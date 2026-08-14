// Toytype — 툴바 팝업
// 브리지 연결·연결 테스트·엔진 선택을 맡는다. AI 기능 실행은 독스 패널의
// [추가기능] 메뉴가 담당하므로 여기서 중복으로 두지 않는다.
// 오탈자 목록은 기본으로 접어 두고, 일반 페이지에서는 본문 빨간 밑줄 표시를
// 여기서 켜고 끈다.
'use strict';

const DEFAULT_BRIDGE_PORT = 17644;
const NATIVE_HOST = 'com.toytype.bridge_host';

const DEFAULT_AI = {
  timeoutDefaultVersion: 2,
  provider: 'codex',
  bridgeUrl: 'http://127.0.0.1:' + DEFAULT_BRIDGE_PORT,
  codexCommand: 'codex',
  claudeCommand: 'claude',
  grokCommand: 'grok',
  workspaceDir: '',
  outputDir: '~/.toytype/generated',
  requestTimeoutMs: 1800000,
  maxDocumentChars: 180000
};

const PROVIDERS = [
  { id: 'codex', label: 'Codex', commandKey: 'codexCommand' },
  { id: 'claude', label: 'Claude Code', commandKey: 'claudeCommand' },
  { id: 'grok', label: 'Grok', commandKey: 'grokCommand' }
];

// 카테고리 색 계열 — content/highlight.css의 밑줄 색과 맞춘다.
const CAT_COLOR_CLASS = {
  convert: 'cat-red', spelling: 'cat-red', final: 'cat-red',
  plural: 'cat-purple', honorific: 'cat-purple',
  space1: 'cat-orange', space2: 'cat-orange', space3: 'cat-orange'
};

const $app = document.getElementById('app');

let tabId = null;
let isDocsTab = false;
let report = null;          // 활성 탭의 검사 결과 (없으면 지원 안 하는 페이지)
let findingsOpen = false;   // 오탈자 목록은 접힌 상태로 시작한다
let providersOpen = false;  // AI 엔진 선택도 평소엔 접어 둔다
let settings = {};
let ai = Object.assign({}, DEFAULT_AI);
let bridgeState = { state: 'unknown', version: '', port: null, tools: null, error: '' };
let busyAction = '';
let statusText = '';
let statusKind = 'info';
let nativeHostReady = true; // 호출해 보기 전까지는 있다고 보고, 실패하면 안내로 전환

// ---------- 유틸 ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function strokedSvg(paths, className) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

function settingsIcon() {
  return strokedSvg([
    'M9.67 4.14a2.34 2.34 0 0 1 4.66 0 2.34 2.34 0 0 0 3.32 1.91 2.34 2.34 0 0 1 2.33 4.03 2.34 2.34 0 0 0 0 3.84 2.34 2.34 0 0 1-2.33 4.03 2.34 2.34 0 0 0-3.32 1.91 2.34 2.34 0 0 1-4.66 0 2.34 2.34 0 0 0-3.32-1.91 2.34 2.34 0 0 1-2.33-4.03 2.34 2.34 0 0 0 0-3.84 2.34 2.34 0 0 1 2.33-4.03 2.34 2.34 0 0 0 3.32-1.91z',
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'
  ], 'icon');
}

function normalizeProvider(value) {
  return PROVIDERS.some(p => p.id === value) ? value : DEFAULT_AI.provider;
}

function providerLabel(id) {
  const found = PROVIDERS.find(p => p.id === id);
  return found ? found.label : id;
}

function externalFeaturesEnabled() {
  return settings && settings.externalFeaturesEnabled === true;
}

