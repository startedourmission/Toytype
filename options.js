'use strict';

const DEFAULT_TOC_MAX_LEVEL = 4;
const DEFAULT_CLEANUP_DAYS = 30;
const CLEANUP_DAY_OPTIONS = [1, 7, 30, 60, 180];
const LEGACY_AI_REQUEST_TIMEOUT_MS = 600000;

const DEFAULT_AI = {
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

const els = {
  save: document.getElementById('save'),
  bridgeUrl: document.getElementById('bridgeUrl'),
  bridgeCommand: document.getElementById('bridgeCommand'),
  health: document.getElementById('health'),
  codexCommand: document.getElementById('codexCommand'),
  claudeCommand: document.getElementById('claudeCommand'),
  testCodex: document.getElementById('testCodex'),
  testClaude: document.getElementById('testClaude'),
  workspaceDir: document.getElementById('workspaceDir'),
  outputDir: document.getElementById('outputDir'),
  openOutputDir: document.getElementById('openOutputDir'),
  cleanupDays: document.getElementById('cleanupDays'),
  cleanupGenerated: document.getElementById('cleanupGenerated'),
  requestTimeoutMs: document.getElementById('requestTimeoutMs'),
  maxDocumentChars: document.getElementById('maxDocumentChars'),
  tocMaxLevel: document.getElementById('tocMaxLevel'),
  copyOnSelect: document.getElementById('copyOnSelect'),
  status: document.getElementById('status')
};

function aiFromSettings(settings) {
  const ai = Object.assign({}, DEFAULT_AI, settings && settings.ai || {});
  ai.requestTimeoutMs = normalizeAiRequestTimeout(ai);
  ai.timeoutDefaultVersion = DEFAULT_AI.timeoutDefaultVersion;
  return ai;
}

function tocMaxLevelFromSettings(settings) {
  return clampNumber(settings && settings.tocMaxLevel, DEFAULT_TOC_MAX_LEVEL, 1, 5);
}

function cleanupDaysFromSettings(settings) {
  return cleanupDaysValue(settings && settings.generatedJsonCleanupDays);
}

async function readSettings() {
  try {
    return (await chrome.storage.local.get('settings')).settings || {};
  } catch (e) {
    return {};
  }
}

async function writeAiSettings(ai) {
  const settings = await readSettings();
  settings.ai = ai;
  await chrome.storage.local.set({ settings });
}

function selectedProvider() {
  const checked = document.querySelector('input[name="provider"]:checked');
  return checked ? checked.value : 'codex';
}

function setSelectedProvider(provider) {
  const value = provider === 'claude' ? 'claude' : 'codex';
  const input = document.querySelector('input[name="provider"][value="' + value + '"]');
  if (input) input.checked = true;
}

function formToAi() {
  return {
    timeoutDefaultVersion: DEFAULT_AI.timeoutDefaultVersion,
    provider: selectedProvider(),
    bridgeUrl: els.bridgeUrl.value.trim() || DEFAULT_AI.bridgeUrl,
    codexCommand: els.codexCommand.value.trim() || DEFAULT_AI.codexCommand,
    claudeCommand: els.claudeCommand.value.trim() || DEFAULT_AI.claudeCommand,
    workspaceDir: els.workspaceDir.value.trim() || DEFAULT_AI.workspaceDir,
    outputDir: els.outputDir.value.trim() || DEFAULT_AI.outputDir,
    requestTimeoutMs: clampNumber(els.requestTimeoutMs.value, DEFAULT_AI.requestTimeoutMs, 5000, 3600000),
    maxDocumentChars: clampNumber(els.maxDocumentChars.value, DEFAULT_AI.maxDocumentChars, 1000, 1000000)
  };
}

function cleanupDaysValue(value) {
  const n = Number(value);
  return CLEANUP_DAY_OPTIONS.includes(n) ? n : DEFAULT_CLEANUP_DAYS;
}

function fillForm(ai) {
  setSelectedProvider(ai.provider);
  els.bridgeUrl.value = ai.bridgeUrl;
  els.codexCommand.value = ai.codexCommand;
  els.claudeCommand.value = ai.claudeCommand;
  els.workspaceDir.value = ai.workspaceDir;
  els.outputDir.value = ai.outputDir;
  els.requestTimeoutMs.value = String(ai.requestTimeoutMs);
  els.maxDocumentChars.value = String(ai.maxDocumentChars);
  updateBridgeCommand();
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function normalizeAiRequestTimeout(ai) {
  const n = Number(ai && ai.requestTimeoutMs);
  const version = Number(ai && ai.timeoutDefaultVersion);
  if (Number.isFinite(n) && Math.floor(n) === LEGACY_AI_REQUEST_TIMEOUT_MS && !(version >= DEFAULT_AI.timeoutDefaultVersion)) {
    return DEFAULT_AI.requestTimeoutMs;
  }
  return clampNumber(ai && ai.requestTimeoutMs, DEFAULT_AI.requestTimeoutMs, 5000, 3600000);
}

function updateBridgeCommand() {
  const url = (els.bridgeUrl.value || DEFAULT_AI.bridgeUrl).replace(/\/+$/, '');
  const match = url.match(/:(\d+)$/);
  const port = match ? match[1] : '17644';
  els.bridgeCommand.textContent = 'node tools/toytype_ai_bridge.mjs --port ' + port;
}

function setStatus(value) {
  if (typeof value === 'string') {
    els.status.textContent = value;
    return;
  }
  els.status.textContent = formatStatus(value);
}

function formatStatus(res) {
  if (!res || typeof res !== 'object') return String(res);
  if (res.provider && Object.prototype.hasOwnProperty.call(res, 'expected')) {
    const lines = [
      (res.ok ? '연결 성공' : '연결 실패') + ': ' + res.provider,
      'exitCode: ' + String(res.exitCode),
      'elapsedMs: ' + String(res.elapsedMs)
    ];
    const diagnostic = res.diagnostics && typeof res.diagnostics.diagnostic === 'string'
      ? res.diagnostics.diagnostic
      : typeof res.diagnostic === 'string'
        ? res.diagnostic
        : '';
    const response = String(res.ok ? (res.response || diagnostic) : (diagnostic || res.response) || res.stdoutTail || res.stderrTail || '').trim();
    if (response) lines.push('', response);
    if (res.diagnostics && (res.diagnostics.stdoutChars !== undefined || res.diagnostics.stderrChars !== undefined)) {
      lines.push('', 'stdoutChars: ' + String(res.diagnostics.stdoutChars || 0) + ' · stderrChars: ' + String(res.diagnostics.stderrChars || 0));
    }
    if (res.stderrTail && String(res.stderrTail).trim() && String(res.stderrTail).trim() !== response) {
      lines.push('', String(res.stderrTail).trim());
    }
    return lines.join('\n');
  }
  if (res.error === 'bridge_unavailable' || res.error === 'extension_message_failed') {
    return '브리지 연결 실패\n\n설정된 브리지 URL에서 응답이 없습니다. 아래 명령으로 로컬 브리지를 먼저 실행하세요.\n\n' + els.bridgeCommand.textContent;
  }
  if (res.error === 'bridge_timeout') {
    return '브리지 요청 시간 초과';
  }
  if (res.status === 404 && res.error === 'not found') {
    return '브리지 기능을 찾지 못했습니다.\n\n현재 실행 중인 브리지가 이전 코드입니다. 터미널에서 브리지를 종료한 뒤 아래 명령으로 다시 실행하세요.\n\n' + els.bridgeCommand.textContent;
  }
  if (res.opened && res.outputDir) {
    return '저장 폴더를 열었습니다.\n\n' + res.outputDir;
  }
  if (res.cleaned) {
    const lines = [
      '오래된 생성 JSON 제거 완료',
      '',
      '기준: ' + String(res.days) + '일 이전',
      '삭제: ' + String(res.deleted) + '개',
      '건너뜀: ' + String(res.skipped) + '개',
      '무시: ' + String(res.ignored || 0) + '개',
      '폴더: ' + String(res.outputDir || '')
    ];
    if (Array.isArray(res.deletedFiles) && res.deletedFiles.length) {
      lines.push('', '삭제한 파일:');
      for (const file of res.deletedFiles) lines.push('- ' + String(file.fileName || file));
      if (res.deletedFilesTruncated) lines.push('- ...');
    }
    return lines.join('\n');
  }
  return JSON.stringify(res, null, 2);
}

async function save() {
  const ai = formToAi();
  const settings = await readSettings();
  settings.ai = ai;
  settings.tocMaxLevel = clampNumber(els.tocMaxLevel.value, DEFAULT_TOC_MAX_LEVEL, 1, 5);
  settings.copyOnSelect = els.copyOnSelect.checked;
  settings.generatedJsonCleanupDays = cleanupDaysValue(els.cleanupDays.value);
  await chrome.storage.local.set({ settings });
  fillForm(ai);
  setStatus('저장됨');
}

async function sendBridge(action, payload) {
  await save();
  try {
    return await chrome.runtime.sendMessage({
      type: 'typo:aiBridge',
      action,
      payload: payload || {}
    });
  } catch (error) {
    return {
      ok: false,
      error: 'extension_message_failed',
      message: error && error.message ? error.message : String(error)
    };
  }
}

async function checkHealth() {
  setStatus('브리지 확인 중...');
  const res = await sendBridge('health');
  applyDetectedToolPaths(res);
  setStatus(res);
}

async function test(provider) {
  setStatus(provider + ' 연결 테스트 중...');
  const res = await sendBridge('test', { provider, timeoutMs: 120000 });
  setStatus(res);
}

async function openOutputDir() {
  setStatus('저장 폴더 여는 중...');
  const res = await sendBridge('openOutputDir');
  setStatus(res);
}

async function cleanupGenerated() {
  const days = cleanupDaysValue(els.cleanupDays.value);
  setStatus(String(days) + '일 이전 생성 JSON 제거 중...');
  const res = await sendBridge('cleanupGenerated', { days });
  setStatus(res);
}

function handleUiError(context, error) {
  console.error('[Toytype options] ' + context, error);
  setStatus(error && error.message ? error.message : String(error));
}

async function init() {
  const settings = await readSettings();
  fillForm(aiFromSettings(settings));
  els.tocMaxLevel.value = String(tocMaxLevelFromSettings(settings));
  els.cleanupDays.value = String(cleanupDaysFromSettings(settings));
  els.copyOnSelect.checked = settings.copyOnSelect !== false;
  setStatus('설정을 불러왔습니다.');
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'typo:aiBridge',
      action: 'health',
      payload: {}
    });
    applyDetectedToolPaths(res);
  } catch (e) {
    /* 브리지를 아직 안 켠 경우에는 입력값 그대로 둔다. */
  }
}

