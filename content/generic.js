// Toytype — 일반 페이지 content script.
// DOM 무변형 원칙: 텍스트·속성을 절대 바꾸지 않고 CSS Custom Highlight API로만 표시한다.
(() => {
  'use strict';

  // 매니페스트가 docs 문서를 분리하지만, 혹시 실행돼도 즉시 종료 (docs는 content/docs.js 담당).
  if (location.hostname === 'docs.google.com' && location.pathname.startsWith('/document/')) return;

  const DEFAULT_SETTINGS = {
    schemaVersion: 1,
    docsCategories:    { convert: true, spelling: true, plural: true,  honorific: true,  space1: true,  space2: true,  space3: true,  final: true  },
    genericCategories: { convert: true, spelling: true, plural: false, honorific: false, space1: false, space2: false, space3: false, final: false },
    disabledOrigins:   []
  };

  const FINDING_LIMIT = 500;
  const TEXT_BUDGET = 1000000;
  const CHUNK_NODES = 200;

  // 조상에 있으면 텍스트 노드를 제외하는 태그 (코드·입력류는 규칙 적용 대상이 아님)
  const EXCLUDED_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'PRE', 'CODE', 'KBD', 'SAMP',
    'VAR', 'TEXTAREA', 'SELECT', 'OPTION', 'SVG', 'MATH'
  ]);

  // ---- 상태 ----
  let status = 'init'; // 'init' | 'disabled' | 'ready' | 'error'
  let lastError = null;
  let lastReport = null;
  let rules = null;        // RulesJson (background에서 수신)
  let engineKey = null;    // 마지막 TypoEngine.init의 활성 카테고리 키 (불필요한 리빌드 방지)
  let observer = null;
  let scanChain = Promise.resolve(); // 스캔 직렬화 (동시 스캔 금지)

  // ---- 메시지 리스너: 비동기 init 전에 동기 등록 ----
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'typo:get') {
      if (lastReport) sendResponse(lastReport);
      else if (status === 'error') sendResponse(errorReport(lastError || 'internal'));
      else sendResponse(errorReport('not_ready'));
      return;
    }
    if (msg.type === 'typo:rescan') {
      scheduleScan()
        .then((report) => sendResponse(report))
        .catch(() => sendResponse(errorReport('internal')));
      return true; // 비동기 응답
    }
  });

  // ---- storage.onChanged: 300ms 디바운스 후 재스캔 (설정은 runScan이 fresh로 재독) ----
  let storageTimer = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    clearTimeout(storageTimer);
    storageTimer = setTimeout(() => {
      scheduleScan().catch(() => {});
    }, 300);
  });

  // ---- 초기 스캔 ----
  scheduleScan().catch(() => {});

  // ============================================================

  function scheduleScan() {
    const p = scanChain.then(() => runScan());
    scanChain = p.catch(() => {}); // 실패해도 체인은 계속
    return p;
  }

  async function runScan() {
    let settings;
    try {
      settings = await readSettings();
    } catch (e) {
      status = 'error';
      lastError = 'internal';
      return errorReport('internal');
    }

    if (settings.disabledOrigins.includes(location.origin)) {
      clearHighlights();
      status = 'disabled';
      lastReport = makeReport({ disabled: true, scannedAt: null, total: 0, truncated: false, categoryCounts: {}, findings: [] });
      sendCount(0);
      return lastReport;
    }

    if (!rules) {
      try {
        rules = await fetchRules();
      } catch (e) {
        status = 'error';
        lastError = 'rules_load_failed';
        sendCount(0);
        return errorReport('rules_load_failed');
      }
    }

    const enabledIds = rules.categories
      .filter((c) => settings.genericCategories[c.id] === true)
      .map((c) => c.id);
    const key = enabledIds.join(',');
    if (key !== engineKey) {
      try {
        globalThis.TypoEngine.init(rules, enabledIds);
        engineKey = key;
      } catch (e) {
        status = 'error';
        lastError = 'rules_load_failed';
        sendCount(0);
        return errorReport('rules_load_failed');
      }
    }

    const labelById = {};
    for (const c of rules.categories) labelById[c.id] = c.label;

    const collected = collectTextNodes();
    let truncated = collected.truncated;
    const findings = [];
    const categoryCounts = {};
    const rangesByCat = {};

    for (let i = 0; i < collected.nodes.length; i++) {
      if (findings.length >= FINDING_LIMIT) { truncated = true; break; }
      const node = collected.nodes[i];
      const text = node.nodeValue;
      if (!text) continue;

      let result;
      try {
        result = globalThis.TypoEngine.scan(text, { limit: FINDING_LIMIT - findings.length });
      } catch (e) {
        continue;
      }
      if (result.truncated) truncated = true;

      for (const f of result.findings) {
        findings.push({
          idx: findings.length,
          src: f.src,
          dst: f.dst,
          cat: f.cat,
          catLabel: labelById[f.cat] || f.cat,
          before: collapseWs(text.slice(Math.max(0, f.start - 20), f.start)),
          after: collapseWs(text.slice(f.end, f.end + 20)),
          line: null
        });
        categoryCounts[f.cat] = (categoryCounts[f.cat] || 0) + 1;
        try {
          const range = new Range();
          range.setStart(node, f.start);
          range.setEnd(node, f.end);
          (rangesByCat[f.cat] || (rangesByCat[f.cat] = [])).push(range);
        } catch (e) {
          // 스캔 도중 노드가 변형되면 하이라이트만 생략 (목록·카운트는 유지)
        }
      }

      if ((i + 1) % CHUNK_NODES === 0) await yieldToMain();
    }

    applyHighlights(rangesByCat);
    status = 'ready';
    lastError = null;
    lastReport = makeReport({
      disabled: false,
      scannedAt: Date.now(),
      total: findings.length,
      truncated,
      categoryCounts,
      findings
    });
    sendCount(findings.length);
    startObserver();
    return lastReport;
  }

  // ---- 텍스트 수집 ----
  function collectTextNodes() {
    const nodes = [];
    let truncated = false;
    if (!document.body) return { nodes, truncated };

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // FILTER_REJECT로 서브트리 전체를 건너뛴다 (조상 검사 비용 절감)
            if (EXCLUDED_TAGS.has(node.nodeName.toUpperCase())) return NodeFilter.FILTER_REJECT;
            if (node.isContentEditable === true) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_SKIP;
          }
          if (!/\S/.test(node.nodeValue)) return NodeFilter.FILTER_SKIP;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let budget = 0;
    let node;
    while ((node = walker.nextNode())) {
      nodes.push(node);
      budget += node.nodeValue.length;
      if (budget >= TEXT_BUDGET) { truncated = true; break; }
    }
    return { nodes, truncated };
  }

  // ---- 하이라이트 (DOM 무변형) ----
  function highlightsSupported() {
    return typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight !== 'undefined';
  }

  function clearHighlights() {
    if (!highlightsSupported()) return;
    // 우리 접두사(typo-)만 삭제 — CSS.highlights.clear()는 타 확장 하이라이트를 지우므로 금지.
    // CAT_IDS 고정 목록 대신 접두사 순회: rules.json에 카테고리가 추가돼도 잔존 하이라이트가 안 남는다.
    const ours = [];
    CSS.highlights.forEach((_v, key) => { if (typeof key === 'string' && key.indexOf('typo-') === 0) ours.push(key); });
    for (const key of ours) CSS.highlights.delete(key);
  }

  function applyHighlights(rangesByCat) {
    if (!highlightsSupported()) return;
    clearHighlights();
    for (const cat of Object.keys(rangesByCat)) {
      CSS.highlights.set('typo-' + cat, new Highlight(...rangesByCat[cat]));
    }
  }

  // ---- MutationObserver (트레일링 디바운스 + 백오프) ----
  let mutationTimer = null;
  let pendingWhileHidden = false;
  const autoScanTimes = []; // 직전 60초 자동 재스캔 타임스탬프

  function currentDebounceMs() {
    const now = Date.now();
    while (autoScanTimes.length && now - autoScanTimes[0] > 60000) autoScanTimes.shift();
    return autoScanTimes.length > 5 ? 5000 : 1000;
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(() => {
      if (status === 'disabled') return;
      clearTimeout(mutationTimer);
      mutationTimer = setTimeout(fireAutoScan, currentDebounceMs());
    });
    observer.observe(document.body || document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && pendingWhileHidden) {
        pendingWhileHidden = false;
        fireAutoScan();
      }
    });
  }

  function fireAutoScan() {
    if (status === 'disabled') return;
    if (document.hidden) { pendingWhileHidden = true; return; }
    autoScanTimes.push(Date.now());
    scheduleScan().catch(() => {});
  }

  // ---- 헬퍼 ----
  function readSettings() {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.get('settings', (res) => {
          if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
          const stored = (res && res.settings) || {};
          resolve({
            schemaVersion: 1,
            docsCategories: Object.assign({}, DEFAULT_SETTINGS.docsCategories, stored.docsCategories || {}),
            genericCategories: Object.assign({}, DEFAULT_SETTINGS.genericCategories, stored.genericCategories || {}),
            disabledOrigins: Array.isArray(stored.disabledOrigins) ? stored.disabledOrigins : []
          });
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function fetchRules() {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: 'typo:getRules' }, (res) => {
          if (chrome.runtime.lastError || !res || !res.ok || !res.rules) {
            reject(new Error('rules_load_failed'));
          } else {
            resolve(res.rules);
          }
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function sendCount(count) {
    try {
      const p = chrome.runtime.sendMessage({ type: 'typo:count', count });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) {
      // 확장 리로드 등으로 컨텍스트가 무효화된 경우 무시
    }
  }

  function makeReport(partial) {
    return Object.assign({
      ok: true,
      context: 'generic',
      url: location.href,
      origin: location.origin,
      disabled: false,
      rulesVersion: rules ? rules.version : null,
      scannedAt: null,
      fetchedAt: null,
      cached: false,
      total: 0,
      truncated: false,
      categoryCounts: {},
      findings: []
    }, partial);
  }

  function errorReport(error) {
    return {
      ok: false,
      error,
      context: 'generic',
      url: location.href,
      origin: location.origin,
      disabled: status === 'disabled'
    };
  }

  function collapseWs(s) {
    return s.replace(/\s+/g, ' ');
  }

  function yieldToMain() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
})();
