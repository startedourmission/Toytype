import { GaruBase } from './third_party/garu-ko/dist/core.js';
import initGaruWasm, { GaruWasm } from './third_party/garu-ko/pkg/garu_wasm.js';
import { createLocalTermConsistencyEngine } from './term-consistency.mjs';
import { createAiJobStore, publicJobRecord, AI_JOB_STORE_KEY } from './ai-job-store.mjs';
import { handleDriveMessage } from './drive-service.mjs';

// Toytype — background service worker
// 역할: 탭 배지 갱신 + rules.json 로드·배포 + 로컬 AI 브리지 프록시.
'use strict';

chrome.action.setBadgeBackgroundColor({ color: '#d93025' });

const gridFrameReports = [];

// SW 재기동 시 사라지는 모듈 레벨 캐시 — 재fetch가 정상 동작이다.
let rulesCache = null;

const LEGACY_AI_REQUEST_TIMEOUT_MS = 600000;

const AI_PROVIDERS = ['codex', 'claude', 'grok'];

const DEFAULT_AI_SETTINGS = {
  timeoutDefaultVersion: 2,
  provider: 'codex',
  bridgeUrl: 'http://127.0.0.1:17644',
  codexCommand: 'codex',
  claudeCommand: 'claude',
  grokCommand: 'grok',
  workspaceDir: '~/Dev/Toytype',
  outputDir: '~/.toytype/generated',
  requestTimeoutMs: 1800000,
  maxDocumentChars: 180000
};

const ISSUE_NEW_URL = 'https://github.com/startedourmission/Toytype/issues/new';

const localTermConsistencyEngine = createLocalTermConsistencyEngine({
  loadAnalyzer: () => loadExtensionGaruAnalyzer(),
  loadRules
});

async function loadRules() {
  if (rulesCache) return rulesCache;
  const res = await fetch(chrome.runtime.getURL('rules.json'));
  if (!res.ok) throw new Error('rules.json fetch failed: ' + res.status);
  rulesCache = await res.json();
  return rulesCache;
}

async function loadExtensionGaruAnalyzer() {
  const [wasmRes, modelRes] = await Promise.all([
    fetch(chrome.runtime.getURL('third_party/garu-ko/pkg/garu_wasm_bg.wasm')),
    fetch(chrome.runtime.getURL('third_party/garu-ko/models/base.gmdl'))
  ]);
  if (!wasmRes.ok) throw new Error('garu wasm fetch failed: ' + wasmRes.status);
  if (!modelRes.ok) throw new Error('garu model fetch failed: ' + modelRes.status);
  const wasmBytes = await wasmRes.arrayBuffer();
  await initGaruWasm({ module_or_path: wasmBytes });
  const modelBytes = new Uint8Array(await modelRes.arrayBuffer());
  return new GaruBase(new GaruWasm(modelBytes, false), modelBytes.byteLength);
}

async function readSettings() {
  let stored = {};
  try {
    stored = (await chrome.storage.local.get('settings')).settings || {};
  } catch (e) {
    stored = {};
  }
  return stored && typeof stored === 'object' ? stored : {};
}

function externalFeaturesEnabled(settings) {
  return settings && settings.externalFeaturesEnabled === true;
}

function normalizeBridgeUrl(value) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_AI_SETTINGS.bridgeUrl;
  return raw.replace(/\/+$/, '');
}

function normalizeAiProvider(value) {
  return typeof value === 'string' && AI_PROVIDERS.includes(value) ? value : DEFAULT_AI_SETTINGS.provider;
}