function bridgePort() {
  const match = String(ai.bridgeUrl || '').match(/:(\d+)\/*$/);
  if (match) return Number(match[1]);
  if (Number.isFinite(Number(bridgeState.port))) return Number(bridgeState.port);
  return DEFAULT_BRIDGE_PORT;
}

async function readSettings() {
  try {
    return (await chrome.storage.local.get('settings')).settings || {};
  } catch (e) {
    return {};
  }
}

async function writeSettings(next) {
  await chrome.storage.local.set({ settings: next });
}

function mergeAi(stored) {
  const source = stored && typeof stored.ai === 'object' && stored.ai ? stored.ai : {};
  const merged = Object.assign({}, DEFAULT_AI, source);
  merged.provider = normalizeProvider(merged.provider);
  return merged;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e2) {
      return false;
    }
  }
}

function setStatus(text, kind) {
  statusText = text || '';
  statusKind = kind || 'info';
  render();
}

function sendBridge(action, payload) {
  return chrome.runtime.sendMessage({
    type: 'typo:aiBridge',
    action,
    payload: payload || {}
  }).catch(error => ({
    ok: false,
    error: 'extension_message_failed',
    message: error && error.message ? error.message : String(error)
  }));
}

// ---------- 네이티브 호스트 ----------

// 확장은 프로세스를 못 띄운다. 호스트가 대신 LaunchAgent로 브리지를 상주시킨다.
function sendNative(action) {
  return new Promise(resolve => {
    let settled = false;
    const done = value => { if (!settled) { settled = true; resolve(value); } };
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, { action, port: bridgePort() }, res => {
        if (chrome.runtime.lastError) {
          done({ ok: false, error: 'native_host_missing', message: chrome.runtime.lastError.message });
          return;
        }
        done(res || { ok: false, error: 'native_host_empty' });
      });
    } catch (error) {
      done({ ok: false, error: 'native_host_missing', message: error && error.message ? error.message : String(error) });
    }
    // 호스트가 응답하지 않는 경우까지 UI가 매달리지 않게 한다.
    setTimeout(() => done({ ok: false, error: 'native_host_timeout' }), 40000);
  });
}

function nativeHostInstallCommand() {
  return 'node tools/install_native_host.mjs';
}

async function connectBridge() {
  if (busyAction) return;
  if (!externalFeaturesEnabled()) return;
  busyAction = 'connect';
  bridgeState = Object.assign({}, bridgeState, { state: 'checking' });
  setStatus('브리지를 켜는 중…', 'info');

  const res = await sendNative('connect');
  busyAction = '';

  if (res && res.ok) {
    nativeHostReady = true;
    await refreshBridge(false);
    setStatus(res.alreadyRunning ? '이미 켜져 있습니다.' : '브리지를 켰습니다. 이제 로그인하면 자동으로 실행됩니다.', 'ok');
    return;
  }
  // 실패하면 checking 상태에 갇히지 않게 되돌린다 — 버튼이 계속 비활성이면 재시도할 방법이 없다.
  bridgeState = Object.assign({}, bridgeState, { state: 'error' });
  if (res && (res.error === 'native_host_missing' || res.error === 'native_host_timeout')) {
    nativeHostReady = false;
    setStatus('연결 도우미가 아직 설치되지 않았습니다. 아래 명령을 한 번만 실행하세요.', 'warn');
    return;
  }
  setStatus('브리지를 켜지 못했습니다 — ' + bridgeErrorText(res), 'warn');
}

async function disconnectBridge() {
  if (busyAction) return;
  busyAction = 'disconnect';
  setStatus('상주를 끄는 중…', 'info');
  const res = await sendNative('disconnect');
  busyAction = '';
  if (res && res.ok) {
    bridgeState = { state: 'error', version: '', port: bridgePort(), tools: null, error: '' };
    setStatus('브리지 상주를 껐습니다.', 'ok');
    return;
  }
  setStatus('끄지 못했습니다 — ' + bridgeErrorText(res), 'warn');
}

// ---------- 동작 ----------

async function refreshBridge(force) {
  if (!externalFeaturesEnabled()) {
    bridgeState = { state: 'off', version: '', port: null, tools: null, error: '' };
    render();
    return;
  }
  bridgeState = Object.assign({}, bridgeState, { state: 'checking' });
  if (force) setStatus('브리지 확인 중…', 'info');
  else render();

  const res = await sendBridge('health');
  if (res && res.ok) {
    bridgeState = {
      state: 'ok',
      version: typeof res.version === 'string' ? res.version : '',
      port: Number.isFinite(Number(res.port)) ? Number(res.port) : bridgePort(),
      tools: res.tools && typeof res.tools === 'object' ? res.tools : null,
      error: ''
    };
    if (force) setStatus('브리지에 연결되었습니다.', 'ok');
    else render();
    return;
  }
  bridgeState = {
    state: 'error',
    version: '',
    port: bridgePort(),
    tools: null,
    error: res && (res.message || res.error) ? String(res.message || res.error) : 'bridge_unavailable'
  };
  if (force) setStatus('브리지에 연결하지 못했습니다. 아래 명령으로 브리지를 켜세요.', 'warn');
  else render();
}

async function selectProvider(id) {
  const provider = normalizeProvider(id);
  if (provider === ai.provider) return;
  ai = Object.assign({}, ai, { provider });
  const stored = await readSettings();
  stored.ai = Object.assign({}, mergeAi(stored), { provider });
  settings = stored;
  await writeSettings(stored);
  setStatus(providerLabel(provider) + '(으)로 전환했습니다.', 'ok');
}

async function testProvider(id) {
  const provider = normalizeProvider(id);
  if (busyAction) return;
  busyAction = 'test:' + provider;
  setStatus(providerLabel(provider) + ' 연결 테스트 중…', 'info');
  const res = await sendBridge('test', { provider, timeoutMs: 120000 });
  busyAction = '';
  if (res && res.ok) {
    const elapsed = Number.isFinite(Number(res.elapsedMs)) ? ' · ' + Math.round(Number(res.elapsedMs) / 100) / 10 + '초' : '';
    setStatus(providerLabel(provider) + ' 연결 성공' + elapsed, 'ok');
    return;
  }
  setStatus(providerLabel(provider) + ' 연결 실패 — ' + bridgeErrorText(res), 'warn');
}

function bridgeErrorText(res) {
  if (!res || typeof res !== 'object') return String(res || '알 수 없는 오류');
  if (res.error === 'external_features_disabled') return '외부 기능이 꺼져 있습니다';
  if (res.error === 'bridge_unavailable' || res.error === 'extension_message_failed') return '브리지가 꺼져 있습니다';
  if (res.error === 'bridge_timeout') return '시간 초과';
  const diagnostic = res.diagnostics && res.diagnostics.diagnostic;
  const text = String(diagnostic || res.message || res.error || '').replace(/\s+/g, ' ').trim();
  return text.length > 120 ? text.slice(0, 119) + '…' : (text || '알 수 없는 오류');
}

// 밑줄 표시만 끈다. 검사와 목록·배지는 그대로 두므로 껐다 켜도 다시 스캔하지 않는다.
async function toggleHighlight(enabled) {
  const stored = await readSettings();
  stored.highlightEnabled = enabled === true;
  settings = stored;
  await writeSettings(stored);
  setStatus(enabled ? '본문에 빨간 밑줄을 표시합니다.' : '본문 밑줄을 감췄습니다. 검사는 계속합니다.', 'ok');
}

function highlightEnabled() {
  return !settings || settings.highlightEnabled !== false;
}

async function fetchReport() {
  if (typeof tabId !== 'number') return null;
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'typo:get' });
    return res && res.ok ? res : null;
  } catch (e) {
    return null; // chrome:// 등 콘텐츠 스크립트가 없는 페이지
  }
}

async function rescanActiveTab() {
  if (busyAction) return;
  busyAction = 'rescan';
  setStatus('다시 검사 중…', 'info');
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'typo:rescan' });
    report = res && res.ok ? res : report;
  } catch (e) { /* 아래에서 상태만 갱신 */ }
  busyAction = '';
  setStatus(report ? '검사를 마쳤습니다.' : '이 페이지는 검사할 수 없습니다.', report ? 'ok' : 'warn');
}

