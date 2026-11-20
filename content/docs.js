// Toytype — 구글 독스 어댑터
// 검사는 본문을 수정하지 않는다. 사용자가 항목을 클릭하면 Google Docs 위치 선택과 교정어 복사만 시도한다.
// 항목의 적용 버튼은 사용자가 직접 누를 때만 Google Docs 내부 찾기/바꾸기로 문서를 수정한다.
'use strict';

(() => {
  // 목차 파서는 드라이브 버블과 같이 쓰는 content/doc-tools.js에 있다
  const {
    normalizeTocLine,
    isFenceLine,
    isBadTocText,
    parseMarkdownExportHeadings,
    formatExtractedToc
  } = globalThis.ToytypeDocTools;
  const DEFAULT_SETTINGS = {
    schemaVersion: 1,
    docsCategories:    { convert: true, spelling: true, plural: true,  honorific: true,  space1: true,  space2: true,  space3: true,  final: true  },
    genericCategories: { convert: true, spelling: true, plural: false, honorific: false, space1: false, space2: false, space3: false, final: false },
    disabledOrigins:   [],
    tocMaxLevel: 4, // 목차 추출에 포함할 최대 헤딩 레벨 (1~5)
    copyOnSelect: true, // 오탈자 선택 시 교정어 클립보드 자동 복사
    charPresetDirectInsert: false, // 특수문자 프리셋을 클립보드 복사 대신 문서에 바로 입력
    externalFeaturesEnabled: false // 로컬 브리지/외부 CLI가 필요한 기능은 기본 비활성화
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
  const AI_VERIFY_CONTEXT = 1200; // 선택 영역 앞뒤로 참고용 문맥만 전달한다
  const AI_VERIFY_TIMEOUT = 300000; // 웹 검색을 돌리므로 길이 조절보다 넉넉히 잡는다
  const AI_LENGTH_CONTEXT = 1200;
  const AI_LENGTH_TIMEOUT = 180000;
  const AI_DIAGRAM_TIMEOUT = 300000;
  const AI_DIAGRAM_CONTEXT = 800;
  const DIAGRAM_STORE_KEY = 'toytypeDiagrams';
  const DIAGRAM_MAX_PER_DOC = 12;
  const DIAGRAM_KIND_LABEL = { diagram: '글 → 도해', annotate: '스크린샷 강조', edit: '그리기 수정', redraw: '이미지 → 그리기 도해' };
  const AI_TERMS_TIMEOUT = 180000;
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
    '.trd-head{display:flex;gap:6px;align-items:center;padding:10px 12px;border-bottom:1px solid #e0e0e0}.trd-btn{flex:none;font-size:12px;padding:4px 9px;cursor:pointer}.trd-icon-btn{width:28px;height:28px;min-width:28px;min-height:28px;display:inline-flex;align-items:center;justify-content:center;padding:0;font-size:17px;line-height:1;vertical-align:top}.trd-svg-icon{width:14px;height:14px;display:block;margin:auto}.trd-close-icon{width:15px;height:15px;display:block;margin:auto}.trd-select{flex:1;min-width:64px;height:28px;border:1px solid #dadce0;border-radius:6px;background:#fff;color:#202124;font:inherit;font-size:12px;padding:0 5px}.trd-view-toggle{flex:none;display:flex;height:28px;border:1px solid #dadce0;border-radius:6px;overflow:hidden;background:#fff}.trd-view-btn{width:28px;height:26px;border:0;border-right:1px solid #dadce0;background:#fff;color:#5f6368;display:flex;align-items:center;justify-content:center;cursor:pointer}.trd-view-btn:last-child{border-right:0}.trd-view-btn.trd-active{background:#e8f0fe;color:#174ea6}.trd-view-icon{width:15px;height:15px;display:block}.trd-file{display:none}.trd-body{flex:1;min-height:0;overflow-y:auto}.trd-resize-top,.trd-resize-left,.trd-resize-corner{position:absolute;z-index:6;touch-action:none}.trd-resize-top{top:0;left:10px;right:0;height:6px;cursor:ns-resize}.trd-resize-left{top:10px;left:0;bottom:0;width:6px;cursor:ew-resize}.trd-resize-corner{top:0;left:0;width:12px;height:12px;cursor:nwse-resize}.trd-resizing{user-select:none}' +
    '.trd-msg{padding:16px 12px;color:#5f6368}.trd-item{position:relative;padding:8px 74px 9px 18px;border-top:1px solid #f1f3f4;cursor:pointer;content-visibility:auto;contain-intrinsic-size:auto 58px}.trd-item.trd-selected{background:#e8f0fe;box-shadow:inset 3px 0 0 #1a73e8}.trd-item.trd-copy-only{padding-right:18px}.trd-item.trd-suggestion-item .trd-fix{font-weight:500}.trd-diagram-composer{padding:10px 12px;border-bottom:1px solid #e0e0e0;background:#f8f9fa}.trd-diagram-prompt{display:block;width:100%;min-height:58px;resize:vertical;border:1px solid #dadce0;border-radius:6px;padding:6px 8px;font:inherit;font-size:12px;line-height:1.45;color:#202124;background:#fff}.trd-diagram-prompt:focus{outline:none;border-color:#1a73e8;box-shadow:0 0 0 1px #1a73e8}.trd-diagram-actions{display:flex;justify-content:flex-end;margin-top:6px}.trd-diagram-generate{background:#1a73e8;border-color:#1a73e8;color:#fff;font-weight:600}.trd-diagram-generate:hover:not(:disabled){background:#1765cc}.trd-diagram-from-selection{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:8px}.trd-diagram-from-label{font-size:11px;color:#5f6368;margin-right:2px}.trd-diagram-mode-btn{font-size:11px;padding:2px 7px}.trd-diagram-preview{margin:6px -56px 0 0;padding:6px;border:1px solid #e0e0e0;border-radius:6px;background:#fff}.trd-diagram-preview-svg{display:block;width:100%;height:auto;max-height:240px}.trd-apply-btn,.trd-ignore-btn,.trd-suggestion-delete-btn{position:absolute;top:10px;width:24px;height:24px;border:1px solid #dadce0;border-radius:6px;background:#fff;color:#1a73e8;display:flex;align-items:center;justify-content:center;cursor:pointer}.trd-apply-btn,.trd-suggestion-delete-btn{right:10px}.trd-ignore-btn{right:40px;color:#5f6368}.trd-suggestion-delete-btn{color:#5f6368}.trd-apply-btn:disabled,.trd-ignore-btn:disabled,.trd-suggestion-delete-btn:disabled{opacity:.5;cursor:default}.trd-apply-icon{width:14px;height:14px;display:block}' +
    '.trd-cursor-marker{height:0;border-top:2px solid #1a73e8;margin:2px 0;position:relative}.trd-cursor-marker:before{content:"";position:absolute;left:12px;top:-4px;width:6px;height:6px;border-radius:50%;background:#1a73e8}' +
    '.trd-hit{font-weight:700;color:#d93025}.trd-ctx,.trd-fix,.trd-explain{font-size:12px}.trd-line{color:#80868b;margin-left:6px}.trd-explain{margin-top:4px;color:#5f6368}' +
    '.trd-foot{padding:8px 12px;font-size:11px;color:#80868b;border-top:1px solid #e0e0e0}' +
    '.trd-statusbar-notice{color:#188038}.trd-statusbar{position:relative}.trd-statusbar-jobs{flex:none;margin-left:auto;height:18px;padding:0 7px;border:1px solid #dadce0;border-radius:9px;background:#fff;color:#5f6368;font:inherit;font-size:10px;line-height:16px;cursor:pointer}.trd-statusbar-count+.trd-statusbar-jobs{margin-left:0}.trd-statusbar-jobs.trd-active{color:#1a73e8;border-color:#8ab4f8}.trd-statusbar-jobs.trd-on{background:#e8f0fe;color:#174ea6}.trd-jobs{position:absolute;left:6px;right:6px;bottom:calc(100% + 4px);max-height:300px;display:flex;flex-direction:column;background:#fff;border:1px solid #dadce0;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.18);white-space:normal;z-index:7;color:#202124}.trd-jobs-head{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid #f1f3f4}.trd-jobs-title{font-weight:700;font-size:12px;margin-right:auto}.trd-jobs-conc{display:flex;align-items:center;gap:4px;font-size:11px;color:#5f6368}.trd-jobs-btn{border:1px solid #dadce0;border-radius:5px;background:#fff;color:#3c4043;font:inherit;font-size:11px;line-height:16px;padding:0 6px;cursor:pointer}.trd-jobs-btn:disabled{opacity:.4;cursor:default}.trd-jobs-btn:hover:not(:disabled){background:#f1f3f4}.trd-jobs-list{overflow-y:auto}.trd-jobs-empty{padding:10px;font-size:11px;color:#80868b}.trd-job{display:flex;align-items:center;gap:6px;padding:6px 8px;border-top:1px solid #f5f6f7}.trd-job:first-child{border-top:0}.trd-job-main{flex:1;min-width:0}.trd-job-name{font-size:11px;font-weight:600}.trd-job-detail{font-size:11px;color:#5f6368;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.trd-job-actions{flex:none;display:flex;gap:3px}.trd-job-running .trd-job-name{color:#1a73e8}.trd-job-error .trd-job-name{color:#d93025}.trd-job-canceled .trd-job-name,.trd-job-done .trd-job-name{color:#5f6368}' +
    '.trd-notice{padding:6px 12px;font-size:12px;background:#fef7e0;color:#b06000}' +
    '.trd-foot{display:flex;align-items:center;gap:8px}.trd-foot-text{flex:1;min-width:0}.trd-statusbar{display:flex;align-items:center;gap:8px;padding:3px 12px;font-size:11px;line-height:16px;color:#5f6368;background:#f1f3f4;border-top:1px solid #e0e0e0;white-space:nowrap}.trd-statusbar-status{flex:1;min-width:0;display:flex;align-items:center;gap:5px}.trd-statusbar-text{overflow:hidden;text-overflow:ellipsis}.trd-statusbar-count{flex:none;margin-left:auto;color:#1a73e8}.trd-statusbar-running{color:#1a73e8}.trd-statusbar-error{color:#d93025}.trd-bridge-badge{flex:none;height:20px;display:inline-flex;align-items:center;gap:4px;padding:0 6px;border:1px solid #dadce0;border-radius:10px;background:#fff;color:#5f6368;font:inherit;font-size:10px;line-height:18px;cursor:pointer}.trd-bridge-badge:hover{background:#f1f3f4}.trd-bridge-dot{width:6px;height:6px;border-radius:50%;background:#9aa0a6}.trd-bridge-ok .trd-bridge-dot{background:#188038}.trd-bridge-error .trd-bridge-dot{background:#d93025}.trd-bridge-checking .trd-bridge-dot{background:#fbbc04}.trd-addon-status{font-weight:600;color:#3c4043}.trd-addon-status-error{color:#5f6368}.trd-foot-actions{display:flex;align-items:center;gap:6px;flex:none;height:28px;line-height:0}.trd-settings-btn,.trd-facts-btn,.trd-terms-btn,.trd-suggestions-btn,.trd-diagrams-btn,.trd-addons-btn{width:28px;height:28px;color:#5f6368}.trd-facts-head-actions{display:flex;gap:6px}.trd-facts-btn.trd-on,.trd-terms-btn.trd-on,.trd-suggestions-btn.trd-on,.trd-diagrams-btn.trd-on{background:#e8f0fe;color:#174ea6}.trd-terms-view{padding:10px}.trd-terms-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}.trd-terms-title{font-weight:700;color:#202124}.trd-terms-table-wrap{overflow-x:auto;border:1px solid #e0e0e0;border-radius:6px}.trd-terms-table{width:100%;min-width:560px;border-collapse:collapse;font-size:12px}.trd-terms-table th,.trd-terms-table td{padding:7px 8px;border-bottom:1px solid #f1f3f4;text-align:left;vertical-align:top}.trd-terms-table th{background:#f8f9fa;color:#5f6368}.trd-terms-filter{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px}.trd-terms-chip{border:1px solid #dadce0;border-radius:12px;background:#fff;color:#3c4043;font:inherit;font-size:11px;line-height:18px;padding:0 8px;cursor:pointer}.trd-terms-chip.trd-on{background:#e8f0fe;border-color:#8ab4f8;color:#174ea6}.trd-terms-note{font-size:11px;color:#5f6368;margin-bottom:6px}.trd-terms-kind{display:inline-block;margin-bottom:3px;padding:0 5px;border-radius:4px;font-size:10px;line-height:16px;background:#f1f3f4;color:#5f6368}.trd-terms-kind-particle{background:#fce8e6;color:#c5221f}.trd-addons-wrap{position:relative;flex:none;width:28px;height:28px;display:flex;align-items:center}.trd-addons-menu{position:absolute;right:0;bottom:34px;min-width:160px;background:#fff;border:1px solid #dadce0;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.18);padding:4px;z-index:5}.trd-addons-empty{padding:8px 10px;font-size:12px;color:#80868b}.trd-addons-item{display:block;width:100%;text-align:left;border:0;background:#fff;color:#202124;font:inherit;font-size:13px;padding:8px 10px;border-radius:6px;cursor:pointer}.trd-addons-item:hover:not(:disabled){background:#f1f3f4}.trd-addons-item:disabled{opacity:.5;cursor:default}.trd-addons-subitem{padding-left:22px;font-size:12px}' +
    '.trd-context-menu{position:absolute;z-index:6;min-width:116px;padding:4px;border:1px solid #dadce0;border-radius:8px;background:#fff;box-shadow:0 4px 16px rgba(0,0,0,.18)}.trd-context-item{display:block;width:100%;border:0;border-radius:6px;background:#fff;color:#202124;font:inherit;font-size:12px;text-align:left;padding:7px 10px;cursor:pointer}.trd-context-item:hover{background:#f1f3f4}';

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
  // 드래그한 영역의 글자수 집계 ({ chars, charsNoSpace, words } 또는 null)
  let selectionCount = null;
  // 마지막으로 글자수를 센 선택 범위('start:end'). 같으면 본문을 다시 읽지 않는다.
  let lastSelectionSpanKey = '';
  let ignoredFindingKeys = new Set();
  let ignoredFindingDocId = null;
  let applyingFindingKey = null;
  let addonBusyActions = new Map(); // 작업 id → 진행 중인 개수 (AI 작업은 같은 종류를 여러 개 동시에 돌릴 수 있다)
  // AI 작업 큐. 동시 실행 수를 넘는 요청은 대기했다가 차례로 실행된다.
  let aiJobs = [];
  let aiJobSeq = 0;
  let aiConcurrency = 3;
  let jobQueueOpen = false;
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
  let factsViewOpen = false;
  let factReport = null;
  let factReportDocId = null;
  let autoTermsStartedDocId = null;
  let autoTermsTimer = null;
  // AI 도해 결과(도해 탭에 표시). 문서별로 chrome.storage.local에 저장한다.
  let diagramResults = [];
  let diagramResultsDocId = null;
  // 독스 copy 이벤트에서 마지막으로 읽은 데이터. AI 도해가 선택 영역의 이미지·그리기를 얻을 때 쓴다.
  let lastDocsCopy = null;
  const docsCopyCaptureWindows = new WeakSet();

  let host = null;
  let shadowRoot = null;
  let shadowView = null;
  let panelCss = null;
  let expanded = false; // 펼침 상태는 메모리만 (미저장)
  let addonsMenuOpen = false; // 푸터 추가기능 메뉴 펼침 상태 (메모리만)
  let charMenuOpen = false; // 푸터 특수문자 프리셋 팔레트 펼침 상태 (메모리만)
  let stylePresetMenuOpen = false; // 추가기능 안 단락 스타일 셋팅 하위 목록 펼침 상태
  let diagramPromptDraft = ''; // 도해 탭 입력 창 내용 (메모리만, 다시 그려도 유지)
  let suggestionsViewOpen = false; // AI 문장 제안 전용 보기
  let diagramsViewOpen = false; // AI 도해 결과 전용 보기
  let termKindFilter = 'all'; // 용어 통일 표 종류 필터 (메모리만)
  let panelSize = null; // 사용자가 핸들로 바꾼 패널 크기 {w,h} (chrome.storage.local에 저장)
  let findingContextMenu = null;
  let nativeControlInteractionUntil = 0;
  let deferredRenderOptions = null;
  let deferredRenderTimer = null;
  let toastTimer = null;
  let statusNotice = null; // 상태 표시줄에 잠시 띄우는 안내 {text, error}
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
      copyOnSelect: s.copyOnSelect !== false,
      charPresetDirectInsert: s.charPresetDirectInsert === true,
      externalFeaturesEnabled: s.externalFeaturesEnabled === true
    };
  }

  function externalFeaturesEnabled() {
    return settings && settings.externalFeaturesEnabled === true;
  }

  function syncExternalFeatureState() {
    if (externalFeaturesEnabled()) return;
    suggestionsViewOpen = false;
    diagramsViewOpen = false;
    if (isSentenceSuggestionSource(activeRulesSource) && builtinRulesJson) {
      useRulesSource('builtin');
    }
    stopBridgeStatusWatcher();
    bridgeStatusBusy = false;
    bridgeStatus = {
      state: 'unknown',
      checkedAt: 0,
      port: DEFAULT_BRIDGE_PORT,
      version: '',
      error: ''
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
    return validStringList(value.rejectBefore) &&
      validStringList(value.rejectAfter) &&
      validBoolean(value.allowCodeToken);
  }

  function validBoolean(value) {
    return value === undefined || typeof value === 'boolean';
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
      selectionCount = null;
      lastSelectionSpanKey = '';
      generatedRulesFiles = [];
      generatedRulesLoadedDocId = null;
      restoreAiJobs(docId);
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
        // text·selection이 같은 getText 응답이라 오프셋이 이 본문과 정확히 맞는다.
        syncSelectionCountFromModel(text, model.selection);
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
          selectionCount = null;
          lastSelectionSpanKey = '';
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
    host.style.cssText = 'position:fixed;right:24px;bottom:96px;z-index:2147483646;' + (GRID_FRAME ? 'display:none;' : '');
    shadowRoot = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = await loadPanelCss();
    shadowRoot.appendChild(style);
    shadowView = el('div', 'trd-wrap');
    shadowRoot.appendChild(shadowView);
    (document.body || document.documentElement).appendChild(host);
    loadPanelSize();
    loadAiConcurrency();
    render();
  }

  function removePanel() {
    closeFindingContextMenu();
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

  // 도해 아이콘 — 상자 두 개를 잇는 화살표
  function diagramsIcon() {
    return strokedSvg(['M3 5h7v6H3z', 'M14 13h7v6h-7z', 'M6.5 11v5h7.5', 'M11 13.5l3 2.5-3 2.5'], 'trd-svg-icon');
  }

  // 사실 검증 아이콘 — 돋보기 안에 체크
  function factsIcon() {
    return strokedSvg(['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4-4', 'M8 11l2 2 4-4'], 'trd-svg-icon');
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
    const actions = [
      { id: 'export-hwpx', label: 'HWPX 내보내기', run: handleExportHwpxAddon },
      { id: 'extract-images', label: '이미지 추출', run: handleExtractImagesAddon },
      { id: 'extract-toc', label: '목차 추출', run: handleExtractTocAddon },
      { id: 'style-preset', label: '단락 스타일 셋팅', expandable: 'style' }
    ];
    if (!externalFeaturesEnabled()) return actions;
    return [
      { id: 'ai-proofread', label: 'AI 교정 생성', run: handleAiProofreadAddon },
      { id: 'ai-verify', label: 'AI 사실 검증', run: handleAiVerifyAddon },
      { id: 'ai-length', label: 'AI 문장 길이 조절', run: handleAiLengthAddon },
      ...actions
    ];
  }

  function isAddonBusy(actionId) {
    return addonBusyActions.has(actionId);
  }

  function setAddonBusy(actionId, busy) {
    const n = (addonBusyActions.get(actionId) || 0) + (busy ? 1 : -1);
    if (n > 0) addonBusyActions.set(actionId, n);
    else addonBusyActions.delete(actionId);
  }

  // 동시에 여러 개 돌릴 수 있는 AI 작업. 이 작업들은 진행 중이어도 버튼을 막지 않는다.
  const CONCURRENT_AI_ACTIONS = new Set(['ai-proofread', 'ai-verify', 'ai-length', 'ai-diagram']);

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
      charMenuOpen = false;
      suggestionsViewOpen = false;
      diagramsViewOpen = false;
      termsViewOpen = false;
      factsViewOpen = false;
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
      charMenuOpen = false;
      termsViewOpen = false;
      factsViewOpen = false;
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

  function buildDiagramsButton() {
    const btn = el('button', 'trd-btn trd-icon-btn trd-diagrams-btn' + (diagramsViewOpen ? ' trd-on' : ''));
    btn.type = 'button';
    btn.appendChild(diagramsIcon());
    btn.setAttribute('aria-label', 'AI 도해');
    btn.setAttribute('aria-pressed', diagramsViewOpen ? 'true' : 'false');
    btn.title = 'AI 도해';
    btn.addEventListener('click', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      const next = !diagramsViewOpen;
      addonsMenuOpen = false;
      charMenuOpen = false;
      termsViewOpen = false;
      factsViewOpen = false;
      suggestionsViewOpen = false;
      diagramsViewOpen = next;
      render();
    });
    return btn;
  }

  function buildTermsButton() {
    const btn = el('button', 'trd-btn trd-icon-btn trd-terms-btn' + (termsViewOpen ? ' trd-on' : ''));
    btn.type = 'button';
    btn.appendChild(termsIcon());
    btn.setAttribute('aria-label', '용어 통일 표');
    btn.setAttribute('aria-pressed', termsViewOpen ? 'true' : 'false');
    btn.title = '용어 통일 표';
    btn.disabled = isAddonBusy('ai-terms');
    btn.addEventListener('click', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      addonsMenuOpen = false;
      charMenuOpen = false;
      suggestionsViewOpen = false;
      diagramsViewOpen = false;
      factsViewOpen = false;
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

  // 특수문자 프리셋 — 원고에서 자주 쓰는 동글뱅이 번호와 화살표를 커서 위치에 삽입한다.
  const CHAR_PRESET_ITEMS = ['❶', '❷', '❸', '❹', '❺', '❻', '❼', '❽', '❾', '▶', '➝'];

  // 기본은 클립보드 복사, 설정(charPresetDirectInsert)을 켜면 커서 위치에 바로 입력한다.
  function insertPresetChar(ch) {
    if (settings.charPresetDirectInsert) {
      styleBridgeOp('typeText', { text: ch }).then(() => {
        showToast(ch + ' 삽입됨', { durationMs: 1400 });
      }).catch(error => {
        console.error('[Toytype char preset] insert failed', error);
        showToast('문자 삽입 실패 — ' + styleShortErrorText(error), { durationMs: 4200 });
      });
      return;
    }
    copyText(ch).then(
      () => showToast(ch + ' 복사됨', { durationMs: 1400 }),
      () => showToast('클립보드 복사 실패', { durationMs: 2600 })
    );
  }

  function buildCharMenu() {
    const menu = el('div', 'trd-chars-menu');
    menu.setAttribute('role', 'menu');
    for (const ch of CHAR_PRESET_ITEMS) {
      const item = el('button', 'trd-chars-item');
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.textContent = ch;
      item.title = ch + ' 삽입';
      item.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        insertPresetChar(ch);
      });
      menu.appendChild(item);
    }
    return menu;
  }

  function buildCharPresetButton() {
    const wrap = el('div', 'trd-addons-wrap');
    const btn = el('button', 'trd-btn trd-icon-btn trd-chars-btn' + (charMenuOpen ? ' trd-on' : ''));
    btn.type = 'button';
    btn.textContent = '❶';
    btn.setAttribute('aria-label', '특수문자 프리셋');
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', charMenuOpen ? 'true' : 'false');
    btn.title = '특수문자 프리셋';
    btn.addEventListener('click', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      charMenuOpen = !charMenuOpen;
      addonsMenuOpen = false;
      render();
    });
    wrap.appendChild(btn);
    if (charMenuOpen) wrap.appendChild(buildCharMenu());
    return wrap;
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
      charMenuOpen = false;
      termsViewOpen = false;
      factsViewOpen = false;
      openSettingsPageFromDocs();
    });
    return btn;
  }

  function buildFactsButton() {
    const btn = el('button', 'trd-btn trd-icon-btn trd-facts-btn' + (factsViewOpen ? ' trd-on' : ''));
    btn.type = 'button';
    btn.appendChild(factsIcon());
    btn.setAttribute('aria-label', 'AI 사실 검증');
    btn.setAttribute('aria-pressed', factsViewOpen ? 'true' : 'false');
    btn.title = 'AI 사실 검증';
    btn.addEventListener('click', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      addonsMenuOpen = false;
      charMenuOpen = false;
      suggestionsViewOpen = false;
      diagramsViewOpen = false;
      termsViewOpen = false;
      factsViewOpen = !factsViewOpen;
      render();
    });
    return btn;
  }

  function buildFooterActions() {
    const wrap = el('div', 'trd-foot-actions');
    // 자리가 모자라 AI 기능이 켜져 있으면 설정 대신 사실 검증 버튼을 둔다(설정은 툴바 팝업에서 연다)
    wrap.append(externalFeaturesEnabled() ? buildFactsButton() : buildSettingsButton(), buildTermsButton(), buildCharPresetButton());
    if (externalFeaturesEnabled()) wrap.append(buildSuggestionsButton(), buildDiagramsButton());
    wrap.appendChild(buildAddonsButton());
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
      item.disabled = applyingFindingKey !== null || (!CONCURRENT_AI_ACTIONS.has(action.id) && isAddonBusy(action.id));
      if (action.expandable) {
        const isStyle = action.expandable === 'style';
        const open = stylePresetMenuOpen;
        item.textContent = action.label + (open ? ' ▾' : ' ▸');
        item.setAttribute('aria-expanded', open ? 'true' : 'false');
        item.addEventListener('click', ev => {
          ev.preventDefault();
          ev.stopPropagation();
          stylePresetMenuOpen = !stylePresetMenuOpen;
          render();
        });
        menu.appendChild(item);
        if (open) {
          for (const sub of buildStylePresetSubItems()) menu.appendChild(sub);
        }
        continue;
      }
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

  function buildStylePresetSubItems() {
    const options = [{ keys: STYLE_PRESET_DEFS.map(d => d.key), label: '전체 셋팅' }]
      .concat(STYLE_PRESET_DEFS.map(d => ({ keys: [d.key], label: d.label })));
    return options.map(option => {
      const btn = el('button', 'trd-addons-item trd-addons-subitem');
      btn.type = 'button';
      btn.setAttribute('role', 'menuitem');
      btn.textContent = option.label;
      btn.disabled = applyingFindingKey !== null || isAddonBusy('style-preset');
      btn.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        addonsMenuOpen = false;
        stylePresetMenuOpen = false;
        render();
        handleStylePresetAddon(option.keys);
      });
      return btn;
    });
  }

  // 도해 탭의 선택 영역 기반 생성 버튼. 입력 창에 적은 내용은 추가 지시로 함께 보낸다.
  const DIAGRAM_MENU_ITEMS = [
    { mode: 'diagram', label: '선택한 글 → 도해', title: '문서에서 선택한 글의 내용을 도해로 그립니다' },
    { mode: 'redraw', label: '이미지 → 그리기', title: '선택한 이미지 속 도해를 편집할 수 있는 구글 그리기 도형으로 다시 그립니다' },
    { mode: 'annotate', label: '스크린샷 강조', title: '선택한 스크린샷에 강조 상자와 설명을 얹습니다' },
    { mode: 'edit', label: '그리기 수정', title: '선택한 구글 그리기를 입력 창의 지시대로 고칩니다 (비워 두면 정렬·간격만 다듬음)' }
  ];

  function buildDiagramComposer() {
    const busy = false; // 도해는 여러 개를 동시에 만들 수 있다(작업 큐가 순서를 관리)
    const box = el('div', 'trd-diagram-composer');
    const ta = el('textarea', 'trd-diagram-prompt');
    ta.rows = 3;
    ta.value = diagramPromptDraft;
    ta.placeholder = '만들 도해를 설명하세요 (⌘Enter로 생성)\n예: HTTP 요청이 로드밸런서 → 웹 서버 → DB로 가는 흐름';
    ta.disabled = busy;
    // 독스 단축키가 입력을 가로채지 않게 키 이벤트를 패널 안에서 끝낸다
    for (const type of ['keydown', 'keypress', 'keyup']) {
      ta.addEventListener(type, ev => {
        ev.stopPropagation();
        if (type === 'keydown' && ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
          ev.preventDefault();
          handleAiDiagramAddon('prompt', { prompt: ta.value });
        }
      });
    }
    ta.addEventListener('input', () => { diagramPromptDraft = ta.value; });
    const primary = el('button', 'trd-btn trd-diagram-generate');
    primary.type = 'button';
    primary.textContent = busy ? '생성 중…' : '프롬프트로 생성';
    primary.disabled = busy;
    primary.addEventListener('click', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      handleAiDiagramAddon('prompt', { prompt: ta.value });
    });
    const row = el('div', 'trd-diagram-actions');
    row.appendChild(primary);
    const fromSel = el('div', 'trd-diagram-from-selection');
    const label = el('span', 'trd-diagram-from-label');
    label.textContent = '선택 영역으로:';
    fromSel.appendChild(label);
    for (const option of DIAGRAM_MENU_ITEMS) {
      const btn = el('button', 'trd-btn trd-diagram-mode-btn');
      btn.type = 'button';
      btn.textContent = option.label;
      btn.title = option.title + ' · 입력 창 내용은 추가 지시로 보냅니다';
      btn.disabled = busy || applyingFindingKey !== null;
      // 선택 영역 복사는 클릭의 사용자 활성화 안에서 동기로 일어나야 하므로 바로 부른다
      btn.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        handleAiDiagramAddon(option.mode, { prompt: ta.value });
      });
      fromSel.appendChild(btn);
    }
    box.append(ta, row, fromSel);
    return box;
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

  function render(options) {
    if (!shadowView) return;
    closeFindingContextMenu();
    const opts = options && typeof options === 'object' ? options : {};
    if (shouldDeferRenderForNativeControl(opts)) {
      deferRender(opts);
      return;
    }
    const prevBody = opts.preserveBodyScroll ? shadowView.querySelector('.trd-body') : null;
    const prevBodyScrollTop = prevBody ? prevBody.scrollTop : 0;
    // 표(용어·사실 검증)의 좌우 스크롤, 작업 큐 목록 스크롤은 다시 그려도 유지한다
    const INNER_SCROLL = '.trd-terms-table-wrap, .trd-jobs-list';
    const innerScroll = Array.from(shadowView.querySelectorAll(INNER_SCROLL)).map(node => [node.scrollLeft, node.scrollTop]);
    // 도해 입력 창에 입력 중이면 다시 그린 뒤에도 포커스와 커서를 그대로 둔다
    const active = shadowRoot && shadowRoot.activeElement;
    const promptFocus = active && active.classList && active.classList.contains('trd-diagram-prompt')
      ? { start: active.selectionStart, end: active.selectionEnd, scrollTop: active.scrollTop, bodyScroll: (shadowView.querySelector('.trd-body') || {}).scrollTop || 0 }
      : null;
    shadowView.textContent = '';
    shadowView.appendChild(expanded ? buildPanel() : buildBubble());
    if (innerScroll.length) {
      const nodes = shadowView.querySelectorAll(INNER_SCROLL);
      innerScroll.forEach(([left, top], i) => {
        if (!nodes[i]) return;
        nodes[i].scrollLeft = left;
        nodes[i].scrollTop = top;
      });
    }
    if (promptFocus) {
      const ta = shadowView.querySelector('.trd-diagram-prompt');
      if (ta && !ta.disabled) {
        ta.focus({ preventScroll: true });
        try { ta.setSelectionRange(promptFocus.start, promptFocus.end); } catch (_) { /* 무시 */ }
        ta.scrollTop = promptFocus.scrollTop;
        const nextBody = shadowView.querySelector('.trd-body');
        if (nextBody && !opts.preserveBodyScroll) nextBody.scrollTop = promptFocus.bodyScroll;
      }
    }
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
      !diagramsViewOpen &&
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

  // ---------- 패널 크기 조절 ----------
  // 패널은 화면 우하단(right/bottom)에 붙어 있으므로 위쪽 경계를 끌면 높이, 왼쪽 경계를 끌면 너비가 바뀐다.
  const PANEL_SIZE_KEY = 'docsPanelSize';
  const PANEL_MIN_W = 280;
  const PANEL_MIN_H = 220;
  const PANEL_HOST_RIGHT = 24;
  const PANEL_HOST_BOTTOM = 96;

  function clampPanelSize(size) {
    if (!size) return null;
    const maxW = Math.max(PANEL_MIN_W, window.innerWidth - PANEL_HOST_RIGHT - 16);
    const maxH = Math.max(PANEL_MIN_H, window.innerHeight - PANEL_HOST_BOTTOM - 16);
    const w = Number(size.w);
    const h = Number(size.h);
    return {
      w: Number.isFinite(w) ? Math.round(Math.min(maxW, Math.max(PANEL_MIN_W, w))) : null,
      h: Number.isFinite(h) ? Math.round(Math.min(maxH, Math.max(PANEL_MIN_H, h))) : null
    };
  }

  function applyPanelSize(panel) {
    const size = clampPanelSize(panelSize);
    if (!size) return;
    if (size.w) panel.style.width = size.w + 'px';
    if (size.h) {
      panel.style.height = size.h + 'px';
      panel.style.maxHeight = 'none';
    }
  }

  function loadPanelSize() {
    try {
      chrome.storage.local.get(PANEL_SIZE_KEY, items => {
        if (chrome.runtime.lastError) return;
        const saved = items && items[PANEL_SIZE_KEY];
        if (saved && typeof saved === 'object') {
          panelSize = { w: saved.w, h: saved.h };
          if (expanded) render({ preserveBodyScroll: true });
        }
      });
    } catch (_) {
      // 확장 컨텍스트가 무효화된 경우 — 기본 크기로 둔다
    }
  }

  function savePanelSize() {
    try {
      if (panelSize) chrome.storage.local.set({ [PANEL_SIZE_KEY]: panelSize });
      else chrome.storage.local.remove(PANEL_SIZE_KEY);
    } catch (_) {
      // 저장 실패는 무시 (이번 세션 메모리 값은 유지)
    }
  }

  function buildResizeHandle(panel, className, axis) {
    const handle = el('div', className);
    handle.title = '끌어서 크기 조절 · 더블클릭하면 기본 크기';
    handle.addEventListener('pointerdown', ev => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      const rect = panel.getBoundingClientRect();
      const start = { x: ev.clientX, y: ev.clientY, w: rect.width, h: rect.height };
      let next = null;
      handle.setPointerCapture(ev.pointerId);
      panel.classList.add('trd-resizing');
      const onMove = moveEv => {
        const raw = {
          w: axis.includes('x') ? start.w + (start.x - moveEv.clientX) : start.w,
          h: axis.includes('y') ? start.h + (start.y - moveEv.clientY) : start.h
        };
        next = clampPanelSize(raw);
        if (axis.includes('x')) panel.style.width = next.w + 'px';
        if (axis.includes('y')) {
          panel.style.height = next.h + 'px';
          panel.style.maxHeight = 'none';
        }
      };
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        panel.classList.remove('trd-resizing');
        if (!next) return;
        // 끌지 않은 축은 저장하지 않아 기본(65vh 한도 자동 높이 등)을 유지한다
        panelSize = {
          w: axis.includes('x') ? next.w : (panelSize && panelSize.w) || null,
          h: axis.includes('y') ? next.h : (panelSize && panelSize.h) || null
        };
        savePanelSize();
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
    handle.addEventListener('dblclick', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      panelSize = null;
      savePanelSize();
      render({ preserveBodyScroll: true });
    });
    return handle;
  }

  function appendResizeHandles(panel) {
    panel.append(
      buildResizeHandle(panel, 'trd-resize-top', 'y'),
      buildResizeHandle(panel, 'trd-resize-left', 'x'),
      buildResizeHandle(panel, 'trd-resize-corner', 'xy')
    );
  }

  function buildPanel() {
    const panel = el('div', 'trd-panel');
    applyPanelSize(panel);
    // 작업 큐 팝업은 푸터 위에 뜨므로, 팝업 밖을 누르면 닫고 누른 버튼은 그대로 동작하게 한다
    panel.addEventListener('pointerdown', ev => {
      if (!jobQueueOpen) return;
      const path = ev.composedPath ? ev.composedPath() : [];
      if (path.some(node => node && node.classList && (node.classList.contains('trd-jobs') || node.classList.contains('trd-statusbar-jobs')))) return;
      jobQueueOpen = false;
      const pop = panel.querySelector('.trd-jobs');
      if (pop) pop.remove();
      const jobsBtn = panel.querySelector('.trd-statusbar-jobs');
      if (jobsBtn) {
        jobsBtn.classList.remove('trd-on');
        jobsBtn.setAttribute('aria-expanded', 'false');
      }
    }, true);

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
    } else if (factsViewOpen) {
      appendFactsView(body);
    } else if (suggestionsViewOpen) {
      appendSentenceSuggestionsView(body);
    } else if (diagramsViewOpen) {
      appendDiagramsView(body);
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

    // 푸터: 브리지 상태 점과 버튼만 둔다. 선택 글자 수와 AI 작업 진행은 아래 상태 표시줄 한 줄에.
    const foot = el('div', 'trd-foot');
    if (externalFeaturesEnabled()) foot.appendChild(buildBridgeStatusBadge());
    foot.append(el('div', 'trd-foot-text'), buildFooterActions());
    panel.appendChild(foot);
    const statusBar = buildStatusBar();
    if (statusBar) panel.appendChild(statusBar);

    appendResizeHandles(panel);
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

  function appendDiagramsView(body) {
    if (externalFeaturesEnabled()) body.appendChild(buildDiagramComposer());
    const diagrams = diagramResultsForDoc();
    if (diagrams.length === 0) {
      const msg = el('div', 'trd-msg');
      msg.textContent = '아직 만든 도해가 없습니다.';
      body.appendChild(msg);
      return;
    }
    for (const diagram of diagrams) body.appendChild(buildDiagramResultItem(diagram));
  }

  function appendTermsView(body) {
    const docId = getDocId();
    const report = termReportDocId === docId ? termReport : null;
    const wrap = el('div', 'trd-terms-view');
    const head = el('div', 'trd-terms-head');
    const title = el('div', 'trd-terms-title');
    title.textContent = '용어 통일 표';
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

    const allTerms = Array.isArray(report.terms) ? report.terms : [];
    const kindCounts = new Map();
    for (const term of allTerms) kindCounts.set(term.kind, (kindCounts.get(term.kind) || 0) + 1);
    if (termKindFilter !== 'all' && !kindCounts.has(termKindFilter)) termKindFilter = 'all';
    if (kindCounts.size > 1) wrap.appendChild(buildTermKindFilter(allTerms.length, kindCounts));
    const terms = termKindFilter === 'all' ? allTerms : allTerms.filter(term => term.kind === termKindFilter);
    for (const note of Array.isArray(report.notes) ? report.notes : []) {
      const n = el('div', 'trd-terms-note');
      n.textContent = note;
      wrap.appendChild(n);
    }
    if (terms.length === 0) {
      const msg = el('div', 'trd-msg');
      msg.textContent = '혼용된 용어나 조사 오류를 찾지 못했습니다.';
      wrap.appendChild(msg);
    } else {
      const tableWrap = el('div', 'trd-terms-table-wrap');
      const table = document.createElement('table');
      table.className = 'trd-terms-table';
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const label of ['표기', '권장', '근거']) {
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

  const FACT_STATUS_LABEL = {
    supported: '근거 있음',
    contradicted: '사실과 다름',
    unverifiable: '확인 불가',
    needs_context: '맥락 필요'
  };

  function buildFactsRunButton() {
    const btn = el('button', 'trd-btn trd-terms-refresh');
    btn.type = 'button';
    btn.textContent = '선택 영역 검증';
    btn.addEventListener('click', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      handleAiVerifyAddon();
    });
    return btn;
  }

  function appendFactsView(body) {
    const docId = getDocId();
    const report = factReportDocId === docId ? factReport : null;
    const wrap = el('div', 'trd-terms-view');
    const head = el('div', 'trd-terms-head');
    const title = el('div', 'trd-terms-title');
    title.textContent = 'AI 사실 검증';
    const closeBtn = el('button', 'trd-btn trd-terms-refresh');
    closeBtn.type = 'button';
    closeBtn.textContent = '닫기';
    closeBtn.addEventListener('click', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      factsViewOpen = false;
      render();
    });
    const headActions = el('div', 'trd-facts-head-actions');
    if (report) headActions.appendChild(buildFactsRunButton());
    headActions.appendChild(closeBtn);
    head.append(title, headActions);
    wrap.appendChild(head);

    if (isAddonBusy('ai-verify') && !report) {
      const msg = el('div', 'trd-msg');
      msg.textContent = '사실 검증 중…';
      wrap.appendChild(msg);
      body.appendChild(wrap);
      return;
    }
    if (!report) {
      const msg = el('div', 'trd-msg');
      msg.textContent = '검증할 문장을 선택하고 [선택 영역 검증]을 누르세요.';
      wrap.appendChild(msg);
      wrap.appendChild(buildFactsRunButton());
      body.appendChild(wrap);
      return;
    }

    // 웹 접근 여부는 판정 신뢰도에 직접 영향을 주므로 표 위에 명시한다.
    // 웹 없이 나온 판정은 검증이 아니라 모델의 기억이므로 눈에 띄게 경고한다.
    if (report.webAccess !== 'used') {
      const note = el('div', 'trd-msg trd-fact-warn');
      note.textContent = report.webAccess === 'partial'
        ? '일부 항목만 웹 근거를 확인했습니다. 근거 링크가 없는 항목은 모델 지식입니다.'
        : '웹 검색이 되지 않아 모델 지식만으로 판단했습니다. 검증 결과로 신뢰하지 마세요.';
      wrap.appendChild(note);
      if (report.provider !== 'codex') {
        const hint = el('div', 'trd-msg trd-fact-warn');
        hint.textContent = '팝업의 [AI 엔진]에서 Codex로 바꾸면 웹 검증이 동작합니다.';
        wrap.appendChild(hint);
      }
    }

    if (report.claims.length === 0) {
      const msg = el('div', 'trd-msg');
      msg.textContent = '검증할 사실 주장을 찾지 못했습니다.';
      wrap.appendChild(msg);
      body.appendChild(wrap);
      return;
    }

    const tableWrap = el('div', 'trd-terms-table-wrap');
    const table = document.createElement('table');
    table.className = 'trd-terms-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of ['주장', '판정', '근거']) {
      const th = document.createElement('th');
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    // 사실과 다른 항목을 위로 올린다 — 눈으로 훑을 때 놓치지 않도록.
    const order = { contradicted: 0, needs_context: 1, unverifiable: 2, supported: 3 };
    const claims = report.claims.slice().sort((a, b) => {
      const av = order[a.status] === undefined ? 9 : order[a.status];
      const bv = order[b.status] === undefined ? 9 : order[b.status];
      return av - bv;
    });
    for (const claim of claims) tbody.appendChild(buildFactRow(claim));
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    wrap.appendChild(tableWrap);
    body.appendChild(wrap);
  }

  function buildFactRow(claim) {
    const tr = document.createElement('tr');

    const source = document.createElement('td');
    const sourceText = el('div', 'trd-fact-source');
    sourceText.textContent = displayText(claim.sourceText);
    sourceText.title = '클릭하면 문서에서 이 부분을 선택합니다';
    sourceText.addEventListener('click', () => { selectFactClaimInDoc(claim); });
    source.appendChild(sourceText);

    const status = document.createElement('td');
    const badge = el('div', 'trd-fact-status trd-fact-' + claim.status);
    badge.textContent = FACT_STATUS_LABEL[claim.status] || claim.status;
    status.appendChild(badge);
    if (claim.confidence) {
      const conf = el('div', 'trd-fact-confidence');
      conf.textContent = claim.confidence;
      status.appendChild(conf);
    }

    const evidence = document.createElement('td');
    if (claim.finding) {
      const finding = el('div', 'trd-fact-finding');
      finding.textContent = displayText(claim.finding);
      evidence.appendChild(finding);
    }
    if (claim.suggestedReplacement) {
      const fix = el('div', 'trd-fact-fix');
      fix.textContent = '→ ' + displayText(claim.suggestedReplacement);
      fix.title = '클릭하면 교정문을 복사합니다';
      fix.addEventListener('click', () => {
        copyText(claim.suggestedReplacement).then(
          () => showToast('교정문 복사됨', { durationMs: 1400 }),
          () => showToast('클립보드 복사 실패', { durationMs: 2600 })
        );
      });
      evidence.appendChild(fix);
    }
    for (const src of claim.sources) {
      const url = String(src && src.url || '').trim();
      if (!url || !/^https?:\/\//i.test(url)) continue;
      const link = document.createElement('a');
      link.className = 'trd-fact-source-link';
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = String(src.publisher || src.title || url).slice(0, 40);
      link.title = url;
      evidence.appendChild(link);
    }

    tr.append(source, status, evidence);
    return tr;
  }

  // 표에서 주장을 누르면 문서의 해당 위치를 잡아 준다 (문장 제안 클릭과 같은 경로).
  async function selectFactClaimInDoc(claim) {
    const text = String(claim && claim.sourceText || '').trim();
    if (!text) return;
    let start = cachedText === null ? -1 : String(cachedText).indexOf(text);
    if (start === -1 || cachedTextSource !== 'model') {
      await refreshCachedModelTextForSuggestion();
      start = cachedText === null ? -1 : String(cachedText).indexOf(text);
    }
    if (start === -1 || cachedTextSource !== 'model') {
      showToast('문서에서 해당 문장을 찾지 못했습니다', { durationMs: 3000 });
      return;
    }
    selectDocsModelRange(start, start + text.length).then(res => {
      updateCursorOffset(res && res.selection ? res.selection : [{ start, end: start + text.length }]);
      showToast('문서 위치 선택됨', { durationMs: 1400 });
    }, () => {
      showToast('위치 선택 실패', { durationMs: 2600 });
    });
  }

  function buildTermKindFilter(total, kindCounts) {
    const bar = el('div', 'trd-terms-filter');
    const chips = [['all', '전체', total]];
    for (const kind of Object.keys(TERM_KIND_LABEL)) {
      if (kindCounts.has(kind)) chips.push([kind, TERM_KIND_LABEL[kind], kindCounts.get(kind)]);
    }
    for (const [kind, label, count] of chips) {
      const chip = el('button', 'trd-terms-chip' + (termKindFilter === kind ? ' trd-on' : ''));
      chip.type = 'button';
      chip.textContent = label + ' ' + count;
      chip.setAttribute('aria-pressed', termKindFilter === kind ? 'true' : 'false');
      chip.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        termKindFilter = kind;
        render({ preserveBodyScroll: true });
      });
      bar.appendChild(chip);
    }
    return bar;
  }

  function buildTermRow(term) {
    const tr = document.createElement('tr');
    const variants = document.createElement('td');
    if (term && TERM_KIND_LABEL[term.kind]) {
      const badge = el('span', 'trd-terms-kind trd-terms-kind-' + term.kind);
      badge.textContent = TERM_KIND_LABEL[term.kind];
      variants.appendChild(badge);
    }
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

  function buildDiagramResultItem(diagram) {
    const item = el('div', 'trd-item trd-suggestion-item trd-diagram-item');
    const ctx = el('div', 'trd-ctx');
    ctx.textContent = displayText(diagram.instruction || '');
    const fix = el('div', 'trd-fix');
    fix.textContent = diagram.title || '도해';
    const ln = el('span', 'trd-line');
    const kind = DIAGRAM_KIND_LABEL[diagram.kind] || (diagram.spec && diagram.spec.mode === 'annotate' ? '스크린샷 강조' : '도해');
    ln.textContent = kind + ' · ' + formatDiagramTime(diagram.createdAt) + (diagram.imageMissing ? ' · 이미지 없음' : '');
    fix.appendChild(ln);
    item.append(ctx, fix);
    const preview = buildDiagramPreview(diagram);
    if (preview) item.appendChild(preview);
    item.title = '누르면 복사 · 그리기 창에서 ⌘V';
    item.addEventListener('click', () => {
      copyDiagramResult(diagram);
    });
    const deleteBtn = el('button', 'trd-suggestion-delete-btn');
    deleteBtn.type = 'button';
    deleteBtn.appendChild(trashIcon());
    deleteBtn.title = '도해 삭제';
    deleteBtn.setAttribute('aria-label', '도해 삭제');
    deleteBtn.addEventListener('click', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      deleteDiagramResult(diagram.id);
    });
    item.appendChild(deleteBtn);
    return item;
  }

  // 도해 미리보기: 붙여넣을 그리기 명령을 SVG로 그린다. 실패하면 미리보기 없이 목록만 보인다.
  function buildDiagramPreview(diagram) {
    const clip = globalThis.ToytypeDrawingClip;
    if (!clip || typeof clip.buildPreviewSvg !== 'function' || !diagram || !diagram.spec) return null;
    try {
      const svg = clip.buildPreviewSvg(clip.buildDrawingPayload(diagram.spec, diagram.image || null), document);
      svg.setAttribute('class', 'trd-diagram-preview-svg');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', (diagram.title || '도해') + ' 미리보기');
      const wrap = el('div', 'trd-diagram-preview');
      wrap.appendChild(svg);
      return wrap;
    } catch (error) {
      debugLog('[Toytype addons] diagram preview failed', summarizeErrorForConsole(error));
      return null;
    }
  }

  function formatDiagramTime(ms) {
    const d = new Date(Number(ms) || Date.now());
    const pad = n => String(n).padStart(2, '0');
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  // copy 이벤트로 구글 그리기 내부 형식을 쓴다. 버튼 클릭 직후(사용자 활성화 안)에서만 동작한다.
  function copyDiagramResult(diagram) {
    const clip = globalThis.ToytypeDrawingClip;
    if (!clip) {
      showToast('도해 모듈을 찾지 못했습니다', { durationMs: 3200 });
      return;
    }
    try {
      const payload = clip.buildDrawingPayload(diagram.spec, diagram.image || null);
      if (!clip.writeDrawingClipboard(payload, document)) throw new Error('copy event was not delivered');
      showToast('도해 복사됨 · 그리기 창에서 ⌘V', { durationMs: 2800 });
    } catch (error) {
      console.error('[Toytype addons] diagram copy failed', summarizeErrorForConsole(error));
      showToast('도해 복사 실패', { durationMs: 3200 });
    }
  }

  function diagramResultsForDoc() {
    const docId = getDocId();
    return docId && diagramResultsDocId === docId ? diagramResults : [];
  }

  function loadDiagramResults() {
    const docId = getDocId();
    if (!docId) return Promise.resolve();
    return new Promise(resolve => {
      try {
        chrome.storage.local.get(DIAGRAM_STORE_KEY, items => {
          const store = items && items[DIAGRAM_STORE_KEY];
          const list = store && Array.isArray(store[docId]) ? store[docId] : [];
          // 다른 문서로 넘어간 뒤 늦게 도착한 결과는 버린다
          if (getDocId() === docId) {
            diagramResults = list;
            diagramResultsDocId = docId;
          }
          resolve();
        });
      } catch (_) {
        resolve();
      }
    });
  }

  // 이미지 data URL 때문에 저장소 한도에 걸리면 오래된 결과부터 뺀다.
  // 그래도 안 되면 이미지만 빼고 저장하고 메모리 결과는 그대로 쓴다.
  function saveDiagramResults() {
    const docId = diagramResultsDocId;
    if (!docId) return Promise.resolve();
    return new Promise(resolve => {
      try {
        chrome.storage.local.get(DIAGRAM_STORE_KEY, items => {
          const store = Object.assign({}, items && items[DIAGRAM_STORE_KEY]);
          const attempt = list => {
            store[docId] = list;
            chrome.storage.local.set({ [DIAGRAM_STORE_KEY]: store }, () => {
              if (!chrome.runtime.lastError) {
                resolve();
                return;
              }
              if (list.length > 1) attempt(list.slice(0, -1));
              else if (list.length === 1 && list[0].image) attempt([Object.assign({}, list[0], { image: null, imageMissing: true })]);
              else resolve();
            });
          };
          attempt(diagramResults.slice(0, DIAGRAM_MAX_PER_DOC));
        });
      } catch (_) {
        resolve();
      }
    });
  }

  function deleteDiagramResult(id) {
    diagramResults = diagramResults.filter(d => d.id !== id);
    saveDiagramResults();
    render();
    showToast('도해를 삭제했습니다');
  }

  // 독스는 ⌘C 때 텍스트 입력용 iframe 안에서 copy 이벤트를 처리한다. 독스 처리기가 데이터를 넣은 뒤
  // (버블 단계) 읽어서, 선택 영역에 든 이미지 주소와 그리기 명령을 기억해 둔다.
  function installDocsCopyCapture() {
    const windows = [window];
    const iframe = document.querySelector('iframe.docs-texteventtarget-iframe');
    try {
      if (iframe && iframe.contentWindow) windows.push(iframe.contentWindow);
    } catch (_) { /* 접근할 수 없는 iframe은 건너뛴다 */ }
    for (const w of windows) {
      if (docsCopyCaptureWindows.has(w)) continue;
      try {
        w.addEventListener('copy', onDocsCopy, false);
        docsCopyCaptureWindows.add(w);
      } catch (_) { /* 다음 설치 시도에서 다시 본다 */ }
    }
  }

  function onDocsCopy(ev) {
    const clip = globalThis.ToytypeDrawingClip;
    if (!clip || !ev || !ev.clipboardData) return;
    const data = clip.readCopyEventData(ev.clipboardData);
    if (!Object.keys(data).length) return;
    const summary = clip.summarizeDocsCopy(data);
    lastDocsCopy = Object.assign({ docId: getDocId(), at: Date.now() }, summary);
    debugLog('[Toytype addons] docs copy captured', {
      types: Object.keys(data),
      imageUrls: summary.imageUrls.length,
      drawing: !!summary.drawingCommands
    });
  }

  // [AI 도해]를 누른 순간(사용자 클릭 안) 선택 영역의 독스 원본 데이터를 얻는다.
  //  1) 텍스트 입력 iframe에서 copy를 일으켜, 독스 처리기가 넣은 데이터를 버블 단계에서 읽는다.
  //  2) 못 읽었으면 paste로 시스템 클립보드를 읽는다(clipboardRead 권한). 1)의 복사가 됐다면 그 내용이다.
  // 사용자 클립보드는 선택 영역 내용으로 바뀐다(⌘C와 같다). 클릭 핸들러 안에서 동기로 불러야 한다.
  function captureDocsSelection() {
    const startedAt = Date.now();
    installDocsCopyCapture();
    let copied = false;
    try {
      const iframe = document.querySelector('iframe.docs-texteventtarget-iframe');
      const d = iframe && iframe.contentDocument;
      if (d) copied = d.execCommand('copy');
    } catch (_) { /* 아래 paste 읽기로 넘어간다 */ }
    if (lastDocsCopy && lastDocsCopy.at >= startedAt) return Object.assign({}, lastDocsCopy, { via: 'copy' });
    const pasted = readClipboardViaPaste();
    if (!pasted) return { via: copied ? 'copy-empty' : 'none', imageUrls: [], drawingRenderUrls: [], drawingCommands: null, text: '' };
    return Object.assign({ docId: getDocId(), at: Date.now() }, pasted, { via: copied ? 'copy+paste' : 'paste' });
  }

  function readClipboardViaPaste() {
    const clip = globalThis.ToytypeDrawingClip;
    if (!clip || !shadowRoot) return null;
    // 임시 textarea도 페이지 DOM이 아닌 shadow root 안에만 둔다 (무수정 invariant)
    const ta = document.createElement('textarea');
    ta.style.cssText = 'position:absolute;left:-9999px;opacity:0;';
    shadowRoot.appendChild(ta);
    let data = null;
    const onPaste = ev => {
      ev.preventDefault();
      data = clip.readCopyEventData(ev.clipboardData);
    };
    ta.addEventListener('paste', onPaste);
    ta.focus();
    try {
      document.execCommand('paste');
    } catch (_) { /* 권한이 없으면 data가 null로 남는다 */ }
    ta.removeEventListener('paste', onPaste);
    ta.remove();
    return data && Object.keys(data).length ? clip.summarizeDocsCopy(data) : null;
  }

  // paste로 읽은 클립보드는 예전 내용일 수 있으니 선택한 글과 겹칠 때만 쓴다.
  function capturedMatchesSelection(captured, selectedText) {
    if (!captured) return false;
    if (captured.via === 'copy') return true;
    const norm = s => String(s || '').replace(/[\s\u0000-\u001f￼*]/g, '');
    const a = norm(captured.text);
    const b = norm(selectedText);
    if (!a || !b) return false;
    return a.includes(b.slice(0, 24)) || b.includes(a.slice(0, 24));
  }

  // 본문 그리기의 원본 명령은 그리기 편집 창 페이지 HTML에 들어 있다(같은 출처라 쿠키로 바로 받는다).
  // AI가 그림을 보고 위치를 잡도록 같은 범위의 렌더링 PNG도 받는다.
  async function loadInlineDrawing(renderUrl, docId) {
    const clip = globalThis.ToytypeDrawingClip;
    const fail = (message, detail) => {
      const error = new Error(detail || message);
      error.userMessage = message;
      return error;
    };
    const drawingId = clip.drawingIdFromRenderUrl(renderUrl);
    if (!drawingId) throw fail('선택한 그리기의 ID를 찾지 못했습니다');
    const res = await fetch(clip.drawingEditorUrl(drawingId, docId), { credentials: 'include' });
    if (!res.ok) throw fail('선택한 그리기를 읽지 못했습니다', 'drawing editor page status ' + res.status);
    const html = await res.text();
    const spec = clip.drawingCommandsToSpec(clip.extractEditorCommands(html));
    if (!spec.items.length) throw fail('선택한 그리기에서 도형을 찾지 못했습니다');
    // 그리기 안 스크린샷의 픽셀을 받아 둔다. 붙여넣을 때 이미지 데이터를 직접 넣어야 깨지지 않는다
    const imageUrls = clip.extractEditorImageUrls(html);
    for (const it of spec.items) {
      if (it.type !== 'image' || !imageUrls[it.blob]) continue;
      try {
        const img = await fetch(imageUrls[it.blob], { credentials: 'include' });
        if (!img.ok) continue;
        const dataUrl = await blobToDataUrl(await img.blob());
        const size = await imageSizeFromDataUrl(dataUrl);
        Object.assign(it, { dataUrl, pixelWidth: size.width, pixelHeight: size.height });
      } catch (_) { /* 이 이미지는 blob id 참조로 남는다 */ }
    }
    const { width, height } = spec.bounds;
    if (width > 0 && height > 0) {
      // AI는 긴 변 1568px 또는 약 115만 화소를 넘는 이미지를 줄여서 본다. 줄어들면 AI가 눈으로 잡은 좌표가
      // 그만큼 어긋나므로 처음부터 그 한도 안의 크기로 렌더링한다.
      const pxPerPt = Math.min(2, 1500 / Math.max(width, height), Math.sqrt(1100000 / (width * height)));
      const w = Math.max(1, Math.round(width * pxPerPt));
      const h = Math.max(1, Math.round(height * pxPerPt));
      try {
        const png = await fetch(clip.drawingRenderPngUrl(drawingId, docId, w, h), { credentials: 'include' });
        if (png.ok) spec.reference = { dataUrl: await blobToDataUrl(await png.blob()), width: w, height: h, ptPerPx: width / w };
      } catch (_) { /* 참고 이미지 없이도 도형 정보만으로 고칠 수 있다 */ }
    }
    return spec;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('blob read failed'));
      reader.readAsDataURL(blob);
    });
  }

  // AI 응답에 원래 정보를 id로 다시 붙인다: image는 blob id와 속성, 기존 도형은 rawProps.
  // 모르는 id의 image는 다시 만들 수 없어 버린다.
  // AI 도해 응답을 도해 탭 목록에 넣고 저장한다. 새로고침 뒤 복구한 결과도 이 길로 들어온다.
  async function applyDiagramResult(res, meta) {
    if (diagramResultsDocId !== meta.docId) await loadDiagramResults();
    const drawing = meta.restoreDrawing && Array.isArray(meta.restoreDrawing.items) ? meta.restoreDrawing : null;
    const result = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      createdAt: Date.now(),
      title: res.spec.title,
      kind: meta.kind,
      instruction: meta.instruction || DIAGRAM_KIND_LABEL[meta.kind] || '도해',
      spec: drawing ? restoreDrawingOriginals(res.spec, drawing) : res.spec,
      image: meta.image || null
    };
    diagramResults = [result].concat(diagramResults).slice(0, DIAGRAM_MAX_PER_DOC);
    diagramResultsDocId = meta.docId;
    await saveDiagramResults();
    return result;
  }

  function restoreDrawingOriginals(spec, drawing) {
    const originals = new Map(drawing.items.filter(it => it.id).map(it => [it.id, it]));
    const items = [];
    for (const it of spec.items || []) {
      const orig = it.id ? originals.get(it.id) : null;
      if (it.type === 'image') {
        if (orig && orig.type === 'image') items.push(Object.assign({}, orig, Array.isArray(it.rect) ? { rect: it.rect } : {}));
        continue;
      }
      if (orig && orig.rawProps && it.type === 'node') items.push(Object.assign({}, it, { rawProps: orig.rawProps }));
      else items.push(it);
    }
    return Object.assign({}, spec, { items });
  }

  function fetchImageDataUrl(url) {
    if (/^data:image\//i.test(url)) return Promise.resolve({ ok: true, dataUrl: url });
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: 'typo:fetchImage', url }, res => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: 'extension_message_failed', message: chrome.runtime.lastError.message });
            return;
          }
          resolve(res || { ok: false, error: 'no_response' });
        });
      } catch (e) {
        resolve({ ok: false, error: 'extension_message_failed', message: e && e.message ? e.message : String(e) });
      }
    });
  }

  function imageSizeFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new Error('image decode failed'));
      img.src = dataUrl;
    });
  }

  const DIAGRAM_MODES = ['redraw', 'diagram', 'annotate', 'edit'];
  const DIAGRAM_MAX_REDRAW_IMAGES = 12;

  function diagramError(message, detail) {
    const error = new Error(detail || message);
    error.userMessage = message;
    return error;
  }

  // mode: prompt(프롬프트만으로 도해) | redraw(이미지 → 그리기 도해) | diagram(글 → 도해)
  //       | annotate(스크린샷 강조) | edit(그리기 수정)
  // opts.prompt: 도해 탭 입력 창의 지시. 선택 영역 기반 모드에서는 추가 지시로 함께 보낸다.
  async function handleAiDiagramAddon(mode, opts) {
    const promptOnly = mode === 'prompt';
    const kind = promptOnly ? 'diagram' : DIAGRAM_MODES.includes(mode) ? mode : 'diagram';
    const actionId = 'ai-diagram';
    if (!externalFeaturesEnabled()) {
      showToast('AI 기능이 꺼져 있습니다 · 설정에서 [브릿지 · AI 기능 사용]을 켜세요', { durationMs: 3600 });
      return;
    }
    const typedInstruction = String(opts && opts.prompt || '').trim().slice(0, 2000);
    if (promptOnly && !typedInstruction) {
      showToast('만들 도해를 입력 창에 적어 주세요', { durationMs: 2600 });
      return;
    }
    // 첫 await 전에(클릭의 사용자 활성화가 살아 있을 때) 선택 영역 데이터를 잡는다.
    // 프롬프트만 쓰는 경우는 선택 영역이 필요 없으므로 클립보드를 건드리지 않는다.
    let captured = { via: 'skipped', imageUrls: [], drawingRenderUrls: [], drawingCommands: null, text: '' };
    if (!promptOnly) {
      try {
        captured = captureDocsSelection();
      } catch (error) {
        captured = { via: 'error', imageUrls: [], drawingRenderUrls: [], drawingCommands: null, text: '' };
      }
    }
    setAddonBusy(actionId, true);
    let finalStatus = '';
    let errorToast = '';
    let successToast = '';
    startAiDiagramStatus('선택 영역 읽는 중');
    try {
      const doc = await readCurrentDocumentTextForAddon();
      if (doc.source !== 'model') throw diagramError('문서 선택 영역을 읽지 못했습니다', 'Google Docs model text is required for diagrams');
      let selection = promptOnly ? null : (doc.selection || null);
      if (!selection && !promptOnly) {
        try {
          selection = await fetchDocsSelection();
          updateCursorOffset(selection);
        } catch (_) {
          selection = null;
        }
      }
      const range = selectionRange(selection) || { start: 0, end: 0 };
      const rangeText = range.end > range.start ? doc.text.slice(range.start, range.end) : '';
      // 글 → 도해는 선택한 글이 내용이고 입력 창은 추가 지시. 나머지 모드는 입력 창이 곧 지시
      // (비워 두면 선택한 글, 그것도 없으면 브리지의 모드별 기본 지시).
      const selectedText = promptOnly ? typedInstruction
        : kind === 'diagram' ? (rangeText && typedInstruction ? rangeText + '\n\n[도해 지시] ' + typedInstruction : rangeText || typedInstruction)
          : typedInstruction || rangeText;
      const hasText = !!selectedText.replace(/[\s\u0000-\u001f￼]/g, '');
      if (kind === 'diagram' && !hasText) throw diagramError('도해로 만들 글을 선택하거나 입력 창에 적어 주세요', 'selected text is required');

      const source = capturedMatchesSelection(captured, rangeText) ? captured : null;
      console.info('[Toytype addons] AI diagram selection source', {
        kind,
        via: captured.via,
        used: !!source,
        imageUrls: captured.imageUrls.length,
        drawingCommands: captured.drawingCommands ? captured.drawingCommands.length : 0,
        drawingRenderUrls: captured.drawingRenderUrls ? captured.drawingRenderUrls.length : 0
      });
      const imageUrls = source ? source.imageUrls : [];
      const hasDrawing = !!(source && ((source.drawingCommands && source.drawingCommands.length) || (source.drawingRenderUrls && source.drawingRenderUrls.length)));

      let drawing = null;
      if (kind === 'edit') {
        if (source && source.drawingCommands && globalThis.ToytypeDrawingClip) {
          const spec = globalThis.ToytypeDrawingClip.drawingCommandsToSpec(source.drawingCommands);
          if (spec.items.some(it => it.type === 'node')) drawing = spec;
        }
        if (!drawing && source && source.drawingRenderUrls && source.drawingRenderUrls.length) {
          updateAiDiagramStatus('선택한 그리기 읽는 중');
          drawing = await loadInlineDrawing(source.drawingRenderUrls[0], doc.docId);
        }
        if (!drawing) throw diagramError('고칠 구글 그리기를 선택하세요', 'no drawing in selection');
      }
      if ((kind === 'redraw' || kind === 'annotate') && !imageUrls.length) {
        throw diagramError(kind === 'redraw' && hasDrawing
          ? '이미 구글 그리기입니다 · [그리기 수정]을 쓰세요'
          : '이미지를 선택하세요', 'no image in selection');
      }

      // 이미지 → 그리기 도해는 선택 범위의 이미지를 모두 차례로 바꾼다. 나머지는 첫 번째 대상 하나만.
      const targets = kind === 'redraw' ? imageUrls.slice(0, DIAGRAM_MAX_REDRAW_IMAGES)
        : kind === 'annotate' ? imageUrls.slice(0, 1)
          : [null];
      const phase = { edit: 'AI 그리기 수정 중', redraw: 'AI 도해 다시 그리는 중', annotate: 'AI 스크린샷 강조 생성 중', diagram: 'AI 도해 생성 중' }[kind];
      if (diagramResultsDocId !== doc.docId) await loadDiagramResults();
      const instruction = (typedInstruction || (hasText ? selectedText : '')).replace(/\s+/g, ' ').trim().slice(0, 200);
      let done = 0;
      const failures = [];
      for (let i = 0; i < targets.length; i++) {
        const label = targets.length > 1 ? ' (' + (i + 1) + '/' + targets.length + ')' : '';
        try {
          let image = null;
          if (targets[i]) {
            updateAiDiagramStatus('선택한 이미지 받는 중' + label);
            const res = await fetchImageDataUrl(targets[i]);
            if (!res || !res.ok || !res.dataUrl) throw diagramError('선택한 이미지를 받지 못했습니다', 'image fetch failed: ' + (res && (res.error || res.status)));
            const size = await imageSizeFromDataUrl(res.dataUrl);
            image = { dataUrl: res.dataUrl, width: size.width, height: size.height };
          }
          updateAiDiagramStatus(phase + label);
          const res = await sendAiBridge('diagram', {
            timeoutMs: AI_DIAGRAM_TIMEOUT,
            mode: kind,
            image,
            // 이미지 blob id와 도형의 원래 속성(rawProps)은 AI에 보내지 않고, 응답을 받은 뒤 id로 다시 붙인다
            drawing: drawing ? {
              items: drawing.items.map(it => {
                if (it.type === 'image') return { id: it.id, type: 'image', rect: it.rect };
                const { rawProps, ...rest } = it;
                return rest;
              }),
              bounds: drawing.bounds,
              reference: drawing.reference || null
            } : null,
            document: {
              id: doc.docId,
              title: doc.title,
              url: location.href,
              textSource: doc.source,
              selectionStart: range.start,
              selectionEnd: range.end,
              selectedText: hasText ? selectedText : '',
              // 프롬프트만으로 만들 때는 문서 내용을 맥락으로 보내지 않는다
              contextBefore: promptOnly ? '' : doc.text.slice(Math.max(0, range.start - AI_DIAGRAM_CONTEXT), range.start),
              contextAfter: promptOnly ? '' : doc.text.slice(range.end, range.end + AI_DIAGRAM_CONTEXT)
            }
          }, {
            kind,
            instruction: instruction || (DIAGRAM_KIND_LABEL[kind] + label),
            restoreDrawing: drawing || null
          });
          if (!res || !res.ok || !res.spec) throw aiBridgeError(res, 'AI 도해 생성 실패');
          await applyDiagramResult(res, {
            docId: doc.docId,
            kind,
            instruction: instruction || (DIAGRAM_KIND_LABEL[kind] + label),
            restoreDrawing: drawing,
            // 다시 그린 도해에는 원래 이미지가 들어가지 않으므로 저장하지 않는다
            image: kind === 'annotate' ? image : null
          });
          done++;
        } catch (error) {
          if (targets.length === 1) throw error;
          const summary = summarizeErrorForConsole(error);
          if (error && error.response !== undefined) summary.response = summarizeAiBridgeResponse(error.response);
          console.error('[Toytype addons] AI diagram failed for image ' + (i + 1), summary);
          failures.push(i + 1);
        }
      }
      if (!done) throw diagramError('AI 도해 생성 실패', 'every image failed');
      // 다른 탭(사실 검증·용어 표 등)을 읽고 있으면 강제로 넘기지 않는다. 상태 표시줄 안내로 알린다.
      if (!suggestionsViewOpen && !termsViewOpen && !factsViewOpen) diagramsViewOpen = true;
      finalStatus = (promptOnly ? '프롬프트 도해' : DIAGRAM_KIND_LABEL[kind]) + ' 완료' + (targets.length > 1 ? ' ' + done + '/' + targets.length + '개' : '') + ' · 도해 탭에서 복사';
      if (failures.length) finalStatus += ' · 실패: ' + failures.join(', ') + '번째 이미지';
      if (kind === 'redraw' && imageUrls.length > DIAGRAM_MAX_REDRAW_IMAGES) finalStatus += ' · 앞 ' + DIAGRAM_MAX_REDRAW_IMAGES + '개만 처리';
      successToast = 'AI 도해 생성 완료 · 도해 탭에서 눌러 복사';
      if (promptOnly) diagramPromptDraft = '';
    } catch (error) {
      const summary = summarizeErrorForConsole(error);
      if (error && error.userMessage) summary.userMessage = error.userMessage;
      if (error && error.response !== undefined) summary.response = summarizeAiBridgeResponse(error.response);
      console.error('[Toytype addons] AI diagram failed', summary);
      finalStatus = error && error.userMessage ? error.userMessage : 'AI 도해 생성 실패';
      errorToast = finalStatus;
    } finally {
      setAddonBusy(actionId, false);
      finishAiDiagramStatus(errorToast ? 'error' : 'success', finalStatus);
      if (errorToast) showToast(errorToast, { durationMs: 4200 });
      else if (successToast) showToast(successToast, { durationMs: 3200 });
    }
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

  // 커서만 움직였을 때 패널 전체를 다시 그리지 않고 표시선만 옮긴다(긴 문서에서 타이핑할 때 느려지던 원인).
  // 문서 순서 목록이 아닌 화면이면 할 일이 없다. 제자리로 못 옮기면 false를 돌려 전체 렌더에 맡긴다.
  function moveCursorMarkerInPlace() {
    if (!shadowView || listMode !== 'order') return true;
    const body = shadowView.querySelector('.trd-body');
    if (!body) return true;
    const items = Array.from(body.children).filter(node => node.classList.contains('trd-item') && node.dataset.start !== undefined);
    const old = Array.from(body.children).find(node => node.classList.contains('trd-cursor-marker'));
    if (!items.length && !old) return true;
    if (old) old.remove();
    if (!shouldShowCursorMarker()) return true;
    const marker = buildCursorMarker();
    const next = items.find(node => currentCursorOffset <= Number(node.dataset.start));
    if (next) body.insertBefore(marker, next);
    else if (items.length) items[items.length - 1].after(marker);
    else return false;
    if (shouldFollowCursorInOrderList()) scheduleCursorListFollow();
    return true;
  }

  function refreshCursorViews(cursorChanged, countChanged) {
    if (!expanded) return;
    if (cursorChanged && !moveCursorMarkerInPlace()) {
      render();
      return;
    }
    if (countChanged) refreshStatusBar();
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
      diagramsViewOpen = false;
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
    builtinOption.textContent = '기본 규칙';
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
      uploadedOption.textContent = uploadedRulesLabel || '업로드한 JSON';
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
    diagramsViewOpen = false;
    termsViewOpen = false;
    factsViewOpen = false;
    showToast(activeRulesSource === 'builtin' ? 'rules.json 기준으로 검사' : 'JSON 기준으로 검사');
    enqueueScan(cachedText === null);
  }

  function syncCursorWatcher() {
    // 커서 마커는 order 모드에서만 쓰지만, 선택 글자수는 어느 화면에서나 보여준다.
    const shouldPoll = expanded && status === 'ready' && lastReport &&
      lastReport.textSource === 'model';
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
    lastSelectionSpanKey = '';
    if (selectionCount !== null) {
      selectionCount = null;
      if (expanded) render();
    }
  }

  function pollCursorSelection() {
    // 적용 진행 중에는 모델 호출 경합을 피하려고 커서 폴링을 쉰다.
    if (cursorPollBusy || applyingFindingKey !== null || addonBusyActions.size > 0 || isNativeControlInteractionActive()) return;
    cursorPollBusy = true;
    // 가벼운 getSelection으로 먼저 범위를 보고, 범위가 실제로 바뀌었을 때만
    // 본문까지 가져오는 getSelectionText를 부른다(매 틱 전체 본문 조회 방지).
    fetchDocsSelection().then(selection => {
      const cursorChanged = updateCursorOffset(selection) && listMode === 'order';
      const range = selectionRange(selection);
      const spanKey = range && range.end > range.start ? range.start + ':' + range.end : '';
      if (spanKey === lastSelectionSpanKey) {
        refreshCursorViews(cursorChanged, false);
        return null;
      }
      lastSelectionSpanKey = spanKey;
      if (!spanKey) {
        const cleared = updateSelectionCount('');
        refreshCursorViews(cursorChanged, cleared);
        return null;
      }
      return fetchDocsSelectionText().then(res => {
        const countChanged = updateSelectionCount(res.selectedText);
        refreshCursorViews(cursorChanged, countChanged);
      });
    }).catch(() => {
      const cursorChanged = currentCursorOffset !== null && listMode === 'order';
      const countChanged = selectionCount !== null;
      currentCursorOffset = null;
      selectionCount = null;
      lastSelectionSpanKey = '';
      refreshCursorViews(cursorChanged, countChanged);
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

  // 서로게이트 쌍(이모지 등)을 한 글자로 세려고 Array.from을 쓴다.
  function countTextStats(text) {
    const chars = Array.from(text);
    let charsNoSpace = 0;
    for (const ch of chars) {
      if (!/\s/.test(ch)) charsNoSpace++;
    }
    const words = text.split(/\s+/).filter(Boolean).length;
    return { chars: chars.length, charsNoSpace, words };
  }

  // getText 응답(본문+오프셋)으로 글자수와 범위 키를 함께 갱신한다.
  // 폴러가 이 결과를 중복 조회하지 않도록 키까지 맞춰 둔다.
  function syncSelectionCountFromModel(text, selection) {
    const range = selectionRange(selection);
    lastSelectionSpanKey = range && range.end > range.start ? range.start + ':' + range.end : '';
    return updateSelectionCount(sliceSelectedText(text, selection));
  }

  // 같은 응답에서 온 본문·오프셋 쌍을 잘라낸다. 짝이 안 맞으면 세지 않는다.
  function sliceSelectedText(text, selection) {
    if (typeof text !== 'string') return '';
    const range = selectionRange(selection);
    if (!range || range.end <= range.start || range.end > text.length) return '';
    return text.slice(range.start, range.end);
  }

  function updateSelectionCount(selectedText) {
    const next = selectedText ? countTextStats(selectedText) : null;
    if (selectionCountsEqual(next, selectionCount)) return false;
    selectionCount = next;
    return true;
  }

  function selectionCountsEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.chars === b.chars && a.charsNoSpace === b.charsNoSpace && a.words === b.words;
  }

  function selectionCountText() {
    if (!selectionCount) return '';
    return '선택 ' + selectionCount.chars.toLocaleString() + '자' +
      ' (공백 제외 ' + selectionCount.charsNoSpace.toLocaleString() + ')' +
      ' · ' + selectionCount.words.toLocaleString() + '단어';
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

  function closeFindingContextMenu() {
    if (!findingContextMenu) return;
    if (findingContextMenu.node) findingContextMenu.node.remove();
    if (findingContextMenu.closeEvents) {
      for (const item of findingContextMenu.closeEvents) {
        item.target.removeEventListener(item.type, item.handler, item.options);
      }
    }
    findingContextMenu = null;
  }

  function findingIssuePayload(f) {
    const report = lastReport && typeof lastReport === 'object' ? lastReport : {};
    return {
      context: 'docs',
      src: f && f.src,
      dst: f && f.dst,
      cat: f && f.cat,
      catLabel: f && (f.catLabel || labelOf(f.cat)),
      before: f && f.before,
      after: f && f.after,
      line: f && f.line,
      rulesVersion: report.rulesVersion || (rulesJson && rulesJson.version),
      rulesSource: activeRulesSource === 'builtin' ? 'rules.json' : (rulesSourceLabel || 'uploaded.json'),
      scannedAt: report.scannedAt,
      textSource: report.textSource,
      pageTitle: documentTitleForAddon(),
      pageUrl: location.href,
      docId: getDocId()
    };
  }

  function handleReportFindingIssueClick(f) {
    try {
      chrome.runtime.sendMessage({ type: 'typo:reportFindingIssue', finding: findingIssuePayload(f) }, res => {
        if (chrome.runtime.lastError || !res || res.ok !== true) {
          showToast('이슈 열기 실패', { durationMs: 2400 });
          return;
        }
        showToast('오류 제보 이슈 작성 화면 열림');
      });
    } catch (error) {
      showToast('이슈 열기 실패', { durationMs: 2400 });
    }
  }

  function showFindingContextMenu(f, ev) {
    ev.preventDefault();
    ev.stopPropagation();
    closeFindingContextMenu();

    const panel = shadowView && shadowView.querySelector('.trd-panel');
    if (!panel) return;
    const menu = el('div', 'trd-context-menu');
    menu.setAttribute('role', 'menu');
    const reportBtn = el('button', 'trd-context-item');
    reportBtn.type = 'button';
    reportBtn.setAttribute('role', 'menuitem');
    reportBtn.textContent = '오류 제보';
    reportBtn.addEventListener('click', clickEv => {
      clickEv.preventDefault();
      clickEv.stopPropagation();
      closeFindingContextMenu();
      handleReportFindingIssueClick(f);
    });
    menu.appendChild(reportBtn);
    panel.appendChild(menu);

    const margin = 6;
    const panelRect = panel.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const x = Math.min(
      Math.max(margin, ev.clientX - panelRect.left),
      Math.max(margin, panel.clientWidth - menuRect.width - margin)
    );
    const y = Math.min(
      Math.max(margin, ev.clientY - panelRect.top),
      Math.max(margin, panel.clientHeight - menuRect.height - margin)
    );
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    const closeOnClick = clickEv => {
      if (!menu.contains(clickEv.target)) closeFindingContextMenu();
    };
    const closeOnScroll = () => closeFindingContextMenu();
    const closeOnEscape = keyEv => {
      if (keyEv.key === 'Escape') closeFindingContextMenu();
    };
    findingContextMenu = {
      node: menu,
      closeEvents: [
        { target: shadowRoot, type: 'click', handler: closeOnClick, options: false },
        { target: document, type: 'click', handler: closeOnClick, options: false },
        { target: document, type: 'scroll', handler: closeOnScroll, options: true },
        { target: document, type: 'keydown', handler: closeOnEscape, options: true }
      ]
    };
    for (const item of findingContextMenu.closeEvents) {
      item.target.addEventListener(item.type, item.handler, item.options);
    }
  }

  function buildItem(f) {
    const isSuggestion = isSentenceSuggestionFinding(f);
    const item = el('div', 'trd-item' + (isSuggestion ? ' trd-suggestion-item trd-copy-only' : ''));
    item.dataset.start = String(f.start);
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
    item.addEventListener('contextmenu', ev => {
      showFindingContextMenu(f, ev);
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
      finalStatus = applyProofreadResult(res);
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

  // AI 교정 응답을 규칙 소스로 올리고 다시 검사한다. 새로고침 뒤 복구한 결과도 이 길로 들어온다.
  function applyProofreadResult(res) {
    let finalStatus = '';
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
    if (res.factCheck && res.factCheck.model) {
      finalStatus += ' · 사실확인 완료';
    }
    return finalStatus;
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
        diagramsViewOpen = false;
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
      diagramsViewOpen = false;
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
      updateAiTermsStatus('용어 분석 중');
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
        throw aiBridgeError(res, '용어 분석 실패');
      }
      termReport = normalizeTermReportForView(res.report, res);
      termReportDocId = doc.docId;
      const n = Array.isArray(termReport.terms) ? termReport.terms.length : 0;
      const doneLabel = res.fromCache ? '저장된 용어 표 불러옴' : '용어 분석 완료';
      finalStatus = n ? doneLabel + ' · ' + n + '건' : doneLabel + ' · 혼용 없음';
      successToast = finalStatus;
    } catch (error) {
      const summary = summarizeErrorForConsole(error);
      if (error && error.userMessage) summary.userMessage = error.userMessage;
      if (error && error.response !== undefined) summary.response = summarizeAiBridgeResponse(error.response);
      console.error('[Toytype addons] local terms failed', summary);
      debugLog('[Toytype addons] local terms failed detail', {
        response: error && error.response !== undefined ? error.response : null,
        stack: error && error.stack ? error.stack : ''
      });
      finalStatus = error && error.userMessage ? error.userMessage : '용어 분석 실패';
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

  const TERM_KIND_LABEL = {
    dictionary: '사전',
    spelling: '철자',
    case: '대소문자',
    spacing: '띄어쓰기',
    script: '한·영',
    synonym: '약어·번역어',
    particle: '조사'
  };

  function normalizeTermItemForView(item) {
    if (!item || typeof item !== 'object') return null;
    const variants = Array.isArray(item.variants)
      ? item.variants.map(variant => ({
          text: String(variant && variant.text || '').trim(),
          count: Math.max(0, Math.round(Number(variant && variant.count) || 0))
        })).filter(variant => variant.text)
      : [];
    // 조사 오류 행(kind: particle)은 표기가 하나뿐이어도 보여 준다
    const kind = TERM_KIND_LABEL[item.kind] ? item.kind : 'dictionary';
    if (variants.length < 2 && kind !== 'particle') return null;
    if (variants.length === 0) return null;
    return {
      kind,
      concept: String(item.concept || '').trim(),
      recommended: String(item.recommended || '').trim(),
      variants,
      severity: item.severity === 'major' ? 'major' : 'minor',
      evidence: Array.isArray(item.evidence) ? item.evidence.filter(text => typeof text === 'string' && text.trim()).slice(0, 4) : [],
      reason: String(item.reason || '').trim()
    };
  }

  // 드래그한 문장만 사실 검증한다. 문서는 건드리지 않고 결과를 패널 표로만 보여준다.
  async function handleAiVerifyAddon() {
    const actionId = 'ai-verify';
    setAddonBusy(actionId, true);
    let finalStatus = '';
    let errorToast = '';
    let successToast = '';
    startAiVerifyStatus('선택 영역 읽는 중');
    try {
      const doc = await readCurrentDocumentTextForAddon();
      if (doc.source !== 'model') {
        const error = new Error('Google Docs model text is required for fact verification');
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
        error.userMessage = '검증할 문장을 드래그해 선택하세요';
        throw error;
      }
      const selectedText = doc.text.slice(range.start, range.end);
      if (!selectedText.trim()) {
        const error = new Error('selected text is blank');
        error.userMessage = '공백이 아닌 문장을 선택하세요';
        throw error;
      }

      updateAiVerifyStatus('AI 사실 검증 중');
      const res = await sendAiBridge('verifyFacts', {
        timeoutMs: AI_VERIFY_TIMEOUT,
        document: {
          id: doc.docId,
          title: doc.title,
          url: location.href,
          textSource: doc.source,
          selectedText,
          contextBefore: doc.text.slice(Math.max(0, range.start - AI_VERIFY_CONTEXT), range.start),
          contextAfter: doc.text.slice(range.end, range.end + AI_VERIFY_CONTEXT)
        }
      }, { selectedText });
      if (!res || !res.ok) {
        throw aiBridgeError(res, 'AI 사실 검증 실패');
      }

      const applied = applyFactsResult(res, selectedText, getDocId(), true);
      finalStatus = applied.status;
      successToast = applied.toast;
    } catch (error) {
      const summary = summarizeErrorForConsole(error);
      if (error && error.userMessage) summary.userMessage = error.userMessage;
      if (error && error.response !== undefined) summary.response = summarizeAiBridgeResponse(error.response);
      console.error('[Toytype addons] AI fact verification failed', summary);
      debugLog('[Toytype addons] AI fact verification failed detail', {
        response: error && error.response !== undefined ? error.response : null,
        stack: error && error.stack ? error.stack : ''
      });
      finalStatus = error && error.userMessage ? error.userMessage : 'AI 사실 검증 실패';
      errorToast = finalStatus;
    } finally {
      setAddonBusy(actionId, false);
      finishAiVerifyStatus(errorToast ? 'error' : 'success', finalStatus);
      if (errorToast) showToast(errorToast, { durationMs: 4200 });
      else if (successToast) showToast(successToast);
      render();
    }
  }

  // 사실 검증 결과를 표로 연다. force가 아니면(복구한 결과) 다른 탭을 읽는 중일 때 탭을 넘기지 않는다.
  function applyFactsResult(res, selectedText, docId, force) {
    factReport = normalizeFactReportForView(res, selectedText);
    factReportDocId = docId;
    if (force || !anyAddonViewOpen()) {
      factsViewOpen = true;
      termsViewOpen = false;
      suggestionsViewOpen = false;
      diagramsViewOpen = false;
      addonsMenuOpen = false;
    }
    const flagged = factReport.claims.filter(c => c.status === 'contradicted').length;
    let status = 'AI 사실 검증 완료 · 주장 ' + factReport.claims.length + '건';
    if (flagged) status += ' · 모순 ' + flagged + '건';
    return {
      status,
      toast: flagged ? '사실과 다른 내용 ' + flagged + '건을 찾았습니다' : '검증을 마쳤습니다'
    };
  }

  function anyAddonViewOpen() {
    return !!(suggestionsViewOpen || termsViewOpen || factsViewOpen || diagramsViewOpen);
  }

  // 브리지 응답을 표에 그리기 좋은 형태로 좁힌다.
  function normalizeFactReportForView(res, selectedText) {
    const raw = Array.isArray(res && res.claims) ? res.claims : [];
    const claims = raw.map(item => ({
      sourceText: String(item && item.sourceText || ''),
      status: String(item && item.status || 'unverifiable'),
      confidence: String(item && item.confidence || ''),
      finding: String(item && item.finding || ''),
      suggestedReplacement: String(item && item.suggestedReplacement || ''),
      sources: Array.isArray(item && item.sources) ? item.sources.filter(Boolean).slice(0, 4) : []
    })).filter(c => c.sourceText || c.finding);
    return {
      claims,
      selectedText: String(selectedText || ''),
      provider: String(res && res.provider || ''),
      model: String(res && res.model || ''),
      webAccess: String(res && res.webAccess || ''),
      checkedAt: Date.now()
    };
  }

  async function handleAiLengthAddon() {
    const actionId = 'ai-length';
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
      }, { targetChars });
      if (!res || !res.ok || !res.json) {
        throw aiBridgeError(res, 'AI 문장 길이 조절 실패');
      }
      updateAiLengthStatus('문장 제안 JSON 저장 중');
      finalStatus = applyLengthResult(res, targetChars);
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

  function applyLengthResult(res, targetChars) {
    const n = activateGeneratedRulesResponse(res, '문장제안.json');
    let status = 'AI 문장 제안 저장 완료' + (targetChars ? ' · 목표 ' + targetChars + '자' : '');
    if (n) status += ' · 누적 ' + n + '건';
    return status;
  }

  // 그리기 수정 지시 입력. 취소면 null, 빈 입력이면 ''(정렬·간격만 다듬기).
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
    if (!globalThis.ToytypeHwpxExport || typeof globalThis.ToytypeHwpxExport.extractGoogleDocImages !== 'function') {
      showToast('이미지 추출 모듈을 찾지 못했습니다', { durationMs: 4200 });
      return;
    }
    setAddonBusy(actionId, true);
    let finalStatus = '';
    let errorToast = '';
    let successToast = '';
    startImageExtractStatus('DOCX 다운로드 중');
    try {
      const result = await globalThis.ToytypeHwpxExport.extractGoogleDocImages({
        docId,
        title: documentTitleForAddon(),
        onProgress: phase => updateImageExtractStatus(imageExtractPhaseLabel(phase))
      });
      if (!result || !result.imageCount) {
        finalStatus = '이미지 없음';
        successToast = '문서에 추출할 이미지가 없습니다';
      } else {
        updateImageExtractStatus('다운로드 시작 중');
        globalThis.ToytypeHwpxExport.downloadBytes(result.fileName, result.bytes, 'application/zip');
        finalStatus = '이미지 추출 완료 · ' + result.imageCount + '개';
        if (result.skippedImageCount > 0) finalStatus += ' · 빈 이미지 제외 ' + result.skippedImageCount + '개';
        if (result.fileName) finalStatus += ' · ' + result.fileName;
        successToast = '이미지 ZIP 다운로드 시작: ' + (result.fileName || result.imageCount + '개');
      }
    } catch (error) {
      const summary = summarizeErrorForConsole(error);
      console.error('[Toytype addons] image extract failed', summary);
      finalStatus = '이미지 추출 실패';
      if (error && error.message) finalStatus += ' · ' + error.message;
      errorToast = finalStatus;
    } finally {
      setAddonBusy(actionId, false);
      finishImageExtractStatus(errorToast ? 'error' : 'success', finalStatus);
      if (errorToast) showToast(errorToast, { durationMs: 4200 });
      else if (successToast) showToast(successToast, { durationMs: 2800 });
    }
  }

  function imageExtractPhaseLabel(phase) {
    const key = String(phase || '');
    if (key === 'DOCX export downloading') return 'DOCX 다운로드 중';
    if (key === 'DOCX reading') return 'DOCX 분석 중';
    if (key === 'ZIP packaging') return 'ZIP 생성 중';
    return key || '진행 중';
  }

  async function handleExportHwpxAddon() {
    const actionId = 'export-hwpx';
    if (isAddonBusy(actionId)) return;
    const docId = getDocId();
    if (!docId) {
      showToast('문서 ID를 찾지 못했습니다', { durationMs: 3200 });
      return;
    }
    if (!globalThis.ToytypeHwpxExport || typeof globalThis.ToytypeHwpxExport.exportGoogleDoc !== 'function') {
      showToast('HWPX 내보내기 모듈을 찾지 못했습니다', { durationMs: 4200 });
      return;
    }
    setAddonBusy(actionId, true);
    let finalStatus = '';
    let errorToast = '';
    let successToast = '';
    startHwpxExportStatus('HTML 다운로드 중');
    try {
      const result = await globalThis.ToytypeHwpxExport.exportGoogleDoc({
        docId,
        title: documentTitleForAddon(),
        url: location.href,
        onProgress: phase => updateHwpxExportStatus(hwpxPhaseLabel(phase))
      });
      updateHwpxExportStatus('다운로드 시작 중');
      globalThis.ToytypeHwpxExport.downloadBytes(result.fileName, result.bytes, 'application/hwp+zip');
      const stats = result.stats || {};
      finalStatus = 'HWPX 내보내기 완료';
      if (stats.blockCount) finalStatus += ' · 블록 ' + stats.blockCount + '개';
      if (stats.equationCount) finalStatus += ' · 수식 ' + stats.equationCount + '개';
      if (stats.imageCount) finalStatus += ' · 이미지 ' + stats.imageCount + '개';
      if (stats.skippedImageCount) finalStatus += ' · 이미지 제외 ' + stats.skippedImageCount + '개';
      if (result.fileName) finalStatus += ' · ' + result.fileName;
      successToast = 'HWPX 다운로드 시작: ' + (result.fileName || 'document.hwpx');
    } catch (error) {
      const summary = summarizeErrorForConsole(error);
      console.error('[Toytype addons] HWPX export failed', summary);
      finalStatus = 'HWPX 내보내기 실패';
      if (error && error.message) finalStatus += ' · ' + error.message;
      errorToast = finalStatus;
    } finally {
      setAddonBusy(actionId, false);
      finishHwpxExportStatus(errorToast ? 'error' : 'success', finalStatus);
      if (errorToast) showToast(errorToast, { durationMs: 5200 });
      else if (successToast) showToast(successToast, { durationMs: 2800 });
    }
  }

  function hwpxPhaseLabel(phase) {
    const key = String(phase || '');
    if (key === 'HTML export downloading') return 'HTML 다운로드 중';
    if (key === 'HTML parsing') return 'HTML 분석 중';
    if (key === 'equations scanning') return '수식 스캔 중';
    if (key === 'images loading') return '이미지 수집 중';
    if (key === 'HWPX structure building') return 'HWPX 생성 중';
    return key || '진행 중';
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

  // ---------------- 단락 스타일 셋팅 (골든래빗 프리셋, 로컬 브리지 불필요) ----------------
  // 문서 끝 임시 문단에 목표 서식을 만든 뒤 각 단락 스타일 정의를 Docs의 '스타일 업데이트'
  // 메뉴로 반영한다. 서체는 집필 가이드 기준인 Arimo, 줄간격은 1.5로 맞춘다.
  // 메뉴·툴바·키 입력 자동화는 페이지 브리지의 stylePresetOp이 페이지 월드에서 실행한다 —
  // 콘텐트 스크립트에서 만든 KeyboardEvent는 keyCode 재정의가 페이지에 보이지 않는다.

  const STYLE_PRESET_TEMP_TEXT = 'toytype-style-preset-temp';
  const STYLE_PRESET_CLEANUP_ATTEMPTS = 8;   // 선택+Backspace 재시도 횟수
  const STYLE_PRESET_UNDO_ATTEMPTS = 12;     // 실행취소 최후 수단 상한
  const STYLE_PRESET_FONT = 'Arimo';         // 집필 가이드 기준 서체
  const STYLE_PRESET_LINE_SPACING = '1.5';   // 줄간격 메뉴의 배수 항목 캡션
  const STYLE_PRESET_DEFS = [
    { key: 'normal', label: '일반 텍스트', sizePt: 10, bold: false, underline: false, colorRgb: 'rgb(0, 0, 0)' },
    { key: 'h1', label: '제목 1', sizePt: 25, bold: true, underline: false, colorRgb: 'rgb(0, 0, 0)' },
    { key: 'h2', label: '제목 2', sizePt: 16, bold: true, underline: false, colorRgb: 'rgb(0, 0, 0)' },
    { key: 'h3', label: '제목 3', sizePt: 14, bold: true, underline: false, colorRgb: 'rgb(74, 134, 232)' },
    { key: 'h4', label: '제목 4', sizePt: 12, bold: true, underline: true, colorRgb: 'rgb(17, 85, 204)' },
    { key: 'h5', label: '제목 5', sizePt: 10, bold: true, underline: false, colorRgb: 'rgb(0, 0, 0)' }
  ];

  function styleDelay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // 실패 원인을 토스트에 담을 수 있게 짧은 한국어 문구로 줄인다.
  // 페이지 브리지가 던지는 메시지는 이미 한국어이므로 그대로 쓰고, 길면 자른다.
  function styleShortErrorText(error) {
    const raw = error && error.message ? String(error.message) : '';
    if (!raw) return '알 수 없는 오류 · 콘솔 확인';
    const cleaned = raw.replace(/^stylePresetOp \w+ failed:?\s*/, '').trim();
    if (!cleaned) return '알 수 없는 오류 · 콘솔 확인';
    return cleaned.length > 70 ? cleaned.slice(0, 70) + '…' : cleaned;
  }

  // 페이지 브리지의 stylePresetOp으로 DOM 자동화 한 단계를 실행한다.
  function styleBridgeOp(op, payload) {
    return requestDocsModel('stylePresetOp', Object.assign({
      op,
      docId: getDocId(),
      timeoutMs: 15000
    }, payload || {})).then(res => {
      if (!res || !res.ok) throw docsModelError('stylePresetOp ' + op + ' failed', res);
      return res.result;
    });
  }

  function styleGetModelText() {
    return requestDocsModel('getText', { docId: getDocId() }).then(res => {
      if (!res || !res.ok || typeof res.text !== 'string') throw docsModelError('getText failed', res);
      return res.text;
    });
  }

  // 문서 끝(마지막 문단 뒤)에 임시 문단을 만든다: 커서 이동 → Enter → 임시 텍스트 타이핑.
  async function styleInsertTempParagraph() {
    let before = await styleGetModelText();
    // 이전 실행이 남긴 잔여물은 기능을 잠그지 않고 먼저 정리한다.
    if (before.lastIndexOf(STYLE_PRESET_TEMP_TEXT) !== -1) {
      const cleaned = await styleRemoveTempParagraph({ enterCreated: true });
      if (!cleaned) {
        throw new Error('이전 임시 문단을 정리하지 못했습니다 — 문서 끝의 ' + STYLE_PRESET_TEMP_TEXT + ' 줄을 직접 지워주세요');
      }
      before = await styleGetModelText();
    }
    const cursor = Math.max(0, before.length - 1);
    await selectDocsModelRange(cursor, cursor);
    await styleDelay(200);
    const inserted = await styleBridgeOp('insertTemp', { text: STYLE_PRESET_TEMP_TEXT });
    let idx = -1;
    for (let i = 0; i < 20 && idx === -1; i++) {
      await styleDelay(150);
      const text = await styleGetModelText();
      idx = text.lastIndexOf(STYLE_PRESET_TEMP_TEXT);
    }
    if (idx === -1) throw new Error('임시 문단 삽입을 확인하지 못했습니다');
    return {
      range: { start: idx, end: idx + STYLE_PRESET_TEMP_TEXT.length },
      enterCreated: !!(inserted && inserted.enterCreated)
    };
  }

  // 임시 문단 삭제 — 앞 개행까지 선택해 Backspace로 지우면 앞 문단이 자기 스타일을 유지한 채 합쳐진다.
  // 선택+Backspace를 우선 시도하고, 그래도 남으면 실행취소로 확실히 되돌린다.
  // 실제 Docs 호출은 주입받아 제어 흐름만 테스트할 수 있게 한다.
  async function removeStylePresetTempText(tempInfo, deps) {
    const getText = deps.getText;
    const tempGone = async () => (await getText()).lastIndexOf(STYLE_PRESET_TEMP_TEXT) === -1;
    for (let attempt = 0; attempt < STYLE_PRESET_CLEANUP_ATTEMPTS; attempt++) {
      const text = await getText();
      const idx = text.lastIndexOf(STYLE_PRESET_TEMP_TEXT);
      if (idx === -1) return true;
      const includeNewline = tempInfo && tempInfo.enterCreated && idx > 0 && text[idx - 1] === '\n';
      const start = includeNewline ? idx - 1 : idx;
      await deps.selectRange(start, idx + STYLE_PRESET_TEMP_TEXT.length);
      await deps.delay(250);
      await deps.backspace();
    }
    if (await tempGone()) return true;
    // 최후 수단: 실행취소를 한 번씩 보내며 매회 잔존을 확인한다.
    // 사라지는 즉시 멈추므로 사용자의 이전 편집까지 되돌리지 않는다.
    for (let attempt = 0; attempt < STYLE_PRESET_UNDO_ATTEMPTS; attempt++) {
      await deps.undo();
      await deps.delay(250);
      if (await tempGone()) return true;
    }
    return false;
  }

  function styleRemoveTempParagraph(tempInfo) {
    return removeStylePresetTempText(tempInfo, {
      getText: styleGetModelText,
      selectRange: selectDocsModelRange,
      backspace: () => styleBridgeOp('backspace'),
      undo: () => styleBridgeOp('undo'),
      delay: styleDelay
    });
  }

  async function styleApplyPresetDef(def, range) {
    // 문서가 도중에 바뀌었을 수 있으니 임시 텍스트 위치를 재확인한다.
    const text = await styleGetModelText();
    if (text.slice(range.start, range.end) !== STYLE_PRESET_TEMP_TEXT) {
      const idx = text.lastIndexOf(STYLE_PRESET_TEMP_TEXT);
      if (idx === -1) throw new Error('임시 문단을 찾지 못했습니다');
      range.start = idx;
      range.end = idx + STYLE_PRESET_TEMP_TEXT.length;
    }
    await selectDocsModelRange(range.start, range.end);
    await styleDelay(250);
    await styleBridgeOp('menu', { label: def.label, update: false });
    // 스타일 적용·메뉴 닫기 후 선택이 유지된다는 보장이 없어 단계마다 재선택한다.
    await selectDocsModelRange(range.start, range.end);
    await styleDelay(200);
    await styleBridgeOp('toggle', { buttonId: 'boldButton', want: def.bold });
    await styleBridgeOp('toggle', { buttonId: 'italicButton', want: false });
    await styleBridgeOp('toggle', { buttonId: 'underlineButton', want: def.underline });
    await styleBridgeOp('fontSize', { sizePt: def.sizePt });
    await selectDocsModelRange(range.start, range.end);
    await styleDelay(200);
    await styleBridgeOp('fontFamily', { fontName: STYLE_PRESET_FONT });
    await selectDocsModelRange(range.start, range.end);
    await styleDelay(200);
    await styleBridgeOp('lineSpacing', { spacing: STYLE_PRESET_LINE_SPACING });
    await selectDocsModelRange(range.start, range.end);
    await styleDelay(200);
    await styleBridgeOp('color', { colorRgb: def.colorRgb });
    await selectDocsModelRange(range.start, range.end);
    await styleDelay(200);
    await styleBridgeOp('menu', { label: def.label, update: true });
  }

  function handleStylePresetAddon(styleKeys) {
    const actionId = 'style-preset';
    if (isAddonBusy(actionId)) return;
    const defs = STYLE_PRESET_DEFS.filter(def => styleKeys.includes(def.key));
    if (!defs.length) return;
    setAddonBusy(actionId, true);
    render();
    let finalToast = '';
    let finalToastDuration = 2600;
    (async () => {
      showToast('단락 스타일 셋팅 준비 중…', { persist: true });
      const tempInfo = await styleInsertTempParagraph();
      const done = [];
      try {
        for (let i = 0; i < defs.length; i++) {
          const def = defs[i];
          showToast('단락 스타일 셋팅: ' + def.label + ' (' + (i + 1) + '/' + defs.length + ')', { persist: true });
          await styleApplyPresetDef(def, tempInfo.range);
          done.push(def.label);
        }
      } finally {
        showToast('임시 문단 정리 중…', { persist: true });
        tempInfo.removed = await styleRemoveTempParagraph(tempInfo).catch(error => {
          console.error('[Toytype style preset] temp cleanup failed', error);
          return false;
        });
      }
      return { done, removed: tempInfo.removed, total: defs.length };
    })().then(result => {
      if (!result.removed) {
        finalToast = '스타일 셋팅 ' + result.done.length + '/' + result.total + ' 완료 · 임시 문단 삭제 실패 — 문서 끝의 ' + STYLE_PRESET_TEMP_TEXT + ' 줄을 직접 지워주세요';
        finalToastDuration = 6000;
        return;
      }
      finalToast = '단락 스타일 셋팅 완료: ' + result.done.join(', ');
    }).catch(error => {
      console.error('[Toytype style preset] failed', error);
      finalToast = '단락 스타일 셋팅 실패 — ' + styleShortErrorText(error);
      finalToastDuration = 6000;
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

  function startAiVerifyStatus(phase) {
    addonStatus = {
      type: 'ai-verify',
      label: 'AI 사실 검증',
      state: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      phase: phase || '시작 중',
      message: ''
    };
    startAddonStatusTicker();
    if (expanded) render();
  }

  function updateAiVerifyStatus(phase) {
    if (!addonStatus || addonStatus.type !== 'ai-verify' || addonStatus.state !== 'running') {
      startAiVerifyStatus(phase);
      return;
    }
    addonStatus.phase = phase || addonStatus.phase;
    if (expanded) render();
  }

  function finishAiVerifyStatus(state, message) {
    const now = Date.now();
    const previous = addonStatus && addonStatus.type === 'ai-verify' ? addonStatus : null;
    addonStatus = {
      type: 'ai-verify',
      label: 'AI 사실 검증',
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
      label: '용어 통일',
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
      label: '용어 통일',
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

  function startAiDiagramStatus(phase) {
    addonStatus = {
      type: 'ai-diagram',
      label: 'AI 도해',
      state: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      phase: phase || '시작 중',
      message: ''
    };
    startAddonStatusTicker();
    if (expanded) render();
  }

  function updateAiDiagramStatus(phase) {
    if (!addonStatus || addonStatus.type !== 'ai-diagram' || addonStatus.state !== 'running') {
      startAiDiagramStatus(phase);
      return;
    }
    addonStatus.phase = phase || addonStatus.phase;
    if (expanded) render();
  }

  function finishAiDiagramStatus(state, message) {
    const now = Date.now();
    const previous = addonStatus && addonStatus.type === 'ai-diagram' ? addonStatus : null;
    addonStatus = {
      type: 'ai-diagram',
      label: 'AI 도해',
      state: state === 'error' ? 'error' : 'success',
      startedAt: previous && previous.startedAt ? previous.startedAt : now,
      finishedAt: now,
      phase: '',
      message: message || ''
    };
    stopAddonStatusTicker();
    if (expanded) render();
  }

  function startHwpxExportStatus(phase) {
    addonStatus = {
      type: 'export-hwpx',
      label: 'HWPX 내보내기',
      state: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      phase: phase || '시작 중',
      message: ''
    };
    startAddonStatusTicker();
    if (expanded) render();
  }

  function updateHwpxExportStatus(phase) {
    if (!addonStatus || addonStatus.type !== 'export-hwpx' || addonStatus.state !== 'running') {
      startHwpxExportStatus(phase);
      return;
    }
    addonStatus.phase = phase || addonStatus.phase;
    if (expanded) render();
  }

  function finishHwpxExportStatus(state, message) {
    const now = Date.now();
    const previous = addonStatus && addonStatus.type === 'export-hwpx' ? addonStatus : null;
    addonStatus = {
      type: 'export-hwpx',
      label: 'HWPX 내보내기',
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
      const jobRunning = aiJobs.some(job => job.state === 'running');
      if (!jobRunning && (!addonStatus || addonStatus.state !== 'running')) {
        stopAddonStatusTicker();
        return;
      }
      // 경과 시간은 상태 표시줄에만 있으므로 그 줄만 바꾼다(전체 렌더는 지적 목록이 길면 무겁다)
      if (expanded) refreshStatusBar();
    }, 1000);
  }

  function stopAddonStatusTicker() {
    if (!addonStatusTimer) return;
    // 다른 AI 작업이 아직 돌고 있으면 경과 시간 표시를 위해 계속 돈다
    if (aiJobs.some(job => job.state === 'running') && addonStatus && addonStatus.state !== 'running') return;
    clearInterval(addonStatusTimer);
    addonStatusTimer = null;
  }

  // 푸터 상태: 1줄 요약(제목 · 경과) + 2줄 상세. 상세가 요약을 되풀이하면 생략한다.
  function addonStatusLines() {
    if (!addonStatus) return null;
    const label = addonStatus.label || (addonStatus.type === 'ai-proofread' ? 'AI 교정' : 'AI 작업');
    const now = addonStatus.state === 'running' ? Date.now() : (addonStatus.finishedAt || Date.now());
    const elapsed = formatElapsed(now - (addonStatus.startedAt || now));
    const state = addonStatus.state;
    const suffix = state === 'running' ? ' 중' : (state === 'error' ? ' 실패' : ' 완료');
    const head = label + suffix + ' · ' + elapsed;
    const raw = state === 'running'
      ? (addonStatus.phase || '')
      : (addonStatus.message || (state === 'error' ? '오류 발생' : ''));
    const detail = stripStatusHeadEcho(raw, label + suffix);
    return { head, detail };
  }

  // 상태 표시줄 한 줄 문구. 진행 중이면 지금 단계와 경과 시간, 끝나면 결과를 보여 준다.
  function addonStatusBarText() {
    const lines = addonStatusLines();
    if (!lines || !lines.head) return '';
    if (!lines.detail) return lines.head;
    const state = addonStatus.state;
    if (state === 'running') return lines.detail + ' · ' + lines.head.slice(lines.head.lastIndexOf(' · ') + 3);
    // 끝난 뒤에는 결과 문구만(완료 문구에 이미 무엇이 끝났는지 들어 있다). 실패는 무엇이 실패했는지 앞에 붙인다.
    if (state === 'error') return (addonStatus.label || 'AI 작업') + ' 실패 · ' + lines.detail;
    return lines.detail;
  }

  // 상태 표시줄용 짧은 글자 수(전체는 툴팁)
  function selectionCountShortText() {
    if (!selectionCount) return '';
    return selectionCount.chars.toLocaleString() + '자 · ' + selectionCount.words.toLocaleString() + '단어';
  }

  function buildStatusBar() {
    const notice = statusNotice;
    const jobsText = aiJobsSummaryText();
    const statusText = notice ? notice.text : (jobsText || addonStatusBarText());
    const countText = selectionCountText();
    const showJobs = externalFeaturesEnabled();
    if (!statusText && !countText && !showJobs) return null;
    const bar = el('div', 'trd-statusbar');
    if (statusText) {
      const state = notice ? (notice.error ? 'error' : 'notice') : jobsText ? 'running' : (addonStatus && addonStatus.state ? addonStatus.state : '');
      const status = el('div', 'trd-statusbar-status' + (state ? ' trd-statusbar-' + state : ''));
      if (state === 'running') {
        // 상태 표시줄은 1초마다 다시 그려지므로 회전 위상을 시계에 맞춰 끊기지 않게 한다
        const spinner = el('span', 'trd-statusbar-spinner');
        spinner.style.animationDelay = '-' + (Date.now() % 800) + 'ms';
        status.appendChild(spinner);
      }
      const text = el('span', 'trd-statusbar-text');
      text.textContent = statusText;
      status.appendChild(text);
      status.title = statusText;
      bar.appendChild(status);
    }
    if (countText) {
      const count = el('div', 'trd-statusbar-count');
      count.textContent = statusText ? selectionCountShortText() : countText;
      count.title = countText;
      bar.appendChild(count);
    }
    if (showJobs) {
      bar.appendChild(buildJobQueueButton());
      if (jobQueueOpen) bar.appendChild(buildJobQueuePanel());
    }
    return bar;
  }

  // '<라벨> 완료 · JSON 업로드됨' 처럼 상세 앞머리가 요약과 겹치면 잘라낸다.
  function stripStatusHeadEcho(detail, head) {
    const text = String(detail || '').trim();
    if (!text) return '';
    if (text === head) return '';
    if (text.startsWith(head + ' · ')) return text.slice(head.length + 3);
    return text;
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
      syncSelectionCountFromModel(res.text, res.selection || null);
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
  // ---------- AI 작업 큐 ----------
  const AI_JOB_LABEL = {
    proofread: 'AI 교정',
    verifyFacts: 'AI 사실 검증',
    adjustLength: 'AI 문장 길이 조절',
    diagram: 'AI 도해',
    question: 'AI 문장 삽입'
  };
  const AI_JOB_HISTORY = 20;
  const AI_CONCURRENCY_KEY = 'aiJobConcurrency';

  function sendAiBridge(action, payload, meta) {
    if (!AI_JOB_LABEL[action]) return sendAiBridgeViaBackground(action, payload);
    return new Promise(resolve => {
      const job = newAiJob(action, payload, meta || null);
      job.resolve = resolve;
      aiJobs.push(job);
      pumpAiJobs();
      syncAiJobQueue();
      refreshJobViews();
    });
  }

  function newAiJob(action, payload, meta) {
    return {
      id: 'job' + (++aiJobSeq) + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      docId: getDocId() || '',
      action,
      payload,
      meta,
      label: AI_JOB_LABEL[action],
      detail: aiJobDetail(action, payload),
      state: 'queued',
      createdAt: Date.now(),
      startedAt: 0,
      finishedAt: 0,
      message: '',
      retryable: false,
      resolve: null
    };
  }

  function aiJobDetail(action, payload) {
    const doc = payload && payload.document || {};
    const text = String(doc.selectedText || '').replace(/\s+/g, ' ').trim();
    if (action === 'proofread') return '문서 전체';
    if (action === 'diagram') {
      const mode = DIAGRAM_KIND_LABEL[payload && payload.mode] || '도해';
      return text ? mode + ' · ' + text.slice(0, 40) : mode;
    }
    return text ? text.slice(0, 48) : '';
  }

  function aiJobsActive() {
    return aiJobs.filter(job => job.state === 'queued' || job.state === 'running');
  }

  function pumpAiJobs() {
    let running = aiJobs.filter(job => job.state === 'running').length;
    for (const job of aiJobs) {
      if (running >= aiConcurrency) break;
      if (job.state !== 'queued') continue;
      running++;
      startAiJob(job);
    }
  }

  function startAiJob(job) {
    job.state = 'running';
    job.startedAt = Date.now();
    startAddonStatusTicker();
    sendAiBridgeViaBackground(job.action, job.payload, job.id, {
      docId: job.docId,
      action: job.action,
      label: job.label,
      detail: job.detail,
      meta: job.meta,
      createdAt: job.createdAt
    }).then(res => {
      if (job.state !== 'running') return; // 이미 취소됨
      finishAiJob(job, res && res.ok ? 'done' : (res && res.error === 'canceled' ? 'canceled' : 'error'),
        res && res.ok ? '' : (res && (res.message || res.error)) || '실패', res);
    });
  }

  function finishAiJob(job, state, message, res) {
    job.state = state;
    job.finishedAt = Date.now();
    job.message = String(message || '');
    // 문서 텍스트는 오래 들고 있지 않는다. 실패·취소한 작업만 [다시]를 위해 남긴다.
    if (state === 'done') job.payload = null;
    job.retryable = state !== 'done' && !!job.payload;
    const resolve = job.resolve;
    job.resolve = null;
    const finished = aiJobs.filter(j => j.state !== 'queued' && j.state !== 'running');
    if (finished.length > AI_JOB_HISTORY) {
      const drop = new Set(finished.slice(0, finished.length - AI_JOB_HISTORY));
      aiJobs = aiJobs.filter(j => !drop.has(j));
    }
    pumpAiJobs();
    syncAiJobQueue();
    const result = res || { ok: false, error: state === 'canceled' ? 'canceled' : 'failed', message: job.message };
    if (resolve) {
      resolve(result);
      if (state === 'done') ackAiJob(job.id);
    } else if (state === 'done') {
      // 새로고침 뒤 이어받았거나 [다시]로 돌린 작업: 기다리는 화면이 없으므로 결과를 직접 반영한다.
      recoverAiJobResult(job, result).finally(() => ackAiJob(job.id));
    }
    refreshJobViews();
  }

  function cancelAiJob(job) {
    if (!job || (job.state !== 'queued' && job.state !== 'running')) return;
    const wasRunning = job.state === 'running';
    finishAiJob(job, 'canceled', '취소함', { ok: false, error: 'canceled', message: '작업을 취소했습니다' });
    if (wasRunning) {
      try {
        chrome.runtime.sendMessage({ type: 'typo:aiBridgeAbort', requestId: job.id }, () => { void chrome.runtime.lastError; });
      } catch (_) { /* 확장 컨텍스트가 없어도 결과는 이미 버렸다 */ }
    }
  }

  function moveAiJob(job, delta) {
    const queued = aiJobs.filter(j => j.state === 'queued');
    const i = queued.indexOf(job);
    const target = queued[i + delta];
    if (i < 0 || !target) return;
    const a = aiJobs.indexOf(job);
    const b = aiJobs.indexOf(target);
    aiJobs[a] = target;
    aiJobs[b] = job;
    syncAiJobQueue();
    refreshJobViews();
  }

  function removeAiJobs(jobs) {
    const drop = new Set(jobs);
    if (!drop.size) return;
    aiJobs = aiJobs.filter(j => !drop.has(j));
    sendJobStoreMessage({ type: 'typo:aiJobRemove', ids: jobs.map(j => j.id) });
    refreshJobViews();
  }

  // 실패·취소한 작업을 같은 내용으로 다시 큐에 넣는다. 결과는 원래 실행했을 때와 같은 곳에 반영된다.
  async function retryAiJob(job) {
    if (!job || !job.retryable) return;
    let payload = job.payload;
    let meta = job.meta;
    if (!payload) {
      const res = await sendJobStoreMessage({ type: 'typo:aiJobPayload', id: job.id });
      payload = res && res.ok ? res.payload : null;
      meta = res && res.meta || meta;
    }
    if (!payload) {
      job.retryable = false;
      showToast('다시 실행할 내용이 남아 있지 않습니다 · 처음부터 다시 실행하세요', { durationMs: 3600 });
      refreshJobViews();
      return;
    }
    const next = newAiJob(job.action, payload, meta);
    next.detail = job.detail;
    aiJobs = aiJobs.filter(j => j !== job);
    sendJobStoreMessage({ type: 'typo:aiJobRemove', ids: [job.id] });
    aiJobs.push(next);
    pumpAiJobs();
    syncAiJobQueue();
    refreshJobViews();
  }

  function sendJobStoreMessage(msg) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(msg, res => {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(res || null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  // 대기열(아직 시작 안 한 작업)을 백그라운드에 맡겨 둔다. 짧은 시간에 여러 번 바뀌면 한 번만 보낸다.
  let aiJobQueueSyncTimer = null;
  function syncAiJobQueue() {
    clearTimeout(aiJobQueueSyncTimer);
    aiJobQueueSyncTimer = setTimeout(() => {
      aiJobQueueSyncTimer = null;
      const byDoc = new Map();
      for (const job of aiJobs) {
        if (!job.docId) continue;
        if (!byDoc.has(job.docId)) byDoc.set(job.docId, []);
        if (job.state === 'queued') {
          byDoc.get(job.docId).push({
            id: job.id, action: job.action, label: job.label, detail: job.detail,
            meta: job.meta, payload: job.payload, createdAt: job.createdAt
          });
        }
      }
      const docId = getDocId();
      if (docId && !byDoc.has(docId)) byDoc.set(docId, []);
      for (const [id, jobs] of byDoc) sendJobStoreMessage({ type: 'typo:aiJobsSyncQueue', docId: id, jobs });
    }, 150);
  }

  function ackAiJob(id) {
    sendJobStoreMessage({ type: 'typo:aiJobAck', id });
  }

  // 문서를 열 때 백그라운드에 남은 이 문서의 작업을 이어받는다.
  let aiJobsRestoredDocId = null;
  async function restoreAiJobs(docId) {
    if (!docId || aiJobsRestoredDocId === docId) return;
    aiJobsRestoredDocId = docId;
    const res = await sendJobStoreMessage({ type: 'typo:aiJobsList', docId });
    if (!res || !res.ok || !Array.isArray(res.jobs) || getDocId() !== docId) return;
    const known = new Set(aiJobs.map(j => j.id));
    let recovered = 0;
    let resumed = 0;
    for (const rec of res.jobs) {
      if (!rec || known.has(rec.id) || !AI_JOB_LABEL[rec.action]) continue;
      const job = Object.assign(newAiJob(rec.action, rec.payload || null, rec.meta || null), {
        id: rec.id,
        docId,
        label: rec.label || AI_JOB_LABEL[rec.action],
        detail: rec.detail || '',
        state: rec.state,
        createdAt: rec.createdAt || Date.now(),
        startedAt: rec.startedAt || 0,
        finishedAt: rec.finishedAt || 0,
        message: rec.message || '',
        retryable: !!rec.retryable
      });
      if (job.state === 'queued' && !job.payload) {
        job.state = 'error';
        job.message = '내용이 너무 커서 이어받지 못했습니다 · 다시 실행하세요';
        job.finishedAt = Date.now();
      }
      aiJobs.push(job);
      if (job.state === 'running') {
        resumed++;
        awaitRestoredAiJob(job);
      } else if (job.state === 'queued') {
        resumed++;
      } else if (job.state === 'done' && rec.result) {
        recovered++;
        recoverAiJobResult(job, rec.result).finally(() => ackAiJob(job.id));
      }
    }
    if (!recovered && !resumed) {
      refreshJobViews();
      return;
    }
    pumpAiJobs();
    if (aiJobs.some(j => j.state === 'running')) startAddonStatusTicker();
    const parts = [];
    if (resumed) parts.push('이어받은 AI 작업 ' + resumed + '개');
    if (recovered) parts.push('복구한 결과 ' + recovered + '개');
    showToast(parts.join(' · '), { durationMs: 3600 });
    refreshJobViews();
  }

  function awaitRestoredAiJob(job) {
    sendJobStoreMessage({ type: 'typo:aiJobAwait', id: job.id }).then(res => {
      if (job.state !== 'running') return;
      const rec = res && res.ok ? res.job : null;
      if (!rec) {
        finishAiJob(job, 'error', '작업 기록을 찾지 못했습니다', null);
        return;
      }
      if (rec.state === 'running') {
        // 백그라운드가 재시작돼 응답이 끊겼다 — 잠시 뒤 다시 확인한다
        setTimeout(() => awaitRestoredAiJob(job), 3000);
        return;
      }
      job.retryable = !!rec.retryable;
      finishAiJob(job, rec.state, rec.message, rec.state === 'done' ? (rec.result || { ok: true }) : { ok: false, error: rec.state === 'canceled' ? 'canceled' : 'failed', message: rec.message });
    });
  }

  // 화면이 기다리지 않는 작업(새로고침 뒤 이어받은 것, [다시])의 결과를 반영한다.
  async function recoverAiJobResult(job, res) {
    if (!res || !res.ok || job.docId !== getDocId()) return;
    const meta = job.meta || {};
    let status = '';
    try {
      if (job.action === 'proofread' && res.json) {
        status = applyProofreadResult(res);
      } else if (job.action === 'adjustLength' && res.json) {
        status = applyLengthResult(res, meta.targetChars);
      } else if (job.action === 'verifyFacts') {
        status = applyFactsResult(res, String(meta.selectedText || ''), job.docId, false).status;
      } else if (job.action === 'diagram' && res.spec) {
        await applyDiagramResult(res, {
          docId: job.docId,
          kind: meta.kind || 'diagram',
          instruction: meta.instruction || '',
          restoreDrawing: meta.restoreDrawing || null,
          image: null
        });
        if (!anyAddonViewOpen()) diagramsViewOpen = true;
        status = 'AI 도해 완료 · 도해 탭에서 복사';
      }
    } catch (error) {
      console.error('[Toytype addons] AI job result recovery failed', summarizeErrorForConsole(error));
      showToast(job.label + ' 결과를 반영하지 못했습니다', { durationMs: 3600, error: true });
      return;
    }
    if (status) showToast(status, { durationMs: 3600 });
    if (expanded) render({ preserveBodyScroll: true });
  }

  function setAiConcurrency(n) {
    aiConcurrency = Math.min(6, Math.max(1, Math.round(n)));
    try { chrome.storage.local.set({ [AI_CONCURRENCY_KEY]: aiConcurrency }); } catch (_) { /* 메모리 값만 유지 */ }
    pumpAiJobs();
    refreshJobViews();
  }

  function loadAiConcurrency() {
    try {
      chrome.storage.local.get(AI_CONCURRENCY_KEY, items => {
        if (chrome.runtime.lastError) return;
        const n = Number(items && items[AI_CONCURRENCY_KEY]);
        if (n >= 1 && n <= 6) aiConcurrency = Math.round(n);
      });
    } catch (_) { /* 기본값 사용 */ }
  }

  function refreshJobViews() {
    if (!expanded) return;
    render({ preserveBodyScroll: true });
  }

  function aiJobsSummaryText() {
    const active = aiJobsActive();
    if (!active.length) return '';
    const running = active.filter(j => j.state === 'running').length;
    const queued = active.length - running;
    if (running <= 1 && queued === 0) return ''; // 하나뿐이면 원래 상태 문구가 더 자세하다
    return 'AI 작업 ' + running + '개 진행 중' + (queued ? ' · ' + queued + '개 대기' : '');
  }

  function buildJobQueueButton() {
    const active = aiJobsActive().length;
    const btn = el('button', 'trd-statusbar-jobs' + (jobQueueOpen ? ' trd-on' : '') + (active ? ' trd-active' : ''));
    btn.type = 'button';
    btn.textContent = active ? '작업 ' + active : '작업';
    btn.title = '작업 큐 보기 · 순서 바꾸기 · 취소';
    btn.setAttribute('aria-expanded', jobQueueOpen ? 'true' : 'false');
    btn.addEventListener('click', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      jobQueueOpen = !jobQueueOpen;
      render({ preserveBodyScroll: true });
    });
    return btn;
  }

  const AI_JOB_STATE_LABEL = { queued: '대기', running: '실행 중', done: '완료', error: '실패', canceled: '취소됨' };

  function buildJobQueuePanel() {
    const panel = el('div', 'trd-jobs');
    const head = el('div', 'trd-jobs-head');
    const title = el('span', 'trd-jobs-title');
    title.textContent = 'AI 작업 큐';
    const conc = el('div', 'trd-jobs-conc');
    const concLabel = el('span');
    concLabel.textContent = '동시 실행 ' + aiConcurrency;
    const minus = el('button', 'trd-jobs-btn');
    minus.type = 'button';
    minus.textContent = '−';
    minus.title = '동시 실행 수 줄이기';
    minus.disabled = aiConcurrency <= 1;
    minus.addEventListener('click', ev => { ev.stopPropagation(); setAiConcurrency(aiConcurrency - 1); });
    const plus = el('button', 'trd-jobs-btn');
    plus.type = 'button';
    plus.textContent = '+';
    plus.title = '동시 실행 수 늘리기';
    plus.disabled = aiConcurrency >= 6;
    plus.addEventListener('click', ev => { ev.stopPropagation(); setAiConcurrency(aiConcurrency + 1); });
    conc.append(minus, concLabel, plus);
    const clear = el('button', 'trd-jobs-btn trd-jobs-clear');
    clear.type = 'button';
    clear.textContent = '끝난 항목 지우기';
    clear.disabled = !aiJobs.some(j => j.state !== 'queued' && j.state !== 'running');
    clear.addEventListener('click', ev => {
      ev.stopPropagation();
      removeAiJobs(aiJobs.filter(j => j.state !== 'queued' && j.state !== 'running'));
    });
    head.append(title, conc, clear);
    panel.appendChild(head);
    if (!aiJobs.length) {
      const empty = el('div', 'trd-jobs-empty');
      empty.textContent = 'AI 작업이 없습니다. 실행한 AI 교정·사실 검증·문장 길이 조절·도해가 여기에 쌓입니다.';
      panel.appendChild(empty);
      return panel;
    }
    const list = el('div', 'trd-jobs-list');
    const queued = aiJobs.filter(j => j.state === 'queued');
    // 진행 중·대기 먼저(실행 순서대로), 그다음 최근에 끝난 것
    const order = aiJobs.filter(j => j.state === 'running')
      .concat(queued)
      .concat(aiJobs.filter(j => j.state !== 'queued' && j.state !== 'running').reverse());
    for (const job of order) {
      const row = el('div', 'trd-job trd-job-' + job.state);
      const main = el('div', 'trd-job-main');
      const name = el('div', 'trd-job-name');
      const now = job.state === 'running' ? Date.now() : (job.finishedAt || Date.now());
      const elapsed = job.startedAt ? ' · ' + formatElapsed(now - job.startedAt) : '';
      name.textContent = job.label + ' · ' + AI_JOB_STATE_LABEL[job.state] + (job.state === 'queued' ? ' ' + (queued.indexOf(job) + 1) + '번째' : elapsed);
      const detail = el('div', 'trd-job-detail');
      detail.textContent = job.state === 'error' && job.message ? job.message : job.detail;
      detail.title = job.detail + (job.message ? '\n' + job.message : '');
      main.append(name, detail);
      row.appendChild(main);
      const actions = el('div', 'trd-job-actions');
      const addBtn = (text, title, fn, disabled) => {
        const b = el('button', 'trd-jobs-btn');
        b.type = 'button';
        b.textContent = text;
        b.title = title;
        b.disabled = !!disabled;
        b.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); fn(); });
        actions.appendChild(b);
      };
      if (job.state === 'queued') {
        const qi = queued.indexOf(job);
        addBtn('↑', '먼저 실행', () => moveAiJob(job, -1), qi === 0);
        addBtn('↓', '나중에 실행', () => moveAiJob(job, 1), qi === queued.length - 1);
      }
      if (job.state === 'queued' || job.state === 'running') {
        addBtn('취소', job.state === 'running' ? '실행 중인 AI를 멈추고 결과를 버립니다' : '대기열에서 뺍니다', () => cancelAiJob(job));
      } else {
        if (job.retryable) addBtn('다시', '같은 내용으로 다시 실행합니다', () => { retryAiJob(job); });
        addBtn('✕', '목록에서 지우기', () => { removeAiJobs([job]); });
      }
      row.appendChild(actions);
      list.appendChild(row);
    }
    panel.appendChild(list);
    return panel;
  }

  function sendAiBridgeViaBackground(action, payload, requestId, job) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({
          type: 'typo:aiBridge',
          action,
          requestId: requestId || '',
          job: job || null,
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
    if (!externalFeaturesEnabled()) {
      stopBridgeStatusWatcher();
      return;
    }
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
    if (!externalFeaturesEnabled()) return;
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
    if (!externalFeaturesEnabled()) return;
    refreshGeneratedRulesList().catch(error => {
      console.error('[Toytype addons] generated JSON list failed', error);
    });
  }

  async function refreshGeneratedRulesList() {
    if (!externalFeaturesEnabled()) return false;
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
    if (code === 'canceled') {
      userMessage = '작업 큐에서 취소했습니다';
    } else if (code === 'bridge_unavailable') {
      userMessage = '로컬 브리지가 꺼져 있습니다 · 터미널에서 브리지를 실행하세요';
    } else if (code === 'external_features_disabled') {
      userMessage = '브릿지/외부 기능이 꺼져 있습니다 · 설정에서 켜세요';
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
    const diagnostic = details && typeof details.diagnostic === 'string' && details.diagnostic.trim()
      ? details.diagnostic.trim()
      : firstUsefulAiBridgeDiagnostic(details);
    if (diagnostic) userMessage += ' · ' + diagnostic.slice(0, 160);
    const error = new Error(userMessage);
    error.userMessage = userMessage;
    error.response = res;
    return error;
  }

  function firstUsefulAiBridgeDiagnostic(details) {
    if (!details || typeof details !== 'object') return '';
    const streams = [details.stderr, details.stdout];
    for (const stream of streams) {
      if (typeof stream !== 'string' || !stream.trim()) continue;
      const lines = stream.split(/\r?\n/).map(cleanAiBridgeDiagnosticLine).filter(Boolean);
      const line = lines.find(isUsefulAiBridgeDiagnosticLine);
      if (line) return line;
    }
    return '';
  }

  function cleanAiBridgeDiagnosticLine(line) {
    return String(line || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').trim();
  }

  function isUsefulAiBridgeDiagnosticLine(line) {
    const text = String(line || '').trim();
    if (!text || text.length > 300) return false;
    if (/^(error|fatal|failed|failure|timed out|timeout|aborted|spawn|enoent|eacces|permission denied|authentication|unauthorized|rate limit|api error|openai error|claude error|codex error|node:|npm err!)/i.test(text)) return true;
    if (/^(오류|실패|시간 초과|인증|권한|명령을 찾을 수 없습니다|찾을 수 없습니다)/.test(text)) return true;
    return false;
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
      diagnostic: details && typeof details.diagnostic === 'string' ? details.diagnostic : firstUsefulAiBridgeDiagnostic(details) || undefined,
      stdoutChars: details && details.stdoutChars !== undefined ? details.stdoutChars : details && typeof details.stdout === 'string' ? details.stdout.length : undefined,
      stderrChars: details && details.stderrChars !== undefined ? details.stderrChars : details && typeof details.stderr === 'string' ? details.stderr.length : undefined
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





  function isMarkdownHeadingLine(line) {
    return /^#{1,6}\s+\S/.test(line || '');
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

  // 선택 오프셋과 그 구간의 실제 본문을 한 번에 받는다(글자수 집계용).
  function fetchDocsSelectionText() {
    return requestDocsModel('getSelectionText', { docId: getDocId() }).then(res => {
      if (!res || !res.ok) throw new Error(res && res.errorMessage ? res.errorMessage : 'getSelectionText failed');
      return {
        selection: res.selection || null,
        selectedText: typeof res.selectedText === 'string' ? res.selectedText : ''
      };
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

  // 짧은 안내는 떠 있는 토스트 대신 패널 아래 상태 표시줄에 잠시 보여 준다.
  // 이름은 호출부가 많아 그대로 둔다. 안내가 사라지면 진행 중·완료된 작업 상태로 돌아간다.
  function showToast(text, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const message = String(text || '').trim();
    clearTimeout(toastTimer);
    if (!message) {
      statusNotice = null;
      refreshStatusBar();
      return;
    }
    const durationMs = Number.isFinite(Number(opts.durationMs)) ? Math.max(500, Number(opts.durationMs)) : 2000;
    statusNotice = {
      text: message,
      error: opts.error === true || /실패|못했|없습니다|찾지 못|오류|꺼져/.test(message)
    };
    refreshStatusBar();
    if (opts.persist === true) return;
    // 상태 표시줄은 한 줄이라 토스트보다 조금 더 오래 둔다
    toastTimer = setTimeout(() => {
      statusNotice = null;
      refreshStatusBar();
    }, durationMs + 1000);
  }

  // 패널 전체를 다시 그리지 않고 상태 표시줄만 바꾼다(입력 중인 창의 포커스를 지키기 위해).
  function refreshStatusBar() {
    if (!shadowView) return;
    const panel = shadowView.querySelector('.trd-panel');
    if (!panel) return;
    const old = panel.querySelector('.trd-statusbar');
    const oldList = old && old.querySelector('.trd-jobs-list');
    const listScroll = oldList ? oldList.scrollTop : 0;
    const next = buildStatusBar();
    if (old && next) {
      old.replaceWith(next);
      const list = next.querySelector('.trd-jobs-list');
      if (list) list.scrollTop = listScroll;
    }
    else if (old) old.remove();
    else if (next) {
      const foot = panel.querySelector('.trd-foot');
      if (foot) foot.after(next);
      else panel.appendChild(next);
    }
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
    syncExternalFeatureState();
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
    if (!GRID_FRAME) injectPageBridgeScript();
    refreshGeneratedRulesListQuiet();
    return enqueueScan(true);
  }

  async function onSettingsChanged() {
    settings = await readSettings();
    syncExternalFeatureState();
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

  // 프레임 안: 우리 격자 보기가 띄운 문서 칸에서만 동작한다(구글이 자체로 띄운 프레임에서는 쉰다)
  const IN_FRAME = window.top !== window;
  const GRID_FRAME = IN_FRAME && window.parent === window.top && (() => {
    try {
      const anc = location.ancestorOrigins;
      return !!anc && anc.length > 0 && anc[anc.length - 1] === 'chrome-extension://' + chrome.runtime.id;
    } catch (_) {
      return false;
    }
  })();

  function reportGridFrame() {
    if (!GRID_FRAME) return;
    const report = {
      docId: getDocId(),
      title: document.title,
      hasEditor: !!document.querySelector('.kix-appview-editor'),
      signInLink: !!document.querySelector('a[href*="ServiceLogin"], a[href*="accounts.google.com/signin"]'),
      pages: measureEditorPages(),
      bridgeReady: !!pageBridgeReady,
      sinceLoadMs: Math.round(performance.now())
    };
    try { chrome.runtime.sendMessage({ type: 'typo:gridFrameReport', report }, () => { void chrome.runtime.lastError; }); } catch (_) { /* 무시 */ }
    try { window.parent.postMessage({ kind: 'toytype-grid-frame', report }, 'chrome-extension://' + chrome.runtime.id); } catch (_) { /* 무시 */ }
  }

  // ---------- 격자 보기 요청 처리 ----------
  // 격자 페이지(부모 프레임, 우리 확장 출처)만 이 문서에 본문 읽기·위치 선택·문구 바꾸기를 요청할 수 있다.
  // 바꾸기는 패널의 [적용]과 같은 내부 텍스트 액션을 쓰므로 실행 취소(⌘Z)와 버전 기록에 그대로 남는다.
  const GRID_ORIGIN = 'chrome-extension://' + chrome.runtime.id;
  let gridApplyChain = Promise.resolve();
  let pageBridgeInjectedForGrid = false;

  function nearestIndexOf(text, needle, hint) {
    if (!needle) return -1;
    let best = -1;
    let bestDist = Infinity;
    let i = text.indexOf(needle);
    while (i !== -1) {
      const d = Math.abs(i - (Number(hint) || 0));
      if (d < bestDist) { best = i; bestDist = d; }
      i = text.indexOf(needle, i + 1);
    }
    return best;
  }

  // ---------- 에이전트 커서 ----------
  // 구글 문서의 공동 작업자 커서와 같은 모양(세로 막대 + 이름표)을 본문과 함께 스크롤되는 컨테이너에 그린다.
  // 위치는 그 자리를 실제로 선택한 뒤 내 커서(.kix-cursor 중 이름이 빈 것)가 놓인 좌표를 빌린다.
  const agentCursors = new Map();

  function ownDocsCursor() {
    return Array.from(document.querySelectorAll('.kix-cursor')).find(node => {
      const name = node.querySelector('.kix-cursor-name');
      return !name || !name.textContent.trim();
    }) || null;
  }

  const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  async function placeAgentCursor(agent, start) {
    if (!agent || !agent.id) return false;
    await selectDocsModelRange(start, start).catch(() => null);
    await nextFrame();
    const own = ownDocsCursor();
    const caretOwn = own && own.querySelector('.kix-cursor-caret');
    if (!own || !own.parentElement || !caretOwn) return false;
    let cur = agentCursors.get(agent.id);
    const fresh = !cur || !cur.isConnected;
    if (fresh) {
      cur = document.createElement('div');
      cur.className = 'toytype-agent-cursor';
      // 구글 문서 커서는 transform: translate(x, y)로 자리를 잡는다 — 같은 방식으로 따라가며 미끄러지듯 옮긴다
      cur.style.cssText = 'position:absolute;left:0;top:0;z-index:5;pointer-events:none;transition:transform .35s cubic-bezier(.2,.8,.2,1);';
      const caret = document.createElement('div');
      caret.style.cssText = 'width:2px;border-radius:1px;';
      const flag = document.createElement('div');
      flag.style.cssText = 'position:absolute;left:0;bottom:100%;margin-bottom:1px;padding:1px 5px;border-radius:3px 3px 3px 0;color:#fff;font:600 11px/15px "Google Sans",Roboto,Arial,sans-serif;white-space:nowrap;';
      cur.append(flag, caret);
      agentCursors.set(agent.id, cur);
    }
    const [flag, caret] = cur.children;
    const color = String(agent.color || '#1a73e8');
    caret.style.background = color;
    caret.style.height = Math.max(14, parseFloat(caretOwn.style.height) || caretOwn.offsetHeight || 18) + 'px';
    flag.style.background = color;
    flag.textContent = String(agent.label || '에이전트');
    if (cur.parentElement !== own.parentElement) own.parentElement.appendChild(cur);
    const pos = String(own.style.transform || '').match(/translate\(\s*([-\d.]+)px\s*,\s*([-\d.]+)px\s*\)/);
    if (pos) cur.style.transform = 'translate(' + pos[1] + 'px, ' + pos[2] + 'px)';
    else cur.style.transform = 'translate(' + own.offsetLeft + 'px, ' + own.offsetTop + 'px)';
    // 새 구간을 맡을 때마다 새 커서가 나타나는 것처럼 보이게 한다
    if (fresh && cur.animate) cur.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' });
    return true;
  }

  function removeAgentCursor(id) {
    const cur = agentCursors.get(id);
    agentCursors.delete(id);
    if (!cur) return;
    if (cur.animate) cur.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300 }).onfinish = () => cur.remove();
    else cur.remove();
  }

  async function gridApplyEdit(args) {
    const src = String(args.src || '');
    const dst = String(args.dst || '');
    if (!src) throw new Error('empty source');
    const model = await fetchModelText(getDocId());
    const start = nearestIndexOf(model.text, src, args.hint);
    if (start === -1) return { ok: false, error: 'not_found' };
    if (args.agent) await placeAgentCursor(args.agent, start).catch(() => false);
    await selectDocsModelRange(start, start + src.length).catch(() => null);
    const result = await applyResolvedFindingFromContent({
      index: -1,
      finding: { src, dst, start, end: start + src.length, cat: 'ai-grid' },
      selector: 'grid'
    }, {
      confirmMutation: true,
      useInternalTextAction: true,
      useFindReplaceFallback: false,
      requirePrimeFindMatch: true,
      actionWaitMs: 3000,
      primeWaitMs: 5000,
      mutationWaitMs: 8000,
      directActionWaitMs: 250,
      deferVerification: false,
      rescan: false,
      knownBeforeText: model.text
    });
    const verified = !!(result && result.verified === true);
    return { ok: verified, error: verified ? '' : 'not_verified', start };
  }

  async function handleGridRpc(op, args) {
    if (op === 'ping') {
      // 패널 초기화(페이지 브리지 주입)가 끝나야 문서 모델을 다룰 수 있다
      return { ok: !!pageBridgeReady, pages: measureEditorPages() };
    }
    if (op === 'getText') {
      const model = await fetchModelText(getDocId());
      return { ok: true, text: model.text };
    }
    if (op === 'select') {
      await selectDocsModelRange(Number(args.start) || 0, Number(args.end) || Number(args.start) || 0);
      return { ok: true };
    }
    if (op === 'agentCursor') {
      const ok = await placeAgentCursor(args.agent, Number(args.start) || 0);
      return { ok };
    }
    if (op === 'agentCursorRemove') {
      removeAgentCursor(String(args.id || ''));
      return { ok: true };
    }
    if (op === 'locate') {
      const model = await fetchModelText(getDocId());
      const start = nearestIndexOf(model.text, String(args.src || ''), args.hint);
      if (start === -1) return { ok: false, error: 'not_found' };
      await selectDocsModelRange(start, start + String(args.src).length);
      return { ok: true, start };
    }
    if (op === 'applyEdit') {
      // 문서 모델 조작은 한 번에 하나씩
      const run = gridApplyChain.then(() => gridApplyEdit(args));
      gridApplyChain = run.catch(() => {});
      return run;
    }
    return { ok: false, error: 'unknown_op' };
  }

  if (GRID_FRAME) {
    window.addEventListener('message', event => {
      if (event.origin !== GRID_ORIGIN || event.source !== window.parent) return;
      const data = event.data;
      if (!data || data.kind !== 'toytype-grid-rpc') return;
      handleGridRpc(String(data.op || ''), data.args || {}).catch(error => ({
        ok: false, error: error && error.message ? error.message : String(error)
      })).then(res => {
        window.parent.postMessage({ kind: 'toytype-grid-rpc-result', id: data.id, res }, GRID_ORIGIN);
      });
    });
  }

  async function init() {
    if (IN_FRAME && !GRID_FRAME) return;
    if (GRID_FRAME) {
      // 격자 칸은 패널을 쓰지 않으므로 문서 모델에 닿는 페이지 브리지부터 바로 붙인다
      injectPageBridgeScript();
      pageBridgeInjectedForGrid = true;
      setTimeout(reportGridFrame, 6000);
    }
    settings = await readSettings();
    syncExternalFeatureState();
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
    loadDiagramResults();
    // 텍스트 입력용 iframe이 늦게 생길 수 있어 몇 번 더 설치를 시도한다(이미 설치된 창은 건너뜀).
    for (const ms of [0, 3000, 10000, 30000]) setTimeout(installDocsCopyCapture, ms);
    injectPageBridgeScript();
    refreshGeneratedRulesListQuiet();
    // document_idle + 3000ms 후 1회 자동 스캔. 이후 자동 폴링 없음.
    const delay = Math.max(0, 3000 - (Date.now() - startedAt));
    setTimeout(() => {
      enqueueScan(true).then(() => consumeDriveJump());
    }, delay);
    startPageCountSampler();
  }

  // ---------- 쪽수 기록 ----------
  // 구글 문서는 쪽 수를 서버에서 바로 얻을 수 없다. 편집기는 쪽을 가상화해 화면 근처만 그리지만
  // 스크롤 높이는 전체 배치를 반영하므로 (전체 높이 − 첫 쪽 위 여백) ÷ 쪽 간격으로 센다.
  // 값이 1.5초 동안 그대로일 때(배치가 끝났을 때)만 기록하고, 드라이브 버블이 이 값을 바로 쓴다.
  let pageMeasureLast = null;
  let pageMeasureStableSince = 0;
  let pageMeasureRecorded = null;

  function measureEditorPages() {
    const editor = document.querySelector('.kix-appview-editor');
    const nodes = Array.from(document.querySelectorAll('.kix-page-paginated'));
    if (!editor || !nodes.length) return null; // 쪽 없음(pageless) 모드
    const tops = nodes.map(n => parseFloat(n.style.top)).filter(Number.isFinite).sort((a, b) => a - b);
    const height = parseFloat(nodes[0].style.height) || nodes[0].offsetHeight;
    if (!tops.length || !height) return null;
    let pitch = 0;
    for (let i = 1; i < tops.length; i++) {
      const d = tops[i] - tops[i - 1];
      if (d > height * 0.9 && (!pitch || d < pitch)) pitch = d;
    }
    if (!pitch) {
      // 쪽이 하나만 그려져 있으면 한 쪽짜리 문서인지만 판단한다
      return editor.scrollHeight < tops[0] + height * 1.9 ? 1 : null;
    }
    const firstTop = tops[0] % pitch;
    const n = Math.round((editor.scrollHeight - firstTop) / pitch);
    return n >= 1 ? n : null;
  }

  function samplePageCount() {
    if (document.hidden) return;
    const docId = getDocId();
    const n = measureEditorPages();
    if (!docId || !n) return;
    if (n !== pageMeasureLast) {
      pageMeasureLast = n;
      pageMeasureStableSince = Date.now();
      return;
    }
    if (Date.now() - pageMeasureStableSince < 1500) return;
    const key = docId + ':' + n + ':' + location.search;
    if (pageMeasureRecorded === key) return;
    pageMeasureRecorded = key;
    try {
      // 탭 매개변수가 없으면 첫 탭을 보고 있는 것이다
      const tab = new URLSearchParams(location.search).get('tab') || 't.0';
      chrome.runtime.sendMessage({ type: 'typo:driveRecordPages', docId, pages: n, tab }, () => { void chrome.runtime.lastError; });
    } catch (_) { /* 확장 컨텍스트 무효화 */ }
  }

  function startPageCountSampler() {
    setInterval(samplePageCount, 1000);
  }

  // 드라이브 버블에서 지적을 눌러 이 문서를 열었으면 패널을 펴고 그 지적을 선택한다.
  async function consumeDriveJump() {
    const docId = getDocId();
    if (!docId) return;
    const res = await new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: 'typo:driveTakeJump', docId }, r => {
          void chrome.runtime.lastError;
          resolve(r || null);
        });
      } catch (_) {
        resolve(null);
      }
    });
    const target = res && res.ok ? res.target : null;
    if (!target || !target.src) return;
    if (target.kind === 'ai') {
      // 격자 보기의 AI 지적은 규칙 지적 목록에 없으므로 문구를 찾아 선택하고 제안을 상태 표시줄에 띄운다
      await selectFactClaimInDoc({ sourceText: target.src });
      showToast('AI 제안: ' + target.src + ' ➝ ' + (target.dst || '') + (target.reason ? ' · ' + target.reason : ''), { durationMs: 8000 });
      return;
    }
    expanded = true;
    listMode = 'order';
    suggestionsViewOpen = false;
    diagramsViewOpen = false;
    termsViewOpen = false;
    factsViewOpen = false;
    render();
    handleFindingClick({
      src: String(target.src),
      dst: String(target.dst || ''),
      cat: String(target.cat || ''),
      contextBefore: String(target.contextBefore || ''),
      contextAfter: String(target.contextAfter || ''),
      start: Number(target.start) || 0,
      end: (Number(target.start) || 0) + String(target.src).length,
      selectable: true
    });
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

  // 순수 로직 테스트용 훅 — Docs 없이 검증할 수 있는 함수만 노출한다.
  globalThis.ToytypeDocsInternal = {
    STYLE_PRESET_TEMP_TEXT,
    STYLE_PRESET_CLEANUP_ATTEMPTS,
    STYLE_PRESET_UNDO_ATTEMPTS,
    removeStylePresetTempText,
    styleShortErrorText,
    countTextStats,
    sliceSelectedText,
    stripStatusHeadEcho
  };

  init();
})();
