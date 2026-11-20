// 토인비 편집 — AI 작업 기록 저장소 (백그라운드 서비스워커 전용)
// 페이지를 새로고침하거나 탭을 닫았다 열어도 대기·실행 중이던 AI 작업과
// 아직 패널에 반영하지 못한 결과를 이어받을 수 있게 chrome.storage.session에 둔다.
// session 저장소는 브라우저를 끄면 비워지므로 문서 본문을 디스크에 남기지 않는다.
// 저장소 접근은 주입받아 Node 테스트에서도 그대로 돌린다.

export const AI_JOB_STORE_KEY = 'aiJobStore';
export const AI_JOB_MAX_RECORDS = 40;
// 결과가 이보다 크면 기록만 남기고 결과 본문은 버린다(교정·문장 제안 JSON은 브리지 디스크에도 있다).
export const AI_JOB_MAX_RESULT_CHARS = 1500000;
// 다시 실행용 페이로드는 최근 실패 몇 건만 들고 있는다.
export const AI_JOB_MAX_RETRY_PAYLOADS = 6;
// session 저장소 한도(10MB) 아래로 유지한다. 넘으면 끝난 작업의 결과·페이로드부터 버린다.
export const AI_JOB_STORE_BUDGET_CHARS = 7000000;

const FINISHED = new Set(['done', 'error', 'canceled']);

export function createAiJobStore({ read, write, isLive = () => false, now = () => Date.now() }) {
  let chain = Promise.resolve();

  // 서비스워커 하나에서 읽기-수정-쓰기가 겹치지 않게 직렬화한다.
  function mutate(fn) {
    const run = chain.then(async () => {
      const records = normalizeRecords(await read());
      const out = fn(records);
      prune(records);
      await write(records);
      return out;
    });
    chain = run.catch(() => {});
    return run;
  }

  function upsert(records, id, fields) {
    const prev = records[id] || { id, createdAt: now() };
    records[id] = Object.assign({}, prev, fields, { id });
    return records[id];
  }

  // 페이지의 대기열을 그대로 반영한다. 대기 상태가 아닌 기록(실행 중·끝남)은 건드리지 않는다.
  function syncQueue(docId, jobs) {
    const list = Array.isArray(jobs) ? jobs : [];
    return mutate(records => {
      const keep = new Set(list.map(j => String(j && j.id || '')));
      for (const rec of Object.values(records)) {
        if (rec.docId === docId && rec.state === 'queued' && !keep.has(rec.id)) delete records[rec.id];
      }
      list.forEach((job, order) => {
        if (!job || !job.id) return;
        const prev = records[job.id];
        if (prev && prev.state !== 'queued') return;
        upsert(records, String(job.id), {
          docId,
          action: String(job.action || ''),
          label: String(job.label || ''),
          detail: String(job.detail || ''),
          meta: job.meta || null,
          payload: job.payload || null,
          createdAt: Number(job.createdAt) || now(),
          state: 'queued',
          order
        });
      });
    });
  }

  function start(id, info) {
    return mutate(records => upsert(records, id, {
      docId: String(info && info.docId || ''),
      action: String(info && info.action || ''),
      label: String(info && info.label || ''),
      detail: String(info && info.detail || ''),
      meta: info && info.meta || null,
      payload: info && info.payload || null,
      createdAt: Number(info && info.createdAt) || now(),
      state: 'running',
      startedAt: now(),
      finishedAt: 0,
      message: '',
      result: null,
      acked: false
    }));
  }

  function finish(id, res) {
    return mutate(records => {
      const rec = records[id];
      if (!rec) return null;
      const ok = !!(res && res.ok);
      const state = ok ? 'done' : (res && res.error === 'canceled' ? 'canceled' : 'error');
      rec.state = state;
      rec.finishedAt = now();
      rec.message = ok ? '' : String(res && (res.message || res.error) || '실패');
      rec.result = ok && resultFits(res) ? res : null;
      rec.acked = false;
      if (ok) rec.payload = null;
      return Object.assign({}, rec);
    });
  }

  function ack(id) {
    return mutate(records => {
      const rec = records[id];
      if (!rec) return;
      rec.acked = true;
      rec.result = null;
    });
  }

  function remove(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    return mutate(records => {
      for (const id of list) delete records[String(id)];
    });
  }

  function get(id) {
    return mutate(records => (records[id] ? Object.assign({}, records[id]) : null));
  }

  // 문서의 기록을 실행 순서대로 돌려준다. 서비스워커가 재시작돼 주인이 없는 '실행 중' 기록은 중단으로 바꾼다.
  function list(docId) {
    return mutate(records => {
      for (const rec of Object.values(records)) {
        if (rec.state === 'running' && !isLive(rec.id)) {
          rec.state = 'error';
          rec.finishedAt = now();
          rec.message = '브라우저가 작업을 중단했습니다 · 다시 실행하세요';
        }
      }
      return Object.values(records)
        .filter(rec => rec.docId === docId)
        .sort(compareRecords)
        .map(rec => Object.assign({}, rec));
    });
  }

  return { syncQueue, start, finish, ack, remove, get, list };
}

