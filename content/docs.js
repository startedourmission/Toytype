// Toytype — 구글 독스 어댑터
// 검사는 본문을 수정하지 않는다. 사용자가 항목을 클릭하면 Google Docs 위치 선택과 교정어 복사만 시도한다.
// 항목의 적용 버튼은 사용자가 직접 누를 때만 Google Docs 내부 찾기/바꾸기로 문서를 수정한다.
'use strict';
(() => {
  const DEFAULT_SETTINGS = {
    schemaVersion: 1,
    docsCategories:    { convert: true, spelling: true, plural: true,  honorific: true,  space1: true,  space2: true,  space3: true,  final: true  },
    genericCategories: { convert: true, spelling: true, plural: false, honorific: false, space1: false, space2: false, space3: false, final: false },
    disabledOrigins:   []
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
  const CURSOR_POLL_INTERVAL = 800;
  const FALLBACK_CSS =
    '.trd-wrap{font-family:sans-serif;font-size:13px;color:#202124;line-height:1.45}' +
    '.trd-bubble{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.3)}' +
    '.trd-bubble.trd-alert{background:#d93025}.trd-bubble.trd-idle{background:#5f6368}' +
    '.trd-panel{position:relative;width:320px;max-height:65vh;display:flex;flex-direction:column;background:#fff;border:1px solid #dadce0;border-radius:10px;overflow:hidden}' +
    '.trd-head{display:flex;gap:6px;align-items:center;padding:10px 12px;border-bottom:1px solid #e0e0e0}.trd-btn{flex:none;font-size:12px;padding:4px 9px;cursor:pointer}.trd-icon-btn{width:28px;height:28px;padding:0;font-size:17px;line-height:1}.trd-svg-icon{width:14px;height:14px;display:block;margin:auto}.trd-close-icon{width:15px;height:15px;display:block;margin:auto}.trd-select{flex:1;min-width:64px;height:28px;border:1px solid #dadce0;border-radius:6px;background:#fff;color:#202124;font:inherit;font-size:12px;padding:0 5px}.trd-view-toggle{flex:none;display:flex;height:28px;border:1px solid #dadce0;border-radius:6px;overflow:hidden;background:#fff}.trd-view-btn{width:28px;height:26px;border:0;border-right:1px solid #dadce0;background:#fff;color:#5f6368;display:flex;align-items:center;justify-content:center;cursor:pointer}.trd-view-btn:last-child{border-right:0}.trd-view-btn.trd-active{background:#e8f0fe;color:#174ea6}.trd-view-icon{width:15px;height:15px;display:block}.trd-file{display:none}.trd-body{flex:1;min-height:0;overflow-y:auto}' +
    '.trd-msg{padding:16px 12px;color:#5f6368}.trd-item{position:relative;padding:8px 44px 9px 18px;border-top:1px solid #f1f3f4;cursor:pointer}.trd-item.trd-selected{background:#e8f0fe;box-shadow:inset 3px 0 0 #1a73e8}.trd-apply-btn{position:absolute;right:10px;top:10px;width:24px;height:24px;border:1px solid #dadce0;border-radius:6px;background:#fff;color:#1a73e8;display:flex;align-items:center;justify-content:center;cursor:pointer}.trd-apply-btn:disabled{opacity:.5;cursor:default}.trd-apply-icon{width:14px;height:14px;display:block}' +
    '.trd-cursor-marker{height:0;border-top:2px solid #1a73e8;margin:2px 0;position:relative}.trd-cursor-marker:before{content:"";position:absolute;left:12px;top:-4px;width:6px;height:6px;border-radius:50%;background:#1a73e8}' +
    '.trd-hit{font-weight:700;color:#d93025}.trd-ctx,.trd-fix{font-size:12px}.trd-line{color:#80868b;margin-left:6px}' +
    '.trd-foot{padding:8px 12px;font-size:11px;color:#80868b;border-top:1px solid #e0e0e0}' +
    '.trd-toast{position:absolute;left:50%;bottom:52px;transform:translateX(-50%);background:#202124;color:#fff;padding:6px 12px;border-radius:16px;font-size:12px;opacity:0;transition:opacity .15s}.trd-toast.trd-show{opacity:1}' +
    '.trd-notice{padding:6px 12px;font-size:12px;background:#fef7e0;color:#b06000}';

  const startedAt = Date.now();

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
  let currentCursorOffset = null;
  let cursorPollTimer = null;
  let cursorPollBusy = false;
  let applyingFindingKey = null;

  let host = null;
  let shadowRoot = null;
  let shadowView = null;
  let panelCss = null;
  let expanded = false; // 펼침 상태는 메모리만 (미저장)
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
      disabledOrigins: Array.isArray(s.disabledOrigins) ? s.disabledOrigins : []
    };
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
            useRulesSource(activeRulesSource === 'uploaded' && uploadedRulesJson ? 'uploaded' : 'builtin');
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
    } else {
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
      }
    }
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
    return out;
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
    if (docId !== currentDocId) {
      // SPA 문서 전환 — 캐시 무효화 후 재초기화
      currentDocId = docId;
      cachedText = null;
      cachedTextSource = null;
      lastFetchAt = 0;
      lastModelAt = 0;
      selectedFindingKey = null;
      currentCursorOffset = null;
    }
    // quiet: 적용 파이프라인 내부 재스캔 — 목록을 '검사 중…'으로 비우지 않고
    // 기존 패널을 유지한 채 결과만 갱신한다 (불필요한 전체 리렌더 2회 제거).
    if (!(scanOpts && scanOpts.quiet)) {
      status = 'scanning';
      render();
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
          render();
          return errorResponse();
        }
      } else if (cachedText !== null) {
        text = cachedText;
        textSource = cachedTextSource || 'cache';
        cached = true;
      } else {
        status = 'init';
        render();
        return notReadyResponse();
      }
    }

    try {
      initEngine();
    } catch (e) {
      status = 'error';
      errorCode = 'rules_load_failed';
      sendCount(0);
      render();
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
      render();
      return errorResponse();
    }

    const buildStartedAt = Date.now();
    const findings = buildUIFindings(text, result.findings, textSource);
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
    render();
    perf.renderMs = Date.now() - renderStartedAt;
    perf.textSource = textSource;
    perf.textLength = text.length;
    perf.totalMs = Date.now() - perfStartedAt;
    lastReport.perf = perf;
    console.info('[Toytype perf] scan', JSON.stringify(Object.assign({ total: findings.length, cached }, perf)));
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
    clearTimeout(toastTimer);
    clearTimeout(cooldownTimer);
    stopCursorWatcher();
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

  function applyIcon() {
    return strokedSvg(['M20 6L9 17l-5-5'], 'trd-apply-icon');
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

  function render() {
    if (!shadowView) return;
    shadowView.textContent = '';
    shadowView.appendChild(expanded ? buildPanel() : buildBubble());
    syncCursorWatcher();
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
    if (status === 'error') {
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
        det.open = true;
        const sum = document.createElement('summary');
        sum.textContent = labelOf(id) + ' (' + items.length + ')';
        det.appendChild(sum);
        for (const f of items) det.appendChild(buildItem(f));
        body.appendChild(det);
      }
    }
    panel.appendChild(body);

    // 푸터
    const foot = el('div', 'trd-foot');
    const l1 = document.createElement('div');
    const sourceLabel = lastReport && lastReport.textSource === 'model' ? '문서 모델 기준' : '저장 스냅샷 기준';
    l1.textContent = '검사만으로는 수정하지 않습니다 · ' + sourceLabel;
    const ver = (lastReport && lastReport.rulesVersion) || (rulesJson && rulesJson.version) || '-';
    const when = lastReport && lastReport.scannedAt ? timeStr(lastReport.scannedAt) : '-';
    const l2 = document.createElement('div');
    const ruleSource = activeRulesSource === 'uploaded' ? 'JSON ' + (rulesSourceLabel || 'uploaded.json') : 'rules.json';
    l2.textContent = ruleSource + ' · 버전 ' + ver + ' · 마지막 검사 ' + when;
    foot.append(l1, l2);
    panel.appendChild(foot);

    const toast = el('div', 'trd-toast');
    toast.id = 'trd-toast';
    panel.appendChild(toast);
    return panel;
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
    if (uploadedRulesJson) {
      const uploadedOption = document.createElement('option');
      uploadedOption.value = 'uploaded';
      uploadedOption.textContent = 'JSON' + rulesVersionSuffix(uploadedRulesJson);
      uploadedOption.title = uploadedRulesLabel || 'uploaded.json';
      select.appendChild(uploadedOption);
    }
    select.value = activeRulesSource;
    select.addEventListener('click', ev => {
      ev.stopPropagation();
    });
    select.addEventListener('change', () => {
      handleRulesSourceChange(select.value);
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
    showToast(activeRulesSource === 'uploaded' ? 'JSON 기준으로 검사' : 'rules.json 기준으로 검사');
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
    if (cursorPollBusy || applyingFindingKey !== null) return;
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

  function buildItem(f) {
    const item = el('div', 'trd-item');
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
    fix.textContent = displayText(f.src) + ' → ' + displayText(f.dst);
    const ln = el('span', 'trd-line');
    ln.textContent = '¶' + f.line + (listMode === 'order' ? ' · ' + labelOf(f.cat) : '');
    fix.appendChild(ln);

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

    item.append(ctx, fix, applyBtn);
    item.addEventListener('click', () => {
      handleFindingClick(f);
    });
    return item;
  }

  function handleFindingClick(f) {
    if (!f.selectable || !Number.isFinite(f.start) || !Number.isFinite(f.end)) {
      fallbackFindingClick(f);
      return;
    }
    enqueueScan(true).then(report => {
      const fresh = report && report.ok && Array.isArray(report.findings)
        ? findFreshFinding(f, report.findings)
        : null;
      if (!fresh || !fresh.selectable || !Number.isFinite(fresh.start) || !Number.isFinite(fresh.end)) {
        fallbackFindingClick(f);
        return;
      }
      selectedFindingKey = findingKey(fresh);
      render();
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
      if (applied && appliedFresh) removeAppliedFindingOptimistically(appliedFresh);
      const timings = {
        totalMs: Date.now() - applyStartedAt,
        preScanMs: preScanDoneAt === null ? null : preScanDoneAt - applyStartedAt,
        applyMs: preScanDoneAt === null ? null : Date.now() - preScanDoneAt
      };
      console.info('[Toytype apply] item apply result', {
        finding: f,
        result,
        timings
      });
      console.info('[Toytype apply timings]', JSON.stringify(Object.assign({}, timings, {
        bridge: result && result.phaseTimings ? result.phaseTimings : null,
        actionWait: result && result.actionResult && result.actionResult.waitResult ? result.actionResult.waitResult : null,
        verifyDeferred: !!(result && result.verificationDeferred),
        beforeTextSource: result && result.beforeTextSource ? result.beforeTextSource : null,
        actionId: result && result.actionResult && result.actionResult.actionId ? result.actionResult.actionId : null
      })));
      if (result) console.info('[Toytype apply item json]', JSON.stringify({ finding: f, result, timings }));
    }).catch(error => {
      console.warn('[Toytype apply] item apply failed', {
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
    console.info('[Toytype apply] deferred verification', {
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
    }).catch(() => {
      showToast('JSON 업로드 실패');
    });
  }

  function fallbackFindingClick(f) {
    const term = searchTermForFinding(f);
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
      console.info('[Toytype profile] model ops', result);
      if (result && typeof console.table === 'function') console.table(result.steps || []);
      if (result) console.info('[Toytype profile model ops json]', JSON.stringify(result));
      return result;
    });
  }

  function probeFindReplaceFromContent(options) {
    return requestDocsModel('probeFindReplace', Object.assign({ docId: getDocId(), timeoutMs: 30000 }, options || {})).then(res => {
      if (!res || !res.ok) throw new Error(res && res.errorMessage ? res.errorMessage : 'probeFindReplace failed');
      const result = res.result;
      console.info('[Toytype probe/content] find/replace result', result);
      if (result && typeof console.table === 'function') console.table(result.topCandidates || []);
      if (result) console.info('[Toytype probe/content json]', JSON.stringify(result));
      return result;
    });
  }

  function probeFindReplaceInteractionFromContent(options) {
    const opts = Object.assign({ durationMs: 15000 }, options || {});
    const timeoutMs = Math.min(75000, Math.max(2000, Number(opts.durationMs || 15000) + 5000));
    return requestDocsModel('probeFindReplaceInteraction', Object.assign({ timeoutMs }, opts)).then(res => {
      if (!res || !res.ok) throw new Error(res && res.errorMessage ? res.errorMessage : 'probeFindReplaceInteraction failed');
      const result = res.result;
      console.info('[Toytype probe/content] find/replace interaction result', result);
      if (result && typeof console.table === 'function') {
        console.table(result.topEvents || []);
        console.table(result.topMutations || []);
      }
      if (result) console.info('[Toytype probe/content interaction json]', JSON.stringify(result));
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
      console.info('[Toytype probe/content] run docs find action result', result);
      if (result) console.info('[Toytype probe/content run action json]', JSON.stringify(result));
      return result;
    });
  }

  function probeFindReplaceUiFromContent(options) {
    return requestDocsModel('probeFindReplaceUi', Object.assign({
      timeoutMs: 8000
    }, options || {})).then(res => {
      if (!res || !res.ok) throw new Error(res && res.errorMessage ? res.errorMessage : 'probeFindReplaceUi failed');
      const result = res.result;
      console.info('[Toytype probe/content] find/replace UI result', result);
      if (result && typeof console.table === 'function') console.table(result.candidates || []);
      if (result) console.info('[Toytype probe/content ui json]', JSON.stringify(result));
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
      console.info('[Toytype probe/content] prepare find/replace UI result', result);
      if (result) console.info('[Toytype probe/content prepare ui json]', JSON.stringify(result));
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
      console.info('[Toytype probe/content] click find/replace button result', result);
      if (result) console.info('[Toytype probe/content click button json]', JSON.stringify(result));
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
      console.info('[Toytype probe/content] apply find/replace once result', result);
      if (result) console.info('[Toytype probe/content apply once json]', JSON.stringify(result));
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
      console.info('[Toytype probe/content] apply internal text action result', result);
      if (result) console.info('[Toytype probe/content apply internal text action json]', JSON.stringify(result));
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
      console.info('[Toytype probe/content] apply finding result', { target, finding, result });
      if (result) console.info('[Toytype probe/content apply finding json]', JSON.stringify({ target, result }));
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
      console.info('[Toytype probe/content] apply finding internal text action result', { target, finding, result });
      if (result) console.info('[Toytype probe/content apply finding internal text action json]', JSON.stringify({ target, result }));
      if (result && result.verified && payload.rescan !== false) {
        enqueueScan(true, { quiet: true }); // 결과 반환을 막지 않는 백그라운드 재검사
      }
      return result;
    }).catch(error => {
      const canFallback = payload.useFindReplaceFallback === true && !shouldPreventApplyFallback(error);
      console.warn(canFallback ? '[Toytype apply] internal text action fallback' : '[Toytype apply] internal text action failed', {
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
        console.info('[Toytype probe/content] diagnose finding result', result);
        console.info('[Toytype probe/content diagnose finding json]', JSON.stringify(result));
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
    console.info('[Toytype probe/content] findings', result);
    if (typeof console.table === 'function') console.table(items);
    console.info('[Toytype probe/content findings json]', JSON.stringify(result));
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
        console.info('[Toytype probe/content] full diagnose current finding result', result);
        if (typeof console.table === 'function') console.table(list.items || []);
        console.info('[Toytype probe/content full diagnose json]', JSON.stringify(result));
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
      console.info('[Toytype probe/content] apply state', result);
      console.info('[Toytype probe/content apply state json]', JSON.stringify(result));
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

  function showToast(text) {
    if (!shadowRoot) return;
    const toast = shadowRoot.getElementById('trd-toast');
    if (!toast) return;
    toast.textContent = text;
    toast.classList.add('trd-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('trd-show'), 1500);
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
    injectPageBridgeScript();
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
      injectPageBridgeScript();
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
    injectPageBridgeScript();
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
