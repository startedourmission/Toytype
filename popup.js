// 오탈자 레이더 — 팝업
// settings 쓰기는 팝업만 한다(스펙 §3). content에는 typo:get / typo:rescan만 보낸다.
'use strict';

const DEFAULT_SETTINGS = {
  schemaVersion: 1,
  docsCategories:    { convert: true, spelling: true, plural: true,  honorific: true,  space1: true,  space2: true,  space3: true,  final: true  },
  genericCategories: { convert: true, spelling: true, plural: false, honorific: false, space1: false, space2: false, space3: false, final: false },
  disabledOrigins:   []
};

// rules.json 로드 실패 시 폴백 (정본은 typo:getCategories 응답)
const FALLBACK_CATEGORIES = [
  { id: 'convert',   label: '표기 변환',     ruleCount: 689  },
  { id: 'spelling',  label: '맞춤법',       ruleCount: 255  },
  { id: 'plural',    label: '존대와 복수',   ruleCount: 73   },
  { id: 'honorific', label: '높임말 서술어', ruleCount: 148  },
  { id: 'space1',    label: '조사 앞 공백',  ruleCount: 2317 },
  { id: 'space2',    label: '붙여쓰기',     ruleCount: 1980 },
  { id: 'space3',    label: '값 붙이기',    ruleCount: 1077 },
  { id: 'final',     label: '맨마지막',     ruleCount: 315  }
];

const CATEGORY_IDS = FALLBACK_CATEGORIES.map((c) => c.id);

const CAT_COLOR_CLASS = {
  convert: 'cat-red', spelling: 'cat-red', final: 'cat-red',
  plural: 'cat-purple', honorific: 'cat-purple',
  space1: 'cat-orange', space2: 'cat-orange', space3: 'cat-orange'
};

const $app = document.getElementById('app');
let tabId = null;
let categories = FALLBACK_CATEGORIES;

// ---------- 유틸 ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// 표시 규약(§1.4): 선두·후미 공백(U+0020)만 ␣로 치환, 내부 공백 유지. 빈 dst는 ∅(삭제).
function displayToken(s) {
  if (s === '') return '∅(삭제)';
  let i = 0;
  let j = s.length;
  while (i < j && s.charCodeAt(i) === 0x20) i++;
  while (j > i && s.charCodeAt(j - 1) === 0x20) j--;
  return '␣'.repeat(i) + s.slice(i, j) + '␣'.repeat(s.length - j);
}

function relTime(ts) {
  const d = Date.now() - ts;
  if (d < 10000) return '방금 전';
  if (d < 60000) return Math.floor(d / 1000) + '초 전';
  if (d < 3600000) return Math.floor(d / 60000) + '분 전';
  if (d < 86400000) return Math.floor(d / 3600000) + '시간 전';
  return new Date(ts).toLocaleDateString('ko-KR');
}

// 저장값은 부분일 수 있으므로 섹션별 머지. 모르는 카테고리 id는 무시.
function mergeCats(defaults, stored) {
  const out = Object.assign({}, defaults);
  if (stored && typeof stored === 'object') {
    for (const id of CATEGORY_IDS) {
      if (typeof stored[id] === 'boolean') out[id] = stored[id];
    }
  }
  return out;
}

async function readSettings() {
  let stored = {};
  try {
    stored = (await chrome.storage.local.get('settings')).settings || {};
  } catch (e) { /* 기본값 사용 */ }
  return {
    schemaVersion: 1,
    docsCategories: mergeCats(DEFAULT_SETTINGS.docsCategories, stored.docsCategories),
    genericCategories: mergeCats(DEFAULT_SETTINGS.genericCategories, stored.genericCategories),
    disabledOrigins: Array.isArray(stored.disabledOrigins)
      ? stored.disabledOrigins.filter((o) => typeof o === 'string')
      : []
  };
}

async function writeSettings(settings) {
  await chrome.storage.local.set({ settings: settings });
}