async function toggleExternalFeatures(enabled) {
  const stored = await readSettings();
  stored.externalFeaturesEnabled = enabled === true;
  settings = stored;
  await writeSettings(stored);
  if (enabled) {
    setStatus('외부 기능을 켰습니다.', 'ok');
    refreshBridge(false);
    return;
  }
  bridgeState = { state: 'off', version: '', port: null, tools: null, error: '' };
  setStatus('외부 기능을 껐습니다.', 'info');
}

function openSettingsPage() {
  try {
    chrome.runtime.openOptionsPage();
  } catch (e) {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  }
}

// ---------- 화면 ----------

function bridgeStateLabel() {
  if (bridgeState.state === 'ok') return '연결됨';
  if (bridgeState.state === 'checking') return '확인 중';
  if (bridgeState.state === 'off') return '꺼짐';
  if (bridgeState.state === 'error') return '연결 안 됨';
  return '알 수 없음';
}

function buildHeader() {
  const header = el('header', 'header');
  const row = el('div', 'head-row');
  row.append(el('div', 'title', 'Toytype'));
  const settingsBtn = el('button', 'btn icon-btn ghost');
  settingsBtn.type = 'button';
  settingsBtn.appendChild(settingsIcon());
  settingsBtn.title = '설정';
  settingsBtn.setAttribute('aria-label', '설정');
  settingsBtn.addEventListener('click', openSettingsPage);
  row.append(settingsBtn);
  header.append(row);
  header.append(el('div', 'meta', isDocsTab ? '구글 독스 문서 · 오탈자 목록은 문서 패널에서' : '구글 독스 문서에서 오탈자 패널이 열립니다'));
  return header;
}