function mergeAiSettings(settings) {
  const ai = settings && settings.ai && typeof settings.ai === 'object' ? settings.ai : {};
  const provider = normalizeAiProvider(ai.provider);
  const requestTimeoutMs = normalizeAiRequestTimeout(ai);
  return {
    timeoutDefaultVersion: DEFAULT_AI_SETTINGS.timeoutDefaultVersion,
    provider,
    bridgeUrl: normalizeBridgeUrl(ai.bridgeUrl),
    codexCommand: typeof ai.codexCommand === 'string' && ai.codexCommand.trim() ? ai.codexCommand.trim() : DEFAULT_AI_SETTINGS.codexCommand,
    claudeCommand: typeof ai.claudeCommand === 'string' && ai.claudeCommand.trim() ? ai.claudeCommand.trim() : DEFAULT_AI_SETTINGS.claudeCommand,
    grokCommand: typeof ai.grokCommand === 'string' && ai.grokCommand.trim() ? ai.grokCommand.trim() : DEFAULT_AI_SETTINGS.grokCommand,
    // 비워 두면 브리지가 자기 저장소 폴더를 쓴다. 여기서 기본값을 채워 보내면
    // 그 경로가 없는 머신에서도 덮어써 버리므로 빈 값을 그대로 넘긴다.
    workspaceDir: typeof ai.workspaceDir === 'string' && ai.workspaceDir.trim() ? ai.workspaceDir.trim() : '',
    outputDir: typeof ai.outputDir === 'string' && ai.outputDir.trim() ? ai.outputDir.trim() : DEFAULT_AI_SETTINGS.outputDir,
    requestTimeoutMs,
    maxDocumentChars: clampNumber(ai.maxDocumentChars, DEFAULT_AI_SETTINGS.maxDocumentChars, 1000, 1000000)
  };
}

function normalizeAiRequestTimeout(ai) {
  const n = Number(ai && ai.requestTimeoutMs);
  const version = Number(ai && ai.timeoutDefaultVersion);
  if (Number.isFinite(n) && Math.floor(n) === LEGACY_AI_REQUEST_TIMEOUT_MS && !(version >= DEFAULT_AI_SETTINGS.timeoutDefaultVersion)) {
    return DEFAULT_AI_SETTINGS.requestTimeoutMs;
  }
  return clampNumber(ai && ai.requestTimeoutMs, DEFAULT_AI_SETTINGS.requestTimeoutMs, 5000, 3600000);
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function buildAiBridgePayload(ai, payload) {
  return Object.assign({}, payload || {}, {
    provider: payload && payload.provider || ai.provider,
    settings: {
      provider: ai.provider,
      codexCommand: ai.codexCommand,
      claudeCommand: ai.claudeCommand,
      grokCommand: ai.grokCommand,
      workspaceDir: ai.workspaceDir,
      outputDir: ai.outputDir,
      requestTimeoutMs: ai.requestTimeoutMs,
      maxDocumentChars: ai.maxDocumentChars
    }
  });
}

// AI 도해용: 독스 본문 이미지(googleusercontent)는 페이지 출처로 받으면 CORS에 막히므로
// host_permissions가 적용되는 서비스워커에서 받아 data URL로 넘긴다.
const IMAGE_FETCH_MAX_BYTES = 20 * 1024 * 1024;

async function fetchImageAsDataUrl(url) {
  let u;
  try {
    u = new URL(String(url || ''));
  } catch (_) {
    return { ok: false, error: 'image_url_invalid' };
  }
  if (u.protocol !== 'https:' || !/(^|\.)(googleusercontent|google)\.com$/.test(u.hostname)) {
    return { ok: false, error: 'image_url_not_allowed' };
  }
  const res = await fetch(u.href, { credentials: 'include' });
  if (!res.ok) return { ok: false, error: 'image_fetch_failed', status: res.status };
  const type = String(res.headers.get('content-type') || '').split(';')[0].trim();
  if (!/^image\/(png|jpe?g|gif|webp)$/i.test(type)) return { ok: false, error: 'not_an_image', contentType: type };
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > IMAGE_FETCH_MAX_BYTES) return { ok: false, error: 'image_too_large', bytes: bytes.length };
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { ok: true, dataUrl: 'data:' + type + ';base64,' + btoa(bin), bytes: bytes.length };
}

// 작업 큐에서 취소한 요청을 끊기 위한 컨트롤러. 연결이 끊기면 브리지가 실행 중인 CLI도 끝낸다.
const aiRequestControllers = new Map();

