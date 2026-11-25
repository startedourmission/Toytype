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
  <aside class="g-chat" id="g-chat">
    <div class="g-progress"><div class="g-progress-fill" id="g-progress-fill"></div></div>
    <header class="g-chat-head">
      <div class="g-titlebar">
        <span class="g-chat-title">에이전트</span>
        <span class="g-chat-sub" id="g-sub"></span>
        <button type="button" class="g-stop" id="g-stop" hidden>멈춤</button>
        <button type="button" class="g-ghost" id="g-review" aria-haspopup="true" aria-expanded="false" title="문서에 남은 댓글·제안을 작성자별로 골라 AI가 판단해 반영·해결합니다">댓글 반영</button>
        <button type="button" class="g-ghost" id="g-docs" aria-haspopup="true" aria-expanded="false" title="격자에 띄울 문서 켜고 끄기">문서</button>
        <button type="button" class="g-ghost" id="g-history" aria-haspopup="true" aria-expanded="false" title="이전 대화 고르기">기록</button>
      </div>
      <div class="g-pop" id="g-pop" hidden></div>
      <div class="g-toolbar">
        <label class="g-field" title="한 줄에 놓을 문서 수"><span>열</span>
          <select id="g-cols"><option value="0">자동</option><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option></select>
        </label>
        <label class="g-field" title="동시에 일하는 AI 에이전트 수"><span>인원</span>
          <select id="g-conc"><option>1</option><option>2</option><option selected>3</option><option>4</option><option>5</option><option>6</option></select>
        </label>
        <label class="g-switch" title="켜면 에이전트가 고친 곳을 문서에 바로 반영합니다. 끄면 제안만 받고 직접 승인합니다.">
          <input type="checkbox" id="g-auto"><span class="g-switch-track" aria-hidden="true"></span><span>바로 적용</span>
        </label>
        <button type="button" class="g-apply-all" id="g-apply-all" title="이 대화에서 아직 적용 안 된 제안을 전부 문서에 적용합니다" hidden>전체 적용</button>
        <div class="g-nav" id="g-nav" hidden>
        <button type="button" class="g-nav-btn" id="g-top" title="맨 위로" aria-label="맨 위로">↑</button>
        <button type="button" class="g-nav-btn g-nav-last" id="g-last" title="마지막으로 [적용]을 누른 곳으로" aria-label="마지막으로 적용을 누른 곳으로">최근 적용</button>
        <button type="button" class="g-nav-btn" id="g-jump" title="맨 아래로" aria-label="맨 아래로">↓</button>
      </div>
        <button type="button" class="g-reset" id="g-reset" title="열 수·열 너비·칸 높이·채팅창 너비를 처음대로 되돌립니다" disabled>크기 원래대로</button>
      </div>
    </header>
    <div class="g-log-wrap">
      <div class="g-log" id="g-log"></div>
    </div>
    <footer class="g-composer">
      <div class="g-targets" id="g-targets" title="에이전트가 맡을 문서 · 눌러서 넣고 빼기 · 입력창에 @all을 쓰면 전부 선택, 지우면 전부 해제"></div>
      <div class="g-slash" id="g-slash" hidden></div>
      <form class="g-compose" id="g-compose">
        <div class="g-compose-main">
        <div class="g-cmds" id="g-cmds" hidden></div>
        <textarea id="g-input" rows="2" placeholder="에이전트에게 지시하세요 · /로 기능 부르기 (/맞춤법(룰베이스), /서식 점검, /전체 교정 …)"></textarea>
        </div>
        <button type="submit" class="g-send" id="g-send" title="보내기 (⌘Enter)" aria-label="보내기">↑</button>
      </form>
      <div class="g-hint">⌘Enter로 보내기 · /로 기능 부르기 · @all로 전부 선택</div>
    </footer>
  </aside>