// 표시 규약: 선두·후미 공백만 ␣로 치환, 빈 dst는 ∅(삭제).
function displayToken(s) {
  if (s === '') return '∅(삭제)';
  let i = 0;
  let j = s.length;
  while (i < j && s.charCodeAt(i) === 0x20) i++;
  while (j > i && s.charCodeAt(j - 1) === 0x20) j--;
  return '␣'.repeat(i) + s.slice(i, j) + '␣'.repeat(s.length - j);
}

function buildHighlightSection() {
  const sec = el('section', 'sec');
  const row = el('label', 'switch-row');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = highlightEnabled();
  cb.addEventListener('change', () => { toggleHighlight(cb.checked); });
  row.append(cb);
  row.append(el('span', 'switch-label', '본문에 빨간 밑줄 표시'));
  sec.append(row);
  sec.append(el('p', 'hint', isDocsTab
    ? '구글 독스는 본문에 밑줄을 긋지 않습니다. 일반 웹페이지에만 적용됩니다.'
    : '끄면 밑줄만 감추고 검사와 목록은 그대로 유지합니다.'));
  return sec;
}

// 오탈자 목록 — 기본은 접힘. 펼치면 카테고리별로 묶어 보여준다.
function buildFindingsSection() {
  const sec = el('section', 'sec');
  const head = el('div', 'sec-head');
  const toggle = el('button', 'findings-toggle');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', findingsOpen ? 'true' : 'false');
  const total = report && Number.isFinite(Number(report.total)) ? Number(report.total) : 0;
  toggle.append(el('span', 'caret', findingsOpen ? '▾' : '▸'));
  toggle.append(el('span', 'sec-title', '오탈자'));
  toggle.append(el('span', 'count-chip' + (total > 0 ? ' has' : ''), report ? String(total) + '건' : '—'));
  toggle.addEventListener('click', () => {
    findingsOpen = !findingsOpen;
    render();
  });
  head.append(toggle);

  if (report) {
    const rescan = el('button', 'btn small', busyAction === 'rescan' ? '검사 중…' : '다시 검사');
    rescan.type = 'button';
    rescan.disabled = !!busyAction;
    rescan.addEventListener('click', () => { rescanActiveTab(); });
    head.append(rescan);
  }
  sec.append(head);

  if (!findingsOpen) return sec;

  if (!report) {
    sec.append(el('p', 'hint', '이 페이지에서는 검사할 수 없습니다.'));
    return sec;
  }
  if (report.disabled) {
    sec.append(el('p', 'hint', '이 사이트에서 꺼져 있습니다.'));
    return sec;
  }
  const findings = Array.isArray(report.findings) ? report.findings : [];
  if (findings.length === 0) {
    sec.append(el('p', 'hint', '발견된 오탈자가 없습니다.'));
    return sec;
  }

  const byCat = new Map();
  for (const f of findings) {
    if (!byCat.has(f.cat)) byCat.set(f.cat, []);
    byCat.get(f.cat).push(f);
  }
  const list = el('div', 'findings');
  for (const [catId, group] of byCat) {
    const details = document.createElement('details');
    details.open = true;
    details.append(el('summary', null, (group[0].catLabel || catId) + ' (' + group.length + ')'));
    for (const f of group) details.append(buildFindingItem(f));
    list.append(details);
  }
  sec.append(list);
  return sec;
}

