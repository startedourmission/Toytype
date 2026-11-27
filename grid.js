// 토인비 편집 — 격자 보기 (실제 문서 + 에이전트 채팅)
// 드라이브에서 고른 구글 문서를 한 탭 안에 격자로 띄우고(실제 편집기), 오른쪽 채팅창에서 에이전트들에게 지시한다.
// 에이전트는 문서를 구간으로 나눠 맡고, 일하는 구간을 문서에서 실제로 선택해 보여 준다.
// 고칠 곳은 채팅에 올리고, [바로 적용]이면 문서 칸 안의 토인비 편집이 패널의 [적용]과 같은 방식으로 바꾼다
// (그래서 실행 취소·버전 기록에 그대로 남는다).
'use strict';

(() => {
  // 격자 페이지는 docs.google.com/document/toytype-grid(구글이 돌려주는 가벼운 404 페이지)에 콘텐트 스크립트로 그린다.
  // 확장 페이지(다른 출처) 안에 문서를 끼우면 구글 문서가 편집자 권한을 줄여 제안 수락 등이 막히기 때문에,
  // 같은 출처 페이지에서 문서 칸을 띄운다.
  if (!location.pathname.startsWith('/document/toytype-grid')) return;
  if (globalThis.__toytypeGridLoaded) return;
  globalThis.__toytypeGridLoaded = true;
  for (const node of Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))) node.remove();
  document.documentElement.lang = 'ko';
  document.title = '토인비 편집 · 격자 보기';
  document.body.className = 'toytype-grid-page';
  document.body.removeAttribute('style');
  document.body.innerHTML = `<div class="g-main">
  <main class="g-grid" id="g-grid"></main>
  <div class="g-split" id="g-split" title="끌어서 채팅창 너비 조절 · 두 번 누르면 원래대로"></div>
  <aside class="g-chat" id="g-chat">${globalThis.ToytypeAgentChat.markup({ grid: true })}</aside>
</div>`;

  // 채팅(지시·제안·질문·요약)은 문서 안 패널과 같이 쓰는 엔진(content/agent-chat.js)이 맡는다. 격자는 문서 칸만 준다.
  const chat = globalThis.ToytypeAgentChat.create({
    root: document.getElementById('g-chat'),
    rpc: (card, op, args, timeoutMs) => rpc(card, op, args, timeoutMs),
    revealCard: card => revealCard(card),
    setWorking: (card, agent, label) => setWorking(card, agent, label),
    updateMeta: card => updateMeta(card),
    scheduleUnload: card => scheduleUnload(card),
    loadCard: card => loadCard(card),
    setFullEditor: (card, on, quiet) => setFullEditor(card, on, quiet),
    trace: (event, detail) => trace(event, detail),
    applyOptions: o => {
      for (const c of cards) if ((o.unchecked || []).includes(c.doc.id)) c.pick.checked = false;
      for (const c of cards) if ((o.full || []).includes(c.doc.id)) setFullEditor(c, true, true);
      renderTargets();
    },
    saveOptions: () => ({ unchecked: cards.filter(c => !c.pick.checked).map(c => c.doc.id), full: cards.filter(c => c.full).map(c => c.doc.id) }),
    onBusy: on => { for (const chip of document.querySelectorAll('.g-chip')) chip.disabled = on; },
    onInput: input => watchAllMention(input),
    // @all은 문서 선택용이라 에이전트에게 보내는 지시에서는 뺀다
    cleanInput: text => text.replace(new RegExp(ALL_MENTION.source, 'gi'), ''),
    onSent: () => { hadAllMention = false; }
  });
  const { systemMsg, setBusy, saveLog, flushLog } = chat;


  // 에이전트는 하나로 보인다 — 여러 구간을 동시에 보내도 같은 색·같은 이름
  const AI_COLOR = '#1a73e8';
  // 한 번에 같이 보내는 구간·문서 수(고정)
  const DOCS_ORIGIN = 'https://docs.google.com';
  const RPC_TIMEOUT_MS = 30000;
  const READY_TIMEOUT_MS = 90000;

  const $ = id => document.getElementById(id);
  let session = null;
  let sessionId = '';
  // 대화 맥락: 지시마다 결과를 짧게 요약해 두고 다음 지시 때 에이전트에게 같이 보낸다.
  // 구간마다 에이전트는 새로 시작하지만 이 요약 덕분에 "아까처럼", "방금 고친 것 중" 같은 말이 통한다.
  let cards = [];
  // 작업 중에 누른 질문 카드 반영은 줄 세워 두었다가 지금 작업이 끝나면 차례로 돌린다
  // 지시(턴)마다 구간 메시지 DOM — 끝나면 요약 아래로 접어 넣는다
  // 전체 적용이 도는 동안만 [전체 적용]·[이 대화 모두 적용]을 꺼 둔다(에이전트 작업 중에도 적용은 된다)
  // [멈춤]은 그때 대기 중이던 적용만 취소한다 — 멈춘 뒤에 새로 누른 [적용]은 그대로 실행돼야 한다
  let stopGen = 0;
  const rpcWaiters = new Map();
  let rpcSeq = 0;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function send(msg) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(msg, res => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false, error: 'no_response' });
        });
      } catch (e) {
        resolve({ ok: false, error: e && e.message ? e.message : String(e) });
      }
    });
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // 진단: 격자 페이지의 오류와 진행 단계를 백그라운드에 남긴다(드라이브 탭에서 읽어 볼 수 있다)
  function trace(event, detail) {
    try { chrome.runtime.sendMessage({ type: 'typo:gridFrameReport', report: { grid: true, event, detail: String(detail || '').slice(0, 300) } }, () => { void chrome.runtime.lastError; }); } catch (_) { /* 무시 */ }
  }
  window.addEventListener('error', ev => trace('error', (ev.message || '') + ' @' + (ev.lineno || '')));
  window.addEventListener('unhandledrejection', ev => trace('rejection', ev.reason && (ev.reason.stack || ev.reason.message) || ev.reason));

  // ---------- 문서 칸과 대화(postMessage) ----------

  window.addEventListener('message', ev => {
    if (ev.origin === DOCS_ORIGIN && ev.data && ev.data.kind === 'toytype-grid-frame' && ev.data.report && ev.data.report.pages) {
      const card = cards.find(c => c.frame.contentWindow === ev.source);
      if (card && !card.pages) {
        card.pages = ev.data.report.pages;
        updateMeta(card);
      }
    }
    if (ev.origin === DOCS_ORIGIN && ev.data && ev.data.kind === 'toytype-grid-notice' && typeof ev.data.text === 'string') {
      const card = cards.find(c => c.frame.contentWindow === ev.source);
      systemMsg((card ? card.doc.name + ' · ' : '') + ev.data.text.slice(0, 200), /못했|실패/.test(ev.data.text), false);
      return;
    }
    if (ev.origin !== DOCS_ORIGIN || !ev.data || ev.data.kind !== 'toytype-grid-rpc-result') return;
    const waiter = rpcWaiters.get(ev.data.id);
    if (!waiter) return;
    rpcWaiters.delete(ev.data.id);
    waiter(ev.data.res || { ok: false, error: 'empty' });
  });

  // ---------- 화면 고정 ----------
  // 문서 칸과 격자 페이지가 같은 출처라서, 칸 안의 구글 문서가 커서·찾기 상자를 보이게 하려고 부르는
  // scrollIntoView가 바깥 격자 페이지까지 올라와 화면을 밀어 올린다. 스크롤하면 안 되는 상자는 늘 0으로 되돌리고,
  // 칸에서 편집이 도는 동안에는 격자와 대화창 위치도 그대로 붙잡아 둔다.
  function pinScroll(el) {
    el.addEventListener('scroll', () => {
      if (el.scrollTop || el.scrollLeft) {
        el.scrollTop = 0;
        el.scrollLeft = 0;
      }
    });
  }
  window.addEventListener('scroll', () => { if (window.scrollY || window.scrollX) window.scrollTo(0, 0); });
  let holdDepth = 0;
  let held = null;
  function holdScroll() {
    if (holdDepth++ === 0) {
      const grid = $('g-grid');
      const log = $('g-log');
      held = { grid: [grid.scrollTop, grid.scrollLeft], log: log.scrollTop };
    }
  }
  function releaseScroll() {
    // 구글 문서가 조금 늦게 스크롤을 부르기도 해서 잠깐 더 붙잡았다 놓는다
    setTimeout(() => { if (--holdDepth === 0) held = null; }, 2000);
  }
  // 사람이 스크롤·클릭·키를 쓴 직후가 아니면, 에이전트가 일하는 동안 생긴 스크롤은 되돌린다
  let lastUserIntent = 0;
  // 버튼 클릭([적용] 등)은 스크롤 의도가 아니다. 그걸 의도로 치면 적용 중 문서가 당긴 스크롤이 그대로 통과해
  // 격자가 밀리고, 보이게 된 칸들이 줄줄이 다시 로드된다. 휠·터치·스크롤바 잡기·스크롤 키만 의도로 친다.
  const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ']);
  const markIntent = () => { lastUserIntent = Date.now(); };
  window.addEventListener('wheel', markIntent, { capture: true, passive: true });
  window.addEventListener('touchmove', markIntent, { capture: true, passive: true });
  window.addEventListener('pointerdown', ev => {
    // 스크롤바를 잡으면 대상이 스크롤 상자 자신이다
    if (ev.target && (ev.target.id === 'g-grid' || ev.target.id === 'g-log')) markIntent();
  }, { capture: true, passive: true });
  window.addEventListener('keydown', ev => {
    const t = ev.target;
    const typing = t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable);
    if (!typing && SCROLL_KEYS.has(ev.key)) markIntent();
  }, { capture: true, passive: true });
  function guardHeld(el, key) {
    let pos = [el.scrollTop, el.scrollLeft];
    let lastTrace = 0;
    el.addEventListener('scroll', () => {
      const userMoved = Date.now() - lastUserIntent < 1500;
      if (key === 'grid' && Date.now() - lastTrace > 300) {
        lastTrace = Date.now();
        trace('gridScroll', JSON.stringify({ top: el.scrollTop, held: held ? held.grid[0] : null, busy: !!chat.isBusy(), userMoved, active: document.activeElement && document.activeElement.tagName }));
      }
      if (held && !userMoved) {
        const want = key === 'grid' ? held.grid : [held.log, el.scrollLeft];
        if (el.scrollTop !== want[0] || el.scrollLeft !== want[1]) { el.scrollTop = want[0]; el.scrollLeft = want[1]; }
        return;
      }
      if (chat.isBusy() && !userMoved) {
        if (el.scrollTop !== pos[0] || el.scrollLeft !== pos[1]) { el.scrollTop = pos[0]; el.scrollLeft = pos[1]; }
        return;
      }
      pos = [el.scrollTop, el.scrollLeft];
    });
  }
  // [위치]·#문단 링크처럼 사람이 칸으로 가라고 한 이동. 스크롤 고정이 되돌리지 않게 의도로 표시하고,
  // 부드러운 스크롤은 도중에 다른 스크롤 보정에 끊기므로 바로 옮긴다.
  function revealCard(card) {
    const grid = $('g-grid');
    const g = grid.getBoundingClientRect();
    const r = card.root.getBoundingClientRect();
    let top = grid.scrollTop;
    if (r.top < g.top) top += r.top - g.top - 8;
    else if (r.bottom > g.bottom) top += Math.min(r.top - g.top - 8, r.bottom - g.bottom + 8);
    let left = grid.scrollLeft;
    if (r.left < g.left) left += r.left - g.left - 8;
    else if (r.right > g.right) left += Math.min(r.left - g.left - 8, r.right - g.right + 8);
    markIntent();
    grid.scrollTo({ top: Math.max(0, top), left: Math.max(0, left), behavior: 'auto' });
    // 다른 작업이 붙잡아 둔 위치보다 사람의 이동이 우선 — 붙잡을 위치를 새 위치로 바꾼다
    if (held) held.grid = [grid.scrollTop, grid.scrollLeft];
  }
  const HOLD_OPS = new Set(['applyEdit', 'formatFix', 'docosAct', 'docosList', 'tabInfo', 'select', 'agentCursor', 'agentCursorRemove', 'probe', 'getText', 'digest']);

  // 내려 둔 칸에 일을 시키면 먼저 다시 불러온다 — 에이전트는 안 보이는 칸도 다룰 수 있어야 한다
  async function rpc(card, op, args, timeoutMs) {
    const hold = HOLD_OPS.has(op);
    if (hold) holdScroll();
    // 작업 중에는 화면 밖이어도 칸을 그리게 한다(그리기를 건너뛴 편집기는 일부 동작이 멈출 수 있다)
    const lightOp = op === 'ping' || op === 'digest';
    if (!lightOp) { card.opDepth = (card.opDepth || 0) + 1; card.root.classList.add('g-op'); }
    let res;
    try {
      // 칸을 다시 불러오는 동안에도 격자 위치를 붙잡는다
      if (op !== 'ping' && card.unloaded && !(await ensureLoaded(card))) return { ok: false, error: 'not_ready' };
      res = await rawRpc(card, op, args, timeoutMs);
    } finally {
      if (hold) releaseScroll();
      if (!lightOp && --card.opDepth <= 0) { card.opDepth = 0; card.root.classList.remove('g-op'); }
    }
    if (!card.visible && op !== 'ping') scheduleUnload(card);
    return res;
  }

  function rawRpc(card, op, args, timeoutMs) {
    return new Promise(resolve => {
      const id = 'r' + (++rpcSeq);
      const timer = setTimeout(() => {
        rpcWaiters.delete(id);
        resolve({ ok: false, error: 'timeout' });
      }, timeoutMs || RPC_TIMEOUT_MS);
      rpcWaiters.set(id, res => {
        clearTimeout(timer);
        resolve(res);
      });
      try {
        card.frame.contentWindow.postMessage({ kind: 'toytype-grid-rpc', id, op, args: args || {} }, DOCS_ORIGIN);
      } catch (_) {
        clearTimeout(timer);
        rpcWaiters.delete(id);
        resolve({ ok: false, error: 'frame_unavailable' });
      }
    });
  }

  async function waitReady(card) {
    const t0 = Date.now();
    while (Date.now() - t0 < READY_TIMEOUT_MS) {
      if (card.unloaded) return false;
      const res = await rawRpc(card, 'ping', {}, 1500);
      if (res.ok) {
        card.ready = true;
        card.root.classList.add('g-ready');
        card.dot.title = '에이전트 연결됨';
        if (res.pages) card.pages = res.pages;
        updateMeta(card);
        return true;
      }
      await sleep(1000);
    }
    card.root.classList.add('g-failed');
    card.dot.title = '에이전트가 이 문서에 연결하지 못했습니다 · 칸을 새로고침하거나 [열기]로 여세요';
    return false;
  }

  // ---------- 카드 ----------

  function docUrl(docId, minimal) {
    const a = session.authuser > 0 ? 'u/' + session.authuser + '/' : '';
    return 'https://docs.google.com/document/' + a + 'd/' + encodeURIComponent(docId) + '/edit' + (minimal ? '?rm=minimal' : '');
  }

  function buildCard(doc) {
    const card = { doc, ready: false, pages: 0, applyChain: Promise.resolve(), counts: { applied: 0, proposed: 0 } };
    const root = el('section', 'g-card');
    const head = el('div', 'g-card-head');
    const pick = el('input');
    pick.type = 'checkbox';
    pick.checked = true;
    pick.title = '에이전트 작업 대상에 넣기';
    pick.addEventListener('change', () => { saveLog(); renderTargets(); });
    const name = el('div', 'g-card-name', doc.name || doc.id);
    name.title = doc.name || '';
    const badge = el('span', 'g-agent-badge', '');
    const meta = el('div', 'g-card-meta', '');
    const open = el('button', 'g-btn g-card-open', '열기');
    open.type = 'button';
    open.title = '문서를 새 탭으로 엽니다';
    open.addEventListener('click', () => send({ type: 'typo:driveOpenDoc', docId: doc.id, authuser: session.authuser }));
    // 간결 모드(rm=minimal)는 메뉴·댓글 패널이 빠져 댓글 해결 같은 기능을 못 쓴다 — 칸마다 일반 편집기로 바꿀 수 있다
    const full = el('button', 'g-btn g-card-open g-card-full', '전체 편집기');
    full.type = 'button';
    full.title = '이 칸을 메뉴·댓글까지 다 있는 일반 편집기로 엽니다(다시 누르면 간결 모드)';
    full.setAttribute('aria-pressed', 'false');
    full.addEventListener('click', () => setFullEditor(card, !card.full));
    const reload = el('button', 'g-btn g-card-open', '↻');
    reload.type = 'button';
    reload.title = '이 칸만 다시 불러옵니다(원본에서 고친 내용이 안 보일 때)';
    reload.addEventListener('click', () => reloadCard(card, false));
    const dot = el('span', 'g-ready-dot');
    dot.title = '에이전트 연결 준비 중';
    head.append(pick, dot, name, badge, meta, full, reload, open);
    const wrap = el('div', 'g-frame-wrap');
    const frame = el('iframe', 'g-frame');
    frame.src = docUrl(doc.id, true);
    frame.setAttribute('allow', 'clipboard-read; clipboard-write');
    wrap.append(frame, el('div', 'g-sleep', '화면 밖이라 잠시 내려 두었습니다 · 보이면 다시 불러옵니다'));
    pinScroll(wrap);
    pinScroll(root);
    // 오른쪽 모서리: 열 너비, 아래 모서리: 칸 높이 (두 번 누르면 원래대로)
    const sizeCol = el('div', 'g-size g-size-col');
    sizeCol.title = '끌어서 열 너비 조절 · 두 번 누르면 원래대로';
    const sizeRow = el('div', 'g-size g-size-row');
    sizeRow.title = '끌어서 이 줄 높이 조절 · 두 번 누르면 원래대로';
    root.append(head, wrap, sizeCol, sizeRow);
    sizeCol.addEventListener('pointerdown', ev => startColDrag(ev, card));
    sizeCol.addEventListener('dblclick', () => { ui.colFr = {}; layout(); saveUi(); });
    sizeRow.addEventListener('pointerdown', ev => startRowDrag(ev, card));
    sizeRow.addEventListener('dblclick', () => { setRowH(rowOf(card), 0); layout(); saveUi(); });
    Object.assign(card, { root, pick, badge, meta, frame, dot, fullBtn: full });
    return card;
  }

  // ---------- 원본 탭과 맞추기 ----------
  // 격자 칸(iframe 속 편집기)이 같은 문서를 연 일반 탭의 수정을 놓치는 일이 있다.
  // 원본 탭이 열려 있으면 몇 초마다 두 편집기 본문의 요약값을 대조하고,
  // 원본이 멈춘 뒤에도 계속 어긋나면 그 칸만 다시 불러온다.
  const SYNC_INTERVAL_MS = 5000;
  const STALE_GRACE_MS = 8000;
  let syncRunning = false;

  // ---------- 안 보이는 칸 내려 두기 ----------
  // 칸마다 편집기 하나라 무겁다. 하지만 편집기를 다시 불러오는 비용이 띄워 두는 비용보다 훨씬 크므로,
  // 화면 밖으로 나갔다고 바로 내리지 않는다. 띄운 편집기가 MAX_LIVE_FRAMES를 넘을 때만, 화면 밖에
  // UNLOAD_AFTER_MS 넘게 있던 칸부터(가장 오래 안 본 칸부터) 내린다. 에이전트가 맡은 칸(pinned)은 내리지 않는다.
  const UNLOAD_AFTER_MS = 30000;
  // 동시에 편집기를 띄워 두는 칸 수 상한. 넘으면 화면 밖 칸부터 바로 내린다(에이전트가 맡은 칸은 제외)
  const MAX_LIVE_FRAMES = 9;

  function trimLiveFrames() {
    const live = cards.filter(c => !c.unloaded);
    if (live.length <= MAX_LIVE_FRAMES) return;
    const now = Date.now();
    // 방금 화면 밖으로 나간 칸은 다시 돌아올 수 있으니 남겨 둔다
    const spare = live.filter(c => !c.visible && !c.pinned && !c.applying && !c.root.classList.contains('g-working') && now - (c.lastSeen || 0) >= UNLOAD_AFTER_MS)
      .sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0));
    for (const c of spare.slice(0, live.length - MAX_LIVE_FRAMES)) unloadCard(c);
  }
  let visObserver = null;

  function unloadCard(card) {
    if (card.unloaded || card.pinned || card.applying || card.root.classList.contains('g-working')) return;
    card.unloaded = true;
    card.ready = false;
    card.sync = null;
    card.root.classList.remove('g-ready', 'g-failed');
    card.root.classList.add('g-unloaded');
    card.dot.title = '화면 밖이라 내려 둠';
    card.frame.src = 'about:blank';
  }

  function loadCard(card) {
    if (!card.unloaded) return card.readyPromise;
    reloadCard(card, false);
    return card.readyPromise;
  }

  async function ensureLoaded(card) {
    if (card.unloaded) loadCard(card);
    return card.ready ? true : await card.readyPromise;
  }

  function scheduleUnload(card) {
    clearTimeout(card.unloadTimer);
    if (card.visible) return;
    card.unloadTimer = setTimeout(() => { if (!card.visible) trimLiveFrames(); }, UNLOAD_AFTER_MS);
  }

  function observeCard(card) {
    if (!visObserver) {
      visObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
          const card = cards.find(c => c.root === entry.target);
          if (!card) continue;
          card.visible = entry.isIntersecting;
          if (card.visible) {
            card.lastSeen = Date.now();
            clearTimeout(card.unloadTimer);
            // 잠깐 스쳐 보인 칸까지 불러오지 않게, 잠시 보인 채로 있어야 불러온다
            if (card.unloaded) {
              clearTimeout(card.loadTimer);
              card.loadTimer = setTimeout(() => { if (card.visible && card.unloaded) loadCard(card); }, 400);
            }
            trimLiveFrames();
          } else {
            card.lastSeen = Date.now();
            scheduleUnload(card);
          }
        }
      }, { root: $('g-grid'), rootMargin: '300px' });
    }
    visObserver.observe(card.root);
  }

  function reloadCard(card, auto) {
    card.unloaded = false;
    card.root.classList.remove('g-unloaded');
    card.ready = false;
    card.sync = null;
    card.root.classList.remove('g-ready', 'g-failed');
    card.dot.title = '다시 불러오는 중';
    card.frame.src = docUrl(card.doc.id, !card.full);
    card.readyPromise = waitReady(card);
    if (auto) systemMsg('「' + (card.doc.name || card.doc.id) + '」 칸이 원본 탭과 달라 다시 불러왔습니다', false, false);
  }

  function setFullEditor(card, on, quiet) {
    card.full = !!on;
    card.fullBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    card.fullBtn.textContent = on ? '간결 모드' : '전체 편집기';
    card.fullBtn.title = on ? '메뉴를 숨기고 본문만 넓게 봅니다' : '이 칸을 메뉴·댓글까지 다 있는 일반 편집기로 엽니다(다시 누르면 간결 모드)';
    card.root.classList.toggle('g-full', !!on);
    reloadCard(card, false);
    if (!quiet) saveLog();
  }

  async function syncCard(card) {
    // 원본 탭과 맞춰 보기는 보이는 칸만 한다. 화면 밖 칸은 다시 보일 때 맞춘다
    if (!card.ready || card.unloaded || !card.visible || card.root.classList.contains('g-working')) return;
    const origin = await send({ type: 'typo:gridOriginDigest', docId: card.doc.id });
    if (!origin.ok) { card.sync = null; return; }
    const mine = await rpc(card, 'digest', {}, 8000);
    if (!mine.ok || !card.ready || chat.isBusy()) return;
    const now = Date.now();
    const prev = card.sync;
    if (mine.digest === origin.digest) { card.sync = null; return; }
    // 원본이 아직 바뀌는 중이면(사용자가 치는 중) 기다린다 — 원본이 그대로인데도 계속 다를 때만 다시 불러온다
    if (!prev || prev.origin !== origin.digest || prev.frame !== mine.digest) {
      card.sync = { origin: origin.digest, frame: mine.digest, since: now };
      return;
    }
    if (now - prev.since >= STALE_GRACE_MS) {
      trace('stale', card.doc.name + ' reload');
      reloadCard(card, true);
    }
  }

  async function syncAll() {
    if (syncRunning || chat.isBusy() || document.visibilityState !== 'visible') return;
    syncRunning = true;
    try {
      for (const card of cards) await syncCard(card).catch(() => {});
    } finally {
      syncRunning = false;
    }
  }

  function updateMeta(card) {
    const parts = [];
    if (card.pages) parts.push(card.pages + '쪽');
    if (card.counts.applied) parts.push('고침 ' + card.counts.applied);
    else if (card.counts.proposed) parts.push('제안 ' + card.counts.proposed);
    card.meta.textContent = parts.join(' · ');
  }

  function setWorking(card, agent, label) {
    if (agent === null) {
      card.root.classList.remove('g-working');
      return;
    }
    card.root.style.setProperty('--agent', AI_COLOR);
    card.badge.textContent = label;
    card.root.classList.add('g-working');
  }

  // ---------- 이전 대화 고르기 ----------
  // 저장된 격자 세션(문서 묶음 + 채팅창 + 대화 기록)을 골라 그 상태로 다시 연다.
  function relTime(at) {
    const d = Math.max(0, Date.now() - (Number(at) || 0));
    if (d < 60000) return '방금';
    if (d < 3600000) return Math.floor(d / 60000) + '분 전';
    if (d < 86400000) return Math.floor(d / 3600000) + '시간 전';
    return Math.floor(d / 86400000) + '일 전';
  }

  async function listSessions() {
    const all = await chrome.storage.local.get(null);
    const out = [];
    for (const [k, v] of Object.entries(all)) {
      if (!/^grid:[\w-]+$/.test(k) || !v || !Array.isArray(v.docs)) continue;
      const id = k.slice(5);
      const log = all[k + ':log'];
      const hist = all[k + ':history'];
      const users = log && Array.isArray(log.entries) ? log.entries.filter(e => e.t === 'user') : [];
      const last = users.length ? users[users.length - 1].text : Array.isArray(hist) && hist.length ? hist[hist.length - 1].instruction : '';
      out.push({ id, docs: v.docs, at: Number(v.touchedAt || v.createdAt) || 0, turns: users.length || (Array.isArray(hist) ? hist.length : 0), last: String(last || '') });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  function gotoSession(id) {
    location.hash = id;
    location.reload();
  }

  async function newConversation() {
    if (!session || chat.isBusy()) return;
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ ['grid:' + id]: { docs: session.docs, pool: session.pool, folderName: session.folderName, authuser: session.authuser, createdAt: Date.now(), touchedAt: Date.now() } });
    gotoSession(id);
  }

  function closeHistory() {
    $('g-pop').hidden = true;
    $('g-history').setAttribute('aria-expanded', 'false');
    $('g-docs').setAttribute('aria-expanded', 'false');
    $('g-review').setAttribute('aria-expanded', 'false');
  }

  // ---------- 댓글 반영 ----------
  // 체크한 문서들에서 댓글·제안 카드를 모아 작성자별로 고르게 한 뒤, 고른 사람의 것만 AI가 판단해
  // 제안은 수락·거절하고, 댓글은 요청대로 고친 뒤 해결(또는 해결만)한다. 사람이 봐야 할 것은 남겨 둔다.
  // ---------- 격자 문서 켜고 끄기 ----------
  // 드라이브에서 격자를 열 때 보고 있던 폴더의 문서들을 후보로 두고, 칸을 켜고 끈다(최대 GRID_MAX_CARDS개).
  const GRID_MAX_CARDS = 30;

  function poolDocs() {
    const pool = Array.isArray(session.pool) ? session.pool.slice() : [];
    for (const d of session.docs) if (!pool.some(p => p.id === d.id)) pool.push(d);
    return pool;
  }

  // ---------- 대상 문서 칩 ----------
  // 채팅 입력창 위에 문서마다 칩을 두고, 켜진 칩(=칸 머리의 체크)이 에이전트가 맡을 문서다.
  function renderTargets() {
    const box = $('g-targets');
    if (!box) return;
    box.textContent = '';
    const on = cards.filter(c => c.pick.checked).length;
    const all = el('button', 'g-target g-target-all' + (on === cards.length ? ' g-on' : ''), '@all');
    all.type = 'button';
    all.title = on === cards.length ? '전부 빼기' : '전부 넣기';
    all.addEventListener('click', () => setAllPicks(on !== cards.length));
    box.appendChild(all);
    for (const c of cards) {
      const chip = el('button', 'g-target' + (c.pick.checked ? ' g-on' : ''), c.doc.name || c.doc.id);
      chip.type = 'button';
      chip.title = (c.doc.name || '') + (c.pick.checked ? ' · 눌러서 빼기' : ' · 눌러서 넣기');
      chip.addEventListener('click', () => {
        c.pick.checked = !c.pick.checked;
        saveLog();
        renderTargets();
      });
      box.appendChild(chip);
    }
  }

  function setAllPicks(on) {
    for (const c of cards) c.pick.checked = on;
    saveLog();
    renderTargets();
  }

  // 입력창에 @all(@전체)을 쓰면 전부 선택, 그 말을 지우면 전부 해제
  const ALL_MENTION = /@(all|전체)(?![\w가-힣])/i;
  let hadAllMention = false;
  function watchAllMention(input) {
    const has = ALL_MENTION.test(input.value);
    if (has && !hadAllMention) setAllPicks(true);
    else if (!has && hadAllMention) setAllPicks(false);
    hadAllMention = has;
  }

  function persistDocs() {
    renderTargets();
    session.docs = cards.map(c => c.doc);
    $('g-sub').textContent = '문서 ' + cards.length + '개';
    document.title = '격자 보기 · 문서 ' + cards.length + '개';
    chrome.storage.local.set({ ['grid:' + sessionId]: Object.assign(session, { touchedAt: Date.now() }) }).catch(() => {});
  }

  function addDocCard(doc) {
    if (cards.length >= GRID_MAX_CARDS || cards.some(c => c.doc.id === doc.id)) return;
    const order = poolDocs().map(d => d.id);
    const rank = id => { const i = order.indexOf(id); return i === -1 ? 1e9 : i; };
    const card = buildCard(doc);
    let idx = cards.findIndex(c => rank(c.doc.id) > rank(doc.id));
    if (idx === -1) idx = cards.length;
    $('g-grid').insertBefore(card.root, cards[idx] ? cards[idx].root : null);
    cards.splice(idx, 0, card);
    layout();
    card.readyPromise = waitReady(card);
    observeCard(card);
    persistDocs();
  }

  function removeDocCard(id) {
    const i = cards.findIndex(c => c.doc.id === id);
    if (i === -1 || cards.length <= 1) return;
    clearTimeout(cards[i].unloadTimer);
    if (visObserver) visObserver.unobserve(cards[i].root);
    cards[i].root.remove();
    cards.splice(i, 1);
    layout();
    persistDocs();
  }

  function openDocsPicker() {
    const pop = $('g-pop');
    pop.textContent = '';
    pop.appendChild(el('div', 'g-pop-label', (session.folderName ? session.folderName + ' · ' : '') + '격자 ' + cards.length + '/' + GRID_MAX_CARDS));
    if (chat.isBusy()) pop.appendChild(el('div', 'g-pop-note', '에이전트가 일하는 중에는 바꿀 수 없습니다'));
    for (const doc of poolDocs()) {
      const on = cards.some(c => c.doc.id === doc.id);
      const blocked = chat.isBusy() || (on ? cards.length <= 1 : cards.length >= GRID_MAX_CARDS);
      const row = el('label', 'g-doc-row' + (blocked ? ' g-disabled' : ''));
      const box = el('input');
      box.type = 'checkbox';
      box.checked = on;
      box.disabled = blocked;
      box.addEventListener('change', () => {
        if (box.checked) addDocCard(doc);
        else removeDocCard(doc.id);
        openDocsPicker();
      });
      row.append(box, el('span', 'g-switch-track'), el('span', 'g-doc-name', doc.name || doc.id));
      row.title = doc.name || '';
      pop.appendChild(row);
    }
    if (!Array.isArray(session.pool) || !session.pool.length) pop.appendChild(el('div', 'g-pop-note', '예전에 연 격자라 폴더 목록이 없습니다 · 드라이브에서 격자를 다시 열면 그 폴더의 문서가 다 나옵니다'));
    pop.hidden = false;
    $('g-docs').setAttribute('aria-expanded', 'true');
    $('g-history').setAttribute('aria-expanded', 'false');
    $('g-review').setAttribute('aria-expanded', 'false');
  }

  async function openHistory() {
    const pop = $('g-pop');
    pop.textContent = '';
    const fresh = el('button', 'g-pop-new', '+ 이 문서들로 새 대화 시작');
    fresh.type = 'button';
    fresh.disabled = chat.isBusy();
    fresh.addEventListener('click', newConversation);
    pop.appendChild(fresh);
    pop.appendChild(el('div', 'g-pop-label', '이전 대화'));
    const list = await listSessions();
    if (!list.length) pop.appendChild(el('div', 'g-pop-empty', '저장된 대화가 없습니다'));
    for (const it of list) {
      const row = el('div', 'g-sess' + (it.id === sessionId ? ' g-current' : ''));
      row.tabIndex = 0;
      const names = it.docs.map(d => d.name || d.id);
      row.append(
        el('span', 'g-sess-title', names.slice(0, 2).join(', ') + (names.length > 2 ? ' 외 ' + (names.length - 2) + '개' : '')),
        it.last ? el('span', 'g-sess-last', '“' + it.last.replace(/\s+/g, ' ').slice(0, 80) + '”') : el('span', 'g-sess-last', '지시 없음'),
        el('span', 'g-sess-meta', relTime(it.at) + ' · 지시 ' + it.turns + '번' + (it.id === sessionId ? ' · 지금 대화' : ''))
      );
      if (it.id !== sessionId) {
        const go = () => { if (!chat.isBusy() || !session) gotoSession(it.id); };
        row.addEventListener('click', go);
        row.addEventListener('keydown', ev => { if (ev.key === 'Enter') go(); });
        const del = el('button', 'g-sess-del', '×');
        del.type = 'button';
        del.title = '이 대화 기록 지우기';
        del.addEventListener('click', async ev => {
          ev.stopPropagation();
          await chrome.storage.local.remove(['grid:' + it.id, 'grid:' + it.id + ':history', 'grid:' + it.id + ':log']);
          row.remove();
        });
        row.appendChild(del);
      }
      pop.appendChild(row);
    }
    pop.hidden = false;
    $('g-history').setAttribute('aria-expanded', 'true');
    $('g-docs').setAttribute('aria-expanded', 'false');
    $('g-review').setAttribute('aria-expanded', 'false');
  }

  function initHistoryPicker() {
    const btn = $('g-history');
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      if ($('g-pop').hidden || btn.getAttribute('aria-expanded') !== 'true') openHistory();
      else closeHistory();
    });
    $('g-docs').addEventListener('click', ev => {
      ev.stopPropagation();
      if (!session) return;
      if ($('g-pop').hidden || $('g-docs').getAttribute('aria-expanded') !== 'true') openDocsPicker();
      else closeHistory();
    });
  }

  // ---------- 크기 조절 ----------
  // 채팅창 너비, 열 수, 열마다 너비 비율, 칸 높이를 끌어서 바꾸고 다음에 열 때도 그대로 쓴다.
  const UI_KEY = 'gridLayout';
  let ui = { chatW: 0, cols: 0, colFr: {}, rowH: 0, rowHs: {} };
  let uiSaveTimer = 0;

  function saveUi() {
    clearTimeout(uiSaveTimer);
    uiSaveTimer = setTimeout(() => chrome.storage.local.set({ [UI_KEY]: ui }).catch(() => {}), 300);
  }

  function colCount() {
    const n = cards.length;
    if (ui.cols >= 1) return Math.min(ui.cols, Math.max(1, n));
    return n <= 1 ? 1 : n <= 4 ? 2 : 3;
  }

  function colFractions(cols) {
    const fr = ui.colFr[cols];
    return Array.isArray(fr) && fr.length === cols ? fr : Array(cols).fill(1);
  }

  function layout() {
    const n = cards.length;
    const cols = colCount();
    const rows = Math.ceil(n / cols);
    const root = document.documentElement.style;
    root.setProperty('--cols', String(cols));
    root.setProperty('--grid-cols', colFractions(cols).map(f => 'minmax(0, ' + f.toFixed(3) + 'fr)').join(' '));
    // 두 줄까지는 화면을 꽉 채우고, 그보다 많으면 칸 높이를 고정하고 스크롤한다 — 직접 정한 높이가 있으면 그것을 쓴다
    // 줄마다 직접 정한 높이가 있으면 그 줄만 그 높이를 쓴다(열 수마다 따로 기억)
    const base = ui.rowH ? ui.rowH + 'px' : rows <= 2 ? 'calc((100% - ' + (rows - 1) * 6 + 'px) / ' + rows + ')' : '46vh';
    root.setProperty('--card-h', base);
    const own = (ui.rowHs && ui.rowHs[cols]) || {};
    root.setProperty('--grid-rows', Array.from({ length: rows }, (_, i) => own[i] ? own[i] + 'px' : base).join(' '));
    if (ui.chatW) root.setProperty('--chat-w', ui.chatW + 'px');
    else root.removeProperty('--chat-w');
    cards.forEach((c, i) => c.root.classList.toggle('g-last-col', i % cols === cols - 1 || i === n - 1));
    const reset = $('g-reset');
    if (reset) reset.disabled = !(ui.chatW || ui.cols || ui.rowH || Object.keys(ui.colFr || {}).length || Object.keys(ui.rowHs || {}).length);
  }

  // 끄는 동안 문서 iframe이 마우스를 가로채지 않게 화면 전체를 덮는다
  function dragSession(cursor, onMove, onEnd) {
    const shield = el('div', 'g-drag-shield');
    shield.style.cursor = cursor;
    document.body.appendChild(shield);
    document.body.classList.add('g-dragging');
    const move = ev => onMove(ev);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      shield.remove();
      document.body.classList.remove('g-dragging');
      if (onEnd) onEnd();
      saveUi();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function startColDrag(ev, card) {
    ev.preventDefault();
    const cols = colCount();
    const idx = cards.indexOf(card) % cols;
    if (idx >= cols - 1) return;
    const left = cards[idx].root.getBoundingClientRect();
    const right = cards[idx + 1].root.getBoundingClientRect();
    const pair = left.width + right.width;
    const fr = colFractions(cols).slice();
    const frPair = fr[idx] + fr[idx + 1];
    const x0 = ev.clientX;
    dragSession('col-resize', e => {
      const w = Math.max(220, Math.min(pair - 220, left.width + e.clientX - x0));
      fr[idx] = frPair * w / pair;
      fr[idx + 1] = frPair - fr[idx];
      ui.colFr = Object.assign({}, ui.colFr, { [cols]: fr });
      layout();
    });
  }

  function rowOf(card) {
    return Math.floor(cards.indexOf(card) / colCount());
  }

  function setRowH(row, h) {
    const cols = colCount();
    const own = Object.assign({}, (ui.rowHs && ui.rowHs[cols]) || {});
    if (h) own[row] = h;
    else delete own[row];
    const all = Object.assign({}, ui.rowHs);
    if (Object.keys(own).length) all[cols] = own;
    else delete all[cols];
    ui.rowHs = all;
  }

  // 끄는 줄만 높이가 바뀐다(다른 줄은 그대로)
  function startRowDrag(ev, card) {
    ev.preventDefault();
    const h0 = card.root.getBoundingClientRect().height;
    const y0 = ev.clientY;
    const row = rowOf(card);
    dragSession('row-resize', e => {
      setRowH(row, Math.round(Math.max(180, Math.min(window.innerHeight * 1.5, h0 + e.clientY - y0))));
      layout();
    });
  }

  function startChatDrag(ev) {
    ev.preventDefault();
    const w0 = $('g-chat').getBoundingClientRect().width;
    const x0 = ev.clientX;
    dragSession('col-resize', e => {
      ui.chatW = Math.round(Math.max(260, Math.min(window.innerWidth * 0.6, w0 - (e.clientX - x0))));
      layout();
    });
  }

  async function initLayoutControls() {
    const saved = (await chrome.storage.local.get(UI_KEY).catch(() => ({})))[UI_KEY];
    if (saved && typeof saved === 'object') ui = Object.assign(ui, saved, { colFr: Object.assign({}, saved.colFr), rowHs: Object.assign({}, saved.rowHs) });
    const sel = $('g-cols');
    sel.value = String(ui.cols || 0);
    sel.addEventListener('change', () => {
      ui.cols = Number(sel.value) || 0;
      layout();
      saveUi();
    });
    $('g-reset').addEventListener('click', () => {
      ui = { chatW: 0, cols: 0, colFr: {}, rowH: 0, rowHs: {} };
      sel.value = '0';
      layout();
      saveUi();
    });
    const split = $('g-split');
    split.addEventListener('pointerdown', startChatDrag);
    split.addEventListener('dblclick', () => { ui.chatW = 0; layout(); saveUi(); });
    layout();
  }

  async function start() {
    const id = location.hash.slice(1);
    sessionId = id;
    const keys = ['grid:' + id, 'grid:' + id + ':history', 'grid:' + id + ':log'];
    const stored = id ? await chrome.storage.local.get(keys) : {};
    session = stored['grid:' + id];
    trace('start', 'session ' + (session ? session.docs.length : 'missing'));
    const history = Array.isArray(stored['grid:' + id + ':history']) ? stored['grid:' + id + ':history'] : [];
    chat.setSession(id ? 'grid:' + id : '', session, history);
    if (!session || !Array.isArray(session.docs) || !session.docs.length) {
      systemMsg('이 대화를 찾지 못했습니다 · 오른쪽 위 [기록]에서 이전 대화를 고르거나 드라이브에서 [격자 보기]를 다시 누르세요', true, false);
      setBusy(true);
      $('g-stop').hidden = true;
      initHistoryPicker();
      return;
    }
    $('g-sub').textContent = '문서 ' + session.docs.length + '개';
    document.title = '격자 보기 · 문서 ' + session.docs.length + '개';
    cards = session.docs.map(buildCard);
    chat.setCards(cards);
    const grid = $('g-grid');
    for (const c of cards) grid.appendChild(c.root);
    layout();
    await initLayoutControls();
    initHistoryPicker();
    trace('cards', cards.length + ' cards');
    for (const c of cards) c.readyPromise = waitReady(c).then(ok => { trace('ready', c.doc.name + ' ' + ok); return ok; });
    for (const c of cards) observeCard(c);

    renderTargets();
    pinScroll(document.documentElement);
    pinScroll(document.body);
    pinScroll(document.querySelector('.g-main'));
    pinScroll($('g-chat'));
    guardHeld($('g-grid'), 'grid');
    guardHeld($('g-log'), 'log');
    setInterval(syncAll, SYNC_INTERVAL_MS);
    chat.load(stored['grid:' + id + ':log'], '문서 ' + cards.length + '개를 열었습니다. 지시를 쓰거나 아래 버튼을 누르세요. 기본은 제안 모드라 문서는 승인한 곳만 바뀝니다.');
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncAll(); });

    // 예전 판에서 session에 있던 세션은 local로 옮겨 다음부터 유지되게 한다
    chrome.storage.local.set({ ['grid:' + id]: Object.assign(session, { touchedAt: Date.now() }), ['grid:' + id + ':history']: history }).catch(() => {});
  }

  start();
})();
