// 토인비 편집 — 격자 보기 (실제 문서 + 에이전트 채팅)
// 드라이브에서 고른 구글 문서를 한 탭 안에 격자로 띄우고(실제 편집기), 오른쪽 채팅창에서 에이전트들에게 지시한다.
// 에이전트는 문서를 구간으로 나눠 맡고, 일하는 구간을 문서에서 실제로 선택해 보여 준다.
// 고칠 곳은 채팅에 올리고, [바로 적용]이면 문서 칸 안의 토인비 편집이 패널의 [적용]과 같은 방식으로 바꾼다
// (그래서 실행 취소·버전 기록에 그대로 남는다).
'use strict';

(() => {
  const AGENT_COLORS = ['#1a73e8', '#e37400', '#188038', '#8430ce', '#d01884', '#12839b'];
  const DOCS_ORIGIN = 'https://docs.google.com';
  const CHUNK_MIN = 1500;
  const CHUNK_MAX = 6000;
  const AI_TIMEOUT_MS = 300000;
  const RPC_TIMEOUT_MS = 30000;
  const READY_TIMEOUT_MS = 90000;
  const PRESETS = [
    ['전체 교정', '이 원고를 교정해 줘. 비문, 어색한 문장, 잘못된 기술 설명, 용어 혼용을 고쳐 줘.'],
    ['합니다체 통일', '본문 서술을 합니다체로 통일해 줘. 인용·예시 대화·코드는 그대로 둬.'],
    ['비문만', '문법적으로 틀린 문장(비문)만 최소한으로 고쳐 줘.'],
    ['용어 표기 통일', '같은 용어가 다른 표기로 섞인 곳을 가장 많이 쓴 표기로 통일해 줘.'],
    ['문장 다듬기', '뜻은 그대로 두고 길고 어색한 문장만 짧고 자연스럽게 다듬어 줘.']
  ];

  const HISTORY_TURNS = 6;

  const $ = id => document.getElementById(id);
  let session = null;
  let sessionId = '';
  // 대화 맥락: 지시마다 결과를 짧게 요약해 두고 다음 지시 때 에이전트에게 같이 보낸다.
  // 구간마다 에이전트는 새로 시작하지만 이 요약 덕분에 "아까처럼", "방금 고친 것 중" 같은 말이 통한다.
  let history = [];
  let cards = [];
  let busy = false;
  let stopRequested = false;
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
    if (ev.origin !== DOCS_ORIGIN || !ev.data || ev.data.kind !== 'toytype-grid-rpc-result') return;
    const waiter = rpcWaiters.get(ev.data.id);
    if (!waiter) return;
    rpcWaiters.delete(ev.data.id);
    waiter(ev.data.res || { ok: false, error: 'empty' });
  });

  function rpc(card, op, args, timeoutMs) {
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
      const res = await rpc(card, 'ping', {}, 1500);
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
    wrap.append(frame);
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

  function reloadCard(card, auto) {
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
    if (!card.ready || card.root.classList.contains('g-working')) return;
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
        edits: (e.edits || []).map(x => ({
          src: x.src, dst: x.dst, reason: x.reason, category: x.category, hint: x.hint,
          state: x.state === 'applied' ? 'applied' : x.state === 'failed' ? 'failed' : 'proposed'
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

  function scrollLog() {
    const log = $('g-log');
    log.scrollTop = log.scrollHeight;
  }

  // persist=false: 잠깐 보이는 안내(대기 중·멈추는 중 등)는 기록하지 않는다
  function systemMsg(text, error, persist) {
    pushEntry({ t: 'system', text, error: !!error }, persist);
    const m = el('div', 'g-msg g-msg-system' + (error ? ' g-err' : ''), text);
    $('g-log').appendChild(m);
    scrollLog();
    return m;
  }

  function userMsg(text, persist) {
    pushEntry({ t: 'user', text }, persist);
    $('g-log').appendChild(el('div', 'g-msg g-msg-user', text));
    scrollLog();
  }

  function agentMsg(agent, who, restored) {
    const entry = restored || pushEntry({ t: 'agent', agent, who, text: '', pending: true, docId: '', edits: [] });
    const m = el('div', 'g-msg g-msg-agent');
    m.style.setProperty('--agent', AGENT_COLORS[agent % AGENT_COLORS.length]);
    // who: "에이전트 N · 문서 · i/n · 구간 첫 줄" → 머리줄(이름·위치)과 인용 한 줄로 나눠 보여 준다
    const parts = String(who || '').split(' · ');
    const head = el('div', 'g-agent-head');
    head.append(el('span', 'g-avatar', String(agent + 1)), el('span', 'g-agent-name', parts[0] || ''), el('span', 'g-agent-where', parts.slice(1, 3).join(' · ')));
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
    if (edit.reason) item.appendChild(el('div', 'g-edit-why', (edit.category ? '[' + edit.category + '] ' : '') + edit.reason));
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
      const res = await rpc(card, 'locate', { src: first || second, alts: [second].filter(Boolean), hint: edit.hint }, 15000);
      show.disabled = false;
      if (!res.ok) flashState(edit, '문서에서 찾지 못함');
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
  }

  function queueApply(card, edit, agentCursor) {
    if (edit.state === 'applied' || edit.state === 'applying' || edit.state === 'queued') return Promise.resolve();
    edit.state = 'queued';
    edit.applyBtn.disabled = true;
    edit.stateEl.textContent = '적용 대기';
    const run = card.applyChain.then(async () => {
      if (stopRequested) {
        edit.state = 'proposed';
        edit.applyBtn.disabled = false;
        edit.stateEl.textContent = '멈춤';
        return;
      }
      edit.state = 'applying';
      edit.stateEl.textContent = '적용 중…';
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
    $('g-send').disabled = on;
    $('g-stop').hidden = !on;
    $('g-conc').disabled = on;
    for (const chip of document.querySelectorAll('.g-chip')) chip.disabled = on;
  }

  function setProgress(done, total) {
    $('g-progress-fill').style.width = total ? Math.round(done / total * 100) + '%' : '0';
  }

  async function runInstruction(instruction) {
    if (busy) return;
    const targets = cards.filter(c => c.pick.checked);
    if (!targets.length) {
      systemMsg('작업할 문서를 하나 이상 체크하세요', true);
      return;
    }
    userMsg(instruction);
    stopRequested = false;
    setBusy(true);
    const auto = $('g-auto').checked;
    const agents = Number($('g-conc').value) || 3;
    const notReady = targets.filter(c => !c.ready);
    if (notReady.length) systemMsg('문서가 열리기를 기다리는 중… (' + notReady.length + '개)', false, false);
    await Promise.all(notReady.map(c => c.readyPromise));

    // 문서 본문을 칸 안의 편집기에서 직접 읽는다(적용할 때 쓰는 위치와 같은 기준)
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
    const tasks = [];
    for (let round = 0; queues.some(q => round < q.length); round++) {
      for (const q of queues) if (round < q.length) tasks.push(q[round]);
    }
    if (!tasks.length) {
      setBusy(false);
      return;
    }
    systemMsg('에이전트 ' + Math.min(agents, tasks.length) + '명이 문서 ' + queues.length + '개를 구간 ' + tasks.length + '개로 나눠 맡습니다' + (auto ? ' · 바로 적용' : ' · 제안 모드'));
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
    else systemMsg((stopRequested ? '멈췄습니다 · ' : '끝 · ') + '고칠 곳 ' + total + '개' + (auto ? ' · 적용 ' + targets.reduce((n, c) => n + c.counts.applied, 0) + '개(누적)' : ''));
    setBusy(false);
  }

  function renderEdits(msg, card, edits, auto) {
    const list = el('div', 'g-edits');
    for (const edit of edits) list.appendChild(buildEditItem(card, edit, auto));
    msg.bubble.appendChild(list);
    if (!auto && edits.filter(e => e.state !== 'applied').length > 1) {
      const actions = el('div', 'g-msg-actions');
      const all = el('button', 'g-link', '모두 적용');
      all.type = 'button';
      all.addEventListener('click', () => {
        all.disabled = true;
        for (const edit of edits) queueApply(card, edit);
      });
      actions.appendChild(all);
      msg.bubble.appendChild(actions);
    }
  }

  // 저장해 둔 채팅창을 다시 그린다. 적용된 제안은 적용됨으로, 진행 중이던 것은 제안으로 돌아온다.
  function restoreLog(saved) {
    for (const e of saved.entries || []) {
      if (e.t === 'system') systemMsg(e.text, e.error);
      else if (e.t === 'user') userMsg(e.text);
      else if (e.t === 'agent') {
        const entry = { t: 'agent', agent: Number(e.agent) || 0, who: String(e.who || ''), text: String(e.text || ''), pending: false, docId: e.docId, edits: [] };
        logEntries.push(entry);
        const msg = agentMsg(entry.agent, entry.who, entry);
        msg.text.textContent = entry.text;
        const card = cards.find(c => c.doc.id === e.docId);
        const edits = (e.edits || []).map(x => Object.assign({}, x));
        entry.edits = edits;
        if (card && edits.length) {
          const states = edits.map(x => x.state);
          renderEdits(msg, card, edits, false);
          edits.forEach((edit, i) => {
            if (states[i] === 'applied') {
              edit.state = 'applied';
              edit.item.classList.add('g-applied');
              edit.stateEl.textContent = '✓ 적용됨';
              edit.applyBtn.disabled = true;
              card.counts.applied++;
            } else if (states[i] === 'failed') {
              edit.state = 'failed';
              edit.item.classList.add('g-failed');
              edit.stateEl.textContent = '적용 실패 · 다시 시도';
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
    const requestId = 'grid-' + card.doc.id.slice(0, 8) + '-' + idx + '-' + Date.now().toString(36);
    liveRequests.add(requestId);
    const res = await send({
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
      msg.text.textContent = stopRequested ? '멈췄습니다.' : '이 구간은 처리하지 못했습니다. (' + (res && (res.message || res.error) || '오류') + ')';
      msg.entry.text = msg.text.textContent;
      saveLog();
      return 0;
    }
    const edits = (res.findings || []).map(f => ({
      src: f.source, dst: f.replacement, reason: f.reason, category: f.category,
      hint: chunk.start + (Number(f.offset) || 0)
    }));
    task.note = res.note || '';
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
    await chrome.storage.local.set({ ['grid:' + id]: { docs: session.docs, authuser: session.authuser, createdAt: Date.now(), touchedAt: Date.now() } });
    gotoSession(id);
  }

  function closeHistory() {
    $('g-pop').hidden = true;
    $('g-history').setAttribute('aria-expanded', 'false');
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
  }

  function initHistoryPicker() {
    const btn = $('g-history');
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      if ($('g-pop').hidden) openHistory();
      else closeHistory();
    });
    document.addEventListener('click', ev => { if (!$('g-pop').contains(ev.target)) closeHistory(); });
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
    // 예전 판은 session 저장소에 두었다 — 거기 있으면 그대로 읽는다
    const stored = id ? Object.assign({}, await chrome.storage.session.get(keys).catch(() => ({})), await chrome.storage.local.get(keys)) : {};
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

    const presets = $('g-presets');
    for (const [label, text] of PRESETS) {
      const chip = el('button', 'g-chip', label);
      chip.type = 'button';
      chip.title = text;
      chip.addEventListener('click', () => runInstruction(text));
      presets.appendChild(chip);
    }
    const input = $('g-input');
    $('g-compose').addEventListener('submit', ev => {
      ev.preventDefault();
      const text = input.value.trim();
      if (!text || busy) return;
      input.value = '';
      runInstruction(text);
    });
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        $('g-compose').requestSubmit();
      }
    });
    $('g-stop').addEventListener('click', stopAll);
    setInterval(syncAll, SYNC_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncAll(); });
    const savedLog = stored['grid:' + id + ':log'];
    trace('logLoad', savedLog && savedLog.entries ? savedLog.entries.length : 'none');
    // 탭을 닫거나 새로고침하기 직전에 대기 중인 저장을 바로 내보낸다
    window.addEventListener('pagehide', flushLog);
    if (savedLog) applyOptions(savedLog.options);
    if (savedLog && Array.isArray(savedLog.entries) && savedLog.entries.length) {
      restoreLog(savedLog);
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
    for (const c of cards) c.pick.addEventListener('change', saveLog);
    // 예전 판에서 session에 있던 세션은 local로 옮겨 다음부터 유지되게 한다
    chrome.storage.local.set({ ['grid:' + id]: Object.assign(session, { touchedAt: Date.now() }), ['grid:' + id + ':history']: history }).catch(() => {});
  }

  start();
})();
