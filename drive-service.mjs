// 토인비 편집 — 드라이브 버블용 백그라운드 서비스
// 드라이브 페이지(drive.google.com)에서 docs.google.com export로 바로 요청하면 CORS에 막히므로
// 서비스워커가 로그인 쿠키로 대신 받는다. 큰 docx는 메시지 한도(64MB)를 넘지 않게 조각으로 넘긴다.
import './content/doc-tools.js';

const EXPORT_TIMEOUT_MS = 120000;
const CHUNK_BYTES = 4 * 1024 * 1024;
const BLOB_TTL_MS = 5 * 60 * 1000;
const PAGE_CACHE_KEY = 'drivePageCache';
const PAGE_CACHE_MAX = 400;
const PAGE_CONCURRENCY = 2;

const blobs = new Map(); // token → { bytes, expires }
const pendingJumps = new Map(); // docId → 찾아갈 지적
const pageInflight = new Map(); // cacheKey → Promise
let pageRunning = 0;
const pageWaiters = [];

// tab: 문서 탭 하나만 내보낼 때(예: 't.0' = 첫 탭). 없으면 모든 탭을 이어 붙인다.
export function docsExportUrl(docId, format, authuser, tab) {
  const account = Number.isInteger(authuser) && authuser > 0 ? 'u/' + authuser + '/' : '';
  return 'https://docs.google.com/document/' + account + 'd/' + encodeURIComponent(docId) +
    '/export?format=' + encodeURIComponent(format) + (tab ? '&tab=' + encodeURIComponent(tab) : '');
}

// 쪽수 범위: 'all'(모든 탭) | 'tab1'(첫 탭만). 캐시는 범위마다 따로 둔다.
export function pageCacheKey(docId, scope) {
  return scope === 'tab1' ? docId + '#t.0' : docId;
}

function validDocId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{20,120}$/.test(id);
}

async function fetchExport(docId, format, authuser, tab) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), EXPORT_TIMEOUT_MS);
  try {
    const res = await fetch(docsExportUrl(docId, format, authuser, tab), { credentials: 'include', signal: ctrl.signal });
    if (!res.ok) throw new Error('export http ' + res.status);
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    // 로그인 화면으로 넘어가면 200 + HTML이 온다 — 권한 없음으로 본다
    if (ct.includes('text/html')) throw new Error('no_access');
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function exportText(docId, format, authuser) {
  const res = await fetchExport(docId, format, authuser);
  const text = await res.text();
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r/g, '');
}

// ---------- 쪽수 ----------
// 구글 문서는 쪽 나눔이 레이아웃을 그려야 정해져서 PDF export 말고는 정확한 값을 얻을 곳이 없다.
// 그래서 (문서 ID, 썸네일 버전)으로 결과를 저장해 두고, 같은 버전이면 바로 돌려준다.
async function readPageCache() {
  const items = await chrome.storage.local.get(PAGE_CACHE_KEY);
  const v = items && items[PAGE_CACHE_KEY];
  return v && typeof v === 'object' ? v : {};
}

async function writePageCache(docId, entry) {
  const cache = await readPageCache();
  cache[docId] = entry;
  const ids = Object.keys(cache);
  if (ids.length > PAGE_CACHE_MAX) {
    ids.sort((a, b) => (cache[a].at || 0) - (cache[b].at || 0));
    for (const id of ids.slice(0, ids.length - PAGE_CACHE_MAX)) delete cache[id];
  }
  await chrome.storage.local.set({ [PAGE_CACHE_KEY]: cache });
}

function withPageSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      pageRunning++;
      fn().then(resolve, reject).finally(() => {
        pageRunning--;
        const next = pageWaiters.shift();
        if (next) next();
      });
    };
    if (pageRunning < PAGE_CONCURRENCY) run();
    else pageWaiters.push(run);
  });
}

