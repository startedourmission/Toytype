// Toytype — background service worker
// 역할: 탭 배지 갱신 + rules.json 로드·배포 + 로컬 AI 브리지 프록시.
'use strict';

chrome.action.setBadgeBackgroundColor({ color: '#d93025' });

// SW 재기동 시 사라지는 모듈 레벨 캐시 — 재fetch가 정상 동작이다.
let rulesCache = null;

const LEGACY_AI_REQUEST_TIMEOUT_MS = 600000;

const DEFAULT_AI_SETTINGS = {
  timeoutDefaultVersion: 2,
  provider: 'codex',
  bridgeUrl: 'http://127.0.0.1:17644',
  codexCommand: 'codex',
  claudeCommand: 'claude',
  workspaceDir: '~/Dev/Toytype',
  outputDir: '~/.toytype/generated',
  requestTimeoutMs: 1800000,
  maxDocumentChars: 180000
};

const ISSUE_NEW_URL = 'https://github.com/startedourmission/Toytype/issues/new';

async function loadRules() {
  if (rulesCache) return rulesCache;
  const res = await fetch(chrome.runtime.getURL('rules.json'));
  if (!res.ok) throw new Error('rules.json fetch failed: ' + res.status);
  rulesCache = await res.json();
  return rulesCache;
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

function normalizeBridgeUrl(value) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_AI_SETTINGS.bridgeUrl;
  return raw.replace(/\/+$/, '');
}

function mergeAiSettings(settings) {
  const ai = settings && settings.ai && typeof settings.ai === 'object' ? settings.ai : {};
  const provider = ai.provider === 'claude' ? 'claude' : 'codex';
  const requestTimeoutMs = normalizeAiRequestTimeout(ai);
  return {
    timeoutDefaultVersion: DEFAULT_AI_SETTINGS.timeoutDefaultVersion,
    provider,
    bridgeUrl: normalizeBridgeUrl(ai.bridgeUrl),
    codexCommand: typeof ai.codexCommand === 'string' && ai.codexCommand.trim() ? ai.codexCommand.trim() : DEFAULT_AI_SETTINGS.codexCommand,
    claudeCommand: typeof ai.claudeCommand === 'string' && ai.claudeCommand.trim() ? ai.claudeCommand.trim() : DEFAULT_AI_SETTINGS.claudeCommand,
    workspaceDir: typeof ai.workspaceDir === 'string' && ai.workspaceDir.trim() ? ai.workspaceDir.trim() : DEFAULT_AI_SETTINGS.workspaceDir,
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
      workspaceDir: ai.workspaceDir,
      outputDir: ai.outputDir,
      requestTimeoutMs: ai.requestTimeoutMs,
      maxDocumentChars: ai.maxDocumentChars
    }
  });
}

async function callAiBridge(path, payload) {
  const settings = await readSettings();
  const ai = mergeAiSettings(settings);
  const bridgePayload = buildAiBridgePayload(ai, payload);
  const ctrl = new AbortController();
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
    if (path === '/docs/extract-images' && json && json.ok && json.downloadUrlPath && json.fileName) {
      const download = await downloadBridgeFile(ai.bridgeUrl, json.downloadUrlPath, json.fileName);
      return Object.assign({}, json, download);
    }
    return json;
  } catch (e) {
    return {
      ok: false,
      error: e && e.name === 'AbortError' ? 'bridge_timeout' : 'bridge_unavailable',
      message: e && e.message ? e.message : String(e),
      bridgeUrl: ai.bridgeUrl
    };
  } finally {
    clearTimeout(timer);
  }
}

function downloadBridgeFile(bridgeUrl, urlPath, fileName) {
  return new Promise(resolve => {
    if (!chrome.downloads || typeof chrome.downloads.download !== 'function') {
      resolve({ chromeDownloadError: 'downloads API unavailable' });
      return;
    }
    const url = normalizeBridgeUrl(bridgeUrl) + urlPath;
    chrome.downloads.download({
      url,
      filename: safeDownloadFileName(fileName),
      conflictAction: 'uniquify',
      saveAs: false
    }, downloadId => {
      if (chrome.runtime.lastError) {
        resolve({ chromeDownloadError: chrome.runtime.lastError.message });
        return;
      }
      resolve({ chromeDownloadId: downloadId });
    });
  });
}

function safeDownloadFileName(fileName) {
  return String(fileName || 'toytype-images.zip').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'toytype-images.zip';
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
    terms: '/ai/terms',
    question: '/ai/question',
    adjustLength: '/ai/adjust-length',
    extractImages: '/docs/extract-images',
    listGenerated: '/fs/list-generated',
    openOutputDir: '/fs/open-output-dir',
    cleanupGenerated: '/fs/cleanup-generated',
    deleteSentenceSuggestion: '/fs/delete-sentence-suggestion'
  };
  return paths[action] || '';
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

  if (msg.type === 'typo:aiBridge') {
    const action = msg.action;
    const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
    const path = aiBridgePath(action);
    if (!path) {
      sendResponse({ ok: false, error: 'unknown_ai_bridge_action' });
      return;
    }
    callAiBridge(path, payload).then(sendResponse, error => {
      sendResponse({ ok: false, error: 'bridge_internal', message: error && error.message ? error.message : String(error) });
    });
    return true;
  }
});