function buildFindingItem(f) {
  const item = el('div', 'finding ' + (CAT_COLOR_CLASS[f.cat] || 'cat-red'));
  const line1 = el('div', 'snippet');
  if (f.before) line1.append(document.createTextNode('…' + f.before));
  line1.append(el('mark', 'src-mark', displayToken(f.src)));
  if (f.after) line1.append(document.createTextNode(f.after + '…'));
  item.append(line1);

  const line2 = el('div', 'fix');
  line2.append(el('span', 'pair', displayToken(f.src) + ' → ' + displayToken(f.dst)));
  line2.append(el('span', 'chip', f.catLabel || f.cat));
  if (f.line != null) line2.append(el('span', 'line', '¶' + f.line));
  item.append(line2);

  // 클릭하면 교정어를 복사한다 — 예전 팝업과 같은 동작.
  item.title = '클릭하면 교정어 복사';
  item.addEventListener('click', async () => {
    const ok = await copyText(f.dst);
    const old = item.querySelector('.copied');
    if (old) old.remove();
    const badge = el('span', 'copied', ok ? '복사됨' : '복사 실패');
    item.append(badge);
    setTimeout(() => { badge.remove(); }, 1200);
  });
  return item;
}

function buildExternalToggle() {
  const sec = el('section', 'sec');
  const row = el('label', 'switch-row');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = externalFeaturesEnabled();
  cb.addEventListener('change', () => { toggleExternalFeatures(cb.checked); });
  row.append(cb);
  row.append(el('span', 'switch-label', '브릿지 · AI 기능 사용'));
  sec.append(row);
  if (!externalFeaturesEnabled()) {
    sec.append(el('p', 'hint', '끄면 확장 자체 규칙 검사만 씁니다. 로컬 브리지와 AI 기능은 숨겨집니다.'));
  }
  return sec;
}

function buildBridgeSection() {
  const sec = el('section', 'sec');
  const head = el('div', 'sec-head');
  head.append(el('h2', 'sec-title', '로컬 브리지'));
  const badge = el('span', 'badge badge-' + bridgeState.state, bridgeStateLabel());
  head.append(badge);
  sec.append(head);

  const meta = [];
  if (bridgeState.state === 'ok') {
    if (bridgeState.version) meta.push('v' + bridgeState.version);
    if (bridgeState.port) meta.push('포트 ' + bridgeState.port);
  } else {
    meta.push(ai.bridgeUrl);
  }
  sec.append(el('div', 'sec-meta', meta.join(' · ')));

  const actions = el('div', 'row-actions');

  if (bridgeState.state === 'ok') {
    const recheck = el('button', 'btn', '다시 확인');
    recheck.type = 'button';
    recheck.disabled = !!busyAction;
    recheck.addEventListener('click', () => { refreshBridge(true); });
    actions.append(recheck);

    const off = el('button', 'btn ghost', busyAction === 'disconnect' ? '끄는 중…' : '상주 끄기');
    off.type = 'button';
    off.disabled = !!busyAction;
    off.title = '자동 실행을 해제하고 브리지를 종료합니다';
    off.addEventListener('click', () => { disconnectBridge(); });
    actions.append(off);
  } else {
    const connectBtn = el('button', 'btn primary', busyAction === 'connect' || bridgeState.state === 'checking' ? '연결 중…' : '연결');
    connectBtn.type = 'button';
    connectBtn.disabled = !!busyAction || bridgeState.state === 'checking';
    connectBtn.addEventListener('click', () => { connectBridge(); });
    actions.append(connectBtn);
  }
  sec.append(actions);

  // 도우미가 없을 때만 터미널 명령을 보여준다 — 평소에는 숨긴다.
  if (!nativeHostReady) {
    sec.append(el('p', 'hint', '최초 1회만 프로젝트 폴더에서 실행하세요.'));
    const cmd = el('pre', 'command', nativeHostInstallCommand());
    sec.append(cmd);
    const copyBtn = el('button', 'btn ghost', '명령 복사');
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(nativeHostInstallCommand());
      setStatus(ok ? '명령을 복사했습니다. 터미널에 붙여넣고 확장을 새로고침하세요.' : '복사하지 못했습니다.', ok ? 'ok' : 'warn');
    });
    sec.append(copyBtn);
  }
  return sec;
}