// 캐시만 본다(즉시). 버전이 다르면 stale로 알려 준다.
// 편집기에서 잰 값은 썸네일 버전을 모르므로, 드라이브가 처음 볼 때의 버전을 붙여 확정한다.
export async function cachedPageCounts(files, scope) {
  const cache = await readPageCache();
  const out = {};
  let adopted = false;
  for (const f of files || []) {
    const hit = f && cache[pageCacheKey(f.id, scope)];
    if (!hit) continue;
    // 예전 버전은 편집기 값(열린 탭만)을 전체 쪽수 자리에 저장했다 — 전체 범위에서는 믿지 않는다
    if (scope !== 'tab1' && hit.source === 'editor') continue;
    if (hit.source === 'editor' && !hit.version && f.version) {
      hit.version = f.version;
      adopted = true;
    }
    out[f.id] = { pages: hit.pages, stale: !!(f.version && hit.version !== f.version), at: hit.at, source: hit.source || 'pdf' };
  }
  if (adopted) await chrome.storage.local.set({ [PAGE_CACHE_KEY]: cache });
  return out;
}

// 문서 편집기가 화면 배치로 센 쪽수를 기록한다(추가 요청 없는 정확값).
// 편집기는 지금 열린 탭만 그리므로 첫 탭(t.0)을 보고 있을 때의 값만 '첫 탭' 쪽수로 남긴다.
export async function recordEditorPages(docId, pagesN, tab) {
  const n = Math.round(Number(pagesN));
  if (!(n >= 1 && n <= 100000)) return false;
  if (tab && tab !== 't.0') return false;
  const key = pageCacheKey(docId, 'tab1');
  const cache = await readPageCache();
  const prev = cache[key];
  if (prev && prev.pages === n && prev.source === 'editor') return true;
  await writePageCache(key, { pages: n, version: '', at: Date.now(), source: 'editor' });
  return true;
}

export function countPages(docId, version, authuser, scope) {
  const key = pageCacheKey(docId, scope) + '@' + (version || '');
  if (pageInflight.has(key)) return pageInflight.get(key);
  const job = withPageSlot(async () => {
    const res = await fetchExport(docId, 'pdf', authuser, scope === 'tab1' ? 't.0' : '');
    const pages = globalThis.ToytypeDocTools.countPdfPages(new Uint8Array(await res.arrayBuffer()));
    if (!pages) throw new Error('pdf_parse_failed');
    const entry = { pages, version: version || '', at: Date.now(), source: 'pdf' };
    await writePageCache(pageCacheKey(docId, scope), entry);
    return entry;
  }).finally(() => pageInflight.delete(key));
  pageInflight.set(key, job);
  return job;
}

// ---------- 큰 바이너리(docx) 조각 전달 ----------
function sweepBlobs() {
  const now = Date.now();
  for (const [token, b] of blobs) if (b.expires < now) blobs.delete(token);
}

async function exportBinary(docId, format, authuser) {
  sweepBlobs();
  const res = await fetchExport(docId, format, authuser);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const token = crypto.randomUUID();
  blobs.set(token, { bytes, expires: Date.now() + BLOB_TTL_MS });
  return { token, size: bytes.length };
}

function readChunk(token, offset) {
  const b = blobs.get(token);
  if (!b) return { ok: false, error: 'expired' };
  const start = Math.max(0, Number(offset) || 0);
  const part = b.bytes.subarray(start, start + CHUNK_BYTES);
  let bin = '';
  for (let i = 0; i < part.length; i += 8192) bin += String.fromCharCode.apply(null, part.subarray(i, i + 8192));
  const end = start + part.length;
  if (end >= b.bytes.length) blobs.delete(token);
  return { ok: true, base64: btoa(bin), end, done: end >= b.bytes.length };
}

// ---------- 문서 열기 ----------
// 팝업 창은 쓰지 않는다. 요청한 탭 바로 옆에 일반 탭으로 연다.
async function openDocTab(docId, authuser, target, sender) {
  if (target) pendingJumps.set(docId, Object.assign({}, target, { at: Date.now() }));
  const account = Number.isInteger(authuser) && authuser > 0 ? 'u/' + authuser + '/' : '';
  const url = 'https://docs.google.com/document/' + account + 'd/' + encodeURIComponent(docId) + '/edit';
  const opts = { url, active: true };
  const tab = sender && sender.tab;
  if (tab && Number.isInteger(tab.index)) {
    opts.index = tab.index + 1;
    opts.windowId = tab.windowId;
    opts.openerTabId = tab.id;
  }
  const created = await chrome.tabs.create(opts);
  return { ok: true, tabId: created && created.id };
}