// AI 작업 기록: 페이지를 새로고침해도 작업과 결과를 이어받게 session 저장소에 둔다.
const aiJobStore = createAiJobStore({
  read: () => chrome.storage.session.get(AI_JOB_STORE_KEY).then(items => items && items[AI_JOB_STORE_KEY]),
  write: records => chrome.storage.session.set({ [AI_JOB_STORE_KEY]: records }),
  isLive: id => aiRequestControllers.has(id)
});
// 새로고침한 페이지가 실행 중인 작업의 끝을 기다리는 응답 콜백
const aiJobWaiters = new Map();

function notifyAiJobWaiters(id, rec) {
  const waiters = aiJobWaiters.get(id);
  if (!waiters) return;
  aiJobWaiters.delete(id);
  const out = rec ? Object.assign(publicJobRecord(rec), { result: rec.result || null }) : null;
  for (const send of waiters) {
    try { send({ ok: true, job: out }); } catch (_) { /* 기다리던 탭이 닫힘 */ }
  }
}

async function runTrackedAiJob(path, payload, requestId, job) {
  if (requestId && job && job.docId) {
    await aiJobStore.start(requestId, Object.assign({}, job, { payload })).catch(() => {});
  }
  const res = await callAiBridge(path, payload, requestId);
  if (requestId && job && job.docId) {
    const rec = await aiJobStore.finish(requestId, res).catch(() => null);
    notifyAiJobWaiters(requestId, rec ? Object.assign({}, rec, { result: res && res.ok ? res : null }) : null);
  }
  return res;
}

function handleAiJobMessage(msg, sendResponse) {
  const docId = String(msg.docId || '');
  const fail = error => sendResponse({ ok: false, error: 'ai_job_store_failed', message: error && error.message ? error.message : String(error) });
  if (msg.type === 'typo:aiJobsSyncQueue') {
    aiJobStore.syncQueue(docId, msg.jobs).then(() => sendResponse({ ok: true }), fail);
    return true;
  }
  if (msg.type === 'typo:aiJobsList') {
    aiJobStore.list(docId).then(list => sendResponse({ ok: true, jobs: list.map(publicJobRecord) }), fail);
    return true;
  }
  if (msg.type === 'typo:aiJobAwait') {
    const id = String(msg.id || '');
    aiJobStore.get(id).then(rec => {
      if (!rec || rec.state !== 'running' || !aiRequestControllers.has(id)) {
        sendResponse({ ok: true, job: rec ? Object.assign(publicJobRecord(rec), { result: rec.acked ? null : rec.result || null }) : null });
        return;
      }
      if (!aiJobWaiters.has(id)) aiJobWaiters.set(id, []);
      aiJobWaiters.get(id).push(sendResponse);
    }, fail);
    return true;
  }
  if (msg.type === 'typo:aiJobAck') {
    aiJobStore.ack(String(msg.id || '')).then(() => sendResponse({ ok: true }), fail);
    return true;
  }
  if (msg.type === 'typo:aiJobRemove') {
    aiJobStore.remove(Array.isArray(msg.ids) ? msg.ids.map(String) : [String(msg.id || '')]).then(() => sendResponse({ ok: true }), fail);
    return true;
  }
  if (msg.type === 'typo:aiJobPayload') {
    aiJobStore.get(String(msg.id || '')).then(rec => sendResponse({ ok: !!(rec && rec.payload), payload: rec ? rec.payload : null, meta: rec ? rec.meta : null }), fail);
    return true;
  }
  return undefined;
}

async function callAiBridge(path, payload, requestId) {
  const settings = await readSettings();
  const ai = mergeAiSettings(settings);
  const bridgePayload = buildAiBridgePayload(ai, payload);
  const ctrl = new AbortController();
  let canceled = false;
  if (requestId) {
    aiRequestControllers.set(requestId, () => { canceled = true; ctrl.abort(); });
  }
  const timer = setTimeout(() => ctrl.abort(), ai.requestTimeoutMs + 5000);
  try {
    const res = await fetch(ai.bridgeUrl + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bridgePayload),
      signal: ctrl.signal
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : {};
    } catch (e) {
      return { ok: false, error: 'bridge_invalid_json', status: res.status, body: text.slice(0, 2000) };
    }
    if (!res.ok) {
      return Object.assign({ ok: false, status: res.status }, json);
    }
    return json;
  } catch (e) {
    if (canceled) return { ok: false, error: 'canceled', message: '작업을 취소했습니다' };
    return {
      ok: false,
      error: e && e.name === 'AbortError' ? 'bridge_timeout' : 'bridge_unavailable',
      message: e && e.message ? e.message : String(e),
      bridgeUrl: ai.bridgeUrl
    };
  } finally {
    clearTimeout(timer);
    if (requestId) aiRequestControllers.delete(requestId);
  }
}