</div>`;

  const AGENT_COLORS = ['#1a73e8', '#e37400', '#188038', '#8430ce', '#d01884', '#12839b'];
  const DOCS_ORIGIN = 'https://docs.google.com';
  const CHUNK_MIN = 1500;
  const CHUNK_MAX = 6000;
  const AI_TIMEOUT_MS = 300000;
  const RPC_TIMEOUT_MS = 30000;
  const READY_TIMEOUT_MS = 90000;
  const PRESETS = [
    ['전체 교정', '이 원고를 교정해 줘. 확실히 틀린 것만 고쳐 줘: 명백한 비문, 잘못된 기술 설명, 용어 혼용, 오탈자. 문체·어감 손질(윤문)은 하지 마.'],
    ['합니다체 통일', '본문 서술을 합니다체로 통일해 줘. 인용·예시 대화·코드는 그대로 둬.'],
    ['비문만', '문법적으로 확실히 틀린 문장(비문)만 최소한으로 고쳐 줘. 애매하면 두고 넘어가.'],
    ['용어 표기 통일', '같은 용어가 다른 표기로 섞인 곳을 가장 많이 쓴 표기로 통일해 줘.'],
    ['문장 다듬기', '뜻은 그대로 두고 길고 어색한 문장만 짧고 자연스럽게 다듬어 줘.']
  ];

  const HISTORY_TURNS = 6;
  // 윤문(문체·어감 손질)을 맡기는 지시
  const POLISH_RE = /다듬|윤문|자연스럽|매끄럽|간결/;

  const $ = id => document.getElementById(id);
  let session = null;
  let sessionId = '';
  // 대화 맥락: 지시마다 결과를 짧게 요약해 두고 다음 지시 때 에이전트에게 같이 보낸다.
  // 구간마다 에이전트는 새로 시작하지만 이 요약 덕분에 "아까처럼", "방금 고친 것 중" 같은 말이 통한다.
  let history = [];
  let cards = [];
  let busy = false;
  let stopRequested = false;
  // [멈춤]은 그때 대기 중이던 적용만 취소한다 — 멈춘 뒤에 새로 누른 [적용]은 그대로 실행돼야 한다
  let stopGen = 0;
  const liveRequests = new Set();
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
        trace('gridScroll', JSON.stringify({ top: el.scrollTop, held: held ? held.grid[0] : null, busy: !!busy, userMoved, active: document.activeElement && document.activeElement.tagName }));
      }
      if (held && !userMoved) {
        const want = key === 'grid' ? held.grid : [held.log, el.scrollLeft];
        if (el.scrollTop !== want[0] || el.scrollLeft !== want[1]) { el.scrollTop = want[0]; el.scrollLeft = want[1]; }
        return;
      }
      if (busy && !userMoved) {
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
    sizeRow.title = '끌어서 칸 높이 조절 · 두 번 누르면 원래대로';
    root.append(head, wrap, sizeCol, sizeRow);
    sizeCol.addEventListener('pointerdown', ev => startColDrag(ev, card));
    sizeCol.addEventListener('dblclick', () => { ui.colFr = {}; layout(); saveUi(); });
    sizeRow.addEventListener('pointerdown', ev => startRowDrag(ev, card));
    sizeRow.addEventListener('dblclick', () => { ui.rowH = 0; layout(); saveUi(); });
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
    if (!mine.ok || !card.ready || busy) return;
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
    if (syncRunning || busy || document.visibilityState !== 'visible') return;
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
    card.root.style.setProperty('--agent', AGENT_COLORS[agent % AGENT_COLORS.length]);
    card.badge.textContent = label;
    card.root.classList.add('g-working');
  }

  // ---------- 채팅 ----------
  // 채팅창 내용은 logEntries에 데이터로 쌓고 local 저장소에 남겨, 탭을 새로고침해도 그대로 다시 그린다.
  const LOG_MAX_ENTRIES = 300;
  let logEntries = [];
  let logSaveTimer = 0;

  function saveLog() {
    updateApplyAll();
    if (!sessionId) return;
    clearTimeout(logSaveTimer);
    logSaveTimer = setTimeout(flushLog, 400);
  }

  function flushLog() {
    clearTimeout(logSaveTimer);
    if (!sessionId || !session) return;
    try {
      const entries = logEntries.slice(-LOG_MAX_ENTRIES).map(e => e.t !== 'agent' ? e : {
        t: 'agent', agent: e.agent, who: e.who, text: e.pending ? '(새로고침으로 중단됨)' : e.text, docId: e.docId,
        review: Array.isArray(e.review) ? e.review.slice(0, 200) : undefined,
        format: Array.isArray(e.format) ? e.format.slice(0, 300) : undefined,
        figure: Array.isArray(e.figure) ? e.figure.slice(0, 300) : undefined,
        turn: e.turn || undefined,
        share: Array.isArray(e.share) && e.share.length ? e.share : undefined,
        edits: (e.edits || []).map(x => ({
          src: x.src, dst: x.dst, reason: x.reason, category: x.category, hint: x.hint, pressedAt: x.pressedAt || 0, refs: x.refs || undefined,
          state: x.state === 'applied' ? 'applied' : x.state === 'failed' ? 'failed' : x.state === 'rejected' ? 'rejected' : 'proposed',
          note: x.state === 'rejected' || x.reviewed ? (x.stateEl && x.stateEl.textContent || x.note || '') : undefined
        }))
      });
      const options = { auto: $('g-auto').checked, conc: $('g-conc').value, unchecked: cards.filter(c => !c.pick.checked).map(c => c.doc.id), full: cards.filter(c => c.full).map(c => c.doc.id) };
      chrome.storage.local.set({
        ['grid:' + sessionId + ':log']: { entries, options },
        ['grid:' + sessionId]: Object.assign(session, { touchedAt: Date.now() })
      }).then(() => trace('logSaved', entries.length), e => trace('logSaveFailed', e && e.message));
    } catch (e) {
      trace('logSaveFailed', e && e.message);
    }
  }

  function pushEntry(entry, persist) {
    if (persist === false) return entry;
    logEntries.push(entry);
    if (logEntries.length > LOG_MAX_ENTRIES * 2) logEntries = logEntries.slice(-LOG_MAX_ENTRIES);
    saveLog();
    return entry;
  }

  // 새 메시지가 와도 읽던 자리를 끌어내리지 않는다. 아래에 안 본 내용이 있으면 [↓] 버튼만 띄운다.
  function atBottom(log) {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 24;
  }

  // 대화창 아래 떠 있는 이동 버튼: 맨 위 · 최근 적용 · 맨 아래 — 대화가 화면을 넘칠 때만 보인다
  let lastAppliedItem = null;

  // 직접 누른 [적용]이 없으면(새로고침 전·바로 적용 모드) 대화창에서 가장 아래 있는 적용된 항목으로 간다
  function lastAppliedTarget() {
    if (lastAppliedItem && lastAppliedItem.isConnected) return lastAppliedItem;
    const applied = $('g-log').querySelectorAll('.g-edit.g-applied');
    return applied.length ? applied[applied.length - 1] : null;
  }

  function updateJump() {
    const log = $('g-log');
    const scrollable = log.scrollHeight - log.clientHeight > 24;
    const hasLast = !!lastAppliedTarget();
    $('g-nav').hidden = !scrollable && !hasLast;
    $('g-top').disabled = log.scrollTop < 24;
    $('g-jump').disabled = atBottom(log);
    $('g-last').hidden = !hasLast;
  }

  function jumpToTop() {
    $('g-log').scrollTo({ top: 0, behavior: 'smooth' });
  }

  function jumpToLastApplied() {
    const item = lastAppliedTarget();
    if (!item) return;
    item.scrollIntoView({ block: 'center', behavior: 'smooth' });
    item.classList.remove('g-flash');
    void item.offsetWidth;
    item.classList.add('g-flash');
  }

  function scrollLog() {
    requestAnimationFrame(updateJump);
  }

  function jumpToBottom(smooth) {
    const log = $('g-log');
    log.scrollTo({ top: log.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  // persist=false: 잠깐 보이는 안내(대기 중·멈추는 중 등)는 기록하지 않는다
  // 지시 한 번(대화 한 턴)에서 나온 제안을 묶는 표시 — 턴 끝 메시지에 [이 대화 모두 적용]을 단다
  let currentTurn = '';

  // ---------- 애매한 선택은 묻기 ----------
  // AI가 고르지 못한 선택(용어 A/B, 코너 이름 등)을 모아 채팅창에 질문 카드로 띄운다.
  // 답은 이 대화의 편집자 결정(session.decisions)으로 남아 이후 모든 요청에 함께 가고, 같은 것을 다시 묻지 않는다.
  let runQuestions = [];
  // 이번 지시에서 이미 띄운 질문 주제 — 작업 중에 바로 띄운 질문을 다시 띄우지 않는다
  let askedThisRun = new Set();
  const topicKey = q => String(q.topic || q.question).replace(/\s+/g, '').toLowerCase();

  function decisions() {
    return session && Array.isArray(session.decisions) ? session.decisions : [];
  }

  function addDecision(topic, choice) {
    if (!session) return;
    const list = decisions().filter(d => !d.startsWith(topic + ': '));
    list.push(topic + ': ' + choice);
    session.decisions = list.slice(-40);
    chrome.storage.local.set({ ['grid:' + sessionId]: Object.assign(session, { touchedAt: Date.now() }) }).catch(() => {});
  }

  function collectQuestions(list) {
    for (const q of list || []) {
      const key = topicKey(q);
      if (askedThisRun.has(key)) continue;
      if (decisions().some(d => d.split(': ')[0].replace(/\s+/g, '').toLowerCase() === key)) continue;
      const same = runQuestions.find(x => String(x.topic || x.question).replace(/\s+/g, '').toLowerCase() === key);
      if (same) {
        for (const o of q.options) if (!same.options.includes(o) && same.options.length < 4) same.options.push(o);
      } else if (runQuestions.length < 8) {
        runQuestions.push({ topic: q.topic, question: q.question, options: q.options.slice(0, 4), answer: '' });
      }
    }
  }

  function renderQuestionCard(entry) {
    const m = el('div', 'g-msg g-msg-question');
    const pre = !!(entry.followUp && entry.followUp.preflight);
    const live = !!(entry.followUp && entry.followUp.live);
    m.appendChild(el('div', 'g-q-title', pre ? '시작 전에 정할 것 ' + entry.items.length + '개 · 답하면 이 대화 내내 그대로 따릅니다'
      : live ? '작업 중 나온 질문 ' + entry.items.length + '개 · 답하면 아직 안 한 구간부터 바로 따릅니다'
        : '확인이 필요한 선택 ' + entry.items.length + '개 · 답하면 이 대화 내내 그대로 따릅니다'));
    const again = el('button', 'g-apply-all g-q-go', '답한 내용으로 다시 처리');
    again.type = 'button';
    const sync = () => {
      const answered = entry.items.filter(q => q.answer).length;
      if (pre) {
        // 시작 전 질문은 모두 답(또는 넘김)해야 시작한다
        again.disabled = answered < entry.items.length || busy || entry.started;
        again.textContent = entry.started ? '시작했습니다' : answered < entry.items.length ? '남은 질문 ' + (entry.items.length - answered) + '개에 답하세요' : '답한 대로 시작';
        return;
      }
      again.disabled = !answered || busy;
      // 작업 중에 답하면 남은 구간에 바로 들어가므로, 다시 처리는 작업이 끝난 뒤에 누를 수 있다
      again.textContent = busy && live ? '답은 남은 구간에 바로 반영됩니다 · 끝나면 다시 처리할 수 있어요'
        : answered ? '답한 ' + answered + '개로 다시 처리' : '답을 고르세요';
    };
    m.syncQuestion = sync;
    for (const q of entry.items) {
      const box = el('div', 'g-q');
      box.appendChild(el('div', 'g-q-text', q.question));
      const opts = el('div', 'g-q-opts');
      const buttons = [];
      const pick = choice => {
        q.answer = choice;
        // 넘기면 에이전트에게 맡긴 것으로 남겨, 다시 묻지 않게 한다
        addDecision(q.topic, choice === '(넘김)' ? '편집자가 에이전트 판단에 맡김' : choice);
        for (const b of buttons) b.classList.toggle('g-on', b.dataset.choice === choice);
        sync();
        saveLog();
      };
      const custom = q.answer && q.answer !== '(넘김)' && !q.options.includes(q.answer) ? q.answer : '';
      for (const o of q.options.concat(['(넘김)'])) {
        const b = el('button', 'g-target' + (q.answer === o ? ' g-on' : ''), o);
        b.type = 'button';
        b.dataset.choice = o;
        b.title = o === '(넘김)' ? '정하지 않고 에이전트가 알아서 판단하게 하기' : '“' + o + '”로 정하기';
        b.addEventListener('click', () => pick(o));
        buttons.push(b);
        opts.appendChild(b);
      }
      box.appendChild(opts);
      // 선택지에 없는 답: [직접 입력]을 누르면 입력 칸이 열린다(Enter 저장, Esc 닫기)
      const own = el('div', 'g-q-own');
      own.hidden = true;
      const input = el('input', 'g-q-input');
      input.type = 'text';
      input.placeholder = '답을 적고 Enter';
      input.value = custom;
      own.appendChild(input);
      const ownBtn = el('button', 'g-target' + (custom ? ' g-on' : ''), custom ? '직접: ' + custom : '직접 입력');
      ownBtn.type = 'button';
      ownBtn.title = '선택지에 없는 답을 직접 적습니다';
      ownBtn.addEventListener('click', () => {
        own.hidden = !own.hidden;
        if (!own.hidden) { input.focus(); input.select(); }
      });
      opts.insertBefore(ownBtn, buttons[buttons.length - 1]); // (넘김) 앞에
      input.addEventListener('keydown', ev => {
        ev.stopPropagation();
        if (ev.key === 'Escape') { own.hidden = true; return; }
        if (ev.key !== 'Enter' || ev.isComposing || ev.keyCode === 229) return;
        ev.preventDefault();
        const v = input.value.trim().slice(0, 200);
        if (!v) return;
        pick(v);
        own.hidden = true;
        ownBtn.classList.add('g-on');
        ownBtn.textContent = '직접: ' + v;
      });
      for (const b of buttons) b.addEventListener('click', () => { ownBtn.classList.remove('g-on'); ownBtn.textContent = '직접 입력'; own.hidden = true; });
      box.appendChild(own);
      m.appendChild(box);
    }
    again.addEventListener('click', () => {
      if (busy) return;
      again.disabled = true;
      const f = entry.followUp || {};
      if (pre) { entry.started = true; saveLog(); }
      if (f.kind === 'format') runFormatCheck(f.extra || '');
      else if (f.kind === 'spell') runSpellCheck(f.extra || '', { answered: pre });
      else if (f.instruction) runInstruction(f.instruction, { answered: pre });
    });
    m.appendChild(again);
    sync();
    $('g-log').appendChild(m);
    scrollLog();
    return m;
  }

  function showRunQuestions(followUp) {
    if (!runQuestions.length) return;
    const entry = pushEntry({ t: 'question', items: runQuestions, followUp });
    for (const q of runQuestions) askedThisRun.add(topicKey(q));
    runQuestions = [];
    renderQuestionCard(entry);
  }

  function attachTurnApply(m, turn) {
    const btn = el('button', 'g-link g-turn-apply', '');
    btn.type = 'button';
    btn.dataset.turn = turn;
    btn.title = '이 지시에서 나온 제안 중 아직 적용 안 된 것을 모두 적용합니다';
    btn.addEventListener('click', () => applyAllPending(turn));
    m.append(document.createTextNode(' '), btn);
    updateApplyAll();
  }

  function systemMsg(text, error, persist) {
    // "팀장 · ..."은 팀장(계획·규칙) 메시지로 따로 보여 준다
    const lead = /^팀장 · /.test(String(text || ''));
    pushEntry({ t: 'system', text, error: !!error }, persist);
    const body = String(text || '');
    const cut = lead ? body.indexOf('\n') : -1;
    let m;
    if (cut > 0) {
      // 팀장 메시지는 한 줄 요약만 보이고, 작업 요령·규칙은 눌러야 펼친다
      m = el('details', 'g-msg g-msg-system g-msg-lead');
      m.append(el('summary', '', body.slice(0, cut)), el('div', 'g-lead-more', body.slice(cut + 1)));
    } else {
      m = el('div', 'g-msg g-msg-system' + (error ? ' g-err' : '') + (lead ? ' g-msg-lead' : ''), text);
    }
    $('g-log').appendChild(m);
    scrollLog();
    return m;
  }

  function userMsg(text, persist) {
    pushEntry({ t: 'user', text }, persist);
    if (persist !== false) requestAnimationFrame(() => jumpToBottom(false));
    $('g-log').appendChild(el('div', 'g-msg g-msg-user', text));
    scrollLog();
  }

  function agentMsg(agent, who, restored) {
    const entry = restored || pushEntry({ t: 'agent', agent, who, text: '', pending: true, docId: '', edits: [], turn: currentTurn });
    const m = el('div', 'g-msg g-msg-agent' + (agent < 0 ? ' g-msg-rule' : ''));
    m.style.setProperty('--agent', agent < 0 ? '#80868b' : AGENT_COLORS[agent % AGENT_COLORS.length]);
    // who: "에이전트 N · 문서 · i/n · 구간 첫 줄" → 머리줄(이름·위치)과 인용 한 줄로 나눠 보여 준다
    const parts = String(who || '').split(' · ');
    const head = el('div', 'g-agent-head');
    head.append(el('span', 'g-avatar', agent < 0 ? '규' : String(agent + 1)), el('span', 'g-agent-name', parts[0] || ''), el('span', 'g-agent-where', parts.slice(1, 3).join(' · ')));
    m.appendChild(head);
    if (parts.length > 3) m.appendChild(el('div', 'g-agent-quote', parts.slice(3).join(' · ')));
    const text = el('div', 'g-bubble-text');
    const typing = el('span', 'g-typing');
    typing.append(el('i'), el('i'), el('i'));
    text.appendChild(typing);
    m.appendChild(text);
    $('g-log').appendChild(m);
    scrollLog();
    return { root: m, bubble: m, text, entry };
  }

  function buildEditItem(card, edit, auto) {
    const item = el('div', 'g-edit');
    const diff = el('div', 'g-edit-diff');
    diff.append(el('del', '', edit.src), el('span', 'g-edit-arrow', '→'), el('ins', '', edit.dst || '(삭제)'));
    item.appendChild(diff);
    if (edit.reason) {
      const why = el('div', 'g-edit-why');
      appendWithRefs(why, (edit.category ? '[' + edit.category + '] ' : '') + edit.reason, edit.refs, card);
      item.appendChild(why);
    }
    const row = el('div', 'g-edit-row');
    const state = el('span', 'g-edit-state', auto ? '적용 대기' : '');
    const show = el('button', 'g-link', '위치');
    show.type = 'button';
    show.title = '문서에서 이 문구를 선택합니다';
    show.addEventListener('click', async () => {
      // 적용됐으면 고친 문구부터, 아니면 원문부터 찾는다(적용 실패로 보였지만 실제로 바뀐 경우도 찾게 둘 다 보낸다)
      const first = edit.state === 'applied' ? edit.dst : edit.src;
      const second = edit.state === 'applied' ? edit.src : edit.dst;
      show.disabled = true;
      // 그 문서 칸을 격자에서 보이게 하고, 내려 둔 칸이면 불러오는 동안 그렇다고 알린다
      revealCard(card);
      const prevState = edit.stateEl.textContent;
      const waiting = card.unloaded || !card.ready;
      if (waiting) edit.stateEl.textContent = '문서 불러오는 중…';
      const res = await rpc(card, 'locate', { src: first || second, alts: [second].filter(Boolean), hint: edit.hint }, 15000);
      if (waiting && edit.stateEl.textContent === '문서 불러오는 중…') edit.stateEl.textContent = prevState;
      show.disabled = false;
      trace('locate', card.doc.name + ' ' + JSON.stringify({ res, unloaded: !!card.unloaded, visible: card.visible, ready: card.ready, state: edit.state }));
      if (!res.ok) flashState(edit, res.error === 'timeout' ? '문서가 응답하지 않음 · ↻로 칸을 다시 불러오세요' : res.error === 'frame_unavailable' ? '이 문서 칸이 격자에 없습니다' : '문서에서 찾지 못함');
      else if (res.approx) flashState(edit, '문구가 바뀌어 원래 자리 근처로 갔습니다');
      else if (edit.state === 'failed' && res.matched === edit.dst) {
        // 실패로 표시됐지만 문서에는 이미 고친 문구가 있다 — 적용됨으로 바로잡는다
        markApplied(card, edit);
      }
    });
    const apply = el('button', 'g-link', '적용');
    apply.type = 'button';
    apply.addEventListener('click', () => queueApply(card, edit));
    row.append(state, show, apply);
    item.appendChild(row);
    Object.assign(edit, { item, stateEl: state, applyBtn: apply, state: 'proposed' });
    return item;
  }

  function flashState(edit, text) {
    const prev = edit.stateEl.textContent;
    edit.stateEl.textContent = text;
    clearTimeout(edit.flashTimer);
    edit.flashTimer = setTimeout(() => { if (edit.stateEl.textContent === text) edit.stateEl.textContent = prev; }, 2500);
  }

  function markApplied(card, edit) {
    if (edit.state === 'applied') return;
    edit.state = 'applied';
    edit.item.classList.remove('g-failed');
    edit.item.classList.add('g-applied');
    edit.stateEl.textContent = '✓ 적용됨';
    edit.applyBtn.disabled = true;
    card.counts.applied++;
    updateMeta(card);
    saveLog();
    updateJump();
  }

  function queueApply(card, edit, agentCursor) {
    if (edit.state === 'applied' || edit.state === 'applying' || edit.state === 'queued') return Promise.resolve();
    // 사람이 누른 [적용]만 '최근 적용'으로 기억한다(바로 적용 모드의 자동 적용은 빼고)
    if (!agentCursor) {
      lastAppliedItem = edit.item;
      edit.pressedAt = Date.now();
      updateJump();
    }
    edit.state = 'queued';
    edit.applyBtn.disabled = true;
    edit.stateEl.textContent = '적용 대기';
    const gen = stopGen;
    const run = card.applyChain.then(async () => {
      if (gen !== stopGen) {
        edit.state = 'proposed';
        edit.applyBtn.disabled = false;
        edit.stateEl.textContent = '멈춤';
        return;
      }
      edit.state = 'applying';
      edit.stateEl.textContent = '적용 중…';
      card.applying = (card.applying || 0) + 1;
      const res = await rpc(card, 'applyEdit', { src: edit.src, dst: edit.dst, hint: edit.hint, agent: agentCursor || null }, 45000);
      let ok = res.ok;
      if (!ok && edit.dst && edit.dst !== edit.src) {
        // 시간 초과나 검증 실패여도 실제로는 바뀌었을 수 있다 — 원문은 사라지고 고친 문구가 그 자리에 있으면 적용된 것이다
        const probe = await rpc(card, 'probe', { src: edit.src, dst: edit.dst, hint: edit.hint }, 15000);
        ok = !!(probe.ok && probe.dst && !probe.src);
      }
      if (ok) {
        edit.state = 'applied';
        edit.item.classList.remove('g-failed');
        edit.item.classList.add('g-applied');
        edit.stateEl.textContent = '✓ 적용됨';
        card.counts.applied++;
        updateMeta(card);
      } else {
        edit.state = 'failed';
        edit.item.classList.add('g-failed');
        edit.applyBtn.disabled = false;
        edit.stateEl.textContent = res.error === 'not_found' ? '문서에서 찾지 못함(이미 바뀜?)' : '적용 실패 · 다시 시도';
      }
      updateJump();
      card.applying = Math.max(0, (card.applying || 1) - 1);
      if (!card.applying) scheduleUnload(card);
      saveLog();
    });
    card.applyChain = run.catch(() => {});
    return run;
  }

  // ---------- 구간 나누기 ----------

  function looksLikeHeading(line) {
    const s = line.trim();
    if (!s || s.length > 60) return false;
    if (/^(\d+(\.\d+)*|[0-9]+장|PART\s*\d+|부록)\s*\S/.test(s) && !/[.。!?]$/.test(s)) return true;
    return false;
  }

  // 제목처럼 보이는 줄에서 끊되 너무 짧으면 붙이고, 너무 길면 문단 경계에서 자른다.
  function buildChunks(text) {
    const chunks = [];
    let cur = null;
    let pos = 0;
    for (const line of text.split('\n')) {
      const start = pos;
      const end = pos + line.length;
      pos = end + 1;
      if (!line.trim()) continue;
      const len = cur ? end - cur.start : 0;
      const cut = cur && ((looksLikeHeading(line) && len >= CHUNK_MIN) || len >= CHUNK_MAX);
      if (!cur || cut) {
        if (cur) chunks.push(cur);
        cur = { start, end };
      } else {
        cur.end = end;
      }
    }
    if (cur) chunks.push(cur);
    return chunks;
  }

  function firstLine(text) {
    return text.trim().split('\n')[0].replace(/\s+/g, ' ').slice(0, 30);
  }

  // ---------- 실행 ----------

  function setBusy(on) {
    busy = on;
    updateApplyAll();
    $('g-send').disabled = on;
    $('g-stop').hidden = !on;
    $('g-conc').disabled = on;
    for (const chip of document.querySelectorAll('.g-chip')) chip.disabled = on;
    // 질문 카드 버튼은 작업 중에 꺼 두므로, 작업이 끝나면 다시 계산한다
    for (const q of document.querySelectorAll('.g-msg-question')) if (q.syncQuestion) q.syncQuestion();
  }

  function setProgress(done, total) {
    $('g-progress-fill').style.width = total ? Math.round(done / total * 100) + '%' : '0';
  }

  function unpinTargets(targets) {
    for (const c of targets) {
      c.pinned = false;
      scheduleUnload(c);
    }
  }

  // ---------- 맞춤법 규칙(토이타입 규칙 엔진) ----------
  // 격자 칸은 가볍게 띄우느라 규칙 검사를 하지 않는다. 기계적 검사는 /맞춤법(룰베이스)만 한다.
  // 일반 지시(전체 교정 등)는 규칙 결과를 쓰지 않는다 — 에이전트는 프롬프트의 하우스 표기 규칙만 따른다.
  const RULE_CANDIDATES_MAX = 120;
  let rulesReady = null;
  function ensureRules() {
    if (rulesReady) return rulesReady;
    rulesReady = new Promise(resolve => {
      const engine = globalThis.TypoEngine;
      if (!engine) { resolve(false); return; }
      chrome.runtime.sendMessage({ type: 'typo:getRules' }, res => {
        if (chrome.runtime.lastError || !res || !res.ok || !res.rules || !Array.isArray(res.rules.categories)) {
          rulesReady = null;
          resolve(false);
          return;
        }
        chrome.storage.local.get('settings', items => {
          // 버블과 같이 설정에서 끈 범주는 빼고, 복사용 문장 제안 범주는 쓰지 않는다
          const off = (items && items.settings && items.settings.docsCategories) || {};
          const ids = res.rules.categories.map(c => c.id).filter(id => id !== 'ai-sentence-suggestions' && off[id] !== false);
          try {
            engine.init(res.rules, ids);
            resolve(true);
          } catch (_) {
            rulesReady = null;
            resolve(false);
          }
        });
      });
    });
    return rulesReady;
  }

  async function ruleCandidates(text) {
    // 엔진 스크립트가 다시 실행돼 초기화가 풀렸으면 다시 불러온다
    if (rulesReady && globalThis.TypoEngine && !globalThis.TypoEngine.isReady()) rulesReady = null;
    if (!(await ensureRules())) return [];
    let result;
    try { result = globalThis.TypoEngine.scan(text, { limit: RULE_CANDIDATES_MAX }); } catch (_) { return []; }
    return (result.findings || []).filter(f => f.src !== f.dst).map((f, i) => ({
      id: i, start: f.start, end: f.end, src: f.src, dst: f.dst, cat: f.cat,
      context: text.slice(Math.max(0, f.start - 24), f.start) + '⟦' + f.src + '⟧' + text.slice(f.end, f.end + 24)
    }));
  }

  // 규칙이 잡은 곳을 수정 제안으로 만든다. 짧은 문구는 위치를 짚게 앞뒤 글자를 붙여 넓히고,
  // 넓힌 범위가 겹치는 이웃 규칙은 한 수정으로 합친다(따로 적용하면 앞 수정 뒤 원문을 못 찾는다)
  function buildRuleEdits(task) {
    const text = task.card.text.slice(task.chunk.start, task.chunk.end);
    const groups = [];
    for (const r of task.rules || []) {
      let a = r.start;
      let b = r.end;
      while (b - a < 6 && a > 0 && text[a - 1] !== '\n') a--;
      while (b - a < 10 && b < text.length && text[b] !== '\n') b++;
      const last = groups[groups.length - 1];
      if (last && a < last.b) { last.b = Math.max(last.b, b); last.parts.push(r); }
      else groups.push({ a, b, parts: [r] });
    }
    return groups.map(g => ({
      src: text.slice(g.a, g.b),
      dst: ruleDst(text, g.a, g.b, g.parts),
      reason: '규칙: ' + g.parts.map(r => r.src + ' → ' + r.dst).join(', '),
      category: '맞춤법',
      hint: task.chunk.start + g.a,
      rule: { a: g.a, b: g.b, parts: g.parts.map(r => ({ id: r.id, start: r.start, end: r.end, dst: r.dst })) }
    }));
  }

  function ruleDst(text, a, b, parts) {
    let dst = '';
    let pos = a;
    for (const r of parts) { dst += text.slice(pos, r.start) + r.dst; pos = r.end; }
    return dst + text.slice(pos, b);
  }

  // 1) 규칙 검사는 기계적이라 바로 끝난다
  async function scanRules(queues) {
    for (const q of queues) {
      for (const t of q) t.rules = await ruleCandidates(t.card.text.slice(t.chunk.start, t.chunk.end));
    }
  }

  // 2) 문서마다 AI가 규칙 결과를 거른다: 오탐은 무시, 애매하면 질문, 나머지는 반영
  async function triageRules(queues, conc) {
    const jobs = queues.map(q => {
      const candidates = [];
      let gid = 0;
      for (const t of q) {
        for (const r of t.rules || []) {
          r.gid = gid++;
          // 확정은 오탐(코드·고유명사 등)만 거르고, 권장·맥락은 검토해서 애매하면 묻는다
          r.verdict = 'unchecked';
          candidates.push({ id: r.gid, level: r.cat === 'fix' || r.cat === 'context' ? r.cat : 'prefer', source: r.src, replacement: r.dst, context: r.context });
        }
      }
      return { q, candidates };
    }).filter(j => j.candidates.length);
    if (!jobs.length) return;
    const wait = systemMsg('맞춤법 규칙 결과를 AI가 거르는 중… (문서 ' + jobs.length + '개)', false, false);
    let next = 0;
    const worker = async () => {
      while (next < jobs.length && !stopRequested) {
        const job = jobs[next++];
        const card = job.q[0].card;
        const requestId = 'grid-triage-' + card.doc.id.slice(0, 8) + '-' + Date.now().toString(36);
        liveRequests.add(requestId);
        const res = await send({ type: 'typo:aiBridge', action: 'ruleTriage', requestId, payload: { timeoutMs: 180000, document: { title: card.doc.name, candidates: job.candidates, decisions: decisions() } } });
        liveRequests.delete(requestId);
        if (!res || !res.ok) continue; // 거르지 못한 문서는 '검토 안 됨'으로 제안만 한다
        const ignore = new Set(res.ignore || []);
        const held = new Set();
        for (const q of res.questions || []) for (const id of q.ids || []) held.add(id);
        collectQuestions(res.questions);
        for (const t of job.q) for (const r of t.rules || []) r.verdict = ignore.has(r.gid) ? 'ignore' : held.has(r.gid) ? 'held' : 'apply';
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(conc, jobs.length)) }, worker));
    wait.remove();
  }

  // 같은 문서에 이전 지시에서 이미 올린 같은 수정이면 다시 올리지 않는다
  function alreadyProposed(card, e) {
    for (const entry of logEntries) {
      if (entry.t !== 'agent' || entry.docId !== card.doc.id || entry.turn === currentTurn || !Array.isArray(entry.edits)) continue;
      for (const x of entry.edits) {
        if (x.src === e.src && x.dst === e.dst && x.state !== 'rejected' && Math.abs((x.hint || 0) - (e.hint || 0)) < 400) return true;
      }
    }
    return false;
  }

  // 3) 거른 결과 중 반영할 것만 문서마다 한 메시지로 묶어 올린다(바로 적용 모드면 바로 적용)
  function postRuleEdits(queues, auto) {
    for (const q of queues) {
      const card = q[0].card;
      const all = [];
      let ignored = 0;
      let held = 0;
      let unchecked = false;
      for (const t of q) {
        const rules = t.rules || [];
        ignored += rules.filter(r => r.verdict === 'ignore').length;
        held += rules.filter(r => r.verdict === 'held').length;
        if (rules.some(r => r.verdict === 'unchecked')) unchecked = true;
        t.ruleEdits = buildRuleEdits(Object.assign({}, t, { rules: rules.filter(r => r.verdict === 'apply' || r.verdict === 'unchecked') }))
          .filter(e => !alreadyProposed(card, e));
        all.push(...t.ruleEdits);
      }
      if (!all.length && !ignored && !held) continue;
      const msg = agentMsg(-1, '맞춤법 규칙 · ' + card.doc.name);
      const parts = [];
      if (all.length) parts.push((auto && !unchecked ? '반영 ' : '고칠 곳 ') + all.length + '개');
      if (ignored) parts.push('오탐 ' + ignored + '개 무시');
      if (held) parts.push('질문으로 보류 ' + held + '개');
      if (unchecked) parts.push('AI가 거르지 못해 검토 필요');
      msg.text.textContent = parts.join(' · ');
      Object.assign(msg.entry, { pending: false, docId: card.doc.id, text: msg.text.textContent, edits: all });
      if (all.length) renderRuleBox(msg, card, all, auto && !unchecked);
      card.counts.proposed += all.length;
      updateMeta(card);
      if (auto && !unchecked) for (const e of all) queueApply(card, e);
    }
    saveLog();
  }

  // 규칙 수정은 하나하나 보이지 않고, 규칙별 개수와 [모두 적용] 하나로 보여 준다(펼치면 하나씩)
  function renderRuleBox(msg, card, edits, auto) {
    const box = el('div', 'g-rule-box');
    const counts = new Map();
    for (const e of edits) {
      for (const p of String(e.reason || '').replace(/^규칙: /, '').split(', ')) counts.set(p, (counts.get(p) || 0) + 1);
    }
    if (!auto) {
      const all = el('button', 'g-apply-all g-rule-apply', '모두 적용 (' + edits.length + '개)');
      all.type = 'button';
      all.addEventListener('click', () => {
        all.disabled = true;
        for (const e of edits) if (e.state === 'proposed' || e.state === 'failed') queueApply(card, e);
      });
      box.appendChild(all);
    }
    const more = el('details', 'g-rule-more');
    more.appendChild(el('summary', '', '규칙별 보기 (' + counts.size + '종)'));
    const pats = el('div', 'g-rule-pats');
    for (const [p, n] of Array.from(counts).sort((x, y) => y[1] - x[1])) pats.appendChild(el('div', 'g-rule-pat', p + (n > 1 ? '  ×' + n : '')));
    more.appendChild(pats);
    const each = el('details', 'g-rule-each');
    each.appendChild(el('summary', '', '하나씩 보기'));
    const list = el('div', 'g-edits');
    for (const e of edits) list.appendChild(buildEditItem(card, e, auto));
    each.appendChild(list);
    more.appendChild(each);
    box.appendChild(more);
    msg.bubble.appendChild(box);
    updateApplyAll();
  }

  function markRuleRejected(edit, text) {
    edit.state = 'rejected';
    edit.item.classList.add('g-rejected');
    edit.stateEl.textContent = text;
    edit.applyBtn.disabled = false;
  }

  // ---------- 첫 언급(원어 병기·첫 소개) ----------
  // 원어 병기와 "~라고 합니다" 같은 첫 소개는 책 전체에서 처음 나올 때만 한다.
  // 이전 장(장 번호가 더 작은 폴더 문서)의 본문에서 병기를 모아, 구간 에이전트가 반복 병기를 찾게 한다.
  // 격자에 안 띄운 장은 export로 읽고, 그래도 못 읽은 장은 이름을 알린다.
  const docTextCache = new Map(); // docId -> { text, at }
  const DOC_TEXT_TTL_MS = 10 * 60 * 1000;

  function chapterNo(name) {
    const m = String(name || '').match(/(\d+)\s*장/) || String(name || '').match(/^\s*(\d+)/);
    return m ? Number(m[1]) : null;
  }

  // 병기는 위첨자라 평문에서는 한글 바로 뒤에 붙어 나온다(해시 테이블hash table). 괄호 병기도 잡는다.
  const GLOSS_RE = /([가-힣]+(?: [가-힣]+){0,2})(?:\(([A-Za-z][A-Za-z0-9 .\-]{1,40}[A-Za-z0-9])\)|([A-Za-z][A-Za-z0-9\-]*(?: [A-Za-z][A-Za-z0-9\-]*){0,4}))/g;
  function extractGlosses(text) {
    const out = [];
    const seen = new Set();
    for (const m of String(text || '').matchAll(GLOSS_RE)) {
      const en = (m[2] || m[3] || '').trim();
      if (en.length < 3 || !/[a-z]/i.test(en) || /^[A-Z0-9_]+$/.test(en)) continue; // 약어·상수는 병기로 보지 않는다
      const key = en.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ko: m[1].split(' ').slice(-2).join(' '), en, at: m.index });
    }
    return out;
  }

  async function docPlainText(doc) {
    const card = cards.find(c => c.doc.id === doc.id);
    if (card && typeof card.text === 'string' && card.text) return card.text;
    const hit = docTextCache.get(doc.id);
    if (hit && Date.now() - hit.at < DOC_TEXT_TTL_MS) return hit.text;
    const a = session.authuser > 0 ? 'u/' + session.authuser + '/' : '';
    const res = await fetch('https://docs.google.com/document/' + a + 'd/' + encodeURIComponent(doc.id) + '/export?format=txt');
    if (!res.ok) throw new Error('export ' + res.status);
    const text = (await res.text()).replace(/^﻿/, '').replace(/\r/g, '');
    docTextCache.set(doc.id, { text, at: Date.now() });
    return text;
  }

  // 대상 문서마다: 이전 장의 병기 목록과 못 읽은 장 이름
  async function collectFirstMentions(queues) {
    const all = (Array.isArray(session.pool) ? session.pool : []).concat(session.docs || []);
    const byId = new Map(all.map(d => [d.id, d]));
    const result = new Map();
    const glossOf = new Map(); // docId -> glosses
    const unreadable = new Set();
    for (const q of queues) {
      const card = q[0].card;
      const no = chapterNo(card.doc.name);
      const earlier = no === null ? [] : Array.from(byId.values()).filter(d => d.id !== card.doc.id && chapterNo(d.name) !== null && chapterNo(d.name) < no)
        .sort((x, y) => chapterNo(x.name) - chapterNo(y.name));
      const list = [];
      const missing = [];
      for (const d of earlier) {
        if (!glossOf.has(d.id) && !unreadable.has(d.id)) {
          try { glossOf.set(d.id, extractGlosses(await docPlainText(d))); } catch (_) { unreadable.add(d.id); }
        }
        if (unreadable.has(d.id)) { missing.push(d.name); continue; }
        for (const g of glossOf.get(d.id)) list.push({ term: g.ko, en: g.en, where: d.name });
      }
      result.set(card.doc.id, { earlier: list, missing, own: extractGlosses(card.text), numbered: no !== null });
    }
    return result;
  }

  // 구간에 넘길 것: 이 구간에 다시 나오는 용어 중 이미 앞에서(이전 장 또는 같은 장 앞부분) 병기·소개된 것
  function firstMentionsFor(task, info) {
    if (!info) return { firstMentions: [], unreadChapters: [] };
    const text = task.card.text.slice(task.chunk.start, task.chunk.end);
    const low = text.toLowerCase();
    const seen = new Set();
    const out = [];
    const push = (g, where) => {
      const key = g.en.toLowerCase();
      if (seen.has(key) || out.length >= 60) return;
      if (!low.includes(key) && !text.includes(g.term)) return;
      seen.add(key);
      out.push({ term: g.term, en: g.en, where });
    };
    for (const g of info.earlier) push(g, g.where);
    for (const g of info.own) if (g.at < task.chunk.start) push(g, '이 장 앞부분');
    return { firstMentions: out, unreadChapters: info.missing };
  }

  // 문서 하나의 구간들을 한 구간으로 합친다(한 번에 볼 수 있는 길이일 때만)
  const WHOLE_MAX_CHARS = 12000;
  function mergeWholeDoc(queue) {
    if (queue.length < 2) return queue;
    const first = queue[0];
    const last = queue[queue.length - 1];
    if (last.chunk.end - first.chunk.start > WHOLE_MAX_CHARS) return queue;
    return [{ card: first.card, chunk: { start: first.chunk.start, end: last.chunk.end }, idx: 0, count: 1 }];
  }

  function renderShare(msg, share) {
    // 에이전트끼리 주고받는 약속이라 접어 두고, 눌러야 펼친다
    const box = el('details', 'g-share');
    box.appendChild(el('summary', 'g-share-label', '팀에 공유 ' + share.length + '개'));
    for (const note of share) box.appendChild(el('div', 'g-share-note', note));
    msg.bubble.appendChild(box);
  }

  async function leadRequest(action, document, label) {
    const requestId = 'grid-' + action + '-' + Date.now().toString(36);
    liveRequests.add(requestId);
    const wait = systemMsg('팀장 · ' + label + '…', false, false);
    const res = await send({ type: 'typo:aiBridge', action, requestId, payload: { timeoutMs: 180000, document } });
    liveRequests.delete(requestId);
    wait.remove();
    if (!res || !res.ok) {
      if (!stopRequested) systemMsg('팀장 · ' + label + ' 실패 — 계획 없이 진행합니다 (' + (res && (res.message || res.error) || '오류') + ')', false, false);
      return null;
    }
    return res;
  }

  async function planWork(instruction, queues) {
    const docs = queues.map(q => ({
      id: q[0].card.doc.id,
      title: q[0].card.doc.name,
      sections: q.map(t => {
        const text = t.card.text.slice(t.chunk.start, t.chunk.end);
        return { i: t.idx, chars: text.length, head: firstLine(text), preview: text.replace(/\s+/g, ' ').slice(0, 200) };
      })
    }));
    const res = await leadRequest('planWork', { instruction, docs, decisions: decisions(), history: history.slice(-HISTORY_TURNS) }, '지시를 보고 계획 세우는 중');
    if (!res || !res.plan) return null;
    collectQuestions(res.questions);
    return res.plan;
  }

  async function surveyRules(instruction, queues, plan) {
    const docs = queues.map(q => ({
      title: q[0].card.doc.name,
      text: q.map(t => t.card.text.slice(t.chunk.start, t.chunk.end)).join('\n')
    }));
    const res = await leadRequest('surveyRules', { instruction, docs, plan, decisions: decisions() }, '원고를 훑어 공통 규칙 정하는 중');
    if (!res) return null;
    return { rules: Array.isArray(res.rules) ? res.rules : [], note: res.note || '', questions: res.questions || [] };
  }

  // 문서 본문을 칸 안의 편집기에서 직접 읽어 구간으로 나눈다(적용할 때 쓰는 위치와 같은 기준)
  async function readQueues(targets) {
    const queues = [];
    for (const card of targets.filter(c => c.ready)) {
      const res = await rpc(card, 'getText', {}, 30000);
      if (!res.ok) {
        systemMsg(card.doc.name + ' 본문을 읽지 못했습니다', true);
        continue;
      }
      card.text = res.text;
      const chunks = buildChunks(res.text);
      queues.push(chunks.map((chunk, idx) => ({ card, chunk, idx, count: chunks.length })));
    }
    return queues;
  }

  // /맞춤법(룰베이스): 규칙 엔진으로 기계적으로 검사하고, AI는 결과를 거르기만 한다(오탐 무시·애매하면 질문).
  // 일반 지시(전체 교정 등)는 이 단계를 거치지 않는다.
  async function runSpellCheck(extra, opts) {
    const answered = !!(opts && opts.answered);
    if (busy) return;
    const targets = cards.filter(c => c.pick.checked);
    if (!targets.length) { systemMsg('검사할 문서를 하나 이상 고르세요', true); return; }
    if (!answered) userMsg('맞춤법(룰베이스)' + (extra ? '\n' + extra : ''));
    runQuestions = [];
    askedThisRun = new Set();
    currentTurn = 'turn-' + Date.now().toString(36);
    const turn = currentTurn;
    stopRequested = false;
    setBusy(true);
    const auto = $('g-auto').checked;
    const agents = Number($('g-conc').value) || 3;
    for (const c of targets) { c.pinned = true; clearTimeout(c.unloadTimer); if (c.unloaded) loadCard(c); }
    const notReady = targets.filter(c => !c.ready);
    if (notReady.length) systemMsg('문서가 열리기를 기다리는 중… (' + notReady.length + '개)', false, false);
    await Promise.all(notReady.map(c => c.readyPromise));
    const finish = () => { currentTurn = ''; unpinTargets(targets); setBusy(false); };
    const queues = await readQueues(targets);
    await scanRules(queues);
    if (queues.length && !stopRequested) await triageRules(queues, agents);
    if (stopRequested) { systemMsg('멈췄습니다.'); finish(); return; }
    // 애매해서 보류한 규칙은 반영하기 전에 묻는다. 답하면 그 결정대로 다시 거른다
    if (runQuestions.length && !answered) {
      systemMsg('맞춤법(룰베이스) · 정할 것이 ' + runQuestions.length + '개 있습니다. 답하면 그대로 반영합니다.');
      finish();
      showRunQuestions({ kind: 'spell', extra: extra || '', preflight: true });
      return;
    }
    postRuleEdits(queues, auto);
    if (auto) await Promise.all(targets.map(c => c.applyChain));
    const total = logEntries.filter(e => e.t === 'agent' && e.turn === turn && Array.isArray(e.edits)).reduce((n, e) => n + e.edits.length, 0);
    history.push({ instruction: '맞춤법(룰베이스)' + (extra ? ': ' + extra.slice(0, 200) : ''), result: '규칙 수정 ' + total + '곳', notes: [], changes: [] });
    history = history.slice(-HISTORY_TURNS);
    if (sessionId) chrome.storage.local.set({ ['grid:' + sessionId + ':history']: history }).catch(() => {});
    const endMsg = systemMsg('맞춤법(룰베이스) 끝 · 고칠 곳 ' + total + '개');
    if (pendingEdits(turn).length) {
      logEntries[logEntries.length - 1].turnApply = turn;
      attachTurnApply(endMsg, turn);
      saveLog();
    }
    finish();
    showRunQuestions({ kind: 'spell', extra: extra || '' });
  }

  // opts.answered: 시작 전 질문에 답하고 다시 시작한 것 — 또 묻지 않고(새 질문은 끝에 모아) 바로 작업한다
  async function runInstruction(instruction, opts) {
    const answered = !!(opts && opts.answered);
    if (busy) return;
    const targets = cards.filter(c => c.pick.checked);
    if (!targets.length) {
      systemMsg('작업할 문서를 하나 이상 체크하세요', true);
      return;
    }
    if (!answered) userMsg(instruction);
    runQuestions = [];
    askedThisRun = new Set();
    currentTurn = 'turn-' + Date.now().toString(36);
    const turn = currentTurn;
    stopRequested = false;
    setBusy(true);
    const auto = $('g-auto').checked;
    const agents = Number($('g-conc').value) || 3;
    // 맡긴 칸은 화면 밖이어도 내리지 않고, 내려 둔 칸은 다시 불러온다
    for (const c of targets) {
      c.pinned = true;
      clearTimeout(c.unloadTimer);
      if (c.unloaded) loadCard(c);
    }
    const notReady = targets.filter(c => !c.ready);
    if (notReady.length) systemMsg('문서가 열리기를 기다리는 중… (' + notReady.length + '개)', false, false);
    await Promise.all(notReady.map(c => c.readyPromise));

    const queues = await readQueues(targets);
    // 팀장 단계: 지시와 목차를 보고 손댈 구간을 고르고, 모두가 따를 작업 요령을 정한다.
    // 일관성이 중요한 지시면 원고를 먼저 훑어 규칙을 정하고, 애매한 건 손대기 전에 묻는다.
    const team = { plan: null, board: [] };
    // 기계적 맞춤법 검사는 /맞춤법(룰베이스)로 따로 한다. 일반 지시는 규칙 결과를 쓰지 않는다
    const [plan, mentions] = queues.length && !stopRequested
      ? await Promise.all([planWork(instruction, queues), collectFirstMentions(queues).catch(() => new Map())])
      : [null, new Map()];
    team.mentions = mentions;
    {
      // 첫 언급 확인 범위를 알린다 — 못 읽은 이전 장이 있으면 이름을 밝힌다
      const missing = new Set();
      let unnumbered = 0;
      for (const v of mentions.values()) { v.missing.forEach(n => missing.add(n)); if (!v.numbered) unnumbered++; }
      if (missing.size) systemMsg('첫 언급(원어 병기) 확인 · 이전 장 중 ' + Array.from(missing).join(', ') + '은(는) 읽지 못해 그 장과의 중복 병기는 확인하지 못했습니다', false);
      else if (unnumbered) systemMsg('첫 언급(원어 병기) 확인 · 장 번호가 없는 문서 ' + unnumbered + '개는 이전 장을 알 수 없어 그 문서 안에서만 확인합니다', false, false);
    }
    let planned = queues;
    if (plan) {
      if (plan.scope === 'targeted') {
        const pick = new Map(plan.targets.map(t => [t.doc, new Set(t.sections)]));
        planned = queues.map(q => q.filter(t => pick.has(t.card.doc.id) && pick.get(t.card.doc.id).has(t.idx))).filter(q => q.length);
      }
      team.plan = { brief: plan.brief, rules: [] };
      const picked = planned.reduce((n, q) => n + q.length, 0);
      const all = queues.reduce((n, q) => n + q.length, 0);
      systemMsg('팀장 · ' + (plan.note || '계획을 세웠습니다') + (plan.scope === 'targeted' ? ' (구간 ' + picked + '/' + all + '개)' : '') + (plan.brief ? '\n작업 요령: ' + plan.brief : ''));
      if (!stopRequested && plan.needsSurvey && planned.length) {
        const survey = await surveyRules(instruction, planned, team.plan);
        if (survey) {
          team.plan.rules = survey.rules;
          if (survey.rules.length || survey.note) systemMsg('팀장 · ' + (survey.note || '규칙을 정했습니다') + (survey.rules.length ? '\n' + survey.rules.map(r => '· ' + r).join('\n') : ''));
          collectQuestions(survey.questions);
        }
      }
      // 편집자가 골라야 할 것(계획·규칙 단계에서 나온 질문)은 고치기 전에 묻는다
      if (runQuestions.length && !answered && !stopRequested) {
        systemMsg('팀장 · 시작 전에 정할 것이 ' + runQuestions.length + '개 있습니다. 답하면 그대로 시작합니다.');
        currentTurn = '';
        unpinTargets(targets);
        setBusy(false);
        showRunQuestions({ kind: 'text', instruction, preflight: true });
        return;
      }
      // 원고 전체 일관성이 필요한데 문서가 한 번에 볼 만큼 짧으면 나누지 않고 한 에이전트가 통째로 본다
      if (plan.scope === 'whole') planned = planned.map(q => mergeWholeDoc(q));
    }
    if (stopRequested) {
      systemMsg('멈췄습니다.');
      currentTurn = '';
      unpinTargets(targets);
      setBusy(false);
      return;
    }
    const tasks = [];
    for (let round = 0; planned.some(q => round < q.length); round++) {
      for (const q of planned) if (round < q.length) tasks.push(q[round]);
    }
    for (const t of tasks) t.team = team;
    if (!tasks.length) {
      if (plan && plan.scope === 'targeted') systemMsg('팀장 · 이 지시로 손댈 구간이 없다고 판단했습니다');
      currentTurn = '';
      unpinTargets(targets);
      setBusy(false);
      return;
    }
    systemMsg('에이전트 ' + Math.min(agents, tasks.length) + '명이 문서 ' + planned.length + '개를 구간 ' + tasks.length + '개로 나눠 맡습니다' + (auto ? ' · 바로 적용' : ' · 제안 모드'));
    setProgress(0, tasks.length);

    let next = 0;
    let done = 0;
    let total = 0;
    let disabled = false;
    const agentLoop = async agent => {
      while (next < tasks.length && !stopRequested && !disabled) {
        const task = tasks[next++];
        const r = await runChunk(task, agent, instruction, auto);
        if (r === 'disabled') disabled = true;
        else total += r;
        done++;
        setProgress(done, tasks.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(agents, tasks.length) }, (_, a) => agentLoop(a)));
    for (const card of targets) setWorking(card, null);
    if (auto) await Promise.all(targets.map(c => c.applyChain));
    if (!disabled) recordTurn(instruction, tasks);
    if (disabled) systemMsg('AI 기능이 꺼져 있습니다 · 설정에서 [브릿지 · AI 기능 사용]을 켜고 로컬 브리지를 실행하세요', true);
    else {
      const endMsg = systemMsg((stopRequested ? '멈췄습니다 · ' : '끝 · ') + '고칠 곳 ' + total + '개' + (auto ? ' · 적용 ' + targets.reduce((n, c) => n + c.counts.applied, 0) + '개(누적)' : ''));
      if (total) {
        logEntries[logEntries.length - 1].turnApply = turn;
        attachTurnApply(endMsg, turn);
        saveLog();
      }
    }
    currentTurn = '';
    unpinTargets(targets);
    setBusy(false);
    if (!disabled) showRunQuestions({ kind: 'text', instruction });
  }

  function renderEdits(msg, card, edits, auto) {
    // 메시지(에이전트 한 구간) 단위 [모두 적용] — 이 메시지에서 아직 적용 안 된 제안만 적용한다
    if (!auto && edits.length > 1) {
      const all = el('button', 'g-apply-all g-rule-apply g-msg-apply', '');
      all.type = 'button';
      all.msgEdits = { card, edits };
      all.addEventListener('click', () => {
        if (busy) return;
        all.disabled = true;
        Promise.all(edits.filter(e => e.state === 'proposed' || e.state === 'failed').map(e => queueApply(card, e)))
          .then(updateApplyAll);
      });
      msg.bubble.appendChild(all);
    }
    const list = el('div', 'g-edits');
    for (const edit of edits) list.appendChild(buildEditItem(card, edit, auto));
    msg.bubble.appendChild(list);
    updateApplyAll();
  }

  // ---------- 전체 적용 ----------
  // 이 대화에서 아직 적용 안 된 제안(제안 상태·실패)을 문서마다 차례로 전부 적용한다.
  function pendingEdits(turn) {
    const out = [];
    for (const entry of logEntries) {
      if (entry.t !== 'agent' || !Array.isArray(entry.edits)) continue;
      if (turn && entry.turn !== turn) continue;
      const card = cards.find(c => c.doc.id === entry.docId);
      if (!card) continue; // [문서]에서 꺼 둔 문서는 건너뛴다
      for (const edit of entry.edits) {
        if (edit.item && (edit.state === 'proposed' || edit.state === 'failed')) out.push({ card, edit });
      }
    }
    return out;
  }

  function updateApplyAll() {
    const btn = $('g-apply-all');
    if (!btn) return;
    const n = pendingEdits().length;
    btn.hidden = n === 0;
    btn.textContent = '전체 적용 ' + n;
    btn.disabled = busy;
    for (const b of document.querySelectorAll('.g-turn-apply')) {
      const k = pendingEdits(b.dataset.turn).length;
      b.hidden = k === 0;
      b.textContent = '이 대화 모두 적용 ' + k;
      b.disabled = busy;
    }
    for (const b of document.querySelectorAll('.g-msg-apply')) {
      const k = b.msgEdits ? b.msgEdits.edits.filter(e => e.item && (e.state === 'proposed' || e.state === 'failed')).length : 0;
      b.hidden = k === 0;
      b.textContent = '모두 적용 (' + k + '개)';
      b.disabled = busy;
    }
  }

  async function applyAllPending(turn) {
    const todo = pendingEdits(typeof turn === 'string' ? turn : '');
    if (!todo.length || busy) return;
    const btn = $('g-apply-all');
    btn.disabled = true;
    systemMsg('아직 적용 안 된 ' + todo.length + '곳을 전부 적용합니다', false, false);
    // 문서마다 적용 줄이 따로 있어 문서끼리는 동시에, 한 문서 안에서는 차례로 돈다
    await Promise.all(todo.map(({ card, edit }) => queueApply(card, edit)));
    const left = pendingEdits().length;
    systemMsg('전체 적용 끝 · ' + (todo.length - left) + '곳 적용' + (left ? ' · 남은 ' + left + '곳은 실패나 멈춤' : ''), left > 0, false);
    updateApplyAll();
  }

  // 저장해 둔 채팅창을 다시 그린다. 적용된 제안은 적용됨으로, 진행 중이던 것은 제안으로 돌아온다.
  function restoreLog(saved) {
    let newest = 0;
    // 턴 표시가 없던 예전 대화는 사용자 지시를 기준으로 턴을 나눠 [이 대화 모두 적용]을 단다
    let inferredTurn = '';
    let userCount = 0;
    for (const e of saved.entries || []) {
      if (e.t === 'question') {
        const entry = { t: 'question', items: Array.isArray(e.items) ? e.items : [], followUp: e.followUp || {}, started: !!e.started };
        logEntries.push(entry);
        renderQuestionCard(entry);
        continue;
      }
      if (e.t === 'system') {
        const m = systemMsg(e.text, e.error);
        const turnApply = e.turnApply || (inferredTurn && /^(끝|멈췄습니다) · 고칠 곳 [1-9]/.test(String(e.text || '')) ? inferredTurn : '');
        if (turnApply) {
          logEntries[logEntries.length - 1].turnApply = turnApply;
          attachTurnApply(m, turnApply);
        }
      }
      else if (e.t === 'user') {
        userMsg(e.text);
        inferredTurn = 'restored-' + (++userCount);
      }
      else if (e.t === 'agent') {
        const entry = { t: 'agent', agent: Number(e.agent) || 0, who: String(e.who || ''), text: String(e.text || ''), pending: false, docId: e.docId, edits: [], turn: e.turn || inferredTurn, review: Array.isArray(e.review) ? e.review : undefined, format: Array.isArray(e.format) ? e.format : undefined };
        logEntries.push(entry);
        const msg = agentMsg(entry.agent, entry.who, entry);
        msg.text.textContent = entry.text;
        if (Array.isArray(e.share) && e.share.length) { entry.share = e.share; renderShare(msg, e.share); }
        const card = cards.find(c => c.doc.id === e.docId);
        if (entry.review) renderReviewRows(msg, card, entry.review);
        if (entry.format) renderFormatRows(msg, card, entry.format);
        if (Array.isArray(e.figure) && card) { entry.figure = e.figure; renderFigureRows(msg, card, e.figure); }
        const edits = (e.edits || []).map(x => Object.assign({}, x));
        entry.edits = edits;
        if (card && edits.length) {
          const states = edits.map(x => x.state);
          if (entry.agent < 0) renderRuleBox(msg, card, edits, false);
          else renderEdits(msg, card, edits, false);
          edits.forEach((edit, i) => {
            if (edit.pressedAt > newest) {
              newest = edit.pressedAt;
              lastAppliedItem = edit.item;
            }
            if (states[i] === 'applied') {
              edit.state = 'applied';
              edit.item.classList.add('g-applied');
              edit.stateEl.textContent = '✓ 적용됨';
              edit.applyBtn.disabled = true;
              card.counts.applied++;
            } else if (states[i] === 'rejected') {
              markRuleRejected(edit, edit.note || '오탐으로 제외');
            } else if (states[i] === 'failed') {
              edit.state = 'failed';
              edit.item.classList.add('g-failed');
              edit.stateEl.textContent = '적용 실패 · 다시 시도';
            } else if (edit.note) {
              edit.reviewed = true;
              edit.stateEl.textContent = edit.note;
            }
          });
          card.counts.proposed += edits.length;
          updateMeta(card);
        }
      }
    }
  }

  function applyOptions(o) {
    o = o || {};
    if (typeof o.auto === 'boolean') $('g-auto').checked = o.auto;
    if (o.conc) $('g-conc').value = String(o.conc);
    for (const c of cards) if ((o.unchecked || []).includes(c.doc.id)) c.pick.checked = false;
    for (const c of cards) if ((o.full || []).includes(c.doc.id)) setFullEditor(c, true, true);
    renderTargets();
  }

  async function runChunk(task, agent, instruction, auto) {
    const { card, chunk, idx, count } = task;
    const name = '에이전트 ' + (agent + 1);
    const where = card.doc.name + ' · ' + (idx + 1) + '/' + count;
    setWorking(card, agent, name);
    // 구간마다 새 에이전트 커서가 문서 안 구간 첫머리에 나타난다(공동 작업자 커서 모양)
    const cursor = { id: 'agent-' + agent + '-' + idx + '-' + Date.now().toString(36), label: name, color: AGENT_COLORS[agent % AGENT_COLORS.length] };
    rpc(card, 'agentCursor', { agent: cursor, start: chunk.start }, 8000);
    const msg = agentMsg(agent, name + ' · ' + where + ' · ' + firstLine(card.text.slice(chunk.start, chunk.end)));
    const chunkText = card.text.slice(chunk.start, chunk.end);
    const requestId = 'grid-' + card.doc.id.slice(0, 8) + '-' + idx + '-' + Date.now().toString(36);
    liveRequests.add(requestId);
    let res = await send({
      type: 'typo:aiBridge',
      action: 'proofreadChunk',
      requestId,
      payload: {
        timeoutMs: AI_TIMEOUT_MS,
        document: {
          id: card.doc.id,
          title: card.doc.name,
          text: card.text.slice(chunk.start, chunk.end),
          instruction,
          history: history.slice(-HISTORY_TURNS),
          decisions: decisions(),
          plan: task.team && task.team.plan,
          team: task.team ? task.team.board.slice(-24) : [],
          heading: firstLine(chunkText),
          ...firstMentionsFor(task, task.team && task.team.mentions && task.team.mentions.get(card.doc.id)),
          chunkIndex: idx,
          chunkCount: count
        }
      }
    });
    liveRequests.delete(requestId);
    msg.text.textContent = '';
    msg.entry.pending = false;
    msg.entry.docId = card.doc.id;
    task.cursor = cursor;
    if (!res || !res.ok) {
      rpc(card, 'agentCursorRemove', { id: cursor.id }, 3000);
      if (res && res.error === 'external_features_disabled') {
        msg.root.remove();
        logEntries = logEntries.filter(e => e !== msg.entry);
        saveLog();
        return 'disabled';
      }
      const why = res && (res.message || res.error) || '오류';
      msg.text.textContent = stopRequested ? '멈췄습니다.' : '이 구간은 처리하지 못했습니다. (' + why + ')';
      msg.entry.text = msg.text.textContent;
      saveLog();
      return 0;
    }
    // 윤문은 다듬어 달라고 한 지시에서만 받는다 — 그 밖의 지시에서 AI가 낸 윤문은 버린다
    const polish = POLISH_RE.test(instruction.replace(/윤문[^.\n]{0,4}(하지|말|빼|금지)/g, ''));
    const edits = (res.findings || []).filter(f => polish || f.category !== '윤문').map(f => ({
      src: f.source, dst: f.replacement, reason: f.reason, category: f.category,
      hint: chunk.start + (Number(f.offset) || 0)
    }));
    // 이전 지시(/맞춤법(룰베이스) 포함)에서 이미 올린 같은 수정은 뺀다
    for (let i = edits.length - 1; i >= 0; i--) if (alreadyProposed(card, edits[i])) edits.splice(i, 1);
    task.note = res.note || '';
    collectQuestions(res.questions);
    // 작업 중에 나온 질문은 끝까지 기다리지 않고 바로 띄운다 — 답하면 결정이 되어 아직 안 한 구간 요청에 들어간다
    if (runQuestions.length && !stopRequested) showRunQuestions({ kind: 'text', instruction, live: true });
    // 다른 구간 에이전트에게 알릴 약속을 게시판에 올린다(이후 시작하는 에이전트가 받아 따른다)
    const share = Array.isArray(res.share) ? res.share.filter(Boolean).slice(0, 3) : [];
    if (share.length && task.team) {
      for (const note of share) task.team.board.push({ from: name + ' · ' + where, note });
      renderShare(msg, share);
      msg.entry.share = share;
    }
    msg.text.textContent = res.note || (edits.length ? '고칠 곳 ' + edits.length + '개를 찾았습니다.' : '고칠 곳이 없습니다.');
    msg.entry.text = msg.text.textContent;
    msg.entry.edits = edits;
    saveLog();
    if (edits.length) {
      renderEdits(msg, card, edits, auto);
      card.counts.proposed += edits.length;
      updateMeta(card);
      if (auto) {
        // 커서가 고칠 곳으로 차례로 옮겨 가며 고친 뒤 사라진다
        Promise.all(edits.map(edit => queueApply(card, edit, cursor)))
          .then(() => rpc(card, 'agentCursorRemove', { id: cursor.id }, 3000));
        task.recorded = edits;
        scrollLog();
        return edits.length;
      }
    }
    task.recorded = edits;
    setTimeout(() => rpc(card, 'agentCursorRemove', { id: cursor.id }, 3000), 1500);
    scrollLog();
    return edits.length;
  }

  // 이번 지시의 결과를 한 덩어리 요약으로 남긴다(문서별 개수, 에이전트 보고 몇 줄, 고친 문구 몇 개)
  function recordTurn(instruction, tasks) {
    const byDoc = new Map();
    const notes = [];
    const changes = [];
    for (const t of tasks) {
      const edits = t.recorded || [];
      byDoc.set(t.card.doc.name, (byDoc.get(t.card.doc.name) || 0) + edits.length);
      if (t.note && notes.length < 4) notes.push(t.card.doc.name + ': ' + t.note);
      for (const e of edits) {
        if (changes.length >= 15) break;
        changes.push(e.src + ' → ' + (e.dst || '(삭제)') + (e.state === 'applied' ? ' [적용]' : ''));
      }
    }
    const team = tasks[0] && tasks[0].team;
    if (team && team.plan) for (const r of team.plan.rules.slice(0, 3)) if (notes.length < 6) notes.push('규칙: ' + r);
    if (team) for (const b of team.board.slice(-3)) if (notes.length < 8) notes.push('공유: ' + b.note);
    history.push({
      instruction: instruction.slice(0, 400),
      result: Array.from(byDoc, ([name, n]) => name + ' ' + n + '곳').join(', '),
      notes,
      changes
    });
    history = history.slice(-HISTORY_TURNS);
    if (sessionId) chrome.storage.local.set({ ['grid:' + sessionId + ':history']: history }).catch(() => {});
  }

  function stopAll() {
    stopRequested = true;
    stopGen++;
    for (const id of liveRequests) send({ type: 'typo:aiBridgeAbort', requestId: id });
    systemMsg('멈추는 중…', false, false);
  }

  // ---------- 시작 ----------

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
    if (!session || busy) return;
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
  const REVIEW_BATCH = 40;
  let reviewCollected = null;
  let reviewInstruction = ''; // 댓글 반영 때 AI에게 덧붙이는 지시(창을 닫았다 열어도 남는다)

  function reviewLabel(it) {
    return (it.type === 'suggestion' ? '제안' : '댓글') + ' · ' + it.author + ' · ' + it.body.slice(0, 50);
  }

  async function collectReviewItems() {
    const targets = cards.filter(c => c.pick.checked);
    const out = [];
    for (const card of targets) {
      const res = await rpc(card, 'docosList', {}, 20000);
      if (!res.ok) continue;
      for (const it of res.items) out.push(Object.assign({ card }, it));
    }
    return { targets, items: out };
  }

  async function openReviewPicker(refresh) {
    const pop = $('g-pop');
    pop.textContent = '';
    pop.appendChild(el('div', 'g-pop-label', '댓글 반영'));
    if (busy) {
      pop.appendChild(el('div', 'g-pop-note', '에이전트가 일하는 중에는 시작할 수 없습니다'));
      pop.hidden = false;
      return;
    }
    pop.hidden = false;
    $('g-review').setAttribute('aria-expanded', 'true');
    // 한 번 모은 목록과 고른 상태는 창을 닫았다 열어도 그대로 쓴다(체크한 문서가 바뀌었거나 ↻를 누를 때만 다시 모은다)
    const targetKey = cards.filter(c => c.pick.checked).map(c => c.doc.id).join(',');
    if (!reviewCollected || reviewCollected.key !== targetKey || refresh) {
      const wait = el('div', 'g-pop-note', '체크한 문서에서 댓글·제안을 모으는 중…');
      pop.appendChild(wait);
      reviewCollected = await collectReviewItems();
      reviewCollected.key = targetKey;
      reviewCollected.chosen = new Set(reviewCollected.items);
      reviewCollected.open = new Set();
      wait.remove();
    }
    const again = el('button', 'g-caret g-pop-refresh', '↻');
    again.type = 'button';
    again.title = '댓글·제안을 다시 모으기';
    again.addEventListener('click', ev => { ev.stopPropagation(); openReviewPicker(true); });
    pop.firstChild.appendChild(again);
    const { items, targets } = reviewCollected;
    if (!items.length) {
      pop.appendChild(el('div', 'g-pop-note', '체크한 문서 ' + targets.length + '개에 남은 댓글·제안이 없습니다'));
      return;
    }
    // 작성자별로 묶고, 작성자 줄의 ▸를 누르면 그 사람의 댓글·제안을 하나씩 골라 끄고 켤 수 있다
    const groups = new Map();
    for (const it of items) {
      if (!groups.has(it.author)) groups.set(it.author, []);
      groups.get(it.author).push(it);
    }
    pop.appendChild(el('div', 'g-pop-note', '문서 ' + targets.length + '개 · 댓글 ' + items.filter(i => i.type === 'comment').length + ' · 제안 ' + items.filter(i => i.type === 'suggestion').length + ' · 반영할 것을 고르세요'));
    const chosen = reviewCollected.chosen;
    const go = el('button', 'g-pop-new', '');
    go.type = 'button';
    const syncGo = () => {
      go.disabled = chosen.size === 0;
      go.textContent = chosen.size ? '고른 ' + chosen.size + '개 반영 시작' : '반영할 것을 고르세요';
    };
    for (const [name, list] of groups) {
      const head = el('div', 'g-review-author');
      const label = el('label', 'g-doc-row');
      const box = el('input');
      box.type = 'checkbox';
      const nc = list.filter(i => i.type === 'comment').length;
      const ns = list.length - nc;
      const counts = [nc ? '댓글 ' + nc : '', ns ? '제안 ' + ns : ''].filter(Boolean).join(' · ');
      label.append(box, el('span', 'g-switch-track'), el('span', 'g-doc-name', name || '(이름 없음)'), el('span', 'g-pop-count', counts));
      const caret = el('button', 'g-caret', '▸');
      caret.type = 'button';
      caret.title = '하나씩 고르기';
      caret.setAttribute('aria-expanded', 'false');
      head.append(label, caret);
      const sub = el('div', 'g-review-items');
      sub.hidden = !reviewCollected.open.has(name);
      caret.textContent = sub.hidden ? '▸' : '▾';
      const itemBoxes = [];
      const syncAuthor = () => {
        const on = list.filter(it => chosen.has(it)).length;
        box.checked = on === list.length;
        box.indeterminate = on > 0 && on < list.length;
        syncGo();
      };
      for (const it of list) {
        // 체크는 체크박스로만, 줄을 누르면 그 댓글·제안이 걸린 문서 위치로 간다
        const row = el('div', 'g-review-item');
        row.title = '눌러서 문서의 그 위치로 이동';
        const b = el('input');
        b.type = 'checkbox';
        b.checked = chosen.has(it);
        b.addEventListener('click', ev => ev.stopPropagation());
        b.addEventListener('change', () => {
          if (b.checked) chosen.add(it); else chosen.delete(it);
          syncAuthor();
        });
        row.addEventListener('click', () => {
          revealCard(it.card);
          for (const r of row.parentElement.querySelectorAll('.g-review-item.g-current')) r.classList.remove('g-current');
          row.classList.add('g-current');
          rpc(it.card, 'docosFocus', { sig: { index: it.index, type: it.type, author: it.author, body: it.body } }, 15000);
        });
        itemBoxes.push(b);
        const text = el('span', 'g-review-text', it.body || '(내용 없음)');
        row.append(b, el('span', 'g-review-kind g-review-' + it.type, it.type === 'suggestion' ? '제안' : '댓글'), text);
        if (targets.length > 1) row.appendChild(el('span', 'g-pop-count', it.card.doc.name.slice(0, 12)));
        sub.appendChild(row);
      }
      box.addEventListener('change', () => {
        for (let k = 0; k < list.length; k++) {
          itemBoxes[k].checked = box.checked;
          if (box.checked) chosen.add(list[k]); else chosen.delete(list[k]);
        }
        syncAuthor();
      });
      caret.addEventListener('click', ev => {
        ev.preventDefault();
        sub.hidden = !sub.hidden;
        if (sub.hidden) reviewCollected.open.delete(name); else reviewCollected.open.add(name);
        caret.textContent = sub.hidden ? '▸' : '▾';
        caret.setAttribute('aria-expanded', sub.hidden ? 'false' : 'true');
      });
      syncAuthor();
      pop.append(head, sub);
    }
    const extra = el('textarea', 'g-review-extra');
    extra.rows = 2;
    extra.placeholder = '추가 지시 (선택) · 예) 코드 블록 안 제안은 모두 거절해 줘 / 용어는 “함수”로 통일';
    extra.value = reviewInstruction;
    extra.addEventListener('input', () => { reviewInstruction = extra.value; });
    extra.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey) && !ev.isComposing && ev.keyCode !== 229 && !go.disabled) { ev.preventDefault(); go.click(); }
    });
    go.addEventListener('click', () => {
      const picked = new Set(chosen);
      closeHistory();
      runReview(picked, reviewInstruction.trim());
    });
    syncGo();
    pop.appendChild(el('div', 'g-pop-note', '제안은 맞으면 수락, 댓글은 고친 뒤 해결까지 바로 처리합니다 · 틀렸거나 판단이 어려운 것은 거절하지 않고 남겨 두며, 결과에서 [위치]로 바로 찾아갈 수 있습니다'));
    pop.appendChild(extra);
    pop.appendChild(go);
  }

  // DOCX export에서 댓글이 걸린 문구와 앞뒤 문맥, 제안의 지움·넣음 원문을 가져온다
  // 문서를 DOCX로 내보내 본문·스타일·댓글 XML을 꺼낸다(격자 페이지가 docs.google.com이라 같은 출처로 바로 받는다)
  async function fetchDocxParts(card) {
    const H = globalThis.ToytypeHwpxExport;
    if (!H || !H.readZipPackage) throw new Error('docx reader unavailable');
    const a = session.authuser > 0 ? 'u/' + session.authuser + '/' : '';
    const res = await fetch('https://docs.google.com/document/' + a + 'd/' + encodeURIComponent(card.doc.id) + '/export?format=docx');
    if (!res.ok) throw new Error('export ' + res.status);
    const pkg = await H.readZipPackage(await res.arrayBuffer());
    const text = name => { const f = pkg.files.get(name); return f ? new TextDecoder('utf-8').decode(f.data) : ''; };
    return { document: text('word/document.xml'), styles: text('word/styles.xml'), comments: text('word/comments.xml') };
  }

  async function fetchReviewContext(card) {
    const D = globalThis.ToytypeDocTools;
    if (!D || !D.parseDocxReview) return null;
    const parts = await fetchDocxParts(card);
    return D.parseDocxReview(parts.document, parts.comments);
  }

  // ---------- 서식 점검 ----------
  // DOCX의 문단·글자 서식을 요소별로 정리해 규칙으로 확실한 불일치를 먼저 잡고,
  // 요약본을 구간별로 AI에게 보내 코너 분류·표기 통일·흐름 같은 판단이 필요한 문제를 찾는다.
  const FORMAT_SECTION_CHARS = 12000;

  function formatStats(summary) {
    const ps = summary.paragraphs.filter(p => p.kind !== 'empty');
    const stats = {};
    for (const p of ps) {
      const k = stats[p.kind] || (stats[p.kind] = { count: 0, sizes: {}, fonts: {} });
      k.count++;
      k.sizes[p.size] = (k.sizes[p.size] || 0) + 1;
      k.fonts[p.font || '기본'] = (k.fonts[p.font || '기본'] || 0) + 1;
    }
    const corners = {};
    for (const p of ps.filter(p => p.kind === 'corner')) {
      const m = /^\s*\[([^\]\n]{1,24})\]/.exec(p.text);
      if (m) corners[m[1]] = (corners[m[1]] || 0) + 1;
    }
    return { elements: stats, cornerTitles: corners };
  }

  // "#124" 같은 문단 번호를 눌러 그 문단으로 가는 링크로 바꿔 붙인다
  function appendWithRefs(node, text, refs, card) {
    const str = String(text || '');
    let last = 0;
    for (const m of str.matchAll(/#(\d{1,5})/g)) {
      const ref = refs && refs[m[1]];
      if (!ref || !card) continue;
      node.appendChild(document.createTextNode(str.slice(last, m.index)));
      const a = el('button', 'g-ref', m[0]);
      a.type = 'button';
      a.title = '문서에서 이 문단으로 이동';
      a.addEventListener('click', () => {
        revealCard(card);
        rpc(card, 'locate', { src: ref.find, hint: ref.hint || 0 }, 15000);
      });
      node.appendChild(a);
      last = m.index + m[0].length;
    }
    node.appendChild(document.createTextNode(str.slice(last)));
  }

  function renderFormatRows(msg, card, rows) {
    let list = msg.bubble.querySelector('.g-format-results');
    if (!list) {
      list = el('div', 'g-edits g-format-results');
      msg.bubble.appendChild(list);
    }
    list.textContent = '';
    for (const r of rows) {
      const item = el('div', 'g-edit g-format-row');
      const head = el('div', 'g-edit-diff');
      head.append(el('span', 'g-review-kind g-format-' + (r.rule ? 'rule' : 'ai'), r.category), document.createTextNode(' '));
      appendWithRefs(head, r.issue, r.refs, card);
      item.appendChild(head);
      if (r.suggestion) {
        const why = el('div', 'g-edit-why');
        appendWithRefs(why, r.suggestion, r.refs, card);
        item.appendChild(why);
      }
      if (card && r.find) {
        const row = el('div', 'g-edit-row');
        const state = el('span', 'g-edit-state', r.done ? '✓ 적용됨' : r.text ? '“' + r.text.slice(0, 40) + '”' : '');
        if (r.done) item.classList.add('g-applied');
        const go = el('button', 'g-link', '위치');
        go.type = 'button';
        go.addEventListener('click', async () => {
          revealCard(card);
          const res = await rpc(card, 'locate', { src: r.find, hint: r.hint || 0 }, 15000);
          if (!res.ok) state.textContent = '문서에서 찾지 못함';
          else if (res.approx) state.textContent = '이 문단을 찾지 못해 근처로 갔습니다';
        });
        row.append(state, go);
        if (r.fix) {
          const apply = el('button', 'g-link', '적용');
          apply.type = 'button';
          apply.disabled = !!r.done;
          apply.title = fixLabel(r.fix);
          apply.addEventListener('click', async () => {
            apply.disabled = true;
            state.textContent = '적용 중…';
            const ok = await applyFormatFix(card, r);
            r.done = ok.ok;
            state.textContent = ok.ok ? '✓ 적용됨' : '적용 실패 · ' + ok.why;
            item.classList.toggle('g-applied', ok.ok);
            if (!ok.ok) apply.disabled = false;
            saveLog();
          });
          row.appendChild(apply);
        }
        item.appendChild(row);
      }
      list.appendChild(item);
    }
  }

  function fixLabel(fix) {
    if (fix.type === 'fontSize') return '이 문단 글자 크기를 ' + fix.value + 'pt로';
    if (fix.type === 'fontFamily') return '이 문단 글꼴을 ' + fix.value + '(으)로';
    if (fix.type === 'script') return '“' + fix.text + '” ' + (fix.on ? (fix.kind === 'sub' ? '아래첨자로' : '위첨자로') : '첨자 풀기');
    return '';
  }

  // 서식 고치기. 크기·글꼴은 툴바가 있어야 해서, 간결 모드 칸이면 그 칸을 전체 편집기로 바꾼 뒤 다시 한다
  async function applyFormatFix(card, r) {
    // 서식은 문단 단위로 잡고(문단 첫머리 글자), 첨자는 문제 문구(quote) 안의 글자를 고른다
    const args = { find: r.paraFind || r.find, hint: r.paraHint != null ? r.paraHint : r.hint || 0, quote: r.quote || '', fix: r.fix };
    let res = await rpc(card, 'formatFix', args, 45000);
    if (!res.ok && res.error === 'need_full') {
      setFullEditor(card, true);
      const ready = await card.readyPromise;
      if (!ready) return { ok: false, why: '전체 편집기를 열지 못함' };
      // 툴바는 편집기보다 조금 늦게 뜬다 — 몇 번 다시 시도한다
      for (let k = 0; k < 6; k++) {
        await sleep(1500);
        res = await rpc(card, 'formatFix', args, 45000);
        if (res.ok || res.error !== 'need_full') break;
      }
    }
    if (!res.ok) trace('formatFix', card.doc.name + ' ' + JSON.stringify({ error: res.error, fix: r.fix, find: String(args.find).slice(0, 30), quote: args.quote }));
    const why = { not_found: '문서에서 찾지 못함', need_full: '툴바를 찾지 못함', script_failed: '첨자 바꾸기 실패', timeout: '문서가 응답하지 않음' }[res.error] || (/timeout/.test(res.error || '') ? '문서 응답이 늦음 · 다시 눌러 보세요' : res.error) || '';
    return { ok: !!res.ok, why };
  }

  // HTML 문단을 문서 모델 본문 위치에 차례로 맞춘다(같은 문구가 여러 번 나와도 순서대로 짝지어 [위치]가 정확해진다)
  function mapParagraphOffsets(paragraphs, modelText) {
    const out = new Array(paragraphs.length).fill(-1);
    let pos = 0;
    for (const p of paragraphs) {
      const key = p.text.replace(/\s+/g, ' ').trim().slice(0, 24);
      if (!key || !modelText) continue;
      let at = modelText.indexOf(key, pos);
      if (at === -1 || at - pos > 20000) {
        // 앞부분이 모델과 조금 다르면(머리 기호 등) 가운데 몇 글자로 다시 찾는다
        const mid = key.slice(Math.floor(key.length / 3), Math.floor(key.length / 3) + 10);
        const m = mid.length >= 4 ? modelText.indexOf(mid, pos) : -1;
        at = m !== -1 && m - pos <= 20000 ? Math.max(pos, m - Math.floor(key.length / 3)) : -1;
      }
      if (at !== -1) {
        out[p.i] = at;
        pos = at + 1;
      }
    }
    return out;
  }

  async function formatCheckDoc(card, agent, instruction) {
    const D = globalThis.ToytypeDocTools;
    const name = '에이전트 ' + (agent + 1);
    setWorking(card, agent, name);
    const msg = agentMsg(agent, name + ' · ' + card.doc.name + ' · 서식 점검');
    msg.entry.docId = card.doc.id;
    const flush = text => {
      msg.text.textContent = text;
      msg.entry.text = text;
      msg.entry.pending = false;
      saveLog();
    };
    try {
      let summary;
      try {
        // 글꼴·크기는 HTML export가 화면과 같다(DOCX는 한글 섞인 줄의 글꼴을 자리표시용으로 내보낸다)
        const a = session.authuser > 0 ? 'u/' + session.authuser + '/' : '';
        // 칸에 보이는 문서 탭만 내보낸다(탭이 여럿이면 전체 export와 편집기 본문이 어긋나 위치를 못 찾는다)
        const info = await rpc(card, 'tabInfo', {}, 8000);
        const tab = info && info.ok && /^t\.[\w-]+$/.test(info.tab || '') ? info.tab : '';
        const res = await fetch('https://docs.google.com/document/' + a + 'd/' + encodeURIComponent(card.doc.id) + '/export?format=html' + (tab ? '&tab=' + encodeURIComponent(tab) : ''));
        if (!res.ok) throw new Error('export ' + res.status);
        summary = D.summarizeHtmlFormat(await res.text());
      } catch (e) {
        flush('문서 서식을 읽지 못했습니다 (' + (e && e.message || e) + ')');
        return 0;
      }
      const ruleFindings = D.formatRuleFindings(summary);
      const stats = formatStats(summary);
      const textRes = await rpc(card, 'getText', {}, 30000);
      const modelText = textRes.ok ? textRes.text : '';
      const paraText = i => (summary.paragraphs[i] ? summary.paragraphs[i].text : '');
      const offsets = mapParagraphOffsets(summary.paragraphs, modelText);
      // [위치]는 모델 본문에서 그 문단 자리의 실제 글자로 찾는다
      const findOf = i => {
        const at = offsets[i];
        if (at >= 0) { const line = modelText.slice(at, modelText.indexOf('\n', at) === -1 ? undefined : modelText.indexOf('\n', at)); return line.slice(0, 40); }
        return paraText(i).replace(/\s+/g, ' ').trim().slice(0, 40);
      };
      const hintOf = i => (offsets[i] >= 0 ? offsets[i] : 0);
      // 설명 속 "#124" 같은 문단 번호를 눌러 갈 수 있게 그 문단 자리를 함께 적어 둔다
      const refsOf = text => {
        const out = {};
        for (const m of String(text || '').matchAll(/#(\d{1,5})/g)) {
          const i = Number(m[1]);
          if (summary.paragraphs[i] && !out[i]) out[i] = { find: findOf(i), hint: hintOf(i) };
        }
        return out;
      };
      // [위치]·[적용]이 문단 첫머리가 아니라 문제 문구 자체로 가게 한다
      const placeOf = (i, quote) => {
        if (i < 0) return { find: '', hint: 0 };
        const ptext = paraText(i);
        const q = String(quote || '');
        const qi = q ? ptext.indexOf(q) : -1;
        if (qi !== -1) return { find: q, hint: hintOf(i) + qi, quote: q, paraFind: findOf(i), paraHint: hintOf(i) };
        return { find: findOf(i), hint: hintOf(i), paraFind: findOf(i), paraHint: hintOf(i) };
      };
      const rows = [];
      const edits = [];
      for (const f of ruleFindings) {
        if (f.edit && f.at >= 0) {
          const ptext = paraText(f.at);
          const hint = hintOf(f.at) + Math.max(0, ptext.indexOf(f.edit.src));
          edits.push({ src: f.edit.src, dst: f.edit.dst, reason: f.issue + (f.suggestion ? ' · ' + f.suggestion : ''), category: f.category, hint });
          continue;
        }
        rows.push(Object.assign({ rule: true, category: f.category, issue: f.issue, suggestion: f.suggestion, at: f.at, text: f.text, fix: f.fix || null }, placeOf(f.at, f.quote)));
      }
      renderFormatRows(msg, card, rows);
      msg.entry.format = rows.slice();
      flush('규칙으로 ' + rows.length + '곳을 찾았습니다 · AI가 일관성을 보는 중…');

      // 요약본을 구간으로 나눠 AI에게 보낸다
      const lines = D.formatTranscript(summary, 0, summary.paragraphs.length).split('\n');
      const sections = [];
      let cur = '';
      for (const line of lines) {
        if (cur && cur.length + line.length > FORMAT_SECTION_CHARS) { sections.push(cur); cur = ''; }
        cur += (cur ? '\n' : '') + line;
      }
      if (cur) sections.push(cur);
      const notes = [];
      for (let k = 0; k < sections.length && !stopRequested; k++) {
        const requestId = 'format-' + card.doc.id.slice(0, 8) + '-' + k + '-' + Date.now().toString(36);
        liveRequests.add(requestId);
        const res = await send({ type: 'typo:aiBridge', action: 'formatCheck', requestId, payload: { timeoutMs: AI_TIMEOUT_MS, document: {
          title: card.doc.name, transcript: sections[k], stats, instruction: instruction || '', decisions: decisions(),
          ruleFindings: ruleFindings.map(f => ({ at: f.at, issue: f.issue }))
        } } });
        liveRequests.delete(requestId);
        if (!res || !res.ok) {
          if (res && res.error === 'external_features_disabled') { notes.push('AI 기능이 꺼져 있어 규칙 점검만 했습니다'); break; }
          notes.push('구간 ' + (k + 1) + ' 판단 실패(' + (res && (res.message || res.error) || '오류') + ')');
          continue;
        }
        if (res.note) notes.push(res.note);
        collectQuestions(res.questions);
        for (const f of res.findings || []) {
          const ptext = paraText(f.at);
          if (f.source && ptext.includes(f.source)) {
            // 글자만 바꾸면 되는 것은 일반 제안처럼 [적용]으로 고칠 수 있게 한다
            const hint = hintOf(f.at) + Math.max(0, ptext.indexOf(f.source));
            edits.push({ src: f.source, dst: f.replacement || '', reason: f.issue + (f.suggestion ? ' · ' + f.suggestion : ''), category: f.category, hint, refs: refsOf(f.issue + ' ' + f.suggestion) });
          } else {
            rows.push(Object.assign({ rule: false, category: f.category, issue: f.issue, suggestion: f.suggestion, at: f.at, text: ptext.slice(0, 80), fix: f.fix || null, refs: refsOf(f.issue + ' ' + f.suggestion) }, placeOf(f.at, f.quote)));
          }
        }
        msg.entry.format = rows.slice();
        renderFormatRows(msg, card, rows);
        flush('규칙 ' + ruleFindings.length + '곳 · AI ' + Math.max(0, rows.length + edits.length - ruleFindings.length) + '곳 · 구간 ' + (k + 1) + '/' + sections.length);
      }
      if (edits.length) {
        msg.entry.edits = edits;
        renderEdits(msg, card, edits, false);
        card.counts.proposed += edits.length;
        updateMeta(card);
      }
      flush((notes.length ? notes.slice(0, 3).join(' ') + '\n' : '') + '서식·표기 지적 ' + rows.length + '곳' + (edits.length ? ' · 글자로 바로 고칠 수 있는 것 ' + edits.length + '곳([적용])' : ''));
      return rows.length + edits.length;
    } finally {
      setWorking(card, null);
    }
  }

  // ---------- 도해 점검 ----------
  // 문서 export(HTML)에서 그림·그리기를 차례로 꺼내, 그림마다 OCR+AI로 안의 글자를 점검한다.
  // 그림 속 글자는 바로 고칠 수 없어 지적과 [위치](그림 근처 문단)만 보여 준다.
  const FIGURE_MAX_PER_DOC = 40;

  async function listFigures(card) {
    const a = session.authuser > 0 ? 'u/' + session.authuser + '/' : '';
    const info = await rpc(card, 'tabInfo', {}, 8000);
    const tab = info && info.ok && /^t\.[\w-]+$/.test(info.tab || '') ? info.tab : '';
    const res = await fetch('https://docs.google.com/document/' + a + 'd/' + encodeURIComponent(card.doc.id) + '/export?format=html' + (tab ? '&tab=' + encodeURIComponent(tab) : ''));
    if (!res.ok) throw new Error('export ' + res.status);
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const figures = [];
    let lastText = '';
    // 본문 블록을 차례로 보며 그림 앞뒤 문단을 기억한다(앞 문단 = 위치, 뒤 문단 = 보통 그림 캡션)
    const blocks = Array.from(doc.body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, td'));
    blocks.forEach((b, i) => {
      const text = (b.textContent || '').replace(/\s+/g, ' ').trim();
      for (const img of b.querySelectorAll('img')) {
        if (figures.length >= FIGURE_MAX_PER_DOC) break;
        const next = blocks.slice(i + 1, i + 4).map(x => (x.textContent || '').replace(/\s+/g, ' ').trim()).find(Boolean) || '';
        figures.push({ src: img.getAttribute('src') || '', before: text || lastText, after: next });
      }
      if (text) lastText = text;
    });
    return figures.filter(f => /^https:\/\//.test(f.src));
  }

  async function figureCheckDoc(card, agent, instruction) {
    const name = '에이전트 ' + (agent + 1);
    setWorking(card, agent, name);
    const msg = agentMsg(agent, name + ' · ' + card.doc.name + ' · 도해 점검');
    msg.entry.docId = card.doc.id;
    const done = text => { msg.text.textContent = text; msg.entry.text = text; msg.entry.pending = false; saveLog(); };
    let figures;
    try { figures = await listFigures(card); } catch (e) {
      setWorking(card, null);
      done('그림 목록을 읽지 못했습니다 (' + (e && e.message || e) + ')');
      return 0;
    }
    if (!figures.length) { setWorking(card, null); done('이 문서에는 그림이 없습니다.'); return 0; }
    const rows = [];
    let failed = 0;
    for (let i = 0; i < figures.length && !stopRequested; i++) {
      const f = figures[i];
      msg.text.textContent = '그림 ' + (i + 1) + '/' + figures.length + ' 읽는 중…';
      const img = await send({ type: 'typo:fetchImage', url: f.src });
      if (!img || !img.ok) { failed++; continue; }
      const requestId = 'grid-figure-' + card.doc.id.slice(0, 8) + '-' + i + '-' + Date.now().toString(36);
      liveRequests.add(requestId);
      const res = await send({ type: 'typo:aiBridge', action: 'figureTextCheck', requestId, payload: { timeoutMs: 240000, document: {
        title: card.doc.name, index: i + 1, image: { dataUrl: img.dataUrl },
        context: [f.before, f.after].filter(Boolean).join('\n') + (instruction ? '\n[편집장 추가 지시] ' + instruction : ''),
        decisions: decisions()
      } } });
      liveRequests.delete(requestId);
      if (!res || !res.ok) { failed++; continue; }
      for (const x of res.findings || []) rows.push({ fig: i + 1, caption: f.after.slice(0, 40), find: f.before.slice(0, 40), found: x.found, suggestion: x.suggestion, reason: x.reason });
    }
    setWorking(card, null);
    done('그림 ' + figures.length + '개 점검 · 지적 ' + rows.length + '개' + (failed ? ' · ' + failed + '개는 읽지 못함' : '') + (figures.length >= FIGURE_MAX_PER_DOC ? ' · 앞 ' + FIGURE_MAX_PER_DOC + '개만' : ''));
    msg.entry.figure = rows;
    renderFigureRows(msg, card, rows);
    saveLog();
    return rows.length;
  }

  function renderFigureRows(msg, card, rows) {
    if (!rows.length) return;
    const list = el('div', 'g-edits');
    for (const r of rows) {
      const item = el('div', 'g-edit');
      const diff = el('div', 'g-edit-diff');
      diff.append(el('span', 'g-fig-no', '그림 ' + r.fig), el('del', '', r.found), el('span', 'g-edit-arrow', '→'), el('ins', '', r.suggestion || '?'));
      item.appendChild(diff);
      if (r.reason || r.caption) item.appendChild(el('div', 'g-edit-why', [r.reason, r.caption ? '(' + r.caption + ')' : ''].filter(Boolean).join(' ')));
      const row = el('div', 'g-edit-row');
      const state = el('span', 'g-edit-state', '그림 안 글자라 직접 고쳐야 합니다');
      row.appendChild(state);
      if (r.find) {
        const go = el('button', 'g-link', '위치');
        go.type = 'button';
        go.title = '그림 바로 앞 문단으로 이동';
        go.addEventListener('click', () => { revealCard(card); rpc(card, 'locate', { src: r.find, hint: 0 }, 15000); });
        row.appendChild(go);
      }
      item.appendChild(row);
      list.appendChild(item);
    }
    msg.bubble.appendChild(list);
  }

  async function runFigureCheck(instruction) {
    if (busy) return;
    const targets = cards.filter(c => c.pick.checked);
    if (!targets.length) { systemMsg('점검할 문서를 하나 이상 고르세요', true); return; }
    userMsg('도해 점검' + (instruction ? '\n' + instruction : ''));
    currentTurn = 'turn-' + Date.now().toString(36);
    stopRequested = false;
    setBusy(true);
    for (const c of targets) { c.pinned = true; clearTimeout(c.unloadTimer); if (c.unloaded) loadCard(c); }
    const agents = Math.min(Number($('g-conc').value) || 3, targets.length);
    let next = 0;
    let total = 0;
    let finished = 0;
    setProgress(0, targets.length);
    await Promise.all(Array.from({ length: agents }, async (_, a) => {
      while (next < targets.length && !stopRequested) {
        const card = targets[next++];
        total += await figureCheckDoc(card, a, instruction);
        setProgress(++finished, targets.length);
      }
    }));
    unpinTargets(targets);
    history.push({ instruction: '도해 점검' + (instruction ? ': ' + instruction.slice(0, 200) : ''), result: '그림 안 글자 지적 ' + total + '곳', notes: [], changes: [] });
    history = history.slice(-HISTORY_TURNS);
    if (sessionId) chrome.storage.local.set({ ['grid:' + sessionId + ':history']: history }).catch(() => {});
    systemMsg((stopRequested ? '멈췄습니다 · ' : '도해 점검 끝 · ') + '지적 ' + total + '곳');
    currentTurn = '';
    setBusy(false);
  }

  async function runFormatCheck(instruction) {
    if (busy) return;
    const targets = cards.filter(c => c.pick.checked);
    if (!targets.length) {
      systemMsg('점검할 문서를 하나 이상 고르세요', true);
      return;
    }
    userMsg('서식 점검' + (instruction ? '\n' + instruction : ''));
    runQuestions = [];
    currentTurn = 'turn-' + Date.now().toString(36);
    const turn = currentTurn;
    stopRequested = false;
    setBusy(true);
    for (const c of targets) { c.pinned = true; clearTimeout(c.unloadTimer); }
    const agents = Math.min(Number($('g-conc').value) || 3, targets.length);
    let next = 0;
    let total = 0;
    let finished = 0;
    setProgress(0, targets.length);
    await Promise.all(Array.from({ length: agents }, async (_, a) => {
      while (next < targets.length && !stopRequested) {
        const card = targets[next++];
        if (card.unloaded) loadCard(card);
        total += await formatCheckDoc(card, a, instruction);
        setProgress(++finished, targets.length);
      }
    }));
    for (const c of targets) { c.pinned = false; scheduleUnload(c); }
    history.push({ instruction: '서식 점검' + (instruction ? ': ' + instruction.slice(0, 200) : ''), result: '지적 ' + total + '곳', notes: [], changes: [] });
    history = history.slice(-HISTORY_TURNS);
    if (sessionId) chrome.storage.local.set({ ['grid:' + sessionId + ':history']: history }).catch(() => {});
    const endMsg = systemMsg((stopRequested ? '멈췄습니다 · ' : '서식 점검 끝 · ') + '지적 ' + total + '곳');
    if (pendingEdits(turn).length) {
      logEntries[logEntries.length - 1].turnApply = turn;
      attachTurnApply(endMsg, turn);
      saveLog();
    }
    currentTurn = '';
    setBusy(false);
    showRunQuestions({ kind: 'format', extra: instruction || '' });
  }

  function squashText(t) {
    return String(t || '').replace(/\s+/g, ' ').trim();
  }

  // 화면 카드와 DOCX 항목을 작성자·내용으로 짝짓는다
  function enrichReviewItems(items, review) {
    if (!review) return;
    const usedC = new Set();
    const usedS = new Set();
    for (const it of items) {
      if (it.type === 'comment') {
        const c = review.comments.find((x, i) => !usedC.has(i) && x.author === it.author && squashText(x.text).slice(0, 40) === it.body.slice(0, 40));
        if (c) {
          usedC.add(review.comments.indexOf(c));
          it.anchor = c.anchor;
          it.context = c.context;
        }
      } else {
        const body = squashText(it.body);
        const s = review.suggestions.find((x, i) => !usedS.has(i) && x.author === it.author && [x.deleted, x.inserted].some(t => t && body.includes(squashText(t).slice(0, 12))));
        if (s) {
          usedS.add(review.suggestions.indexOf(s));
          it.context = s.context;
          it.inserted = s.inserted;
          // 지우기만 한 제안은 받아들이면 글자가 사라지므로 바로 앞 문구로 위치를 잡는다
          const before = s.context.slice(0, s.context.indexOf('⟦') >= 0 ? s.context.indexOf('⟦') : s.context.length).replace(/⟦[^⟧]*⟧/g, '');
          it.before = before.slice(-20);
        }
      }
    }
  }

  const DECISION_LABEL = { accept: '수락', edit: '고치고 해결', resolve: '해결', skip: '남겨 둠' };

  // 처리 결과를 항목별 줄로 그린다. 남겨 둔 것·실패한 것에는 [위치]를 달아 문서의 그 댓글로 바로 간다.
  function renderReviewRows(msg, card, rows) {
    let list = msg.bubble.querySelector('.g-review-results');
    if (!list) {
      list = el('div', 'g-edits g-review-results');
      msg.bubble.appendChild(list);
    }
    list.textContent = '';
    for (const r of rows) {
      const item = el('div', 'g-edit g-review-row g-review-' + (r.mark === '✓' ? 'done' : r.mark === '✗' ? 'fail' : 'left'));
      const head = el('div', 'g-edit-diff');
      head.append(el('b', '', r.mark + ' ' + r.label), document.createTextNode(' ' + r.what));
      item.appendChild(head);
      if (r.reason) item.appendChild(el('div', 'g-edit-why', r.reason));
      if (card && (r.sig || r.find)) {
        const row = el('div', 'g-edit-row');
        const done = r.mark === '✓';
        const state = el('span', 'g-edit-state', done ? '' : r.fail ? '실패: ' + r.fail : '직접 처리할 것');
        const go = el('button', 'g-link', '위치');
        go.type = 'button';
        go.title = done ? '문서에서 반영한 곳으로 이동' : '문서에서 이 댓글·제안으로 이동';
        go.addEventListener('click', async () => {
          revealCard(card);
          // 남은 카드는 카드를 눌러 이동하고, 처리돼 카드가 없으면 본문 문구로 찾는다
          let res = !done && r.sig ? await rpc(card, 'docosFocus', { sig: r.sig }, 15000) : { ok: false };
          if (!res.ok && r.find) res = await rpc(card, 'locate', { src: r.find, hint: r.hint || 0 }, 15000);
          state.textContent = res.ok ? (res.approx ? '문구가 바뀌어 근처로 갔습니다' : state.textContent) : '문서에서 찾지 못함';
        });
        row.append(state, go);
        item.appendChild(row);
      }
      list.appendChild(item);
    }
  }

  async function reviewOneDoc(card, items, agent, instruction) {
    const name = '에이전트 ' + (agent + 1);
    setWorking(card, agent, name);
    const msg = agentMsg(agent, name + ' · ' + card.doc.name + ' · 댓글 반영 · 댓글·제안 ' + items.length + '개');
    msg.entry.docId = card.doc.id;
    const lines = [];
    const flush = text => {
      msg.text.textContent = text;
      msg.entry.text = text;
      msg.entry.pending = false;
      saveLog();
    };
    try {
      let review = null;
      try { review = await fetchReviewContext(card); } catch (_) { review = null; }
      enrichReviewItems(items, review);
      const decisions = new Map();
      let note = '';
      for (let i = 0; i < items.length && !stopRequested; i += REVIEW_BATCH) {
        const batch = items.slice(i, i + REVIEW_BATCH).map((it, k) => ({
          id: 'r' + (i + k), type: it.type, author: it.author, request: it.body, anchor: it.anchor || '', context: it.context || '',
          replies: it.replies.map(r => r.author + ': ' + r.body)
        }));
        const requestId = 'review-' + card.doc.id.slice(0, 8) + '-' + i + '-' + Date.now().toString(36);
        liveRequests.add(requestId);
        const res = await send({ type: 'typo:aiBridge', action: 'reviewComments', requestId, payload: { timeoutMs: AI_TIMEOUT_MS, document: { title: card.doc.name, items: batch, instruction: instruction || '', history: history.slice(-HISTORY_TURNS) } } });
        liveRequests.delete(requestId);
        if (!res || !res.ok) {
          flush(res && res.error === 'external_features_disabled' ? 'AI 기능이 꺼져 있습니다 · 설정에서 [브릿지 · AI 기능 사용]을 켜세요' : '판단을 받지 못했습니다 (' + (res && (res.message || res.error) || '오류') + ')');
          return { done: 0, total: items.length };
        }
        if (res.note) note = res.note;
        for (const d of res.decisions || []) decisions.set(d.id, d);
      }
      flush((note || '판단을 마쳤습니다') + ' · 처리하는 중…');
      let modelText = '';
      const textRes = await rpc(card, 'getText', {}, 30000);
      if (textRes.ok) modelText = textRes.text;
      const cursor = { id: 'review-' + agent + '-' + Date.now().toString(36), label: name, color: AGENT_COLORS[agent % AGENT_COLORS.length] };
      let done = 0;
      for (let i = 0; i < items.length; i++) {
        if (stopRequested) {
          for (const rest of items.slice(i)) lines.push({ mark: '·', label: '멈춤', what: reviewLabel(rest), reason: '', fail: '', sig: { index: rest.index, type: rest.type, author: rest.author, body: rest.body } });
          msg.entry.review = lines.slice();
          renderReviewRows(msg, card, lines);
          break;
        }
        const it = items[i];
        const d = decisions.get('r' + i) || { decision: 'skip', reason: '판단을 받지 못함' };
        const sig = { index: it.index, type: it.type, author: it.author, body: it.body };
        let ok = true;
        let why = '';
        if (d.decision === 'accept' || d.decision === 'resolve') {
          const r = await rpc(card, 'docosAct', { sig, action: d.decision }, 20000);
          ok = r.ok;
          why = r.error || '';
        } else if (d.decision === 'edit') {
          const anchorAt = modelText ? modelText.indexOf(it.anchor || d.source) : -1;
          const r = await rpc(card, 'applyEdit', { src: d.source, dst: d.replacement, hint: anchorAt >= 0 ? anchorAt : 0, agent: cursor }, 45000);
          ok = r.ok;
          why = r.error || '';
          if (ok) {
            const r2 = await rpc(card, 'docosAct', { sig, action: 'resolve' }, 20000);
            if (!r2.ok) why = '고쳤지만 해결 표시는 못함';
          }
        }
        if (ok && d.decision !== 'skip') done++;
        const mark = d.decision === 'skip' ? '·' : ok ? '✓' : '✗';
        const change = d.decision === 'edit' ? ' (' + d.source + ' → ' + d.replacement + ')' : '';
        // 처리한 뒤에는 카드가 사라지므로 본문 문구로 위치를 찾는다(받아들인 제안은 넣은 글자, 고친 댓글은 고친 문구)
        const find = d.decision === 'edit' ? (d.replacement || it.anchor || '')
          : d.decision === 'accept' ? (it.inserted || it.before || '')
          : (it.anchor || '');
        const at = modelText && (it.anchor || d.source) ? modelText.indexOf(it.anchor || d.source) : -1;
        lines.push({ mark, label: DECISION_LABEL[d.decision] || '남겨 둠', what: reviewLabel(it) + change, reason: d.reason || '', fail: !ok && d.decision !== 'skip' ? (why || '알 수 없음') : '', sig, find: find.slice(0, 200), hint: at >= 0 ? at : 0 });
        msg.entry.review = lines.slice();
        renderReviewRows(msg, card, lines);
        flush(note || '처리하는 중…');
      }
      rpc(card, 'agentCursorRemove', { id: cursor.id }, 3000);
      const left = lines.filter(l => l.mark !== '✓').length;
      flush((note ? note + ' · ' : '') + '처리 ' + done + '개' + (left ? ' · 직접 볼 것 ' + left + '개' : ''));
      return { done, total: items.length, decisions: Array.from(decisions.values()) };
    } finally {
      setWorking(card, null);
    }
  }

  async function runReview(picked, instruction) {
    if (busy || !reviewCollected) return;
    const items = reviewCollected.items.filter(it => picked.has(it));
    const chosen = new Set(items.map(it => it.author));
    if (!items.length) return;
    const byCard = new Map();
    for (const it of items) {
      if (!byCard.has(it.card)) byCard.set(it.card, []);
      byCard.get(it.card).push(it);
    }
    userMsg('댓글·제안 반영 · ' + Array.from(chosen).join(', ') + ' (' + items.length + '개)' + (instruction ? '\n' + instruction : ''));
    stopRequested = false;
    setBusy(true);
    const queue = Array.from(byCard.entries());
    for (const [c] of queue) { c.pinned = true; clearTimeout(c.unloadTimer); }
    const agents = Math.min(Number($('g-conc').value) || 3, queue.length);
    let next = 0;
    let done = 0;
    let total = 0;
    setProgress(0, queue.length);
    let finished = 0;
    await Promise.all(Array.from({ length: agents }, async (_, a) => {
      while (next < queue.length && !stopRequested) {
        const [card, list] = queue[next++];
        const r = await reviewOneDoc(card, list, a, instruction);
        done += r.done;
        total += r.total;
        setProgress(++finished, queue.length);
      }
    }));
    for (const [c] of queue) { c.pinned = false; scheduleUnload(c); }
    history.push({ instruction: '댓글·제안 반영 (' + Array.from(chosen).join(', ') + ')', result: '처리 ' + done + '/' + total, notes: [], changes: [] });
    history = history.slice(-HISTORY_TURNS);
    if (sessionId) chrome.storage.local.set({ ['grid:' + sessionId + ':history']: history }).catch(() => {});
    systemMsg((stopRequested ? '멈췄습니다 · ' : '댓글 반영 끝 · ') + total + '개 중 ' + done + '개 처리 · 나머지는 남겨 두었거나 실패', false);
    reviewCollected = null;
    setBusy(false);
  }

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
    if (busy) pop.appendChild(el('div', 'g-pop-note', '에이전트가 일하는 중에는 바꿀 수 없습니다'));
    for (const doc of poolDocs()) {
      const on = cards.some(c => c.doc.id === doc.id);
      const blocked = busy || (on ? cards.length <= 1 : cards.length >= GRID_MAX_CARDS);
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
    fresh.disabled = busy;
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
        const go = () => { if (!busy || !session) gotoSession(it.id); };
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
    $('g-review').addEventListener('click', ev => {
      ev.stopPropagation();
      if (!session) return;
      if ($('g-pop').hidden || $('g-review').getAttribute('aria-expanded') !== 'true') openReviewPicker();
      else closeHistory();
    });
    $('g-docs').addEventListener('click', ev => {
      ev.stopPropagation();
      if (!session) return;
      if ($('g-pop').hidden || $('g-docs').getAttribute('aria-expanded') !== 'true') openDocsPicker();
      else closeHistory();
    });
    // 켜고 끌 때 목록을 다시 그리므로 클릭한 줄이 이미 DOM에서 빠졌을 수 있다 — 이벤트 경로로 판단한다
    document.addEventListener('click', ev => { if (!ev.composedPath().includes($('g-pop'))) closeHistory(); });
    document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeHistory(); });
  }

  // ---------- 크기 조절 ----------
  // 채팅창 너비, 열 수, 열마다 너비 비율, 칸 높이를 끌어서 바꾸고 다음에 열 때도 그대로 쓴다.
  const UI_KEY = 'gridLayout';
  let ui = { chatW: 0, cols: 0, colFr: {}, rowH: 0 };
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
    root.setProperty('--card-h', ui.rowH ? ui.rowH + 'px' : rows <= 2 ? 'calc((100% - ' + (rows - 1) * 6 + 'px) / ' + rows + ')' : '46vh');
    if (ui.chatW) root.setProperty('--chat-w', ui.chatW + 'px');
    else root.removeProperty('--chat-w');
    cards.forEach((c, i) => c.root.classList.toggle('g-last-col', i % cols === cols - 1 || i === n - 1));
    const reset = $('g-reset');
    if (reset) reset.disabled = !(ui.chatW || ui.cols || ui.rowH || Object.keys(ui.colFr || {}).length);
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

  function startRowDrag(ev, card) {
    ev.preventDefault();
    const h0 = card.root.getBoundingClientRect().height;
    const y0 = ev.clientY;
    dragSession('row-resize', e => {
      ui.rowH = Math.round(Math.max(180, Math.min(window.innerHeight * 1.5, h0 + e.clientY - y0)));
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
    if (saved && typeof saved === 'object') ui = Object.assign(ui, saved, { colFr: Object.assign({}, saved.colFr) });
    const sel = $('g-cols');
    sel.value = String(ui.cols || 0);
    sel.addEventListener('change', () => {
      ui.cols = Number(sel.value) || 0;
      layout();
      saveUi();
    });
    $('g-reset').addEventListener('click', () => {
      ui = { chatW: 0, cols: 0, colFr: {}, rowH: 0 };
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
    history = Array.isArray(stored['grid:' + id + ':history']) ? stored['grid:' + id + ':history'] : [];
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
    const grid = $('g-grid');
    for (const c of cards) grid.appendChild(c.root);
    layout();
    await initLayoutControls();
    initHistoryPicker();
    trace('cards', cards.length + ' cards');
    for (const c of cards) c.readyPromise = waitReady(c).then(ok => { trace('ready', c.doc.name + ' ' + ok); return ok; });
    for (const c of cards) observeCard(c);

    const input = $('g-input');
    // ---------- / 명령 ----------
    // 기능 템플릿은 입력창에 /를 쳐서 부른다. 고른 명령은 입력창 안에 버튼 모양 꼬리표로 들어가고 여러 개 쌓을 수 있다.
    // 보내면(⌘Enter) 꼬리표 명령을 차례로 실행하고, 입력창에 쓴 말은 추가 지시로 함께 넘긴다.
    const COMMANDS = [
      { name: '맞춤법(룰베이스)', desc: '토이타입 규칙으로 기계적 검사 · AI는 오탐만 거름', kind: 'spell' },
      { name: '서식 점검', desc: '요소별 서식·표기 일관성, 첨자, 코너로 뺄 본문', kind: 'format' },
      { name: '댓글 반영', desc: '문서에 남은 댓글·제안을 골라 반영', kind: 'review' },
      { name: '도해 점검', desc: '그림·그리기 안 글자의 오탈자·용어를 점검 (지적만)', kind: 'figure' }
    ].concat(PRESETS.map(([label, text]) => ({ name: label, desc: text, kind: 'text', text })));
    const slash = $('g-slash');
    const pills = $('g-cmds');
    let picked = [];
    let slashItems = [];
    let slashIndex = 0;
    const squash = t => String(t || '').replace(/\s+/g, '').toLowerCase();
    // 커서 바로 앞의 "/검색어"
    const slashQuery = () => {
      const before = input.value.slice(0, input.selectionStart == null ? input.value.length : input.selectionStart);
      const m = /(^|\s)\/(\S*)$/.exec(before);
      return m ? { q: m[2], from: before.length - m[2].length - 1 } : null;
    };
    const hideSlash = () => { slash.hidden = true; slashItems = []; };
    const renderPills = () => {
      pills.textContent = '';
      pills.hidden = !picked.length;
      for (const c of picked) {
        const pill = el('span', 'g-cmd-pill');
        pill.title = c.desc;
        const x = el('button', 'g-cmd-x', '×');
        x.type = 'button';
        x.title = '빼기';
        x.addEventListener('click', () => { picked = picked.filter(p => p !== c); renderPills(); input.focus(); });
        pill.append(el('span', '', '/' + c.name), x);
        pills.appendChild(pill);
      }
    };
    const pickCommand = cmd => {
      const sq = slashQuery();
      if (sq) {
        const end = sq.from + 1 + sq.q.length;
        input.value = input.value.slice(0, sq.from) + input.value.slice(end);
        input.setSelectionRange(sq.from, sq.from);
      }
      if (!picked.includes(cmd)) picked.push(cmd);
      hideSlash();
      renderPills();
      input.focus();
    };
    const renderSlash = () => {
      const sq = slashQuery();
      if (!sq) return hideSlash();
      const q = squash(sq.q);
      slashItems = COMMANDS.filter(c => !picked.includes(c) && (!q || squash(c.name).includes(q)));
      if (!slashItems.length) return hideSlash();
      slashIndex = Math.min(slashIndex, slashItems.length - 1);
      slash.textContent = '';
      slashItems.forEach((c, i) => {
        const row = el('div', 'g-slash-item' + (i === slashIndex ? ' g-current' : ''));
        row.append(el('span', 'g-slash-name', '/' + c.name), el('span', 'g-slash-desc', c.desc));
        row.addEventListener('mousedown', ev => { ev.preventDefault(); pickCommand(c); });
        slash.appendChild(row);
      });
      slash.hidden = false;
    };
    // 꼬리표 명령 실행: 글 지시 템플릿은 한 번의 지시로 묶고, 서식 점검·댓글 반영은 그다음에 차례로
    const runPicked = async (cmds, extra) => {
      const texts = cmds.filter(c => c.kind === 'text');
      if (texts.length) await runInstruction(texts.map(c => c.text).join('\n') + (extra ? '\n' + extra : ''));
      if (cmds.some(c => c.kind === 'spell')) await runSpellCheck(texts.length ? '' : extra);
      if (cmds.some(c => c.kind === 'format')) await runFormatCheck(extra);
      if (cmds.some(c => c.kind === 'figure')) await runFigureCheck(extra);
      if (cmds.some(c => c.kind === 'review')) {
        if (extra && !texts.length) reviewInstruction = extra;
        $('g-review').click();
      }
    };
    $('g-compose').addEventListener('submit', ev => {
      ev.preventDefault();
      if (busy) return;
      // @all은 문서 선택용이라 에이전트에게 보내는 지시에서는 뺀다
      const text = input.value.replace(new RegExp(ALL_MENTION.source, 'gi'), '').trim();
      const cmds = picked.slice();
      if (!text && !cmds.length) return;
      input.value = '';
      hadAllMention = false;
      picked = [];
      renderPills();
      hideSlash();
      if (cmds.length) runPicked(cmds, text);
      else runInstruction(text);
    });
    input.addEventListener('input', () => { watchAllMention(input); slashIndex = 0; renderSlash(); });
    input.addEventListener('click', renderSlash);
    input.addEventListener('blur', () => setTimeout(hideSlash, 150));
    renderTargets();
    input.addEventListener('keydown', ev => {
      // 한글 조합 중 Enter는 크롬이 keydown을 두 번 보낸다(조합 확정 + 실제 Enter). 조합 중 것은 버린다
      if (ev.isComposing || ev.keyCode === 229) return;
      if (!slash.hidden && slashItems.length) {
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
          ev.preventDefault();
          slashIndex = (slashIndex + (ev.key === 'ArrowDown' ? 1 : -1) + slashItems.length) % slashItems.length;
          renderSlash();
          return;
        }
        if ((ev.key === 'Enter' && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey) || ev.key === 'Tab') {
          ev.preventDefault();
          pickCommand(slashItems[slashIndex]);
          return;
        }
        if (ev.key === 'Escape') { hideSlash(); return; }
      }
      // 빈 입력창에서 Backspace는 마지막 꼬리표를 뺀다
      if (ev.key === 'Backspace' && picked.length && input.selectionStart === 0 && input.selectionEnd === 0) {
        ev.preventDefault();
        picked.pop();
        renderPills();
        return;
      }
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        $('g-compose').requestSubmit();
      }
    });
    $('g-stop').addEventListener('click', stopAll);
    $('g-log').addEventListener('scroll', updateJump, { passive: true });
    pinScroll(document.documentElement);
    pinScroll(document.body);
    pinScroll(document.querySelector('.g-main'));
    pinScroll($('g-chat'));
    guardHeld($('g-grid'), 'grid');
    guardHeld($('g-log'), 'log');
    $('g-jump').addEventListener('click', () => jumpToBottom(true));
    $('g-top').addEventListener('click', jumpToTop);
    $('g-apply-all').addEventListener('click', applyAllPending);
    updateApplyAll();
    $('g-last').addEventListener('click', jumpToLastApplied);
    setInterval(syncAll, SYNC_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncAll(); });
    const savedLog = stored['grid:' + id + ':log'];
    trace('logLoad', savedLog && savedLog.entries ? savedLog.entries.length : 'none');
    // 탭을 닫거나 새로고침하기 직전에 대기 중인 저장을 바로 내보낸다
    window.addEventListener('pagehide', flushLog);
    if (savedLog) applyOptions(savedLog.options);
    if (savedLog && Array.isArray(savedLog.entries) && savedLog.entries.length) {
      restoreLog(savedLog);
      updateApplyAll();
      // 불러온 대화는 처음 한 번만 마지막 메시지가 보이게 둔다
      requestAnimationFrame(() => jumpToBottom(false));
      systemMsg('이전 대화를 불러왔습니다' + (history.length ? ' · 에이전트는 최근 ' + history.length + '턴을 기억합니다' : ''), false, false);
    } else if (history.length) {
      // 채팅창 저장 기능 전에 쓴 대화: 지시와 결과 요약만 남아 있으므로 그것으로 다시 그린다
      for (const turn of history) {
        userMsg(turn.instruction);
        systemMsg('결과 · ' + (turn.result || '기록 없음') + (turn.changes && turn.changes.length ? ' · ' + turn.changes.slice(0, 5).join(', ') : ''));
      }
      systemMsg('예전 대화라 요약만 불러왔습니다 · 에이전트는 최근 ' + history.length + '턴을 기억합니다', false, false);
    } else {
      systemMsg('문서 ' + cards.length + '개를 열었습니다. 지시를 쓰거나 아래 버튼을 누르세요. 기본은 제안 모드라 문서는 승인한 곳만 바뀝니다.', false, false);
    }
    $('g-auto').addEventListener('change', saveLog);
    $('g-conc').addEventListener('change', saveLog);

    // 예전 판에서 session에 있던 세션은 local로 옮겨 다음부터 유지되게 한다
    chrome.storage.local.set({ ['grid:' + id]: Object.assign(session, { touchedAt: Date.now() }), ['grid:' + id + ':history']: history }).catch(() => {});
  }

  start();
})();
