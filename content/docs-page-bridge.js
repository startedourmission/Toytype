(function () {
  'use strict';

  function debugLogsEnabled() {
    try {
      return window.ToytypeDebug === true || window.localStorage.getItem('toytype:debug') === '1';
    } catch (e) {
      return window.ToytypeDebug === true;
    }
  }

  function debugLog() {
    if (!debugLogsEnabled()) return;
    console.info.apply(console, arguments);
  }

  function debugTable(data) {
    if (!debugLogsEnabled() || typeof console.table !== 'function') return;
    console.table(data);
  }

  let contentCommandSeq = 0;
  let lastPreflightFindingTarget = null;
  let lastPreflightFindingSnapshot = null;
  // annotated text 객체 캐시 — 매 요청마다 후보 ID 체인을 다시 해석하지 않는다.
  // 모델 메서드 호출이 실패하면 무효화 후 다음 요청에서 재해석한다.
  let cachedAnnotatedObj = null;
  // beforeinput 폴백에서 마지막으로 성공한 (타깃, inputType) 조합 — 다음 적용은 이 조합부터 시도한다.
  let cachedTextEventCombo = null;
  // 내부 텍스트 액션 가용성 기억 — 이 페이지에서 한 번도 없었으면 대기 없이 1회 확인만 하고 폴백으로 간다.
  let internalActionEverSucceeded = false;
  let internalActionUnavailableSeen = false;

  function safeGet(obj, key) {
    try {
      return obj[key];
    } catch (e) {
      return undefined;
    }
  }

  function safeGetPath(path) {
    const parts = path.split('.');
    let cur = window;
    for (const part of parts) {
      if (part === 'window') continue;
      cur = safeGet(cur, part);
      if (cur === undefined || cur === null) break;
    }
    return cur;
  }

  function getDocsActionGetter() {
    const info = getDocsActionRegistryInfo();
    return info.getAction;
  }

  function getDocsActionRegistryCandidates() {
    return [
      ['_.ox', safeGetPath('_.ox')],
      ['_$kx.ox', safeGetPath('_$kx.ox')]
    ];
  }

  function getDocsActionRegistryInfo() {
    const candidates = getDocsActionRegistryCandidates();
    for (const pair of candidates) {
      if (typeof pair[1] === 'function') {
        return { path: pair[0], getAction: pair[1] };
      }
    }
    return { path: '', getAction: null };
  }

  const KNOWN_MUTATION_ACTION_IDS = [
    'docs-replace',
    'docs-mlti',
    'docs-null',
    'docs-reverse',
    'docs-revert',
    'docs-undo',
    'docs-updatemodelversion',
    'docs-updatemodelfeaturebitset',
    'docs-text-inCh',
    'docs-text-del',
    'docs-text-bksp',
    'docs-text-cr',
    'docs-text-ctTxt',
    'docs-text-imeIn',
    'docs-text-eetxp',
    'docs-text-usc',
    'docs-paste',
    'docs-paste-without-formatting',
    'docs-paste-from-markdown'
  ];

  const DIRECT_TEXT_ACTION_IDS = [
    'docstext-insert-characters',
    'docstext-carriage-return',
    'docstext-apply-tab',
    'docstext-ime-input',
    'docstext-composing',
    'doctext-delete',
    'doctext-backspace'
  ];

  function toPromise(value) {
    if (value && typeof value.then === 'function') return value;
    return Promise.resolve(value);
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function requestToytypeContentCommand(action, payload) {
    return new Promise((resolve, reject) => {
      const opts = payload && typeof payload === 'object' ? payload : {};
      const timeoutMs = clampNumber(opts.timeoutMs, 20000, 1000, 75000);
      const requestId = 'toytype-content-' + Date.now() + '-' + (++contentCommandSeq);
      const timeout = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        reject(new Error('content command timeout'));
      }, timeoutMs);
      function onMessage(event) {
        if (event.source !== window || !event.data) return;
        if (event.data.kind !== 'toytype:content-command-response' || event.data.requestId !== requestId) return;
        clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        resolve(event.data);
      }
      window.addEventListener('message', onMessage);
      window.postMessage(Object.assign({
        kind: 'toytype:content-command-request',
        requestId,
        action
      }, opts), '*');
    });
  }

  window.addEventListener('message', event => {
    if (event.source !== window || !event.data || event.data.kind !== 'typo-radar:page-model-request') return;
    handleRequest(event.data);
  });

  function handleRequest(data) {
    if (data && data.action === 'profileModelOps') {
      return profileModelOps(data).then(result => {
        postResponse(data, { ok: true, action: data.action, result });
      }).catch(error => {
        postResponse(data, errorResponse(data, error));
      });
    }

    if (data && data.action === 'applyInternalTextActionOnce') {
      return applyInternalTextActionOnce(data).then(result => {
        postResponse(data, { ok: true, action: data.action, result });
      }).catch(error => {
        postResponse(data, errorResponse(data, error));
      });
    }

    if (data && data.action === 'applyFindReplaceOnce') {
      return applyFindReplaceOnce(data).then(result => {
        postResponse(data, { ok: true, action: data.action, result });
      }).catch(error => {
        postResponse(data, errorResponse(data, error));
      });
    }

    if (data && data.action === 'clickFindReplaceButton') {
      return clickFindReplaceButton(data).then(result => {
        postResponse(data, { ok: true, action: data.action, result });
      }).catch(error => {
        postResponse(data, errorResponse(data, error));
      });
    }

    if (data && data.action === 'prepareFindReplaceUi') {
      return prepareFindReplaceUi(data).then(result => {
        postResponse(data, { ok: true, action: data.action, result });
      }).catch(error => {
        postResponse(data, errorResponse(data, error));
      });
    }

    if (data && data.action === 'probeFindReplaceUi') {
      return probeFindReplaceUi(data).then(result => {
        postResponse(data, { ok: true, action: data.action, result });
      }).catch(error => {
        postResponse(data, errorResponse(data, error));
      });
    }

    if (data && data.action === 'runKnownFindAction') {
      return Promise.resolve().then(() => runKnownFindAction(data)).then(result => {
        postResponse(data, { ok: true, action: data.action, result });
      }).catch(error => {
        postResponse(data, errorResponse(data, error));
      });
    }

    if (data && data.action === 'probeFindReplaceInteraction') {
      return probeFindReplaceInteraction(data).then(result => {
        postResponse(data, { ok: true, action: data.action, result });
      }).catch(error => {
        postResponse(data, errorResponse(data, error));
      });
    }

    if (data && data.action === 'probeFindReplace') {
      return getAnnotatedTextObject(data).catch(() => null).then(obj => {
        return probeFindReplace(obj, data);
      }).then(result => {
        postResponse(data, { ok: true, action: data.action, result });
      }).catch(error => {
        postResponse(data, errorResponse(data, error));
      });
    }

    getAnnotatedTextObject(data).then(obj => {
      if (data.action === 'getText') {
        return getText(obj).then(text => {
          return getSelection(obj).then(selection => {
            postResponse(data, { ok: true, action: data.action, text, selection });
          });
        });
      }
      if (data.action === 'getSelection') {
        return getSelection(obj).then(selection => {
          postResponse(data, { ok: true, action: data.action, selection });
        });
      }
      if (data.action === 'setSelection') {
        const range = readRange(data);
        return setSelection(obj, range.start, range.end).then(result => {
          focusDocsEditor();
          return delay(80).then(() => getSelection(obj)).then(selection => {
            postResponse(data, { ok: true, action: data.action, result, selection });
          });
        });
      }
      throw new Error('unknown page model action: ' + data.action);
    }).catch(error => {
      postResponse(data, errorResponse(data, error));
    });
  }

  function readRange(data) {
    const start = Number(data.start);
    const end = Number(data.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
      throw new Error('invalid selection range');
    }
    return { start, end };
  }

  function getAnnotatedTextObject(data) {
    if (cachedAnnotatedObj) return Promise.resolve(cachedAnnotatedObj);
    const fn = safeGetPath('_docs_annotate_getAnnotatedText');
    if (typeof fn !== 'function') return Promise.reject(new Error('_docs_annotate_getAnnotatedText unavailable'));
    const ids = annotatedTextArgCandidates(data);
    if (!ids.length) return Promise.reject(new Error('no annotated text id candidates'));
    let index = 0;
    const tryNext = lastError => {
      if (index >= ids.length) return Promise.reject(lastError || new Error('annotated text object unavailable'));
      const id = ids[index++];
      return Promise.resolve().then(() => {
        return toPromise(fn(id)).then(obj => {
          if (!obj || typeof obj.getText !== 'function' || typeof obj.setSelection !== 'function') {
            throw new Error('annotated text object missing methods for id ' + id);
          }
          cachedAnnotatedObj = obj;
          return obj;
        });
      }).catch(tryNext);
    };
    return tryNext();
  }

  function annotatedTextArgCandidates(data) {
    const out = [];
    const add = value => {
      if (typeof value !== 'string' || !value || out.includes(value)) return;
      out.push(value);
    };
    add(data && data.extensionId);
    add(data && data.docId);
    const match = location.pathname.match(/\/d\/([a-zA-Z0-9_-]+)/);
    add(match && match[1]);
    add('docs');
    add('kix');
    return out;
  }

  function getText(obj) {
    return callAnnotatedMethod(obj, 'getText').then(text => {
      if (typeof text !== 'string') throw new Error('getText returned non-string');
      return text;
    });
  }

  function getSelection(obj) {
    return callAnnotatedMethod(obj, 'getSelection').then(selection => {
      if (!Array.isArray(selection)) return null;
      return selection.map(item => ({
        start: item && typeof item.start === 'number' ? item.start : null,
        end: item && typeof item.end === 'number' ? item.end : null
      }));
    }).catch(() => null);
  }

  function setSelection(obj, start, end) {
    return callAnnotatedMethod(obj, 'setSelection', [start, end]);
  }

  function probeFindReplace(annotatedObj, data) {
    const result = {
      kind: 'toytype:find-replace-probe-result',
      timestamp: new Date().toISOString(),
      url: location.href,
      docId: data && data.docId || extractDocId(),
      roots: [],
      windowMatches: [],
      scriptMatches: [],
      knownFindActions: [],
      candidates: [],
      topCandidates: [],
      notes: [
        'Read-only probe: samples names, keys, constructor names, and function source prefixes.',
        'It does not call candidate find/replace functions or mutate the document.',
        'Script source probe fetches same-origin loaded Google Docs scripts and samples only short keyword neighborhoods.'
      ]
    };
    const seen = [];
    const candidates = [];
    const limits = probeLimits(data);

    const roots = [
      ['KX_kixApp', safeGetPath('KX_kixApp')],
      ['annotatedText', annotatedObj],
      ['_docs_annotate_getAnnotatedText', safeGetPath('_docs_annotate_getAnnotatedText')],
      ['document.__wizmanager', safeGetPath('document.__wizmanager')],
      ['document.__wizdispatcher', safeGetPath('document.__wizdispatcher')],
      ['DOCS_warmStartDocumentLoader', safeGetPath('DOCS_warmStartDocumentLoader')]
    ];

    for (const pair of roots) {
      const name = pair[0];
      const value = pair[1];
      result.roots.push(summarizeAtPath(name, value));
      scanGraph(name, value, candidates, seen, limits);
    }

    result.windowMatches = scanWindowDirect(limits);
    for (const match of result.windowMatches) {
      if (match.score >= 10) candidates.push(match);
    }

    result.knownFindActions = probeKnownFindActions(data);
    for (const action of result.knownFindActions) {
      candidates.push({
        path: 'knownAction:' + action.id,
        key: action.id,
        type: 'docs-action',
        ctor: action.ctor || '',
        score: scoreText(action.id + ' ' + (action.label || '') + ' ' + action.methods.join(' ')) + (action.exists ? 40 : 0),
        valueSample: JSON.stringify(action).slice(0, 500)
      });
    }

    return probeScriptSources(limits).then(matches => {
      result.scriptMatches = matches;
      for (const match of matches) candidates.push(match);
      return finalizeFindReplaceProbe(result, candidates);
    }).catch(error => {
      result.scriptMatches = [{
        kind: 'script-source-error',
        errorName: error && error.name ? error.name : '',
        errorMessage: error && error.message ? String(error.message).slice(0, 300) : String(error).slice(0, 300)
      }];
      return finalizeFindReplaceProbe(result, candidates);
    });
  }

  function finalizeFindReplaceProbe(result, candidates) {
    candidates.sort((a, b) => (b.score - a.score) || String(a.path).localeCompare(String(b.path)));
    result.candidates = candidates.slice(0, 120);
    result.topCandidates = result.candidates.slice(0, 25).map(candidateSummary);
    return result;
  }

  function probeLimits(data) {
    const raw = data && data.limits && typeof data.limits === 'object' ? data.limits : {};
    return {
      maxDepth: clampNumber(raw.maxDepth, 3, 1, 5),
      maxNodes: clampNumber(raw.maxNodes, 260, 40, 1500),
      maxProps: clampNumber(raw.maxProps, 120, 20, 320),
      windowKeys: clampNumber(raw.windowKeys, 2500, 200, 6000),
      scriptCount: clampNumber(raw.scriptCount, 4, 0, 12),
      scriptMatches: clampNumber(raw.scriptMatches, 30, 0, 120),
      scriptContext: clampNumber(raw.scriptContext, 90, 30, 220)
    };
  }

  function clampNumber(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
  }

  function candidateSummary(candidate) {
    return {
      score: candidate.score,
      path: candidate.path,
      type: candidate.type,
      ctor: candidate.ctor,
      length: candidate.length === undefined ? '' : candidate.length,
      sample: candidate.sourcePrefix || candidate.valueSample ||
        (candidate.interestingValues && candidate.interestingValues[0] && candidate.interestingValues[0].value) || ''
    };
  }

  function scanWindowDirect(limits) {
    const out = [];
    const keys = ownKeys(window).slice(0, limits.windowKeys);
    for (const key of keys) {
      const value = safeGet(window, key);
      const item = candidateFor('window.' + key, key, value, 0);
      if (item && item.score >= 8) out.push(item);
    }
    out.sort((a, b) => (b.score - a.score) || String(a.path).localeCompare(String(b.path)));
    return out.slice(0, 80);
  }

  function probeKnownFindActions(options) {
    const ids = [
      'docs-find',
      'docs-find-start',
      'docs-find-stop',
      'docs-find-next',
      'docs-find-previous',
      'docs-find-scope-change',
      'docs-find-and-replace-start',
      'docs-find-and-replace-stop',
      'docs-replace',
      'docs-replace-all'
    ];
    const registry = getDocsActionRegistryInfo();
    return ids.map(id => summarizeKnownFindAction(id, registry, options));
  }

  function summarizeKnownFindAction(id, registryOrGetter, options) {
    const registry = typeof registryOrGetter === 'function'
      ? { path: '', getAction: registryOrGetter }
      : (registryOrGetter || { path: '', getAction: null });
    const getAction = registry.getAction;
    const summary = {
      id,
      registryPath: registry.path || '',
      exists: false,
      type: '',
      ctor: '',
      methods: [],
      label: '',
      enabled: null,
      visible: null,
      selected: null,
      value: null,
      tooltip: '',
      hasZo: false,
      hasZf: false,
      error: ''
    };
    if (typeof getAction !== 'function') {
      summary.error = 'docs action registry unavailable';
      return summary;
    }
    let action;
    try {
      action = getAction(id);
    } catch (e) {
      summary.error = e && e.message ? String(e.message).slice(0, 200) : String(e).slice(0, 200);
      return summary;
    }
    summary.exists = !!action;
    summary.type = action === null ? 'null' : typeof action;
    summary.ctor = ctorName(action);
    summary.methods = probeKeys(action).filter(key => typeof safeGet(action, key) === 'function').slice(0, 60);
    summary.hasZo = !!(action && typeof action.Zo === 'function');
    summary.hasZf = !!(action && typeof action.Zf === 'function');
    summary.executor = actionExecutorName(action);
    summary.label = safeReadActionString(action, 'getLabel');
    summary.tooltip = safeReadActionString(action, 'Lf');
    summary.enabled = safeReadActionBoolean(action, 'isEnabled');
    summary.visible = safeReadActionBoolean(action, 'isVisible');
    summary.selected = safeReadActionBoolean(action, 'Pc');
    summary.value = safeReadActionString(action, 'getValue');
    if (options && options.deepActions === true) {
      summary.deep = summarizeActionObject(action, options);
    }
    return summary;
  }

  function actionExecutorName(action) {
    return action && typeof action.Zo === 'function' ? 'Zo' : '';
  }

  function executeDocsAction(action, id) {
    const executor = actionExecutorName(action);
    if (!executor) {
      const error = new Error('docs action has no known executor: ' + id);
      error.debug = {
        id,
        ctor: ctorName(action),
        methods: probeKeys(action).filter(key => typeof safeGet(action, key) === 'function').slice(0, 120)
      };
      throw error;
    }
    action[executor]();
    return executor;
  }

  function summarizeActionObject(action, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const keyLimit = clampNumber(opts.actionKeyLimit, 80, 10, 200);
    const sourceLimit = clampNumber(opts.actionSourceLimit, 260, 80, 1200);
    const keys = probeKeys(action).slice(0, keyLimit);
    return {
      keyCount: probeKeys(action).length,
      keys,
      props: keys.map(key => summarizeActionProperty(action, key, sourceLimit))
    };
  }

  function summarizeActionProperty(action, key, sourceLimit) {
    const value = safeGet(action, key);
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const out = { key: String(key), type, ctor: ctorName(value) };
    if (value == null) return out;
    if (type === 'string') {
      out.value = String(value).slice(0, 300);
      out.length = String(value).length;
      return out;
    }
    if (type === 'number' || type === 'boolean') {
      out.value = value;
      return out;
    }
    if (type === 'function') {
      out.length = value.length;
      out.sourcePrefix = functionSource(value, sourceLimit);
      return out;
    }
    if (isObjectLike(value)) {
      const keys = probeKeys(value).slice(0, 20);
      out.keys = keys;
      out.keyCount = probeKeys(value).length;
      out.primitiveProps = keys.map(childKey => {
        const child = safeGet(value, childKey);
        const childType = child === null ? 'null' : Array.isArray(child) ? 'array' : typeof child;
        const childOut = { key: String(childKey), type: childType, ctor: ctorName(child) };
        if (childType === 'string') childOut.value = String(child).slice(0, 160);
        else if (childType === 'number' || childType === 'boolean') childOut.value = child;
        else if (childType === 'function') childOut.sourcePrefix = functionSource(child, Math.min(sourceLimit, 180));
        return childOut;
      }).slice(0, 20);
    }
    return out;
  }

  function safeReadActionString(action, method) {
    try {
      const fn = action && action[method];
      if (typeof fn !== 'function') return '';
      const value = fn.call(action);
      return value == null ? '' : String(value).slice(0, 300);
    } catch (e) {
      return '';
    }
  }

  function safeReadActionBoolean(action, method) {
    try {
      const fn = action && action[method];
      return typeof fn === 'function' ? !!fn.call(action) : null;
    } catch (e) {
      return null;
    }
  }

  function summarizePrimitiveReturn(value) {
    if (value === undefined) return { type: 'undefined' };
    if (value === null) return { type: 'null' };
    const type = Array.isArray(value) ? 'array' : typeof value;
    const out = { type, ctor: ctorName(value) };
    if (type === 'string') {
      out.length = value.length;
      out.value = value.slice(0, 300);
    } else if (type === 'number' || type === 'boolean') {
      out.value = value;
    } else if (type === 'function') {
      out.length = value.length;
      out.sourcePrefix = functionSource(value, 180);
    } else if (isObjectLike(value)) {
      out.keys = probeKeys(value).slice(0, 20);
      out.keyCount = probeKeys(value).length;
    }
    return out;
  }

  function runKnownFindAction(options) {
    const allowed = [
      'docs-find-start',
      'docs-find-stop',
      'docs-find',
      'docs-find-next',
      'docs-find-previous',
      'docs-find-and-replace-start',
      'docs-find-and-replace-stop'
    ];
    const id = options && typeof options.id === 'string' ? options.id : 'docs-find-and-replace-start';
    const dryRun = options && options.dryRun === true;
    if (allowed.indexOf(id) === -1) throw new Error('find action is not whitelisted: ' + id);
    const registry = getDocsActionRegistryInfo();
    const getAction = registry.getAction;
    const before = summarizeKnownFindAction(id, registry);
    if (!before.exists) throw new Error('find action unavailable: ' + id);
    if (dryRun) {
      return { id, dryRun: true, before, after: before, executed: false };
    }
    const action = getAction(id);
    const executor = executeDocsAction(action, id);
    return delay(120).then(() => ({
      id,
      dryRun: false,
      before,
      after: summarizeKnownFindAction(id, registry),
      activeElement: summarizeElement(document.activeElement),
      executor,
      executed: true
    }));
  }

  function waitForKnownAction(id, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const timeoutMs = clampNumber(opts.actionWaitMs, 2500, 0, 10000);
    const intervalMs = clampNumber(opts.actionPollMs, 120, 40, 1000);
    const started = Date.now();
    const registry = getDocsActionRegistryInfo();
    const getAction = registry.getAction;
    let pollCount = 0;
    let lastSummary = null;

    function poll() {
      pollCount++;
      lastSummary = summarizeKnownFindAction(id, registry);
      if (lastSummary.exists && lastSummary.enabled !== false) {
        return {
          id,
          pollCount,
          elapsedMs: Date.now() - started,
          summary: lastSummary
        };
      }
      if (Date.now() - started >= timeoutMs) {
        return {
          id,
          pollCount,
          elapsedMs: Date.now() - started,
          summary: lastSummary,
          timedOut: true
        };
      }
      return delay(intervalMs).then(poll);
    }

    return Promise.resolve().then(poll);
  }

  function probeFindReplaceUi(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const waitMs = clampNumber(opts.waitMs, 250, 0, 2000);
    const open = opts.open !== false;
    const actionId = typeof opts.id === 'string' ? opts.id : 'docs-find-and-replace-start';
    const actionPromise = open ? Promise.resolve().then(() => runKnownFindAction({ id: actionId })) : Promise.resolve(null);
    return actionPromise.then(actionResult => {
      return delay(waitMs).then(() => {
        const result = {
          kind: 'toytype:find-replace-ui-probe-result',
          timestamp: new Date().toISOString(),
          url: location.href,
          actionResult,
          activeElement: summarizeElement(document.activeElement),
          dialogs: scanVisibleElements('[role="dialog"], .docs-dialog, .modal-dialog, [class*="dialog"]', 20),
          textInputs: scanVisibleElements('input, textarea, [contenteditable="true"], [role="textbox"]', 80),
          buttons: scanVisibleElements('button, [role="button"], [aria-label], [title]', 120),
          knownFindActions: probeKnownFindActions(opts),
          candidates: []
        };
        result.fieldGuess = guessFindReplaceFields(result.textInputs);
        result.buttonGuess = guessFindReplaceButtons(result.buttons);
        result.candidates = result.dialogs.concat(result.textInputs, result.buttons)
          .map(item => Object.assign({}, item, { score: scoreUiElement(item) }))
          .filter(item => item.score > 0 || item.kind === 'textInput')
          .sort((a, b) => (b.score - a.score) || ((a.rect && a.rect.y || 0) - (b.rect && b.rect.y || 0)))
          .slice(0, 80);
        debugLog('[Toytype probe] find/replace UI result', result);
        if (typeof console.table === 'function') debugTable(result.candidates);
        debugLog('[Toytype probe ui json]', JSON.stringify(result));
        return result;
      });
    });
  }

  function prepareFindReplaceUi(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const findText = typeof opts.findText === 'string' ? opts.findText : '';
    const replaceText = typeof opts.replaceText === 'string' ? opts.replaceText : '';
    if (!findText) throw new Error('findText is required');
    return probeFindReplaceUi(Object.assign({}, opts, { open: opts.open !== false })).then(probe => {
      const fields = resolveFindReplaceFieldNodes();
      if (!fields.find) throw new Error('find field unavailable');
      const inputEvents = [];
      inputEvents.push(setElementTextValue(fields.find.node, findText));
      const findSettleMs = clampNumber(opts.findSettleMs, 120, 0, 3000);
      const fieldSettleMs = clampNumber(opts.fieldSettleMs, 250, 0, 3000);
      return delay(findSettleMs).then(() => {
        if (fields.replace) inputEvents.push(setElementTextValue(fields.replace.node, replaceText));
        return delay(fieldSettleMs).then(() => probeFindReplaceUi({
          open: false,
          waitMs: 120,
          deepActions: opts.deepActions === true,
          actionKeyLimit: opts.actionKeyLimit,
          actionSourceLimit: opts.actionSourceLimit
        }));
      }).then(afterProbe => {
        const fieldValuesAfterInput = summarizeResolvedFindReplaceFields();
        const fieldVerification = verifyFindReplaceFieldValues(findText, replaceText);
        return {
          kind: 'toytype:find-replace-ui-prepare-result',
          timestamp: new Date().toISOString(),
          url: location.href,
          requested: { findText, replaceText },
          initialProbe: probe,
          fields: {
            find: fields.find ? fields.find.summary : null,
            replace: fields.replace ? fields.replace.summary : null
          },
          fieldValuesAfterInput,
          fieldVerification,
          inputEvents,
          afterProbe,
          documentMutated: false,
          note: 'Only populated the Google Docs find/replace UI fields; it did not click replace.'
        };
      });
    });
  }

  function verifyFindReplaceFieldValues(findText, replaceText) {
    const fields = resolveFindReplaceFieldNodes();
    const findValue = fields.find ? readableElementValueFull(fields.find.node) : '';
    const replaceValue = fields.replace ? readableElementValueFull(fields.replace.node) : '';
    return {
      ok: !!fields.find && !!fields.replace && findValue === findText && replaceValue === replaceText,
      find: {
        found: !!fields.find,
        ok: !!fields.find && findValue === findText,
        expectedLength: findText.length,
        actualLength: findValue.length,
        expectedSample: findText.slice(0, 160),
        actualSample: findValue.slice(0, 160),
        summary: fields.find ? fields.find.summary : null
      },
      replace: {
        found: !!fields.replace,
        ok: !!fields.replace && replaceValue === replaceText,
        expectedLength: replaceText.length,
        actualLength: replaceValue.length,
        expectedSample: replaceText.slice(0, 160),
        actualSample: replaceValue.slice(0, 160),
        summary: fields.replace ? fields.replace.summary : null
      },
      confidence: fields.confidence || null,
      fieldCount: fields.all.length
    };
  }

  function clickFindReplaceButton(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const mode = typeof opts.mode === 'string' ? opts.mode : 'replace';
    const allow = ['replace', 'replaceAll', 'next', 'previous', 'close'];
    if (allow.indexOf(mode) === -1) throw new Error('unsupported find/replace button mode: ' + mode);
    const mayMutate = mode === 'replace' || mode === 'replaceAll';
    if (mayMutate && opts.confirmMutation !== true) {
      return waitForFindReplaceButton(mode, opts).then(waitResult => {
        return probeFindReplaceUi({
          open: false,
          waitMs: 0,
          deepActions: opts.deepActions === true,
          actionKeyLimit: opts.actionKeyLimit,
          actionSourceLimit: opts.actionSourceLimit
        }).then(probe => ({
          kind: 'toytype:find-replace-button-click-result',
          mode,
          clicked: false,
          documentMutated: false,
          requiresConfirmMutation: true,
          buttonGuess: probe.buttonGuess,
          waitResult: summarizeButtonWaitForLog(waitResult),
          note: 'Pass confirmMutation:true to click a mutating replace button.'
        }));
      });
    }
    return waitForFindReplaceButtonWithOptionalPrime(mode, opts).then(({ waitResult, primeResult, primeValidation, currentValidation, firstWait }) => {
      const target = waitResult.target;
      if (!target) {
        const error = new Error('find/replace button unavailable for mode: ' + mode);
        error.debug = {
          mode,
          waitResult: summarizeButtonWaitForLog(waitResult),
          primeResult,
          primeValidation,
          currentValidation,
          firstWait: summarizeButtonWaitForLog(firstWait)
        };
        throw error;
      }
      const activation = activateElement(target.node);
      return delay(120).then(() => probeFindReplaceUi({
        open: false,
        waitMs: 0,
        deepActions: opts.deepActions === true,
        actionKeyLimit: opts.actionKeyLimit,
        actionSourceLimit: opts.actionSourceLimit
      }).then(probe => ({
        kind: 'toytype:find-replace-button-click-result',
        mode,
        clicked: true,
        documentMutated: mayMutate,
        clickedButton: target.summary,
        activation,
        waitResult: summarizeButtonWaitForLog(waitResult),
        firstWait: summarizeButtonWaitForLog(firstWait),
        primeResult,
        primeValidation,
        currentValidation,
        afterProbe: probe
      })));
    });
  }

  function waitForFindReplaceButtonWithOptionalPrime(mode, opts) {
    return waitForFindReplaceButton(mode, opts).then(firstWait => {
      const mustPrime = opts.requirePrimeFindMatch === true || opts.primeFindMatch === 'always';
      if (firstWait.target && !mustPrime) {
        const mayMutate = mode === 'replace' || mode === 'replaceAll';
        const validationPromise = mayMutate ? validateCurrentSelectionBeforeReplace(opts) : Promise.resolve(null);
        return validationPromise.then(currentValidation => ({
          waitResult: firstWait,
          primeResult: null,
          primeValidation: null,
          currentValidation,
          firstWait: null
        }));
      }
      if (!mustPrime && (opts.primeFindMatch === false || opts.primeFindMatch === 'never')) {
        return { waitResult: firstWait, primeResult: null, primeValidation: null, currentValidation: null, firstWait: null };
      }
      return runFindNavigationAction(opts).then(primeResult => {
        return validatePrimeSelection(opts, primeResult).then(primeValidation => {
          return waitForFindReplaceButton(mode, opts).then(waitResult => ({
            waitResult,
            primeResult,
            primeValidation,
            currentValidation: null,
            firstWait
          }));
        });
      }).catch(error => {
        if (mustPrime) {
          if (typeof error === 'object' && !error.preventFallback) error.preventFallback = true;
          throw error || new Error('required find prime failed');
        }
        if (error && error.preventFallback) throw error;
        return {
          waitResult: firstWait,
          primeResult: {
            ok: false,
            errorName: error && error.name ? error.name : '',
            errorMessage: error && error.message ? String(error.message).slice(0, 500) : String(error).slice(0, 500),
            debug: error && error.debug !== undefined ? safeJsonClone(error.debug, 4000) : undefined
          },
          primeValidation: null,
          currentValidation: null,
          firstWait
        };
      });
    });
  }

  function summarizeButtonWaitForLog(waitResult) {
    if (!waitResult) return null;
    return {
      pollCount: waitResult.pollCount,
      elapsedMs: waitResult.elapsedMs,
      available: !!waitResult.target,
      target: waitResult.target ? waitResult.target.summary : null,
      lastButtons: Array.isArray(waitResult.lastButtons) ? waitResult.lastButtons.slice(0, 8) : []
    };
  }

  function runFindReplaceMutationAction(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const mode = typeof opts.mode === 'string' ? opts.mode : 'replace';
    const id = mode === 'replaceAll' ? 'docs-replace-all' : 'docs-replace';
    if ((mode === 'replace' || mode === 'replaceAll') && opts.confirmMutation !== true) {
      return Promise.resolve({
        kind: 'toytype:find-replace-action-result',
        mode,
        id,
        executed: false,
        documentMutated: false,
        requiresConfirmMutation: true,
        action: summarizeKnownFindAction(id, getDocsActionRegistryInfo()),
        note: 'Pass confirmMutation:true to execute a mutating Google Docs replace action.'
      });
    }
    return waitForReplaceActionWithOptionalPrime(id, opts).then(({ primeResult, primeValidation, currentValidation, waitResult, firstWait }) => {
      const registry = getDocsActionRegistryInfo();
      const getAction = registry.getAction;
      const before = waitResult.summary || summarizeKnownFindAction(id, registry);
      if (!before.exists) throw new Error('replace action unavailable: ' + id);
      if (before.enabled === false) {
        const error = new Error('replace action disabled: ' + id);
        error.debug = {
          primeResult,
          primeValidation,
          currentValidation,
          firstWait: summarizeActionWaitForLog(firstWait),
          waitResult: summarizeActionWaitForLog(waitResult)
        };
        throw error;
      }
      let action;
      try {
        action = getAction(id);
      } catch (e) {
        throw e;
      }
      const executor = executeDocsAction(action, id);
      return delay(120).then(() => ({
        kind: 'toytype:find-replace-action-result',
        mode,
        id,
        executor,
        executed: true,
        documentMutated: true,
        waitResult: {
          pollCount: waitResult.pollCount,
          elapsedMs: waitResult.elapsedMs
        },
        firstWait: summarizeActionWaitForLog(firstWait),
        primeResult,
        primeValidation,
        currentValidation,
        before,
        after: summarizeKnownFindAction(id, registry),
        activeElement: summarizeElement(document.activeElement)
      }));
    });
  }

  function waitForReplaceActionWithOptionalPrime(id, opts) {
    return waitForKnownAction(id, opts).then(firstWait => {
      const mustPrime = opts.requirePrimeFindMatch === true || opts.primeFindMatch === 'always';
      if (firstWait.summary && firstWait.summary.exists && firstWait.summary.enabled !== false && !mustPrime) {
        return validateCurrentSelectionBeforeReplace(opts).then(currentValidation => ({
          primeResult: null,
          primeValidation: null,
          currentValidation,
          waitResult: firstWait
        }));
      }
      const primeMode = opts.primeFindMatch;
      if (!mustPrime && (primeMode === false || primeMode === 'never')) {
        return { primeResult: null, primeValidation: null, currentValidation: null, waitResult: firstWait };
      }
      return runFindNavigationAction(opts).then(primeResult => {
        return validatePrimeSelection(opts, primeResult).then(primeValidation => {
          return waitForKnownAction(id, opts).then(waitResult => ({
            primeResult,
            primeValidation,
            currentValidation: null,
            waitResult,
            firstWait
          }));
        });
      }).catch(error => {
        if (mustPrime) {
          if (typeof error === 'object' && !error.preventFallback) error.preventFallback = true;
          throw error || new Error('required find prime failed');
        }
        if (error && error.preventFallback) throw error;
        return {
          primeResult: {
            ok: false,
            errorName: error && error.name ? error.name : '',
            errorMessage: error && error.message ? String(error.message).slice(0, 500) : String(error).slice(0, 500),
            debug: error && error.debug !== undefined ? safeJsonClone(error.debug, 4000) : undefined
          },
          primeValidation: null,
          currentValidation: null,
          waitResult: firstWait,
          firstWait
        };
      });
    });
  }

  function summarizeActionWaitForLog(waitResult) {
    if (!waitResult) return null;
    const summary = waitResult.summary || null;
    return {
      pollCount: waitResult.pollCount,
      elapsedMs: waitResult.elapsedMs,
      timedOut: !!waitResult.timedOut,
      exists: summary ? !!summary.exists : null,
      enabled: summary ? summary.enabled : null,
      visible: summary ? summary.visible : null,
      selected: summary ? summary.selected : null,
      value: summary ? summary.value : null,
      error: summary ? summary.error : ''
    };
  }

  function validatePrimeSelection(opts, primeResult) {
    const obj = opts && opts.annotatedObj;
    if (!obj || shouldSkipTargetSelectionVerification(opts) || !primeResult || primeResult.ok !== true) {
      return Promise.resolve(null);
    }
    return validateTargetSelection(opts, 'prime find moved selection away from target range', {
      primeResult,
      reason: 'replace aborted before mutation because find navigation selected a different range'
    });
  }

  function validateCurrentSelectionBeforeReplace(opts) {
    const obj = opts && opts.annotatedObj;
    if (!obj || shouldSkipTargetSelectionVerification(opts)) return Promise.resolve(null);
    return validateTargetSelection(opts, 'replace target selection is not the expected range', {
      reason: 'replace aborted before mutation because the currently active find match is not proven to be the target range'
    });
  }

  function shouldSkipTargetSelectionVerification(opts) {
    return opts && (opts.verifyTargetSelection === false || opts.verifyPrimeSelection === false);
  }

  function validateTargetSelection(opts, message, extraDebug) {
    const obj = opts && opts.annotatedObj;
    if (!obj) return Promise.resolve(null);
    const expectedStart = Number(opts.expectedStart);
    const expectedEnd = Number(opts.expectedEnd);
    const findText = typeof opts.findText === 'string' ? opts.findText : '';
    if (!Number.isFinite(expectedStart) || !Number.isFinite(expectedEnd)) return Promise.resolve(null);
    return getSelection(obj).then(selection => {
      const first = Array.isArray(selection) && selection.length ? selection[0] : null;
      const selectedStart = first && Number(first.start);
      const selectedEnd = first && Number(first.end);
      const exact = selectedStart === expectedStart && selectedEnd === expectedEnd;
      if (exact) {
        return { ok: true, mode: 'exact-range', selection };
      }
      const error = new Error(message);
      error.preventFallback = true;
      error.debug = {
        expectedStart,
        expectedEnd,
        findText,
        selection,
        reason: extraDebug && extraDebug.reason || ''
      };
      if (extraDebug && extraDebug.primeResult !== undefined) error.debug.primeResult = extraDebug.primeResult;
      throw error;
    });
  }

  function runFindNavigationAction(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const id = typeof opts.primeActionId === 'string' ? opts.primeActionId : 'docs-find-next';
    const allowed = ['docs-find', 'docs-find-next', 'docs-find-previous'];
    if (allowed.indexOf(id) === -1) throw new Error('unsupported find prime action: ' + id);
    return waitForKnownAction(id, Object.assign({}, opts, {
      actionWaitMs: opts.primeWaitMs !== undefined ? opts.primeWaitMs : opts.actionWaitMs,
      actionPollMs: opts.primePollMs !== undefined ? opts.primePollMs : opts.actionPollMs
    })).then(waitResult => {
      const registry = getDocsActionRegistryInfo();
      const getAction = registry.getAction;
      const before = waitResult.summary || summarizeKnownFindAction(id, registry);
      if (!before.exists) throw new Error('find prime action unavailable: ' + id);
      if (before.enabled === false) {
        const error = new Error('find prime action disabled: ' + id);
        error.debug = waitResult;
        throw error;
      }
      const action = getAction(id);
      const executor = executeDocsAction(action, id);
      const afterDelayMs = clampNumber(opts.primeAfterDelayMs, 180, 0, 2000);
      return delay(afterDelayMs).then(() => ({
        ok: true,
        id,
        executor,
        executed: true,
        waitResult: {
          pollCount: waitResult.pollCount,
          elapsedMs: waitResult.elapsedMs
        },
        before,
        after: summarizeKnownFindAction(id, registry),
        activeElement: summarizeElement(document.activeElement)
      }));
    });
  }

  function applyInternalTextActionOnce(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const findText = typeof opts.findText === 'string' ? opts.findText : '';
    const replaceText = typeof opts.replaceText === 'string' ? opts.replaceText : '';
    if (!findText) throw new Error('findText is required');
    if (opts.confirmMutation !== true) {
      return preflightInternalTextAction(opts, findText, replaceText).then(preflight => ({
        kind: 'toytype:internal-text-action-result',
        applied: false,
        documentMutated: false,
        requiresConfirmMutation: true,
        requested: { findText, replaceText },
        preflight,
        note: 'Pass confirmMutation:true to run Google Docs internal text action.'
      }));
    }

    let annotatedObj = null;
    let beforeText = null;
    let beforeTextSource = 'model';
    let beforeSelection = null;
    let selectionResult = null;
    let selectionSettle = null;
    let selectionBeforeApply = null;
    const actionId = typeof opts.internalTextActionId === 'string'
      ? opts.internalTextActionId
      : 'docstext-insert-characters';
    // 단계별 소요 시간 — 어느 구간이 느린지 결과/콘솔에서 바로 읽을 수 있게 기록한다.
    const phaseStartedAt = Date.now();
    let phaseMark = phaseStartedAt;
    const phaseTimings = {};
    function markPhase(name) {
      const now = Date.now();
      phaseTimings[name] = now - phaseMark;
      phaseMark = now;
    }

    return getAnnotatedTextObject(opts).then(obj => {
      markPhase('annotatedObjectMs');
      annotatedObj = obj;
      // 호출 측(콘텐트 스크립트)이 방금 사전 재스캔으로 받아간 모델 텍스트를 그대로 넘기면
      // 전체 텍스트 재취득 1회를 생략한다. 대상 슬라이스 검사·선택 검증·사후 검증은 동일하게 수행.
      const known = typeof opts.knownBeforeText === 'string' && opts.knownBeforeText.length > 0
        ? opts.knownBeforeText
        : null;
      if (known) beforeTextSource = 'caller';
      return (known ? Promise.resolve(known) : getText(obj)).then(text => {
        markPhase('beforeTextMs');
        beforeText = text;
        return getSelection(obj);
      }).then(selection => {
        markPhase('beforeSelectionMs');
        beforeSelection = selection;
        const start = Number(opts.start);
        const end = Number(opts.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
          throw internalTextActionError('target range is required for internal text action', {
            requested: { findText, replaceText, start: opts.start, end: opts.end },
            beforeSelection
          }, false);
        }
        const beforeSelected = beforeText.slice(start, end);
        if (beforeSelected !== findText) {
          const error = internalTextActionError('target text no longer matches before apply', {
            requested: { findText, replaceText, start, end },
            beforeSelected,
            beforeWindow: summarizeTextWindowForDebug(beforeText, beforeText, { start, end })
          }, false);
          error.preventFallback = true;
          throw error;
        }
        return setSelection(obj, start, end).then(result => {
          markPhase('setSelectionMs');
          selectionResult = result;
          focusDocsEditor();
          return waitForSelectionRange(obj, start, end, opts);
        });
      }).then(settle => {
        markPhase('selectionSettleMs');
        selectionSettle = settle ? { matched: settle.matched, pollCount: settle.pollCount, elapsedMs: settle.elapsedMs } : null;
        return getSelection(obj);
      }).then(selection => {
        selectionBeforeApply = selection;
        return validateTargetSelection({
          annotatedObj,
          expectedStart: Number(opts.start),
          expectedEnd: Number(opts.end),
          findText,
          verifyTargetSelection: opts.verifyTargetSelection
        }, 'internal text action target selection is not the expected range', {
          reason: 'internal text action aborted before mutation because the active selection is not proven to be the target range'
        }).then(validation => {
          markPhase('validateSelectionMs');
          return validation;
        });
      });
    }).then(selectionValidation => {
      // Promise.resolve().then() 래핑 필수: runInternalInsertCharactersAction은
      // 레지스트리 부재 등을 동기 throw 하는데, 동기 예외는 .catch(폴백 진입점)를
      // 건너뛰어 beforeinput 폴백이 영영 실행되지 않는다.
      return Promise.resolve().then(() => {
        return runInternalInsertCharactersAction(replaceText, actionId, opts);
      }).catch(actionError => {
        if (opts.directTextEventFallback === false || !canFallbackToTextEventTarget(actionError)) throw actionError;
        return runInternalTextEventTargetInsert(annotatedObj, beforeText, findText, replaceText, opts, actionError);
      }).then(actionResult => {
        markPhase('dispatchMs');
        const verifyPromise = delay(clampNumber(opts.directAfterDelayMs, 0, 0, 2000)).then(() => {
          return waitForVerifiedTextAfterReplace(annotatedObj, beforeText, opts, findText, replaceText);
        });

        // 지연 검증: 디스패치+선택 검증이 끝난 시점에 즉시 응답하고,
        // 텍스트 검증은 계속 진행해 결과를 별도 메시지(typo-radar:apply-verify-result)로 알린다.
        if (opts.deferVerification === true) {
          phaseTimings.totalMs = Date.now() - phaseStartedAt;
          verifyPromise.then(waitResult => {
            const verified = waitResult.verification && waitResult.verification.ok === true;
            postApplyVerifyResult(opts, {
              ok: true,
              verified,
              verification: waitResult.verification,
              waitResult: {
                pollCount: waitResult.pollCount,
                elapsedMs: waitResult.elapsedMs,
                changed: waitResult.text !== beforeText
              },
              // 검증 통과 시 검증에 쓴 본문을 같이 넘겨 콘텐트 측 재스캔이 재취득 없이 돌게 한다.
              afterText: verified ? waitResult.text : undefined,
              requested: { findText, replaceText, start: Number(opts.start), end: Number(opts.end) }
            });
          }).catch(error => {
            postApplyVerifyResult(opts, {
              ok: false,
              verified: false,
              errorName: error && error.name ? error.name : '',
              errorMessage: error && error.message ? String(error.message).slice(0, 500) : String(error).slice(0, 500),
              debug: error && error.debug !== undefined ? safeJsonClone(error.debug, 4000) : undefined,
              requested: { findText, replaceText, start: Number(opts.start), end: Number(opts.end) }
            });
          });
          return {
            kind: 'toytype:internal-text-action-result',
            applied: true,
            dispatched: true,
            verificationDeferred: true,
            documentMutated: null,
            verified: null,
            requested: { findText, replaceText },
            actionResult,
            beforeTextSource,
            beforeSelection,
            selectionResult,
            selectionSettle,
            selectionBeforeApply,
            selectionValidation,
            phaseTimings
          };
        }

        return verifyPromise.then(waitResult => {
          markPhase('verifyWaitMs');
          const afterText = waitResult.text;
          const verification = waitResult.verification;
          return getSelection(annotatedObj).catch(() => null).then(selectionAfterApply => {
            phaseTimings.totalMs = Date.now() - phaseStartedAt;
            const result = {
              kind: 'toytype:internal-text-action-result',
              applied: true,
              documentMutated: beforeText !== afterText,
              verified: verification.ok,
              verification,
              waitResult: {
                pollCount: waitResult.pollCount,
                elapsedMs: waitResult.elapsedMs,
                changed: beforeText !== afterText
              },
              requested: { findText, replaceText },
              actionResult,
              beforeTextSource,
              beforeSelection,
              selectionResult,
              selectionSettle,
              selectionBeforeApply,
              selectionAfterApply,
              selectionValidation,
              phaseTimings
            };
            if (verification.ok !== true) {
              throwInternalTextActionVerificationError(result, beforeText, afterText, opts);
            }
            return result;
          });
        });
      });
    }).catch(error => {
      if (error && error.preventFallback) throw error;
      const err = error instanceof Error ? error : new Error(String(error || 'internal text action failed'));
      if (err.debug === undefined) {
        err.debug = {
          requested: { findText, replaceText, start: opts.start, end: opts.end },
          actionId,
          beforeSelection,
          selectionResult,
          selectionBeforeApply
        };
      }
      if (err.debug && typeof err.debug === 'object' && err.debug.phaseTimings === undefined) {
        try { err.debug.phaseTimings = phaseTimings; } catch (e) { /* best effort */ }
      }
      throw err;
    });
  }

  function postApplyVerifyResult(opts, payload) {
    try {
      window.postMessage(Object.assign({
        kind: 'typo-radar:apply-verify-result',
        requestId: opts && opts.requestId ? opts.requestId : null,
        completedAt: Date.now()
      }, payload), '*');
    } catch (e) { /* best effort */ }
  }

  // 읽기 전용 프로파일: annotated 객체 해석·getText·getSelection의 실제 지연을 측정한다.
  // 어느 원시 호출이 느린지(스로틀·문서 크기 비례 여부) 판단하는 연구용 프로브.
  function profileModelOps(data) {
    const out = {
      kind: 'toytype:model-ops-profile',
      timestamp: new Date().toISOString(),
      url: location.href,
      steps: [],
      annotatedMethods: [],
      insertAction: null
    };
    function timed(name, fn) {
      const t0 = Date.now();
      return Promise.resolve().then(fn).then(value => {
        out.steps.push({ name, ms: Date.now() - t0, ok: true, info: value === undefined ? null : value });
      }).catch(error => {
        out.steps.push({ name, ms: Date.now() - t0, ok: false, error: shortErrorMessage(error) });
      });
    }
    cachedAnnotatedObj = null; // cold 해석 시간 측정을 위해 캐시 비움
    let obj = null;
    return timed('annotatedObjectCold', () => getAnnotatedTextObject(data).then(o => { obj = o; return null; }))
      .then(() => timed('annotatedObjectWarm', () => getAnnotatedTextObject(data).then(() => null)))
      .then(() => {
        if (obj) out.annotatedMethods = probeKeys(obj).slice(0, 80);
        return timed('getText1', () => obj ? getText(obj).then(t => ({ length: t.length })) : Promise.reject(new Error('no annotated object')));
      })
      .then(() => timed('getText2', () => getText(obj).then(t => ({ length: t.length }))))
      .then(() => timed('getText3', () => getText(obj).then(t => ({ length: t.length }))))
      .then(() => timed('getSelection1', () => getSelection(obj)))
      .then(() => timed('getSelection2', () => getSelection(obj)))
      .then(() => timed('insertActionSummary', () => {
        const summary = summarizeKnownFindAction('docstext-insert-characters', getDocsActionRegistryInfo());
        out.insertAction = summary;
        return { exists: summary.exists, enabled: summary.enabled, error: summary.error };
      }))
      .then(() => out);
  }

  function canFallbackToTextEventTarget(error) {
    if (!error) return false;
    const message = error.message ? String(error.message) : '';
    return /internal text action unavailable|internal text action executor unavailable|docs action registry unavailable/.test(message);
  }

  function runInternalInsertCharactersAction(text, actionId, opts) {
    const allowed = ['docstext-insert-characters'];
    if (allowed.indexOf(actionId) === -1) {
      throw internalTextActionError('unsupported internal text action: ' + actionId, { actionId }, false);
    }
    const registry = getDocsActionRegistryInfo();
    const getAction = registry.getAction;
    const initial = summarizeKnownFindAction(actionId, registry, opts);
    if (typeof getAction !== 'function') {
      internalActionUnavailableSeen = true;
      throw internalTextActionError('docs action registry unavailable', { actionId, before: initial }, false);
    }
    const focusBeforeWait = focusDocsEditor();
    // 이 페이지에서 액션이 한 번도 가용한 적 없으면 대기 없이 1회 확인만 한다 (뒤에 폴백이 있다).
    const skipActionWait = internalActionUnavailableSeen && !internalActionEverSucceeded;
    const waitOptions = Object.assign({}, opts, {
      actionWaitMs: skipActionWait
        ? 0
        : (opts.directActionWaitMs !== undefined ? opts.directActionWaitMs : opts.actionWaitMs),
      actionPollMs: opts.directActionPollMs !== undefined ? opts.directActionPollMs : opts.actionPollMs
    });
    return waitForKnownAction(actionId, waitOptions).then(waitResult => {
      const before = waitResult.summary || summarizeKnownFindAction(actionId, registry, opts);
      if (!before.exists) {
        internalActionUnavailableSeen = true;
        throw internalTextActionError('internal text action unavailable', {
          actionId,
          initial,
          waitResult
        }, false);
      }
      if (waitResult.timedOut || before.enabled === false) {
        internalActionUnavailableSeen = true;
        throw internalTextActionError('internal text action disabled before dispatch', {
          actionId,
          initial,
          waitResult,
          before
        }, false);
      }
      let action = null;
      try {
        action = getAction(actionId);
      } catch (e) {
        throw internalTextActionError('internal text action lookup failed', {
          actionId,
          before,
          errorName: e && e.name ? e.name : '',
          errorMessage: e && e.message ? String(e.message).slice(0, 300) : String(e).slice(0, 300)
        }, false);
      }
      if (!action || typeof action.Zf !== 'function') {
        throw internalTextActionError('internal text action executor unavailable', {
          actionId,
          before,
          action: summarizeActionObject(action, opts)
        }, false);
      }
      const Payload = safeGetPath('_.fSd');
      if (typeof Payload !== 'function') {
        throw internalTextActionError('internal text action payload constructor unavailable', {
          actionId,
          before,
          payloadPath: '_.fSd'
        }, false);
      }
      let payload;
      try {
        payload = new Payload(text);
      } catch (e) {
        throw internalTextActionError('internal text action payload creation failed', {
          actionId,
          before,
          errorName: e && e.name ? e.name : '',
          errorMessage: e && e.message ? String(e.message).slice(0, 300) : String(e).slice(0, 300)
        }, false);
      }
      let dispatchReturn;
      const focusBeforeDispatch = focusDocsEditor();
      try {
        dispatchReturn = action.Zf(payload, null);
      } catch (e) {
        throw internalTextActionError('internal text action dispatch failed', {
          actionId,
          before,
          focusBeforeWait,
          focusBeforeDispatch,
          errorName: e && e.name ? e.name : '',
          errorMessage: e && e.message ? String(e.message).slice(0, 300) : String(e).slice(0, 300),
          stack: e && e.stack ? String(e.stack).slice(0, 1000) : ''
        }, false);
      }
      internalActionEverSucceeded = true;
      return {
        actionId,
        registryPath: registry.path || '',
        executor: 'Zf',
        payloadCtor: '_.fSd',
        replacementLength: text.length,
        initial,
        waitResult: summarizeActionWaitForLog(waitResult),
        before,
        focusBeforeWait,
        focusBeforeDispatch,
        dispatchReturn: summarizePrimitiveReturn(dispatchReturn),
        after: summarizeKnownFindAction(actionId, registry, opts)
      };
    });
  }

  function runInternalTextEventTargetInsert(annotatedObj, beforeText, findText, replaceText, opts, actionError) {
    const sweepStartedAt = Date.now();
    const focusBeforeDispatch = focusDocsEditor();
    const targetInfo = resolveTextEventTargets();
    const dispatches = [];
    let handled = null;
    let okDispatch = null;
    let sequence = Promise.resolve(null);
    const inputTypes = Array.isArray(opts && opts.textEventInputTypes) && opts.textEventInputTypes.length
      ? opts.textEventInputTypes.map(String)
      : ['insertReplacementText', 'insertText'];
    // defaultPrevented(독스가 이벤트를 소비)된 디스패치만 길게 기다리고,
    // 처리되지 않은 미스 조합은 퀵 프로브로 짧게만 확인한다 — 스윕 시간의 주범 제거.
    const handledProbeWaitMs = clampNumber(opts && opts.textEventProbeWaitMs, 600, 50, 1500);
    const quickProbeWaitMs = clampNumber(opts && opts.textEventQuickProbeMs, 80, 0, 1500);

    // (타깃 × inputType) 조합 — 직전 성공 조합을 맨 앞으로 당긴다.
    const combos = [];
    for (const target of targetInfo.targets) {
      if (!target || !target.node) continue;
      for (const inputType of inputTypes) combos.push({ target, inputType });
    }
    if (cachedTextEventCombo) {
      combos.sort((a, b) => comboCacheRank(a) - comboCacheRank(b));
    }

    for (const combo of combos) {
      const target = combo.target;
      const inputType = combo.inputType;
      sequence = sequence.then(success => {
        if (success) return success;
        try {
          if (typeof target.node.focus === 'function') target.node.focus();
        } catch (e) {
          dispatches.push({
            target: target.label,
            event: 'focus',
            ok: false,
            error: shortErrorMessage(e)
          });
        }
        const dispatch = dispatchBeforeInput(target.node, inputType, replaceText);
        dispatch.target = target.label;
        dispatch.targetSummary = summarizeElement(target.node);
        dispatch.sinceSweepStartMs = Date.now() - sweepStartedAt;
        dispatches.push(dispatch);
        if (dispatch.defaultPrevented && !handled) handled = dispatch;
        if (dispatch.ok && !okDispatch) okDispatch = dispatch;
        if (!dispatch.ok) return null;
        const probeWaitMs = dispatch.defaultPrevented ? handledProbeWaitMs : quickProbeWaitMs;
        return waitForTextChangeProbe(annotatedObj, beforeText, Object.assign({}, opts, {
          textEventProbeWaitMs: probeWaitMs
        })).then(probe => {
          dispatch.textProbe = {
            pollCount: probe.pollCount,
            elapsedMs: probe.elapsedMs,
            changed: probe.text !== beforeText
          };
          if (probe.text === beforeText) return null;
          const verification = verifyTextReplacement(beforeText, probe.text, opts, findText, replaceText);
          dispatch.textProbe.verification = verification;
          cachedTextEventCombo = { label: target.label, inputType };
          return {
            actionId: 'docs-texteventtarget-beforeinput',
            executor: 'dispatchEvent',
            inputType,
            target: target.label,
            handled: !!dispatch.defaultPrevented,
            replacementLength: replaceText.length,
            sweepMs: Date.now() - sweepStartedAt,
            comboCount: combos.length,
            focusBeforeDispatch,
            targetDocument: targetInfo.documentSummary,
            dispatches,
            directActionError: summarizeErrorObject(actionError),
            probeResult: {
              pollCount: probe.pollCount,
              elapsedMs: probe.elapsedMs,
              changed: true,
              verification
            }
          };
        });
      });
    }

    return sequence.then(success => {
      if (success) return success;
      if (handled || okDispatch) {
        return {
          actionId: 'docs-texteventtarget-beforeinput',
          executor: 'dispatchEvent',
          inputType: (handled || okDispatch).inputType,
          handled: !!handled,
          replacementLength: replaceText.length,
          sweepMs: Date.now() - sweepStartedAt,
          comboCount: combos.length,
          focusBeforeDispatch,
          targetDocument: targetInfo.documentSummary,
          dispatches,
          directActionError: summarizeErrorObject(actionError)
        };
      }

      throw internalTextActionError('text event target insert was not handled', {
        actionId: 'docs-texteventtarget-beforeinput',
        focusBeforeDispatch,
        targetDocument: targetInfo.documentSummary,
        targets: targetInfo.targets.map(target => ({
          label: target.label,
          summary: summarizeElement(target.node)
        })),
        dispatches,
        directActionError: summarizeErrorObject(actionError)
      }, false);
    });
  }

  function comboCacheRank(combo) {
    if (!cachedTextEventCombo) return 1;
    return combo.target.label === cachedTextEventCombo.label && combo.inputType === cachedTextEventCombo.inputType ? 0 : 1;
  }

  function resolveTextEventTargets() {
    const iframe = document.querySelector('iframe.docs-texteventtarget-iframe');
    const result = {
      documentSummary: {
        iframe: summarizeElement(iframe),
        accessible: false,
        activeElement: null
      },
      targets: []
    };
    let doc = null;
    try {
      doc = iframe && iframe.contentDocument || null;
      result.documentSummary.accessible = !!doc;
      result.documentSummary.activeElement = doc ? summarizeElement(doc.activeElement) : null;
    } catch (e) {
      result.documentSummary.error = shortErrorMessage(e);
      doc = null;
    }
    if (!doc) return result;
    const add = (label, node) => {
      if (!node || result.targets.some(item => item.node === node)) return;
      result.targets.push({ label, node });
    };
    add('#docs-texteventtarget-descendant', doc.getElementById('docs-texteventtarget-descendant'));
    add('iframe.activeElement', doc.activeElement);
    add('iframe.body', doc.body);
    const selectors = [
      '[contenteditable="true"]',
      '[tabindex]',
      '[role="textbox"]',
      'textarea',
      'input',
      'div',
      'body'
    ];
    try {
      const nodes = Array.prototype.slice.call(doc.querySelectorAll(selectors.join(','))).slice(0, 20);
      nodes.forEach((node, index) => add('iframe.query[' + index + ']', node));
    } catch (e) {
      result.documentSummary.queryError = shortErrorMessage(e);
    }
    return result;
  }

  function dispatchBeforeInput(target, inputType, text) {
    const result = {
      inputType,
      ok: false,
      dispatchReturn: null,
      defaultPrevented: false,
      error: ''
    };
    try {
      const view = target.ownerDocument && target.ownerDocument.defaultView || window;
      const InputEventCtor = view.InputEvent || InputEvent;
      const event = new InputEventCtor('beforeinput', {
        bubbles: true,
        cancelable: true,
        composed: true,
        inputType,
        data: text
      });
      result.dispatchReturn = target.dispatchEvent(event);
      result.defaultPrevented = event.defaultPrevented;
      result.ok = true;
      return result;
    } catch (e) {
      result.error = shortErrorMessage(e);
    }
    try {
      const doc = target.ownerDocument || document;
      const event = doc.createEvent('Event');
      event.initEvent('beforeinput', true, true);
      defineEventValue(event, 'inputType', inputType);
      defineEventValue(event, 'data', text);
      result.dispatchReturn = target.dispatchEvent(event);
      result.defaultPrevented = event.defaultPrevented;
      result.ok = true;
      result.fallbackEvent = true;
    } catch (e) {
      result.error = result.error ? result.error + ' | ' + shortErrorMessage(e) : shortErrorMessage(e);
    }
    return result;
  }

  function defineEventValue(event, key, value) {
    try {
      Object.defineProperty(event, key, { configurable: true, enumerable: true, get: () => value });
    } catch (e) {
      try { event[key] = value; } catch (ignored) { /* best effort */ }
    }
  }

  function summarizeErrorObject(error) {
    if (!error) return null;
    return {
      name: error.name || '',
      message: error.message ? String(error.message).slice(0, 500) : String(error).slice(0, 500),
      debug: error.debug !== undefined ? safeJsonClone(error.debug, 5000) : undefined
    };
  }

  function preflightInternalTextAction(opts, findText, replaceText) {
    const actionId = typeof opts.internalTextActionId === 'string'
      ? opts.internalTextActionId
      : 'docstext-insert-characters';
    const registry = getDocsActionRegistryInfo();
    const Payload = safeGetPath('_.fSd');
    let action = null;
    let actionLookupError = null;
    if (typeof registry.getAction === 'function') {
      try {
        action = registry.getAction(actionId);
      } catch (e) {
        actionLookupError = {
          errorName: e && e.name ? e.name : '',
          errorMessage: e && e.message ? String(e.message).slice(0, 300) : String(e).slice(0, 300)
        };
      }
    }
    const result = {
      kind: 'toytype:internal-text-action-preflight',
      actionId,
      registryPath: registry.path || '',
      actionRegistryAvailable: typeof registry.getAction === 'function',
      actionObjectAvailable: !!action,
      actionLookupError,
      payloadCtorPath: '_.fSd',
      payloadCtorAvailable: typeof Payload === 'function',
      executor: {
        expected: 'Zf',
        available: !!(action && typeof action.Zf === 'function')
      },
      requested: { findText, replaceText, start: opts.start, end: opts.end },
      action: summarizeKnownFindAction(actionId, registry, opts),
      target: null,
      canAttempt: false,
      notes: [
        'Read-only preflight. It does not set selection, dispatch actions, or mutate the document.'
      ]
    };
    result.canAttempt = result.actionObjectAvailable === true &&
      result.executor.available === true &&
      result.payloadCtorAvailable === true;

    const start = Number(opts.start);
    const end = Number(opts.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
      result.target = { checked: false, reason: 'valid start/end not provided' };
      return Promise.resolve(result);
    }

    return getAnnotatedTextObject(opts).then(obj => {
      return getText(obj).then(text => {
        const selected = text.slice(start, end);
        result.target = {
          checked: true,
          start,
          end,
          textLength: text.length,
          selected,
          selectedLength: selected.length,
          matchesFindText: selected === findText
        };
        result.canAttempt = result.canAttempt && selected === findText;
        return result;
      });
    }).catch(error => {
      result.target = {
        checked: false,
        reason: 'annotated text unavailable',
        errorName: error && error.name ? error.name : '',
        errorMessage: error && error.message ? String(error.message).slice(0, 300) : String(error).slice(0, 300)
      };
      result.canAttempt = false;
      return result;
    });
  }

  function internalTextActionError(message, debug, preventFallback) {
    const error = new Error(message);
    error.debug = Object.assign({ phase: 'internalTextAction' }, debug || {});
    if (preventFallback === true) error.preventFallback = true;
    return error;
  }

  function throwInternalTextActionVerificationError(result, beforeText, afterText, opts) {
    const error = new Error('internal text action did not verify document update');
    error.preventFallback = !!result.documentMutated;
    error.debug = {
      phase: 'internalTextActionVerify',
      preventFallback: error.preventFallback,
      requested: result.requested,
      actionResult: result.actionResult,
      verification: result.verification,
      waitResult: result.waitResult,
      documentMutated: result.documentMutated,
      beforeSelection: result.beforeSelection,
      selectionResult: result.selectionResult,
      selectionBeforeApply: result.selectionBeforeApply,
      selectionAfterApply: result.selectionAfterApply,
      textWindow: summarizeTextWindowForDebug(beforeText, afterText, opts)
    };
    throw error;
  }

  function applyFindReplaceOnce(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const findText = typeof opts.findText === 'string' ? opts.findText : '';
    const replaceText = typeof opts.replaceText === 'string' ? opts.replaceText : '';
    if (!findText) throw new Error('findText is required');
    if (opts.confirmMutation !== true) {
      return Promise.resolve({
        kind: 'toytype:find-replace-once-result',
        clicked: false,
        documentMutated: false,
        requiresConfirmMutation: true,
        requested: { findText, replaceText },
        note: 'Pass confirmMutation:true to run one Google Docs replace action.'
      });
    }

    let annotatedObj = null;
    let beforeText = null;
    let beforeSelection = null;
    let selectionResult = null;
    let selectionRefreshResult = null;
    return getAnnotatedTextObject(opts).catch(() => null).then(obj => {
      annotatedObj = obj;
      return obj ? getText(obj).then(text => {
        beforeText = text;
        return getSelection(obj).then(selection => {
          beforeSelection = selection;
          if (Number.isFinite(Number(opts.start)) && Number.isFinite(Number(opts.end))) {
            return setSelection(obj, Number(opts.start), Number(opts.end)).then(result => {
              selectionResult = result;
              focusDocsEditor();
              return delay(120);
            });
          }
          return null;
        });
      }) : null;
    }).then(() => {
      return prepareFindReplaceUi(Object.assign({}, opts, { findText, replaceText, open: true }));
    }).then(prepareResult => {
      if (!prepareResult.fieldVerification || prepareResult.fieldVerification.ok !== true) {
        const error = new Error('find/replace field values not ready');
        error.preventFallback = true;
        error.debug = {
          requested: { findText, replaceText },
          fieldVerification: prepareResult.fieldVerification || null,
          fieldValuesAfterInput: prepareResult.fieldValuesAfterInput || null,
          fields: prepareResult.fields || null,
          inputEvents: prepareResult.inputEvents || null
        };
        throw error;
      }
      const readyWaitMs = clampNumber(opts.readyWaitMs, 300, 0, 3000);
      return refreshTargetSelectionBeforeReplace(annotatedObj, opts).then(result => {
        selectionRefreshResult = result;
        return delay(readyWaitMs);
      }).then(() => {
        return annotatedObj ? getSelection(annotatedObj) : null;
      }).then(selectionBeforeApply => executeReplaceOnce(Object.assign({}, opts, {
        annotatedObj,
        expectedStart: Number(opts.start),
        expectedEnd: Number(opts.end),
        findText
      })).then(clickResult => ({ selectionBeforeApply, clickResult })).catch(error => {
        throw augmentReplaceExecutionError(error, {
          requested: { findText, replaceText },
          beforeSelection,
          selectionResult,
          selectionRefreshResult,
          selectionBeforeApply,
          prepareResult
        });
      })).then(({ selectionBeforeApply, clickResult }) => {
        return delay(250).then(() => {
          if (!annotatedObj) {
            return {
              kind: 'toytype:find-replace-once-result',
              clicked: true,
              documentMutated: true,
              verified: null,
              requested: { findText, replaceText },
              beforeSelection,
              selectionBeforeApply,
              selectionResult,
              selectionRefreshResult,
              prepareResult,
              clickResult
            };
          }
          return waitForTextAfterReplace(annotatedObj, beforeText, opts).then(waitResult => {
            const afterText = waitResult.text;
            const verification = verifyTextReplacement(beforeText, afterText, opts, findText, replaceText);
            return getSelection(annotatedObj).catch(() => null).then(selectionAfterApply => {
              const result = {
                kind: 'toytype:find-replace-once-result',
                clicked: true,
                documentMutated: beforeText !== afterText,
                verified: verification.ok,
                verification,
                waitResult: {
                  pollCount: waitResult.pollCount,
                  elapsedMs: waitResult.elapsedMs,
                  changed: beforeText !== afterText
                },
                requested: { findText, replaceText },
                beforeSelection,
                selectionBeforeApply,
                selectionAfterApply,
                selectionResult,
                selectionRefreshResult,
                prepareResult,
                clickResult,
                finalFieldVerification: verifyFindReplaceFieldValues(findText, replaceText),
                finalKnownFindActions: probeKnownFindActions(opts)
              };
              if (verification.ok !== true) throwFindReplaceVerificationError(result, beforeText, afterText, opts);
              return result;
            });
          });
        });
      });
    });
  }

  function augmentReplaceExecutionError(error, context) {
    const err = error instanceof Error ? error : new Error(String(error || 'replace execution failed'));
    const existingDebug = err.debug !== undefined ? err.debug : undefined;
    err.debug = {
      phase: 'executeReplaceOnce',
      requested: context && context.requested || null,
      beforeSelection: context && context.beforeSelection || null,
      selectionResult: context && context.selectionResult || null,
      selectionRefreshResult: context && context.selectionRefreshResult || null,
      selectionBeforeApply: context && context.selectionBeforeApply || null,
      prepare: summarizePrepareResultForDebug(context && context.prepareResult),
      innerDebug: existingDebug !== undefined ? safeJsonClone(existingDebug, 5000) : undefined
    };
    return err;
  }

  function refreshTargetSelectionBeforeReplace(annotatedObj, opts) {
    if (!annotatedObj) return Promise.resolve(null);
    const start = Number(opts && opts.start);
    const end = Number(opts && opts.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return Promise.resolve(null);
    const mustPrime = opts && (opts.requirePrimeFindMatch === true || opts.primeFindMatch === 'always');
    const primeCursor = Math.max(0, start - 1);
    const selectionStart = mustPrime ? primeCursor : start;
    const selectionEnd = mustPrime ? primeCursor : end;
    const mode = mustPrime ? 'collapsed-before-prime' : 'target-range';
    return setSelection(annotatedObj, selectionStart, selectionEnd).then(result => {
      focusDocsEditor();
      return delay(120).then(() => getSelection(annotatedObj)).then(selection => ({
        mode,
        requestedStart: selectionStart,
        requestedEnd: selectionEnd,
        targetStart: start,
        targetEnd: end,
        result,
        selection
      }));
    });
  }

  function throwFindReplaceVerificationError(result, beforeText, afterText, opts) {
    const error = new Error('find/replace did not verify document update');
    error.preventFallback = true;
    error.debug = {
      requested: result.requested,
      verification: result.verification,
      waitResult: result.waitResult,
      documentMutated: result.documentMutated,
      beforeSelection: result.beforeSelection,
      selectionBeforeApply: result.selectionBeforeApply,
      selectionAfterApply: result.selectionAfterApply,
      selectionResult: result.selectionResult,
      selectionRefreshResult: result.selectionRefreshResult,
      prepare: summarizePrepareResultForDebug(result.prepareResult),
      click: summarizeClickResultForDebug(result.clickResult),
      finalFieldVerification: result.finalFieldVerification,
      finalReplaceAction: summarizeReplaceActionFromProbe(result.finalKnownFindActions),
      textWindow: summarizeTextWindowForDebug(beforeText, afterText, opts)
    };
    throw error;
  }

  function summarizePrepareResultForDebug(prepareResult) {
    if (!prepareResult) return null;
    return {
      requested: prepareResult.requested || null,
      fields: prepareResult.fields || null,
      fieldVerification: prepareResult.fieldVerification || null,
      fieldValuesAfterInput: prepareResult.fieldValuesAfterInput || null,
      inputEvents: prepareResult.inputEvents || null,
      actionRegistryPath: actionRegistryPathFromProbe(prepareResult.afterProbe && prepareResult.afterProbe.knownFindActions)
    };
  }

  function actionRegistryPathFromProbe(knownFindActions) {
    if (!Array.isArray(knownFindActions)) return '';
    const action = knownFindActions.find(item => item && item.registryPath) || null;
    return action ? action.registryPath : '';
  }

  function summarizeClickResultForDebug(clickResult) {
    if (!clickResult) return null;
    return safeJsonClone({
      kind: clickResult.kind,
      mode: clickResult.mode,
      id: clickResult.id,
      executor: clickResult.executor,
      executed: clickResult.executed,
      clicked: clickResult.clicked,
      documentMutated: clickResult.documentMutated,
      requiresConfirmMutation: clickResult.requiresConfirmMutation,
      primary: clickResult.primary,
      fallback: clickResult.fallback ? {
        kind: clickResult.fallback.kind,
        mode: clickResult.fallback.mode,
        clicked: clickResult.fallback.clicked,
        documentMutated: clickResult.fallback.documentMutated,
        waitResult: clickResult.fallback.waitResult,
        primeResult: clickResult.fallback.primeResult,
        primeValidation: clickResult.fallback.primeValidation,
        currentValidation: clickResult.fallback.currentValidation
      } : undefined,
      waitResult: clickResult.waitResult,
      firstWait: clickResult.firstWait,
      primeResult: clickResult.primeResult,
      primeValidation: clickResult.primeValidation,
      currentValidation: clickResult.currentValidation,
      before: clickResult.before,
      after: clickResult.after,
      activeElement: clickResult.activeElement
    }, 8000);
  }

  function summarizeReplaceActionFromProbe(knownFindActions) {
    const actions = knownFindActions && Array.isArray(knownFindActions.actions) ? knownFindActions.actions : knownFindActions;
    if (!Array.isArray(actions)) return null;
    return actions.find(action => action && action.id === 'docs-replace') || null;
  }

  function summarizeTextWindowForDebug(beforeText, afterText, opts) {
    const start = Number(opts && opts.start);
    const end = Number(opts && opts.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return {
        beforeLength: typeof beforeText === 'string' ? beforeText.length : null,
        afterLength: typeof afterText === 'string' ? afterText.length : null
      };
    }
    const from = Math.max(0, start - 40);
    const to = Math.min(typeof beforeText === 'string' ? beforeText.length : 0, end + 40);
    const afterTo = Math.min(typeof afterText === 'string' ? afterText.length : 0, start + 80);
    return {
      start,
      end,
      beforeLength: typeof beforeText === 'string' ? beforeText.length : null,
      afterLength: typeof afterText === 'string' ? afterText.length : null,
      beforeWindow: typeof beforeText === 'string' ? beforeText.slice(from, to) : '',
      afterWindow: typeof afterText === 'string' ? afterText.slice(from, afterTo) : ''
    };
  }

  function executeReplaceOnce(opts) {
    const strategy = typeof opts.replaceStrategy === 'string' ? opts.replaceStrategy : 'action';
    if (strategy === 'button') {
      return clickFindReplaceButton({
        mode: 'replace',
        confirmMutation: true,
        buttonWaitMs: opts.buttonWaitMs,
        buttonPollMs: opts.buttonPollMs,
        deepActions: opts.deepActions === true,
        actionKeyLimit: opts.actionKeyLimit,
        actionSourceLimit: opts.actionSourceLimit,
        primeFindMatch: opts.primeFindMatch,
        primeActionId: opts.primeActionId,
        primeWaitMs: opts.primeWaitMs,
        primePollMs: opts.primePollMs,
        primeAfterDelayMs: opts.primeAfterDelayMs,
        requirePrimeFindMatch: opts.requirePrimeFindMatch,
        annotatedObj: opts.annotatedObj,
        expectedStart: opts.expectedStart,
        expectedEnd: opts.expectedEnd,
        findText: opts.findText,
        verifyTargetSelection: opts.verifyTargetSelection,
        verifyPrimeSelection: opts.verifyPrimeSelection
      });
    }
    return runFindReplaceMutationAction({
      mode: 'replace',
      confirmMutation: true,
      actionWaitMs: opts.actionWaitMs,
      actionPollMs: opts.actionPollMs,
      primeFindMatch: opts.primeFindMatch,
      primeActionId: opts.primeActionId,
      primeWaitMs: opts.primeWaitMs,
      primePollMs: opts.primePollMs,
      primeAfterDelayMs: opts.primeAfterDelayMs,
      requirePrimeFindMatch: opts.requirePrimeFindMatch,
      annotatedObj: opts.annotatedObj,
      expectedStart: opts.expectedStart,
      expectedEnd: opts.expectedEnd,
      findText: opts.findText,
      verifyTargetSelection: opts.verifyTargetSelection,
      verifyPrimeSelection: opts.verifyPrimeSelection
    }).catch(actionError => {
      if (opts.fallbackToButton === false || actionError.preventFallback) throw actionError;
      return clickFindReplaceButton({
        mode: 'replace',
        confirmMutation: true,
        buttonWaitMs: opts.buttonWaitMs,
        buttonPollMs: opts.buttonPollMs,
        deepActions: opts.deepActions === true,
        actionKeyLimit: opts.actionKeyLimit,
        actionSourceLimit: opts.actionSourceLimit,
        primeFindMatch: opts.primeFindMatch,
        primeActionId: opts.primeActionId,
        primeWaitMs: opts.primeWaitMs,
        primePollMs: opts.primePollMs,
        primeAfterDelayMs: opts.primeAfterDelayMs,
        requirePrimeFindMatch: opts.requirePrimeFindMatch,
        annotatedObj: opts.annotatedObj,
        expectedStart: opts.expectedStart,
        expectedEnd: opts.expectedEnd,
        findText: opts.findText,
        verifyTargetSelection: opts.verifyTargetSelection,
        verifyPrimeSelection: opts.verifyPrimeSelection
      }).then(buttonResult => ({
        kind: 'toytype:find-replace-fallback-result',
        primary: {
          strategy: 'action',
          errorName: actionError && actionError.name ? actionError.name : '',
          errorMessage: actionError && actionError.message ? String(actionError.message).slice(0, 500) : String(actionError).slice(0, 500),
          debug: actionError && actionError.debug !== undefined ? safeJsonClone(actionError.debug, 4000) : undefined
        },
        fallback: buttonResult,
        executed: !!buttonResult.clicked,
        documentMutated: !!buttonResult.documentMutated
      }));
    });
  }

  function waitForTextAfterReplace(annotatedObj, beforeText, opts) {
    const started = Date.now();
    const timeoutMs = clampNumber(opts && opts.mutationWaitMs, 3000, 250, 15000);
    const intervalMs = clampNumber(opts && opts.mutationPollMs, 150, 50, 1000);
    let pollCount = 0;

    function poll() {
      pollCount++;
      return getText(annotatedObj).then(text => {
        if (text !== beforeText || Date.now() - started >= timeoutMs) {
          return {
            text,
            pollCount,
            elapsedMs: Date.now() - started
          };
        }
        return delay(intervalMs).then(poll);
      });
    }

    return poll();
  }

  // 고정 settle 대기 대신 선택이 목표 범위에 도달했는지 폴링 — 대부분 첫 폴에서 끝난다.
  // 시간 안에 도달하지 못해도 여기서 실패시키지 않는다. 이어지는 validateTargetSelection이
  // 기존과 동일하게 최종 판정한다.
  function waitForSelectionRange(annotatedObj, start, end, opts) {
    const started = Date.now();
    const timeoutMs = clampNumber(opts && opts.directSelectionSettleMs, 300, 0, 2000);
    const intervalMs = clampNumber(opts && opts.directSelectionPollMs, 25, 10, 250);
    let pollCount = 0;

    function poll() {
      pollCount++;
      return getSelection(annotatedObj).then(selection => {
        const first = Array.isArray(selection) && selection.length ? selection[0] : null;
        const matched = !!first && Number(first.start) === start && Number(first.end) === end;
        if (matched || Date.now() - started >= timeoutMs) {
          return { matched, selection, pollCount, elapsedMs: Date.now() - started };
        }
        return delay(intervalMs).then(poll);
      });
    }

    return poll();
  }

  // "텍스트가 변했는지"가 아니라 교체 검증이 통과할 때까지 폴링한다.
  // 삭제→삽입이 두 단계 모델 상태로 보이는 순간을 변경 완료로 오인하지 않고,
  // 검증이 통과하는 즉시 빠져나온다. 타임아웃 시 마지막 검증 결과를 그대로 돌려준다.
  function waitForVerifiedTextAfterReplace(annotatedObj, beforeText, opts, findText, replaceText) {
    const started = Date.now();
    const timeoutMs = clampNumber(opts && opts.mutationWaitMs, 3000, 250, 15000);
    const intervalMs = clampNumber(opts && opts.mutationPollMs, 50, 25, 1000);
    let pollCount = 0;

    function poll() {
      pollCount++;
      return getText(annotatedObj).then(text => {
        const verification = verifyTextReplacement(beforeText, text, opts, findText, replaceText);
        if (verification.ok === true || Date.now() - started >= timeoutMs) {
          return { text, verification, pollCount, elapsedMs: Date.now() - started };
        }
        return delay(intervalMs).then(poll);
      });
    }

    return poll();
  }

  function waitForTextChangeProbe(annotatedObj, beforeText, opts) {
    const started = Date.now();
    const timeoutMs = clampNumber(opts && opts.textEventProbeWaitMs, 260, 50, 1500);
    const intervalMs = clampNumber(opts && opts.textEventProbePollMs, 40, 20, 250);
    let pollCount = 0;

    function poll() {
      pollCount++;
      return getText(annotatedObj).then(text => {
        if (text !== beforeText || Date.now() - started >= timeoutMs) {
          return {
            text,
            pollCount,
            elapsedMs: Date.now() - started
          };
        }
        return delay(intervalMs).then(poll);
      });
    }

    return poll();
  }

  function verifyTextReplacement(beforeText, afterText, opts, findText, replaceText) {
    if (typeof beforeText !== 'string' || typeof afterText !== 'string') {
      return { ok: null, reason: 'text unavailable' };
    }
    const start = Number(opts && opts.start);
    const end = Number(opts && opts.end);
    if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start) {
      const beforeSelected = beforeText.slice(start, end);
      const afterAtStart = afterText.slice(start, start + replaceText.length);
      return {
        ok: beforeSelected === findText && afterAtStart === replaceText,
        mode: 'range',
        start,
        end,
        beforeSelected,
        afterAtStart,
        beforeLength: beforeText.length,
        afterLength: afterText.length
      };
    }
    const beforeCount = countOccurrences(beforeText, findText);
    const afterFindCount = countOccurrences(afterText, findText);
    const afterReplaceCount = countOccurrences(afterText, replaceText);
    return {
      ok: beforeText !== afterText && afterFindCount < beforeCount,
      mode: 'count',
      beforeFindCount: beforeCount,
      afterFindCount,
      afterReplaceCount,
      beforeLength: beforeText.length,
      afterLength: afterText.length
    };
  }

  function countOccurrences(text, needle) {
    if (!needle) return 0;
    let count = 0;
    let index = 0;
    while ((index = text.indexOf(needle, index)) !== -1) {
      count++;
      index += Math.max(1, needle.length);
    }
    return count;
  }

  function waitForFindReplaceButton(mode, opts) {
    const started = Date.now();
    const timeoutMs = clampNumber(opts && opts.buttonWaitMs, 2500, 0, 15000);
    const intervalMs = clampNumber(opts && opts.buttonPollMs, 120, 50, 1000);
    let pollCount = 0;
    let lastButtons = [];

    function poll() {
      pollCount++;
      const nodes = resolveFindReplaceButtonNodes();
      lastButtons = nodes.all.slice(0, 12).map(item => item.summary);
      if (nodes[mode] || Date.now() - started >= timeoutMs) {
        return {
          target: nodes[mode] || null,
          pollCount,
          elapsedMs: Date.now() - started,
          lastButtons
        };
      }
      return delay(intervalMs).then(poll);
    }

    return poll();
  }

  function resolveFindReplaceButtonNodes() {
    const nodes = Array.prototype.slice.call(document.querySelectorAll('button, [role="button"], [aria-label], [title]'))
      .filter(isVisibleElement)
      .map(node => ({ node, summary: summarizeButtonCandidate(node) }))
      .filter(item => item.summary.roleGuess)
      .filter(item => !item.summary.disabled)
      .sort((a, b) => (b.summary.roleScore - a.summary.roleScore) ||
        ((a.summary.rect && a.summary.rect.y || 0) - (b.summary.rect && b.summary.rect.y || 0)));
    const out = { replace: null, replaceAll: null, next: null, previous: null, close: null, all: nodes };
    for (const item of nodes) {
      const role = item.summary.roleGuess;
      if (role in out && !out[role]) out[role] = item;
    }
    return out;
  }

  function summarizeButtonCandidate(node) {
    const summary = summarizeElement(node);
    summary.kind = 'button';
    summary.name = readableElementName(node);
    summary.value = readableElementValue(node);
    summary.nearText = nearbyText(node);
    summary.disabled = isDisabledElement(node);
    const role = classifyFindReplaceButton(summary);
    summary.roleGuess = role.role;
    summary.roleScore = role.score;
    return summary;
  }

  function guessFindReplaceButtons(buttons) {
    const out = { replace: null, replaceAll: null, next: null, previous: null, close: null, all: [] };
    const ranked = (buttons || [])
      .map(item => Object.assign({}, item, classifyFindReplaceButton(item)))
      .filter(item => item.role)
      .sort((a, b) => (b.score - a.score) || ((a.rect && a.rect.y || 0) - (b.rect && b.rect.y || 0)));
    out.all = ranked.slice(0, 20);
    for (const item of ranked) {
      if (item.role in out && !out[item.role]) out[item.role] = item;
    }
    return out;
  }

  function classifyFindReplaceButton(item) {
    const primary = normalizeUiText([
      item.name,
      item.text,
      item.ariaLabel,
      item.title,
      item.id,
      item.className
    ].join(' '));
    const nearby = normalizeUiText(item.nearText || '');
    const primaryRole = classifyFindReplaceButtonText(primary, 1);
    if (primaryRole.role) return primaryRole;
    return classifyFindReplaceButtonText(nearby, 0.55);
  }

  function classifyFindReplaceButtonText(text, weight) {
    const scoreWeight = Number.isFinite(weight) ? weight : 1;
    const normalized = normalizeUiText([
      text
    ].join(' '));
    if (!normalized) return { role: '', score: 0 };
    if (/(replace all|all replace|모두\s*바꾸|전체\s*바꾸)/i.test(normalized)) {
      return { role: 'replaceAll', score: Math.round(120 * scoreWeight) };
    }
    if (/(replace|바꾸기|바꿈|교체|대체)/i.test(normalized) && !/(previous|이전|all|모두|전체)/i.test(normalized)) {
      return { role: 'replace', score: Math.round(95 * scoreWeight) };
    }
    if (/(next|다음)/i.test(normalized) && /(find|찾|검색|match|항목)/i.test(normalized)) {
      return { role: 'next', score: Math.round(70 * scoreWeight) };
    }
    if (/(previous|prev|이전)/i.test(normalized) && /(find|찾|검색|match|항목)/i.test(normalized)) {
      return { role: 'previous', score: Math.round(70 * scoreWeight) };
    }
    if (/(close|닫기|취소|done|완료)/i.test(normalized)) {
      return { role: 'close', score: Math.round(40 * scoreWeight) };
    }
    return { role: '', score: 0 };
  }

  function normalizeUiText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function resolveFindReplaceFieldNodes() {
    const nodes = Array.prototype.slice.call(document.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"]'))
      .filter(isVisibleElement)
      .filter(node => {
        const tag = String(node.tagName || '').toLowerCase();
        const type = String(node.getAttribute && node.getAttribute('type') || '').toLowerCase();
        return tag !== 'input' || !type || ['text', 'search', ''].indexOf(type) !== -1;
      })
      .map(node => ({ node, summary: summarizeInputCandidate(node) }))
      .filter(item => isFindReplaceRelevantInput(item.summary))
      .map(item => Object.assign(item, { roleGuess: classifyFindReplaceField(item.summary) }))
      .sort((a, b) => {
        const ar = a.summary.rect || {};
        const br = b.summary.rect || {};
        return (ar.y - br.y) || (ar.x - br.x);
      });
    const picked = pickFindReplaceFields(nodes);
    return {
      find: picked.find,
      replace: picked.replace,
      confidence: picked.confidence,
      all: nodes
    };
  }

  function summarizeResolvedFindReplaceFields() {
    const fields = resolveFindReplaceFieldNodes();
    return {
      find: fields.find ? summarizeInputCandidate(fields.find.node) : null,
      replace: fields.replace ? summarizeInputCandidate(fields.replace.node) : null,
      confidence: fields.confidence || null,
      count: fields.all.length
    };
  }

  function summarizeInputCandidate(node) {
    const summary = summarizeElement(node);
    summary.kind = 'textInput';
    summary.name = readableElementName(node);
    summary.value = readableElementValue(node);
    summary.placeholder = String(node.getAttribute && node.getAttribute('placeholder') || '').slice(0, 160);
    summary.nearText = nearbyText(node);
    summary.score = scoreUiElement(summary);
    return summary;
  }

  function pickFindReplaceFields(items) {
    const findCandidates = items
      .map((item, index) => ({ item, index, score: item.roleGuess.findScore }))
      .filter(candidate => candidate.score > 0)
      .sort((a, b) => (b.score - a.score) || (a.index - b.index));
    const replaceCandidates = items
      .map((item, index) => ({ item, index, score: item.roleGuess.replaceScore }))
      .filter(candidate => candidate.score > 0)
      .sort((a, b) => (b.score - a.score) || (a.index - b.index));

    let find = findCandidates.length ? findCandidates[0].item : null;
    let replace = null;
    for (const candidate of replaceCandidates) {
      if (candidate.item !== find) {
        replace = candidate.item;
        break;
      }
    }

    if (!find) find = items[0] || null;
    if (!replace) {
      const findIndex = items.indexOf(find);
      replace = items.find((item, index) => index !== findIndex && index > findIndex) ||
        items.find(item => item !== find) || null;
    }

    return {
      find,
      replace,
      confidence: {
        find: find ? find.roleGuess : null,
        replace: replace ? replace.roleGuess : null,
        method: findCandidates.length || replaceCandidates.length ? 'role-score' : 'position'
      }
    };
  }

  function classifyFindReplaceField(summary) {
    const ownText = normalizeUiText([
      summary.name,
      summary.placeholder,
      summary.ariaLabel,
      summary.title,
      summary.id,
      summary.className
    ].join(' '));
    const nearText = normalizeUiText(summary.nearText || '');
    const findScore = fieldTextScore(ownText, 'find', 1) + fieldTextScore(nearText, 'find', 0.35);
    const replaceScore = fieldTextScore(ownText, 'replace', 1) + fieldTextScore(nearText, 'replace', 0.35);
    return {
      findScore,
      replaceScore,
      ownText: ownText.slice(0, 180),
      nearText: nearText.slice(0, 180)
    };
  }

  function fieldTextScore(text, role, weight) {
    const s = normalizeUiText(text);
    if (!s) return 0;
    const w = Number.isFinite(weight) ? weight : 1;
    let score = 0;
    if (role === 'find') {
      if (/(^|[^a-z])(find|search|query)([^a-z]|$)/i.test(s)) score += 100;
      if (/(찾기|검색|찾을\s*내용|검색어)/.test(s)) score += 100;
      if (/(replace|바꾸|교체|대체)/i.test(s)) score -= 45;
    } else {
      if (/(replace|replacement|replace with|substitute)/i.test(s)) score += 100;
      if (/(바꾸기|바꿀\s*내용|교체|대체)/.test(s)) score += 100;
      if (/(^|[^a-z])(find|search|query)([^a-z]|$)/i.test(s) || /(찾기|검색|찾을\s*내용|검색어)/.test(s)) score -= 30;
    }
    if (/findreplace|find-replace|find_and_replace|찾기.*바꾸|바꾸.*찾기/i.test(s)) score += 10;
    return Math.max(0, Math.round(score * w));
  }

  function isFindReplaceRelevantInput(summary) {
    const haystack = [
      summary.name,
      summary.placeholder,
      summary.ariaLabel,
      summary.title,
      summary.id,
      summary.className,
      summary.nearText
    ].join(' ');
    if (/docs-title-input|docs-titlebar|docs-offscreen|docs-texteventtarget/i.test(haystack)) return false;
    return scoreText(haystack) > 0 || /find|replace|search|찾기|바꾸|검색/i.test(haystack);
  }

  function guessFindReplaceFields(textInputs) {
    const fields = (textInputs || [])
      .filter(isFindReplaceRelevantInput)
      .map((item, index) => Object.assign({}, item, { roleGuess: classifyFindReplaceField(item), index }))
      .sort((a, b) => {
        const ar = a.rect || {};
        const br = b.rect || {};
        return (ar.y - br.y) || (ar.x - br.x);
      });
    const picked = pickFindReplaceFields(fields.map(item => ({ summary: item, roleGuess: item.roleGuess })));
    return {
      find: picked.find ? picked.find.summary : null,
      replace: picked.replace ? picked.replace.summary : null,
      confidence: picked.confidence,
      all: fields.slice(0, 8)
    };
  }

  function setElementTextValue(node, value) {
    const events = [];
    node.focus();
    events.push('focus');
    try {
      if (typeof node.select === 'function') {
        node.select();
        events.push('select');
      } else if (String(node.getAttribute && node.getAttribute('contenteditable') || '').toLowerCase() === 'true') {
        selectElementContents(node);
        events.push('selectContents');
      }
    } catch (e) {
      events.push('select:error');
    }
    try {
      const selection = window.getSelection && window.getSelection();
      if (selection && node.contains && node.contains(selection.anchorNode)) {
        events.push('selection:inside-field');
      }
    } catch (e) {
      events.push('selection:inspect:error');
    }
    if ('value' in node) {
      const proto = Object.getPrototypeOf(node);
      const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor && typeof descriptor.set === 'function') {
        descriptor.set.call(node, '');
        events.push('nativeValueSetter:clear');
        descriptor.set.call(node, value);
        events.push('nativeValueSetter:set');
      } else {
        node.value = '';
        events.push('value:clear');
        node.value = value;
        events.push('value:set');
      }
    } else {
      let inserted = false;
      try {
        if (document.execCommand && document.execCommand('delete', false, null)) {
          events.push('execCommand:delete');
        } else {
          node.textContent = '';
          events.push('textContent:clear');
        }
      } catch (e) {
        node.textContent = '';
        events.push('execCommand:delete:error');
      }
      try {
        inserted = !!(document.execCommand && document.execCommand('insertText', false, value));
        events.push(inserted ? 'execCommand:insertText' : 'execCommand:insertText:false');
      } catch (e) {
        events.push('execCommand:insertText:error');
      }
      if (!inserted || readableElementValue(node) !== String(value).slice(0, 160)) {
        node.textContent = value;
        events.push('textContent:set');
      }
    }
    try {
      node.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
      events.push('beforeinput');
    } catch (e) {
      events.push('beforeinput:error');
    }
    try {
      node.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
      events.push('input');
    } catch (e) {
      node.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      events.push('input:fallback');
    }
    node.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    events.push('change');
    return {
      tag: String(node.tagName || '').toLowerCase(),
      name: readableElementName(node),
      value: readableElementValue(node),
      events
    };
  }

  function selectElementContents(node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection && window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function activateElement(node) {
    const events = [];
    try {
      node.focus();
      events.push('focus');
    } catch (e) {
      events.push('focus:error');
    }
    const PointerCtor = typeof PointerEvent !== 'undefined' ? PointerEvent : MouseEvent;
    const sequence = [
      ['pointerdown', PointerCtor],
      ['mousedown', MouseEvent],
      ['pointerup', PointerCtor],
      ['mouseup', MouseEvent],
      ['click', MouseEvent]
    ];
    for (const pair of sequence) {
      const type = pair[0];
      const Ctor = pair[1] || MouseEvent;
      try {
        node.dispatchEvent(new Ctor(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          button: 0,
          buttons: type === 'pointerdown' || type === 'mousedown' ? 1 : 0
        }));
        events.push(type);
      } catch (e) {
        events.push(type + ':error');
      }
    }
    try {
      if (typeof node.click === 'function') {
        node.click();
        events.push('nativeClick');
      }
    } catch (e) {
      events.push('nativeClick:error');
    }
    return {
      tag: String(node.tagName || '').toLowerCase(),
      name: readableElementName(node),
      disabled: isDisabledElement(node),
      events
    };
  }

  function scanVisibleElements(selector, limit) {
    const out = [];
    const nodes = Array.prototype.slice.call(document.querySelectorAll(selector));
    for (const node of nodes) {
      if (out.length >= limit) break;
      if (!isVisibleElement(node)) continue;
      const item = summarizeElement(node);
      item.kind = isTextInputElement(node) ? 'textInput' : (isButtonLikeElement(node) ? 'button' : 'container');
      item.name = readableElementName(node);
      item.value = readableElementValue(node);
      item.placeholder = String(node.getAttribute && node.getAttribute('placeholder') || '').slice(0, 160);
      item.autocomplete = String(node.getAttribute && node.getAttribute('autocomplete') || '').slice(0, 80);
      item.nearText = nearbyText(node);
      out.push(item);
    }
    return out;
  }

  function isVisibleElement(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    try {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0 &&
        rect.top <= (window.innerHeight || document.documentElement.clientHeight) &&
        rect.left <= (window.innerWidth || document.documentElement.clientWidth);
    } catch (e) {
      return false;
    }
  }

  function isTextInputElement(node) {
    const tag = String(node.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' ||
      String(node.getAttribute && node.getAttribute('role') || '') === 'textbox' ||
      String(node.getAttribute && node.getAttribute('contenteditable') || '').toLowerCase() === 'true';
  }

  function isButtonLikeElement(node) {
    const tag = String(node.tagName || '').toLowerCase();
    return tag === 'button' || String(node.getAttribute && node.getAttribute('role') || '') === 'button';
  }

  function isDisabledElement(node) {
    try {
      return !!node.disabled ||
        !!(node.hasAttribute && node.hasAttribute('disabled')) ||
        String(node.getAttribute && node.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
    } catch (e) {
      return false;
    }
  }

  function readableElementName(node) {
    const ids = [
      node.getAttribute && node.getAttribute('aria-label'),
      node.getAttribute && node.getAttribute('title'),
      node.getAttribute && node.getAttribute('name'),
      node.getAttribute && node.getAttribute('id'),
      node.getAttribute && node.getAttribute('data-tooltip')
    ];
    for (const value of ids) {
      if (value) return String(value).replace(/\s+/g, ' ').trim().slice(0, 180);
    }
    return String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  }

  function readableElementValue(node) {
    try {
      if ('value' in node) return String(node.value || '').slice(0, 160);
      return String(node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    } catch (e) {
      return '';
    }
  }

  function readableElementValueFull(node) {
    try {
      if ('value' in node) return String(node.value || '');
      return String(node.textContent || '').replace(/\s+/g, ' ').trim();
    } catch (e) {
      return '';
    }
  }

  function nearbyText(node) {
    let cur = node;
    for (let depth = 0; cur && depth < 3; depth++, cur = cur.parentElement) {
      const text = String(cur.innerText || cur.textContent || '').replace(/\s+/g, ' ').trim();
      if (text && text.length <= 500) return text.slice(0, 300);
    }
    return '';
  }

  function scoreUiElement(item) {
    return scoreText([
      item.name,
      item.text,
      item.placeholder,
      item.ariaLabel,
      item.title,
      item.id,
      item.className,
      item.nearText
    ].join(' '));
  }

  function probeScriptSources(limits) {
    if (!limits.scriptCount || !limits.scriptMatches) return Promise.resolve([]);
    const scripts = Array.prototype.slice.call(document.scripts || [])
      .map(script => script && script.src || '')
      .filter(src => /^https:\/\/docs\.google\.com\//.test(src))
      .filter(src => /\/_\/docs\/_|[?&]m=|\/k=docs\./.test(src));
    const unique = [];
    for (const src of scripts) {
      if (unique.indexOf(src) === -1) unique.push(src);
    }
    return unique.slice(0, limits.scriptCount).reduce((promise, src) => {
      return promise.then(matches => {
        if (matches.length >= limits.scriptMatches) return matches;
        return fetchScriptText(src).then(text => {
          return matches.concat(scanScriptText(src, text, limits).slice(0, limits.scriptMatches - matches.length));
        }).catch(error => {
          matches.push({
            path: 'script:' + shortScriptName(src),
            kind: 'script-fetch-error',
            type: 'script',
            score: 0,
            url: src,
            errorName: error && error.name ? error.name : '',
            errorMessage: error && error.message ? String(error.message).slice(0, 180) : String(error).slice(0, 180)
          });
          return matches;
        });
      });
    }, Promise.resolve([]));
  }

  function fetchScriptText(src) {
    return fetch(src, { credentials: 'same-origin' }).then(res => {
      if (!res.ok) throw new Error('script fetch http ' + res.status);
      return res.text();
    });
  }

  function scanScriptText(src, text, limits) {
    const out = [];
    const patterns = [
      /find.{0,40}replace|replace.{0,40}find/ig,
      /findAndReplace/ig,
      /find[-_ ]?replace/ig,
      /replaceSelection|setSelection|getSelection/ig,
      /insertText|deleteContentRange|replaceAllText|batchUpdate/ig,
      /insert.{0,40}text|delete.{0,40}range|update.{0,40}text|mutation|operation/ig,
      /execCommand|command|dispatch/ig,
      /search/ig
    ];
    for (const re of patterns) {
      let match;
      while ((match = re.exec(text)) && out.length < limits.scriptMatches) {
        const start = Math.max(0, match.index - limits.scriptContext);
        const end = Math.min(text.length, match.index + match[0].length + limits.scriptContext);
        const sample = text.slice(start, end).replace(/\s+/g, ' ');
        out.push({
          path: 'script:' + shortScriptName(src) + '@' + match.index,
          key: match[0].slice(0, 80),
          type: 'script',
          ctor: '',
          score: scoreText(match[0]) + scoreText(sample),
          url: src,
          index: match.index,
          valueSample: sample
        });
      }
    }
    out.sort((a, b) => (b.score - a.score) || (a.index - b.index));
    return dedupeScriptMatches(out).slice(0, limits.scriptMatches);
  }

  function probeMutationActions(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const limits = Object.assign(probeLimits(opts), {
      scriptCount: clampNumber(opts.scriptCount, 6, 0, 20),
      scriptMatches: clampNumber(opts.scriptMatches, 80, 0, 250),
      scriptContext: clampNumber(opts.scriptContext, 120, 30, 280)
    });
    const registry = getDocsActionRegistryInfo();
    const result = {
      kind: 'toytype:mutation-action-probe-result',
      timestamp: new Date().toISOString(),
      url: location.href,
      actionRegistryPath: registry.path || '',
      actionRegistryAvailable: typeof registry.getAction === 'function',
      knownMutationActionIds: KNOWN_MUTATION_ACTION_IDS.slice(),
      directTextActionIds: DIRECT_TEXT_ACTION_IDS.slice(),
      scriptActions: [],
      actionSummaries: [],
      scriptMatches: [],
      notes: [
        'Read-only probe. It summarizes action objects and script references; it does not execute mutation actions.',
        'docs-text-* and docs-replace are static Kix candidates, not confirmed public APIs.'
      ]
    };
    return collectScriptTexts(limits).then(scripts => {
      result.scriptActions = extractCandidateActionIds(scripts).slice(0, clampNumber(opts.actionLimit, 120, 10, 500));
      result.actionSummaries = result.scriptActions.map(id => summarizeKnownFindAction(id, registry, {
        deepActions: opts.deepActions === true,
        actionKeyLimit: opts.actionKeyLimit,
        actionSourceLimit: opts.actionSourceLimit
      }));
      result.scriptMatches = scripts.reduce((acc, item) => {
        if (acc.length >= limits.scriptMatches) return acc;
        return acc.concat(scanMutationScriptText(item.url, item.text, limits).slice(0, limits.scriptMatches - acc.length));
      }, []).slice(0, limits.scriptMatches);
      debugLog('[Toytype probe] mutation action candidates', result);
      if (typeof console.table === 'function') debugTable(result.actionSummaries.slice(0, 80));
      debugLog('[Toytype probe mutation actions json]', JSON.stringify(result));
      return result;
    });
  }

  function collectScriptTexts(limits) {
    const scripts = Array.prototype.slice.call(document.scripts || [])
      .map(script => script && script.src || '')
      .filter(src => /^https:\/\/docs\.google\.com\//.test(src))
      .filter(src => /\/_\/docs\/_|[?&]m=|\/k=docs\./.test(src));
    const unique = [];
    for (const src of scripts) {
      if (unique.indexOf(src) === -1) unique.push(src);
    }
    return unique.slice(0, limits.scriptCount).reduce((promise, src) => {
      return promise.then(items => fetchScriptText(src)
        .then(text => items.concat([{ url: src, text }]))
        .catch(() => items));
    }, Promise.resolve([]));
  }

  function extractCandidateActionIds(scripts) {
    const ids = KNOWN_MUTATION_ACTION_IDS.concat(DIRECT_TEXT_ACTION_IDS);
    const idRe = /docs-[a-z0-9][a-z0-9-]{1,80}/ig;
    for (const item of scripts) {
      let match;
      while ((match = idRe.exec(item.text))) {
        const id = match[0];
        const start = Math.max(0, match.index - 120);
        const end = Math.min(item.text.length, match.index + id.length + 120);
        const context = item.text.slice(start, end);
        if (scoreMutationText(id + ' ' + context) <= 0) continue;
        if (ids.indexOf(id) === -1) ids.push(id);
      }
    }
    return ids.sort((a, b) => {
      const aKnown = KNOWN_MUTATION_ACTION_IDS.indexOf(a);
      const bKnown = KNOWN_MUTATION_ACTION_IDS.indexOf(b);
      if (aKnown !== -1 || bKnown !== -1) {
        if (aKnown === -1) return 1;
        if (bKnown === -1) return -1;
        return aKnown - bKnown;
      }
      const aDirect = DIRECT_TEXT_ACTION_IDS.indexOf(a);
      const bDirect = DIRECT_TEXT_ACTION_IDS.indexOf(b);
      if (aDirect !== -1 || bDirect !== -1) {
        if (aDirect === -1) return 1;
        if (bDirect === -1) return -1;
        return aDirect - bDirect;
      }
      return scoreMutationText(b) - scoreMutationText(a) || a.localeCompare(b);
    });
  }

  function scanMutationScriptText(src, text, limits) {
    const out = [];
    const patterns = [
      /docs-[a-z0-9][a-z0-9-]{1,80}/ig,
      /insertText|deleteContentRange|replaceAllText|batchUpdate/ig,
      /insert.{0,50}text|delete.{0,50}range|replace.{0,50}text|update.{0,50}text/ig,
      /mutation|operation|textOperation|collab|apply.{0,40}edit/ig
    ];
    for (const re of patterns) {
      let match;
      while ((match = re.exec(text)) && out.length < limits.scriptMatches) {
        const start = Math.max(0, match.index - limits.scriptContext);
        const end = Math.min(text.length, match.index + match[0].length + limits.scriptContext);
        const sample = text.slice(start, end).replace(/\s+/g, ' ');
        const score = scoreMutationText(match[0] + ' ' + sample);
        if (score <= 0) continue;
        out.push({
          path: 'mutation-script:' + shortScriptName(src) + '@' + match.index,
          key: match[0].slice(0, 100),
          type: 'script',
          score,
          url: src,
          index: match.index,
          valueSample: sample
        });
      }
    }
    out.sort((a, b) => (b.score - a.score) || (a.index - b.index));
    return dedupeScriptMatches(out).slice(0, limits.scriptMatches);
  }

  function scoreMutationText(text) {
    const haystack = String(text || '').toLowerCase();
    const keywords = ['insert', 'delete', 'replace', 'update', 'edit', 'text', 'paste', 'typing', 'write', 'mutation', 'operation', 'batch'];
    let score = 0;
    for (const keyword of keywords) {
      if (haystack.indexOf(keyword) !== -1) score += 12;
    }
    if (/inserttext|deletecontentrange|replacealltext|batchupdate/.test(haystack)) score += 60;
    if (/docs-(insert|delete|replace|update|paste|edit|text|typing)/.test(haystack)) score += 45;
    if (/mutation|operation|collab/.test(haystack)) score += 18;
    if (/find|search/.test(haystack)) score -= 5;
    return score;
  }

  function dedupeScriptMatches(matches) {
    const seen = [];
    const out = [];
    for (const match of matches) {
      const key = match.url + ':' + Math.floor(match.index / 200);
      if (seen.indexOf(key) !== -1) continue;
      seen.push(key);
      out.push(match);
    }
    return out;
  }

  function shortScriptName(src) {
    const m = src.match(/\/([^/?]+)(?:[/?]|$)/g);
    const tail = m && m.length ? m[m.length - 1].replace(/[/?]/g, '') : 'script';
    const module = src.match(/[?&]m=([^&]+)/);
    return module ? tail + '?m=' + decodeURIComponent(module[1]).slice(0, 80) : tail;
  }

  function scanGraph(rootPath, rootValue, out, seen, limits) {
    if (!isObjectLike(rootValue)) return;
    const queue = [{ path: rootPath, value: rootValue, depth: 0 }];
    let visited = 0;
    while (queue.length && visited < limits.maxNodes) {
      const item = queue.shift();
      if (!isObjectLike(item.value) || seen.indexOf(item.value) !== -1) continue;
      seen.push(item.value);
      visited++;

      const keys = probeKeys(item.value).slice(0, limits.maxProps);
      for (const key of keys) {
        const childPath = item.path + '.' + key;
        const child = safeGet(item.value, key);
        const candidate = candidateFor(childPath, key, child, item.depth + 1);
        if (candidate && candidate.score > 0) out.push(candidate);

        if (item.depth + 1 < limits.maxDepth && shouldTraverse(key, child, candidate)) {
          queue.push({ path: childPath, value: child, depth: item.depth + 1 });
        }
      }
    }
  }

  function candidateFor(path, key, value, depth) {
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const ctor = ctorName(value);
    const keyText = String(key || '');
    const keyScore = scoreText(keyText);
    const valueScore = typeof value === 'string' ? scoreText(value) : 0;
    let source = '';
    let sourceScore = 0;
    let keys = [];
    let interestingKeys = [];
    let interestingValues = [];
    let fnLength = null;

    if (typeof value === 'function') {
      fnLength = typeof value.length === 'number' ? value.length : null;
      source = functionSource(value, 520);
      sourceScore = scoreText(source);
    } else if (typeof value === 'string') {
      interestingValues = [{ value: value.slice(0, 260), score: valueScore }];
    } else if (isObjectLike(value)) {
      keys = probeKeys(value).slice(0, 30);
      interestingKeys = keys.filter(k => scoreText(k) > 0).slice(0, 20);
      interestingValues = sampleInterestingValues(value, keys).slice(0, 20);
    }

    const score = keyScore + valueScore + sourceScore + interestingKeys.length * 4 +
      interestingValues.reduce((sum, item) => sum + Math.min(item.score, 40), 0) + ctorScore(ctor);
    if (score <= 0) return null;

    const out = {
      path,
      key: keyText,
      depth,
      type,
      ctor,
      score
    };
    if (fnLength !== null) out.length = fnLength;
    if (source) out.sourcePrefix = source;
    if (typeof value === 'string') {
      out.valueLength = value.length;
      out.valueSample = value.slice(0, 260);
    }
    if (keys.length) out.keys = keys;
    if (interestingKeys.length) out.interestingKeys = interestingKeys;
    if (interestingValues.length) out.interestingValues = interestingValues;
    return out;
  }

  function sampleInterestingValues(obj, keys) {
    const out = [];
    for (const key of keys) {
      const value = safeGet(obj, key);
      if (typeof value !== 'string') continue;
      const score = scoreText(value);
      if (score <= 0) continue;
      out.push({ key: String(key), value: value.slice(0, 260), score });
    }
    return out.sort((a, b) => (b.score - a.score) || a.key.localeCompare(b.key));
  }

  function summarizeAtPath(path, value) {
    const summary = {
      path,
      type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
      ctor: ctorName(value)
    };
    if (isObjectLike(value)) {
      const keys = probeKeys(value).slice(0, 40);
      summary.keyCount = probeKeys(value).length;
      summary.keys = keys;
      summary.interestingKeys = keys.filter(k => scoreText(k) > 0).slice(0, 20);
    }
    if (typeof value === 'function') {
      summary.length = value.length;
      summary.sourcePrefix = functionSource(value, 260);
    }
    return summary;
  }

  function shouldTraverse(key, value, candidate) {
    if (!isObjectLike(value)) return false;
    if (value === window || value === document || value === document.body || value === document.documentElement) return false;
    if (value instanceof Node || value instanceof Window) return false;
    if (Array.isArray(value) && value.length > 40) return false;
    const text = String(key || '') + ' ' + ctorName(value);
    return scoreText(text) > 0 || (candidate && candidate.score >= 8) || text.indexOf('KX') !== -1 || text.indexOf('kix') !== -1;
  }

  function scoreText(text) {
    if (!text) return 0;
    let score = 0;
    const s = String(text);
    if (/replace|replacement|substitut/i.test(s)) score += 40;
    if (/\bfind\b|find|search|query/i.test(s)) score += 35;
    if (/찾기|검색|바꾸|교체|대체/.test(s)) score += 35;
    if (/command|cmd|action|exec|dispatch/i.test(s)) score += 18;
    if (/selection|select|cursor|caret|range/i.test(s)) score += 16;
    if (/edit|text|annotat|mutation|operation/i.test(s)) score += 10;
    if (/kix|docs|document/i.test(s)) score += 4;
    return score;
  }

  function ctorScore(ctor) {
    if (!ctor) return 0;
    if (/find|replace|search/i.test(ctor)) return 30;
    if (/command|action|selection|text|edit/i.test(ctor)) return 12;
    return 0;
  }

  function ownKeys(value) {
    try {
      return Object.getOwnPropertyNames(value);
    } catch (e) {
      return [];
    }
  }

  function probeKeys(value) {
    const out = [];
    const add = keys => {
      for (const key of keys) {
        if (key === 'constructor' || out.indexOf(key) !== -1) continue;
        out.push(key);
      }
    };
    add(ownKeys(value));
    let proto = safePrototypeOf(value);
    let depth = 0;
    while (proto && depth < 2) {
      if (proto === Object.prototype || proto === Function.prototype || proto === Array.prototype) break;
      add(ownKeys(proto));
      proto = safePrototypeOf(proto);
      depth++;
    }
    return out;
  }

  function safePrototypeOf(value) {
    try {
      return Object.getPrototypeOf(value);
    } catch (e) {
      return null;
    }
  }

  function isObjectLike(value) {
    return value !== null && (typeof value === 'object' || typeof value === 'function');
  }

  function ctorName(value) {
    try {
      return value && value.constructor && value.constructor.name || '';
    } catch (e) {
      return '';
    }
  }

  function functionSource(fn, limit) {
    try {
      return Function.prototype.toString.call(fn).replace(/\s+/g, ' ').slice(0, limit);
    } catch (e) {
      return '';
    }
  }

  function shortErrorMessage(error) {
    return error && error.message ? String(error.message).slice(0, 200) : String(error).slice(0, 200);
  }

  function extractDocId() {
    const match = location.pathname.match(/\/d\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : '';
  }

  function focusDocsEditor() {
    const result = {
      before: summarizeElement(document.activeElement),
      steps: []
    };
    try {
      window.focus();
      result.steps.push({ target: 'window', ok: true });
    } catch (e) {
      result.steps.push({ target: 'window', ok: false, error: shortErrorMessage(e) });
    }
    const iframe = document.querySelector('iframe.docs-texteventtarget-iframe');
    try {
      if (iframe && iframe.contentWindow) {
        iframe.contentWindow.focus();
        result.steps.push({ target: 'docs-texteventtarget-iframe.contentWindow', ok: true });
      } else {
        result.steps.push({ target: 'docs-texteventtarget-iframe.contentWindow', ok: false, error: 'unavailable' });
      }
    } catch (e) {
      result.steps.push({ target: 'docs-texteventtarget-iframe.contentWindow', ok: false, error: shortErrorMessage(e) });
    }
    try {
      const body = iframe && iframe.contentDocument && iframe.contentDocument.body;
      if (body && typeof body.focus === 'function') {
        body.focus();
        result.steps.push({ target: 'docs-texteventtarget-iframe.body', ok: true });
      }
    } catch (e) {
      result.steps.push({ target: 'docs-texteventtarget-iframe.body', ok: false, error: shortErrorMessage(e) });
    }
    const editor = document.querySelector('.kix-appview-editor');
    try {
      if (editor && typeof editor.focus === 'function') {
        editor.focus();
        result.steps.push({ target: '.kix-appview-editor', ok: true });
      } else {
        result.steps.push({ target: '.kix-appview-editor', ok: false, error: 'unavailable' });
      }
    } catch (e) {
      result.steps.push({ target: '.kix-appview-editor', ok: false, error: shortErrorMessage(e) });
    }
    result.after = summarizeElement(document.activeElement);
    try {
      result.iframeActiveElement = iframe && iframe.contentDocument
        ? summarizeElement(iframe.contentDocument.activeElement)
        : null;
    } catch (e) {
      result.iframeActiveElement = { error: shortErrorMessage(e) };
    }
    return result;
  }

  function callAnnotatedMethod(obj, name, args) {
    const fn = obj && obj[name];
    if (typeof fn !== 'function') return Promise.reject(new Error(name + ' is not a function'));
    try {
      return toPromise(fn.apply(obj, Array.isArray(args) ? args : [])).catch(error => {
        if (cachedAnnotatedObj === obj) cachedAnnotatedObj = null; // 죽은 객체 캐시 제거
        throw error;
      });
    } catch (error) {
      if (cachedAnnotatedObj === obj) cachedAnnotatedObj = null;
      return Promise.reject(error);
    }
  }

  function errorResponse(data, error) {
    const response = {
      ok: false,
      action: data && data.action || '',
      errorName: error && error.name ? error.name : '',
      errorMessage: error && error.message ? String(error.message).slice(0, 500) : String(error).slice(0, 500)
    };
    if (error && error.preventFallback === true) response.preventFallback = true;
    if (error && error.debug !== undefined) response.debug = safeJsonClone(error.debug, 6000);
    return response;
  }

  function safeJsonClone(value, maxLength) {
    try {
      const json = JSON.stringify(value);
      if (!Number.isFinite(maxLength) || json.length <= maxLength) return JSON.parse(json);
      return {
        truncated: true,
        json: json.slice(0, maxLength)
      };
    } catch (e) {
      return String(value).slice(0, Number.isFinite(maxLength) ? maxLength : 1000);
    }
  }

  function postResponse(request, payload) {
    window.postMessage(Object.assign({
      kind: 'typo-radar:page-model-response',
      requestId: request && request.requestId
    }, payload), '*');
  }

  function probeFindReplaceInteraction(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const durationMs = clampNumber(opts.durationMs, 15000, 500, 60000);
    const maxEvents = clampNumber(opts.maxEvents, 160, 20, 600);
    const result = {
      kind: 'toytype:find-replace-interaction-probe-result',
      timestamp: new Date().toISOString(),
      url: location.href,
      durationMs,
      events: [],
      mutations: [],
      activeElementBefore: summarizeElement(document.activeElement),
      notes: [
        'Read-only interaction probe: records event metadata and newly added UI text/classes only.',
        'Suggested flow: run this, open Google Docs find/replace once, wait for completion.'
      ]
    };

    const startedAt = Date.now();
    const eventTypes = ['keydown', 'keyup', 'beforeinput', 'input', 'click', 'mousedown', 'mouseup', 'focusin', 'change'];
    const listeners = [];
    const addRecord = (bucket, record) => {
      if (result[bucket].length >= maxEvents) return;
      result[bucket].push(record);
    };
    const onEvent = event => {
      const target = summarizeElement(event.target);
      const record = {
        t: Date.now() - startedAt,
        kind: 'event',
        type: event.type,
        key: event.key || '',
        code: event.code || '',
        inputType: event.inputType || '',
        data: typeof event.data === 'string' ? event.data.slice(0, 80) : '',
        ctrlKey: !!event.ctrlKey,
        metaKey: !!event.metaKey,
        shiftKey: !!event.shiftKey,
        altKey: !!event.altKey,
        target,
        score: scoreText(event.type + ' ' + event.key + ' ' + event.code + ' ' + target.text + ' ' + target.id + ' ' + target.className + ' ' + target.ariaLabel + ' ' + target.title)
      };
      if (record.score > 0 || event.type === 'keydown' || event.type === 'click') addRecord('events', record);
    };

    for (const type of eventTypes) {
      window.addEventListener(type, onEvent, true);
      listeners.push(type);
    }

    const observer = new MutationObserver(records => {
      for (const record of records) {
        for (const node of Array.prototype.slice.call(record.addedNodes || [])) {
          for (const summary of summarizeAddedNode(node)) {
            const score = scoreText(summary.text + ' ' + summary.id + ' ' + summary.className + ' ' + summary.ariaLabel + ' ' + summary.title);
            if (score <= 0) continue;
            summary.t = Date.now() - startedAt;
            summary.kind = 'mutation';
            summary.score = score;
            addRecord('mutations', summary);
          }
        }
      }
    });
    try {
      observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    } catch (e) {
      result.mutations.push({
        kind: 'observer-error',
        errorName: e && e.name ? e.name : '',
        errorMessage: e && e.message ? String(e.message).slice(0, 200) : String(e).slice(0, 200)
      });
    }

    return delay(durationMs).then(() => {
      for (const type of listeners) window.removeEventListener(type, onEvent, true);
      observer.disconnect();
      result.activeElementAfter = summarizeElement(document.activeElement);
      result.topEvents = result.events.slice().sort((a, b) => (b.score - a.score) || (a.t - b.t)).slice(0, 30);
      result.topMutations = result.mutations.slice().sort((a, b) => (b.score - a.score) || (a.t - b.t)).slice(0, 30);
      debugLog('[Toytype probe] find/replace interaction result', result);
      if (typeof console.table === 'function') {
        debugTable(result.topEvents);
        debugTable(result.topMutations);
      }
      debugLog('[Toytype probe interaction json]', JSON.stringify(result));
      return result;
    });
  }

  function summarizeAddedNode(node) {
    const out = [];
    const visit = current => {
      if (out.length >= 40 || !current) return;
      if (current.nodeType === Node.ELEMENT_NODE) {
        out.push(summarizeElement(current));
        const children = current.children ? Array.prototype.slice.call(current.children, 0, 12) : [];
        for (const child of children) visit(child);
      } else if (current.nodeType === Node.TEXT_NODE) {
        const text = String(current.nodeValue || '').replace(/\s+/g, ' ').trim();
        if (text) out.push({ tag: '#text', id: '', className: '', role: '', ariaLabel: '', title: '', text: text.slice(0, 180) });
      }
    };
    visit(node);
    return out;
  }

  function summarizeElement(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
      return { tag: '', id: '', className: '', role: '', ariaLabel: '', title: '', text: '' };
    }
    let rect = null;
    try {
      const r = node.getBoundingClientRect();
      rect = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    } catch (e) {
      rect = null;
    }
    return {
      tag: String(node.tagName || '').toLowerCase(),
      id: String(node.id || '').slice(0, 120),
      className: String(node.className || '').slice(0, 180),
      role: String(node.getAttribute && node.getAttribute('role') || '').slice(0, 80),
      ariaLabel: String(node.getAttribute && node.getAttribute('aria-label') || '').slice(0, 160),
      title: String(node.getAttribute && node.getAttribute('title') || '').slice(0, 160),
      text: String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 220),
      rect
    };
  }

  window.ToytypeProbeFindReplace = function ToytypeProbeFindReplace(options) {
    const payload = Object.assign({ docId: extractDocId() }, options || {});
    return getAnnotatedTextObject(payload).catch(() => null).then(obj => {
      return probeFindReplace(obj, payload).then(result => {
        debugLog('[Toytype probe] find/replace result', result);
        if (typeof console.table === 'function') debugTable(result.topCandidates);
        debugLog('[Toytype probe json]', JSON.stringify(result));
        return result;
      });
    });
  };

  window.ToytypeProbeFindReplaceInteraction = function ToytypeProbeFindReplaceInteraction(options) {
    return probeFindReplaceInteraction(options);
  };

  window.ToytypeProbeMutationActions = function ToytypeProbeMutationActions(options) {
    return probeMutationActions(options || {});
  };

  window.ToytypeRunDocsFindAction = function ToytypeRunDocsFindAction(id, options) {
    const opts = Object.assign({ id: id || 'docs-find-and-replace-start' }, options || {});
    return Promise.resolve().then(() => runKnownFindAction(opts)).then(result => {
      debugLog('[Toytype probe] run docs find action result', result);
      debugLog('[Toytype probe run action json]', JSON.stringify(result));
      return result;
    });
  };

  window.ToytypeProbeFindReplaceUi = function ToytypeProbeFindReplaceUi(options) {
    return probeFindReplaceUi(options || {});
  };

  window.ToytypePrepareFindReplaceUi = function ToytypePrepareFindReplaceUi(findText, replaceText, options) {
    return prepareFindReplaceUi(Object.assign({ findText, replaceText }, options || {})).then(result => {
      debugLog('[Toytype probe] prepare find/replace UI result', result);
      debugLog('[Toytype probe prepare ui json]', JSON.stringify(result));
      return result;
    });
  };

  window.ToytypeClickFindReplaceButton = function ToytypeClickFindReplaceButton(mode, options) {
    return clickFindReplaceButton(Object.assign({ mode: mode || 'replace' }, options || {})).then(result => {
      debugLog('[Toytype probe] click find/replace button result', result);
      debugLog('[Toytype probe click button json]', JSON.stringify(result));
      return result;
    });
  };

  window.ToytypeRunReplaceAction = function ToytypeRunReplaceAction(options) {
    return runFindReplaceMutationAction(Object.assign({ mode: 'replace' }, options || {})).then(result => {
      debugLog('[Toytype probe] run replace action result', result);
      debugLog('[Toytype probe run replace action json]', JSON.stringify(result));
      return result;
    });
  };

  window.ToytypePrimeFindMatch = function ToytypePrimeFindMatch(options) {
    return runFindNavigationAction(options || {}).then(result => {
      debugLog('[Toytype probe] prime find match result', result);
      debugLog('[Toytype probe prime find match json]', JSON.stringify(result));
      return result;
    });
  };

  window.ToytypeApplyFindReplaceOnce = function ToytypeApplyFindReplaceOnce(findText, replaceText, options) {
    return applyFindReplaceOnce(Object.assign({ findText, replaceText }, options || {})).then(result => {
      debugLog('[Toytype probe] apply find/replace once result', result);
      debugLog('[Toytype probe apply once json]', JSON.stringify(result));
      return result;
    });
  };

  window.ToytypeApplyInternalTextActionOnce = function ToytypeApplyInternalTextActionOnce(findText, replaceText, options) {
    return applyInternalTextActionOnce(Object.assign({ findText, replaceText }, options || {})).then(result => {
      debugLog('[Toytype probe] apply internal text action result', result);
      debugLog('[Toytype probe apply internal text action json]', JSON.stringify(result));
      return result;
    });
  };

  window.ToytypeApplyFindingAtIndex = function ToytypeApplyFindingAtIndex(index, options) {
    const opts = options && typeof options === 'object' ? options : {};
    return requestToytypeContentCommand('applyFindingAtIndex', {
      index,
      options: opts,
      timeoutMs: opts.timeoutMs || 20000
    }).then(response => {
      if (!response || !response.ok) {
        const error = new Error(response && response.errorMessage ? response.errorMessage : 'applyFindingAtIndex failed');
        if (response && response.errorName) error.name = response.errorName;
        if (response && response.debug !== undefined) error.debug = response.debug;
        if (response !== undefined) error.response = response;
        throw error;
      }
      debugLog('[Toytype probe] apply finding by index result', response.result);
      debugLog('[Toytype probe apply finding json]', JSON.stringify({ index, result: response.result }));
      return response.result;
    });
  };

  window.ToytypeApplyCurrentFinding = function ToytypeApplyCurrentFinding(options) {
    const opts = options && typeof options === 'object' ? options : {};
    return requestToytypeContentCommand('applyCurrentFinding', {
      options: opts,
      timeoutMs: opts.timeoutMs || 20000
    }).then(response => {
      if (!response || !response.ok) {
        const error = new Error(response && response.errorMessage ? response.errorMessage : 'applyCurrentFinding failed');
        if (response && response.errorName) error.name = response.errorName;
        if (response && response.debug !== undefined) error.debug = response.debug;
        if (response !== undefined) error.response = response;
        throw error;
      }
      debugLog('[Toytype probe] apply current finding result', response.result);
      debugLog('[Toytype probe apply current finding json]', JSON.stringify(response.result));
      return response.result;
    });
  };

  window.ToytypeDiagnoseFindingAtIndex = function ToytypeDiagnoseFindingAtIndex(index, options) {
    const opts = options && typeof options === 'object' ? options : {};
    return requestToytypeContentCommand('diagnoseFindingAtIndex', {
      index,
      options: opts,
      timeoutMs: opts.timeoutMs || 20000
    }).then(response => {
      if (!response || !response.ok) {
        const error = new Error(response && response.errorMessage ? response.errorMessage : 'diagnoseFindingAtIndex failed');
        if (response && response.errorName) error.name = response.errorName;
        if (response && response.debug !== undefined) error.debug = response.debug;
        if (response !== undefined) error.response = response;
        throw error;
      }
      debugLog('[Toytype probe] diagnose finding by index result', response.result);
      debugLog('[Toytype probe diagnose finding json]', JSON.stringify({ index, result: response.result }));
      return response.result;
    });
  };

  window.ToytypeDiagnoseCurrentFinding = function ToytypeDiagnoseCurrentFinding(options) {
    const opts = options && typeof options === 'object' ? options : {};
    return requestToytypeContentCommand('diagnoseCurrentFinding', {
      options: opts,
      timeoutMs: opts.timeoutMs || 20000
    }).then(response => {
      if (!response || !response.ok) {
        const error = new Error(response && response.errorMessage ? response.errorMessage : 'diagnoseCurrentFinding failed');
        if (response && response.errorName) error.name = response.errorName;
        if (response && response.debug !== undefined) error.debug = response.debug;
        if (response !== undefined) error.response = response;
        throw error;
      }
      debugLog('[Toytype probe] diagnose current finding result', response.result);
      debugLog('[Toytype probe diagnose current finding json]', JSON.stringify(response.result));
      return response.result;
    });
  };

  window.ToytypeFullDiagnoseCurrentFinding = function ToytypeFullDiagnoseCurrentFinding(options) {
    const opts = options && typeof options === 'object' ? options : {};
    return requestToytypeContentCommand('fullDiagnoseCurrentFinding', {
      options: opts,
      timeoutMs: opts.timeoutMs || 25000
    }).then(response => {
      if (!response || !response.ok) {
        const error = new Error(response && response.errorMessage ? response.errorMessage : 'fullDiagnoseCurrentFinding failed');
        if (response && response.errorName) error.name = response.errorName;
        if (response && response.debug !== undefined) error.debug = response.debug;
        if (response !== undefined) error.response = response;
        throw error;
      }
      debugLog('[Toytype probe] full diagnose current finding result', response.result);
      if (response.result && response.result.findings && typeof console.table === 'function') {
        debugTable(response.result.findings.items || []);
      }
      debugLog('[Toytype probe full diagnose json]', JSON.stringify(response.result));
      return response.result;
    });
  };

  window.ToytypePreflightCurrentFinding = function ToytypePreflightCurrentFinding(options) {
    return window.ToytypeFullDiagnoseCurrentFinding(options).then(result => {
      lastPreflightFindingTarget = result && result.target ? result.target : null;
      lastPreflightFindingSnapshot = result && result.diagnosis && result.diagnosis.findingSnapshot
        ? result.diagnosis.findingSnapshot
        : null;
      return result;
    });
  };

  window.ToytypeApplyCurrentFindingWithPreflight = function ToytypeApplyCurrentFindingWithPreflight(options) {
    const opts = options && typeof options === 'object' ? options : {};
    return window.ToytypePreflightCurrentFinding(opts).then(preflight => {
      if (opts.confirmMutation !== true) {
        return {
          kind: 'toytype:apply-current-with-preflight-result',
          applied: false,
          documentMutated: false,
          requiresConfirmMutation: true,
          preflight,
          note: 'Pass confirmMutation:true to apply the preflighted finding.'
        };
      }
      return window.ToytypeApplyLastPreflightFinding(opts).then(applyResult => ({
        kind: 'toytype:apply-current-with-preflight-result',
        applied: true,
        documentMutated: !!(applyResult && applyResult.documentMutated),
        preflight,
        applyResult
      }));
    }).then(result => {
      debugLog('[Toytype probe] apply current with preflight result', result);
      debugLog('[Toytype probe apply current with preflight json]', JSON.stringify(result));
      return result;
    });
  };

  window.ToytypeApplyLastPreflightFinding = function ToytypeApplyLastPreflightFinding(options) {
    if (!lastPreflightFindingSnapshot) {
      return Promise.reject(new Error('no preflight finding target; run ToytypePreflightCurrentFinding() first'));
    }
    const opts = options && typeof options === 'object' ? options : {};
    return requestToytypeContentCommand('applyPreflightFinding', {
      findingSnapshot: lastPreflightFindingSnapshot,
      options: opts,
      timeoutMs: opts.timeoutMs || 20000
    }).then(response => {
      if (!response || !response.ok) {
        const error = new Error(response && response.errorMessage ? response.errorMessage : 'applyPreflightFinding failed');
        if (response && response.errorName) error.name = response.errorName;
        if (response && response.debug !== undefined) error.debug = response.debug;
        if (response !== undefined) error.response = response;
        throw error;
      }
      debugLog('[Toytype probe] apply preflight finding result', response.result);
      debugLog('[Toytype probe apply preflight finding json]', JSON.stringify({
        target: lastPreflightFindingTarget,
        findingSnapshot: lastPreflightFindingSnapshot,
        result: response.result
      }));
      return response.result;
    });
  };

  window.ToytypeApplyState = function ToytypeApplyState(options) {
    const opts = options && typeof options === 'object' ? options : {};
    return requestToytypeContentCommand('getApplyState', {
      options: opts,
      timeoutMs: opts.timeoutMs || 10000
    }).then(response => {
      if (!response || !response.ok) {
        const error = new Error(response && response.errorMessage ? response.errorMessage : 'getApplyState failed');
        if (response && response.errorName) error.name = response.errorName;
        if (response && response.debug !== undefined) error.debug = response.debug;
        if (response !== undefined) error.response = response;
        throw error;
      }
      debugLog('[Toytype probe] apply state result', response.result);
      if (response.result && typeof console.table === 'function') {
        debugTable([
          Object.assign({ role: 'selected' }, response.result.selected && response.result.selected.finding || {}),
          Object.assign({ role: 'nearestCursor' }, response.result.nearestCursor && response.result.nearestCursor.finding || {}),
          Object.assign({ role: 'current' }, response.result.current && response.result.current.finding || {})
        ]);
      }
      debugLog('[Toytype probe apply state json]', JSON.stringify(response.result));
      return response.result;
    });
  };

  window.ToytypeListFindings = function ToytypeListFindings(options) {
    const opts = options && typeof options === 'object' ? options : {};
    return requestToytypeContentCommand('listFindings', {
      options: opts,
      timeoutMs: opts.timeoutMs || 10000
    }).then(response => {
      if (!response || !response.ok) {
        const error = new Error(response && response.errorMessage ? response.errorMessage : 'listFindings failed');
        if (response && response.errorName) error.name = response.errorName;
        if (response && response.debug !== undefined) error.debug = response.debug;
        if (response !== undefined) error.response = response;
        throw error;
      }
      debugLog('[Toytype probe] findings result', response.result);
      if (response.result && typeof console.table === 'function') debugTable(response.result.items || []);
      debugLog('[Toytype probe findings json]', JSON.stringify(response.result));
      return response.result;
    });
  };

  window.ToytypeBridgeStatus = function ToytypeBridgeStatus() {
    const actionRegistry = getDocsActionRegistryInfo();
    return {
      pageBridgeReady: true,
      url: location.href,
      docId: extractDocId(),
      contentCommandSeq,
      lastPreflightFindingTarget,
      lastPreflightFindingSnapshot,
      hasAnnotatedTextApi: typeof safeGetPath('_docs_annotate_getAnnotatedText') === 'function',
      hasActionRegistry: typeof actionRegistry.getAction === 'function',
      actionRegistryPath: actionRegistry.path,
      actionRegistryCandidates: getDocsActionRegistryCandidates().map(pair => ({
        path: pair[0],
        type: typeof pair[1],
        ctor: ctorName(pair[1]),
        usable: typeof pair[1] === 'function'
      })),
      directTextActions: DIRECT_TEXT_ACTION_IDS.map(id => summarizeKnownFindAction(id, actionRegistry)),
      knownFindActions: probeKnownFindActions().map(action => ({
        id: action.id,
        exists: action.exists,
        executor: action.executor,
        enabled: action.enabled,
        visible: action.visible,
        selected: action.selected,
        value: action.value,
        error: action.error
      }))
    };
  };

  debugLog('[Toytype probe] ready: run ToytypeProbeFindReplace() in this Google Docs console.');
  debugLog('[Toytype probe] mutation candidates: run ToytypeProbeMutationActions().');
  debugLog('[Toytype probe] interaction: run ToytypeProbeFindReplaceInteraction(), open find/replace, then wait.');
  debugLog('[Toytype probe] action: run ToytypeRunDocsFindAction("docs-find-and-replace-start").');
  debugLog('[Toytype probe] ui: run ToytypeProbeFindReplaceUi().');
  debugLog('[Toytype probe] prepare UI: run ToytypePrepareFindReplaceUi("찾을말", "바꿀말").');
  debugLog('[Toytype probe] click button: run ToytypeClickFindReplaceButton("replace", {confirmMutation:true}).');
  debugLog('[Toytype probe] run replace action: run ToytypeRunReplaceAction({confirmMutation:true}).');
  debugLog('[Toytype probe] apply once: run ToytypeApplyFindReplaceOnce("찾을말", "바꿀말", {confirmMutation:true}).');
  debugLog('[Toytype probe] apply internal text action: run ToytypeApplyInternalTextActionOnce("찾을말", "바꿀말", {start:0,end:0,confirmMutation:true}).');
  debugLog('[Toytype probe] apply state: run ToytypeApplyState().');
  debugLog('[Toytype probe] list findings: run ToytypeListFindings().');
  debugLog('[Toytype probe] diagnose list item: run ToytypeDiagnoseFindingAtIndex(0).');
  debugLog('[Toytype probe] diagnose current item: run ToytypeDiagnoseCurrentFinding().');
  debugLog('[Toytype probe] full diagnose current item: run ToytypeFullDiagnoseCurrentFinding().');
  debugLog('[Toytype probe] preflight current item: run ToytypePreflightCurrentFinding().');
  debugLog('[Toytype probe] apply preflight item: run ToytypeApplyLastPreflightFinding({confirmMutation:true}).');
  debugLog('[Toytype probe] preflight + apply current item: run ToytypeApplyCurrentFindingWithPreflight({confirmMutation:true}).');
  debugLog('[Toytype probe] apply list item: run ToytypeApplyFindingAtIndex(0, {confirmMutation:true}).');
  debugLog('[Toytype probe] apply current item: run ToytypeApplyCurrentFinding({confirmMutation:true}).');
  window.postMessage({ kind: 'typo-radar:page-bridge-ready' }, '*');
})();