async function generateLocalTerms(payload) {
  const settings = await readSettings();
  const ai = mergeAiSettings(settings);
  const body = buildAiBridgePayload(ai, payload);
  const document = body.document && typeof body.document === 'object' ? body.document : {};
  if (typeof document.text !== 'string' || !document.text.trim()) {
    return { ok: false, status: 400, error: 'document.text is required' };
  }

  const startedAt = Date.now();
  const report = await localTermConsistencyEngine.buildReport(document, body.settings || ai);
  report.elapsedMs = Date.now() - startedAt;
  return {
    ok: true,
    provider: report.provider,
    model: report.model,
    report,
    terms: report.terms,
    notes: report.notes,
    termCount: report.terms.length,
    includedChars: report.includedChars,
    fromCache: false,
    localOnly: true,
    elapsedMs: report.elapsedMs
  };
}

function oneLine(value, limit) {
  const max = Number.isFinite(Number(limit)) ? Math.max(0, Number(limit)) : 120;
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, Math.max(0, max - 1)) + '…' : text;
}

function blockValue(value, limit) {
  const max = Number.isFinite(Number(limit)) ? Math.max(0, Number(limit)) : 800;
  const text = String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim();
  return text.length > max ? text.slice(0, Math.max(0, max - 1)) + '…' : text;
}

function issueCode(value, limit) {
  const text = blockValue(value, limit).replace(/`/g, '\u02cb');
  return text || '-';
}

function buildFindingIssueUrl(payload) {
  const f = payload && typeof payload === 'object' ? payload : {};
  const src = oneLine(f.src, 80) || '미확인';
  const dst = oneLine(f.dst, 80) || '미확인';
  const cat = oneLine(f.catLabel || f.cat, 80) || '-';
  const title = '[규칙 오류 제보] ' + src + ' → ' + dst;
  const context = [
    blockValue(f.before, 180),
    f.src,
    blockValue(f.after, 180)
  ].filter(v => v != null && String(v) !== '').join('');
  const lines = [
    '## 규칙 오류 제보',
    '',
    '- 원문: `' + issueCode(f.src, 180) + '`',
    '- 제안: `' + issueCode(f.dst, 180) + '`',
    '- 카테고리: ' + cat,
    '- 위치: ' + (oneLine(f.context, 40) || '-') + (f.line != null ? ' ¶' + oneLine(f.line, 20) : ''),
    '- 규칙 버전: ' + (oneLine(f.rulesVersion, 80) || '-'),
    '- 규칙 소스: ' + (oneLine(f.rulesSource, 120) || '-'),
    '- 문서/페이지: ' + (oneLine(f.pageTitle, 140) || '-'),
    '- URL: ' + (oneLine(f.pageUrl, 240) || '-'),
    '',
    '## 문맥',
    '',
    '```text',
    blockValue(context, 500) || '-',
    '```',
    '',
    '## 기대 동작',
    '',
    '<!-- 이 항목이 왜 오탐인지, 또는 어떤 교정이 맞는지 적어 주세요. -->'
  ];
  const params = new URLSearchParams({
    title,
    body: lines.join('\n')
  });
  return ISSUE_NEW_URL + '?' + params.toString();
}

function openIssueTab(payload) {
  return new Promise(resolve => {
    if (!chrome.tabs || typeof chrome.tabs.create !== 'function') {
      resolve({ ok: false, error: 'tabs_unavailable' });
      return;
    }
    const url = buildFindingIssueUrl(payload);
    chrome.tabs.create({ url }, tab => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: 'issue_open_failed', message: chrome.runtime.lastError.message, url });
        return;
      }
      resolve({ ok: true, tabId: tab && tab.id, url });
    });
  });
}

