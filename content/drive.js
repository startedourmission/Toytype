// 토인비 편집 — 구글 드라이브 버블 (독스 패널 버블과 같은 우하단 원형)
// 드라이브에서 고른 구글 문서의 쪽수를 바로 보여 주고, 여러 문서를 한 번에 교정·이미지 추출·목차 추출한다.
// 문서 본문은 백그라운드가 export로 받아 오고(드라이브 페이지에서 docs.google.com으로 직접 요청하면 막힌다),
// 교정은 내장 규칙 엔진으로 이 페이지 안에서 돌린다. 문서를 수정하지 않는다.
'use strict';

(() => {
  if (window.top !== window) return;
  if (globalThis.__toytypeDriveLoaded) return;
  globalThis.__toytypeDriveLoaded = true;

  const DocTools = globalThis.ToytypeDocTools;
  const SELECT_DEBOUNCE_MS = 180;
  const PREFETCH_MAX = 12;
  const SNIPPET = 18;
  const CONTEXT = 24;
  const FINDINGS_PER_DOC = 300;

  let host = null;
  let root = null;
  let view = null;
  let expanded = false;
  let selection = []; // [{ id, name, version }]
  let pages = {}; // id → { pages, stale, loading, error }
  let status = '';
  let statusError = false;
  let busy = '';
  let results = null; // { docs: [{ id, name, findings, total, truncated, error, open }] }
  let rules = null;
  let rulesKey = '';
  let settings = null;
  let selectTimer = null;
  let prefetchTimer = null;
  const prefetched = new Set();
  // 쪽수 범위: 체크하면 문서의 첫 탭만 센다(여러 탭 문서에서 부록·메모 탭을 빼고 싶을 때)
  const FIRST_TAB_KEY = 'drivePagesFirstTab';
  let firstTabOnly = false;
  const pageScope = () => (firstTabOnly ? 'tab1' : 'all'); // id@version — 화면에 보인 문서는 버전마다 한 번만 미리 센다

  // ---------- 드라이브 화면 읽기 ----------

  function authuser() {
    const m = location.pathname.match(/\/u\/(\d+)\//);
    return m ? Number(m[1]) : 0;
  }

  // 바둑판 보기는 셀 자체에, 목록 보기는 행 안 이름 칸의 툴팁에 "문서명 Google Docs"가 있다
  const DOCS_KIND_RE = /\s+Google (?:Docs|문서)(?:\s|$)/;

  function cellLabel(cell) {
    const own = cell.getAttribute('aria-label') || '';
    if (DOCS_KIND_RE.test(own)) return own;
    const tip = Array.from(cell.querySelectorAll('[data-tooltip]'))
      .map(n => n.getAttribute('data-tooltip') || '')
      .find(t => DOCS_KIND_RE.test(t));
    return tip || own;
  }

  function isDocsCell(cell) {
    return DOCS_KIND_RE.test(cellLabel(cell));
  }

  function cellInfo(cell) {
    const label = cellLabel(cell);
    const name = label.split(DOCS_KIND_RE)[0].trim() || label;
    // 바둑판 보기 썸네일 주소의 ivNNN = 드라이브 thumbnailVersion (목록 보기에는 없다)
    const img = cell.querySelector('img[src*="drive-usercontent"], img[src*="googleusercontent"]');
    const m = img && img.src.match(/-iv(\d+)/);
    return { id: cell.dataset.id, name, version: m ? 'iv' + m[1] : '' };
  }

  function allDocCells() {
    return Array.from(document.querySelectorAll('[data-selectable][data-id]')).filter(isDocsCell);
  }

  function readSelection() {
    const seen = new Set();
    const out = [];
    for (const cell of allDocCells()) {
      if (cell.getAttribute('aria-selected') !== 'true' || seen.has(cell.dataset.id)) continue;
      seen.add(cell.dataset.id);
      out.push(cellInfo(cell));
    }
    return out;
  }

  function visibleDocs() {
    const h = window.innerHeight;
    const out = [];
    const seen = new Set();
    for (const cell of allDocCells()) {
      if (seen.has(cell.dataset.id)) continue;
      const r = cell.getBoundingClientRect();
      if (r.bottom < 0 || r.top > h || !r.width) continue;
      seen.add(cell.dataset.id);
      out.push(cellInfo(cell));
      if (out.length >= PREFETCH_MAX) break;
    }
    return out;
  }

  // ---------- 백그라운드 메시지 ----------

  // 확장을 다시 불러오면(업데이트·개발 중 새로고침) 이미 열린 탭의 버블은 확장과 끊긴다
  function contextLost(error) {
    return /context invalidated|Receiving end does not exist/i.test(String(error || '')) || !chrome.runtime || !chrome.runtime.id;
  }

  function send(msg) {
    return new Promise(resolve => {
      if (contextLost('')) {
        setStatus('토인비 편집이 업데이트됐습니다 · 이 탭을 새로고침(⌘R)해 주세요', true);
        resolve({ ok: false, error: 'context_lost' });
        return;
      }
      try {
        chrome.runtime.sendMessage(msg, res => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(res || { ok: false, error: 'no_response' });
        });
      } catch (e) {
        const message = e && e.message ? e.message : String(e);
        if (contextLost(message)) setStatus('토인비 편집이 업데이트됐습니다 · 이 탭을 새로고침(⌘R)해 주세요', true);
        resolve({ ok: false, error: message });
      }
    });
  }

  async function exportText(docId, format) {
    const res = await send({ type: 'typo:driveExportText', docId, format, authuser: authuser() });
    if (!res.ok) throw new Error(exportErrorText(res.error));
    return res.text;
  }

  async function exportDocx(docId) {
    const head = await send({ type: 'typo:driveExportBinary', docId, authuser: authuser() });
    if (!head.ok) throw new Error(exportErrorText(head.error));
    const bytes = new Uint8Array(head.size);
    let offset = 0;
    while (offset < head.size) {
      const part = await send({ type: 'typo:driveChunk', token: head.token, offset });
      if (!part.ok) throw new Error('파일을 받는 중 끊겼습니다');
      const bin = atob(part.base64);
      for (let i = 0; i < bin.length; i++) bytes[offset + i] = bin.charCodeAt(i);
      offset = part.end;
      if (part.done) break;
    }
    return bytes.buffer;
  }

  function exportErrorText(error) {
    const e = String(error || '');
    if (e === 'no_access' || /http 40[13]/.test(e)) return '열람 권한이 없습니다';
    if (/http 404/.test(e)) return '문서를 찾지 못했습니다';
    if (/abort/i.test(e)) return '시간이 너무 오래 걸립니다';
    return '내려받기 실패';
  }

  // ---------- 쪽수 ----------

  async function refreshPages(files, opts) {
    if (!files.length) return;
    const scope = pageScope();
    const cached = await send({ type: 'typo:drivePagesCached', files, scope });
    if (scope !== pageScope()) return; // 그사이 범위를 바꿨다
    const hits = cached.ok ? cached.pages : {};
    for (const f of files) {
      const hit = hits[f.id];
      if (hit) pages[f.id] = { pages: hit.pages, stale: hit.stale };
    }
    render();
    // 캐시에 없거나 버전이 바뀐 문서만 다시 센다(백그라운드가 동시에 2개씩)
    const need = files.filter(f => !hits[f.id] || hits[f.id].stale || (opts && opts.force));
    for (const f of need) {
      pages[f.id] = Object.assign({}, pages[f.id], { loading: true, error: '' });
      send({ type: 'typo:drivePages', docId: f.id, version: f.version, authuser: authuser(), scope }).then(res => {
        if (scope !== pageScope()) return;
        pages[f.id] = res.ok ? { pages: res.pages } : Object.assign({}, pages[f.id], { loading: false, error: exportErrorText(res.error) });
        render();
      });
    }
    if (need.length) render();
  }

  function schedulePrefetch() {
    clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(() => {
      const tag = f => f.id + '@' + f.version + '@' + pageScope();
      const docs = visibleDocs().filter(f => !prefetched.has(tag(f)));
      docs.forEach(f => prefetched.add(tag(f)));
      if (docs.length) refreshPages(docs);
    }, 1200);
  }

  function setFirstTabOnly(on) {
    firstTabOnly = !!on;
    try { chrome.storage.local.set({ [FIRST_TAB_KEY]: firstTabOnly }); } catch (_) { /* 이번 탭에서만 */ }
    pages = {};
    render();
    refreshPages(selection);
    schedulePrefetch();
  }

  function onSelectionMaybeChanged() {
    clearTimeout(selectTimer);
    selectTimer = setTimeout(() => {
      const next = readSelection();
      const key = next.map(f => f.id).join(',');
      if (key === selection.map(f => f.id).join(',')) return;
      selection = next;
      refreshPages(selection);
      render();
    }, SELECT_DEBOUNCE_MS);
  }

  // 센 문서까지의 합계. missing은 아직 쪽수를 모르는 문서 수(세는 중이거나 실패).
  function pageSum(files) {
    let sum = 0;
    let missing = 0;
    for (const f of files) {
      const p = pages[f.id];
      if (p && p.pages) sum += p.pages;
      else missing++;
    }
    return { sum, missing };
  }

  function pageSumText(files) {
    const { sum, missing } = pageSum(files);
    if (!sum) return '';
    return sum.toLocaleString() + '쪽' + (missing ? '+' : '');
  }

  // ---------- 규칙 엔진 ----------

  async function ensureEngine() {
    if (!rules) {
      const res = await send({ type: 'typo:getRules' });
      if (!res.ok || !res.rules) throw new Error('검사 규칙을 불러오지 못했습니다');
      rules = res.rules;
    }
    const stored = await new Promise(resolve => {
      try { chrome.storage.local.get('settings', items => resolve(items && items.settings || {})); } catch (_) { resolve({}); }
    });
    settings = stored;
    const enabledMap = settings.docsCategories || {};
    const enabled = rules.categories.map(c => c.id).filter(id => enabledMap[id] !== false);
    const key = enabled.join(',');
    if (key !== rulesKey) {
      globalThis.TypoEngine.init(rules, enabled);
      rulesKey = key;
    }
  }

  function labelOf(catId) {
    const cat = rules && rules.categories.find(c => c.id === catId);
    return cat && cat.label ? cat.label : catId;
  }

  function oneLine(s) {
    return String(s || '').replace(/[\u0000-\u0008\u000e-\u001f]/g, '').replace(/\s+/g, ' ');
  }

  function scanText(text) {
    const result = globalThis.TypoEngine.scan(text, { limit: FINDINGS_PER_DOC });
    return {
      truncated: !!result.truncated,
      findings: result.findings.map(f => ({
        src: f.src,
        dst: f.dst,
        cat: f.cat,
        start: f.start,
        before: oneLine(text.slice(Math.max(0, f.start - SNIPPET), f.start)),
        after: oneLine(text.slice(f.end, f.end + SNIPPET)),
        contextBefore: text.slice(Math.max(0, f.start - CONTEXT), f.start),
        contextAfter: text.slice(f.end, f.end + CONTEXT)
      }))
    };
  }

  // ---------- 동작 ----------

  async function runBusy(name, fn) {
    if (busy) return;
    busy = name;
    setStatus('');
    render();
    try {
      await fn();
    } catch (error) {
      setStatus(error && error.message ? error.message : String(error), true);
    } finally {
      busy = '';
      render();
    }
  }

  function setStatus(text, error) {
    status = text || '';
    statusError = !!error;
    render();
  }

  function needSelection() {
    if (selection.length) return true;
    setStatus('드라이브에서 구글 문서를 하나 이상 선택하세요', true);
    return false;
  }

  function proofreadAll() {
    if (!needSelection()) return;
    const files = selection.slice();
    runBusy('proofread', async () => {
      await ensureEngine();
      results = { docs: files.map(f => ({ id: f.id, name: f.name, findings: [], total: 0, loading: true, open: files.length === 1 })) };
      render();
      let i = 0;
      // 문서 3개씩 동시에 받아 검사한다
      const worker = async () => {
        while (i < files.length) {
          const doc = results.docs[i++];
          try {
            const text = await exportText(doc.id, 'txt');
            const scanned = scanText(text);
            doc.findings = scanned.findings;
            doc.total = scanned.findings.length;
            doc.truncated = scanned.truncated;
          } catch (error) {
            doc.error = error.message;
          }
          doc.loading = false;
          setStatus('전체 교정 중 · ' + results.docs.filter(d => !d.loading).length + '/' + files.length);
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      const total = results.docs.reduce((n, d) => n + d.total, 0);
      const failed = results.docs.filter(d => d.error).length;
      setStatus('전체 교정 완료 · 문서 ' + files.length + '개 · 지적 ' + total + '건' + (failed ? ' · 실패 ' + failed + '개' : ''), failed > 0);
    });
  }

  function extractImages() {
    if (!needSelection()) return;
    const files = selection.slice();
    const Hwpx = globalThis.ToytypeHwpxExport;
    runBusy('images', async () => {
      const zipFiles = [];
      const failed = [];
      let skipped = 0;
      for (let k = 0; k < files.length; k++) {
        const f = files[k];
        setStatus('이미지 추출 중 · ' + (k + 1) + '/' + files.length + ' · ' + f.name);
        try {
          const buffer = await exportDocx(f.id);
          const got = await Hwpx.extractImageFilesFromDocx(buffer);
          skipped += got.skippedImageCount || 0;
          // 문서가 여럿이면 문서 이름 폴더로 나눈다
          const folder = files.length > 1 ? Hwpx.safeFileName(f.name) + '/' : '';
          for (const img of got.files) zipFiles.push({ name: folder + img.name, data: img.data });
        } catch (error) {
          failed.push(f.name);
        }
      }
      if (!zipFiles.length) {
        setStatus(failed.length ? '이미지 추출 실패 · ' + failed.join(', ') : '선택한 문서에 이미지가 없습니다', !!failed.length);
        return;
      }
      const name = files.length === 1 ? files[0].name + '-이미지.zip' : '토인비-이미지-' + files.length + '개문서.zip';
      Hwpx.downloadBytes(Hwpx.safeFileName(name), Hwpx.createStoredZip(zipFiles), 'application/zip');
      let msg = '이미지 ' + zipFiles.length + '개 ZIP 다운로드';
      if (skipped) msg += ' · 빈 이미지 제외 ' + skipped + '개';
      if (failed.length) msg += ' · 실패: ' + failed.join(', ');
      setStatus(msg, failed.length > 0);
    });
  }

  function extractToc() {
    if (!needSelection()) return;
    const files = selection.slice();
    runBusy('toc', async () => {
      const stored = await new Promise(resolve => {
        try { chrome.storage.local.get('settings', items => resolve(items && items.settings || {})); } catch (_) { resolve({}); }
      });
      const maxLevel = stored.tocMaxLevel || 4;
      const parts = [];
      const failed = [];
      let headings = 0;
      for (let k = 0; k < files.length; k++) {
        const f = files[k];
        setStatus('목차 추출 중 · ' + (k + 1) + '/' + files.length);
        try {
          const md = await exportText(f.id, 'md');
          const toc = DocTools.filterTocLevel(DocTools.parseMarkdownExportHeadings(md), maxLevel);
          headings += toc.headings.length;
          parts.push(files.length > 1 && !toc.headings.length ? f.name + '\n목차를 찾지 못했습니다.' : DocTools.formatExtractedToc(f.name, toc));
        } catch (error) {
          failed.push(f.name);
        }
      }
      const text = parts.join('\n\n');
      if (!text) {
        setStatus('목차 추출 실패 · ' + failed.join(', '), true);
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        setStatus('목차 ' + headings + '개를 클립보드에 복사했습니다' + (failed.length ? ' · 실패: ' + failed.join(', ') : ''), failed.length > 0);
      } catch (_) {
        // 창이 포커스를 잃어 복사가 막히면 파일로 내려준다
        const name = files.length === 1 ? files[0].name + '-목차.txt' : '토인비-목차-' + files.length + '개문서.txt';
        globalThis.ToytypeHwpxExport.downloadBytes(globalThis.ToytypeHwpxExport.safeFileName(name), new TextEncoder().encode(text), 'text/plain');
        setStatus('클립보드 복사가 막혀 목차를 파일로 내려받았습니다');
      }
    });
  }

  function openDoc(docId, target) {
    send({ type: 'typo:driveOpenDoc', docId, authuser: authuser(), target: target || null }).then(res => {
      if (!res.ok) setStatus('문서를 열지 못했습니다', true);
    });
  }

  // 고른 문서들을 새 탭의 격자 보기로 연다(팝업 창은 쓰지 않는다)
  function openGrid() {
    if (!needSelection()) return;
    send({ type: 'typo:driveOpenGrid', docs: selection.slice(0, 12), authuser: authuser() }).then(res => {
      if (res.error === 'context_lost') return;
      if (!res.ok) setStatus('격자 보기를 열지 못했습니다 · ' + (res.error || ''), true);
      else if (selection.length > 12) setStatus('앞 12개 문서만 격자에 넣었습니다');
    });
  }

  // ---------- 화면 ----------

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function button(label, title, onClick, opts) {
    const b = el('button', 'tb-btn' + (opts && opts.primary ? ' tb-primary' : ''), label);
    b.type = 'button';
    if (title) b.title = title;
    b.disabled = !!(opts && opts.disabled);
    b.addEventListener('click', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      onClick();
    });
    return b;
  }

  function pagesText(id) {
    const p = pages[id];
    if (!p) return '';
    if (p.pages && (p.loading || p.stale)) return p.pages + '쪽…';
    if (p.pages) return p.pages + '쪽';
    if (p.error) return p.error;
    if (p.loading) return '세는 중…';
    return '';
  }

  function bubbleText() {
    if (!selection.length) return '';
    if (selection.length === 1) return pagesText(selection[0].id) || '…';
    const text = pageSumText(selection);
    return selection.length + '개' + (text ? ' · 합계 ' + text : '');
  }

  // 독스 패널 버블과 같은 44px 원. 선택한 문서의 쪽수(여럿이면 합계)를 숫자로 보여 준다.
  function buildBubble() {
    const b = el('div', 'tb-bubble');
    b.setAttribute('role', 'button');
    const { sum, missing } = pageSum(selection);
    const loading = selection.some(f => pages[f.id] && pages[f.id].loading);
    if (!selection.length) {
      b.textContent = '…';
      b.classList.add('tb-idle');
      b.title = '토인비 편집 — 구글 문서를 클릭하면 쪽수가 나옵니다';
    } else if (sum) {
      // 여럿을 고르면 합계. 아직 세는 문서가 있으면 연한 색으로 둔다
      b.appendChild(el('span', 'tb-bubble-num' + (sum > 999 ? ' tb-small' : ''), String(sum) + (missing ? '+' : '')));
      b.classList.add(loading || missing || selection.some(f => pages[f.id] && pages[f.id].stale) ? 'tb-pending' : 'tb-ready');
      b.title = bubbleText();
    } else {
      b.textContent = '…';
      b.classList.add('tb-idle');
      b.title = '쪽수를 세는 중입니다';
    }
    b.addEventListener('click', () => {
      expanded = true;
      render();
    });
    return b;
  }

  function buildPanel() {
    const panel = el('div', 'tb-panel');
    const head = el('div', 'tb-head');
    head.appendChild(el('div', 'tb-title', '토인비 편집 · 드라이브'));
    head.appendChild(button('✕', '접기', () => { expanded = false; render(); }, {}));
    panel.appendChild(head);

    const body = el('div', 'tb-body');
    const sel = el('div', 'tb-section');
    if (!selection.length) {
      sel.appendChild(el('div', 'tb-empty', '구글 문서를 클릭하면 쪽수가 바로 나옵니다. ⌘/Shift로 여러 개 고르면 한 번에 처리합니다.'));
    } else {
      sel.appendChild(el('div', 'tb-label', '선택한 문서 ' + selection.length + '개'));
      for (const f of selection) {
        const row = el('div', 'tb-file');
        const name = el('span', 'tb-file-name', f.name);
        name.title = f.name;
        const p = pages[f.id];
        const pg = el('span', 'tb-file-pages' + (p && (p.stale || p.loading) ? ' tb-dim' : '') + (p && p.error ? ' tb-err' : ''), pagesText(f.id));
        row.append(name, pg, button('열기', '문서를 새 탭으로 엽니다', () => openDoc(f.id), {}));
        sel.appendChild(row);
      }
      // 여럿이면 목록 아래에 쪽수 합계(아직 세는 문서가 있으면 +)
      const total = selection.length > 1 ? pageSumText(selection) : '';
      if (total) {
        const row = el('div', 'tb-file tb-total');
        row.append(el('span', 'tb-file-name', '합계'), el('span', 'tb-file-pages', total));
        sel.appendChild(row);
      }
    }
    const scopeRow = el('label', 'tb-scope');
    const scopeBox = el('input');
    scopeBox.type = 'checkbox';
    scopeBox.checked = firstTabOnly;
    scopeBox.addEventListener('change', () => setFirstTabOnly(scopeBox.checked));
    scopeRow.append(scopeBox, document.createTextNode(' 탭 1만 계산'));
    scopeRow.title = '여러 탭이 있는 문서에서 첫 탭의 쪽수만 셉니다';
    sel.appendChild(scopeRow);
    body.appendChild(sel);

    const actions = el('div', 'tb-actions');
    const none = !selection.length || !!busy;
    actions.append(
      button(busy === 'proofread' ? '교정 중…' : '전체 교정', '내장 규칙으로 선택한 문서를 모두 검사합니다', proofreadAll, { primary: true, disabled: none }),
      button(busy === 'images' ? '추출 중…' : '이미지 추출', '선택한 문서의 이미지를 ZIP 하나로 받습니다', extractImages, { disabled: none }),
      button(busy === 'toc' ? '추출 중…' : '목차 추출', '선택한 문서의 목차를 이어 붙여 복사합니다', extractToc, { disabled: none }),
      button('격자 보기', '선택한 문서를 새 탭에 3열 격자로 띄우고 교정 진행을 보여 줍니다', openGrid, { disabled: none }),
      button('쪽수 다시 세기', '캐시를 무시하고 PDF로 다시 셉니다', () => refreshPages(selection, { force: true }), { disabled: !selection.length })
    );
    body.appendChild(actions);

    if (results) body.appendChild(buildResults());
    panel.appendChild(body);

    if (status) panel.appendChild(el('div', 'tb-status' + (statusError ? ' tb-err' : ''), status));
    return panel;
  }

  function buildResults() {
    const wrap = el('div', 'tb-results');
    for (const doc of results.docs) {
      const group = el('div', 'tb-group');
      const gh = el('div', 'tb-group-head');
      const meta = doc.loading ? '검사 중…' : doc.error ? doc.error : doc.total + '건' + (doc.truncated ? '+' : '');
      gh.append(el('span', 'tb-group-caret', doc.open ? '▾' : '▸'), el('span', 'tb-group-name', doc.name), el('span', 'tb-group-meta' + (doc.error ? ' tb-err' : ''), meta));
      gh.addEventListener('click', () => { doc.open = !doc.open; render(); });
      group.appendChild(gh);
      if (doc.open && !doc.loading && !doc.error) {
        if (!doc.findings.length) group.appendChild(el('div', 'tb-empty', '발견된 오탈자가 없습니다.'));
        for (const f of doc.findings) {
          const item = el('div', 'tb-item');
          const ctx = el('div', 'tb-ctx');
          if (f.before) ctx.appendChild(document.createTextNode('…' + f.before));
          ctx.appendChild(el('b', 'tb-hit', f.src));
          if (f.after) ctx.appendChild(document.createTextNode(f.after + '…'));
          const fix = el('div', 'tb-fix', '➝ ' + f.dst);
          fix.appendChild(el('span', 'tb-cat', labelOf(f.cat)));
          item.append(ctx, fix);
          item.title = '문서를 새 탭으로 열고 이 위치로 갑니다';
          item.addEventListener('click', () => openDoc(doc.id, f));
          group.appendChild(item);
        }
      }
      wrap.appendChild(group);
    }
    return wrap;
  }

  function render() {
    if (!view) return;
    const prevBody = view.querySelector('.tb-body');
    const scroll = prevBody ? prevBody.scrollTop : 0;
    view.textContent = '';
    view.appendChild(expanded ? buildPanel() : buildBubble());
    const body = view.querySelector('.tb-body');
    if (body) body.scrollTop = scroll;
  }

  const CSS = `
:host{all:initial}
*{box-sizing:border-box}
.tb-wrap{font-family:"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif;font-size:13px;color:#202124;line-height:1.45;display:flex;justify-content:flex-end}
.tb-bubble{width:44px;height:44px;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;font-size:14px;font-weight:700;line-height:1;cursor:pointer;user-select:none;box-shadow:0 2px 10px rgba(0,0,0,.3)}
.tb-bubble.tb-ready{background:#1a73e8}
.tb-bubble.tb-pending{background:#8ab4f8}
.tb-bubble.tb-idle{background:#5f6368}
.tb-bubble:hover{filter:brightness(1.08)}
.tb-bubble-num{font-size:14px;font-variant-numeric:tabular-nums}
.tb-bubble-num.tb-small{font-size:11px}
.tb-bubble-unit{font-size:9px;font-weight:600;opacity:.85;margin-top:2px}
.tb-panel{position:relative;width:320px;max-height:65vh;display:flex;flex-direction:column;background:#fff;border-radius:10px;box-shadow:0 4px 24px rgba(0,0,0,.32);overflow:hidden}
.tb-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:6px;padding:6px 8px 6px 12px;background:#f8f9fa;border-bottom:1px solid #e0e0e0}
.tb-title{font-weight:700}
.tb-body{overflow:auto;flex:1;min-height:0}
.tb-section{padding:10px 14px 4px}
.tb-label{font-size:12px;color:#5f6368;margin-bottom:6px}
.tb-total{margin-top:4px;padding-top:6px;border-top:1px solid #e0e0e0;font-weight:700}
.tb-total .tb-file-pages{margin-right:46px}
.tb-scope{display:flex;align-items:center;gap:4px;margin-top:6px;font-size:12px;color:#5f6368;cursor:pointer;user-select:none}
.tb-scope input{margin:0}
.tb-empty{font-size:12px;color:#80868b;padding:6px 0}
.tb-file{display:flex;align-items:center;gap:8px;padding:3px 0}
.tb-file-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tb-file-pages{flex:none;font-weight:600;color:#1a73e8;font-variant-numeric:tabular-nums}
.tb-dim{color:#9aa0a6}
.tb-err{color:#d93025}
.tb-actions{display:flex;flex-wrap:wrap;gap:6px;padding:8px 14px 12px;border-bottom:1px solid #eceff1}
.tb-btn{border:1px solid #dadce0;background:#fff;color:#3c4043;border-radius:6px;padding:4px 10px;font:inherit;font-size:12px;cursor:pointer}
.tb-btn:hover:not(:disabled){background:#f1f3f4}
.tb-btn:disabled{opacity:.5;cursor:default}
.tb-primary{background:#1a73e8;border-color:#1a73e8;color:#fff}
.tb-primary:hover:not(:disabled){background:#1765cc}
.tb-file .tb-btn{padding:1px 8px}
.tb-group-head{display:flex;align-items:center;gap:6px;padding:7px 14px;background:#f8f9fa;border-bottom:1px solid #eceff1;cursor:pointer;position:sticky;top:0}
.tb-group-caret{width:10px;color:#5f6368}
.tb-group-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.tb-group-meta{flex:none;font-size:12px;color:#5f6368}
.tb-group .tb-empty{padding:6px 14px}
.tb-item{padding:7px 14px 8px 30px;border-bottom:1px solid #f1f3f4;cursor:pointer}
.tb-item:hover{background:#f8f9fa}
.tb-ctx{color:#5f6368;font-size:12px;word-break:break-all}
.tb-hit{color:#d93025;font-weight:700;text-decoration:underline wavy #d93025 1px;text-underline-offset:3px}
.tb-fix{font-weight:600;font-size:12px;margin-top:2px}
.tb-cat{margin-left:6px;font-weight:400;color:#80868b;font-size:11px}
.tb-status{padding:5px 14px;font-size:11px;color:#5f6368;background:#f1f3f4;border-top:1px solid #e0e0e0}
`;

  function mount() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.id = 'toytype-drive-root';
    // 독스 패널 버블과 같은 자리(우하단)
    host.style.cssText = 'position:fixed;right:24px;bottom:96px;z-index:2147483646;';
    root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
    view = el('div', 'tb-wrap');
    root.appendChild(view);
    document.documentElement.appendChild(host);
    render();
  }

  function originDisabled(stored) {
    const list = stored && Array.isArray(stored.disabledOrigins) ? stored.disabledOrigins : [];
    return list.includes(location.origin);
  }

  async function start() {
    const stored = await new Promise(resolve => {
      try { chrome.storage.local.get('settings', items => resolve(items && items.settings || {})); } catch (_) { resolve({}); }
    });
    if (originDisabled(stored)) return;
    try {
      const scopeItems = await chrome.storage.local.get(FIRST_TAB_KEY);
      firstTabOnly = !!(scopeItems && scopeItems[FIRST_TAB_KEY]);
    } catch (_) { /* 기본: 모든 탭 */ }
    mount();
    // 드라이브는 선택이 바뀌면 셀의 aria-selected를 바꾼다
    new MutationObserver(muts => {
      for (const m of muts) {
        if (m.type === 'attributes' && m.attributeName === 'aria-selected') {
          onSelectionMaybeChanged();
          return;
        }
      }
      schedulePrefetch();
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-selected'] });
    window.addEventListener('scroll', schedulePrefetch, true);
    onSelectionMaybeChanged();
    schedulePrefetch();
    // SPA 화면 전환 뒤에도 버블이 남아 있게
    setInterval(() => { if (!host || !host.isConnected) mount(); }, 3000);
  }

  // 개발판(압축 해제 설치)에서만: 페이지에서 postMessage로 확장을 다시 불러온다(코드 고친 뒤 테스트용)
  window.addEventListener('message', ev => {
    if (ev.source !== window || !ev.data) return;
    if (ev.data.kind === 'toytype-dev-reload') send({ type: 'typo:devReload' });
    // 개발판 디버그: 드라이브 메시지를 그대로 보내고 응답을 페이지에 돌려준다
    if (ev.data.kind === 'toytype-dev-call' && ev.data.msg && /^typo:drive/.test(ev.data.msg.type)) {
      if ('update_url' in chrome.runtime.getManifest()) return;
      send(ev.data.msg).then(res => window.postMessage({ kind: 'toytype-dev-result', id: ev.data.id, res }, '*'));
    }
  });

  start();
})();