function sendToTab(msg) {
  return chrome.tabs.sendMessage(tabId, msg);
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

// ---------- 상태 화면 ----------

function renderUnsupported() {
  $app.textContent = '';
  const box = el('div', 'state-box');
  box.append(el('p', 'msg', '이 페이지에서는 검사할 수 없습니다.'));
  $app.append(box);
}

function renderMessage(text, withRetry) {
  $app.textContent = '';
  const box = el('div', 'state-box');
  box.append(el('p', 'msg', text));
  if (withRetry) {
    const btn = el('button', 'btn primary', '다시 검사');
    btn.addEventListener('click', () => { requestReport({ type: 'typo:rescan' }, 99); });
    box.append(btn);
  }
  $app.append(box);
}

// ---------- 보고서 요청 ----------

async function requestReport(msg, attempt) {
  let report;
  try {
    report = await sendToTab(msg);
  } catch (e) {
    renderUnsupported(); // 수신자 없음 (chrome:// 등)
    return;
  }
  if (!report) {
    renderUnsupported();
    return;
  }
  if (report.ok) {
    await renderReport(report);
    return;
  }
  if (report.error === 'not_ready') {
    if (attempt < 3) {
      renderMessage('검사 중…', false);
      setTimeout(() => { requestReport({ type: 'typo:get' }, attempt + 1); }, 700);
    } else {
      renderMessage('아직 검사 결과가 없습니다.', true);
    }
    return;
  }
  if (report.error === 'export_failed') {
    renderMessage('구글 독스 텍스트를 가져오지 못했습니다. 보기 권한과 로그인 상태를 확인하세요.', true);
    return;
  }
  renderMessage('검사 결과를 가져오지 못했습니다.', true);
}

// ---------- 설정 변경 (read-modify-write → rescan) ----------

async function onToggleCategory(catId, checked, context) {
  const settings = await readSettings();
  const key = context === 'docs' ? 'docsCategories' : 'genericCategories';
  settings[key][catId] = checked;
  await writeSettings(settings);
  await requestReport({ type: 'typo:rescan' }, 99);
}

async function setSiteDisabled(origin, disabled) {
  if (!origin) return;
  const settings = await readSettings();
  const set = new Set(settings.disabledOrigins);
  if (disabled) set.add(origin);
  else set.delete(origin);
  settings.disabledOrigins = Array.from(set);
  await writeSettings(settings);
  await requestReport({ type: 'typo:rescan' }, 99);
}

// ---------- 정상 화면 (상태 D) ----------

async function renderReport(report) {
  $app.textContent = '';

  if (report.disabled) {
    const box = el('div', 'state-box');
    box.append(el('p', 'msg', '이 사이트에서 꺼져 있습니다.'));
    const btn = el('button', 'btn primary', report.context === 'docs' ? '구글 독스에서 켜기' : '다시 켜기');
    btn.addEventListener('click', () => { setSiteDisabled(report.origin, false); });
    box.append(btn);
    $app.append(box);
    return;
  }

  const settings = await readSettings();
  const ctxCats = report.context === 'docs' ? settings.docsCategories : settings.genericCategories;
  const counts = report.categoryCounts || {};

  // 헤더
  const header = el('header', 'header');
  const countSpan = el('div', 'count' + (report.total > 0 ? ' has-findings' : ''), '오탈자 ' + report.total + '건');
  header.append(countSpan);
  const metaParts = [report.context === 'docs' ? '구글 독스' : '일반 페이지'];
  if (report.scannedAt) metaParts.push(relTime(report.scannedAt) + ' 검사');
  if (report.rulesVersion) metaParts.push('규칙 ' + report.rulesVersion);
  header.append(el('div', 'meta', metaParts.join(' · ')));
  $app.append(header);

  if (report.truncated) {
    $app.append(el('p', 'notice warn', '표시 한도(500건)를 초과했습니다. 일부만 표시됩니다.'));
  }
  if (report.cached) {
    $app.append(el('p', 'notice info', '10초 이내 재검사라 캐시된 텍스트 기준입니다.'));
  }

  // 카테고리 토글
  const sec = el('section', 'cats');
  sec.append(el('h2', 'sec-title', report.context === 'docs' ? '카테고리 (구글 독스)' : '카테고리 (일반 페이지)'));
  for (const cat of categories) {
    const row = el('label', 'cat-row');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = ctxCats[cat.id] !== false;
    cb.addEventListener('change', () => { onToggleCategory(cat.id, cb.checked, report.context); });
    row.append(cb);
    row.append(el('span', 'cat-label', cat.label));
    row.append(el('span', 'cat-count', '규칙 ' + cat.ruleCount));
    const found = counts[cat.id] || 0;
    row.append(el('span', 'cat-found' + (found > 0 ? '' : ' zero'), '발견 ' + found));
    sec.append(row);
  }
  $app.append(sec);

  // 발견 목록 (카테고리별 그룹, rules.json 순서)
  const findings = Array.isArray(report.findings) ? report.findings : [];
  if (findings.length === 0) {
    $app.append(el('div', 'empty', '발견된 오탈자가 없습니다.'));
  } else {
    const byCat = new Map();
    for (const f of findings) {
      if (!byCat.has(f.cat)) byCat.set(f.cat, []);
      byCat.get(f.cat).push(f);
    }
    const orderedIds = categories.map((c) => c.id);
    for (const id of byCat.keys()) {
      if (!orderedIds.includes(id)) orderedIds.push(id);
    }
    const list = el('div', 'findings');
    for (const catId of orderedIds) {
      const group = byCat.get(catId);
      if (!group || group.length === 0) continue;
      const details = document.createElement('details');
      details.open = true;
      const labelText = group[0].catLabel || catId;
      details.append(el('summary', null, labelText + ' (' + group.length + ')'));
      for (const f of group) {
        details.append(buildFindingItem(f, report.context));
      }
      list.append(details);
    }
    $app.append(list);
  }

  // 푸터
  const footer = el('footer', 'footer');
  const rescanBtn = el('button', 'btn primary', '다시 검사');
  rescanBtn.addEventListener('click', () => { requestReport({ type: 'typo:rescan' }, 99); });
  footer.append(rescanBtn);
  const disableBtn = el('button', 'btn ghost', report.context === 'docs' ? '구글 독스에서 끄기' : '이 사이트에서 끄기');
  disableBtn.addEventListener('click', () => { setSiteDisabled(report.origin, true); });
  footer.append(disableBtn);
  $app.append(footer);
}

function buildFindingItem(f, context) {
  const item = el('div', 'finding ' + (CAT_COLOR_CLASS[f.cat] || 'cat-red'));

  // 1행: …{before} [src] {after}…
  const line1 = el('div', 'snippet');
  if (f.before) line1.append(document.createTextNode('…' + f.before));
  line1.append(el('mark', 'src-mark', displayToken(f.src)));
  if (f.after) line1.append(document.createTextNode(f.after + '…'));
  item.append(line1);

  // 2행: {src} → {dst} + 칩 + ¶line
  const line2 = el('div', 'fix');
  line2.append(el('span', 'pair', displayToken(f.src) + ' → ' + displayToken(f.dst)));
  line2.append(el('span', 'chip', f.catLabel || f.cat));
  if (context === 'docs' && f.line != null) {
    line2.append(el('span', 'line', '¶' + f.line));
  }
  item.append(line2);

  // 클릭 → 교정어 복사
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

// ---------- 시작 ----------

async function init() {
  let tab = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs && tabs[0];
  } catch (e) { /* 아래에서 처리 */ }
  if (!tab || typeof tab.id !== 'number') {
    renderUnsupported();
    return;
  }
  tabId = tab.id;

  try {
    const res = await chrome.runtime.sendMessage({ type: 'typo:getCategories' });
    if (res && res.ok && Array.isArray(res.categories) && res.categories.length > 0) {
      categories = res.categories;
    }
  } catch (e) { /* 폴백 라벨 사용 */ }

  await requestReport({ type: 'typo:get' }, 0);
}

init();