// 격자 보기: 고른 문서 목록을 session 저장소에 두고 확장 페이지를 드라이브 탭 옆에 연다.
const GRID_MAX_DOCS = 12;
async function openGridTab(docs, authuser, sender) {
  const list = (Array.isArray(docs) ? docs : [])
    .filter(d => d && validDocId(d.id))
    .slice(0, GRID_MAX_DOCS)
    .map(d => ({ id: d.id, name: String(d.name || '').slice(0, 200), version: String(d.version || '') }));
  if (!list.length) return { ok: false, error: 'no_docs' };
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ ['grid:' + id]: { docs: list, authuser, createdAt: Date.now() } });
  const opts = { url: chrome.runtime.getURL('grid.html#' + id), active: true };
  const tab = sender && sender.tab;
  if (tab && Number.isInteger(tab.index)) {
    opts.index = tab.index + 1;
    opts.windowId = tab.windowId;
    opts.openerTabId = tab.id;
  }
  await chrome.tabs.create(opts);
  return { ok: true, count: list.length, sessionId: id };
}

export function takePendingJump(docId) {
  const jump = pendingJumps.get(docId);
  pendingJumps.delete(docId);
  if (!jump || Date.now() - jump.at > 2 * 60 * 1000) return null;
  return jump;
}

// 메시지 라우터. 처리하지 않는 메시지면 undefined.
export function handleDriveMessage(msg, sendResponse, sender) {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('typo:drive')) return undefined;
  const fail = error => {
    console.warn('[Toytype drive]', msg.type, error);
    sendResponse({ ok: false, error: error && error.message ? error.message : String(error) });
  };
  const authuser = Number.isInteger(msg.authuser) ? msg.authuser : 0;
  if (msg.type === 'typo:driveTakeJump') {
    sendResponse({ ok: true, target: validDocId(msg.docId) ? takePendingJump(msg.docId) : null });
    return undefined;
  }
  if (msg.type === 'typo:driveChunk') {
    sendResponse(readChunk(String(msg.token || ''), msg.offset));
    return undefined;
  }
  if (msg.type === 'typo:drivePagesCached') {
    const files = (Array.isArray(msg.files) ? msg.files : []).filter(f => f && validDocId(f.id));
    cachedPageCounts(files, msg.scope === 'tab1' ? 'tab1' : 'all').then(pages => sendResponse({ ok: true, pages }), fail);
    return true;
  }
  if (msg.type === 'typo:driveOpenGrid') {
    openGridTab(msg.docs, authuser, sender).then(sendResponse, fail);
    return true;
  }
  if (!validDocId(msg.docId)) {
    sendResponse({ ok: false, error: 'bad_doc_id' });
    return undefined;
  }
  if (msg.type === 'typo:driveRecordPages') {
    recordEditorPages(msg.docId, msg.pages, String(msg.tab || '')).then(ok => sendResponse({ ok }), fail);
    return true;
  }
  if (msg.type === 'typo:drivePages') {
    countPages(msg.docId, String(msg.version || ''), authuser, msg.scope === 'tab1' ? 'tab1' : 'all').then(entry => sendResponse({ ok: true, pages: entry.pages, at: entry.at }), fail);
    return true;
  }
  if (msg.type === 'typo:driveExportText') {
    const format = msg.format === 'md' ? 'md' : 'txt';
    exportText(msg.docId, format, authuser).then(text => sendResponse({ ok: true, text }), fail);
    return true;
  }
  if (msg.type === 'typo:driveExportBinary') {
    exportBinary(msg.docId, 'docx', authuser).then(r => sendResponse(Object.assign({ ok: true }, r)), fail);
    return true;
  }
  if (msg.type === 'typo:driveOpenDoc') {
    openDocTab(msg.docId, authuser, msg.target || null, sender).then(sendResponse, fail);
    return true;
  }
  sendResponse({ ok: false, error: 'unknown_drive_message' });
  return undefined;
}