// 페이지에 보낼 모양: 대기 작업만 실행에 필요한 페이로드를 싣고, 나머지는 다시 실행 가능 여부만 알린다.
export function publicJobRecord(rec) {
  if (!rec) return null;
  const out = {
    id: rec.id,
    docId: rec.docId,
    action: rec.action,
    label: rec.label,
    detail: rec.detail,
    meta: rec.meta || null,
    state: rec.state,
    createdAt: rec.createdAt || 0,
    startedAt: rec.startedAt || 0,
    finishedAt: rec.finishedAt || 0,
    message: rec.message || '',
    retryable: !!rec.payload && (rec.state === 'error' || rec.state === 'canceled'),
    result: rec.state === 'done' && !rec.acked ? rec.result || null : null
  };
  if (rec.state === 'queued') {
    out.payload = rec.payload || null;
    out.payloadDropped = !rec.payload;
  }
  return out;
}

function normalizeRecords(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [id, rec] of Object.entries(value)) {
    if (rec && typeof rec === 'object' && typeof rec.state === 'string') out[id] = rec;
  }
  return out;
}

function compareRecords(a, b) {
  const rank = rec => (rec.state === 'running' ? 0 : rec.state === 'queued' ? 1 : 2);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 1) return (a.order || 0) - (b.order || 0);
  if (ra === 0) return (a.startedAt || 0) - (b.startedAt || 0);
  return (a.finishedAt || 0) - (b.finishedAt || 0);
}

function resultFits(res) {
  try {
    return JSON.stringify(res).length <= AI_JOB_MAX_RESULT_CHARS;
  } catch (_) {
    return false;
  }
}

function prune(records) {
  const finished = Object.values(records)
    .filter(rec => FINISHED.has(rec.state))
    .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
  finished.slice(AI_JOB_MAX_RECORDS).forEach(rec => { delete records[rec.id]; });
  let retry = 0;
  for (const rec of finished.slice(0, AI_JOB_MAX_RECORDS)) {
    if (!rec.payload) continue;
    retry++;
    if (retry > AI_JOB_MAX_RETRY_PAYLOADS) rec.payload = null;
  }
  enforceBudget(records);
}

function sizeOf(value) {
  if (value == null) return 0;
  try { return JSON.stringify(value).length; } catch (_) { return Infinity; }
}

// 큰 것부터 버린다: 끝난 작업의 페이로드 → 끝난 작업의 결과 → 대기·실행 중 작업의 페이로드.
function enforceBudget(records) {
  let total = sizeOf(records);
  if (total <= AI_JOB_STORE_BUDGET_CHARS) return;
  const recs = Object.values(records);
  const tiers = [
    recs.filter(r => FINISHED.has(r.state)).map(r => [r, 'payload']),
    recs.filter(r => FINISHED.has(r.state)).map(r => [r, 'result']),
    recs.filter(r => !FINISHED.has(r.state)).map(r => [r, 'payload'])
  ];
  for (const tier of tiers) {
    tier.sort((a, b) => sizeOf(b[0][b[1]]) - sizeOf(a[0][a[1]]));
    for (const [rec, field] of tier) {
      if (total <= AI_JOB_STORE_BUDGET_CHARS) return;
      const size = sizeOf(rec[field]);
      if (!size) continue;
      rec[field] = null;
      if (field === 'payload' && rec.state === 'queued') rec.payloadDropped = true;
      total -= size;
    }
  }
}