function aiBridgePath(action) {
  const paths = {
    health: '/health',
    test: '/ai/test',
    proofread: '/ai/proofread',
    proofreadChunk: '/ai/proofread-chunk',
    reviewComments: '/ai/review-comments',
    formatCheck: '/ai/format-check',
    terms: '/ai/terms',
    question: '/ai/question',
    adjustLength: '/ai/adjust-length',
    verifyFacts: '/ai/verify-facts',
    diagram: '/ai/diagram',
    listGenerated: '/fs/list-generated',
    openOutputDir: '/fs/open-output-dir',
    cleanupGenerated: '/fs/cleanup-generated',
    deleteSentenceSuggestion: '/fs/delete-sentence-suggestion'
  };
  return paths[action] || '';
}

function tabMessage(tabId, msg, timeoutMs) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), timeoutMs);
    chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }, res => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res || { ok: false, error: 'no_response' });
    });
  });
}

async function originDocDigest(docId) {
  if (!/^[\w-]{10,}$/.test(docId)) return { ok: false, error: 'bad_doc_id' };
  const tabs = await chrome.tabs.query({ url: 'https://docs.google.com/document/*' });
  const mine = tabs.filter(t => String(t.url || '').includes('/d/' + docId + '/'));
  if (!mine.length) return { ok: false, error: 'no_tab' };
  for (const tab of mine) {
    const res = await tabMessage(tab.id, { type: 'typo:docTextDigest' }, 4000);
    if (res && res.ok && res.docId === docId) return { ok: true, digest: res.digest };
  }
  return { ok: false, error: 'no_answer' };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'typo:count') {
    const tabId = sender.tab && sender.tab.id;
    if (typeof tabId !== 'number') return; // 탭 외 발신은 무시
    const count = typeof msg.count === 'number' && msg.count > 0 ? msg.count : 0;
    chrome.action.setBadgeText({ tabId: tabId, text: count > 0 ? String(count) : '' });
    return; // 응답 없음. 탭 배지는 내비게이션 시 크롬이 자동 초기화.
  }

  if (msg.type === 'typo:getRules') {
    loadRules()
      .then((rules) => sendResponse({ ok: true, rules: rules }))
      .catch(() => {
        rulesCache = null;
        sendResponse({ ok: false, error: 'rules_load_failed' });
      });
    return true; // 비동기 응답
  }

  if (msg.type === 'typo:openOptions') {
    try {
      chrome.runtime.openOptionsPage(() => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: 'options_open_failed', message: chrome.runtime.lastError.message });
          return;
        }
        sendResponse({ ok: true });
      });
    } catch (error) {
      sendResponse({ ok: false, error: 'options_open_failed', message: error && error.message ? error.message : String(error) });
    }
    return true;
  }

  if (msg.type === 'typo:getCategories') {
    loadRules()
      .then((rules) => sendResponse({
        ok: true,
        categories: rules.categories.map((c) => ({
          id: c.id,
          label: c.label,
          ruleCount: c.rules.length
        }))
      }))
      .catch(() => {
        rulesCache = null;
        sendResponse({ ok: false, error: 'rules_load_failed' });
    });
    return true; // 비동기 응답
  }

  if (msg.type === 'typo:getAiBridgeConfig') {
    readSettings()
      .then(settings => {
        const ai = mergeAiSettings(settings);
        sendResponse({
          ok: true,
          bridgeUrl: ai.bridgeUrl,
          requestTimeoutMs: ai.requestTimeoutMs,
          payloadDefaults: buildAiBridgePayload(ai, {})
        });
      })
      .catch(error => {
        sendResponse({ ok: false, error: 'settings_load_failed', message: error && error.message ? error.message : String(error) });
      });
    return true;
  }

  if (msg.type === 'typo:reportFindingIssue') {
    openIssueTab(msg.finding).then(sendResponse, error => {
      sendResponse({ ok: false, error: 'issue_open_failed', message: error && error.message ? error.message : String(error) });
    });
    return true;
  }

  if (msg.type === 'typo:fetchImage') {
    fetchImageAsDataUrl(msg.url).then(sendResponse, error => {
      sendResponse({ ok: false, error: 'image_fetch_failed', message: error && error.message ? error.message : String(error) });
    });
    return true;
  }

  if (msg.type === 'typo:aiBridgeAbort') {
    const abort = aiRequestControllers.get(String(msg.requestId || ''));
    if (abort) abort();
    sendResponse({ ok: true, aborted: !!abort });
    return;
  }

  if (msg.type === 'typo:gridFrameReport') {
    gridFrameReports.unshift(Object.assign({ at: Date.now(), frameUrl: String(sender && sender.url || '').slice(0, 120) }, msg.report || {}));
    gridFrameReports.length = Math.min(gridFrameReports.length, 120);
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'typo:driveGridFrameReports') {
    sendResponse({ ok: true, reports: gridFrameReports });
    return;
  }

  if (msg.type === 'typo:gridOriginDigest') {
    // 격자 페이지만: 같은 문서를 연 일반 탭의 본문 요약값을 받아 온다
    const from = String(sender && sender.url || '');
    if (!(sender && sender.id === chrome.runtime.id && from.startsWith('https://docs.google.com/document/toytype-grid'))) {
      sendResponse({ ok: false, error: 'forbidden_sender' });
      return;
    }
    originDocDigest(String(msg.docId || '')).then(sendResponse, error => {
      sendResponse({ ok: false, error: error && error.message ? error.message : String(error) });
    });
    return true;
  }

  if (msg.type === 'typo:devReload') {
    // 스토어판(update_url 있음)에서는 무시한다
    if (!('update_url' in chrome.runtime.getManifest())) setTimeout(() => chrome.runtime.reload(), 100);
    sendResponse({ ok: true });
    return;
  }

  if (typeof msg.type === 'string' && msg.type.startsWith('typo:drive')) {
    // 드라이브·문서 화면의 콘텐트 스크립트만 문서 export를 요청할 수 있다
    const from = String(sender && (sender.url || (sender.tab && sender.tab.url)) || '');
    const ownPage = sender && sender.id === chrome.runtime.id && from.startsWith(chrome.runtime.getURL(''));
    if (!ownPage && !/^https:\/\/(drive|docs)\.google\.com\//.test(from)) {
      sendResponse({ ok: false, error: 'forbidden_sender' });
      return;
    }
    return handleDriveMessage(msg, sendResponse, sender);
  }

  if (typeof msg.type === 'string' && msg.type.startsWith('typo:aiJob')) {
    return handleAiJobMessage(msg, sendResponse);
  }

  if (msg.type === 'typo:aiBridge') {
    const action = msg.action;
    const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
    const path = aiBridgePath(action);
    if (!path) {
      sendResponse({ ok: false, error: 'unknown_ai_bridge_action' });
      return;
    }
    if (action === 'terms') {
      generateLocalTerms(payload).then(sendResponse, error => {
        sendResponse({
          ok: false,
          error: 'local_terms_failed',
          message: error && error.message ? error.message : String(error)
        });
      });
      return true;
    }
    readSettings().then(settings => {
      if (!externalFeaturesEnabled(settings)) {
        sendResponse({
          ok: false,
          error: 'external_features_disabled',
          message: '브리지/외부 기능이 옵션에서 비활성화되어 있습니다.'
        });
        return null;
      }
      const job = msg.job && typeof msg.job === 'object' ? msg.job : null;
      return runTrackedAiJob(path, payload, typeof msg.requestId === 'string' ? msg.requestId : '', job).then(sendResponse, error => {
        sendResponse({ ok: false, error: 'bridge_internal', message: error && error.message ? error.message : String(error) });
      });
    }).catch(error => {
      sendResponse({ ok: false, error: 'settings_load_failed', message: error && error.message ? error.message : String(error) });
    });
    return true;
  }
});
