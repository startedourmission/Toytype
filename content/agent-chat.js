// 토인비 편집 — 에이전트 대화 엔진(격자 보기와 문서 안 패널이 같이 쓴다)
// 지시를 받아 문서를 구간으로 나눠 AI에게 보내고, 고칠 곳을 [위치]·[적용] 제안으로 올린다. 질문·요약·댓글 반영·서식 점검·
// 도해 점검·배경색 해제까지 여기 있다. 화면(문서 칸, 크기 조절, 대상 문서 고르기)은 쓰는 쪽(host)이 맡는다.
//
// host가 주는 것:
//   root            채팅 마크업(markup())을 넣은 요소 — 이 안에서 id로 찾는다
//   rpc(card, op, args, timeoutMs)   문서에 명령 보내기(격자: 칸 iframe, 문서 패널: 같은 페이지)
//   revealCard, setWorking, updateMeta, scheduleUnload, loadCard, setFullEditor, trace
//   applyOptions(o), saveOptions(), onBusy(on), onInput(input), cleanInput(text), onSent()   (없어도 됨)
// card: { doc:{id,name}, text, ready, readyPromise, counts:{proposed,applied}, pick:{checked}, applyChain, ... }
'use strict';

(() => {
  if (globalThis.ToytypeAgentChat) return;

  // 채팅 마크업. grid: 격자 전용 버튼(문서·기록·열·크기)과 대상 문서 칩 자리를 넣는다
  function markup(opts) {
    const grid = !!(opts && opts.grid);
    return `<div class="g-progress"><div class="g-progress-fill" id="g-progress-fill"></div></div>
    <header class="g-chat-head">
      <div class="g-titlebar">
        <span class="g-chat-title">${opts && opts.title ? opts.title : '에이전트'}</span>
        <span class="g-chat-sub" id="g-sub"></span>
        <button type="button" class="g-stop" id="g-stop" hidden>멈춤</button>
        <button type="button" class="g-ghost" id="g-review" aria-haspopup="true" aria-expanded="false" title="문서에 남은 댓글·제안을 작성자별로 골라 AI가 판단해 반영·해결합니다">댓글 반영</button>
        ${grid ? `<button type="button" class="g-ghost" id="g-docs" aria-haspopup="true" aria-expanded="false" title="격자에 띄울 문서 켜고 끄기">문서</button>
        <button type="button" class="g-ghost" id="g-history" aria-haspopup="true" aria-expanded="false" title="이전 대화 고르기">기록</button>` : ''}
        ${opts && opts.extraHead ? opts.extraHead : ''}
      </div>
      <div class="g-pop" id="g-pop" hidden></div>
      <div class="g-toolbar">
        ${grid ? `<label class="g-field" title="한 줄에 놓을 문서 수"><span>열</span>
          <select id="g-cols"><option value="0">자동</option><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option></select>
        </label>` : ''}
        <label class="g-switch" title="켜면 에이전트가 고친 곳을 문서에 바로 반영합니다. 끄면 제안만 받고 직접 승인합니다.">
          <input type="checkbox" id="g-auto"><span class="g-switch-track" aria-hidden="true"></span><span>바로 적용</span>
        </label>
        <button type="button" class="g-apply-all" id="g-apply-all" title="이 대화에서 아직 적용 안 된 제안을 전부 문서에 적용합니다" hidden>전체 적용</button>
        <div class="g-nav" id="g-nav" hidden>
          <button type="button" class="g-nav-btn" id="g-top" title="맨 위로" aria-label="맨 위로">↑</button>
          <button type="button" class="g-nav-btn g-nav-last" id="g-last" title="마지막으로 [적용]을 누른 곳으로" aria-label="마지막으로 적용을 누른 곳으로">최근 적용</button>
          <button type="button" class="g-nav-btn" id="g-jump" title="맨 아래로" aria-label="맨 아래로">↓</button>
        </div>
        ${grid ? `<button type="button" class="g-reset" id="g-reset" title="열 수·열 너비·칸 높이·채팅창 너비를 처음대로 되돌립니다" disabled>크기 원래대로</button>` : ''}
      </div>
    </header>
    <div class="g-log-wrap">
      <div class="g-log" id="g-log"></div>
    </div>
    <footer class="g-composer">
      ${grid ? `<div class="g-targets" id="g-targets" title="에이전트가 맡을 문서 · 눌러서 넣고 빼기 · 입력창에 @all을 쓰면 전부 선택, 지우면 전부 해제"></div>` : ''}
      <div class="g-slash" id="g-slash" hidden></div>
      <form class="g-compose" id="g-compose">
        <div class="g-compose-main">
        <div class="g-cmds" id="g-cmds" hidden></div>
        <textarea id="g-input" rows="2" placeholder="에이전트에게 지시하세요 · /로 기능 부르기 (/서식 점검, /전체 교정, /댓글 반영 …)"></textarea>
        </div>
        <button type="submit" class="g-send" id="g-send" title="보내기 (⌘Enter)" aria-label="보내기">↑</button>
      </form>
      <div class="g-hint">⌘Enter로 보내기 · /로 기능 부르기${grid ? ' · @all로 전부 선택' : ''}</div>
    </footer>`;
  }

  function create(host) {
    const root = host.root;
    const $ = id => root.querySelector('#' + id);
    const trace = host.trace || (() => {});
    const rpc = host.rpc;
    const noop = () => {};
    const revealCard = host.revealCard || noop;
    const setWorking = host.setWorking || noop;
    const updateMeta = host.updateMeta || noop;
    const scheduleUnload = host.scheduleUnload || noop;
    const loadCard = host.loadCard || noop;
    const setFullEditor = host.setFullEditor || noop;

    const AI_COLOR = '#1a73e8';
    const AI_NAME = 'AI';
    // 한 번에 같이 보내는 구간·문서 수(고정)
    const CONCURRENCY = 3;
    const CHUNK_MIN = 1500;
    const CHUNK_MAX = 6000;
    const AI_TIMEOUT_MS = 300000;
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

    // 대화 저장 키('grid:<id>' 또는 'docchat:<docId>')와 세션(편집자 결정·문서 목록·계정 번호)
    let storeKey = '';
    let session = null;
    // 대화 맥락: 지시마다 결과를 짧게 요약해 두고 다음 지시 때 에이전트에게 같이 보낸다.
    let history = [];
    let cards = [];
    let busy = false;
    // 작업 중에 누른 질문 카드 반영은 줄 세워 두었다가 지금 작업이 끝나면 차례로 돌린다
    let queuedFollowUps = [];
    // 지시(턴)마다 구간 메시지 DOM — 끝나면 요약 아래로 접어 넣는다
    const turnEls = new Map();
    // 전체 적용이 도는 동안만 [전체 적용]·[이 대화 모두 적용]을 꺼 둔다
    let applyingAll = false;
    let stopRequested = false;
    let stopGen = 0;
    const liveRequests = new Set();

    function el(tag, cls, text) {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text !== undefined) node.textContent = text;
      return node;
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

    function closePop() {
      $('g-pop').hidden = true;
      for (const id of ['g-history', 'g-docs', 'g-review']) if ($(id)) $(id).setAttribute('aria-expanded', 'false');
    }

    // ---------- 채팅 ----------
    // 채팅창 내용은 logEntries에 데이터로 쌓고 local 저장소에 남겨, 탭을 새로고침해도 그대로 다시 그린다.
    const LOG_MAX_ENTRIES = 300;
    let logEntries = [];
    let logSaveTimer = 0;

    function saveLog() {
      updateApplyAll();
      if (!storeKey) return;
      clearTimeout(logSaveTimer);
      logSaveTimer = setTimeout(flushLog, 400);
    }

    function flushLog() {
      clearTimeout(logSaveTimer);
      if (!storeKey || !session) return;
      try {
        const entries = logEntries.slice(-LOG_MAX_ENTRIES).map(e => e.t !== 'agent' ? e : {
          t: 'agent', agent: e.agent, who: e.who, text: e.pending ? '(새로고침으로 중단됨)' : e.text, docId: e.docId,
          review: Array.isArray(e.review) ? e.review.slice(0, 200) : undefined,
          format: Array.isArray(e.format) ? e.format.slice(0, 300) : undefined,
          figure: Array.isArray(e.figure) ? e.figure.slice(0, 300) : undefined,
          flags: Array.isArray(e.flags) && e.flags.length ? e.flags : undefined,
          turn: e.turn || undefined,
          edits: (e.edits || []).map(x => ({
            src: x.src, dst: x.dst, reason: x.reason, category: x.category, hint: x.hint, pressedAt: x.pressedAt || 0, refs: x.refs || undefined, fmt: x.fmt || undefined, drw: x.drw || undefined,
            state: x.state === 'applied' ? 'applied' : x.state === 'failed' ? 'failed' : x.state === 'rejected' ? 'rejected' : 'proposed',
            note: x.state === 'rejected' || x.reviewed ? (x.stateEl && x.stateEl.textContent || x.note || '') : undefined
          }))
        });
        const options = Object.assign({ auto: $('g-auto').checked }, host.saveOptions ? host.saveOptions() : {});
        chrome.storage.local.set({
          [storeKey + ':log']: { entries, options },
          [storeKey]: Object.assign(session, { touchedAt: Date.now() })
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
      chrome.storage.local.set({ [storeKey]: Object.assign(session, { touchedAt: Date.now() }) }).catch(() => {});
    }

    function collectQuestions(list) {
      for (const q of list || []) {
        const key = topicKey(q);
        if (askedThisRun.has(key)) continue;
        if (decisions().some(d => d.split(': ')[0].replace(/\s+/g, '').toLowerCase() === key)) continue;
        const same = runQuestions.find(x => String(x.topic || x.question).replace(/\s+/g, '').toLowerCase() === key);
        if (same) {
          for (const o of q.options) if (!same.options.includes(o) && same.options.length < 4) same.options.push(o);
        } else if (runQuestions.length < 3) {
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
          again.disabled = answered < entry.items.length || entry.started || !!entry.queued;
          again.textContent = entry.started ? '시작했습니다' : entry.queued ? '지금 작업이 끝나면 바로 시작합니다' : answered < entry.items.length ? '남은 질문 ' + (entry.items.length - answered) + '개에 답하세요' : '답한 대로 시작';
          return;
        }
        // 넘긴 답은 고칠 게 없으므로 정한 답만 센다
        const decided = entry.items.filter(q => q.answer && q.answer !== '(넘김)').length;
        const followText = !!(entry.followUp && entry.followUp.instruction);
        again.disabled = !(followText ? decided : answered) || !!entry.queued;
        // 작업 중에 답하면 남은 구간에는 바로 들어간다. 누르면 이미 끝난 구간 반영을 줄 세워 두고, 지금 작업이 끝나면 돌린다
        again.textContent = entry.queued ? '지금 작업이 끝나면 바로 반영합니다'
          : busy && live && decided ? '정한 ' + decided + '개를 끝난 구간에도 반영 (작업 끝나면 실행)'
          : followText ? (decided ? '정한 ' + decided + '개를 원고에 반영' : answered ? '모두 넘겼습니다' : '답을 고르세요')
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
      const go = () => {
        entry.queued = false;
        again.disabled = true;
        const f = entry.followUp || {};
        if (pre) { entry.started = true; saveLog(); }
        if (f.kind === 'format') runFormatCheck(f.extra || '');
        else if (pre && f.instruction) runInstruction(f.instruction, { answered: true });
        else if (f.instruction) {
          // 작업 중·끝난 뒤 질문: 원래 지시(전체 교정 등)를 처음부터 다시 돌리지 않고, 정한 것만 원고에 맞춘다
          const picked = entry.items.filter(q => q.answer && q.answer !== '(넘김)');
          if (!picked.length) { again.disabled = false; return; }
          runInstruction('편집자가 방금 정한 것에 맞춰 원고를 고쳐 줘. 이 결정과 어긋나는 곳만 고치고, 그 밖의 교정은 하지 마.\n'
            + picked.map(q => '· ' + (q.topic || q.question) + ': ' + q.answer).join('\n'));
        }
      };
      again.addEventListener('click', () => {
        if (!busy) { go(); return; }
        // 작업 중이면 막지 않고 줄 세운다
        entry.queued = true;
        queuedFollowUps.push({ entry, go, sync });
        sync();
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

    // ---------- 지시 요약 ----------
    // 지시가 끝나면 구간 메시지를 일일이 읽지 않아도 되게, 문서별 개수·범주, 자주 나온 수정, 확인할 것을 한 덩어리로 보여 주고
    // 구간 메시지는 [구간별 보기]로 접는다.
    const DEFAULT_NOTE_RE = /^고칠 곳 \d+개(를 찾았습니다\.)?$/;
    function buildTurnSummary(turn) {
      const entries = logEntries.filter(e => e.t === 'agent' && e.turn === turn);
      const docs = new Map();
      const pats = new Map();
      const flags = [];
      const reports = [];
      for (const e of entries) {
        const card = cards.find(c => c.doc.id === e.docId);
        const name = card ? card.doc.name : String(e.who || '').split(' · ')[0];
        const edits = e.edits || [];
        if (!docs.has(name)) docs.set(name, { name, count: 0, applied: 0, cats: {}, flags: 0 });
        const d = docs.get(name);
        d.flags += (e.flags || []).length;
        for (const x of edits) {
          d.count++;
          if (x.state === 'applied') d.applied++;
          const c = x.category || '기타';
          d.cats[c] = (d.cats[c] || 0) + 1;
          const k = x.src + ' → ' + (x.dst || '(삭제)');
          if (k.length <= 60) pats.set(k, (pats.get(k) || 0) + 1);
        }
        const where = String(e.who || '').split(' · ').slice(0, 2).join(' ');
        const note = String(e.text || '').trim();
        if (!note || DEFAULT_NOTE_RE.test(note) || /^(멈췄습니다|\(새로고침)/.test(note)) continue;
        // 처리에 실패한 구간만 알린다(AI 보고는 보여 주지 않는다)
        if (/처리하지 못했습니다/.test(note)) flags.push(where + ': ' + note);
      }
      return {
        turn,
        docs: Array.from(docs.values()).filter(d => d.count || d.flags),
        patterns: Array.from(pats).filter(p => p[1] > 1).sort((a, b) => b[1] - a[1]).slice(0, 6),
        flags: flags.slice(0, 12),
        reports: reports.slice(0, 30),
        chunks: entries.length
      };
    }

    function renderTurnSummary(m, sum) {
      const box = el('div', 'g-sum');
      for (const d of sum.docs || []) {
        const cats = Object.entries(d.cats || {}).sort((a, b) => b[1] - a[1]).map(([c, n]) => c + ' ' + n).join(' · ');
        const row = el('div', 'g-sum-doc');
        row.append(el('b', '', d.name), document.createTextNode(' ' + d.count + '곳' + (d.applied ? ' (적용 ' + d.applied + ')' : '') + (cats ? ' — ' + cats : '') + (d.flags ? ' · 직접 확인 ' + d.flags : '')));
        box.appendChild(row);
      }
      if ((sum.patterns || []).length) {
        box.appendChild(el('div', 'g-sum-pats', '자주 나온 수정: ' + sum.patterns.map(([p, n]) => p + ' ×' + n).join(', ')));
      }
      if ((sum.flags || []).length) {
        const f = el('div', 'g-sum-flags');
        f.appendChild(el('div', 'g-sum-label', '처리 못 한 구간 ' + sum.flags.length + '개'));
        for (const t of sum.flags) f.appendChild(el('div', 'g-sum-flag', '· ' + t));
        box.appendChild(f);
      }
      if ((sum.reports || []).length) {
        const r = el('details', 'g-sum-more');
        r.appendChild(el('summary', '', '구간 보고 ' + sum.reports.length + '개'));
        for (const t of sum.reports) r.appendChild(el('div', 'g-sum-flag', '· ' + t));
        box.appendChild(r);
      }
      if (box.childNodes.length) { m.classList.add('g-msg-summary'); m.appendChild(box); }
      collapseTurn(sum.turn, m);
    }

    // 그 지시의 구간 메시지를 요약 바로 뒤 [구간별 보기]로 접는다(질문 카드는 그대로 둔다)
    function collapseTurn(turn, after) {
      const els = (turnEls.get(turn) || []).filter(x => x.isConnected);
      if (!els.length) return;
      const det = el('details', 'g-turn-chunks');
      det.appendChild(el('summary', '', '구간별 보기 (' + els.length + '개)'));
      for (const x of els) det.appendChild(x);
      after.after(det);
      turnEls.delete(turn);
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
      // "계획 · ..."은 계획·규칙 메시지로 따로 보여 준다(예전 기록의 "팀장 · " 포함)
      const lead = /^(계획|팀장) · /.test(String(text || ''));
      pushEntry({ t: 'system', text, error: !!error }, persist);
      const body = String(text || '');
      const cut = lead ? body.indexOf('\n') : -1;
      let m;
      if (cut > 0) {
        // 계획 메시지는 한 줄 요약만 보이고, 작업 요령·규칙은 눌러야 펼친다
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
      const m = el('div', 'g-msg g-msg-agent');
      m.style.setProperty('--agent', AI_COLOR);
      // who: "문서 · 위치 · 구간 첫 줄" → 머리줄(문서·위치)과 인용 한 줄로 나눠 보여 준다.
      // 예전 기록의 "에이전트 N"·"맞춤법 규칙" 머리말은 뗀다
      const parts = String(who || '').replace(/^(에이전트 \d+|맞춤법 규칙) · /, '').split(' · ');
      const head = el('div', 'g-agent-head');
      head.append(el('span', 'g-avatar', AI_NAME), el('span', 'g-agent-name', parts[0] || ''), el('span', 'g-agent-where', parts.slice(1, 2).join(' · ')));
      m.appendChild(head);
      if (parts.length > 2) m.appendChild(el('div', 'g-agent-quote', parts.slice(2).join(' · ')));
      const text = el('div', 'g-bubble-text');
      const typing = el('span', 'g-typing');
      typing.append(el('i'), el('i'), el('i'));
      text.appendChild(typing);
      m.appendChild(text);
      $('g-log').appendChild(m);
      if (entry.turn) {
        if (!turnEls.has(entry.turn)) turnEls.set(entry.turn, []);
        turnEls.get(entry.turn).push(m);
      }
      scrollLog();
      return { root: m, bubble: m, text, entry };
    }

    function buildEditItem(card, edit, auto) {
      const item = el('div', 'g-edit');
      const diff = el('div', 'g-edit-diff');
      if (edit.drw) diff.append(el('span', 'g-fmt-src', edit.src), el('span', 'g-edit-arrow', '→'), el('ins', '', drwLabel(edit.drw)));
      else if (edit.fmt) diff.append(el('span', 'g-fmt-src', edit.src), el('span', 'g-edit-arrow', '→'), el('ins', '', fmtLabel(edit.fmt)));
      else diff.append(el('del', '', edit.src), el('span', 'g-edit-arrow', '→'), el('ins', '', edit.dst || '(삭제)'));
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
        if (edit.drw) { revealCard(card); rpc(card, 'revealObject', { pos: edit.drw.pos }, 15000); return; }
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
      // 도해 제안은 바꾼 그리기를 클립보드로도 받을 수 있다(그리기 창에 직접 붙여 넣기)
      if (edit.drw) {
        const copy = el('button', 'g-link', '복사');
        copy.type = 'button';
        copy.title = '바꾼 도해를 클립보드에 담습니다 · 그리기 창에서 붙여 넣으세요';
        copy.addEventListener('click', async () => {
          copy.disabled = true;
          const res = await rpc(card, 'drawingClip', { did: edit.drw.did, changes: edit.drw.changes }, 30000);
          copy.disabled = false;
          flashState(edit, res.ok ? '복사됨 · 그리기 창에 붙여 넣으세요' : '복사 실패 · ' + (res.error || '오류'));
        });
        row.insertBefore(copy, apply);
        // 바꾸기 전 원본 도해 복사 — 카드 왼쪽 아래
        const orig = el('button', 'g-link g-copy-orig', '원본 복사');
        orig.type = 'button';
        orig.title = '바꾸기 전 원본 도해를 클립보드에 담습니다';
        orig.addEventListener('click', async () => {
          orig.disabled = true;
          const res = await rpc(card, 'drawingClip', edit.drw.orig ? { did: edit.drw.did, changes: edit.drw.orig } : { did: edit.drw.did, original: true }, 30000);
          orig.disabled = false;
          flashState(edit, res.ok ? '원본 복사됨 · 그리기 창에 붙여 넣으세요' : '복사 실패 · ' + (res.error || '오류'));
        });
        row.insertBefore(orig, row.firstChild);
      }
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
      // 적용된 뒤에도 [다시 적용]을 누를 수 있게 둔다(잘못 되돌렸을 때)
      edit.applyBtn.textContent = '다시 적용';
      card.counts.applied++;
      updateMeta(card);
      saveLog();
      updateJump();
    }

    function queueApply(card, edit, agentCursor) {
      if (edit.state === 'applying' || edit.state === 'queued') return Promise.resolve();
      // 이미 적용된 것은 사람이 [다시 적용]을 눌렀을 때만 다시 한다(바로 적용·모두 적용은 건너뜀)
      if (edit.state === 'applied' && agentCursor) return Promise.resolve();
      const wasApplied = edit.state === 'applied';
      // 사람이 누른 [적용]만 '최근 적용'으로 기억한다(바로 적용 모드의 자동 적용은 빼고)
      if (!agentCursor) {
        lastAppliedItem = edit.item;
        edit.pressedAt = Date.now();
        updateJump();
      }
      edit.state = 'queued';
      edit.applyBtn.disabled = true;
      edit.stateEl.textContent = '적용 대기';
      updateApplyAll();
      const gen = stopGen;
      const run = card.applyChain.then(async () => {
        if (gen !== stopGen) {
          // 멈춤: 다시 적용하려던 것은 적용됨으로, 나머지는 제안으로 돌린다
          edit.state = wasApplied ? 'applied' : 'proposed';
          edit.applyBtn.disabled = false;
          edit.stateEl.textContent = wasApplied ? '✓ 적용됨' : '멈춤';
          updateApplyAll();
          return;
        }
        edit.state = 'applying';
        edit.stateEl.textContent = '적용 중…';
        card.applying = (card.applying || 0) + 1;
        // 서식 수정은 글자를 바꾸지 않고 그 문구를 골라 서식만 바꾼다
        const res = edit.drw
          ? await rpc(card, 'drawingEdit', { pos: edit.drw.pos, changes: edit.drw.changes }, 120000)
          : edit.fmt
          ? await applyFormatFix(card, { find: edit.src, hint: edit.hint, fix: { type: 'style', style: edit.fmt } }).then(r => ({ ok: r.ok, error: r.why }))
          : await rpc(card, 'applyEdit', { src: edit.src, dst: edit.dst, hint: edit.hint, agent: agentCursor || null }, 45000);
        let ok = res.ok;
        if (!ok && !edit.fmt && !edit.drw && edit.dst && edit.dst !== edit.src) {
          // 시간 초과나 검증 실패여도 실제로는 바뀌었을 수 있다 — 원문은 사라지고 고친 문구가 그 자리에 있으면 적용된 것이다
          const probe = await rpc(card, 'probe', { src: edit.src, dst: edit.dst, hint: edit.hint }, 15000);
          ok = !!(probe.ok && probe.dst && !probe.src);
        }
        if (ok) {
          edit.state = 'applied';
          edit.item.classList.remove('g-failed');
          edit.item.classList.add('g-applied');
          edit.stateEl.textContent = '✓ 적용됨' + (res.note ? ' · ' + res.note : '');
          edit.applyBtn.disabled = false;
          edit.applyBtn.textContent = '다시 적용';
          if (!wasApplied) card.counts.applied++;
          updateMeta(card);
        } else {
          edit.state = 'failed';
          edit.item.classList.add('g-failed');
          edit.applyBtn.disabled = false;
          edit.stateEl.textContent = res.error === 'not_found' ? '문서에서 찾지 못함(이미 바뀜?)' : (edit.fmt || edit.drw) && res.error ? '적용 실패 · ' + res.error : '적용 실패 · 다시 시도';
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
      if (host.onBusy) host.onBusy(on);
      // 질문 카드 버튼은 작업 중에 꺼 두므로, 작업이 끝나면 다시 계산한다
      for (const q of root.querySelectorAll('.g-msg-question')) if (q.syncQuestion) q.syncQuestion();
      if (on || !queuedFollowUps.length) return;
      // 멈춤을 눌렀으면 줄 세운 반영도 취소한다
      if (stopRequested) {
        for (const f of queuedFollowUps) { f.entry.queued = false; f.sync(); }
        queuedFollowUps = [];
        return;
      }
      const nextUp = queuedFollowUps.shift();
      setTimeout(() => { if (!busy) nextUp.go(); else { queuedFollowUps.unshift(nextUp); } }, 0);
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

    function markRejected(edit, text) {
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


    async function leadRequest(action, document, label) {
      const requestId = 'grid-' + action + '-' + Date.now().toString(36);
      liveRequests.add(requestId);
      const wait = systemMsg('계획 · ' + label + '…', false, false);
      const res = await send({ type: 'typo:aiBridge', action, requestId, payload: { timeoutMs: 180000, document } });
      liveRequests.delete(requestId);
      wait.remove();
      if (!res || !res.ok) {
        if (!stopRequested) systemMsg('계획 · ' + label + ' 실패 — 계획 없이 진행합니다 (' + (res && (res.message || res.error) || '오류') + ')', false, false);
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
      const agents = CONCURRENCY;
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
      // 강조(배경) 색 해제는 글자 교정이 아니라 서식 작업이다 — AI 없이 문서에서 칠해진 곳을 찾아 바로 다룬다
      if (isDrawingStyle(instruction)) {
        await runDrawingStyle(targets, instruction, auto);
        currentTurn = '';
        unpinTargets(targets);
        setBusy(false);
        return;
      }
      if (HIGHLIGHT_CLEAR_RE.test(instruction)) {
        await runHighlightClear(targets, auto);
        currentTurn = '';
        unpinTargets(targets);
        setBusy(false);
        return;
      }
      // 팀장 단계: 지시와 목차를 보고 손댈 구간을 고르고, 모두가 따를 작업 요령을 정한다.
      // 일관성이 중요한 지시면 원고를 먼저 훑어 규칙을 정하고, 애매한 건 손대기 전에 묻는다.
      const team = { plan: null };
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
        systemMsg('계획 · ' + (plan.note || '계획을 세웠습니다') + (plan.scope === 'targeted' ? ' (구간 ' + picked + '/' + all + '개)' : '') + (plan.brief ? '\n작업 요령: ' + plan.brief : ''));
        if (!stopRequested && plan.needsSurvey && planned.length) {
          const survey = await surveyRules(instruction, planned, team.plan);
          if (survey) {
            team.plan.rules = survey.rules;
            if (survey.rules.length || survey.note) systemMsg('계획 · ' + (survey.note || '규칙을 정했습니다') + (survey.rules.length ? '\n' + survey.rules.map(r => '· ' + r).join('\n') : ''));
            collectQuestions(survey.questions);
          }
        }
        // 편집자가 골라야 할 것(계획·규칙 단계에서 나온 질문)은 고치기 전에 묻는다
        if (runQuestions.length && !answered && !stopRequested) {
          systemMsg('계획 · 시작 전에 정할 것이 ' + runQuestions.length + '개 있습니다. 답하면 그대로 시작합니다.');
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
      // 지시에 그림 얘기가 있으면 구간 안의 그림을 같이 보낸다(/도해 점검을 안 써도 그림을 본다)
      if (FIGURE_INSTR_RE.test(instruction) && !stopRequested) await attachFigures(tasks);
      // 서식 지시면 구간 안에서 서식이 있는 글자 묶음을 같이 보낸다(AI는 글자만 받아 서식을 못 보므로)
      if (FORMAT_INSTR_RE.test(instruction) && !stopRequested) await attachFormatRuns(tasks);
      if (!tasks.length) {
        if (plan && plan.scope === 'targeted') systemMsg('계획 · 이 지시로 손댈 구간이 없다고 판단했습니다');
        currentTurn = '';
        unpinTargets(targets);
        setBusy(false);
        return;
      }
      systemMsg('문서 ' + planned.length + '개를 구간 ' + tasks.length + '개로 나눠 ' + Math.min(agents, tasks.length) + '개씩 동시에 봅니다' + (auto ? ' · 바로 적용' : ' · 제안 모드'));
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
        // 글자만 다루는 에이전트라 서식(굵게·색·글꼴 등) 지시는 못 한다 — 조용히 0개로 끝내지 않고 그렇다고 말한다
        if (!total && !stopRequested && /글꼴|폰트|글자\s*크기|들여쓰기|줄\s*간격/.test(instruction)) {
          systemMsg('글꼴·크기·들여쓰기·줄 간격은 아직 지시로 못 바꿉니다 · /서식 점검을 쓰세요 (배경색·굵게·기울임·밑줄·글자 색은 됩니다)', true);
        }
        const endMsg = systemMsg((stopRequested ? '멈췄습니다 · ' : '끝 · ') + '고칠 곳 ' + total + '개' + (auto ? ' · 적용 ' + targets.reduce((n, c) => n + c.counts.applied, 0) + '개(누적)' : ''));
        const endEntry = logEntries[logEntries.length - 1];
        if (total) {
          endEntry.turnApply = turn;
          attachTurnApply(endMsg, turn);
        }
        endEntry.summary = buildTurnSummary(turn);
        renderTurnSummary(endMsg, endEntry.summary);
        saveLog();
      }
      currentTurn = '';
      unpinTargets(targets);
      setBusy(false);
      if (!disabled) showRunQuestions({ kind: 'text', instruction });
    }

    function renderFlags(msg, card, flags) {
      const list = el('div', 'g-edits');
      for (const f of flags) {
        const item = el('div', 'g-edit g-flag');
        const row = el('div', 'g-edit-row');
        row.appendChild(el('span', 'g-flag-issue', '⚠ ' + f.issue));
        const go = el('button', 'g-link', '위치');
        go.type = 'button';
        go.title = '문서에서 이 자리를 선택합니다';
        go.addEventListener('click', () => { revealCard(card); rpc(card, 'locate', { src: f.quote, hint: f.hint }, 15000); });
        row.appendChild(go);
        item.appendChild(row);
        list.appendChild(item);
      }
      msg.bubble.appendChild(list);
    }

    function renderEdits(msg, card, edits, auto) {
      // 메시지(에이전트 한 구간) 단위 [모두 적용] — 이 메시지에서 아직 적용 안 된 제안만 적용한다
      if (!auto && edits.length > 1) {
        const all = el('button', 'g-apply-all g-rule-apply g-msg-apply', '');
        all.type = 'button';
        all.msgEdits = { card, edits };
        all.addEventListener('click', () => {
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
    function queuedCount() {
      let n = 0;
      for (const entry of logEntries) for (const e of entry.edits || []) if (e.state === 'queued' || e.state === 'applying') n++;
      return n;
    }

    // 줄 서 있는 적용을 멈춘다(지금 문서에 들어가고 있는 한 곳은 끝까지 하고, 나머지는 제안으로 돌아간다)
    function stopApplying() {
      const q = queuedCount();
      if (!q) return;
      stopGen++;
      systemMsg('적용을 멈췄습니다 · 진행 중인 한 곳만 마치고 나머지 ' + Math.max(0, q - 1) + '곳은 제안으로 남깁니다', false, false);
      updateApplyAll();
    }

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
      // 적용이 줄 서 있거나 도는 중이면 이 버튼이 [적용 멈춤]이 된다(전체 적용·모두 적용·하나씩 누른 것 모두)
      const q = queuedCount();
      if (q > 0) {
        btn.hidden = false;
        btn.disabled = false;
        btn.textContent = '적용 멈춤 · 남은 ' + q;
        btn.classList.add('g-apply-stop');
      } else {
        const n = pendingEdits().length;
        btn.hidden = n === 0;
        btn.textContent = '전체 적용 ' + n;
        btn.classList.remove('g-apply-stop');
        // 적용은 문서마다 줄을 세워 차례로 하므로 에이전트가 도는 중에도 누를 수 있다
        btn.disabled = applyingAll;
      }
      for (const b of root.querySelectorAll('.g-turn-apply')) {
        const k = pendingEdits(b.dataset.turn).length;
        b.hidden = k === 0;
        b.textContent = '이 대화 모두 적용 ' + k;
        b.disabled = applyingAll;
      }
      for (const b of root.querySelectorAll('.g-msg-apply')) {
        const k = b.msgEdits ? b.msgEdits.edits.filter(e => e.item && (e.state === 'proposed' || e.state === 'failed')).length : 0;
        b.hidden = k === 0;
        b.textContent = '모두 적용 (' + k + '개)';
      }
    }

    async function applyAllPending(turn) {
      const todo = pendingEdits(typeof turn === 'string' ? turn : '');
      if (!todo.length || applyingAll) return;
      applyingAll = true;
      updateApplyAll();
      systemMsg('아직 적용 안 된 ' + todo.length + '곳을 전부 적용합니다', false, false);
      // 문서마다 적용 줄이 따로 있어 문서끼리는 동시에, 한 문서 안에서는 차례로 돈다
      await Promise.all(todo.map(({ card, edit }) => queueApply(card, edit)));
      // 작업 중이면 그사이 새 제안이 생기므로, 이번에 맡은 것만 센다
      const left = todo.filter(({ edit }) => edit.state === 'proposed' || edit.state === 'failed').length;
      applyingAll = false;
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
          if (e.summary && e.summary.turn) {
            logEntries[logEntries.length - 1].summary = e.summary;
            renderTurnSummary(m, e.summary);
          }
        }
        else if (e.t === 'user') {
          userMsg(e.text);
          inferredTurn = 'restored-' + (++userCount);
        }
        else if (e.t === 'agent') {
          // 예전에 받은 '누락·비어 있음' 지적은 뽑은 글자의 한계로 생긴 오탐이라 버린다
          // 그림이 아닌 지적(코드 방어 검사 등)도 버린다 — 지적은 '그림 N:'만 남긴다
          if (Array.isArray(e.flags)) e.flags = e.flags.filter(f => /^그림\s*\d/.test(String(f && f.issue || ''))).filter(f => !/누락|비어\s*있|비었|빈\s*(곳|칸|블록|문항|자리)|없음|빠져|빠짐|빠졌|공란|자리만/.test(String(f && f.issue || '')));
          // 수정·결함 없이 AI 보고만 있던 예전 구간 메시지는 다시 그리지 않는다
          if (!(e.edits || []).length && !(e.flags || []).length && !e.review && !e.format && !e.figure && !/처리하지 못했습니다/.test(String(e.text || ''))) continue;
          const entry = { t: 'agent', agent: Number(e.agent) || 0, who: String(e.who || ''), text: String(e.text || ''), pending: false, docId: e.docId, edits: [], turn: e.turn || inferredTurn, review: Array.isArray(e.review) ? e.review : undefined, format: Array.isArray(e.format) ? e.format : undefined };
          logEntries.push(entry);
          const msg = agentMsg(entry.agent, entry.who, entry);
          // 구간 교정 메시지는 예전 AI 보고 대신 개수만 보여 준다
          if (!entry.review && !entry.format && !e.figure && ((e.edits || []).length || (e.flags || []).length) && !/처리하지 못했습니다/.test(entry.text)) {
            entry.text = [(e.edits || []).length ? '고칠 곳 ' + e.edits.length + '개' : '', (e.flags || []).length ? '직접 확인 ' + e.flags.length + '개' : ''].filter(Boolean).join(' · ');
          }
          msg.text.textContent = entry.text;
          const card = cards.find(c => c.doc.id === e.docId);
          if (entry.review) renderReviewRows(msg, card, entry.review);
          if (entry.format) renderFormatRows(msg, card, entry.format);
          if (Array.isArray(e.figure) && card) { entry.figure = e.figure; renderFigureRows(msg, card, e.figure); }
          if (Array.isArray(e.flags) && card) { entry.flags = e.flags; renderFlags(msg, card, e.flags); }
          const edits = (e.edits || []).map(x => Object.assign({}, x));
          entry.edits = edits;
          if (card && edits.length) {
            const states = edits.map(x => x.state);
            renderEdits(msg, card, edits, false);
            edits.forEach((edit, i) => {
              if (edit.pressedAt > newest) {
                newest = edit.pressedAt;
                lastAppliedItem = edit.item;
              }
              if (states[i] === 'applied') {
                edit.state = 'applied';
                edit.item.classList.add('g-applied');
                edit.stateEl.textContent = '✓ 적용됨';
                edit.applyBtn.textContent = '다시 적용';
                card.counts.applied++;
              } else if (states[i] === 'rejected') {
                markRejected(edit, edit.note || '제외');
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
      if (host.applyOptions) host.applyOptions(o);
    }

    async function runChunk(task, agent, instruction, auto) {
      const { card, chunk, idx, count } = task;
      const name = AI_NAME;
      const where = card.doc.name + ' · ' + (idx + 1) + '/' + count;
      setWorking(card, agent, name);
      // 구간마다 새 에이전트 커서가 문서 안 구간 첫머리에 나타난다(공동 작업자 커서 모양)
      const cursor = { id: 'agent-' + agent + '-' + idx + '-' + Date.now().toString(36), label: name, color: AI_COLOR };
      rpc(card, 'agentCursor', { agent: cursor, start: chunk.start }, 8000);
      const msg = agentMsg(agent, where + ' · ' + firstLine(card.text.slice(chunk.start, chunk.end)));
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
            // 앞뒤 글을 조금 같이 보내 맥락을 보게 한다(읽기만, 고치지 않음)
            before: card.text.slice(Math.max(0, chunk.start - CONTEXT_BEFORE), chunk.start),
            after: card.text.slice(chunk.end, chunk.end + CONTEXT_AFTER),
            instruction,
            history: history.slice(-HISTORY_TURNS),
            decisions: decisions(),
            plan: task.team && task.team.plan,
            heading: firstLine(chunkText),
            ...firstMentionsFor(task, task.team && task.team.mentions && task.team.mentions.get(card.doc.id)),
            chunkIndex: idx,
            chunkCount: count,
            figures: await chunkFigureImages(task),
            formatRuns: task.formatRuns || undefined
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
        src: f.source, dst: f.format ? f.source : f.replacement, reason: f.reason, category: f.format ? '서식' : f.category,
        fmt: f.format || undefined,
        hint: chunk.start + (Number(f.offset) || 0)
      }));
      // 이전 지시에서 이미 올린 같은 수정은 뺀다
      for (let i = edits.length - 1; i >= 0; i--) if (alreadyProposed(card, edits[i])) edits.splice(i, 1);
      task.note = '';
      collectQuestions(res.questions);
      // 작업 중에 나온 질문은 끝까지 기다리지 않고 바로 띄운다 — 답하면 결정이 되어 아직 안 한 구간 요청에 들어간다
      if (runQuestions.length && !stopRequested) showRunQuestions({ kind: 'text', instruction, live: true });
      // 구간 보고(메모)는 보여 주지 않는다 — 편집자는 수정 제안만 보고 적용할지 정한다.
      // 손으로 고칠 결함(그림 누락 등)은 [위치]가 달린 한 줄로만 보여 준다
      const flags = (Array.isArray(res.flags) ? res.flags : []).map(f => ({ quote: f.quote, issue: f.issue, hint: chunk.start + (Number(f.offset) || 0) }));
      // 고칠 곳이 없는 구간은 메시지를 남기지 않는다(끝 요약에 전체 개수가 나온다)
      if (!edits.length && !flags.length) {
        msg.root.remove();
        logEntries = logEntries.filter(e => e !== msg.entry);
        saveLog();
        task.recorded = edits;
        rpc(card, 'agentCursorRemove', { id: cursor.id }, 3000);
        return 0;
      }
      msg.text.textContent = [edits.length ? '고칠 곳 ' + edits.length + '개' : '', flags.length ? '직접 확인 ' + flags.length + '개' : ''].filter(Boolean).join(' · ');
      msg.entry.text = msg.text.textContent;
      msg.entry.edits = edits;
      if (flags.length) { msg.entry.flags = flags; renderFlags(msg, card, flags); }
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
      history.push({
        instruction: instruction.slice(0, 400),
        result: Array.from(byDoc, ([name, n]) => name + ' ' + n + '곳').join(', '),
        notes,
        changes
      });
      history = history.slice(-HISTORY_TURNS);
      if (storeKey) chrome.storage.local.set({ [storeKey + ':history']: history }).catch(() => {});
    }

    function stopAll() {
      stopRequested = true;
      stopGen++;
      for (const id of liveRequests) send({ type: 'typo:aiBridgeAbort', requestId: id });
      systemMsg('멈추는 중…', false, false);
    }



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
        closePop();
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

    // ---------- 강조(배경) 색 해제 ----------
    const HIGHLIGHT_CLEAR_RE = /(하이라이트|형광|배경\s*색|강조\s*색|highlight).{0,20}(해제|제거|없애|지우|지워|빼|풀|삭제|clear|remove)/i;

    async function exportHtml(card) {
      const a = session.authuser > 0 ? 'u/' + session.authuser + '/' : '';
      const info = await rpc(card, 'tabInfo', {}, 8000);
      const tab = info && info.ok && /^t\.[\w-]+$/.test(info.tab || '') ? info.tab : '';
      const res = await fetch('https://docs.google.com/document/' + a + 'd/' + encodeURIComponent(card.doc.id) + '/export?format=html' + (tab ? '&tab=' + encodeURIComponent(tab) : ''));
      if (!res.ok) throw new Error('export ' + res.status);
      return new DOMParser().parseFromString(await res.text(), 'text/html');
    }

    const FORMAT_INSTR_RE = /하이라이트|형광|배경\s*색|강조\s*색|굵게|볼드|기울임|이탤릭|밑줄|글자\s*색|색깔|서식|highlight|bold|italic|underline/i;

    function fmtLabel(f) {
      const out = [];
      if (f.highlight === 'none') out.push('배경색 해제');
      if (f.bold === true) out.push('굵게');
      if (f.bold === false) out.push('굵게 해제');
      if (f.italic === true) out.push('기울임');
      if (f.italic === false) out.push('기울임 해제');
      if (f.underline === true) out.push('밑줄');
      if (f.underline === false) out.push('밑줄 해제');
      if (f.color) out.push('글자 색 ' + f.color);
      if (f.size) out.push('크기 ' + f.size + 'pt');
      if (f.font) out.push('글꼴 ' + f.font);
      return out.join(' · ') || '서식';
    }

    // HTML export에서 서식(굵게·기울임·밑줄·글자 색·배경색)이 있는 글자 묶음을 찾아 문서 위치에 맞춘다
    async function formatRunsOf(card) {
      const doc = await exportHtml(card);
      const css = Array.from(doc.querySelectorAll('style')).map(x => x.textContent || '').join('\n');
      const byClass = new Map();
      for (const m of css.matchAll(/\.([\w-]+)\{([^}]*)\}/g)) byClass.set(m[1], (byClass.get(m[1]) || '') + ';' + m[2]);
      const white = v => /^(#fff(fff)?|transparent|none|inherit|initial|white)$/i.test(String(v || '').trim());
      const black = v => /^(#000(000)?|black|inherit|initial)$/i.test(String(v || '').trim());
      const propsOf = sp => {
        const decl = Array.from(sp.classList).map(c => byClass.get(c) || '').join(';') + ';' + (sp.getAttribute('style') || '');
        const get = k => { const m = new RegExp('(?:^|;)\\s*' + k + ':\\s*([^;]+)', 'gi'); let v = ''; let x; while ((x = m.exec(decl))) v = x[1].trim(); return v; };
        const p = {};
        if (/^(700|bold)$/i.test(get('font-weight'))) p.bold = true;
        if (/italic/i.test(get('font-style'))) p.italic = true;
        if (/underline/i.test(get('text-decoration'))) p.underline = true;
        const color = get('color');
        if (color && !black(color)) p.color = color;
        const bg = get('background-color');
        if (bg && !white(bg)) p.highlight = bg;
        return p;
      };
      const blocks = Array.from(doc.body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li')).filter(b => !b.parentElement.closest('p, li'));
      const offs = mapParagraphOffsets(blocks.map(b => ({ text: (b.textContent || '').replace(/ /g, ' ') })), card.text);
      const runs = [];
      blocks.forEach((b, i) => {
        // 제목은 원래 굵다 — 제목 블록에서는 굵게만 빼고 나머지 서식(배경색 등)은 본다
        const heading = /^H\d$/.test(b.tagName);
        let pos = 0;
        let cur = null;
        for (const sp of b.querySelectorAll('span')) {
          if (sp.querySelector('span')) continue;
          const t = (sp.textContent || '').replace(/ /g, ' ');
          const p = propsOf(sp);
          if (heading) delete p.bold;
          const key = JSON.stringify(p);
          if (t && key !== '{}') {
            if (cur && cur.end === pos && cur.key === key) { cur.text += t; cur.end += t.length; }
            else { cur = { text: t, start: pos, end: pos + t.length, block: i, key, props: p }; runs.push(cur); }
          } else if (t) cur = null;
          pos += t.length;
        }
      });
      // 문단 위치를 못 맞춘 묶음도 버리지 않는다: 앞뒤로 맞춘 문단 사이 어림 위치를 주고, 문서에서는 그 근처의 같은 문구를 찾는다
      const near = i => {
        for (let k = i; k >= 0; k--) if (offs[k] >= 0) return offs[k];
        return Math.round(card.text.length * i / Math.max(1, blocks.length));
      };
      return runs.filter(r => r.text.trim()).map(r => Object.assign({ text: r.text, at: offs[r.block] >= 0 ? offs[r.block] + r.start : near(r.block) }, r.props));

    }

    async function attachFormatRuns(tasks) {
      const byCard = new Map();
      for (const t of tasks) {
        if (!byCard.has(t.card)) byCard.set(t.card, []);
        byCard.get(t.card).push(t);
      }
      for (const [card, list] of byCard) {
        let runs = [];
        try { runs = await formatRunsOf(card); } catch (_) { continue; }
        for (const t of list) {
          t.formatRuns = runs.filter(r => r.at >= t.chunk.start && r.at < t.chunk.end).slice(0, 150)
            .map(r => Object.assign({}, r, { at: r.at - t.chunk.start, text: r.text.slice(0, 120) }));
        }
      }
    }

    // ---------- 그리기(도해) 도형 서식 ----------
    // "도해의 형광 도형을 흰 바탕·빨간 테두리로"처럼 그리기 속 도형 서식을 바꾸라는 지시.
    // 문서에서 그리기마다 도형 목록을 읽고(채우기·선 색·굵기·글자), AI가 바꿀 도형을 고르면 그리기마다 [위치]·[적용] 제안 하나.
    // [적용]은 문서에서 그 그리기 편집창을 열어 도형만 바꾸고 [저장 후 닫기]까지 한다.
    function isDrawingStyle(instruction) {
      return /도해|그림|도형|그리기|다이어그램|diagram|drawing/i.test(instruction) && /색|테두리|채우기|배경|굵기|형광|투명|선\s*(색|굵|두께)|color|fill|border|outline/i.test(instruction);
    }

    function drwLabel(d) {
      const c = (d.changes || [])[0] || {};
      const out = [];
      if (c.fill === 'none') out.push('채우기 없음');
      else if (c.fill) out.push('채우기 ' + c.fill);
      if (c.line) out.push('테두리 ' + c.line);
      if (c.weight) out.push('굵기 ' + c.weight + 'pt');
      const n = (d.changes || []).reduce((k, x) => k + (x.ids || []).length, 0);
      return '도형 ' + n + '개 · ' + (out.join(' · ') || '서식');
    }

    async function runDrawingStyle(targets, instruction, auto) {
      let total = 0;
      for (const card of targets) {
        if (stopRequested) break;
        const wait = systemMsg(card.doc.name + ' · 그리기 읽는 중…', false, false);
        const res = await rpc(card, 'drawings', {}, 180000);
        wait.remove();
        if (!res.ok) { systemMsg(card.doc.name + ' · 그리기를 읽지 못했습니다 (' + (res.error || '오류') + ')', true); continue; }
        const drawings = (res.drawings || []).filter(d => d.shapes && d.shapes.length);
        if (!drawings.length) continue;
        const think = systemMsg(card.doc.name + ' · 그리기 ' + drawings.length + '개에서 바꿀 도형 고르는 중…', false, false);
        const requestId = 'grid-drawing-' + card.doc.id.slice(0, 8) + '-' + Date.now().toString(36);
        liveRequests.add(requestId);
        const ai = await send({ type: 'typo:aiBridge', action: 'drawingStyle', requestId, payload: { timeoutMs: 180000, document: { instruction, drawings: drawings.map(d => ({ n: d.n, before: d.before, shapes: d.shapes })) } } });
        liveRequests.delete(requestId);
        think.remove();
        if (!ai || !ai.ok) { systemMsg(card.doc.name + ' · AI가 도형을 고르지 못했습니다 (' + (ai && (ai.message || ai.error) || '오류') + ')', true); continue; }
        const byDrawing = new Map();
        for (const c of ai.changes || []) {
          if (!byDrawing.has(c.drawing)) byDrawing.set(c.drawing, []);
          byDrawing.get(c.drawing).push({ ids: c.ids, fill: c.fill, line: c.line, weight: c.weight, reason: c.reason });
        }
        const edits = [];
        for (const [n, changes] of byDrawing) {
          const d = drawings.find(x => x.n === n);
          if (!d) continue;
          // 바꾸기 전 서식(원본 복사용): 적용한 뒤에도 원본을 되살려 담을 수 있게 읽어 둔 값을 남긴다
          const orig = [];
          for (const c of changes) for (const id of c.ids || []) {
            const sh = (d.shapes || []).find(x => x.id === id);
            if (sh) orig.push({ ids: [id], fill: sh.fill || 'none', line: sh.line || undefined, weight: sh.weight || undefined });
          }
          edits.push({ src: '그림 ' + n + (d.before ? ' (' + d.before.slice(0, 24) + '…)' : ''), dst: '', drw: { pos: d.pos, did: d.did, changes, orig }, reason: changes[0].reason || '', category: '도해', hint: d.pos });
        }
        if (!edits.length) continue;
        const msg = agentMsg(0, card.doc.name + ' · 도해 서식');
        Object.assign(msg.entry, { pending: false, docId: card.doc.id, text: '고칠 곳 ' + edits.length + '개', edits });
        msg.text.textContent = msg.entry.text;
        renderEdits(msg, card, edits, auto);
        card.counts.proposed += edits.length;
        updateMeta(card);
        total += edits.length;
        // 그리기 편집창은 하나씩 열어야 하므로 차례로 적용한다
        if (auto) for (const e of edits) await queueApply(card, e, true);
      }
      saveLog();
      const turn = currentTurn;
      const endMsg = systemMsg(total ? '끝 · 고칠 그리기 ' + total + '개' : '지시에 맞는 도형을 찾지 못했습니다');
      if (total && !auto) {
        logEntries[logEntries.length - 1].turnApply = turn;
        attachTurnApply(endMsg, turn);
        saveLog();
      }
    }

    // 배경색 해제는 AI 없이 칠해진 곳을 모두 찾아, 글자 교정과 같은 [위치]·[적용] 제안으로 올린다
    async function runHighlightClear(targets, auto) {
      let total = 0;
      for (const card of targets) {
        if (stopRequested) break;
        let runs;
        try { runs = (await formatRunsOf(card)).filter(r => r.highlight); } catch (e) {
          systemMsg(card.doc.name + ' · 문서 서식을 읽지 못했습니다 (' + (e && e.message || e) + ')', true);
          continue;
        }
        if (!runs.length) continue;
        const edits = runs.map(r => ({ src: r.text, dst: r.text, fmt: { highlight: 'none' }, reason: '배경색 ' + r.highlight, category: '서식', hint: r.at }));
        const msg = agentMsg(0, card.doc.name + ' · 배경색 해제');
        Object.assign(msg.entry, { pending: false, docId: card.doc.id, text: '고칠 곳 ' + edits.length + '개', edits });
        msg.text.textContent = msg.entry.text;
        renderEdits(msg, card, edits, auto);
        card.counts.proposed += edits.length;
        updateMeta(card);
        total += edits.length;
        if (auto) await Promise.all(edits.map(e => queueApply(card, e, true)));
      }
      saveLog();
      const turn = currentTurn;
      const endMsg = systemMsg(total ? '끝 · 고칠 곳 ' + total + '개' : '배경색이 칠해진 곳을 찾지 못했습니다');
      if (total && !auto) {
        logEntries[logEntries.length - 1].turnApply = turn;
        attachTurnApply(endMsg, turn);
        saveLog();
      }
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
      const name = AI_NAME;
      setWorking(card, agent, name);
      const msg = agentMsg(agent, card.doc.name + ' · 서식 점검');
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

    // ---------- 지시 속 그림 ----------
    const FIGURE_INSTR_RE = /그림|도해|도판|이미지|다이어그램|삽화|캡처|스크린샷|figure|diagram/i;
    const FIGURES_PER_CHUNK = 8;
    const CONTEXT_BEFORE = 2500;
    const CONTEXT_AFTER = 1200;
    // 문서마다 그림 목록을 읽어, 그림 앞 문단이 들어 있는 구간에 붙인다
    async function attachFigures(tasks) {
      const byCard = new Map();
      for (const t of tasks) {
        if (!byCard.has(t.card)) byCard.set(t.card, []);
        byCard.get(t.card).push(t);
      }
      const wait = systemMsg('그림 목록 읽는 중…', false, false);
      let total = 0;
      let lost = 0;
      for (const [card, list] of byCard) {
        let figures = [];
        try { figures = await listFigures(card); } catch (_) { lost++; continue; }
        let from = 0;
        figures.forEach((f, i) => {
          const keys = [f.before.slice(-30), f.before.slice(0, 30), f.after.slice(0, 30)].filter(k => k && k.length >= 6);
          let at = -1;
          for (const k of keys) { at = card.text.indexOf(k, from); if (at < 0) at = card.text.indexOf(k); if (at >= 0) { at += k === f.after.slice(0, 30) ? 0 : k.length; break; } }
          if (at < 0) return;
          from = at;
          const t = list.find(x => at >= x.chunk.start && at <= x.chunk.end);
          if (!t) return;
          (t.figures = t.figures || []).push(Object.assign({ n: i + 1 }, f));
          total++;
        });
      }
      wait.remove();
      if (!total) systemMsg('지시에 그림이 있지만 ' + (lost ? '그림 목록을 읽지 못해' : '보낼 그림을 찾지 못해') + ' 글만 봅니다');
    }

    async function chunkFigureImages(task) {
      const out = [];
      for (const f of (task.figures || []).slice(0, FIGURES_PER_CHUNK)) {
        if (stopRequested) break;
        const img = await send({ type: 'typo:fetchImage', url: f.src });
        if (img && img.ok) out.push({ n: f.n, dataUrl: img.dataUrl, before: f.before.slice(0, 200), after: f.after.slice(0, 200) });
      }
      return out;
    }

    async function figureCheckDoc(card, agent, instruction) {
      const name = AI_NAME;
      setWorking(card, agent, name);
      const msg = agentMsg(agent, card.doc.name + ' · 도해 점검');
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
      const agents = Math.min(CONCURRENCY, targets.length);
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
      if (storeKey) chrome.storage.local.set({ [storeKey + ':history']: history }).catch(() => {});
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
      const agents = Math.min(CONCURRENCY, targets.length);
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
      if (storeKey) chrome.storage.local.set({ [storeKey + ':history']: history }).catch(() => {});
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
      const name = AI_NAME;
      setWorking(card, agent, name);
      const msg = agentMsg(agent, card.doc.name + ' · 댓글 반영 · 댓글·제안 ' + items.length + '개');
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
        const cursor = { id: 'review-' + agent + '-' + Date.now().toString(36), label: name, color: AI_COLOR };
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
      const agents = Math.min(CONCURRENCY, queue.length);
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
      if (storeKey) chrome.storage.local.set({ [storeKey + ':history']: history }).catch(() => {});
      systemMsg((stopRequested ? '멈췄습니다 · ' : '댓글 반영 끝 · ') + total + '개 중 ' + done + '개 처리 · 나머지는 남겨 두었거나 실패', false);
      reviewCollected = null;
      setBusy(false);
    }

    // ---------- 입력창과 / 명령 ----------
    function bindComposer() {
      const input = $('g-input');
      // ---------- / 명령 ----------
      // 기능 템플릿은 입력창에 /를 쳐서 부른다. 고른 명령은 입력창 안에 버튼 모양 꼬리표로 들어가고 여러 개 쌓을 수 있다.
      // 보내면(⌘Enter) 꼬리표 명령을 차례로 실행하고, 입력창에 쓴 말은 추가 지시로 함께 넘긴다.
      const COMMANDS = [
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
        const text = (host.cleanInput ? host.cleanInput(input.value) : input.value).trim();
        const cmds = picked.slice();
        if (!text && !cmds.length) return;
        input.value = '';
        if (host.onSent) host.onSent();
        picked = [];
        renderPills();
        hideSlash();
        if (cmds.length) runPicked(cmds, text);
        else runInstruction(text);
      });
      input.addEventListener('input', () => { if (host.onInput) host.onInput(input); slashIndex = 0; renderSlash(); });
      input.addEventListener('click', renderSlash);
      input.addEventListener('blur', () => setTimeout(hideSlash, 150));
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
      $('g-jump').addEventListener('click', () => jumpToBottom(true));
      $('g-top').addEventListener('click', jumpToTop);
      $('g-apply-all').addEventListener('click', () => { if (queuedCount() > 0) stopApplying(); else applyAllPending(); });
      updateApplyAll();
      $('g-last').addEventListener('click', jumpToLastApplied);
      $('g-review').addEventListener('click', ev => {
        ev.stopPropagation();
        if (!session) return;
        if ($('g-pop').hidden || $('g-review').getAttribute('aria-expanded') !== 'true') openReviewPicker();
        else closePop();
      });
      // 켜고 끌 때 목록을 다시 그리므로 클릭한 줄이 이미 DOM에서 빠졌을 수 있다 — 이벤트 경로로 판단한다
      document.addEventListener('click', ev => { if (!ev.composedPath().includes($('g-pop'))) closePop(); });
      document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closePop(); });
    }

    // 저장해 둔 대화를 다시 그린다(없으면 welcome 한 줄)
    function load(savedLog, welcome) {
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
        systemMsg(welcome || '지시를 쓰거나 /로 기능을 부르세요. 기본은 제안 모드라 문서는 승인한 곳만 바뀝니다.', false, false);
      }
      $('g-auto').addEventListener('change', saveLog);
    }

    bindComposer();

    return {
      setSession(key, sess, hist) { storeKey = key; session = sess; history = Array.isArray(hist) ? hist : []; },
      setCards(list) { cards = list; },
      getHistory: () => history,
      isBusy: () => busy,
      load,
      systemMsg, userMsg, setBusy, saveLog, flushLog, updateApplyAll, updateJump,
      jumpToBottom, closePop, stopAll, runInstruction
    };
  }

  globalThis.ToytypeAgentChat = { create, markup };
})();
