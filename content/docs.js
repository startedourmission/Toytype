// Toytype — 구글 독스 어댑터
// 검사는 본문을 수정하지 않는다. 사용자가 누른 "적용" 버튼만 Google Docs 선택 영역 교체를 시도한다.
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
  const FALLBACK_CSS =
    '.trd-wrap{font-family:sans-serif;font-size:13px;color:#202124;line-height:1.45}' +
    '.trd-bubble{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.3)}' +
    '.trd-bubble.trd-alert{background:#d93025}.trd-bubble.trd-idle{background:#5f6368}' +
    '.trd-panel{position:relative;width:320px;max-height:65vh;display:flex;flex-direction:column;background:#fff;border:1px solid #dadce0;border-radius:10px;overflow:hidden}' +
    '.trd-head{display:flex;gap:6px;align-items:center;padding:10px 12px;border-bottom:1px solid #e0e0e0}.trd-title{flex:1;font-weight:700}' +
    '.trd-head .trd-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.trd-btn{flex:none;font-size:12px;padding:4px 9px;cursor:pointer}.trd-file{display:none}.trd-body{flex:1;min-height:0;overflow-y:auto}' +
    '.trd-msg{padding:16px 12px;color:#5f6368}.trd-item{padding:8px 12px;border-top:1px solid #f1f3f4;cursor:pointer}' +
    '.trd-hit{font-weight:700;color:#d93025}.trd-ctx,.trd-fix,.trd-action{font-size:12px}.trd-action{margin-top:3px;color:#5f6368}.trd-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:5px}.trd-apply{padding:2px 8px}.trd-line{color:#80868b;margin-left:6px}' +
    '.trd-foot{padding:8px 12px;font-size:11px;color:#80868b;border-top:1px solid #e0e0e0}' +
    '.trd-toast{position:absolute;left:50%;bottom:52px;transform:translateX(-50%);background:#202124;color:#fff;padding:6px 12px;border-radius:16px;font-size:12px;opacity:0;transition:opacity .15s}.trd-toast.trd-show{opacity:1}' +
    '.trd-notice{padding:6px 12px;font-size:12px;background:#fef7e0;color:#b06000}';

  const startedAt = Date.now();

  let status = 'init'; // 'init'|'disabled'|'scanning'|'ready'|'error'
  let errorCode = null;
  let lastReport = null;
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
            applyRulesJson(res.rules, null);
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

  function applyRulesJson(nextRulesJson, sourceLabel) {
    validateRulesJson(nextRulesJson);
    rulesJson = nextRulesJson;
    rulesSourceLabel = sourceLabel || null;
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

  async function performScan(allowFetch) {
    const docId = getDocId();
    if (!docId) return notReadyResponse();
    if (docId !== currentDocId) {
      // SPA 문서 전환 — 캐시 무효화 후 재초기화
      currentDocId = docId;
      cachedText = null;
      cachedTextSource = null;
      lastFetchAt = 0;
      lastModelAt = 0;
    }
    status = 'scanning';
    render();

    let text = null;
    let textSource = null;
    let cached = false;
    if (allowFetch) {
      try {
        const model = await fetchModelText(docId);
        text = model.text;
        textSource = 'model';
        cachedText = text;
        cachedTextSource = textSource;
        lastModelAt = Date.now();
      } catch (e) {
        // 내부 모델 API가 막히면 기존 export 경로로 내려간다.
      }
    }
    if (text === null) {
      if (allowFetch && Date.now() - lastFetchAt >= FETCH_MIN_INTERVAL) {
        try {
          text = await fetchExport(docId);
          textSource = 'export';
          cachedText = text;
          cachedTextSource = textSource;
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
      result = globalThis.TypoEngine.scan(text, { limit: SCAN_LIMIT });
    } catch (e) {
      status = 'error';
      errorCode = 'internal';
      sendCount(0);
      render();
      return errorResponse();
    }

    const findings = buildUIFindings(text, result.findings, textSource);
    const categoryCounts = {};
    for (const f of findings) categoryCounts[f.cat] = (categoryCounts[f.cat] || 0) + 1;

    lastReport = Object.assign({
      ok: true,
      disabled: false,
      rulesVersion: rulesJson ? rulesJson.version : null,
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
    render();
    return lastReport;
  }

  function enqueueScan(allowFetch) {
    const run = scanChain.then(() => performScan(allowFetch)).catch(() => {
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
  }

  function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
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
  }

  function buildBubble() {
    const b = el('div', 'trd-bubble');
    b.setAttribute('role', 'button');
    b.title = 'Toytype';
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
    const title = el('span', 'trd-title');
    title.textContent = (status === 'ready' && lastReport)
      ? 'Toytype · ' + lastReport.total + '건'
      : 'Toytype';
    const rescanBtn = el('button', 'trd-btn');
    rescanBtn.type = 'button';
    rescanBtn.textContent = '다시 검사';
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
    const jsonBtn = el('button', 'trd-btn');
    jsonBtn.type = 'button';
    jsonBtn.textContent = 'JSON';
    jsonBtn.title = 'rules.json 파일을 현재 문서 검사 규칙으로 임시 적용합니다';
    jsonBtn.addEventListener('click', () => { jsonInput.click(); });
    const closeBtn = el('button', 'trd-btn');
    closeBtn.type = 'button';
    closeBtn.textContent = '접기';
    closeBtn.addEventListener('click', () => {
      expanded = false;
      render();
    });
    head.append(title, rescanBtn, jsonBtn, closeBtn, jsonInput);
    panel.appendChild(head);

    // 알림 줄
    if (status === 'ready' && lastReport) {
      if (lastReport.truncated) {
        const n = el('div', 'trd-notice');
        n.textContent = '500건 초과 — 일부만 표시';
        panel.appendChild(n);
      }
      if (lastReport.cached) {
        const n = el('div', 'trd-notice');
        n.textContent = lastReport.textSource === 'model'
          ? '설정 변경 — 캐시된 문서 모델 기준'
          : '10초 이내 재검사 — 캐시된 텍스트 기준';
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
    l2.textContent = '규칙 ' + ver + (rulesSourceLabel ? ' · JSON ' + rulesSourceLabel : '') + ' · 마지막 검사 ' + when;
    foot.append(l1, l2);
    panel.appendChild(foot);

    const toast = el('div', 'trd-toast');
    toast.id = 'trd-toast';
    panel.appendChild(toast);
    return panel;
  }

  function buildItem(f) {
    const item = el('div', 'trd-item');
    item.title = f.selectable
      ? '클릭하면 문서 위치를 선택하고 교정어를 복사합니다'
      : '클릭하면 검색어를 복사하고 구글 독스 검색창 열기를 시도합니다';

    const ctx = el('div', 'trd-ctx');
    if (f.before) ctx.appendChild(document.createTextNode('…' + f.before));
    const hit = el('b', 'trd-hit trd-' + (CAT_COLOR[f.cat] || 'red'));
    hit.textContent = displayText(f.src);
    ctx.appendChild(hit);
    if (f.after) ctx.appendChild(document.createTextNode(f.after + '…'));

    const fix = el('div', 'trd-fix');
    fix.textContent = displayText(f.src) + ' → ' + displayText(f.dst);
    const ln = el('span', 'trd-line');
    ln.textContent = '¶' + f.line;
    fix.appendChild(ln);

    const actions = el('div', 'trd-actions');
    const action = el('div', 'trd-action');
    action.textContent = f.selectable ? '클릭: 문서 위치 선택 + 교정어 복사' : '클릭: 검색어 복사 + 찾기 열기';
    actions.appendChild(action);
    if (f.selectable) {
      const applyBtn = el('button', 'trd-btn trd-apply');
      applyBtn.type = 'button';
      applyBtn.textContent = '적용';
      applyBtn.title = '문서에서 이 항목을 교정어로 바꿉니다';
      applyBtn.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        applyFinding(f);
      });
      actions.appendChild(applyBtn);
    }

    item.append(ctx, fix, actions);
    item.addEventListener('click', () => {
      if (f.selectable && Number.isFinite(f.start) && Number.isFinite(f.end)) {
        selectDocsModelRange(f.start, f.end).then(() => {
          copyText(f.dst).then(
            () => showToast('문서 위치 선택 · 교정어 복사됨: ' + displayText(f.dst)),
            () => showToast('문서 위치 선택됨')
          );
        }, () => {
          fallbackFindingClick(f);
        });
        return;
      }
      fallbackFindingClick(f);
    });
    return item;
  }

  function handleRulesJsonUpload(file) {
    file.text().then(text => {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        throw new Error('json_parse_failed');
      }
      applyRulesJson(parsed, file.name || 'uploaded.json');
      showToast('JSON 적용됨: ' + (file.name || 'uploaded.json'));
      enqueueScan(true);
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

  function applyFinding(f) {
    if (!f.selectable || !Number.isFinite(f.start) || !Number.isFinite(f.end)) {
      fallbackFindingClick(f);
      return;
    }
    requestDocsModel('replaceSelection', {
      start: f.start,
      end: f.end,
      text: f.dst,
      docId: getDocId()
    }).then(res => {
      if (!res || !res.ok) return Promise.reject(new Error(res && res.errorMessage ? res.errorMessage : 'replace failed'));
      cachedText = null;
      cachedTextSource = null;
      showToast('적용됨: ' + displayText(f.dst));
      enqueueScan(true);
      return null;
    }).catch(() => {
      selectDocsModelRange(f.start, f.end).then(() => {
        copyText(f.dst).then(
          () => showToast('자동 적용 실패 · 교정어 복사됨: ' + displayText(f.dst)),
          () => showToast('자동 적용 실패 · 문서 위치 선택됨')
        );
      }, () => {
        fallbackFindingClick(f);
      });
    });
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
      injectPageBridgeScript();
      const requestId = 'trd-' + Date.now() + '-' + (++modelRequestSeq);
      const timeout = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        reject(new Error('model request timeout'));
      }, 4000);
      function onMessage(event) {
        if (event.source !== window || !event.data) return;
        if (event.data.kind === 'typo-radar:page-bridge-ready') {
          pageBridgeReady = true;
          return;
        }
        if (event.data.kind !== 'typo-radar:page-model-response' || event.data.requestId !== requestId) return;
        clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        resolve(event.data);
      }
      window.addEventListener('message', onMessage);
      setTimeout(() => {
        window.postMessage(Object.assign({
          kind: 'typo-radar:page-model-request',
          requestId,
          action,
          extensionId: chrome.runtime.id
        }, payload || {}), '*');
      }, pageBridgeReady ? 0 : 80);
    });
  }

  function selectDocsModelRange(start, end) {
    return requestDocsModel('setSelection', { start, end, docId: getDocId() }).then(res => {
      if (!res || !res.ok) throw new Error(res && res.errorMessage ? res.errorMessage : 'setSelection failed');
      return res;
    });
  }

  function injectPageBridgeScript() {
    if (pageBridgeInjected) return;
    pageBridgeInjected = true;
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('content/docs-page-bridge.js');
    script.async = false;
    script.onload = () => { script.remove(); };
    script.onerror = () => { pageBridgeInjected = false; };
    (document.documentElement || document.head || document.body).appendChild(script);
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

  init();
})();