function buildProviderSection() {
  const sec = el('section', 'sec');
  const head = el('button', 'group-toggle');
  head.type = 'button';
  head.setAttribute('aria-expanded', providersOpen ? 'true' : 'false');
  head.append(el('span', 'caret', providersOpen ? '▾' : '▸'));
  head.append(el('span', 'sec-title', 'AI 엔진'));
  // 접혀 있어도 지금 무슨 엔진을 쓰는지는 보이게 한다.
  head.append(el('span', 'group-value', providerLabel(ai.provider)));
  head.addEventListener('click', () => {
    providersOpen = !providersOpen;
    render();
  });
  sec.append(head);

  if (!providersOpen) return sec;

  for (const provider of PROVIDERS) {
    const row = el('div', 'provider-row' + (ai.provider === provider.id ? ' is-active' : ''));
    const pick = el('button', 'provider-pick');
    pick.type = 'button';
    pick.setAttribute('aria-pressed', ai.provider === provider.id ? 'true' : 'false');
    pick.addEventListener('click', () => { selectProvider(provider.id); });

    const dot = el('span', 'provider-dot');
    pick.append(dot);
    pick.append(el('span', 'provider-name', provider.label));

    const tool = bridgeState.tools && bridgeState.tools[provider.id];
    if (tool) {
      pick.append(el('span', 'provider-tool' + (tool.available ? ' ok' : ' missing'), tool.available ? '설치됨' : '없음'));
    }
    row.append(pick);

    const testBtn = el('button', 'btn small', busyAction === 'test:' + provider.id ? '테스트 중…' : '테스트');
    testBtn.type = 'button';
    testBtn.disabled = !!busyAction || bridgeState.state !== 'ok';
    testBtn.title = bridgeState.state === 'ok' ? provider.label + ' 연결 테스트' : '브리지를 먼저 연결하세요';
    testBtn.addEventListener('click', () => { testProvider(provider.id); });
    row.append(testBtn);
    sec.append(row);
  }
  return sec;
}

function buildStatus() {
  if (!statusText) return null;
  return el('div', 'status status-' + statusKind, statusText);
}

function render() {
  $app.textContent = '';
  $app.append(buildHeader());
  $app.append(buildFindingsSection());
  if (!isDocsTab) $app.append(buildHighlightSection());
  $app.append(buildExternalToggle());
  if (externalFeaturesEnabled()) {
    $app.append(buildBridgeSection());
    $app.append(buildProviderSection());
  }
  const status = buildStatus();
  if (status) $app.append(status);
}

// ---------- 시작 ----------

async function init() {
  let tab = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs && tabs[0];
  } catch (e) { /* 아래에서 처리 */ }
  if (tab && typeof tab.id === 'number') {
    tabId = tab.id;
    isDocsTab = /^https:\/\/docs\.google\.com\/document\//.test(String(tab.url || ''));
  }

  settings = await readSettings();
  ai = mergeAi(settings);
  render();

  report = await fetchReport();
  // 콘텐츠 스크립트가 알려주는 context가 url보다 정확하다 (activeTab이 늦게 붙는 경우 대비).
  if (report && report.context) isDocsTab = report.context === 'docs';
  render();

  if (!externalFeaturesEnabled()) return;

  await refreshBridge(false);
  // 브리지가 꺼져 있으면 팝업을 여는 것만으로 켠다 — 평소에는 버튼도 누를 일이 없다.
  if (bridgeState.state !== 'ok') connectBridge();
}

init();
