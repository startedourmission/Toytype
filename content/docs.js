// Toytype — 구글 독스 어댑터
// 검사는 본문을 수정하지 않는다. 사용자가 항목을 클릭하면 Google Docs 위치 선택과 교정어 복사만 시도한다.
// 항목의 적용 버튼은 사용자가 직접 누를 때만 Google Docs 내부 찾기/바꾸기로 문서를 수정한다.
'use strict';
(() => {
  const DEFAULT_SETTINGS = {
    schemaVersion: 1,
    docsCategories:    { convert: true, spelling: true, plural: true,  honorific: true,  space1: true,  space2: true,  space3: true,  final: true  },
    genericCategories: { convert: true, spelling: true, plural: false, honorific: false, space1: false, space2: false, space3: false, final: false },
    disabledOrigins:   [],
    tocMaxLevel: 4, // 목차 추출에 포함할 최대 헤딩 레벨 (1~5)
    copyOnSelect: true // 오탈자 선택 시 교정어 클립보드 자동 복사
  };
  const CATEGORY_ORDER = ['convert', 'spelling', 'plural', 'honorific', 'space1', 'space2', 'space3', 'final'];
  const FALLBACK_LABELS = {
    convert: '표기 변환', spelling: '맞춤법', plural: '존대와 복수', honorific: '높임말 서술어',
    space1: '조사 앞 공백', space2: '붙여쓰기', space3: '값 붙이기', final: '맨마지막'
  };
  const CAT_COLOR = {
    convert: 'red', spelling: 'red', final: 'red',
    plural: 'purple', honorific: 'purple',
    space1: 'orange', space2: 'orange', space3: 'orange'
  };
  const SCAN_LIMIT = 500;
  const FETCH_MIN_INTERVAL = 10000; // export 남발 방지 rate limit
  const FETCH_TIMEOUT = 15000;
  const SNIPPET = 20;
  const MATCH_CONTEXT = 80;
  const AI_QUESTION_CONTEXT_BEFORE = 3500;
  const AI_QUESTION_CONTEXT_AFTER = 2500;
  const AI_QUESTION_TIMEOUT = 180000;
  const AI_LENGTH_CONTEXT = 1200;
  const AI_LENGTH_TIMEOUT = 180000;
  const AI_TERMS_TIMEOUT = 180000;
  const DOCX_FETCH_TIMEOUT = 180000;
  const IMAGE_EXTRACT_TIMEOUT = 300000;
  const SENTENCE_SUGGESTION_CATEGORY_ID = 'ai-sentence-suggestions';
  const SENTENCE_SUGGESTION_CATEGORY_LABEL = 'AI 문장 제안';
  const GENERATED_RULES_CACHE_KEY = 'docsGeneratedRulesCacheV1';
  const GENERATED_RULES_CACHE_DOC_LIMIT = 20;
  const GENERATED_RULES_CACHE_FILE_LIMIT = 50;
  const IGNORED_FINDINGS_CACHE_KEY = 'docsIgnoredFindingsV1';
  const IGNORED_FINDINGS_DOC_LIMIT = 50;
  const IGNORED_FINDINGS_PER_DOC_LIMIT = 500;
  const CURSOR_POLL_INTERVAL = 800;
  const BRIDGE_STATUS_POLL_INTERVAL = 5000;
  const BRIDGE_STATUS_STALE_MS = 4000;
  const DEFAULT_BRIDGE_PORT = 17644;
  const FALLBACK_CSS =
    '.trd-wrap{font-family:sans-serif;font-size:13px;color:#202124;line-height:1.45}' +
    '.trd-bubble{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.3)}' +
    '.trd-bubble.trd-alert{background:#d93025}.trd-bubble.trd-idle{background:#5f6368}' +
    '.trd-panel{position:relative;width:320px;max-height:65vh;display:flex;flex-direction:column;background:#fff;border:1px solid #dadce0;border-radius:10px;overflow:hidden}' +
    '.trd-head{display:flex;gap:6px;align-items:center;padding:10px 12px;border-bottom:1px solid #e0e0e0}.trd-btn{flex:none;font-size:12px;padding:4px 9px;cursor:pointer}.trd-icon-btn{width:28px;height:28px;min-width:28px;min-height:28px;display:inline-flex;align-items:center;justify-content:center;padding:0;font-size:17px;line-height:1;vertical-align:top}.trd-svg-icon{width:14px;height:14px;display:block;margin:auto}.trd-close-icon{width:15px;height:15px;display:block;margin:auto}.trd-select{flex:1;min-width:64px;height:28px;border:1px solid #dadce0;border-radius:6px;background:#fff;color:#202124;font:inherit;font-size:12px;padding:0 5px}.trd-view-toggle{flex:none;display:flex;height:28px;border:1px solid #dadce0;border-radius:6px;overflow:hidden;background:#fff}.trd-view-btn{width:28px;height:26px;border:0;border-right:1px solid #dadce0;background:#fff;color:#5f6368;display:flex;align-items:center;justify-content:center;cursor:pointer}.trd-view-btn:last-child{border-right:0}.trd-view-btn.trd-active{background:#e8f0fe;color:#174ea6}.trd-view-icon{width:15px;height:15px;display:block}.trd-file{display:none}.trd-body{flex:1;min-height:0;overflow-y:auto}' +
    '.trd-msg{padding:16px 12px;color:#5f6368}.trd-item{position:relative;padding:8px 74px 9px 18px;border-top:1px solid #f1f3f4;cursor:pointer}.trd-item.trd-selected{background:#e8f0fe;box-shadow:inset 3px 0 0 #1a73e8}.trd-item.trd-copy-only{padding-right:18px}.trd-item.trd-suggestion-item .trd-fix{font-weight:500}.trd-apply-btn,.trd-ignore-btn,.trd-suggestion-delete-btn{position:absolute;top:10px;width:24px;height:24px;border:1px solid #dadce0;border-radius:6px;background:#fff;color:#1a73e8;display:flex;align-items:center;justify-content:center;cursor:pointer}.trd-apply-btn,.trd-suggestion-delete-btn{right:10px}.trd-ignore-btn{right:40px;color:#5f6368}.trd-suggestion-delete-btn{color:#5f6368}.trd-apply-btn:disabled,.trd-ignore-btn:disabled,.trd-suggestion-delete-btn:disabled{opacity:.5;cursor:default}.trd-apply-icon{width:14px;height:14px;display:block}' +
    '.trd-cursor-marker{height:0;border-top:2px solid #1a73e8;margin:2px 0;position:relative}.trd-cursor-marker:before{content:"";position:absolute;left:12px;top:-4px;width:6px;height:6px;border-radius:50%;background:#1a73e8}' +
    '.trd-hit{font-weight:700;color:#d93025}.trd-ctx,.trd-fix,.trd-explain{font-size:12px}.trd-line{color:#80868b;margin-left:6px}.trd-explain{margin-top:4px;color:#5f6368}' +
    '.trd-foot{padding:8px 12px;font-size:11px;color:#80868b;border-top:1px solid #e0e0e0}' +
    '.trd-toast{position:absolute;left:50%;bottom:52px;transform:translateX(-50%);background:#202124;color:#fff;padding:6px 12px;border-radius:16px;font-size:12px;opacity:0;transition:opacity .15s}.trd-toast.trd-show{opacity:1}' +
    '.trd-notice{padding:6px 12px;font-size:12px;background:#fef7e0;color:#b06000}' +
    '.trd-foot{display:flex;align-items:flex-end;gap:8px}.trd-foot-text{flex:1;min-width:0}.trd-bridge-badge{flex:none;height:20px;display:inline-flex;align-items:center;gap:4px;padding:0 6px;border:1px solid #dadce0;border-radius:10px;background:#fff;color:#5f6368;font:inherit;font-size:10px;line-height:18px;cursor:pointer}.trd-bridge-badge:hover{background:#f1f3f4}.trd-bridge-dot{width:6px;height:6px;border-radius:50%;background:#9aa0a6}.trd-bridge-ok .trd-bridge-dot{background:#188038}.trd-bridge-error .trd-bridge-dot{background:#d93025}.trd-bridge-checking .trd-bridge-dot{background:#fbbc04}.trd-addon-status{font-weight:600;color:#3c4043}.trd-addon-status-error{color:#5f6368}.trd-foot-actions{display:flex;align-items:center;gap:6px;flex:none;height:28px;line-height:0}.trd-settings-btn,.trd-terms-btn,.trd-suggestions-btn,.trd-addons-btn{width:28px;height:28px;color:#5f6368}.trd-terms-btn.trd-on,.trd-suggestions-btn.trd-on{background:#e8f0fe;color:#174ea6}.trd-terms-view{padding:10px}.trd-terms-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}.trd-terms-title{font-weight:700;color:#202124}.trd-terms-table-wrap{overflow-x:auto;border:1px solid #e0e0e0;border-radius:6px}.trd-terms-table{width:100%;min-width:560px;border-collapse:collapse;font-size:12px}.trd-terms-table th,.trd-terms-table td{padding:7px 8px;border-bottom:1px solid #f1f3f4;text-align:left;vertical-align:top}.trd-terms-table th{background:#f8f9fa;color:#5f6368}.trd-addons-wrap{position:relative;flex:none;width:28px;height:28px;display:flex;align-items:center}.trd-addons-menu{position:absolute;right:0;bottom:34px;min-width:160px;background:#fff;border:1px solid #dadce0;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.18);padding:4px;z-index:5}.trd-addons-empty{padding:8px 10px;font-size:12px;color:#80868b}.trd-addons-item{display:block;width:100%;text-align:left;border:0;background:#fff;color:#202124;font:inherit;font-size:13px;padding:8px 10px;border-radius:6px;cursor:pointer}.trd-addons-item:hover:not(:disabled){background:#f1f3f4}.trd-addons-item:disabled{opacity:.5;cursor:default}';

  const startedAt = Date.now();

  function debugLogsEnabled() {
    try {
      return localStorage.getItem('toytype:debug') === '1';
    } catch (e) {
      return false;
    }
  }

  function debugLog() {
    if (!debugLogsEnabled()) return;
    console.info.apply(console, arguments);
  }

  function debugWarn() {
    if (!debugLogsEnabled()) return;
    console.warn.apply(console, arguments);
  }

  function debugTable(data) {
    if (!debugLogsEnabled() || typeof console.table !== 'function') return;
    console.table(data);
  }

  let status = 'init'; // 'init'|'disabled'|'scanning'|'ready'|'error'
  let errorCode = null;
  let lastReport = null;
  let builtinRulesJson = null;
  let uploadedRulesJson = null;
  let uploadedRulesLabel = null;
  let activeRulesSource = 'builtin';
  let rulesJson = null;
  let rulesSourceLabel = null;
  let settings = mergeSettings(null);
  let labelMap = Object.assign({}, FALLBACK_LABELS);
  let cachedText = null;  // 모델 텍스트 또는 정규화된 export 텍스트
  let cachedTextSource = null;
  let lastFetchAt = 0;
  let lastModelAt = 0;
  let currentDocId = null;
  let engineKey = null;
  let scanChain = Promise.resolve();
  let modelRequestSeq = 0;
  let selectedFindingKey = null;
  let listMode = 'order';
  let categoryOpenState = Object.create(null);
  let currentCursorOffset = null;
  let cursorPollTimer = null;
  let cursorPollBusy = false;
  let ignoredFindingKeys = new Set();
  let ignoredFindingDocId = null;
  let applyingFindingKey = null;
  let addonBusyActions = new Set();
  let addonStatus = null;
  let addonStatusTimer = null;
  let bridgeStatus = {
    state: 'unknown',
    checkedAt: 0,
    port: DEFAULT_BRIDGE_PORT,
    version: '',
    error: ''
  };
  let bridgeStatusTimer = null;
  let bridgeStatusBusy = false;
  let generatedRulesFiles = [];
  let generatedRulesLoadedDocId = null;
  let termsViewOpen = false;
  let termReport = null;
  let termReportDocId = null;
  let autoTermsStartedDocId = null;
  let autoTermsTimer = null;

  let host = null;
  let shadowRoot = null;
  let shadowView = null;
  let panelCss = null;
  let expanded = false; // 펼침 상태는 메모리만 (미저장)
  let addonsMenuOpen = false; // 푸터 추가기능 메뉴 펼침 상태 (메모리만)
  let suggestionsViewOpen = false; // AI 문장 제안 전용 보기
  let nativeControlInteractionUntil = 0;
  let deferredRenderOptions = null;
  let deferredRenderTimer = null;
  let toastTimer = null;
  let cooldownTimer = null;
  let settingsTimer = null;
  let pageBridgeReady = false;
  let pageBridgeInjected = false;
  let pageBridgeReadyAt = null;
  let pageBridgeLoadAt = null;
  let pageBridgeErrorAt = null;
  let pageBridgeInjectAttempts = 0;

  // ---------- 설정 ----------

  function mergeSettings(stored) {
    const s = stored && typeof stored === 'object' ? stored : {};
    return {
      schemaVersion: 1,
      docsCategories: Object.assign({}, DEFAULT_SETTINGS.docsCategories, s.docsCategories || {}),
      genericCategories: Object.assign({}, DEFAULT_SETTINGS.genericCategories, s.genericCategories || {}),
      disabledOrigins: Array.isArray(s.disabledOrigins) ? s.disabledOrigins : [],
      tocMaxLevel: normalizeTocMaxLevel(s.tocMaxLevel),
      copyOnSelect: s.copyOnSelect !== false
    };
  }

  function normalizeTocMaxLevel(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 1 ? Math.min(5, Math.floor(n)) : DEFAULT_SETTINGS.tocMaxLevel;
  }

  function readSettings() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get('settings', items => {
          const stored = chrome.runtime.lastError ? null : items && items.settings;
          resolve(mergeSettings(stored));
        });
      } catch (e) {
        resolve(mergeSettings(null));
      }
    });
  }

  function isOriginDisabled() {
    return settings.disabledOrigins.includes(location.origin);
  }

  // ---------- 규칙·엔진 ----------

  function loadRules() {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: 'typo:getRules' }, res => {
          if (chrome.runtime.lastError || !res || !res.ok || !res.rules) {
            resolve(false);
            return;
          }
          try {
            validateRulesJson(res.rules);
            builtinRulesJson = res.rules;
            useRulesSource(canUseRulesSource(activeRulesSource) ? activeRulesSource : 'builtin');
            resolve(true);
          } catch (e) {
            resolve(false);
          }
        });
      } catch (e) {
        resolve(false);
      }
    });
  }

  function setUploadedRulesJson(nextRulesJson, sourceLabel) {
    validateRulesJson(nextRulesJson);
    uploadedRulesJson = nextRulesJson;
    uploadedRulesLabel = sourceLabel || 'uploaded.json';
    useRulesSource('uploaded');
  }

  function useRulesSource(source) {
    let nextRulesJson = null;
    let sourceLabel = null;
    if (source === 'uploaded' && uploadedRulesJson) {
      nextRulesJson = uploadedRulesJson;
      sourceLabel = uploadedRulesLabel || 'uploaded.json';
      activeRulesSource = 'uploaded';
    } else if (isGeneratedRulesSource(source)) {
      const generated = findGeneratedRulesFile(source);
      if (generated) {
        nextRulesJson = generated.json;
        sourceLabel = generated.displayName || generated.fileName;
        activeRulesSource = source;
      }
    } else {
      nextRulesJson = builtinRulesJson;
      sourceLabel = null;
      activeRulesSource = 'builtin';
    }
    if (!nextRulesJson && source !== 'builtin') {
      nextRulesJson = builtinRulesJson;
      sourceLabel = null;
      activeRulesSource = 'builtin';
    }
    if (!nextRulesJson) throw new Error('rules source unavailable');
    rulesJson = nextRulesJson;
    rulesSourceLabel = sourceLabel;
    selectedFindingKey = null;
    labelMap = Object.assign({}, FALLBACK_LABELS);
    for (const c of rulesJson.categories) {
      if (c && c.id) labelMap[c.id] = c.label || labelMap[c.id] || c.id;
    }
    engineKey = null;
  }

  function canUseRulesSource(source) {
    if (source === 'builtin') return !!builtinRulesJson;
    if (source === 'uploaded') return !!uploadedRulesJson;
    if (isGeneratedRulesSource(source)) return !!findGeneratedRulesFile(source);
    return false;
  }

  function isGeneratedRulesSource(source) {
    return typeof source === 'string' && source.indexOf('generated:') === 0;
  }

  function generatedRulesSourceValue(fileName) {
    return 'generated:' + String(fileName || '');
  }

  function generatedFileNameFromSource(source) {
    return String(source || '').slice('generated:'.length);
  }

  function isSentenceSuggestionSource(source) {
    return isGeneratedRulesSource(source) && isSentenceSuggestionFileName(generatedFileNameFromSource(source));
  }

  function isSentenceSuggestionFileName(fileName) {
    return /-문장제안\.json$/i.test(String(fileName || ''));
  }

  function isSentenceSuggestionRulesActive() {
    if (isSentenceSuggestionSource(activeRulesSource)) return true;
    if (rulesJson && typeof rulesJson.source === 'string' && rulesJson.source.indexOf('sentence-suggestions:') === 0) return true;
    if (!rulesJson || !Array.isArray(rulesJson.categories)) return false;
    return rulesJson.categories.some(cat => cat && cat.id === SENTENCE_SUGGESTION_CATEGORY_ID);
  }

  function findGeneratedRulesFile(source) {
    const fileName = generatedFileNameFromSource(source);
    const file = generatedRulesFiles.find(item => item.fileName === fileName);
    if (file) return file;
    const virtualFile = virtualSentenceSuggestionFile();
    if (virtualFile && fileName === virtualFile.fileName) return virtualFile;
    return null;
  }

  function generatedRulesFilesForSelect() {
    return generatedRulesFiles.filter(file => !isSentenceSuggestionFileName(file && file.fileName));
  }

  function virtualSentenceSuggestionFile() {
    const docId = getDocId();
    if (!docId) return null;
    const fileName = sentenceSuggestionFileNameForDoc(docId);
    return {
      fileName,
      displayName: '문장제안.json',
      outputPath: '',
      mtimeMs: 0,
      virtual: true,
      json: emptySentenceSuggestionJson(docId)
    };
  }

  function sentenceSuggestionFileNameForDoc(docId) {
    return String(docId || 'document') + '-문장제안.json';
  }

  function emptySentenceSuggestionJson(docId) {
    return {
      version: new Date().toISOString().slice(0, 10),
      source: 'sentence-suggestions:' + (documentTitleForAddon ? documentTitleForAddon() : docId || 'Google Docs document'),
      categories: [{
        id: SENTENCE_SUGGESTION_CATEGORY_ID,
        label: SENTENCE_SUGGESTION_CATEGORY_LABEL,
        defaultOn: true,
        rules: []
      }],
      notes: [],
      documentId: docId || '',
      documentTitle: documentTitleForAddon ? documentTitleForAddon() : '',
      documentUrl: location.href
    };
  }

  function validateRulesJson(value) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.categories) || value.categories.length === 0) {
      throw new Error('invalid rules json');
    }
    for (let i = 0; i < value.categories.length; i++) {
      const cat = value.categories[i];
      if (!cat || typeof cat !== 'object' || typeof cat.id !== 'string' || cat.id === '' || !Array.isArray(cat.rules)) {
        throw new Error('invalid category at index ' + i);
      }
      for (let j = 0; j < cat.rules.length; j++) {
        const rule = cat.rules[j];
        if (!Array.isArray(rule) || typeof rule[0] !== 'string' || typeof rule[1] !== 'string') {
          throw new Error('invalid rule in category ' + cat.id + ' at index ' + j);
        }
        if (rule.length > 3 || (rule.length === 3 && !validRuleOptions(rule[2]))) {
          throw new Error('invalid rule options in category ' + cat.id + ' at index ' + j);
        }
      }
    }
  }

  function validRuleOptions(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return validStringList(value.rejectBefore) && validStringList(value.rejectAfter);
  }

  function validStringList(value) {
    return value === undefined ||
      typeof value === 'string' ||
      (Array.isArray(value) && value.every(item => typeof item === 'string'));
  }

  function initEngine() {
    const enabled = categoryIdsInOrder().filter(id => settings.docsCategories[id] !== false);
    const key = enabled.join(',');
    if (key === engineKey) return;
    globalThis.TypoEngine.init(rulesJson, enabled);
    engineKey = key;
  }

  function labelOf(catId) {
    return labelMap[catId] || catId;
  }

  function categoryIdsInOrder() {
    if (rulesJson && Array.isArray(rulesJson.categories)) {
      return rulesJson.categories.map(c => c.id);
    }
    return CATEGORY_ORDER;
  }

  // ---------- 텍스트 취득 ----------

  function getDocId() {
    const m = location.pathname.match(/\/document\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : null;
  }

  function fetchExport(docId) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    // 멀티 계정 세션 대응: /document/u/N/ 컨텍스트를 보존해야 두 번째 계정 문서도 권한이 맞는다
    const um = location.pathname.match(/\/document\/u\/(\d+)\//);
    const url = 'https://docs.google.com/document/' + (um ? 'u/' + um[1] + '/' : '') +
      'd/' + docId + '/export?format=txt';
    // 동일출처 fetch — 세션 쿠키 자동 포함
    return fetch(url, { signal: ctrl.signal })
      .then(res => {
        if (!res.ok) throw new Error('export http ' + res.status);
        // 로그인 리다이렉트 등이 200 + HTML로 떨어지면 본문으로 오인 스캔하게 된다 — 차단
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (ct && ct.indexOf('text/plain') === -1) throw new Error('export content-type: ' + ct);
        return res.text();
      })
      .then(t => {
        if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); // BOM 제거
        return t.replace(/\r/g, ''); // 그 외 트리밍·공백 정리 금지 (space1 보존)
      })
      .finally(() => clearTimeout(timer));
  }

  function fetchDocxExport(docId) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DOCX_FETCH_TIMEOUT);
    const um = location.pathname.match(/\/document\/u\/(\d+)\//);
    const url = 'https://docs.google.com/document/' + (um ? 'u/' + um[1] + '/' : '') +
      'd/' + docId + '/export?format=docx';
    return fetch(url, { signal: ctrl.signal })
      .then(res => {
        if (!res.ok) throw new Error('docx export http ' + res.status);
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (ct && ct.indexOf('text/html') !== -1) throw new Error('docx export content-type: ' + ct);
        return res.arrayBuffer();
      })
      .finally(() => clearTimeout(timer));
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function fetchModelText(docId) {
    return requestDocsModel('getText', { docId }).then(res => {
      if (!res || !res.ok || typeof res.text !== 'string') {
        throw new Error(res && res.errorMessage ? res.errorMessage : 'model text unavailable');
      }
      return { text: res.text, selection: res.selection || null };
    });
  }

  // ---------- 응답 빌더 ----------

  function baseFields() {
    return { context: 'docs', url: location.href, origin: location.origin };
  }

  function notReadyResponse() {
    return Object.assign({ ok: false, error: 'not_ready', disabled: false }, baseFields());
  }

  function errorResponse() {
    return Object.assign({ ok: false, error: errorCode || 'internal', disabled: false }, baseFields());
  }

  function disabledReport() {
    return Object.assign({
      ok: true, disabled: true,
      rulesVersion: rulesJson ? rulesJson.version : null,
      scannedAt: null, fetchedAt: null, cached: false,
      total: 0, truncated: false, categoryCounts: {}, findings: []
    }, baseFields());
  }

  // ---------- 스캔 ----------

  function buildUIFindings(text, engineFindings, textSource) {
    const out = [];
    let line = 1;
    let pos = 0;
    const nonEmptyLineByLine = buildNonEmptyLineMap(text);
    for (let i = 0; i < engineFindings.length; i++) {
      const f = engineFindings[i];
      while (pos < f.start) {
        if (isVisualLineBreakCode(text.charCodeAt(pos))) line++;
        pos++;
      }
      out.push({
        idx: i,
        src: f.src,
        dst: f.dst,
        cat: f.cat,
        catLabel: labelOf(f.cat),
        start: f.start,
        end: f.end,
        selectable: textSource === 'model',
        textSource,
        before: snippetText(text.slice(Math.max(0, f.start - SNIPPET), f.start)),
        after: snippetText(text.slice(f.end, f.end + SNIPPET)),
        contextBefore: text.slice(Math.max(0, f.start - MATCH_CONTEXT), f.start),
        contextAfter: text.slice(f.end, f.end + MATCH_CONTEXT),
        line,
        textLine: nonEmptyLineByLine[line] || line
      });
    }
    return appendMissingSentenceSuggestionFindings(out, textSource);
  }

  function appendMissingSentenceSuggestionFindings(findings, textSource) {
    if (!isSentenceSuggestionRulesActive()) return findings;
    if (!rulesJson || !Array.isArray(rulesJson.categories)) return findings;
    const seen = new Set(findings.map(f => sentenceSuggestionRuleKey(f.cat, f.src, f.dst)));
    let idx = findings.length;
    for (const cat of rulesJson.categories) {
      if (!cat || cat.id !== SENTENCE_SUGGESTION_CATEGORY_ID || !Array.isArray(cat.rules)) continue;
      for (const rule of cat.rules) {
        if (!Array.isArray(rule) || typeof rule[0] !== 'string' || typeof rule[1] !== 'string') continue;
        const key = sentenceSuggestionRuleKey(cat.id, rule[0], rule[1]);
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          idx: idx++,
          src: rule[0],
          dst: rule[1],
          cat: cat.id,
          catLabel: labelOf(cat.id),
          start: Number.MAX_SAFE_INTEGER,
          end: Number.MAX_SAFE_INTEGER,
          selectable: false,
          textSource,
          before: '',
          after: '',
          contextBefore: '',
          contextAfter: '',
          line: '제안',
          textLine: Number.MAX_SAFE_INTEGER,
          missingFromDocument: true
        });
      }
    }
    return findings;
  }

  function sentenceSuggestionRuleKey(cat, src, dst) {
    return [String(cat || ''), String(src || ''), String(dst || '')].join('\u0001');
  }

  function buildNonEmptyLineMap(text) {
    const map = {};
    const lines = text.split(/[\n\v]/);
    let n = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/\S/.test(lines[i])) n++;
      map[i + 1] = n || 1;
    }
    return map;
  }

  function isVisualLineBreakCode(code) {
    return code === 10 || code === 11;
  }

  function snippetText(s) {
    return String(s || '').replace(/[\u0000-\u0008\u000e-\u001f]/g, '').replace(/\s+/g, ' ');
  }

  async function performScan(allowFetch, scanOpts) {
    const docId = getDocId();
    if (!docId) return notReadyResponse();
    const renderScan = () => {
      render({ preserveBodyScroll: !!(scanOpts && scanOpts.preserveBodyScroll) });
    };
    if (docId !== currentDocId) {
      // SPA 문서 전환 — 캐시 무효화 후 재초기화
      currentDocId = docId;
      cachedText = null;
      cachedTextSource = null;
      lastFetchAt = 0;
      lastModelAt = 0;
      selectedFindingKey = null;
      currentCursorOffset = null;
      generatedRulesFiles = [];
      generatedRulesLoadedDocId = null;
      await loadIgnoredFindingsForCurrentDoc();
      loadCachedGeneratedRulesListQuiet();
      refreshGeneratedRulesListQuiet();
    } else if (ignoredFindingDocId !== docId) {
      await loadIgnoredFindingsForCurrentDoc();
    }
    // quiet: 적용 파이프라인 내부 재스캔 — 목록을 '검사 중…'으로 비우지 않고
    // 기존 패널을 유지한 채 결과만 갱신한다 (불필요한 전체 리렌더 2회 제거).
    if (!(scanOpts && scanOpts.quiet)) {
      status = 'scanning';
      renderScan();
    }

    const perf = { textSource: null, textLength: 0, fetchMs: null, scanMs: null, buildMs: null, renderMs: null, totalMs: null };
    const perfStartedAt = Date.now();

    let text = null;
    let textSource = null;
    let cached = false;
    const providedText = scanOpts && typeof scanOpts.providedText === 'string' ? scanOpts.providedText : null;
    if (providedText !== null) {
      // 적용 검증이 방금 읽어 온 본문 — 재취득 없이 그대로 스캔한다.
      // 단 그 사이 더 새 모델 텍스트로 스캔된 적이 있으면 구식 텍스트로 되돌리지 않는다.
      const providedTextAt = Number(scanOpts.providedTextAt) || Date.now();
      if (lastModelAt > providedTextAt && lastReport) return lastReport;
      text = providedText;
      textSource = 'model';
      cachedText = text;
      cachedTextSource = textSource;
      lastModelAt = providedTextAt;
      perf.fetchMs = 0;
    } else if (allowFetch) {
      try {
        const fetchStartedAt = Date.now();
        const model = await fetchModelText(docId);
        perf.fetchMs = Date.now() - fetchStartedAt;
        text = model.text;
        textSource = 'model';
        cachedText = text;
        cachedTextSource = textSource;
        lastModelAt = Date.now();
        updateCursorOffset(model.selection);
      } catch (e) {
        // 내부 모델 API가 막히면 기존 export 경로로 내려간다.
      }
    }
    if (text === null) {
      if (allowFetch && Date.now() - lastFetchAt >= FETCH_MIN_INTERVAL) {
        try {
          const exportStartedAt = Date.now();
          text = await fetchExport(docId);
          perf.fetchMs = Date.now() - exportStartedAt;
          textSource = 'export';
          cachedText = text;
          cachedTextSource = textSource;
          currentCursorOffset = null;
          lastFetchAt = Date.now();
        } catch (e) {
          status = 'error';
          errorCode = 'export_failed';
          sendCount(0);
          renderScan();
          return errorResponse();
        }
      } else if (cachedText !== null) {
        text = cachedText;
        textSource = cachedTextSource || 'cache';
        cached = true;
      } else {
        status = 'init';
        renderScan();
        return notReadyResponse();
      }
    }

    try {
      initEngine();
    } catch (e) {
      status = 'error';
      errorCode = 'rules_load_failed';
      sendCount(0);
      renderScan();
      return errorResponse();
    }

    let result;
    try {
      const scanStartedAt = Date.now();
      result = globalThis.TypoEngine.scan(text, { limit: SCAN_LIMIT });
      perf.scanMs = Date.now() - scanStartedAt;
    } catch (e) {
      status = 'error';
      errorCode = 'internal';
      sendCount(0);
      renderScan();
      return errorResponse();
    }

    const buildStartedAt = Date.now();
    const findings = filterIgnoredFindings(buildUIFindings(text, result.findings, textSource));
    const categoryCounts = {};
    for (const f of findings) categoryCounts[f.cat] = (categoryCounts[f.cat] || 0) + 1;
    perf.buildMs = Date.now() - buildStartedAt;

    lastReport = Object.assign({
      ok: true,
      disabled: false,
      rulesVersion: rulesJson ? rulesJson.version : null,
      rulesSource: activeRulesSource,
      rulesSourceLabel,
      scannedAt: Date.now(),
      fetchedAt: textSource === 'model' ? (lastModelAt || null) : (lastFetchAt || null),
      cached,
      textSource,
      total: findings.length,
      truncated: !!result.truncated,
      categoryCounts,
      findings
    }, baseFields());
    status = 'ready';
    errorCode = null;
    sendCount(lastReport.total);
    const renderStartedAt = Date.now();
    renderScan();
    perf.renderMs = Date.now() - renderStartedAt;
    perf.textSource = textSource;
    perf.textLength = text.length;
    perf.totalMs = Date.now() - perfStartedAt;
    lastReport.perf = perf;
    debugLog('[Toytype perf] scan', JSON.stringify(Object.assign({ total: findings.length, cached }, perf)));
    return lastReport;
  }

  function enqueueScan(allowFetch, scanOpts) {
    const run = scanChain.then(() => performScan(allowFetch, scanOpts)).catch(() => {
      status = 'error';
      if (!errorCode) errorCode = 'internal';
      sendCount(0);
      render();
      return errorResponse();
    });
    scanChain = run.then(() => {});
    return run;
  }

  function sendCount(count) {
    try {
      chrome.runtime.sendMessage({ type: 'typo:count', count }, () => {
        void chrome.runtime.lastError; // 응답 없는 메시지 — 에러 무시
      });
    } catch (e) { /* 확장 컨텍스트 무효화 등 */ }
  }

  // ---------- 패널 (Shadow DOM) ----------

  async function loadPanelCss() {
    if (panelCss !== null) return panelCss;
    try {
      const res = await fetch(chrome.runtime.getURL('content/docs-panel.css'));
      if (res.ok) {
        panelCss = await res.text();
        return panelCss;
      }
    } catch (e) { /* 폴백 사용 */ }
    panelCss = FALLBACK_CSS;
    return panelCss;
  }

  async function injectPanel() {
    if (host && host.isConnected) return;
    const stale = document.getElementById('typo-radar-root');
    if (stale) stale.remove(); // 이전 컨텍스트 잔재 — 호스트 div는 1개만
    host = document.createElement('div');
    host.id = 'typo-radar-root';
    host.style.cssText = 'position:fixed;right:24px;bottom:96px;z-index:2147483646;';
    shadowRoot = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = await loadPanelCss();
    shadowRoot.appendChild(style);
    shadowView = el('div', 'trd-wrap');
    shadowRoot.appendChild(shadowView);
    (document.body || document.documentElement).appendChild(host);
    render();
  }

  function removePanel() {
    if (host) host.remove();
    host = shadowRoot = shadowView = null;
    expanded = false;
    nativeControlInteractionUntil = 0;
    deferredRenderOptions = null;
    clearTimeout(deferredRenderTimer);
    deferredRenderTimer = null;
    clearTimeout(toastTimer);
    clearTimeout(cooldownTimer);
    stopAddonStatusTicker();
    stopCursorWatcher();
    stopBridgeStatusWatcher();
    clearTimeout(autoTermsTimer);
    autoTermsTimer = null;
  }

  function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function uploadIcon() {
    return strokedSvg(['M12 3v12', 'M7 8l5-5 5 5', 'M5 15v4h14v-4'], 'trd-svg-icon');
  }

  function viewModeIcon(mode) {
    if (mode === 'order') {
      return strokedSvg(['M8 6h10', 'M8 12h10', 'M8 18h10', 'M5 6h.01', 'M5 12h.01', 'M5 18h.01'], 'trd-view-icon');
    }
    return strokedSvg(['M5 5h6v6H5z', 'M13 5h6v6h-6z', 'M5 13h6v6H5z', 'M13 13h6v6h-6z'], 'trd-view-icon');
  }

  function closeIcon() {
    return strokedSvg(['M6 6l12 12', 'M18 6L6 18'], 'trd-close-icon');
  }

  function ignoreIcon() {
    return strokedSvg(['M7 7l10 10', 'M17 7L7 17'], 'trd-apply-icon');
  }

  function applyIcon() {
    return strokedSvg(['M20 6L9 17l-5-5'], 'trd-apply-icon');
  }

  function suggestionsIcon() {
    return strokedSvg(['M8 7h8', 'M8 12h6', 'M5 4h14v14H8l-3 3z'], 'trd-svg-icon');
  }

  function termsIcon() {
    return strokedSvg(['M4 6h16', 'M4 12h16', 'M4 18h16', 'M8 6v12', 'M15 6v12'], 'trd-svg-icon');
  }

  // 추가기능 아이콘 — 격자 4칸(기능 묶음) 모양
  function addonsIcon() {
    return strokedSvg(['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h6v6h-6z'], 'trd-svg-icon');
  }

  function settingsIcon() {
    return strokedSvg([
      'M9.67 4.14a2.34 2.34 0 0 1 4.66 0 2.34 2.34 0 0 0 3.32 1.91 2.34 2.34 0 0 1 2.33 4.03 2.34 2.34 0 0 0 0 3.84 2.34 2.34 0 0 1-2.33 4.03 2.34 2.34 0 0 0-3.32 1.91 2.34 2.34 0 0 1-4.66 0 2.34 2.34 0 0 0-3.32-1.91 2.34 2.34 0 0 1-2.33-4.03 2.34 2.34 0 0 0 0-3.84 2.34 2.34 0 0 1 2.33-4.03 2.34 2.34 0 0 0 3.32-1.91z',
      'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'
    ], 'trd-svg-icon');
  }

  function trashIcon() {
    return strokedSvg([
      'M3 6h18',
      'M8 6V4h8v2',
      'M19 6l-1 14H6L5 6',
      'M10 11v6',
      'M14 11v6'
    ], 'trd-apply-icon');
  }

  function addonActions() {
    return [
      { id: 'ai-proofread', label: 'AI 교정 생성', run: handleAiProofreadAddon },
      { id: 'ai-question', label: 'AI 문장 삽입', run: handleAiQuestionAddon },
      { id: 'ai-length', label: 'AI 문장 길이 조절', run: handleAiLengthAddon },
      { id: 'extract-images', label: '이미지 추출', run: handleExtractImagesAddon },
      { id: 'extract-toc', label: '목차 추출', run: handleExtractTocAddon }
    ];
  }

  function isAddonBusy(actionId) {
    return addonBusyActions.has(actionId);
  }

  function setAddonBusy(actionId, busy) {
    if (busy) addonBusyActions.add(actionId);
    else addonBusyActions.delete(actionId);
  }

  function buildAddonsButton() {
    const wrap = el('div', 'trd-addons-wrap');
    const btn = el('button', 'trd-btn trd-icon-btn trd-addons-btn' + (addonsMenuOpen ? ' trd-on' : ''));
    btn.type = 'button';
    btn.appendChild(addonsIcon());
    btn.setAttribute('aria-label', '추가기능');
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', addonsMenuOpen ? 'true' : 'false');
    btn.title = '추가기능';
    btn.disabled = applyingFindingKey !== null;
    btn.addEventListener('click', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      addonsMenuOpen = !addonsMenuOpen;
      suggestionsViewOpen = false;
      termsViewOpen = false;
      render();
    });
    wrap.appendChild(btn);
    if (addonsMenuOpen) wrap.appendChild(buildAddonsMenu());
    return wrap;
  }

  function buildSuggestionsButton() {
    const btn = el('button', 'trd-btn trd-icon-btn trd-suggestions-btn' + (suggestionsViewOpen ? ' trd-on' : ''));
    btn.type = 'button';
    btn.appendChild(suggestionsIcon());
    btn.setAttribute('aria-label', '문장 제안');
    btn.setAttribute('aria-pressed', suggestionsViewOpen ? 'true' : 'false');
    btn.title = '문장 제안';
    btn.addEventListener('click', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      addonsMenuOpen = false;
      termsViewOpen = false;
      suggestionsViewOpen = !suggestionsViewOpen;
      if (suggestionsViewOpen) {
        loadCachedGeneratedRulesListQuiet();
        refreshGeneratedRulesListQuiet();
        if (cachedText === null) enqueueScan(true, { quiet: true });
      }
      render();
    });
    return btn;
  }

  function buildTermsButton() {
    const btn = el('button', 'trd-btn trd-icon-btn trd-terms-btn' + (termsViewOpen ? ' trd-on' : ''));
    btn.type = 'button';
    btn.appendChild(termsIcon());
    btn.setAttribute('aria-label', 'AI 용어 표');
    btn.setAttribute('aria-pressed', termsViewOpen ? 'true' : 'false');
    btn.title = 'AI 용어 표';
    btn.disabled = isAddonBusy('ai-terms');
    btn.addEventListener('click', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      addonsMenuOpen = false;
      suggestionsViewOpen = false;
      const docId = getDocId();
      if (termsViewOpen && termReport && termReportDocId === docId) {
        termsViewOpen = false;
        render();
        return;
      }
      termsViewOpen = true;
      render();
      if (!termReport || termReportDocId !== docId) {
        handleAiTermsAddon();
      }
    });
    return btn;
  }

  function buildSettingsButton() {
    const btn = el('button', 'trd-btn trd-icon-btn trd-settings-btn');
    btn.type = 'button';
    btn.appendChild(settingsIcon());
    btn.setAttribute('aria-label', '설정');
    btn.title = '설정';
    btn.addEventListener('click', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      addonsMenuOpen = false;
      termsViewOpen = false;
      openSettingsPageFromDocs();
    });
    return btn;
  }

  function buildFooterActions() {
    const wrap = el('div', 'trd-foot-actions');
    wrap.append(buildSettingsButton(), buildTermsButton(), buildSuggestionsButton(), buildAddonsButton());
    return wrap;
  }

  function buildBridgeStatusBadge() {
    const state = bridgeStatus && bridgeStatus.state ? bridgeStatus.state : 'unknown';
    const btn = el('button', 'trd-bridge-badge trd-bridge-' + state);
    btn.type = 'button';
    btn.title = bridgeStatusTitle();
    btn.setAttribute('aria-label', bridgeStatusAriaLabel());
    const dot = el('span', 'trd-bridge-dot');
    btn.appendChild(dot);
    const labelText = bridgeStatusLabel();
    if (labelText) {
      const label = el('span', 'trd-bridge-label');
      label.textContent = labelText;
      btn.appendChild(label);
    }
    btn.addEventListener('click', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      handleBridgeStatusBadgeClick();
    });
    return btn;
  }

  function buildAddonsMenu() {
    const menu = el('div', 'trd-addons-menu');
    menu.setAttribute('role', 'menu');
    const actions = addonActions();
    if (!actions.length) {
      const empty = el('div', 'trd-addons-empty');
      empty.textContent = '추가된 기능이 없습니다';
      menu.appendChild(empty);
      return menu;
    }
    for (const action of actions) {
      const item = el('button', 'trd-addons-item');
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.textContent = action.label;
      item.disabled = applyingFindingKey !== null || isAddonBusy(action.id);
      item.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        addonsMenuOpen = false;
        render();
        action.run();
      });
      menu.appendChild(item);
    }
    return menu;
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

  // 표시 규약: 선두·후미 공백(U+0020)은 ␣로, 빈 dst는 ∅(삭제)로. 데이터는 변형하지 않는다.
  function displayText(s) {
    if (s === '') return '∅(삭제)';
    return s.replace(/^ +| +$/g, m => '␣'.repeat(m.length));
  }

  function timeStr(ts) {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function render(options) {
    if (!shadowView) return;
    const opts = options && typeof options === 'object' ? options : {};
    if (shouldDeferRenderForNativeControl(opts)) {
      deferRender(opts);
      return;
    }
    const prevBody = opts.preserveBodyScroll ? shadowView.querySelector('.trd-body') : null;
    const prevBodyScrollTop = prevBody ? prevBody.scrollTop : 0;
    shadowView.textContent = '';
    shadowView.appendChild(expanded ? buildPanel() : buildBubble());
    if (opts.preserveBodyScroll) {
      const nextBody = shadowView.querySelector('.trd-body');
      if (nextBody) nextBody.scrollTop = prevBodyScrollTop;
    } else if (shouldFollowCursorInOrderList()) {
      scheduleCursorListFollow();
    }
    syncCursorWatcher();
    syncBridgeStatusWatcher();
    scheduleAutoTermsAnalysis();
  }

  function scheduleAutoTermsAnalysis() {
    if (!expanded) return;
    if (autoTermsTimer) return;
    autoTermsTimer = setTimeout(() => {
      autoTermsTimer = null;
      maybeStartAutoTermsAnalysis();
    }, 0);
  }

  function maybeStartAutoTermsAnalysis() {
    if (!expanded) return;
    if (!bridgeStatus || bridgeStatus.state !== 'ok') return;
    const docId = getDocId();
    if (!docId) return;
    if (autoTermsStartedDocId === docId) return;
    if (termReport && termReportDocId === docId) return;
    if (addonBusyActions.size > 0) return;
    autoTermsStartedDocId = docId;
    handleAiTermsAddon({ openView: false, toast: false });
  }

  function noteNativeControlInteraction(ms) {
    const duration = Number.isFinite(Number(ms)) ? Number(ms) : 1200;
    nativeControlInteractionUntil = Math.max(nativeControlInteractionUntil, Date.now() + Math.max(0, duration));
  }

  function shouldDeferRenderForNativeControl(opts) {
    if (!expanded || opts.force) return false;
    return isNativeControlInteractionActive();
  }

  function isNativeControlInteractionActive() {
    return Date.now() < nativeControlInteractionUntil;
  }

  function deferRender(opts) {
    const next = Object.assign({}, deferredRenderOptions || {}, opts || {});
    if ((deferredRenderOptions && deferredRenderOptions.preserveBodyScroll) || (opts && opts.preserveBodyScroll)) {
      next.preserveBodyScroll = true;
    }
    deferredRenderOptions = next;
    clearTimeout(deferredRenderTimer);
    deferredRenderTimer = setTimeout(flushDeferredRender, Math.max(80, nativeControlInteractionUntil - Date.now() + 80));
  }

  function flushDeferredRender() {
    if (!deferredRenderOptions) return;
    if (isNativeControlInteractionActive()) {
      deferRender(deferredRenderOptions);
      return;
    }
    const opts = deferredRenderOptions;
    deferredRenderOptions = null;
    deferredRenderTimer = null;
    render(Object.assign({}, opts, { force: true }));
  }

  function shouldFollowCursorInOrderList() {
    return expanded &&
      !suggestionsViewOpen &&
      status === 'ready' &&
      lastReport &&
      lastReport.textSource === 'model' &&
      listMode === 'order' &&
      shouldShowCursorMarker();
  }

  function scheduleCursorListFollow() {
    requestAnimationFrame(() => {
      if (!shouldFollowCursorInOrderList() || !shadowView) return;
      const body = shadowView.querySelector('.trd-body');
      const marker = body && body.querySelector('.trd-cursor-marker');
      if (!body || !marker) return;
      scrollPanelBodyToMarker(body, marker);
    });
  }

  function scrollPanelBodyToMarker(body, marker) {
    const bodyRect = body.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    if (!bodyRect.height) return;
    const margin = 24;
    if (markerRect.top >= bodyRect.top + margin && markerRect.bottom <= bodyRect.bottom - margin) return;
    const bodyCenter = bodyRect.top + body.clientHeight / 2;
    const markerCenter = markerRect.top + markerRect.height / 2;
    body.scrollTop += markerCenter - bodyCenter;
  }

  function buildBubble() {
    const b = el('div', 'trd-bubble');
    b.setAttribute('role', 'button');
    if (status === 'error') {
      b.textContent = '!';
      b.classList.add('trd-idle');
    } else if (status === 'ready' && lastReport) {
      const n = lastReport.total;
      b.textContent = n > 99 ? '99+' : String(n);
      b.classList.add(n > 0 ? 'trd-alert' : 'trd-idle');
    } else {
      b.textContent = '…';
      b.classList.add('trd-idle');
    }
    b.addEventListener('click', () => {
      expanded = true;
      render();
      refreshGeneratedRulesListQuiet();
    });
    return b;
  }

  function buildPanel() {
    const panel = el('div', 'trd-panel');

    // 헤더
    const head = el('div', 'trd-head');
    const rulesSelect = buildRulesSourceSelect();
    const viewToggle = buildListModeToggle();
    const rescanBtn = el('button', 'trd-btn trd-icon-btn');
    rescanBtn.type = 'button';
    rescanBtn.textContent = '↻';
    rescanBtn.setAttribute('aria-label', '다시 검사');
    rescanBtn.title = '다시 검사';
    const remain = lastReport && lastReport.textSource === 'model' ? 0 : (lastFetchAt ? lastFetchAt + FETCH_MIN_INTERVAL - Date.now() : 0);
    if (remain > 0) {
      rescanBtn.disabled = true; // 스캔 직후 10초 비활성화 표시
      rescanBtn.title = '10초 후 다시 검사할 수 있습니다';
      clearTimeout(cooldownTimer);
      cooldownTimer = setTimeout(() => { if (expanded) render(); }, remain + 100);
    }
    rescanBtn.addEventListener('click', () => { handleRescan(); });
    const jsonInput = document.createElement('input');
    jsonInput.type = 'file';
    jsonInput.accept = 'application/json,.json';
    jsonInput.className = 'trd-file';
    jsonInput.addEventListener('change', () => {
      const file = jsonInput.files && jsonInput.files[0];
      jsonInput.value = '';
      if (file) handleRulesJsonUpload(file);
    });
    const jsonBtn = el('button', 'trd-btn trd-icon-btn');
    jsonBtn.type = 'button';
    jsonBtn.appendChild(uploadIcon());
    jsonBtn.setAttribute('aria-label', 'JSON 업로드');
    jsonBtn.title = 'JSON 업로드';
    jsonBtn.addEventListener('click', () => { jsonInput.click(); });
    const closeBtn = el('button', 'trd-btn trd-icon-btn');
    closeBtn.type = 'button';
    closeBtn.appendChild(closeIcon());
    closeBtn.setAttribute('aria-label', '접기');
    closeBtn.title = '접기';
    closeBtn.addEventListener('click', () => {
      expanded = false;
      render();
    });
    head.appendChild(rulesSelect);
    head.append(viewToggle, rescanBtn, jsonBtn, closeBtn, jsonInput);
    panel.appendChild(head);

    // 알림 줄
    if (status === 'ready' && lastReport) {
      if (lastReport.truncated) {
        const n = el('div', 'trd-notice');
        n.textContent = '500건 초과 — 일부만 표시';
        panel.appendChild(n);
      }
    }

    // 본문
    const body = el('div', 'trd-body');
    if (termsViewOpen) {
      appendTermsView(body);
    } else if (suggestionsViewOpen) {
      appendSentenceSuggestionsView(body);
    } else if (status === 'error') {
      const msg = el('div', 'trd-msg trd-error');
      msg.textContent = errorCode === 'rules_load_failed'
        ? '검사 규칙을 불러오지 못했습니다. 확장 프로그램을 새로고침해 주세요.'
        : '문서 텍스트를 가져오지 못했습니다. 보기 권한·로그인 상태를 확인하세요.';
      body.appendChild(msg);
    } else if (status !== 'ready' || !lastReport) {
      const msg = el('div', 'trd-msg');
      msg.textContent = '검사 중…';
      body.appendChild(msg);
    } else if (lastReport.total === 0) {
      const msg = el('div', 'trd-msg');
      msg.textContent = '발견된 오탈자가 없습니다.';
      body.appendChild(msg);
    } else if (listMode === 'order') {
      const ordered = lastReport.findings.slice().sort((a, b) => {
        return (a.start - b.start) || (a.idx - b.idx);
      });
      appendOrderedFindings(body, ordered);
    } else {
      const byCat = new Map();
      for (const f of lastReport.findings) {
        if (!byCat.has(f.cat)) byCat.set(f.cat, []);
        byCat.get(f.cat).push(f);
      }
      for (const id of categoryIdsInOrder()) {
        const items = byCat.get(id);
        if (!items || items.length === 0) continue;
        const det = el('details', 'trd-cat');
        det.open = isCategoryOpen(id);
        const sum = document.createElement('summary');
        sum.textContent = labelOf(id) + ' (' + items.length + ')';
        det.appendChild(sum);
        det.addEventListener('toggle', () => {
          categoryOpenState[categoryOpenKey(id)] = det.open;
        });
        for (const f of items) det.appendChild(buildItem(f));
        body.appendChild(det);
      }
    }
    panel.appendChild(body);

    // 푸터 (우측에 설정/추가기능 버튼)
    const foot = el('div', 'trd-foot');
    const footText = el('div', 'trd-foot-text');
    const ver = (lastReport && lastReport.rulesVersion) || (rulesJson && rulesJson.version) || '-';
    const when = lastReport && lastReport.scannedAt ? timeStr(lastReport.scannedAt) : '-';
    const l2 = document.createElement('div');
    const ruleSource = termsViewOpen ? 'AI 용어 표' : (suggestionsViewOpen ? '문장제안.json' : (activeRulesSource === 'builtin' ? 'rules.json' : 'JSON ' + (rulesSourceLabel || 'uploaded.json')));
    l2.textContent = ruleSource + ' · 버전 ' + ver + ' · 마지막 검사 ' + when;
    const addonStatusText = addonStatusLineText();
    if (addonStatusText) {
      const statusLine = document.createElement('div');
      statusLine.className = 'trd-addon-status' + (addonStatus && addonStatus.state ? ' trd-addon-status-' + addonStatus.state : '');
      statusLine.textContent = addonStatusText;
      footText.appendChild(statusLine);
    }
    footText.appendChild(l2);
    foot.append(buildBridgeStatusBadge(), footText, buildFooterActions());
    panel.appendChild(foot);

    const toast = el('div', 'trd-toast');
    toast.id = 'trd-toast';
    panel.appendChild(toast);
    return panel;
  }

  function categoryOpenKey(id) {
    return [getDocId() || '', activeRulesSource || '', String(id || '')].join('\u0001');
  }

  function isCategoryOpen(id) {
    const key = categoryOpenKey(id);
    return categoryOpenState[key] !== false;
  }

  function appendSentenceSuggestionsView(body) {
    const rules = sentenceSuggestionRules();
    if (rules.length === 0) {
      const msg = el('div', 'trd-msg');
      msg.textContent = '문장 제안이 없습니다.';
      body.appendChild(msg);
      return;
    }
    for (let i = 0; i < rules.length; i++) {
      body.appendChild(buildSentenceSuggestionItem(rules[i], i));
    }
  }

  function appendTermsView(body) {
    const docId = getDocId();
    const report = termReportDocId === docId ? termReport : null;
    const wrap = el('div', 'trd-terms-view');
    const head = el('div', 'trd-terms-head');
    const title = el('div', 'trd-terms-title');
    title.textContent = 'AI 용어 표';
    const refreshBtn = el('button', 'trd-btn trd-terms-refresh');
    refreshBtn.type = 'button';
    refreshBtn.textContent = '재분석';
    refreshBtn.disabled = isAddonBusy('ai-terms');
    refreshBtn.addEventListener('click', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      handleAiTermsAddon({ force: true });
    });
    head.append(title, refreshBtn);
    wrap.appendChild(head);

    if (isAddonBusy('ai-terms') && !report) {
      const msg = el('div', 'trd-msg');
      msg.textContent = '용어 분석 중…';
      wrap.appendChild(msg);
      body.appendChild(wrap);
      return;
    }
    if (!report) {
      const msg = el('div', 'trd-msg');
      msg.textContent = '아직 용어 분석 결과가 없습니다.';
      wrap.appendChild(msg);
      body.appendChild(wrap);
      return;
    }

    const terms = Array.isArray(report.terms) ? report.terms : [];
    if (terms.length === 0) {
      const msg = el('div', 'trd-msg');
      msg.textContent = '혼용된 용어를 찾지 못했습니다.';
      wrap.appendChild(msg);
    } else {
      const tableWrap = el('div', 'trd-terms-table-wrap');
      const table = document.createElement('table');
      table.className = 'trd-terms-table';
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const label of ['혼용', '권장', '근거']) {
        const th = document.createElement('th');
        th.textContent = label;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      for (const term of terms) tbody.appendChild(buildTermRow(term));
      table.appendChild(tbody);
      tableWrap.appendChild(table);
      wrap.appendChild(tableWrap);
    }

    body.appendChild(wrap);
  }

  function buildTermRow(term) {
    const tr = document.createElement('tr');
    const variants = document.createElement('td');
    variants.appendChild(buildVariantList(term && term.variants));
    const recommended = document.createElement('td');
    recommended.textContent = displayText(term && term.recommended || '');
    const evidence = document.createElement('td');
    const reason = String(term && term.reason || '').trim();
    const snippets = Array.isArray(term && term.evidence) ? term.evidence.filter(Boolean) : [];
    evidence.textContent = displayText(reason || snippets[0] || '');
    tr.append(variants, recommended, evidence);
    return tr;
  }

  function buildVariantList(variants) {
    const list = el('div', 'trd-terms-variants');
    for (const variant of Array.isArray(variants) ? variants : []) {
      const item = el('div', 'trd-terms-variant');
      const text = String(variant && variant.text || '');
      const count = Number(variant && variant.count) || 0;
      item.textContent = displayText(text) + (count > 0 ? ' (' + count + ')' : '');
      list.appendChild(item);
    }
    return list;
  }

  function sentenceSuggestionRules() {
    const file = sentenceSuggestionRulesFile();
    const json = file && file.json;
    if (!json || !Array.isArray(json.categories)) return [];
    const out = [];
    for (const cat of json.categories) {
      if (!cat || cat.id !== SENTENCE_SUGGESTION_CATEGORY_ID || !Array.isArray(cat.rules)) continue;
      for (let j = 0; j < cat.rules.length; j++) {
        const rule = cat.rules[j];
        if (!Array.isArray(rule) || typeof rule[0] !== 'string' || typeof rule[1] !== 'string') continue;
        out.push({
          src: rule[0],
          dst: rule[1],
          options: rule[2] || null,
          categoryId: cat.id,
          ruleIndex: j,
          fileName: file.fileName
        });
      }
    }
    return out;
  }

  function sentenceSuggestionRulesFile() {
    const docId = getDocId();
    if (!docId) return null;
    return findGeneratedRulesFile(generatedRulesSourceValue(sentenceSuggestionFileNameForDoc(docId)));
  }

  function buildSentenceSuggestionItem(rule, index) {
    const item = el('div', 'trd-item trd-suggestion-item');
    const ctx = el('div', 'trd-ctx');
    ctx.textContent = displayText(rule.src);
    const fix = el('div', 'trd-fix');
    fix.textContent = displayText(rule.dst);
    const ln = el('span', 'trd-line');
    ln.textContent = '문장 제안 · ' + sentenceSuggestionStatus(rule);
    fix.appendChild(ln);
    item.append(ctx, fix);
    item.addEventListener('click', () => {
      handleSentenceSuggestionClick(rule);
    });
    const deleteBtn = el('button', 'trd-suggestion-delete-btn');
    deleteBtn.type = 'button';
    deleteBtn.appendChild(trashIcon());
    deleteBtn.title = '문장 제안 삭제';
    deleteBtn.setAttribute('aria-label', '문장 제안 삭제');
    deleteBtn.disabled = isAddonBusy('delete-sentence-suggestion');
    deleteBtn.addEventListener('click', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      handleDeleteSentenceSuggestion(rule);
    });
    item.appendChild(deleteBtn);
    return item;
  }

  function sentenceSuggestionStatus(rule) {
    const location = locateSentenceSuggestionInCachedText(rule);
    if (location) return location.kind === 'replacement' ? '반영됨' : '원문 찾음';
    if (typeof cachedText !== 'string') return '상태 확인 전';
    return '원문 없음';
  }

  async function handleSentenceSuggestionClick(rule) {
    const suggestion = String(rule && rule.dst || '');
    if (!suggestion) {
      showToast('복사할 문장 제안이 없습니다');
      return;
    }
    let location = locateSentenceSuggestionInCachedText(rule);
    if (!location || cachedTextSource !== 'model') {
      await refreshCachedModelTextForSuggestion();
      location = locateSentenceSuggestionInCachedText(rule);
    }
    if (!location || cachedTextSource !== 'model') {
      copySentenceSuggestionText(suggestion, '위치 못 찾음 · ');
      return;
    }
    selectDocsModelRange(location.start, location.end).then(res => {
      updateCursorOffset(res && res.selection ? res.selection : [{ start: location.start, end: location.end }]);
      copySentenceSuggestionText(suggestion, (location.kind === 'replacement' ? '반영 위치 선택 · ' : '원문 위치 선택 · '));
    }, () => {
      copySentenceSuggestionText(suggestion, '위치 선택 실패 · ');
    });
  }

  async function handleDeleteSentenceSuggestion(rule) {
    const actionId = 'delete-sentence-suggestion';
    if (isAddonBusy(actionId)) return;
    const docId = getDocId();
    if (!docId) {
      showToast('문서 ID를 찾지 못했습니다');
      return;
    }
    setAddonBusy(actionId, true);
    render({ preserveBodyScroll: true });
    let toastText = '';
    let toastOptions = null;
    try {
      const res = await sendAiBridge('deleteSentenceSuggestion', {
        document: {
          id: docId,
          title: documentTitleForAddon(),
          url: location.href
        },
        rule: {
          categoryId: rule.categoryId || SENTENCE_SUGGESTION_CATEGORY_ID,
          ruleIndex: Number.isInteger(Number(rule.ruleIndex)) ? Number(rule.ruleIndex) : undefined,
          sourceText: String(rule.src || ''),
          replacementText: String(rule.dst || ''),
          options: rule.options || undefined
        }
      });
      if (!res || !res.ok || !res.deleted || !res.json) {
        throw aiBridgeError(res, '문장 제안 삭제 실패');
      }
      upsertGeneratedRulesFile({
        fileName: res.fileName || rule.fileName || sentenceSuggestionFileNameForDoc(docId),
        displayName: res.displayName || '문장제안.json',
        outputPath: res.outputPath || '',
        mtimeMs: Date.now(),
        json: res.json
      });
      toastText = '문장 제안을 삭제했습니다';
    } catch (error) {
      console.error('[Toytype addons] sentence suggestion delete failed', error);
      toastText = error && error.userMessage ? error.userMessage : '문장 제안 삭제 실패';
      toastOptions = { durationMs: 3600 };
      refreshGeneratedRulesListQuiet();
    } finally {
      setAddonBusy(actionId, false);
      if (expanded) render({ preserveBodyScroll: true });
      if (toastText) showToast(toastText, toastOptions || undefined);
    }
  }

  async function refreshCachedModelTextForSuggestion() {
    const docId = getDocId();
    if (!docId) return false;
    try {
      const doc = await fetchModelText(docId);
      cachedText = doc.text;
      cachedTextSource = 'model';
      lastModelAt = Date.now();
      updateCursorOffset(doc.selection || null);
      return true;
    } catch (error) {
      return false;
    }
  }

  function locateSentenceSuggestionInCachedText(rule) {
    if (typeof cachedText !== 'string') return null;
    const source = String(rule && rule.src || '');
    const replacement = String(rule && rule.dst || '');
    return findTextRangeInCachedText(source, 'source') || findTextRangeInCachedText(replacement, 'replacement');
  }

  function findTextRangeInCachedText(needle, kind) {
    if (typeof cachedText !== 'string' || !needle || !String(needle).trim()) return null;
    const exact = findExactTextRanges(cachedText, String(needle));
    if (exact.length) return chooseNearestTextRange(exact, kind);
    const normalized = normalizeSearchText(needle);
    if (!normalized) return null;
    const tokens = normalized.split(' ').filter(Boolean);
    if (tokens.length < 2) return null;
    const pattern = tokens.map(escapeRegExp).join('\\s+');
    const match = new RegExp(pattern).exec(cachedText);
    if (!match) return null;
    return { kind, start: match.index, end: match.index + match[0].length, text: match[0] };
  }

  function findExactTextRanges(text, needle) {
    const ranges = [];
    let index = 0;
    while ((index = text.indexOf(needle, index)) !== -1) {
      ranges.push({ start: index, end: index + needle.length, text: needle });
      index += Math.max(1, needle.length);
    }
    return ranges;
  }

  function chooseNearestTextRange(ranges, kind) {
    let best = ranges[0];
    if (Number.isFinite(currentCursorOffset)) {
      let bestScore = Infinity;
      for (const range of ranges) {
        const score = range.start <= currentCursorOffset && currentCursorOffset <= range.end
          ? 0
          : Math.min(Math.abs(currentCursorOffset - range.start), Math.abs(currentCursorOffset - range.end));
        if (score < bestScore) {
          best = range;
          bestScore = score;
        }
      }
    }
    return { kind, start: best.start, end: best.end, text: best.text };
  }

  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function copySentenceSuggestionText(text, prefix) {
    const suggestion = String(text || '');
    if (!suggestion) {
      showToast('복사할 문장 제안이 없습니다');
      return;
    }
    copyText(suggestion).then(
      () => showToast((prefix || '') + '문장 제안 복사됨: ' + displayText(suggestion)),
      () => showToast('문장 제안 복사 실패')
    );
  }

  function appendOrderedFindings(body, findings) {
    let markerAdded = false;
    for (const f of findings) {
      if (!markerAdded && shouldShowCursorMarker() && currentCursorOffset <= f.start) {
        body.appendChild(buildCursorMarker());
        markerAdded = true;
      }
      body.appendChild(buildItem(f));
    }
    if (!markerAdded && shouldShowCursorMarker()) {
      body.appendChild(buildCursorMarker());
    }
  }

  function shouldShowCursorMarker() {
    return listMode === 'order' && Number.isFinite(currentCursorOffset);
  }

  function buildCursorMarker() {
    const marker = el('div', 'trd-cursor-marker');
    marker.setAttribute('aria-hidden', 'true');
    return marker;
  }

  function buildListModeToggle() {
    const wrap = el('div', 'trd-view-toggle');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', '보기 방식');
    wrap.append(
      buildListModeButton('category', '종류별 보기'),
      buildListModeButton('order', '문서 순서 보기')
    );
    return wrap;
  }

  function buildListModeButton(mode, label) {
    const btn = el('button', 'trd-view-btn' + (listMode === mode ? ' trd-active' : ''));
    btn.type = 'button';
    btn.appendChild(viewModeIcon(mode));
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', listMode === mode ? 'true' : 'false');
    btn.addEventListener('click', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      if (listMode === mode) return;
      listMode = mode;
      suggestionsViewOpen = false;
      render();
    });
    return btn;
  }

  function buildRulesSourceSelect() {
    const select = el('select', 'trd-select');
    select.title = '검사 규칙 선택';
    select.value = activeRulesSource;
    const builtinOption = document.createElement('option');
    builtinOption.value = 'builtin';
    builtinOption.textContent = 'rules' + rulesVersionSuffix(builtinRulesJson);
    select.appendChild(builtinOption);
    for (const file of generatedRulesFilesForSelect()) {
      const generatedOption = document.createElement('option');
      generatedOption.value = generatedRulesSourceValue(file.fileName);
      generatedOption.textContent = file.displayName || file.fileName;
      generatedOption.title = file.outputPath || file.fileName;
      select.appendChild(generatedOption);
    }
    if (uploadedRulesJson) {
      const uploadedOption = document.createElement('option');
      uploadedOption.value = 'uploaded';
      uploadedOption.textContent = 'JSON' + rulesVersionSuffix(uploadedRulesJson);
      uploadedOption.title = uploadedRulesLabel || 'uploaded.json';
      select.appendChild(uploadedOption);
    }
    select.value = canUseRulesSource(activeRulesSource) && !isSentenceSuggestionSource(activeRulesSource) ? activeRulesSource : 'builtin';
    const holdNativeSelect = ev => {
      noteNativeControlInteraction(1800);
      ev.stopPropagation();
    };
    ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchend', 'keydown', 'keyup'].forEach(type => {
      select.addEventListener(type, holdNativeSelect);
    });
    select.addEventListener('focus', () => {
      noteNativeControlInteraction(4000);
    });
    select.addEventListener('blur', () => {
      noteNativeControlInteraction(120);
      setTimeout(flushDeferredRender, 140);
    });
    select.addEventListener('change', ev => {
      noteNativeControlInteraction(250);
      ev.stopPropagation();
      handleRulesSourceChange(select.value);
      setTimeout(flushDeferredRender, 280);
    });
    return select;
  }

  function rulesVersionSuffix(json) {
    return json && json.version ? ' ' + json.version : '';
  }

  function handleRulesSourceChange(source) {
    if (source === activeRulesSource) return;
    try {
      useRulesSource(source);
    } catch (e) {
      showToast('규칙 선택 실패');
      render();
      return;
    }
    suggestionsViewOpen = false;
    termsViewOpen = false;
    showToast(activeRulesSource === 'builtin' ? 'rules.json 기준으로 검사' : 'JSON 기준으로 검사');
    enqueueScan(cachedText === null);
  }

  function syncCursorWatcher() {
    const shouldPoll = expanded && status === 'ready' && lastReport &&
      lastReport.textSource === 'model' && listMode === 'order';
    if (shouldPoll && !cursorPollTimer) {
      cursorPollTimer = setInterval(() => { pollCursorSelection(); }, CURSOR_POLL_INTERVAL);
      pollCursorSelection();
      return;
    }
    if (!shouldPoll) stopCursorWatcher();
  }

  function stopCursorWatcher() {
    if (!cursorPollTimer) return;
    clearInterval(cursorPollTimer);
    cursorPollTimer = null;
    cursorPollBusy = false;
  }

  function pollCursorSelection() {
    // 적용 진행 중에는 모델 호출 경합을 피하려고 커서 폴링을 쉰다.
    if (cursorPollBusy || applyingFindingKey !== null || addonBusyActions.size > 0 || isNativeControlInteractionActive()) return;
    cursorPollBusy = true;
    fetchDocsSelection().then(selection => {
      if (updateCursorOffset(selection) && expanded && listMode === 'order') render();
    }).catch(() => {
      if (currentCursorOffset !== null) {
        currentCursorOffset = null;
        if (expanded && listMode === 'order') render();
      }
    }).finally(() => {
      cursorPollBusy = false;
    });
  }

  function updateCursorOffset(selection) {
    const next = selectionOffset(selection);
    if (next === currentCursorOffset) return false;
    currentCursorOffset = next;
    return true;
  }

  function selectionOffset(selection) {
    if (!Array.isArray(selection) || selection.length === 0) return null;
    const first = selection[0];
    if (!first || typeof first.start !== 'number' || typeof first.end !== 'number') return null;
    return Math.min(first.start, first.end);
  }

  function selectionRange(selection) {
    if (!Array.isArray(selection) || selection.length === 0) return null;
    const first = selection[0];
    if (!first || typeof first.start !== 'number' || typeof first.end !== 'number') return null;
    return {
      start: Math.min(first.start, first.end),
      end: Math.max(first.start, first.end)
    };
  }

  function filterIgnoredFindings(findings) {
    if (!ignoredFindingKeys || ignoredFindingKeys.size === 0) return findings;
    return findings.filter(f => !ignoredFindingKeys.has(findingIgnoreKey(f)));
  }

  function findingIgnoreKey(f) {
    return JSON.stringify([
      activeRulesSource || 'builtin',
      f && f.cat || '',
      f && f.src || '',
      f && f.dst || '',
      contextTail(f && f.contextBefore, 48),
      contextHead(f && f.contextAfter, 48)
    ]);
  }

  function contextTail(text, len) {
    const value = normalizeIgnoreContext(text);
    return value.slice(Math.max(0, value.length - len));
  }

  function contextHead(text, len) {
    return normalizeIgnoreContext(text).slice(0, len);
  }

  function normalizeIgnoreContext(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function loadIgnoredFindingsForCurrentDoc() {
    const docId = getDocId();
    ignoredFindingDocId = docId || null;
    ignoredFindingKeys = new Set();
    if (!docId) return Promise.resolve(false);
    return new Promise(resolve => {
      try {
        chrome.storage.local.get(IGNORED_FINDINGS_CACHE_KEY, items => {
          if (chrome.runtime.lastError) {
            resolve(false);
            return;
          }
          const cache = items && items[IGNORED_FINDINGS_CACHE_KEY] && typeof items[IGNORED_FINDINGS_CACHE_KEY] === 'object'
            ? items[IGNORED_FINDINGS_CACHE_KEY]
            : {};
          const docCache = cache[docId] && typeof cache[docId] === 'object' ? cache[docId] : null;
          const keys = Array.isArray(docCache && docCache.keys) ? docCache.keys : [];
          ignoredFindingKeys = new Set(keys.filter(key => typeof key === 'string' && key));
          resolve(true);
        });
      } catch (_) {
        resolve(false);
      }
    });
  }

  function saveIgnoredFindingsForCurrentDoc() {
    const docId = getDocId();
    if (!docId) return Promise.resolve(false);
    const keys = Array.from(ignoredFindingKeys || []).filter(Boolean).slice(-IGNORED_FINDINGS_PER_DOC_LIMIT);
    return new Promise(resolve => {
      try {
        chrome.storage.local.get(IGNORED_FINDINGS_CACHE_KEY, items => {
          if (chrome.runtime.lastError) {
            resolve(false);
            return;
          }
          const cache = items && items[IGNORED_FINDINGS_CACHE_KEY] && typeof items[IGNORED_FINDINGS_CACHE_KEY] === 'object'
            ? Object.assign({}, items[IGNORED_FINDINGS_CACHE_KEY])
            : {};
          cache[docId] = {
            savedAt: Date.now(),
            title: documentTitleForAddon(),
            url: location.href,
            keys
          };
          const docIds = Object.keys(cache).sort((a, b) => {
            const am = cache[a] && Number(cache[a].savedAt) || 0;
            const bm = cache[b] && Number(cache[b].savedAt) || 0;
            return bm - am;
          });
          for (const oldDocId of docIds.slice(IGNORED_FINDINGS_DOC_LIMIT)) delete cache[oldDocId];
          chrome.storage.local.set({ [IGNORED_FINDINGS_CACHE_KEY]: cache }, () => {
            resolve(!chrome.runtime.lastError);
          });
        });
      } catch (_) {
        resolve(false);
      }
    });
  }

  function handleIgnoreFindingClick(f) {
    const docId = getDocId();
    if (!docId) {
      showToast('문서 ID를 찾지 못했습니다');
      return;
    }
    if (ignoredFindingDocId !== docId) {
      ignoredFindingDocId = docId;
      ignoredFindingKeys = new Set();
    }
    ignoredFindingKeys.add(findingIgnoreKey(f));
    if (selectedFindingKey === findingKey(f)) selectedFindingKey = null;
    removeFindingFromReport(f);
    render({ preserveBodyScroll: true });
    saveIgnoredFindingsForCurrentDoc().then(ok => {
      showToast(ok ? '현재 문서에서 숨김' : '숨김 저장 실패', { durationMs: ok ? 1500 : 3200 });
    });
  }

  function removeFindingFromReport(finding) {
    if (!lastReport || !Array.isArray(lastReport.findings)) return false;
    const index = lastReport.findings.indexOf(finding);
    if (index === -1) return false;
    lastReport.findings.splice(index, 1);
    lastReport.total = lastReport.findings.length;
    lastReport.categoryCounts = {};
    for (const item of lastReport.findings) {
      lastReport.categoryCounts[item.cat] = (lastReport.categoryCounts[item.cat] || 0) + 1;
    }
    sendCount(lastReport.total);
    return true;
  }

  function buildItem(f) {
    const isSuggestion = isSentenceSuggestionFinding(f);
    const item = el('div', 'trd-item' + (isSuggestion ? ' trd-suggestion-item trd-copy-only' : ''));
    if (isSelectedFinding(f)) item.classList.add('trd-selected');
    const key = findingKey(f);
    if (applyingFindingKey === key) item.classList.add('trd-applying');

    const ctx = el('div', 'trd-ctx');
    if (f.before) ctx.appendChild(document.createTextNode('…' + f.before));
    const hit = el('b', 'trd-hit trd-' + (CAT_COLOR[f.cat] || 'red'));
    hit.textContent = displayText(f.src);
    ctx.appendChild(hit);
    if (f.after) ctx.appendChild(document.createTextNode(f.after + '…'));

    const fix = el('div', 'trd-fix');
    fix.textContent = '➝ ' + displayText(f.dst);
    const ln = el('span', 'trd-line');
    ln.textContent = '¶' + f.line + (listMode === 'order' ? ' · ' + labelOf(f.cat) : '');
    fix.appendChild(ln);

    item.append(ctx, fix);
    const explanation = isTechnicalAccuracyFinding(f) ? findingExplanationText(f) : '';
    if (explanation) {
      const explain = el('div', 'trd-explain');
      explain.textContent = '해설: ' + explanation;
      item.appendChild(explain);
    }
    if (!isSuggestion) {
      const ignoreBtn = el('button', 'trd-ignore-btn');
      ignoreBtn.type = 'button';
      ignoreBtn.appendChild(ignoreIcon());
      ignoreBtn.title = '현재 문서에서 숨김';
      ignoreBtn.setAttribute('aria-label', '현재 문서에서 숨김');
      ignoreBtn.disabled = applyingFindingKey !== null;
      ignoreBtn.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        handleIgnoreFindingClick(f);
      });
      const applyBtn = el('button', 'trd-apply-btn');
      applyBtn.type = 'button';
      applyBtn.appendChild(applyIcon());
      applyBtn.title = '적용';
      applyBtn.setAttribute('aria-label', '적용');
      applyBtn.disabled = !f.selectable || !Number.isFinite(f.start) || !Number.isFinite(f.end) || applyingFindingKey !== null;
      applyBtn.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        handleApplyFindingClick(f);
      });
      item.appendChild(ignoreBtn);
      item.appendChild(applyBtn);
    }
    item.addEventListener('click', () => {
      if (isSuggestion) handleSentenceSuggestionClick(f);
      else handleFindingClick(f);
    });
    return item;
  }

  function isTechnicalAccuracyFinding(f) {
    const cat = String(f && f.cat || '').toLowerCase();
    const label = String(f && (f.catLabel || labelOf(f.cat)) || '');
    return cat === 'book-editing-technical' || label === '기술 및 내용 정확성';
  }

  function findingExplanationText(f) {
    const note = findFindingNote(f);
    if (!note) return '';
    const text = noteText(note);
    return text ? text.slice(0, 320) : '';
  }

  function findFindingNote(f) {
    if (!rulesJson || !Array.isArray(rulesJson.notes)) return null;
    let best = null;
    let bestScore = 0;
    for (const note of rulesJson.notes) {
      if (!note || typeof note !== 'object') continue;
      const score = findingNoteMatchScore(f, note);
      if (score > bestScore) {
        best = note;
        bestScore = score;
      }
    }
    return bestScore >= 80 ? best : null;
  }

  function findingNoteMatchScore(f, note) {
    let score = 0;
    const cat = String(f && f.cat || '');
    const label = String(f && (f.catLabel || labelOf(f.cat)) || '');
    const noteCategory = String(note.category || note.categoryId || '');
    if (!noteCategory) score += 10;
    else if (noteCategory === cat || noteCategory === label) score += 40;
    else return 0;

    const source = String(note.source || note.sourceText || '');
    const replacement = String(note.replacement || note.replacementText || note.suggestedReplacement || '');
    const src = String(f && f.src || '');
    const dst = String(f && f.dst || '');
    if (source && src) {
      if (source === src) score += 70;
      else if (source.includes(src) || src.includes(source)) score += 45;
      else return 0;
    }
    if (replacement && dst) {
      if (replacement === dst) score += 50;
      else if (replacement.includes(dst) || dst.includes(replacement)) score += 25;
    }
    return score;
  }

  function noteText(note) {
    for (const key of ['reason', 'finding', 'explanation', 'detail', 'message']) {
      if (typeof note[key] === 'string' && note[key].trim()) return note[key].trim();
    }
    if (Array.isArray(note.sources)) {
      const source = note.sources.find(item => item && typeof item.evidence === 'string' && item.evidence.trim());
      if (source) return source.evidence.trim();
    }
    return '';
  }

  function handleFindingClick(f) {
    if (!f.selectable || !Number.isFinite(f.start) || !Number.isFinite(f.end)) {
      fallbackFindingClick(f);
      return;
    }
    const preservePanelScroll = listMode === 'category';
    enqueueScan(true, { quiet: true, preserveBodyScroll: preservePanelScroll }).then(report => {
      const fresh = report && report.ok && Array.isArray(report.findings)
        ? findFreshFinding(f, report.findings)
        : null;
      if (!fresh || !fresh.selectable || !Number.isFinite(fresh.start) || !Number.isFinite(fresh.end)) {
        fallbackFindingClick(f);
        return;
      }
      selectedFindingKey = findingKey(fresh);
      render({ preserveBodyScroll: preservePanelScroll });
      selectAndCopyFinding(fresh);
    }).catch(() => {
      fallbackFindingClick(f);
    });
  }

  function handleApplyFindingClick(f) {
    if (applyingFindingKey !== null) return;
    if (!f.selectable || !Number.isFinite(f.start) || !Number.isFinite(f.end)) {
      fallbackFindingClick(f);
      return;
    }
    const originalKey = findingKey(f);
    const keepSuggestionVisible = isSentenceSuggestionRulesActive();
    const applyStartedAt = Date.now();
    let preScanDoneAt = null;
    let appliedFresh = null;
    let completionToast = '';
    applyingFindingKey = originalKey;
    selectedFindingKey = originalKey;
    render();
    showToast('적용 중…');
    enqueueScan(true, { quiet: true }).then(report => {
      preScanDoneAt = Date.now();
      const fresh = report && report.ok && Array.isArray(report.findings)
        ? findFreshFinding(f, report.findings)
        : null;
      if (!fresh || !fresh.selectable || !Number.isFinite(fresh.start) || !Number.isFinite(fresh.end)) {
        const error = new Error('fresh finding unavailable for apply');
        error.debug = {
          target: summarizeFindingForConsole(f, -1),
          report: report ? {
            ok: !!report.ok,
            textSource: report.textSource || '',
            total: report.total
          } : null
        };
        throw error;
      }
      const matchScore = findingMatchScore(f, fresh);
      if (matchScore < 600) {
        const error = new Error('fresh finding match is too weak for apply');
        error.debug = {
          score: matchScore,
          minScore: 600,
          target: summarizeFindingForConsole(f, -1),
          candidate: summarizeFindingForConsole(fresh, report.findings.indexOf(fresh))
        };
        throw error;
      }
      appliedFresh = fresh;
      const freshKey = findingKey(fresh);
      if (freshKey !== selectedFindingKey || freshKey !== applyingFindingKey) {
        selectedFindingKey = freshKey;
        applyingFindingKey = freshKey;
        render();
      }
      const index = report.findings.indexOf(fresh);
      return applyResolvedFindingFromContent({
        index,
        finding: fresh,
        selector: 'item-button'
      }, {
        confirmMutation: true,
        useInternalTextAction: true,
        useFindReplaceFallback: false,
        requirePrimeFindMatch: true,
        actionWaitMs: 3000,
        primeWaitMs: 5000,
        mutationWaitMs: 8000,
        // 내부 텍스트 액션이 없는 빌드에서 3초 폴링하지 않고 빠르게 beforeinput 폴백으로 넘어간다.
        directActionWaitMs: 250,
        // 디스패치+선택 검증까지만 기다리고 응답 — 텍스트 검증은 백그라운드로 계속된다.
        deferVerification: true,
        // 사전 재스캔이 방금 받아 온 모델 텍스트 — 브리지의 전체 텍스트 재취득 1회를 생략한다.
        knownBeforeText: report.textSource === 'model' && typeof cachedText === 'string' ? cachedText : undefined
      });
    }).then(result => {
      const applied = !!(result && (result.verified === true || result.verificationDeferred === true));
      completionToast = applied ? '적용됨' : '적용 확인 필요';
      if (applied && appliedFresh && !keepSuggestionVisible) removeAppliedFindingOptimistically(appliedFresh);
      const timings = {
        totalMs: Date.now() - applyStartedAt,
        preScanMs: preScanDoneAt === null ? null : preScanDoneAt - applyStartedAt,
        applyMs: preScanDoneAt === null ? null : Date.now() - preScanDoneAt
      };
      debugLog('[Toytype apply] item apply result', {
        finding: f,
        result,
        timings
      });
      debugLog('[Toytype apply timings]', JSON.stringify(Object.assign({}, timings, {
        bridge: result && result.phaseTimings ? result.phaseTimings : null,
        actionWait: result && result.actionResult && result.actionResult.waitResult ? result.actionResult.waitResult : null,
        verifyDeferred: !!(result && result.verificationDeferred),
        beforeTextSource: result && result.beforeTextSource ? result.beforeTextSource : null,
        actionId: result && result.actionResult && result.actionResult.actionId ? result.actionResult.actionId : null
      })));
      if (result) debugLog('[Toytype apply item json]', JSON.stringify({ finding: f, result, timings }));
    }).catch(error => {
      console.error('[Toytype apply] item apply failed', {
        finding: f,
        error: summarizeErrorForConsole(error),
        response: error && error.response !== undefined ? error.response : undefined
      });
      completionToast = '적용 실패 · 콘솔 확인';
    }).finally(() => {
      applyingFindingKey = null;
      if (expanded) render();
      if (completionToast) showToast(completionToast);
    });
  }

  // 지연 검증 결과 — 디스패치 후 백그라운드로 진행된 텍스트 검증의 도착점.
  // 통과 시 검증에 쓴 본문으로 재취득 없이 재스캔하고, 실패 시 알리고 실제 문서 기준으로 복구한다.
  function handleApplyVerifyResult(data) {
    const verified = !!(data && data.ok === true && data.verified === true);
    debugLog('[Toytype apply] deferred verification', {
      verified,
      requestId: data && data.requestId,
      requested: data && data.requested,
      verification: data && data.verification,
      waitResult: data && data.waitResult,
      error: data && data.ok === false
        ? { name: data.errorName, message: data.errorMessage, debug: data.debug }
        : undefined
    });
    if (verified) {
      if (typeof data.afterText === 'string') {
        enqueueScan(true, { quiet: true, providedText: data.afterText, providedTextAt: data.completedAt || Date.now() });
      } else {
        enqueueScan(true, { quiet: true });
      }
      return;
    }
    showToast('적용 확인 실패 · 콘솔 확인');
    enqueueScan(true, { quiet: true }); // 실제 문서 기준으로 패널 복구
  }

  // 검증된 적용 직후 패널을 즉시 갱신한다. 적용된 항목 제거 + 뒤쪽 항목 오프셋 보정(치환 길이차)만
  // 수행하고, 문서 기준의 정확한 상태는 백그라운드 재스캔이 곧 덮어쓴다.
  function removeAppliedFindingOptimistically(applied) {
    if (!lastReport || !Array.isArray(lastReport.findings)) return;
    const index = lastReport.findings.indexOf(applied);
    if (index === -1) return;
    const delta = applied.dst.length - applied.src.length;
    if (selectedFindingKey === findingKey(applied)) selectedFindingKey = null;
    lastReport.findings.splice(index, 1);
    for (const item of lastReport.findings) {
      if (item.start >= applied.end) {
        item.start += delta;
        item.end += delta;
      }
    }
    lastReport.total = lastReport.findings.length;
    if (lastReport.categoryCounts && Number.isFinite(lastReport.categoryCounts[applied.cat])) {
      lastReport.categoryCounts[applied.cat] = Math.max(0, lastReport.categoryCounts[applied.cat] - 1);
    }
    sendCount(lastReport.total);
  }

  function isSelectedFinding(f) {
    return selectedFindingKey !== null && findingKey(f) === selectedFindingKey;
  }

  function findingKey(f) {
    return JSON.stringify([
      activeRulesSource,
      f && f.cat,
      f && f.src,
      f && f.dst,
      f && f.start,
      f && f.end
    ]);
  }

  function selectAndCopyFinding(f) {
    selectDocsModelRange(f.start, f.end).then(() => {
      if (!settings.copyOnSelect) {
        showToast('문서 위치 선택됨');
        return;
      }
      copyText(f.dst).then(
        () => showToast('문서 위치 선택 · 교정어 복사됨: ' + displayText(f.dst)),
        () => showToast('문서 위치 선택됨')
      );
    }, () => {
      fallbackFindingClick(f);
    });
  }

  function findFreshFinding(target, findings) {
    const groups = [
      f => f.src === target.src && f.dst === target.dst && f.cat === target.cat,
      f => f.src === target.src && f.dst === target.dst,
      f => f.src === target.src && f.cat === target.cat,
      f => f.src === target.src
    ];
    for (const matches of groups) {
      const candidates = findings.filter(matches);
      if (candidates.length > 0) return bestFindingMatch(target, candidates);
    }
    return null;
  }

  function bestFindingMatch(target, candidates) {
    let best = null;
    let bestScore = -Infinity;
    for (const candidate of candidates) {
      const score = findingMatchScore(target, candidate);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  }

  function findingMatchScore(target, candidate) {
    let score = 0;
    if (candidate.src === target.src) score += 500;
    if (candidate.dst === target.dst) score += 160;
    if (candidate.cat === target.cat) score += 120;
    if (candidate.idx === target.idx) score += 30;
    if (candidate.before === target.before) score += 20;
    if (candidate.after === target.after) score += 20;

    const startDelta = Math.abs((candidate.start || 0) - (target.start || 0));
    score += Math.max(0, 120 - startDelta / 4);

    const textLineDelta = Math.abs((candidate.textLine || 0) - (target.textLine || 0));
    score += Math.max(0, 60 - textLineDelta * 8);

    score += suffixMatchLength(target.contextBefore || '', candidate.contextBefore || '') * 3;
    score += prefixMatchLength(target.contextAfter || '', candidate.contextAfter || '') * 3;
    return score;
  }

  function suffixMatchLength(a, b) {
    const max = Math.min(MATCH_CONTEXT, a.length, b.length);
    for (let len = max; len > 0; len--) {
      if (a.slice(a.length - len) === b.slice(b.length - len)) return len;
    }
    return 0;
  }

  function prefixMatchLength(a, b) {
    const max = Math.min(MATCH_CONTEXT, a.length, b.length);
    for (let len = max; len > 0; len--) {
      if (a.slice(0, len) === b.slice(0, len)) return len;
    }
    return 0;
  }

  async function handleAiProofreadAddon() {
    const actionId = 'ai-proofread';
    if (isAddonBusy(actionId)) return;
    setAddonBusy(actionId, true);
    let finalStatus = '';
    let errorToast = '';
    startAiProofreadStatus('본문 읽는 중');
    try {
      const doc = await readCurrentDocumentTextForAddon();
      updateAiProofreadStatus('사실 확인/AI 교정 중');
      const res = await sendAiBridge('proofread', {
        document: {
          id: doc.docId,
          title: doc.title,
          url: location.href,
          text: doc.text,
          textSource: doc.source
        }
      });
      if (!res || !res.ok || !res.json) {
        throw aiBridgeError(res, 'AI 교정 생성 실패');
      }
      updateAiProofreadStatus('JSON 저장/업로드 중');
      if (res.fileName) {
        upsertGeneratedRulesFile({
          fileName: res.fileName,
          displayName: res.displayName || '',
          outputPath: res.outputPath || '',
          mtimeMs: Date.now(),
          json: res.json
        });
        useRulesSource(generatedRulesSourceValue(res.fileName));
      } else {
        setUploadedRulesJson(res.json, 'ai-proofread.json');
      }
      refreshGeneratedRulesListQuiet();
      const n = countRulesInJson(res.json);
      enqueueScan(cachedText === null, { quiet: true }).then(report => {
        if (!report || report.ok !== true) {
          console.error('[Toytype addons] post-AI scan failed', report || { error: 'empty report' });
        }
      }).catch(error => {
        console.error('[Toytype addons] post-AI scan failed', error);
      });
      finalStatus = 'AI 교정 완료 · JSON 업로드됨' + (n ? ': ' + n + '건' : '');
      if (res.compactedRules || res.droppedRules) {
        finalStatus += ' · 축약 ' + (res.compactedRules || 0) + '건';
        if (res.droppedRules) finalStatus += ' · 제외 ' + res.droppedRules + '건';
      }
      if (res.displayName || res.fileName) {
        finalStatus += ' · ' + (res.displayName || res.fileName);
      }
      if (res.factCheck && res.factCheck.model) {
        finalStatus += ' · 사실확인 ' + res.factCheck.model;
      }
    } catch (error) {
      const summary = summarizeErrorForConsole(error);
      if (error && error.userMessage) summary.userMessage = error.userMessage;
      if (error && error.response !== undefined) summary.response = summarizeAiBridgeResponse(error.response);
      console.error('[Toytype addons] AI proofread failed', summary);
      debugLog('[Toytype addons] AI proofread failed detail', {
        response: error && error.response !== undefined ? error.response : null,
        stack: error && error.stack ? error.stack : ''
      });
      finalStatus = error && error.userMessage ? error.userMessage : 'AI 교정 생성 실패';
      errorToast = finalStatus;
    } finally {
      setAddonBusy(actionId, false);
      finishAiProofreadStatus(errorToast ? 'error' : 'success', finalStatus);
      if (errorToast) showToast(errorToast, { durationMs: 4200 });
    }
  }

  function activateGeneratedRulesResponse(res, fallbackFileName) {
    if (!res || !res.json) return 0;
    const fileName = res.fileName || fallbackFileName || 'ai-generated.json';
    const isSentenceSuggestionFile = isSentenceSuggestionFileName(fileName);
    if (res.fileName) {
      upsertGeneratedRulesFile({
        fileName: res.fileName,
        displayName: res.displayName || '',
        outputPath: res.outputPath || '',
        mtimeMs: Date.now(),
        json: res.json
      });
      if (isSentenceSuggestionFile) {
        if (isSentenceSuggestionSource(activeRulesSource)) useRulesSource('builtin');
        suggestionsViewOpen = true;
        termsViewOpen = false;
      } else {
        useRulesSource(generatedRulesSourceValue(res.fileName));
      }
    } else if (!isSentenceSuggestionFile) {
      setUploadedRulesJson(res.json, fileName);
    }
    refreshGeneratedRulesListQuiet();
    const n = countRulesInJson(res.json);
    enqueueScan(cachedText === null, { quiet: true }).then(report => {
      if (!report || report.ok !== true) {
        console.error('[Toytype addons] post-AI suggestion scan failed', report || { error: 'empty report' });
      }
    }).catch(error => {
      console.error('[Toytype addons] post-AI suggestion scan failed', error);
    });
    return n;
  }

  async function handleAiTermsAddon(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const openView = opts.openView !== false;
    const showCompletionToast = opts.toast !== false;
    const actionId = 'ai-terms';
    if (isAddonBusy(actionId)) return;
    setAddonBusy(actionId, true);
    if (openView) {
      termsViewOpen = true;
      suggestionsViewOpen = false;
    }
    let finalStatus = '';
    let errorToast = '';
    let successToast = '';
    startAiTermsStatus('본문 읽는 중');
    try {
      const doc = await readCurrentDocumentTextForAddon();
      if (!doc.text || !doc.text.trim()) {
        const error = new Error('document text is blank');
        error.userMessage = '용어를 분석할 본문을 읽지 못했습니다';
        throw error;
      }
      updateAiTermsStatus('AI 용어 분석 중');
      const res = await sendAiBridge('terms', {
        timeoutMs: AI_TERMS_TIMEOUT,
        force: opts.force === true,
        document: {
          id: doc.docId,
          title: doc.title,
          url: location.href,
          textSource: doc.source,
          text: doc.text
        }
      });
      if (!res || !res.ok || !res.report) {
        throw aiBridgeError(res, 'AI 용어 분석 실패');
      }
      termReport = normalizeTermReportForView(res.report, res);
      termReportDocId = doc.docId;
      const n = Array.isArray(termReport.terms) ? termReport.terms.length : 0;
      const doneLabel = res.fromCache ? '저장된 용어 표 불러옴' : 'AI 용어 분석 완료';
      finalStatus = n ? doneLabel + ' · ' + n + '건' : doneLabel + ' · 혼용 없음';
      if (res.model) finalStatus += ' · ' + res.model;
      if (res.displayName || res.fileName) finalStatus += ' · ' + (res.displayName || res.fileName);
      successToast = finalStatus;
    } catch (error) {
      const summary = summarizeErrorForConsole(error);
      if (error && error.userMessage) summary.userMessage = error.userMessage;
      if (error && error.response !== undefined) summary.response = summarizeAiBridgeResponse(error.response);
      console.error('[Toytype addons] AI terms failed', summary);
      debugLog('[Toytype addons] AI terms failed detail', {
        response: error && error.response !== undefined ? error.response : null,
        stack: error && error.stack ? error.stack : ''
      });
      finalStatus = error && error.userMessage ? error.userMessage : 'AI 용어 분석 실패';
      errorToast = finalStatus;
    } finally {
      setAddonBusy(actionId, false);
      finishAiTermsStatus(errorToast ? 'error' : 'success', finalStatus);
      if (showCompletionToast && errorToast) showToast(errorToast, { durationMs: 4200 });
      else if (showCompletionToast && successToast) showToast(successToast);
    }
  }

  function normalizeTermReportForView(report, res) {
    const source = report && typeof report === 'object' ? report : {};
    return {
      generatedAt: source.checkedAt || new Date().toISOString(),
      provider: source.provider || (res && res.provider) || '',
      model: source.model || (res && res.model) || '',
      terms: Array.isArray(source.terms) ? source.terms.map(normalizeTermItemForView).filter(Boolean) : [],
      notes: Array.isArray(source.notes) ? source.notes.filter(note => typeof note === 'string' && note.trim()).slice(0, 20) : []
    };
  }

  function normalizeTermItemForView(item) {
    if (!item || typeof item !== 'object') return null;
    const variants = Array.isArray(item.variants)
      ? item.variants.map(variant => ({
          text: String(variant && variant.text || '').trim(),
          count: Math.max(0, Math.round(Number(variant && variant.count) || 0))
        })).filter(variant => variant.text)
      : [];
    if (variants.length < 2) return null;
    return {
      concept: String(item.concept || '').trim(),
      recommended: String(item.recommended || '').trim(),
      variants,
      severity: item.severity === 'major' ? 'major' : 'minor',
      evidence: Array.isArray(item.evidence) ? item.evidence.filter(text => typeof text === 'string' && text.trim()).slice(0, 4) : [],
      reason: String(item.reason || '').trim()
    };
  }

  async function handleAiQuestionAddon() {
    const actionId = 'ai-question';
    if (isAddonBusy(actionId)) return;
    setAddonBusy(actionId, true);
    let finalStatus = '';
    let errorToast = '';
    let successToast = '';
    startAiQuestionStatus('본문/커서 읽는 중');
    try {
      const doc = await readCurrentDocumentTextForAddon();
      if (doc.source !== 'model') {
        const error = new Error('Google Docs model text is required for cursor insertion');
        error.userMessage = '문서 모델을 읽지 못해 삽입할 수 없습니다';
        throw error;
      }
      let selection = doc.selection || null;
      if (!selection) {
        try {
          selection = await fetchDocsSelection();
          updateCursorOffset(selection);
        } catch (_) {
          selection = null;
        }
      }
      const offset = selectionOffset(selection);
      if (!Number.isFinite(offset) || offset < 0 || offset > doc.text.length) {
        const error = new Error('current Google Docs cursor is unavailable');
        error.userMessage = '커서 위치를 읽지 못했습니다';
        throw error;
      }

      const context = buildAiQuestionContext(doc.text, offset);
      const anchor = buildInsertionSuggestionAnchor(doc.text, offset);
      const insertionProfile = classifyAiSentenceInsertion(doc.text, offset);
      updateAiQuestionStatus(insertionProfile.mode === 'question' ? 'AI 발문 생성 중' : 'AI 설명 문장 생성 중');
      const res = await sendAiBridge('question', {
        timeoutMs: AI_QUESTION_TIMEOUT,
        document: {
          id: doc.docId,
          title: doc.title,
          url: location.href,
          textSource: doc.source,
          cursorOffset: offset,
          totalChars: doc.text.length,
          contextBefore: context.before,
          contextAfter: context.after,
          insertionMode: insertionProfile.mode,
          insertionModeReason: insertionProfile.reason,
          insertionPreviousLine: insertionProfile.previousLine,
          insertionCurrentLinePrefix: insertionProfile.currentLinePrefix,
          insertionCurrentLineSuffix: insertionProfile.currentLineSuffix,
          insertionSource: anchor.source,
          insertionPrefixLength: anchor.prefixLength
        }
      });
      if (!res || !res.ok || !res.json) {
        throw aiBridgeError(res, 'AI 문장 생성 실패');
      }

      updateAiQuestionStatus('문장 제안 JSON 저장 중');
      const n = activateGeneratedRulesResponse(res, '문장제안.json');
      debugLog('[Toytype addons] AI sentence insertion suggestion result', {
        chars: typeof res.text === 'string' ? Array.from(res.text).length : null,
        provider: res.provider || '',
        model: res.model || ''
      });
      finalStatus = 'AI 문장 제안 저장 완료';
      if (n) finalStatus += ' · 누적 ' + n + '건';
      if (res.model) finalStatus += ' · ' + res.model;
      successToast = 'AI 문장 제안을 저장했습니다';
    } catch (error) {
      const summary = summarizeErrorForConsole(error);
      if (error && error.userMessage) summary.userMessage = error.userMessage;
      if (error && error.response !== undefined) summary.response = summarizeAiBridgeResponse(error.response);
      console.error('[Toytype addons] AI sentence insertion suggestion failed', summary);
      debugLog('[Toytype addons] AI sentence insertion suggestion failed detail', {
        response: error && error.response !== undefined ? error.response : null,
        stack: error && error.stack ? error.stack : ''
      });
      finalStatus = error && error.userMessage ? error.userMessage : 'AI 문장 제안 저장 실패';
      errorToast = finalStatus;
    } finally {
      setAddonBusy(actionId, false);
      finishAiQuestionStatus(errorToast ? 'error' : 'success', finalStatus);
      if (errorToast) showToast(errorToast, { durationMs: 4200 });
      else if (successToast) showToast(successToast);
    }
  }

  function buildAiQuestionContext(text, offset) {
    const source = String(text || '');
    const pos = Math.max(0, Math.min(source.length, Number(offset) || 0));
    return {
      before: source.slice(Math.max(0, pos - AI_QUESTION_CONTEXT_BEFORE), pos),
      after: source.slice(pos, pos + AI_QUESTION_CONTEXT_AFTER)
    };
  }

  function classifyAiSentenceInsertion(text, offset) {
    const source = String(text || '');
    const pos = Math.max(0, Math.min(source.length, Number(offset) || 0));
    const lineStart = pos > 0 ? source.lastIndexOf('\n', pos - 1) + 1 : 0;
    const lineEndIndex = source.indexOf('\n', pos);
    const lineEnd = lineEndIndex === -1 ? source.length : lineEndIndex;
    const currentLinePrefix = source.slice(lineStart, pos);
    const currentLineSuffix = source.slice(pos, lineEnd);
    const previous = previousNonEmptyLine(source, lineStart);
    const onlyWhitespaceSincePrevious = previous
      ? source.slice(previous.end, pos).trim() === ''
      : false;
    const atParagraphStart = currentLinePrefix.trim() === '';
    const titleLike = previous ? looksLikeTitleLine(previous.text) : false;
    if (previous && atParagraphStart && onlyWhitespaceSincePrevious && titleLike) {
      return {
        mode: 'question',
        reason: 'title-below',
        previousLine: previous.text,
        currentLinePrefix: currentLinePrefix,
        currentLineSuffix: currentLineSuffix
      };
    }
    return {
      mode: 'explanation',
      reason: previous ? 'body-context' : 'document-start',
      previousLine: previous ? previous.text : '',
      currentLinePrefix: currentLinePrefix,
      currentLineSuffix: currentLineSuffix
    };
  }

  function previousNonEmptyLine(text, lineStart) {
    let end = Math.max(0, Number(lineStart) || 0);
    while (end > 0) {
      const prevBreak = text.lastIndexOf('\n', end - 2);
      const start = prevBreak === -1 ? 0 : prevBreak + 1;
      const lineEnd = end > 0 && text.charCodeAt(end - 1) === 10 ? end - 1 : end;
      const raw = text.slice(start, lineEnd);
      const trimmed = raw.trim();
      if (trimmed) return { text: trimmed, start, end: lineEnd };
      if (prevBreak === -1) break;
      end = prevBreak + 1;
    }
    return null;
  }

  function looksLikeTitleLine(line) {
    const text = String(line || '').trim();
    if (!text) return false;
    const chars = Array.from(text).length;
    if (chars < 2 || chars > 80) return false;
    if (/^[\-*+•]\s+/.test(text)) return false;
    if (/[.?!。！？]$/.test(text) && !/^\d+(?:[.)]|장)\s+\S/.test(text)) return false;
    if (/[.!?。！？].+[.!?。！？]/.test(text)) return false;
    return true;
  }

  function buildInsertionSuggestionAnchor(text, offset) {
    const source = String(text || '');
    const pos = Math.max(0, Math.min(source.length, Number(offset) || 0));
    const right = buildOneSidedInsertionAnchor(source, pos, 'right');
    if (right) return right;
    const left = buildOneSidedInsertionAnchor(source, pos, 'left');
    if (left) return left;

    let best = null;
    for (const radius of [16, 24, 40, 72, 120]) {
      const beforeLen = Math.min(pos, Math.ceil(radius / 2));
      const afterLen = Math.min(source.length - pos, Math.floor(radius / 2));
      const start = pos - beforeLen;
      const end = pos + afterLen;
      const candidate = source.slice(start, end);
      if (!candidate.trim()) continue;
      const anchor = {
        source: candidate,
        prefixLength: beforeLen,
        start,
        end,
        occurrences: countTextOccurrences(source, candidate, 2)
      };
      best = anchor;
      if (anchor.occurrences === 1) return anchor;
    }
    if (best) return best;
    const error = new Error('insertion anchor unavailable');
    error.userMessage = '문장을 넣을 기준 문맥을 찾지 못했습니다';
    throw error;
  }

  function buildOneSidedInsertionAnchor(text, pos, side) {
    const lengths = [4, 6, 8, 12, 18, 28, 44, 72];
    for (const len of lengths) {
      const start = side === 'right' ? pos : Math.max(0, pos - len);
      const end = side === 'right' ? Math.min(text.length, pos + len) : pos;
      const candidate = text.slice(start, end);
      if (!candidate.trim()) continue;
      const anchor = {
        source: candidate,
        prefixLength: side === 'right' ? 0 : candidate.length,
        start,
        end,
        occurrences: countTextOccurrences(text, candidate, 2)
      };
      if (anchor.occurrences === 1) return anchor;
    }
    return null;
  }

  function countTextOccurrences(text, needle, stopAfter) {
    if (!needle) return 0;
    let count = 0;
    let index = 0;
    const limit = Number.isFinite(Number(stopAfter)) ? Number(stopAfter) : Infinity;
    while ((index = text.indexOf(needle, index)) !== -1) {
      count++;
      if (count >= limit) return count;
      index += Math.max(1, needle.length);
    }
    return count;
  }

  async function handleAiLengthAddon() {
    const actionId = 'ai-length';
    if (isAddonBusy(actionId)) return;
    setAddonBusy(actionId, true);
    let finalStatus = '';
    let errorToast = '';
    let successToast = '';
    startAiLengthStatus('선택 영역 읽는 중');
    try {
      const doc = await readCurrentDocumentTextForAddon();
      if (doc.source !== 'model') {
        const error = new Error('Google Docs model text is required for selected text suggestions');
        error.userMessage = '문서 선택 영역을 읽지 못했습니다';
        throw error;
      }
      let selection = doc.selection || null;
      if (!selection) {
        try {
          selection = await fetchDocsSelection();
          updateCursorOffset(selection);
        } catch (_) {
          selection = null;
        }
      }
      const range = selectionRange(selection);
      if (!range || range.end <= range.start) {
        const error = new Error('selected text is required');
        error.userMessage = '길이를 조절할 문장을 드래그해 선택하세요';
        throw error;
      }
      const selectedText = doc.text.slice(range.start, range.end);
      if (!selectedText.trim()) {
        const error = new Error('selected text is blank');
        error.userMessage = '공백이 아닌 문장을 선택하세요';
        throw error;
      }
      const selectedChars = Array.from(selectedText).length;
      const targetChars = promptAiLengthTargetChars(selectedChars);
      if (targetChars === null) {
        finalStatus = 'AI 문장 길이 조절 취소';
        return;
      }

      updateAiLengthStatus('AI 문장 제안 생성 중');
      const res = await sendAiBridge('adjustLength', {
        timeoutMs: AI_LENGTH_TIMEOUT,
        document: {
          id: doc.docId,
          title: doc.title,
          url: location.href,
          textSource: doc.source,
          selectionStart: range.start,
          selectionEnd: range.end,
          selectedText,
          selectedChars,
          targetChars,
          contextBefore: doc.text.slice(Math.max(0, range.start - AI_LENGTH_CONTEXT), range.start),
          contextAfter: doc.text.slice(range.end, range.end + AI_LENGTH_CONTEXT)
        }
      });
      if (!res || !res.ok || !res.json) {
        throw aiBridgeError(res, 'AI 문장 길이 조절 실패');
      }
      updateAiLengthStatus('문장 제안 JSON 저장 중');
      const n = activateGeneratedRulesResponse(res, '문장제안.json');
      finalStatus = 'AI 문장 제안 저장 완료 · 목표 ' + targetChars + '자';
      if (n) finalStatus += ' · 누적 ' + n + '건';
      if (res.model) finalStatus += ' · ' + res.model;
      successToast = 'AI 문장 제안을 저장했습니다';
    } catch (error) {
      const summary = summarizeErrorForConsole(error);
      if (error && error.userMessage) summary.userMessage = error.userMessage;
      if (error && error.response !== undefined) summary.response = summarizeAiBridgeResponse(error.response);
      console.error('[Toytype addons] AI length suggestion failed', summary);
      debugLog('[Toytype addons] AI length suggestion failed detail', {
        response: error && error.response !== undefined ? error.response : null,
        stack: error && error.stack ? error.stack : ''
      });
      finalStatus = error && error.userMessage ? error.userMessage : 'AI 문장 길이 조절 실패';
      errorToast = finalStatus;
    } finally {
      setAddonBusy(actionId, false);
      finishAiLengthStatus(errorToast ? 'error' : 'success', finalStatus);
      if (errorToast) showToast(errorToast, { durationMs: 4200 });
      else if (successToast) showToast(successToast);
    }
  }

  function promptAiLengthTargetChars(currentChars) {
    const current = Math.max(1, Math.round(Number(currentChars) || 0));
    let raw = null;
    try {
      raw = window.prompt('현재 선택 영역: ' + current + '자\n목표 글자수를 입력하세요', String(current));
    } catch (_) {
      raw = null;
    }
    if (raw === null) return null;
    const value = String(raw).replace(/,/g, '').replace(/글자|자/g, '').trim();
    if (!/^\d+$/.test(value)) {
      showToast('목표 글자수를 숫자로 입력하세요', { durationMs: 3200 });
      return null;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n < 1 || n > 20000) {
      showToast('1~20000 사이 목표 글자수를 입력하세요', { durationMs: 3200 });
      return null;
    }
    return Math.round(n);
  }

  async function handleExtractImagesAddon() {
    const actionId = 'extract-images';
    if (isAddonBusy(actionId)) return;
    const docId = getDocId();
    if (!docId) {
      showToast('문서 ID를 찾지 못했습니다', { durationMs: 3200 });
      return;
    }
    setAddonBusy(actionId, true);
    let finalStatus = '';
    let errorToast = '';
    let successToast = '';
    startImageExtractStatus('DOCX 다운로드 중');
    try {
      const docxBuffer = await fetchDocxExport(docId);
      updateImageExtractStatus('브릿지로 전송 중');
      const res = await sendAiBridge('extractImages', {
        timeoutMs: IMAGE_EXTRACT_TIMEOUT,
        document: {
          id: docId,
          title: documentTitleForAddon(),
          url: location.href,
          docxBase64: arrayBufferToBase64(docxBuffer),
          docxBytes: docxBuffer.byteLength
        }
      });
      if (!res || !res.ok) {
        throw aiBridgeError(res, '이미지 추출 실패');
      }
      const imageCount = Number(res.imageCount || 0);
      if (imageCount <= 0) {
        finalStatus = '이미지 없음';
        successToast = '문서에 추출할 이미지가 없습니다';
      } else {
        const skippedCount = Number(res.skippedImageCount || 0);
        const downloadState = res.chromeDownloadId ? 'Chrome 다운로드 시작' : (res.chromeDownloadError ? 'Chrome 다운로드 실패' : '다운로드 준비됨');
        finalStatus = '이미지 추출 완료 · ' + imageCount + '개 · ' + downloadState;
        if (skippedCount > 0) finalStatus += ' · 빈 이미지 제외 ' + skippedCount + '개';
        if (res.displayName || res.fileName) finalStatus += ' · ' + (res.displayName || res.fileName);
        successToast = res.chromeDownloadId
          ? '이미지 ZIP 다운로드 시작: ' + (res.displayName || res.fileName || imageCount + '개')
          : (res.chromeDownloadError
              ? '이미지 ZIP 생성됨 · Chrome 다운로드 실패'
              : '이미지 ZIP 다운로드 준비됨: ' + (res.displayName || res.fileName || imageCount + '개'));
      }
    } catch (error) {
      const summary = summarizeErrorForConsole(error);
      if (error && error.userMessage) summary.userMessage = error.userMessage;
      if (error && error.response !== undefined) summary.response = summarizeAiBridgeResponse(error.response);
      console.error('[Toytype addons] image extract failed', summary);
      finalStatus = error && error.userMessage ? error.userMessage : '이미지 추출 실패';
      errorToast = finalStatus;
    } finally {
      setAddonBusy(actionId, false);
      finishImageExtractStatus(errorToast ? 'error' : 'success', finalStatus);
      if (errorToast) showToast(errorToast, { durationMs: 4200 });
      else if (successToast) showToast(successToast, { durationMs: 2800 });
    }
  }

  function handleExtractTocAddon() {
    const actionId = 'extract-toc';
    if (isAddonBusy(actionId)) return;
    setAddonBusy(actionId, true);
    let finalToast = '';
    let finalToastDuration = 1800;
    render();
    showToast('목차 추출 중...');
    readCurrentDocumentTextForAddon().then(doc => extractTocFromDocument(doc).then(result => {
      const title = doc.title || doc.docId || 'Google Docs';
      const markdown = formatExtractedToc(title, result);
      if (result.headings.length === 0) {
        return copyText(markdown).then(
          () => { finalToast = '목차 없음 안내가 클립보드에 복사되었습니다'; },
          error => {
            console.error('[Toytype addons] TOC clipboard copy failed', error);
            finalToast = '목차 없음 · 클립보드 복사 실패 · 콘솔 확인';
            finalToastDuration = 3600;
          }
        );
      }
      return copyText(markdown).then(
        () => { finalToast = '목차가 클립보드에 복사되었습니다: ' + result.headings.length + '개'; },
        error => {
          console.error('[Toytype addons] TOC clipboard copy failed', error);
          finalToast = '목차 추출됨 · 클립보드 복사 실패 · 콘솔 확인';
          finalToastDuration = 3600;
        }
      );
    })).catch(error => {
      console.error('[Toytype addons] TOC extract failed', error);
      finalToast = '목차 추출 실패 · 콘솔 확인';
      finalToastDuration = 3600;
    }).finally(() => {
      setAddonBusy(actionId, false);
      if (expanded) render();
      if (finalToast) showToast(finalToast, { durationMs: finalToastDuration });
    });
  }

  function startAiProofreadStatus(phase) {
    addonStatus = {
      type: 'ai-proofread',
      label: 'AI 교정',
      state: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      phase: phase || '시작 중',
      message: ''
    };
    startAddonStatusTicker();
    if (expanded) render();
  }

  function updateAiProofreadStatus(phase) {
    if (!addonStatus || addonStatus.type !== 'ai-proofread' || addonStatus.state !== 'running') {
      startAiProofreadStatus(phase);
      return;
    }
    addonStatus.phase = phase || addonStatus.phase;
    if (expanded) render();
  }

  function finishAiProofreadStatus(state, message) {
    const now = Date.now();
    const previous = addonStatus && addonStatus.type === 'ai-proofread' ? addonStatus : null;
    addonStatus = {
      type: 'ai-proofread',
      label: 'AI 교정',
      state: state === 'error' ? 'error' : 'success',
      startedAt: previous && previous.startedAt ? previous.startedAt : now,
      finishedAt: now,
      phase: '',
      message: message || ''
    };
    stopAddonStatusTicker();
    if (expanded) render();
  }

  function startAiQuestionStatus(phase) {
    addonStatus = {
      type: 'ai-question',
      label: 'AI 문장 삽입',
      state: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      phase: phase || '시작 중',
      message: ''
    };
    startAddonStatusTicker();
    if (expanded) render();
  }

  function updateAiQuestionStatus(phase) {
    if (!addonStatus || addonStatus.type !== 'ai-question' || addonStatus.state !== 'running') {
      startAiQuestionStatus(phase);
      return;
    }
    addonStatus.phase = phase || addonStatus.phase;
    if (expanded) render();
  }

  function finishAiQuestionStatus(state, message) {
    const now = Date.now();
    const previous = addonStatus && addonStatus.type === 'ai-question' ? addonStatus : null;
    addonStatus = {
      type: 'ai-question',
      label: 'AI 문장 삽입',
      state: state === 'error' ? 'error' : 'success',
      startedAt: previous && previous.startedAt ? previous.startedAt : now,
      finishedAt: now,
      phase: '',
      message: message || ''
    };
    stopAddonStatusTicker();
    if (expanded) render();
  }

  function startAiTermsStatus(phase) {
    addonStatus = {
      type: 'ai-terms',
      label: 'AI 용어',
      state: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      phase: phase || '시작 중',
      message: ''
    };
    startAddonStatusTicker();
    if (expanded) render();
  }

  function updateAiTermsStatus(phase) {
    if (!addonStatus || addonStatus.type !== 'ai-terms' || addonStatus.state !== 'running') {
      startAiTermsStatus(phase);
      return;
    }
    addonStatus.phase = phase || addonStatus.phase;
    if (expanded) render();
  }

  function finishAiTermsStatus(state, message) {
    const now = Date.now();
    const previous = addonStatus && addonStatus.type === 'ai-terms' ? addonStatus : null;
    addonStatus = {
      type: 'ai-terms',
      label: 'AI 용어',
      state: state === 'error' ? 'error' : 'success',
      startedAt: previous && previous.startedAt ? previous.startedAt : now,
      finishedAt: now,
      phase: '',
      message: message || ''
    };
    stopAddonStatusTicker();
    if (expanded) render();
  }

  function startAiLengthStatus(phase) {
    addonStatus = {
      type: 'ai-length',
      label: 'AI 문장',
      state: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      phase: phase || '시작 중',
      message: ''
    };
    startAddonStatusTicker();
    if (expanded) render();
  }

  function updateAiLengthStatus(phase) {
    if (!addonStatus || addonStatus.type !== 'ai-length' || addonStatus.state !== 'running') {
      startAiLengthStatus(phase);
      return;
    }
    addonStatus.phase = phase || addonStatus.phase;
    if (expanded) render();
  }

  function finishAiLengthStatus(state, message) {
    const now = Date.now();
    const previous = addonStatus && addonStatus.type === 'ai-length' ? addonStatus : null;
    addonStatus = {
      type: 'ai-length',
      label: 'AI 문장',
      state: state === 'error' ? 'error' : 'success',
      startedAt: previous && previous.startedAt ? previous.startedAt : now,
      finishedAt: now,
      phase: '',
      message: message || ''
    };
    stopAddonStatusTicker();
    if (expanded) render();
  }

  function startImageExtractStatus(phase) {
    addonStatus = {
      type: 'extract-images',
      label: '이미지 추출',
      state: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      phase: phase || '시작 중',
      message: ''
    };
    startAddonStatusTicker();
    if (expanded) render();
  }

  function updateImageExtractStatus(phase) {
    if (!addonStatus || addonStatus.type !== 'extract-images' || addonStatus.state !== 'running') {
      startImageExtractStatus(phase);
      return;
    }
    addonStatus.phase = phase || addonStatus.phase;
    if (expanded) render();
  }

  function finishImageExtractStatus(state, message) {
    const now = Date.now();
    const previous = addonStatus && addonStatus.type === 'extract-images' ? addonStatus : null;
    addonStatus = {
      type: 'extract-images',
      label: '이미지 추출',
      state: state === 'error' ? 'error' : 'success',
      startedAt: previous && previous.startedAt ? previous.startedAt : now,
      finishedAt: now,
      phase: '',
      message: message || ''
    };
    stopAddonStatusTicker();
    if (expanded) render();
  }

  function startAddonStatusTicker() {
    stopAddonStatusTicker();
    addonStatusTimer = setInterval(() => {
      if (!addonStatus || addonStatus.state !== 'running') {
        stopAddonStatusTicker();
        return;
      }
      if (expanded) render({ preserveBodyScroll: true });
    }, 1000);
  }

  function stopAddonStatusTicker() {
    if (!addonStatusTimer) return;
    clearInterval(addonStatusTimer);
    addonStatusTimer = null;
  }

  function addonStatusLineText() {
    if (!addonStatus) return '';
    const label = addonStatus.label || (addonStatus.type === 'ai-proofread' ? 'AI 교정' : 'AI 작업');
    const now = addonStatus.state === 'running' ? Date.now() : (addonStatus.finishedAt || Date.now());
    const elapsed = formatElapsed(now - (addonStatus.startedAt || now));
    if (addonStatus.state === 'running') {
      return [label + ' 중', elapsed + ' 경과', addonStatus.phase || '대기 중'].join(' · ');
    }
    if (addonStatus.state === 'error') {
      return [label + ' 실패', elapsed + ' 경과', addonStatus.message || '오류 발생'].join(' · ');
    }
    return [label + ' 완료', elapsed + ' 경과', addonStatus.message || '완료'].join(' · ');
  }

  function formatElapsed(ms) {
    const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const p = n => String(n).padStart(2, '0');
    return h > 0 ? String(h) + ':' + p(m) + ':' + p(s) : p(m) + ':' + p(s);
  }

  function openSettingsPageFromDocs() {
    try {
      chrome.runtime.sendMessage({ type: 'typo:openOptions' }, res => {
        if (chrome.runtime.lastError) {
          const error = new Error(chrome.runtime.lastError.message || 'settings open message failed');
          console.error('[Toytype settings] open failed', error);
          showToast('설정 열기 실패 · 확장 프로그램 새로고침 필요', { durationMs: 4200 });
          return;
        }
        if (!res || res.ok !== true) {
          console.error('[Toytype settings] open failed', res || { error: 'empty response' });
          showToast('설정 열기 실패 · 확장 프로그램 새로고침 필요', { durationMs: 4200 });
        }
      });
    } catch (error) {
      console.error('[Toytype settings] open failed', error);
      showToast('설정 열기 실패 · 확장 프로그램 새로고침 필요', { durationMs: 4200 });
    }
  }

  function readCurrentDocumentTextForAddon() {
    const docId = getDocId();
    if (!docId) return Promise.reject(new Error('document id unavailable'));
    return requestDocsModel('getText', { docId, timeoutMs: 60000 }).then(res => {
      if (!res || !res.ok || typeof res.text !== 'string') {
        throw new Error(res && res.errorMessage ? res.errorMessage : 'model text unavailable');
      }
      cachedText = res.text;
      cachedTextSource = 'model';
      lastModelAt = Date.now();
      updateCursorOffset(res.selection || null);
      return {
        docId,
        title: documentTitleForAddon(),
        text: res.text,
        source: 'model',
        selection: res.selection || null
      };
    }).catch(error => {
      if (typeof cachedText === 'string' && cachedText.length > 0) {
        return {
          docId,
          title: documentTitleForAddon(),
          text: cachedText,
          source: cachedTextSource || 'cache'
        };
      }
      throw error;
    });
  }

  function documentTitleForAddon() {
    const raw = String(document.title || '').replace(/\s*-\s*Google Docs\s*$/i, '').trim();
    return raw || getDocId() || 'Google Docs';
  }

  // 모든 AI 브리지 호출은 백그라운드 서비스워커를 거친다.
  // 콘텐트 스크립트(docs.google.com 페이지 컨텍스트)에서 직접 127.0.0.1로 fetch하면
  // MV3에서는 확장 host_permissions가 적용되지 않아 페이지 출처 기준 접근 제어(CORS/PNA)로
  // 차단된다("Fetch API cannot load ... due to access control checks"). 긴 AI 요청이라도
  // 백그라운드의 진행 중 fetch가 서비스워커를 살려 두므로 백그라운드 경유가 유일한 정상 경로다.
  function sendAiBridge(action, payload) {
    return sendAiBridgeViaBackground(action, payload);
  }

  function sendAiBridgeViaBackground(action, payload) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({
          type: 'typo:aiBridge',
          action,
          payload: payload || {}
        }, res => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: 'extension_message_failed', message: chrome.runtime.lastError.message });
            return;
          }
          resolve(res);
        });
      } catch (e) {
        resolve({ ok: false, error: 'extension_message_failed', message: e && e.message ? e.message : String(e) });
      }
    });
  }

  function bridgeStatusLabel() {
    if (bridgeStatus.state === 'error') return '꺼짐';
    return '';
  }

  function bridgeStatusTitle() {
    if (bridgeStatus.state === 'ok') {
      const meta = [bridgeStatus.version ? 'v' + bridgeStatus.version : '', bridgeStatus.port ? 'port ' + bridgeStatus.port : ''].filter(Boolean).join(' · ');
      return '브릿지 연결됨' + (meta ? ' · ' + meta : '') + ' · 클릭하면 상태를 다시 확인합니다';
    }
    if (bridgeStatus.state === 'checking') return '브릿지 상태 확인 중';
    if (bridgeStatus.state === 'error') return '브릿지 꺼짐 · 클릭하면 재시작 명령을 복사합니다';
    return '브릿지 상태 확인 전';
  }

  function bridgeStatusAriaLabel() {
    if (bridgeStatus.state === 'ok') return '브릿지 연결됨';
    if (bridgeStatus.state === 'checking') return '브릿지 상태 확인 중';
    if (bridgeStatus.state === 'error') return '브릿지 꺼짐';
    return '브릿지 상태 확인 전';
  }

  function handleBridgeStatusBadgeClick() {
    if (bridgeStatus.state === 'error') {
      const command = bridgeRestartCommand();
      copyText(command).then(
        () => showToast('브릿지 재시작 명령 복사됨'),
        () => showToast(command, { durationMs: 4200 })
      );
      return;
    }
    pollBridgeStatus(true);
  }

  function bridgeRestartCommand() {
    const port = Number.isFinite(Number(bridgeStatus.port)) ? Math.floor(Number(bridgeStatus.port)) : DEFAULT_BRIDGE_PORT;
    return 'node tools/toytype_ai_bridge_ctl.mjs restart --port ' + port;
  }

  function syncBridgeStatusWatcher() {
    if (!expanded) {
      stopBridgeStatusWatcher();
      return;
    }
    if (!bridgeStatusTimer) {
      bridgeStatusTimer = setInterval(() => { pollBridgeStatus(false); }, BRIDGE_STATUS_POLL_INTERVAL);
    }
    if (!bridgeStatus.checkedAt || Date.now() - bridgeStatus.checkedAt > BRIDGE_STATUS_STALE_MS) {
      pollBridgeStatus(false);
    }
  }

  function stopBridgeStatusWatcher() {
    if (!bridgeStatusTimer) return;
    clearInterval(bridgeStatusTimer);
    bridgeStatusTimer = null;
    bridgeStatusBusy = false;
  }

  function pollBridgeStatus(force) {
    if (bridgeStatusBusy) return;
    if (!force && bridgeStatus.checkedAt && Date.now() - bridgeStatus.checkedAt <= BRIDGE_STATUS_STALE_MS) return;
    bridgeStatusBusy = true;
    const showChecking = force || !bridgeStatus || bridgeStatus.state !== 'ok';
    if (showChecking) {
      bridgeStatus = Object.assign({}, bridgeStatus, { state: 'checking' });
      if (expanded) render({ preserveBodyScroll: true });
    }
    sendAiBridge('health', {}).then(res => {
      if (res && res.ok) {
        bridgeStatus = {
          state: 'ok',
          checkedAt: Date.now(),
          port: Number.isFinite(Number(res.port)) ? Math.floor(Number(res.port)) : bridgeStatus.port,
          version: typeof res.version === 'string' ? res.version : '',
          error: ''
        };
        return;
      }
      const bridgeUrl = res && typeof res.bridgeUrl === 'string' ? res.bridgeUrl : '';
      bridgeStatus = {
        state: 'error',
        checkedAt: Date.now(),
        port: bridgePortFromUrl(bridgeUrl) || bridgeStatus.port || DEFAULT_BRIDGE_PORT,
        version: '',
        error: res && (res.error || res.message) ? String(res.error || res.message) : 'bridge_unavailable'
      };
    }).catch(error => {
      bridgeStatus = {
        state: 'error',
        checkedAt: Date.now(),
        port: bridgeStatus.port || DEFAULT_BRIDGE_PORT,
        version: '',
        error: error && error.message ? error.message : String(error)
      };
    }).finally(() => {
      bridgeStatusBusy = false;
      if (expanded) render({ preserveBodyScroll: true });
    });
  }

  function bridgePortFromUrl(url) {
    try {
      const parsed = new URL(String(url || ''));
      const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
      return Number.isFinite(port) ? port : null;
    } catch (_) {
      return null;
    }
  }

  function loadCachedGeneratedRulesListQuiet() {
    loadCachedGeneratedRulesList().catch(error => {
      debugWarn('[Toytype addons] generated JSON cache load failed', error);
    });
  }

  function loadCachedGeneratedRulesList() {
    const docId = getDocId();
    if (!docId) return Promise.resolve(false);
    return new Promise(resolve => {
      try {
        chrome.storage.local.get(GENERATED_RULES_CACHE_KEY, items => {
          if (chrome.runtime.lastError) {
            resolve(false);
            return;
          }
          const cache = items && items[GENERATED_RULES_CACHE_KEY] && typeof items[GENERATED_RULES_CACHE_KEY] === 'object'
            ? items[GENERATED_RULES_CACHE_KEY]
            : {};
          const docCache = cache[docId] && typeof cache[docId] === 'object' ? cache[docId] : null;
          const files = Array.isArray(docCache && docCache.files) ? docCache.files : [];
          const nextFiles = [];
          for (const file of files) {
            const entry = normalizeGeneratedRulesFileEntry(file);
            if (entry) nextFiles.push(entry);
          }
          if (nextFiles.length === 0) {
            resolve(false);
            return;
          }
          generatedRulesFiles = mergeGeneratedRulesFileEntries(nextFiles, generatedRulesFiles);
          generatedRulesLoadedDocId = docId;
          if (expanded) render();
          resolve(true);
        });
      } catch (_) {
        resolve(false);
      }
    });
  }

  function saveGeneratedRulesCacheQuiet() {
    saveGeneratedRulesCache().catch(error => {
      debugWarn('[Toytype addons] generated JSON cache save failed', error);
    });
  }

  function saveGeneratedRulesCache() {
    const docId = getDocId();
    if (!docId) return Promise.resolve(false);
    const files = generatedRulesFiles
      .filter(file => file && !file.virtual)
      .map(normalizeGeneratedRulesFileEntry)
      .filter(Boolean)
      .slice(0, GENERATED_RULES_CACHE_FILE_LIMIT);
    return new Promise(resolve => {
      try {
        chrome.storage.local.get(GENERATED_RULES_CACHE_KEY, items => {
          if (chrome.runtime.lastError) {
            resolve(false);
            return;
          }
          const cache = items && items[GENERATED_RULES_CACHE_KEY] && typeof items[GENERATED_RULES_CACHE_KEY] === 'object'
            ? Object.assign({}, items[GENERATED_RULES_CACHE_KEY])
            : {};
          cache[docId] = {
            savedAt: Date.now(),
            title: documentTitleForAddon(),
            url: location.href,
            files
          };
          const keys = Object.keys(cache).sort((a, b) => {
            const am = cache[a] && Number(cache[a].savedAt) || 0;
            const bm = cache[b] && Number(cache[b].savedAt) || 0;
            return bm - am;
          });
          for (const key of keys.slice(GENERATED_RULES_CACHE_DOC_LIMIT)) delete cache[key];
          chrome.storage.local.set({ [GENERATED_RULES_CACHE_KEY]: cache }, () => {
            resolve(!chrome.runtime.lastError);
          });
        });
      } catch (_) {
        resolve(false);
      }
    });
  }

  function normalizeGeneratedRulesFileEntry(file) {
    if (!file || typeof file.fileName !== 'string' || !file.json) return null;
    try {
      validateRulesJson(file.json);
    } catch (_) {
      return null;
    }
    return {
      fileName: file.fileName,
      displayName: typeof file.displayName === 'string' && file.displayName ? file.displayName : generatedRulesDisplayName(file.fileName),
      outputPath: typeof file.outputPath === 'string' ? file.outputPath : '',
      mtimeMs: Number.isFinite(Number(file.mtimeMs)) ? Number(file.mtimeMs) : 0,
      json: file.json
    };
  }

  function mergeGeneratedRulesFileEntries(primary, secondary) {
    const map = new Map();
    for (const file of secondary || []) {
      const entry = normalizeGeneratedRulesFileEntry(file);
      if (entry) map.set(entry.fileName, entry);
    }
    for (const file of primary || []) {
      const entry = normalizeGeneratedRulesFileEntry(file);
      if (entry) map.set(entry.fileName, entry);
    }
    return Array.from(map.values()).sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  }

  function refreshGeneratedRulesListQuiet() {
    refreshGeneratedRulesList().catch(error => {
      console.error('[Toytype addons] generated JSON list failed', error);
    });
  }

  async function refreshGeneratedRulesList() {
    const docId = getDocId();
    if (!docId) {
      generatedRulesFiles = [];
      generatedRulesLoadedDocId = null;
      return false;
    }
    const res = await sendAiBridge('listGenerated', {
      document: {
        id: docId,
        title: documentTitleForAddon(),
        url: location.href
      }
    });
    if (!res || !res.ok || !Array.isArray(res.files)) {
      if (res && res.error !== 'bridge_unavailable' && res.error !== 'extension_message_failed') {
        console.error('[Toytype addons] generated JSON list failed', res);
      }
      return false;
    }
    const nextFiles = [];
    for (const file of res.files) {
      const entry = normalizeGeneratedRulesFileEntry(file);
      if (entry) {
        nextFiles.push(entry);
      } else {
        console.error('[Toytype addons] generated JSON ignored', { fileName: file && file.fileName, reason: 'invalid generated rules json' });
      }
    }
    generatedRulesFiles = nextFiles;
    generatedRulesLoadedDocId = docId;
    saveGeneratedRulesCacheQuiet();
    if (isGeneratedRulesSource(activeRulesSource) && !findGeneratedRulesFile(activeRulesSource)) {
      useRulesSource('builtin');
      if (cachedText !== null) enqueueScan(false, { quiet: true });
    }
    if (expanded) render();
    return true;
  }

  function upsertGeneratedRulesFile(file) {
    if (!file || typeof file.fileName !== 'string' || !file.json) return;
    try {
      validateRulesJson(file.json);
    } catch (error) {
      console.error('[Toytype addons] generated JSON ignored', { fileName: file.fileName, error });
      return;
    }
    const entry = {
      fileName: file.fileName,
      displayName: typeof file.displayName === 'string' && file.displayName ? file.displayName : generatedRulesDisplayName(file.fileName),
      outputPath: typeof file.outputPath === 'string' ? file.outputPath : '',
      mtimeMs: Number.isFinite(Number(file.mtimeMs)) ? Number(file.mtimeMs) : Date.now(),
      json: file.json
    };
    generatedRulesFiles = [entry]
      .concat(generatedRulesFiles.filter(existing => existing.fileName !== entry.fileName))
      .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
    generatedRulesLoadedDocId = getDocId();
    saveGeneratedRulesCacheQuiet();
    if (expanded) render();
  }

  function generatedRulesDisplayName(fileName) {
    if (/-문장제안\.json$/i.test(String(fileName || ''))) return '문장제안.json';
    const stamp = String(fileName || '').match(/(?:-toytype)?-(\d{8}T\d{6}Z)\.json$/);
    return stamp ? 'ai 검토-' + stamp[1] + '.json' : 'ai 검토.json';
  }

  function aiBridgeError(res, fallbackMessage) {
    const code = res && (res.error || res.message);
    let userMessage = fallbackMessage;
    if (code === 'bridge_unavailable') {
      userMessage = '로컬 브리지가 꺼져 있습니다 · 터미널에서 브리지를 실행하세요';
    } else if (code === 'extension_message_failed') {
      userMessage = '확장 background 응답이 끊겼습니다 · Google Docs 또는 확장 프로그램을 새로고침하세요';
    } else if (code === 'bridge_timeout') {
      userMessage = 'AI 응답 시간 초과';
    } else if (res && res.status === 404 && res.error === 'not found') {
      userMessage = '브리지 기능을 찾지 못했습니다 · 로컬 브리지를 재시작하세요';
    } else if (res && res.error) {
      userMessage = fallbackMessage + ': ' + String(res.error).slice(0, 120);
    } else if (res && res.message) {
      userMessage = fallbackMessage + ': ' + String(res.message).slice(0, 120);
    } else {
      userMessage = fallbackMessage;
    }
    const details = res && res.details && typeof res.details === 'object' ? res.details : null;
    if (details && details.exitCode !== undefined) {
      userMessage += ' · exitCode ' + String(details.exitCode);
    }
    if (details && typeof details.stderr === 'string' && details.stderr.trim()) {
      const firstUsefulLine = details.stderr.split(/\r?\n/).map(line => line.trim()).find(Boolean);
      if (firstUsefulLine) userMessage += ' · ' + firstUsefulLine.slice(0, 160);
    }
    const error = new Error(userMessage);
    error.userMessage = userMessage;
    error.response = res;
    return error;
  }

  function summarizeAiBridgeResponse(res) {
    if (!res || typeof res !== 'object') {
      return String(res).slice(0, 500);
    }
    const details = res.details && typeof res.details === 'object' ? res.details : null;
    return {
      ok: res.ok === true,
      status: Number.isFinite(Number(res.status)) ? Number(res.status) : undefined,
      error: typeof res.error === 'string' ? res.error.slice(0, 300) : undefined,
      message: typeof res.message === 'string' ? res.message.slice(0, 300) : undefined,
      exitCode: details && details.exitCode !== undefined ? details.exitCode : undefined,
      model: details && typeof details.model === 'string' ? details.model : undefined,
      stdout: details && typeof details.stdout === 'string' ? details.stdout.slice(-1200) : undefined,
      stderr: details && typeof details.stderr === 'string' ? details.stderr.slice(-1200) : undefined
    };
  }

  function countRulesInJson(json) {
    if (!json || !Array.isArray(json.categories)) return 0;
    return json.categories.reduce((sum, cat) => sum + (Array.isArray(cat.rules) ? cat.rules.length : 0), 0);
  }

  function extractTocFromDocument(doc) {
    return extractTocFromMarkdownExport().catch(error => {
      debugWarn('[Toytype addons] TOC md export unavailable', error && error.message ? error.message : error);
      return null;
    }).then(exported => {
      if (exported && exported.headings.length > 0) return exported;
      const outline = extractTocFromDomOutline();
      if (outline.headings.length > 0) return outline;
      return extractTocFromText(doc && doc.text);
    }).then(applyTocMaxLevel);
  }

  // 설정한 깊이보다 깊은 헤딩은 출처와 무관하게 마지막에 한 번만 거른다 — 복사 개수 토스트와 일치 보장
  function applyTocMaxLevel(result) {
    if (!result || !Array.isArray(result.headings)) return result;
    const cap = normalizeTocMaxLevel(settings && settings.tocMaxLevel);
    return Object.assign({}, result, {
      headings: result.headings.filter(h => Number(h.level) <= cap)
    });
  }

  // 헤딩 레벨의 1차 출처. 어노테이티드 모델 텍스트에는 단락 스타일이 없어
  // 휴리스틱으로는 헤딩 1~5를 구분할 수 없고, md export의 #/##/### 개수가 정확한 레벨이다.
  function extractTocFromMarkdownExport() {
    const docId = getDocId();
    if (!docId) return Promise.reject(new Error('document id unavailable'));
    return fetchMarkdownExport(docId).then(parseMarkdownExportHeadings);
  }

  function fetchMarkdownExport(docId) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    // 멀티 계정 세션 대응: /document/u/N/ 컨텍스트를 보존해야 두 번째 계정 문서도 권한이 맞는다
    const um = location.pathname.match(/\/document\/u\/(\d+)\//);
    const url = 'https://docs.google.com/document/' + (um ? 'u/' + um[1] + '/' : '') +
      'd/' + docId + '/export?format=md';
    return fetch(url, { signal: ctrl.signal })
      .then(res => {
        if (!res.ok) throw new Error('md export http ' + res.status);
        // 로그인 리다이렉트 등이 200 + HTML로 떨어지면 본문으로 오인 스캔하게 된다 — 차단
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (ct.indexOf('text/html') !== -1) throw new Error('md export content-type: ' + ct);
        return res.text();
      })
      .then(t => (t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t).replace(/\r/g, ''))
      .finally(() => clearTimeout(timer));
  }

  function parseMarkdownExportHeadings(markdown) {
    const lines = String(markdown || '').split('\n');
    const headings = [];
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (isFenceLine(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const m = line.match(/^(#{1,6})\s+(\S.*)$/);
      if (!m) continue;
      const level = m[1].length;
      if (level > 5) continue;
      const text = cleanMarkdownHeadingText(m[2]);
      if (!text || isBadTocText(text)) continue;
      headings.push({ level, text, raw: line, line: i + 1 });
    }
    return { headings, lineCount: lines.length, source: 'md-export' };
  }

  function cleanMarkdownHeadingText(text) {
    let s = String(text || '').trim();
    s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); // 링크는 표시 텍스트만
    // 강조 마커 제거 — \*처럼 이스케이프된 리터럴은 건드리지 않는다
    s = s.replace(/(?<!\\)\*\*(.+?)\*\*/g, '$1');
    s = s.replace(/(?<!\\)\*([^*]+)\*/g, '$1');
    s = s.replace(/(?<!\\)~~(.+?)~~/g, '$1');
    s = s.replace(/(?<!\\)`([^`]+)`/g, '$1');
    s = s.replace(/\\([!-/:-@[-`{-~])/g, '$1'); // export가 이스케이프한 특수문자 복원
    return normalizeTocLine(s);
  }

  function extractTocFromDomOutline() {
    const selectors = [
      '[aria-label="Document outline"] [role="treeitem"]',
      '[aria-label="문서 개요"] [role="treeitem"]',
      '[aria-label*="outline" i] [role="treeitem"]',
      '[aria-label*="개요"] [role="treeitem"]',
      '.navigation-widget .navigation-item',
      '.navigation-item'
    ];
    for (const selector of selectors) {
      let nodes = [];
      try {
        nodes = Array.prototype.slice.call(document.querySelectorAll(selector));
      } catch (e) {
        nodes = [];
      }
      const candidates = [];
      const seen = new Set();
      for (const node of nodes) {
        if (!isDocsOutlineNode(node)) continue;
        const text = normalizeTocLine(node.innerText || node.textContent || '');
        if (!text || isBadTocText(text) || isMarkdownHeadingLine(text)) continue;
        const key = text;
        if (seen.has(key)) continue;
        seen.add(key);
        const level = readDocsOutlineLevel(node);
        if (level > 5) continue;
        candidates.push({
          level,
          text,
          raw: text,
          line: null,
          indent: docsOutlineIndent(node)
        });
      }
      if (candidates.length > 0 && candidates.length < 200) {
        const levels = assignDocsOutlineLevels(candidates);
        const headings = candidates.map((item, index) => ({
          level: levels[index],
          text: item.text,
          raw: item.raw,
          line: item.line
        }));
        return { headings, lineCount: 0, source: 'docs-outline' };
      }
    }
    return { headings: [], lineCount: 0, source: 'docs-outline' };
  }

  function isDocsOutlineNode(node) {
    if (!node || typeof node.closest !== 'function') return false;
    return !!node.closest(
      '[aria-label="Document outline"], [aria-label="문서 개요"], [aria-label*="outline" i], [aria-label*="개요"], .navigation-widget, [id*="outline" i], [class*="outline" i]'
    );
  }

  function readDocsOutlineLevel(node) {
    const ariaLevel = readPositiveIntAttr(node, 'aria-level');
    if (ariaLevel) return ariaLevel;
    const headingLevel = readPositiveIntAttr(node, 'data-heading-level');
    if (headingLevel) return headingLevel;
    const classLevel = readDocsOutlineLevelFromClassName(node);
    if (classLevel) return classLevel;
    const childClassLevel = readDocsOutlineChildClassLevel(node);
    if (childClassLevel) return childClassLevel;
    const dataLevel = readNonNegativeIntAttr(node, 'data-level');
    if (dataLevel !== null) return dataLevel === 0 ? 1 : dataLevel;
    return 0;
  }

  // 레벨 클래스(navigation-item-level-N)는 .navigation-item이 아니라
  // 자식 .navigation-item-content에 붙는다. 0은 문서 제목 행, 1=헤딩1, 2=헤딩2 …
  function readDocsOutlineChildClassLevel(node) {
    if (!node || typeof node.querySelector !== 'function') return 0;
    let child = null;
    try {
      child = node.querySelector('[class*="navigation-item-level-"]');
    } catch (e) {
      child = null;
    }
    if (!child) return 0;
    const m = String(child.className || '').match(/navigation-item-level-(\d+)/);
    if (!m) return 0;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n < 0) return 0;
    return n === 0 ? 1 : n;
  }

  function readDocsOutlineLevelFromClassName(node) {
    const text = String((node && node.className || '') + ' ' + (node && node.id || ''));
    const directPatterns = [
      /(?:^|\s)[^\s]*(?:heading|header)[-_ ]?(?:level[-_ ]?)?([1-6])(?:\b|$)/i,
      /(?:^|\s)[^\s]*\bh[-_ ]?([1-6])(?:\b|$)/i,
      /(?:^|\s)[^\s]*level[-_ ]?([1-6])(?:\b|$)/i
    ];
    for (const pattern of directPatterns) {
      const m = text.match(pattern);
      if (m) return Number(m[1]);
    }
    if (/(?:^|\s)[^\s]*level[-_ ]?0(?:\b|$)/i.test(text)) return 1;
    return 0;
  }

  function readPositiveIntAttr(node, name) {
    if (!node || typeof node.getAttribute !== 'function') return 0;
    const n = Number(node.getAttribute(name));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  function readNonNegativeIntAttr(node, name) {
    if (!node || typeof node.getAttribute !== 'function') return null;
    const value = node.getAttribute(name);
    if (value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  }

  function docsOutlineIndent(node) {
    try {
      // 들여쓰기도 외부 행이 아니라 내부 콘텐츠 노드에 적용된다
      let target = node;
      try {
        target = node.querySelector('[class*="navigation-item-level-"], .navigation-item-content') || node;
      } catch (e) {
        target = node;
      }
      const rect = target.getBoundingClientRect();
      const style = window.getComputedStyle(target);
      return Math.round((rect && Number.isFinite(rect.left) ? rect.left : 0) +
        parseFloat(style.paddingLeft || '0') +
        parseFloat(style.marginLeft || '0'));
    } catch (e) {
      return 0;
    }
  }

  function assignDocsOutlineLevels(items) {
    const direct = items.map(item => Number(item.level) || 0);
    const directSet = new Set(direct.filter(level => level > 0));
    // 모든 항목이 명시 레벨을 가지면 단일 레벨(예: 전부 헤딩2)이라도 그대로 신뢰한다
    if (directSet.size > 1 || (directSet.size === 1 && direct.every(level => level > 0))) {
      return direct.map(level => Math.max(1, Math.min(5, level || 1)));
    }

    const indents = items.map(item => Number(item.indent) || 0);
    const sorted = Array.from(new Set(indents)).sort((a, b) => a - b);
    const buckets = [];
    for (const value of sorted) {
      const last = buckets[buckets.length - 1];
      if (last === undefined || Math.abs(value - last) > 4) buckets.push(value);
    }
    if (buckets.length > 1) {
      return indents.map(value => {
        let bucketIndex = 0;
        for (let i = 0; i < buckets.length; i++) {
          if (Math.abs(value - buckets[i]) <= 4) {
            bucketIndex = i;
            break;
          }
        }
        return Math.max(1, Math.min(5, bucketIndex + 1));
      });
    }

    return items.map(() => 1);
  }

  function extractTocFromText(text) {
    const lines = String(text || '').replace(/\r/g, '').split(/\n|\v/);
    const headings = [];
    const seen = new Set();
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const normalized = normalizeTocLine(raw);
      if (isFenceLine(normalized)) {
        inFence = !inFence;
        continue;
      }
      if (inFence || !normalized || isMarkdownHeadingLine(normalized) || isBadTocText(normalized)) continue;
      let level = detectExplicitTocLevel(normalized);
      if (!level) level = detectStandaloneTocLevel(lines, i, headings);
      if (!normalized) continue;
      if (!level) continue;
      const textOnly = stripTocPrefix(normalized);
      if (!textOnly || isBadTocText(textOnly)) continue;
      const key = level + '\u0000' + textOnly;
      if (seen.has(key)) continue;
      seen.add(key);
      headings.push({
        level,
        text: textOnly,
        raw: normalized,
        line: i + 1
      });
    }
    return { headings, lineCount: lines.length, source: 'text' };
  }

  function normalizeTocLine(line) {
    const s = String(line || '')
      .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!s || s.length > 90) return '';
    if (/^[.\-_=*•·\s]+$/.test(s)) return '';
    if (/^https?:\/\//i.test(s)) return '';
    return s;
  }

  function isFenceLine(line) {
    return /^(```|~~~)/.test(line || '');
  }

  function isMarkdownHeadingLine(line) {
    return /^#{1,6}\s+\S/.test(line || '');
  }

  function isBadTocText(line) {
    const s = String(line || '').trim();
    if (!s) return true;
    if (/^<\/?[^>]+>$/.test(s)) return true;
    if (/^[{}[\]();,./\\|`~@$%^&*_+=-]+$/.test(s)) return true;
    if (/^(양식|예시|예제|샘플|템플릿|출력|입력)$/.test(s)) return true;
    if (/^(회의록 요약|1분 꿀팁)$/.test(s)) return true;
    return false;
  }

  function detectExplicitTocLevel(line) {
    if (/^(PART|Part|파트|부)\s*[0-9IVXLC가-힣]*[ .:：-]?\s*\S+/.test(line)) return 1;
    if (/^\d{1,2}\s*(장|부)(?:\s|[.:：-]|$)/.test(line)) return 1;
    if (/^제\s*\d{1,2}\s*장(?:\s|[.:：-]|$)/.test(line)) return 1;
    if (/^(CHAPTER|Chapter|챕터|CH)\s*\d{1,2}(?:\s|[.:：-]|$)/.test(line)) return 1;
    if (/^\d{1,2}\.\d{1,2}\.\d{1,2}\.\d{1,2}\s+\S+/.test(line)) return 5;
    if (/^\d{1,2}\.\d{1,2}\.\d{1,2}\s+\S+/.test(line)) return 4;
    if (/^\d{1,2}\.\d{1,2}\s+\S+/.test(line)) return 3;
    if (/^\d{1,2}\.\s+\S+/.test(line)) return 2;
    if (/^\d{2}\s+[^\d\s].+/.test(line) && !/[.!?。]$/.test(line)) return 2;
    return 0;
  }

  function detectStandaloneTocLevel(lines, index, headings) {
    const line = normalizeTocLine(lines[index]);
    if (!isTitleLikeTocLine(line)) return 0;
    const prev = previousNonEmptyLine(lines, index);
    const next = nextNonEmptyLine(lines, index);
    const prevBlank = index === 0 || !normalizeTocLine(lines[index - 1]);
    const nextBlank = index >= lines.length - 1 || !normalizeTocLine(lines[index + 1]);
    const prevExplicit = prev && detectExplicitTocLevel(prev.text);
    const nextExplicit = next && detectExplicitTocLevel(next.text);
    if (prevExplicit || nextExplicit) return Math.min(5, (prevExplicit || nextExplicit) + 1);
    if (headings.length > 0 && prevBlank && nextBlank) return Math.min(5, Math.max(2, headings[headings.length - 1].level + 1));
    if (prevBlank && nextBlank && line.length <= 32) return 2;
    return 0;
  }

  function isTitleLikeTocLine(line) {
    const s = String(line || '').trim();
    if (!s || s.length < 2 || s.length > 54) return false;
    if (isBadTocText(s) || isMarkdownHeadingLine(s)) return false;
    if (/^[\-*•·]\s+/.test(s)) return false;
    if (/[.!?。]$/.test(s)) return false;
    if (/(습니다|합니다|됩니다|입니다|이었다|했다|한다|된다|이다|였다)[”"')\]]?$/.test(s)) return false;
    if (/[{}[\];]/.test(s)) return false;
    if (/^\S+\s*[:：]\s+\S+/.test(s)) return false;
    if (!/[가-힣A-Za-z0-9]/.test(s)) return false;
    return true;
  }

  function previousNonEmptyLine(lines, index) {
    for (let i = index - 1; i >= Math.max(0, index - 4); i--) {
      const text = normalizeTocLine(lines[i]);
      if (text) return { index: i, text };
    }
    return null;
  }

  function nextNonEmptyLine(lines, index) {
    for (let i = index + 1; i <= Math.min(lines.length - 1, index + 4); i++) {
      const text = normalizeTocLine(lines[i]);
      if (text) return { index: i, text };
    }
    return null;
  }

  function stripTocPrefix(line) {
    return String(line || '').trim();
  }

  function formatExtractedToc(title, result) {
    const lines = [];
    if (!result.headings.length) {
      lines.push('목차를 찾지 못했습니다.');
      return lines.join('\n');
    }
    for (const h of result.headings) {
      const rawLevel = Math.max(1, Number(h.level) || 1);
      if (rawLevel > 5) continue;
      const level = Math.min(5, rawLevel);
      lines.push(tocIndentPrefix(level) + h.text);
    }
    return lines.join('\n');
  }

  function tocIndentPrefix(level) {
    return level <= 1 ? '' : '_'.repeat(level - 1);
  }

  function handleRulesJsonUpload(file) {
    file.text().then(text => {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        throw new Error('json_parse_failed');
      }
      setUploadedRulesJson(parsed, file.name || 'uploaded.json');
      showToast('JSON 선택됨: ' + (file.name || 'uploaded.json'));
      enqueueScan(cachedText === null);
    }).catch(error => {
      console.error('[Toytype rules] JSON upload failed', error);
      showToast('JSON 업로드 실패 · 콘솔 확인', { durationMs: 3600 });
    });
  }

  function fallbackFindingClick(f) {
    if (isSentenceSuggestionFinding(f)) {
      const suggestion = String(f && f.dst || '');
      if (!suggestion) {
        showToast('복사할 문장 제안이 없습니다');
        return;
      }
      if (!settings.copyOnSelect) {
        showToast('문서 위치를 찾지 못했습니다');
        return;
      }
      copyText(suggestion).then(
        () => showToast('문장 제안 복사됨: ' + displayText(suggestion)),
        () => showToast('문장 제안 복사 실패')
      );
      return;
    }
    const term = searchTermForFinding(f);
    if (!settings.copyOnSelect) {
      openDocsFind();
      showToast('문서 위치 선택 실패 · 검색어: ' + displayText(term));
      return;
    }
    copyText(term).then(
      () => {
        openDocsFind();
        showToast('검색어 복사됨: ' + displayText(term));
      },
      () => {
        showToast('검색어 복사 실패');
      }
    );
  }

  function isSentenceSuggestionFinding(f) {
    return !!(f && f.cat === SENTENCE_SUGGESTION_CATEGORY_ID);
  }

  function openDocsFind() {
    // 브라우저 보안상 확장이 "진짜" Cmd/Ctrl+F를 보낼 수는 없다.
    // 구글 독스가 untrusted key event를 받아주는 환경에서는 내부 검색창이 열리고,
    // 막히는 환경에서는 검색어 복사 fallback만 남는다.
    const isMac = /\bMac\b/.test(navigator.platform || '');
    const opts = {
      key: 'f',
      code: 'KeyF',
      keyCode: 70,
      which: 70,
      bubbles: true,
      cancelable: true,
      composed: true,
      metaKey: isMac,
      ctrlKey: !isMac
    };
    try {
      window.focus();
      const target = document.activeElement || document.body || document.documentElement;
      target.dispatchEvent(new KeyboardEvent('keydown', opts));
      target.dispatchEvent(new KeyboardEvent('keyup', opts));
    } catch (e) { /* best effort */ }
  }

  function searchTermForFinding(f) {
    const src = normalizeSearchText(f.src);
    if (src) return src;
    return normalizeSearchText((f.before || '').split(/\s+/).slice(-2).join(' ') + ' ' + (f.after || '').split(/\s+/).slice(0, 2).join(' '));
  }

  function normalizeSearchText(s) {
    return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
  }

  function requestDocsModel(action, payload) {
    return new Promise((resolve, reject) => {
      const timeoutMs = payload && Number.isFinite(Number(payload.timeoutMs))
        ? Math.max(1000, Math.min(75000, Number(payload.timeoutMs)))
        : 4000;
      const requestId = 'trd-' + Date.now() + '-' + (++modelRequestSeq);
      let posted = false;
      let readyPollTimer = null;
      const timeout = setTimeout(() => {
        cleanup();
        const error = new Error('model request timeout');
        error.debug = {
          action,
          requestId,
          posted,
          pageBridge: pageBridgeStatus()
        };
        reject(error);
      }, timeoutMs);
      function cleanup() {
        clearTimeout(timeout);
        if (readyPollTimer) {
          clearInterval(readyPollTimer);
          readyPollTimer = null;
        }
        window.removeEventListener('message', onMessage);
      }
      function postRequestWhenReady() {
        if (posted || (!pageBridgeReady && !pageBridgeLoadAt)) return;
        posted = true;
        window.postMessage(Object.assign({
          kind: 'typo-radar:page-model-request',
          requestId,
          action,
          extensionId: chrome.runtime.id
        }, payload || {}), '*');
      }
      function onMessage(event) {
        if (event.source !== window || !event.data) return;
        if (event.data.kind === 'typo-radar:page-bridge-ready') {
          markPageBridgeReady();
          postRequestWhenReady();
          return;
        }
        if (event.data.kind !== 'typo-radar:page-model-response' || event.data.requestId !== requestId) return;
        cleanup();
        resolve(event.data);
      }
      window.addEventListener('message', onMessage);
      injectPageBridgeScript();
      postRequestWhenReady();
      if (!posted) {
        readyPollTimer = setInterval(postRequestWhenReady, 25);
      }
    });
  }

  function selectDocsModelRange(start, end) {
    return requestDocsModel('setSelection', { start, end, docId: getDocId() }).then(res => {
      if (!res || !res.ok) throw new Error(res && res.errorMessage ? res.errorMessage : 'setSelection failed');
      return res;
    });
  }

  function fetchDocsSelection() {
    return requestDocsModel('getSelection', { docId: getDocId() }).then(res => {
      if (!res || !res.ok) throw new Error(res && res.errorMessage ? res.errorMessage : 'getSelection failed');
      return res.selection || null;
    });
  }

  // 연구용: annotated 모델 호출(getText/getSelection 등)의 실제 지연을 측정한다.
  // 콘솔에서 ToytypeProfileModelOpsFromContent() 로 호출.
  function profileModelOpsFromContent(options) {
    return requestDocsModel('profileModelOps', Object.assign({
      docId: getDocId(),
      timeoutMs: 60000
    }, options || {})).then(res => {
      if (!res || !res.ok) throw docsModelError('profileModelOps failed', res);
      const result = res.result;
      debugLog('[Toytype profile] model ops', result);
      if (result && typeof console.table === 'function') debugTable(result.steps || []);
      if (result) debugLog('[Toytype profile model ops json]', JSON.stringify(result));
      return result;
    });
  }

  function probeFindReplaceFromContent(options) {
    return requestDocsModel('probeFindReplace', Object.assign({ docId: getDocId(), timeoutMs: 30000 }, options || {})).then(res => {
      if (!res || !res.ok) throw new Error(res && res.errorMessage ? res.errorMessage : 'probeFindReplace failed');
      const result = res.result;
      debugLog('[Toytype probe/content] find/replace result', result);
      if (result && typeof console.table === 'function') debugTable(result.topCandidates || []);
      if (result) debugLog('[Toytype probe/content json]', JSON.stringify(result));
      return result;
    });
  }

  function probeFindReplaceInteractionFromContent(options) {
    const opts = Object.assign({ durationMs: 15000 }, options || {});
    const timeoutMs = Math.min(75000, Math.max(2000, Number(opts.durationMs || 15000) + 5000));
    return requestDocsModel('probeFindReplaceInteraction', Object.assign({ timeoutMs }, opts)).then(res => {
      if (!res || !res.ok) throw new Error(res && res.errorMessage ? res.errorMessage : 'probeFindReplaceInteraction failed');
      const result = res.result;
      debugLog('[Toytype probe/content] find/replace interaction result', result);
      if (result && typeof console.table === 'function') {
        debugTable(result.topEvents || []);
        debugTable(result.topMutations || []);
      }
      if (result) debugLog('[Toytype probe/content interaction json]', JSON.stringify(result));
      return result;
    });
  }

  function runDocsFindActionFromContent(id, options) {
    return requestDocsModel('runKnownFindAction', Object.assign({
      id: id || 'docs-find-and-replace-start',
      timeoutMs: 5000
    }, options || {})).then(res => {
      if (!res || !res.ok) throw new Error(res && res.errorMessage ? res.errorMessage : 'runKnownFindAction failed');
      const result = res.result;
      debugLog('[Toytype probe/content] run docs find action result', result);
      if (result) debugLog('[Toytype probe/content run action json]', JSON.stringify(result));
      return result;
    });
  }

  function probeFindReplaceUiFromContent(options) {
    return requestDocsModel('probeFindReplaceUi', Object.assign({
      timeoutMs: 8000
    }, options || {})).then(res => {
      if (!res || !res.ok) throw new Error(res && res.errorMessage ? res.errorMessage : 'probeFindReplaceUi failed');
      const result = res.result;
      debugLog('[Toytype probe/content] find/replace UI result', result);
      if (result && typeof console.table === 'function') debugTable(result.candidates || []);
      if (result) debugLog('[Toytype probe/content ui json]', JSON.stringify(result));
      return result;
    });
  }

  function prepareFindReplaceUiFromContent(findText, replaceText, options) {
    return requestDocsModel('prepareFindReplaceUi', Object.assign({
      findText,
      replaceText,
      timeoutMs: 10000
    }, options || {})).then(res => {
      if (!res || !res.ok) throw new Error(res && res.errorMessage ? res.errorMessage : 'prepareFindReplaceUi failed');
      const result = res.result;
      debugLog('[Toytype probe/content] prepare find/replace UI result', result);
      if (result) debugLog('[Toytype probe/content prepare ui json]', JSON.stringify(result));
      return result;
    });
  }

  function clickFindReplaceButtonFromContent(mode, options) {
    return requestDocsModel('clickFindReplaceButton', Object.assign({
      mode: mode || 'replace',
      timeoutMs: 8000
    }, options || {})).then(res => {
      if (!res || !res.ok) throw new Error(res && res.errorMessage ? res.errorMessage : 'clickFindReplaceButton failed');
      const result = res.result;
      debugLog('[Toytype probe/content] click find/replace button result', result);
      if (result) debugLog('[Toytype probe/content click button json]', JSON.stringify(result));
      return result;
    });
  }

  function applyFindReplaceOnceFromContent(findText, replaceText, options) {
    return requestDocsModel('applyFindReplaceOnce', Object.assign({
      findText,
      replaceText,
      timeoutMs: 15000
    }, options || {})).then(res => {
      if (!res || !res.ok) throw docsModelError('applyFindReplaceOnce failed', res);
      const result = res.result;
      debugLog('[Toytype probe/content] apply find/replace once result', result);
      if (result) debugLog('[Toytype probe/content apply once json]', JSON.stringify(result));
      return result;
    });
  }

  function applyInternalTextActionOnceFromContent(findText, replaceText, options) {
    return requestDocsModel('applyInternalTextActionOnce', Object.assign({
      findText,
      replaceText,
      timeoutMs: 15000
    }, options || {})).then(res => {
      if (!res || !res.ok) throw docsModelError('applyInternalTextActionOnce failed', res);
      const result = res.result;
      debugLog('[Toytype probe/content] apply internal text action result', result);
      if (result) debugLog('[Toytype probe/content apply internal text action json]', JSON.stringify(result));
      return result;
    });
  }

  function applyFindingAtIndexFromContent(index, options) {
    const resolved = resolveFindingAtIndex(index);
    return applyResolvedFindingFromContent(resolved, options);
  }

  function applyPreflightFindingFromContent(snapshot, options) {
    const opts = options || {};
    const refresh = opts.rescanBeforeApply !== false
      ? enqueueScan(true)
      : Promise.resolve(lastReport);
    return refresh.then(report => {
      if (!report || !report.ok || report.textSource !== 'model') {
        const error = new Error('fresh Google Docs model scan unavailable before apply');
        error.debug = {
          rescanBeforeApply: opts.rescanBeforeApply !== false,
          report: report ? {
            ok: !!report.ok,
            textSource: report.textSource || '',
            total: report.total
          } : null
        };
        throw error;
      }
      const targetSnapshot = mergePreflightSnapshotOptions(snapshot, opts);
      const resolved = resolvePreflightFinding(targetSnapshot);
      return applyResolvedFindingFromContent(resolved, opts);
    });
  }

  function applyCurrentFindingFromContent(options) {
    return resolveCurrentFinding(options).then(resolved => applyResolvedFindingFromContent(resolved, options));
  }

  function applyResolvedFindingFromContent(resolved, options) {
    const finding = resolved.finding;
    const payload = Object.assign({
      findText: finding.src,
      replaceText: finding.dst,
      start: finding.start,
      end: finding.end,
      docId: getDocId(),
      timeoutMs: 15000
    }, sanitizeApplyBridgeOptions(options));

    const applyFindReplace = () => requestDocsModel('applyFindReplaceOnce', payload).then(res => {
      if (!res || !res.ok) throw docsModelError('applyFindReplaceOnce failed', res);
      const result = res.result;
      const target = targetSummary(resolved);
      if (result && typeof result === 'object') result.target = target;
      debugLog('[Toytype probe/content] apply finding result', { target, finding, result });
      if (result) debugLog('[Toytype probe/content apply finding json]', JSON.stringify({ target, result }));
      if (result && result.verified && payload.rescan !== false) {
        enqueueScan(true, { quiet: true }); // 결과 반환을 막지 않는 백그라운드 재검사
      }
      return result;
    });

    if (payload.useInternalTextAction === false) return applyFindReplace();

    return requestDocsModel('applyInternalTextActionOnce', payload).then(res => {
      if (!res || !res.ok) throw docsModelError('applyInternalTextActionOnce failed', res);
      const result = res.result;
      const target = targetSummary(resolved);
      if (result && typeof result === 'object') result.target = target;
      debugLog('[Toytype probe/content] apply finding internal text action result', { target, finding, result });
      if (result) debugLog('[Toytype probe/content apply finding internal text action json]', JSON.stringify({ target, result }));
      if (result && result.verified && payload.rescan !== false) {
        enqueueScan(true, { quiet: true }); // 결과 반환을 막지 않는 백그라운드 재검사
      }
      return result;
    }).catch(error => {
      const canFallback = payload.useFindReplaceFallback === true && !shouldPreventApplyFallback(error);
      debugWarn(canFallback ? '[Toytype apply] internal text action fallback' : '[Toytype apply] internal text action failed', {
        finding,
        error: summarizeErrorForConsole(error),
        response: error && error.response !== undefined ? error.response : undefined,
        fallback: canFallback
      });
      if (!canFallback) throw error;
      return applyFindReplace();
    });
  }

  function mergePreflightSnapshotOptions(snapshot, options) {
    const target = snapshot && typeof snapshot === 'object' ? Object.assign({}, snapshot) : snapshot;
    const opts = options || {};
    const minScore = Number(opts.minPreflightMatchScore);
    if (target && Number.isFinite(minScore)) target.minPreflightMatchScore = minScore;
    return target;
  }

  function sanitizeApplyBridgeOptions(options) {
    const opts = options || {};
    const payload = {};
    const allowed = [
      'timeoutMs',
      'actionWaitMs',
      'actionPollMs',
      'primeFindMatch',
      'primeActionId',
      'primeWaitMs',
      'primePollMs',
      'primeAfterDelayMs',
      'requirePrimeFindMatch',
      'readyWaitMs',
      'mutationWaitMs',
      'mutationPollMs',
      'replaceStrategy',
      'fallbackToButton',
      'buttonWaitMs',
      'buttonPollMs',
      'deepActions',
      'actionKeyLimit',
      'actionSourceLimit',
      'verifyTargetSelection',
      'verifyPrimeSelection',
      'confirmMutation',
      'rescan',
      'useInternalTextAction',
      'useFindReplaceFallback',
      'internalTextActionId',
      'deferVerification',
      'knownBeforeText',
      'directSelectionSettleMs',
      'directSelectionPollMs',
      'directActionWaitMs',
      'directActionPollMs',
      'directTextEventFallback',
      'textEventInputTypes',
      'textEventProbeWaitMs',
      'textEventProbePollMs',
      'textEventQuickProbeMs',
      'directAfterDelayMs'
    ];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(opts, key)) payload[key] = opts[key];
    }
    return payload;
  }

  function diagnoseFindingAtIndexFromContent(index, options) {
    const resolved = resolveFindingAtIndex(index);
    return diagnoseResolvedFindingFromContent(resolved, options);
  }

  function diagnoseCurrentFindingFromContent(options) {
    return resolveCurrentFinding(options).then(resolved => diagnoseResolvedFindingFromContent(resolved, options));
  }

  function diagnoseResolvedFindingFromContent(resolved, options) {
    const i = resolved.index;
    const finding = resolved.finding;
    const opts = options || {};
    const payload = Object.assign({
      findText: finding.src,
      replaceText: finding.dst,
      start: finding.start,
      end: finding.end,
      docId: getDocId(),
      timeoutMs: 12000
    }, opts);

    return requestDocsModel('setSelection', {
      start: finding.start,
      end: finding.end,
      docId: getDocId(),
      timeoutMs: 5000
    }).then(selectionRes => {
      if (!selectionRes || !selectionRes.ok) throw docsModelError('setSelection failed', selectionRes);
      return requestDocsModel('prepareFindReplaceUi', payload).then(prepareRes => ({ selectionRes, prepareRes }));
    }).then(({ selectionRes, prepareRes }) => {
      if (!prepareRes || !prepareRes.ok) throw docsModelError('prepareFindReplaceUi failed', prepareRes);
      return requestDocsModel('getSelection', {
        docId: getDocId(),
        timeoutMs: 5000
      }).then(selectionAfterPrepareRes => {
        if (!selectionAfterPrepareRes || !selectionAfterPrepareRes.ok) {
          throw docsModelError('getSelection after prepare failed', selectionAfterPrepareRes);
        }
        return requestDocsModel('clickFindReplaceButton', {
          mode: 'replace',
          buttonWaitMs: opts.buttonWaitMs || 3000,
          buttonPollMs: opts.buttonPollMs,
          timeoutMs: opts.timeoutMs || 12000
        }).then(buttonRes => ({ selectionAfterPrepareRes, buttonRes }));
      }).then(({ selectionAfterPrepareRes, buttonRes }) => {
        if (!buttonRes || !buttonRes.ok) throw docsModelError('clickFindReplaceButton failed', buttonRes);
        const result = {
          index: i,
          target: targetSummary(resolved),
          finding: summarizeFindingForConsole(finding, i),
          findingSnapshot: snapshotFindingForApply(finding, i),
          preflight: summarizeApplyPreflight(prepareRes.result, buttonRes.result, selectionAfterPrepareRes.selection, finding),
          selection: selectionRes.selection || null,
          selectionAfterPrepare: selectionAfterPrepareRes.selection || null,
          prepare: prepareRes.result,
          action: prepareRes.result && prepareRes.result.afterProbe && prepareRes.result.afterProbe.knownFindActions || null,
          button: buttonRes.result,
          documentMutated: false
        };
        debugLog('[Toytype probe/content] diagnose finding result', result);
        debugLog('[Toytype probe/content diagnose finding json]', JSON.stringify(result));
        return result;
      });
    });
  }

  function summarizeApplyPreflight(prepareResult, buttonResult, selection, finding) {
    const actions = prepareResult && prepareResult.afterProbe && prepareResult.afterProbe.knownFindActions || [];
    const replaceAction = Array.isArray(actions)
      ? actions.find(action => action && action.id === 'docs-replace') || null
      : null;
    const fieldVerification = prepareResult && prepareResult.fieldVerification || null;
    const buttonWait = buttonResult && buttonResult.waitResult || null;
    const fieldsReady = !!(fieldVerification && fieldVerification.ok);
    const replaceActionKnown = !!(replaceAction && replaceAction.exists && replaceAction.executor && !replaceAction.error);
    const replaceActionReadyNow = !!(replaceActionKnown && replaceAction.enabled !== false);
    const replaceButtonReadyNow = !!(buttonWait && buttonWait.available);
    const targetSelection = summarizeTargetSelection(selection, finding);
    const canTryApply = fieldsReady && replaceActionKnown && targetSelection.ok;
    return {
      ready: canTryApply,
      readyNow: fieldsReady && replaceActionReadyNow && replaceButtonReadyNow,
      canTryApply,
      willNeedPrime: canTryApply && (!replaceActionReadyNow || !replaceButtonReadyNow),
      fieldsReady,
      targetSelectionReady: targetSelection.ok,
      targetSelection,
      replaceAction: replaceAction ? {
        exists: !!replaceAction.exists,
        executor: replaceAction.executor || '',
        enabled: replaceAction.enabled,
        visible: replaceAction.visible,
        error: replaceAction.error || ''
      } : null,
      replaceActionReadyNow,
      replaceButtonAvailable: replaceButtonReadyNow,
      fieldVerification
    };
  }

  function summarizeTargetSelection(selection, finding) {
    const first = Array.isArray(selection) && selection.length ? selection[0] : null;
    const start = first && Number(first.start);
    const end = first && Number(first.end);
    const expectedStart = finding && Number(finding.start);
    const expectedEnd = finding && Number(finding.end);
    const hasSelection = Number.isFinite(start) && Number.isFinite(end);
    const hasExpected = Number.isFinite(expectedStart) && Number.isFinite(expectedEnd);
    return {
      ok: hasSelection && hasExpected && start === expectedStart && end === expectedEnd,
      start: hasSelection ? start : null,
      end: hasSelection ? end : null,
      expectedStart: hasExpected ? expectedStart : null,
      expectedEnd: hasExpected ? expectedEnd : null
    };
  }

  function listFindingsFromContent(options) {
    const opts = options || {};
    if (!lastReport || !Array.isArray(lastReport.findings)) throw new Error('no current Toytype findings');
    const limit = Number.isFinite(Number(opts.limit)) ? Math.max(1, Math.min(500, Number(opts.limit))) : 100;
    const items = lastReport.findings.slice(0, limit).map((finding, index) => summarizeFindingForConsole(finding, index));
    const result = {
      count: lastReport.findings.length,
      shown: items.length,
      activeRulesSource,
      rulesSourceLabel,
      docId: getDocId(),
      items
    };
    debugLog('[Toytype probe/content] findings', result);
    if (typeof console.table === 'function') debugTable(items);
    debugLog('[Toytype probe/content findings json]', JSON.stringify(result));
    return result;
  }

  function fullDiagnoseCurrentFindingFromContent(options) {
    const opts = options || {};
    const list = listFindingsFromContent({ limit: opts.limit || 20 });
    return resolveCurrentFinding(opts).then(resolved => {
      return diagnoseResolvedFindingFromContent(resolved, opts).then(diagnosis => {
        const result = {
          docId: getDocId(),
          activeRulesSource,
          rulesSourceLabel,
          findings: {
            count: list.count,
            shown: list.shown,
            items: list.items
          },
          target: targetSummary(resolved),
          diagnosis
        };
        debugLog('[Toytype probe/content] full diagnose current finding result', result);
        if (typeof console.table === 'function') debugTable(list.items || []);
        debugLog('[Toytype probe/content full diagnose json]', JSON.stringify(result));
        return result;
      });
    });
  }

  function applyStateFromContent(options) {
    const opts = options || {};
    const result = {
      kind: 'toytype:apply-state',
      docId: getDocId(),
      status,
      activeRulesSource,
      rulesSourceLabel,
      textSource: lastReport ? lastReport.textSource : null,
      total: lastReport ? lastReport.total : null,
      selectedFindingKey,
      currentCursorOffset,
      selected: null,
      nearestCursor: null,
      current: null,
      errors: {}
    };

    const selected = resolveSelectedFinding();
    if (selected) {
      result.selected = {
        target: targetSummary(selected),
        finding: summarizeFindingForConsole(selected.finding, selected.index)
      };
    }

    return resolveCursorOffsetForConsole().then(offset => {
      result.currentCursorOffset = offset;
      result.nearestCursor = nearestCursorFindingSummary(offset, opts);
    }).catch(error => {
      result.errors.cursor = summarizeErrorForConsole(error);
    }).then(() => {
      return resolveCurrentFinding(opts).then(resolved => {
        result.current = {
          target: targetSummary(resolved),
          finding: summarizeFindingForConsole(resolved.finding, resolved.index)
        };
      }).catch(error => {
        result.errors.current = summarizeErrorForConsole(error);
      });
    }).then(() => {
      debugLog('[Toytype probe/content] apply state', result);
      debugLog('[Toytype probe/content apply state json]', JSON.stringify(result));
      return result;
    });
  }

  function resolveFindingAtIndex(index) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0) throw new Error('finding index must be a non-negative integer');
    if (!lastReport || !Array.isArray(lastReport.findings)) throw new Error('no current Toytype findings');
    const finding = lastReport.findings[i];
    if (!finding) throw new Error('finding not found at index ' + i);
    if (!finding.selectable || !Number.isFinite(finding.start) || !Number.isFinite(finding.end)) {
      throw new Error('finding is not backed by a Google Docs model range');
    }
    return { index: i, finding };
  }

  function resolvePreflightFinding(snapshot) {
    const target = snapshot && typeof snapshot === 'object' ? snapshot : null;
    if (!target) throw new Error('missing preflight finding snapshot');
    if (!lastReport || !Array.isArray(lastReport.findings)) throw new Error('no current Toytype findings');

    const byIndex = Number.isInteger(Number(target.index)) ? lastReport.findings[Number(target.index)] : null;
    if (byIndex && isSameFindingIdentity(target, byIndex)) {
      if (!byIndex.selectable || !Number.isFinite(byIndex.start) || !Number.isFinite(byIndex.end)) {
        throw new Error('preflight finding is no longer backed by a Google Docs model range');
      }
      return { index: Number(target.index), finding: byIndex, selector: 'preflight-index' };
    }

    const fresh = findFreshFinding(target, lastReport.findings);
    if (!fresh || !fresh.selectable || !Number.isFinite(fresh.start) || !Number.isFinite(fresh.end)) {
      const error = new Error('preflight finding is no longer available');
      error.debug = {
        target,
        count: lastReport.findings.length
      };
      throw error;
    }
    const index = lastReport.findings.indexOf(fresh);
    const score = findingMatchScore(target, fresh);
    const minScore = Number.isFinite(Number(target.minPreflightMatchScore)) ? Number(target.minPreflightMatchScore) : 600;
    if (score < minScore) {
      const error = new Error('preflight finding match is too weak');
      error.debug = {
        target,
        score,
        minScore,
        candidate: summarizeFindingForConsole(fresh, index)
      };
      throw error;
    }
    return { index, finding: fresh, selector: 'preflight-fresh', preflightMatchScore: score };
  }

  function isSameFindingIdentity(target, finding) {
    return finding &&
      target.src === finding.src &&
      target.dst === finding.dst &&
      target.cat === finding.cat &&
      Number(target.start) === Number(finding.start) &&
      Number(target.end) === Number(finding.end);
  }

  function resolveCurrentFinding(options) {
    const opts = options || {};
    if (opts.index !== undefined && opts.index !== null && Number.isInteger(Number(opts.index))) {
      return Promise.resolve(resolveFindingAtIndex(opts.index));
    }
    const selected = resolveSelectedFinding();
    if (selected) return Promise.resolve(selected);
    return resolveCursorFinding(opts);
  }

  function resolveSelectedFinding() {
    if (!lastReport || !Array.isArray(lastReport.findings) || selectedFindingKey === null) return null;
    for (let i = 0; i < lastReport.findings.length; i++) {
      const finding = lastReport.findings[i];
      if (isSelectedFinding(finding) && finding.selectable && Number.isFinite(finding.start) && Number.isFinite(finding.end)) {
        return { index: i, finding, selector: 'selected' };
      }
    }
    return null;
  }

  function resolveCursorFinding(options) {
    const opts = options || {};
    const maxDistance = opts.maxCursorDistance === false
      ? Infinity
      : (Number.isFinite(Number(opts.maxCursorDistance)) ? Math.max(0, Number(opts.maxCursorDistance)) : 200);
    return resolveCursorOffsetForConsole().then(offset => {
      if (!lastReport || !Array.isArray(lastReport.findings)) throw new Error('no current Toytype findings');
      const candidates = lastReport.findings
        .map((finding, index) => ({ finding, index, score: cursorFindingScore(finding, offset) }))
        .filter(item => Number.isFinite(item.score))
        .sort((a, b) => a.score - b.score || a.index - b.index);
      if (!candidates.length) throw new Error('no selectable finding near cursor');
      if (candidates[0].score > maxDistance) {
        const error = new Error('nearest finding is too far from cursor');
        error.debug = {
          cursorOffset: offset,
          maxCursorDistance: maxDistance,
          nearestDistance: candidates[0].score,
          nearest: summarizeFindingForConsole(candidates[0].finding, candidates[0].index)
        };
        throw error;
      }
      return {
        index: candidates[0].index,
        finding: candidates[0].finding,
        selector: 'cursor',
        cursorOffset: offset,
        cursorDistance: candidates[0].score
      };
    });
  }

  function resolveCursorOffsetForConsole() {
    if (Number.isFinite(currentCursorOffset)) return Promise.resolve(currentCursorOffset);
    return fetchDocsSelection().then(selection => {
      const first = Array.isArray(selection) && selection[0] ? selection[0] : null;
      const start = first && Number(first.start);
      const end = first && Number(first.end);
      if (Number.isFinite(start)) return start;
      if (Number.isFinite(end)) return end;
      throw new Error('current Google Docs cursor is unavailable');
    });
  }

  function cursorFindingScore(finding, offset) {
    if (!finding || !finding.selectable || !Number.isFinite(finding.start) || !Number.isFinite(finding.end)) return Infinity;
    if (offset >= finding.start && offset <= finding.end) return 0;
    return Math.min(Math.abs(offset - finding.start), Math.abs(offset - finding.end));
  }

  function nearestCursorFindingSummary(offset, options) {
    if (!lastReport || !Array.isArray(lastReport.findings) || !Number.isFinite(offset)) return null;
    const maxDistance = options && options.maxCursorDistance === false
      ? Infinity
      : (Number.isFinite(Number(options && options.maxCursorDistance)) ? Math.max(0, Number(options.maxCursorDistance)) : 200);
    const candidates = lastReport.findings
      .map((finding, index) => ({ finding, index, score: cursorFindingScore(finding, offset) }))
      .filter(item => Number.isFinite(item.score))
      .sort((a, b) => a.score - b.score || a.index - b.index);
    if (!candidates.length) return null;
    const nearest = candidates[0];
    return {
      target: targetSummary({
        index: nearest.index,
        finding: nearest.finding,
        selector: 'cursor',
        cursorOffset: offset,
        cursorDistance: nearest.score
      }),
      finding: summarizeFindingForConsole(nearest.finding, nearest.index),
      withinMaxDistance: nearest.score <= maxDistance,
      maxCursorDistance: maxDistance === Infinity ? false : maxDistance
    };
  }

  function summarizeErrorForConsole(error) {
    return {
      name: error && error.name ? error.name : '',
      message: error && error.message ? String(error.message).slice(0, 500) : String(error).slice(0, 500),
      debug: error && error.debug !== undefined ? error.debug : undefined
    };
  }

  function summarizeFindingForConsole(finding, index) {
    return {
      index,
      cat: finding.cat,
      line: finding.line,
      start: finding.start,
      end: finding.end,
      selectable: !!finding.selectable,
      src: finding.src,
      dst: finding.dst,
      before: finding.before,
      after: finding.after
    };
  }

  function snapshotFindingForApply(finding, index) {
    return {
      index,
      cat: finding.cat,
      idx: finding.idx,
      line: finding.line,
      textLine: finding.textLine,
      start: finding.start,
      end: finding.end,
      selectable: !!finding.selectable,
      src: finding.src,
      dst: finding.dst,
      before: finding.before,
      after: finding.after,
      contextBefore: finding.contextBefore,
      contextAfter: finding.contextAfter,
      minPreflightMatchScore: 600
    };
  }

  function targetSummary(resolved) {
    return {
      index: resolved.index,
      selector: resolved.selector || 'index',
      cursorOffset: Number.isFinite(resolved.cursorOffset) ? resolved.cursorOffset : null,
      cursorDistance: Number.isFinite(resolved.cursorDistance) ? resolved.cursorDistance : null
    };
  }

  function handlePageProbeCommand(data) {
    if (!data || data.kind !== 'toytype:content-command-request') return false;
    if (data.action !== 'applyFindingAtIndex' &&
        data.action !== 'applyPreflightFinding' &&
        data.action !== 'applyCurrentFinding' &&
        data.action !== 'diagnoseFindingAtIndex' &&
        data.action !== 'diagnoseCurrentFinding' &&
        data.action !== 'fullDiagnoseCurrentFinding' &&
        data.action !== 'getApplyState' &&
        data.action !== 'listFindings') return false;
    Promise.resolve().then(() => {
      if (data.action === 'applyFindingAtIndex') return applyFindingAtIndexFromContent(data.index, data.options || {});
      if (data.action === 'applyPreflightFinding') return applyPreflightFindingFromContent(data.findingSnapshot, data.options || {});
      if (data.action === 'applyCurrentFinding') return applyCurrentFindingFromContent(data.options || {});
      if (data.action === 'diagnoseFindingAtIndex') return diagnoseFindingAtIndexFromContent(data.index, data.options || {});
      if (data.action === 'diagnoseCurrentFinding') return diagnoseCurrentFindingFromContent(data.options || {});
      if (data.action === 'fullDiagnoseCurrentFinding') return fullDiagnoseCurrentFindingFromContent(data.options || {});
      if (data.action === 'getApplyState') return applyStateFromContent(data.options || {});
      return listFindingsFromContent(data.options || {});
    }).then(result => {
      window.postMessage({
        kind: 'toytype:content-command-response',
        requestId: data.requestId,
        action: data.action,
        ok: true,
        result
      }, '*');
    }).catch(error => {
      window.postMessage({
        kind: 'toytype:content-command-response',
        requestId: data.requestId,
        action: data.action,
        ok: false,
        errorName: error && error.name ? error.name : '',
        errorMessage: error && error.message ? String(error.message).slice(0, 500) : String(error).slice(0, 500),
        debug: error && error.debug !== undefined ? error.debug : undefined,
        response: error && error.response !== undefined ? error.response : undefined
      }, '*');
    });
    return true;
  }

  function docsModelError(fallbackMessage, response) {
    const error = new Error(response && response.errorMessage ? response.errorMessage : fallbackMessage);
    if (response && response.errorName) error.name = response.errorName;
    if (response && response.debug !== undefined) error.debug = response.debug;
    if (response !== undefined) error.response = response;
    return error;
  }

  function shouldPreventApplyFallback(error) {
    if (!error) return false;
    if (error.preventFallback === true) return true;
    const response = error.response;
    if (response && response.preventFallback === true) return true;
    const debug = response && response.debug || error.debug;
    return !!(debug && (debug.preventFallback === true || debug.documentMutated === true));
  }

  function injectPageBridgeScript() {
    if (pageBridgeInjected) return;
    pageBridgeInjected = true;
    pageBridgeInjectAttempts++;
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('content/docs-page-bridge.js');
    script.async = false;
    script.onload = () => {
      pageBridgeLoadAt = Date.now();
      script.remove();
    };
    script.onerror = () => {
      pageBridgeInjected = false;
      pageBridgeErrorAt = Date.now();
    };
    (document.documentElement || document.head || document.body).appendChild(script);
  }

  function markPageBridgeReady() {
    pageBridgeReady = true;
    pageBridgeReadyAt = Date.now();
  }

  function pageBridgeStatus() {
    return {
      injected: pageBridgeInjected,
      ready: pageBridgeReady,
      injectAttempts: pageBridgeInjectAttempts,
      loadAt: pageBridgeLoadAt,
      readyAt: pageBridgeReadyAt,
      errorAt: pageBridgeErrorAt,
      sinceLoadMs: pageBridgeLoadAt ? Date.now() - pageBridgeLoadAt : null,
      sinceReadyMs: pageBridgeReadyAt ? Date.now() - pageBridgeReadyAt : null,
      docId: getDocId()
    };
  }

  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(t).catch(() => copyFallback(t));
    }
    return copyFallback(t);
  }

  function copyFallback(t) {
    return new Promise((resolve, reject) => {
      if (!shadowRoot) {
        reject(new Error('no shadow root'));
        return;
      }
      // 임시 textarea도 페이지 DOM이 아닌 shadow root 안에만 둔다 (무수정 invariant)
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.style.cssText = 'position:absolute;left:-9999px;opacity:0;';
      shadowRoot.appendChild(ta);
      ta.focus();
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { /* 아래에서 reject */ }
      ta.remove();
      ok ? resolve() : reject(new Error('copy failed'));
    });
  }

  function showToast(text, options) {
    if (!shadowRoot) return;
    const toast = shadowRoot.getElementById('trd-toast');
    if (!toast) return;
    const opts = options && typeof options === 'object' ? options : {};
    toast.textContent = text;
    toast.classList.add('trd-show');
    clearTimeout(toastTimer);
    if (opts.persist === true) return;
    const durationMs = Number.isFinite(Number(opts.durationMs)) ? Math.max(500, Number(opts.durationMs)) : 1500;
    toastTimer = setTimeout(() => toast.classList.remove('trd-show'), durationMs);
  }

  // ---------- 상태 전환 ----------

  function applyDisabled() {
    status = 'disabled';
    errorCode = null;
    lastReport = null;
    removePanel();
    sendCount(0);
  }

  async function handleRescan() {
    settings = await readSettings(); // 재스캔 전 설정 fresh 재독
    if (isOriginDisabled()) {
      applyDisabled();
      return disabledReport();
    }
    if (status === 'disabled') status = 'init'; // 재활성화
    if (!getDocId()) return notReadyResponse();
    if (!rulesJson) {
      const ok = await loadRules();
      if (!ok) {
        status = 'error';
        errorCode = 'rules_load_failed';
        await injectPanel();
        render();
        sendCount(0);
        return errorResponse();
      }
    }
    await injectPanel();
    await loadCachedGeneratedRulesList();
    injectPageBridgeScript();
    refreshGeneratedRulesListQuiet();
    return enqueueScan(true);
  }

  async function onSettingsChanged() {
    settings = await readSettings();
    if (isOriginDisabled()) {
      if (status !== 'disabled') applyDisabled();
      return;
    }
    if (status === 'disabled') {
      // 재활성화
      status = 'init';
      if (!getDocId()) return;
      if (!rulesJson) {
        const ok = await loadRules();
        if (!ok) {
          status = 'error';
          errorCode = 'rules_load_failed';
          await injectPanel();
          render();
          sendCount(0);
          return;
        }
      }
      await injectPanel();
      await loadCachedGeneratedRulesList();
      injectPageBridgeScript();
      refreshGeneratedRulesListQuiet();
      enqueueScan(cachedText === null); // 캐시 없으면 fetch 허용
      return;
    }
    // 설정 변경 — 캐시 텍스트 재스캔 (fetch 없음)
    if (cachedText !== null) {
      enqueueScan(false);
    } else {
      try { initEngine(); } catch (e) { /* 다음 스캔에서 처리 */ }
      render();
    }
  }

  // ---------- 초기화 ----------

  async function init() {
    settings = await readSettings();
    if (isOriginDisabled()) {
      status = 'disabled';
      sendCount(0);
      return; // storage.onChanged는 계속 청취
    }
    if (!getDocId()) return; // 새 문서 작성 화면 등 — 비활성 대기 (rescan 시 재시도)
    const ok = await loadRules();
    if (!ok) {
      status = 'error';
      errorCode = 'rules_load_failed';
      await injectPanel();
      sendCount(0);
      return;
    }
    try {
      initEngine();
    } catch (e) {
      status = 'error';
      errorCode = 'rules_load_failed';
      await injectPanel();
      sendCount(0);
      return;
    }
    await injectPanel();
    await loadCachedGeneratedRulesList();
    injectPageBridgeScript();
    refreshGeneratedRulesListQuiet();
    // document_idle + 3000ms 후 1회 자동 스캔. 이후 자동 폴링 없음.
    const delay = Math.max(0, 3000 - (Date.now() - startedAt));
    setTimeout(() => { enqueueScan(true); }, delay);
  }

  // ---------- 리스너 (스크립트 최상위에서 동기 등록) ----------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'typo:get') {
      if (status === 'disabled') sendResponse(disabledReport());
      else if (lastReport) sendResponse(lastReport);
      else if (status === 'error') sendResponse(errorResponse());
      else sendResponse(notReadyResponse());
      return;
    }
    if (msg.type === 'typo:rescan') {
      handleRescan().then(sendResponse, () => {
        sendResponse(Object.assign({ ok: false, error: 'internal', disabled: false }, baseFields()));
      });
      return true; // 비동기 응답
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => { onSettingsChanged(); }, 300);
  });

  window.addEventListener('message', event => {
    if (event.source !== window || !event.data) return;
    if (event.data.kind === 'typo-radar:page-bridge-ready') {
      markPageBridgeReady();
      return;
    }
    if (event.data.kind === 'typo-radar:apply-verify-result') {
      handleApplyVerifyResult(event.data);
      return;
    }
    handlePageProbeCommand(event.data);
  });

  window.ToytypeProfileModelOpsFromContent = profileModelOpsFromContent;
  window.ToytypeProbeFindReplaceFromContent = probeFindReplaceFromContent;
  window.ToytypeProbeFindReplaceInteractionFromContent = probeFindReplaceInteractionFromContent;
  window.ToytypeRunDocsFindActionFromContent = runDocsFindActionFromContent;
  window.ToytypeProbeFindReplaceUiFromContent = probeFindReplaceUiFromContent;
  window.ToytypePrepareFindReplaceUiFromContent = prepareFindReplaceUiFromContent;
  window.ToytypeClickFindReplaceButtonFromContent = clickFindReplaceButtonFromContent;
  window.ToytypeApplyFindReplaceOnceFromContent = applyFindReplaceOnceFromContent;
  window.ToytypeApplyInternalTextActionOnceFromContent = applyInternalTextActionOnceFromContent;
  window.ToytypeApplyFindingAtIndexFromContent = applyFindingAtIndexFromContent;
  window.ToytypeApplyCurrentFindingFromContent = applyCurrentFindingFromContent;
  window.ToytypeDiagnoseFindingAtIndexFromContent = diagnoseFindingAtIndexFromContent;
  window.ToytypeDiagnoseCurrentFindingFromContent = diagnoseCurrentFindingFromContent;
  window.ToytypeFullDiagnoseCurrentFindingFromContent = fullDiagnoseCurrentFindingFromContent;
  window.ToytypePreflightCurrentFindingFromContent = fullDiagnoseCurrentFindingFromContent;
  window.ToytypeApplyStateFromContent = applyStateFromContent;
  window.ToytypeListFindingsFromContent = listFindingsFromContent;
  window.ToytypeBridgeStatusFromContent = pageBridgeStatus;

  init();
})();