function applyDetectedToolPaths(res) {
  if (!res || !res.ok || !res.tools) return;
  const current = formToAi();
  let changed = false;
  if ((!current.codexCommand || current.codexCommand === DEFAULT_AI.codexCommand) &&
      res.tools.codex && res.tools.codex.available && res.tools.codex.path) {
    els.codexCommand.value = res.tools.codex.path;
    changed = true;
  }
  if ((!current.claudeCommand || current.claudeCommand === DEFAULT_AI.claudeCommand) &&
      res.tools.claude && res.tools.claude.available && res.tools.claude.path) {
    els.claudeCommand.value = res.tools.claude.path;
    changed = true;
  }
  if (res.settings && typeof res.settings.workspaceDir === 'string' &&
      (!current.workspaceDir || current.workspaceDir === DEFAULT_AI.workspaceDir)) {
    els.workspaceDir.value = res.settings.workspaceDir;
    changed = true;
  }
  if (res.settings && typeof res.settings.outputDir === 'string' &&
      (!current.outputDir || current.outputDir === DEFAULT_AI.outputDir)) {
    els.outputDir.value = res.settings.outputDir;
    changed = true;
  }
  if (changed) {
    const ai = formToAi();
    writeAiSettings(ai).catch(() => {});
  }
}

els.save.addEventListener('click', () => { save().catch(error => handleUiError('save failed', error)); });
els.health.addEventListener('click', () => { checkHealth().catch(error => handleUiError('health check failed', error)); });
els.testCodex.addEventListener('click', () => { test('codex').catch(error => handleUiError('codex test failed', error)); });
els.testClaude.addEventListener('click', () => { test('claude').catch(error => handleUiError('claude test failed', error)); });
els.openOutputDir.addEventListener('click', () => { openOutputDir().catch(error => handleUiError('open output directory failed', error)); });
els.cleanupGenerated.addEventListener('click', () => { cleanupGenerated().catch(error => handleUiError('cleanup generated JSON failed', error)); });
els.bridgeUrl.addEventListener('input', updateBridgeCommand);

init().catch(error => handleUiError('init failed', error));
