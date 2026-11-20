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
    const dot = el('span', 'g-ready-dot');
    dot.title = '에이전트 연결 준비 중';
    head.append(pick, dot, name, badge, meta, open);
    const wrap = el('div', 'g-frame-wrap');
    const frame = el('iframe', 'g-frame');
    frame.src = docUrl(doc.id, true);
    frame.setAttribute('allow', 'clipboard-read; clipboard-write');
    wrap.append(frame);
    root.append(head, wrap);
    Object.assign(card, { root, pick, badge, meta, frame, dot });
    return card;
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

  function scrollLog() {
    const log = $('g-log');
    log.scrollTop = log.scrollHeight;
  }

  function systemMsg(text, error) {
    const m = el('div', 'g-msg g-msg-system' + (error ? ' g-err' : ''), text);
    $('g-log').appendChild(m);
    scrollLog();
    return m;
  }

  function userMsg(text) {
    $('g-log').appendChild(el('div', 'g-msg g-msg-user', text));
    scrollLog();
  }

  function agentMsg(agent, who) {
    const m = el('div', 'g-msg g-msg-agent');
    m.style.setProperty('--agent', AGENT_COLORS[agent % AGENT_COLORS.length]);
    const avatar = el('div', 'g-avatar', String(agent + 1));
    const bubble = el('div', 'g-bubble');
    bubble.appendChild(el('div', 'g-bubble-who', who));
    const text = el('div', 'g-bubble-text');
    const typing = el('span', 'g-typing');
    typing.append(el('i'), el('i'), el('i'));
    text.appendChild(typing);
    bubble.appendChild(text);
    m.append(avatar, bubble);
    $('g-log').appendChild(m);
    scrollLog();
    return { root: m, bubble, text };
  }

  function buildEditItem(card, edit, auto) {
    const item = el('div', 'g-edit');
    const diff = el('div', 'g-edit-diff');
    diff.append(el('del', '', edit.src), document.createTextNode(' → '), el('ins', '', edit.dst || '(삭제)'));
    item.appendChild(diff);
    if (edit.reason) item.appendChild(el('div', 'g-edit-why', (edit.category ? '[' + edit.category + '] ' : '') + edit.reason));
    const row = el('div', 'g-edit-row');
    const state = el('span', 'g-edit-state', auto ? '적용 대기' : '');
    const show = el('button', 'g-btn', '위치');
    show.type = 'button';
    show.title = '문서에서 이 문구를 선택합니다';
    show.addEventListener('click', () => rpc(card, 'locate', { src: edit.state === 'applied' ? edit.dst : edit.src, hint: edit.hint }));
    const apply = el('button', 'g-btn', '적용');
    apply.type = 'button';
    apply.addEventListener('click', () => queueApply(card, edit));
    row.append(state, show, apply);
    item.appendChild(row);
    Object.assign(edit, { item, stateEl: state, applyBtn: apply, state: 'proposed' });
    return item;
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
      if (res.ok) {
        edit.state = 'applied';
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
    $('g-stop').disabled = !on;
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
    if (notReady.length) systemMsg('문서가 열리기를 기다리는 중… (' + notReady.length + '개)');
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
    task.cursor = cursor;
    if (!res || !res.ok) {
      rpc(card, 'agentCursorRemove', { id: cursor.id }, 3000);
      if (res && res.error === 'external_features_disabled') {
        msg.root.remove();
        return 'disabled';
      }
      msg.text.textContent = stopRequested ? '멈췄습니다.' : '이 구간은 처리하지 못했습니다. (' + (res && (res.message || res.error) || '오류') + ')';
      return 0;
    }
    const edits = (res.findings || []).map(f => ({
      src: f.source, dst: f.replacement, reason: f.reason, category: f.category,
      hint: chunk.start + (Number(f.offset) || 0)
    }));
    task.note = res.note || '';
    msg.text.textContent = res.note || (edits.length ? '고칠 곳 ' + edits.length + '개를 찾았습니다.' : '고칠 곳이 없습니다.');
    if (edits.length) {
      const list = el('div', 'g-edits');
      for (const edit of edits) list.appendChild(buildEditItem(card, edit, auto));
      msg.bubble.appendChild(list);
      card.counts.proposed += edits.length;
      updateMeta(card);
      if (auto) {
        // 커서가 고칠 곳으로 차례로 옮겨 가며 고친 뒤 사라진다
        Promise.all(edits.map(edit => queueApply(card, edit, cursor)))
          .then(() => rpc(card, 'agentCursorRemove', { id: cursor.id }, 3000));
        task.recorded = edits;
        scrollLog();
        return edits.length;
      } else if (edits.length > 1) {
        const actions = el('div', 'g-msg-actions');
        const all = el('button', 'g-btn', '모두 적용');
        all.type = 'button';
        all.addEventListener('click', () => {
          all.disabled = true;
          for (const edit of edits) queueApply(card, edit);
        });
        actions.appendChild(all);
        msg.bubble.appendChild(actions);
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
    if (sessionId) chrome.storage.session.set({ ['grid:' + sessionId + ':history']: history }).catch(() => {});
  }

  function stopAll() {
    stopRequested = true;
    for (const id of liveRequests) send({ type: 'typo:aiBridgeAbort', requestId: id });
    systemMsg('멈추는 중…');
  }

  // ---------- 시작 ----------

  function layout() {
    const n = cards.length;
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
    const rows = Math.ceil(n / cols);
    document.documentElement.style.setProperty('--cols', String(cols));
    // 두 줄까지는 화면을 꽉 채우고, 그보다 많으면 칸 높이를 고정하고 스크롤한다
    document.documentElement.style.setProperty('--card-h', rows <= 2 ? 'calc((100% - ' + (rows - 1) * 10 + 'px) / ' + rows + ')' : '46vh');
  }

  async function start() {
    const id = location.hash.slice(1);
    sessionId = id;
    const stored = id ? await chrome.storage.session.get(['grid:' + id, 'grid:' + id + ':history']) : {};
    session = stored['grid:' + id];
    trace('start', 'session ' + (session ? session.docs.length : 'missing'));
    history = Array.isArray(stored['grid:' + id + ':history']) ? stored['grid:' + id + ':history'] : [];
    if (!session || !Array.isArray(session.docs) || !session.docs.length) {
      systemMsg('격자에 띄울 문서 정보가 없습니다 · 드라이브에서 문서를 고르고 [격자 보기]를 다시 누르세요', true);
      setBusy(true);
      $('g-stop').disabled = true;
      return;
    }
    $('g-sub').textContent = '문서 ' + session.docs.length + '개';
    document.title = '격자 보기 · 문서 ' + session.docs.length + '개';
    cards = session.docs.map(buildCard);
    const grid = $('g-grid');
    for (const c of cards) grid.appendChild(c.root);
    layout();
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
    if (history.length) systemMsg('이전 대화 ' + history.length + '턴을 이어서 기억합니다 · 마지막 지시: ' + history[history.length - 1].instruction.slice(0, 40));
    systemMsg('문서 ' + cards.length + '개를 열었습니다. 지시를 쓰거나 아래 버튼을 누르세요. 기본은 제안 모드라 문서는 승인한 곳만 바뀝니다.');
  }

  start();
})();
