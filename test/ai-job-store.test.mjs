import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAiJobStore,
  publicJobRecord,
  AI_JOB_MAX_RECORDS,
  AI_JOB_MAX_RETRY_PAYLOADS,
  AI_JOB_STORE_BUDGET_CHARS
} from '../ai-job-store.mjs';

function memoryStore(opts = {}) {
  let data = null;
  let clock = 1000;
  const live = new Set();
  const store = createAiJobStore({
    read: async () => (data ? JSON.parse(JSON.stringify(data)) : undefined),
    write: async records => { data = JSON.parse(JSON.stringify(records)); },
    isLive: id => live.has(id),
    now: () => ++clock,
    ...opts
  });
  return { store, live, raw: () => data };
}

const job = (id, extra = {}) => ({ id, action: 'verifyFacts', label: 'AI 사실 검증', detail: id, payload: { document: { selectedText: id } }, meta: { selectedText: id }, ...extra });

test('대기열 동기화는 순서를 지키고 빠진 대기 작업만 지운다', async () => {
  const { store } = memoryStore();
  await store.syncQueue('doc1', [job('a'), job('b'), job('c')]);
  await store.syncQueue('doc1', [job('c'), job('a')]);
  const list = await store.list('doc1');
  assert.deepEqual(list.map(r => r.id), ['c', 'a']);
  assert.ok(list.every(r => r.state === 'queued'));
  assert.deepEqual((await store.list('doc2')), []);
});

test('실행 중 기록은 대기열 동기화로 지워지지 않는다', async () => {
  const { store, live } = memoryStore();
  await store.syncQueue('doc1', [job('a'), job('b')]);
  live.add('a');
  await store.start('a', { docId: 'doc1', action: 'verifyFacts', label: 'x' });
  await store.syncQueue('doc1', [job('b')]);
  const list = await store.list('doc1');
  assert.deepEqual(list.map(r => [r.id, r.state]), [['a', 'running'], ['b', 'queued']]);
});

test('끝난 결과는 확인(ack) 전까지 페이지에 넘기고 그 뒤에는 버린다', async () => {
  const { store, live } = memoryStore();
  live.add('a');
  await store.start('a', { docId: 'doc1', action: 'verifyFacts', payload: { big: 'x' } });
  await store.finish('a', { ok: true, claims: [1] });
  let [rec] = await store.list('doc1');
  assert.equal(rec.state, 'done');
  assert.equal(rec.payload, null);
  assert.deepEqual(publicJobRecord(rec).result, { ok: true, claims: [1] });
  await store.ack('a');
  [rec] = await store.list('doc1');
  assert.equal(publicJobRecord(rec).result, null);
});

test('실패·취소는 다시 실행용 페이로드를 남긴다', async () => {
  const { store, live } = memoryStore();
  live.add('a'); live.add('b');
  await store.start('a', { docId: 'd', action: 'diagram', payload: { p: 1 } });
  await store.start('b', { docId: 'd', action: 'diagram', payload: { p: 2 } });
  await store.finish('a', { ok: false, error: 'bridge_timeout', message: '시간 초과' });
  await store.finish('b', { ok: false, error: 'canceled' });
  const list = await store.list('d');
  const a = publicJobRecord(list.find(r => r.id === 'a'));
  const b = publicJobRecord(list.find(r => r.id === 'b'));
  assert.equal(a.state, 'error');
  assert.equal(a.message, '시간 초과');
  assert.equal(a.retryable, true);
  assert.equal(b.state, 'canceled');
  assert.equal(b.retryable, true);
  assert.equal(a.payload, undefined, '끝난 작업 목록에는 페이로드를 싣지 않는다');
  assert.deepEqual((await store.get('a')).payload, { p: 1 });
});

test('주인 없는 실행 중 기록은 목록을 볼 때 중단으로 바뀐다', async () => {
  const { store } = memoryStore();
  await store.start('a', { docId: 'd', action: 'proofread', payload: { t: 1 } });
  const [rec] = await store.list('d');
  assert.equal(rec.state, 'error');
  assert.match(rec.message, /중단/);
  assert.equal(publicJobRecord(rec).retryable, true);
});

test('끝난 기록 개수와 다시 실행 페이로드 개수를 제한한다', async () => {
  const { store, live } = memoryStore();
  const n = AI_JOB_MAX_RECORDS + 5;
  for (let i = 0; i < n; i++) {
    live.add('j' + i);
    await store.start('j' + i, { docId: 'd', action: 'diagram', payload: { i } });
    await store.finish('j' + i, { ok: false, error: 'x' });
  }
  const list = await store.list('d');
  assert.equal(list.length, AI_JOB_MAX_RECORDS);
  assert.ok(!list.some(r => r.id === 'j0'), '가장 오래된 기록부터 지운다');
  const withPayload = list.filter(r => r.payload);
  assert.equal(withPayload.length, AI_JOB_MAX_RETRY_PAYLOADS);
  assert.ok(withPayload.some(r => r.id === 'j' + (n - 1)), '최근 실패의 페이로드를 남긴다');
});

test('저장 한도를 넘으면 큰 페이로드부터 버리고 대기 작업은 표시해 둔다', async () => {
  const { store, raw } = memoryStore();
  const big = 'x'.repeat(Math.ceil(AI_JOB_STORE_BUDGET_CHARS * 0.6));
  await store.syncQueue('d', [job('a', { payload: { text: big } }), job('b', { payload: { text: big } }), job('c', { payload: { small: 1 } })]);
  assert.ok(JSON.stringify(raw()).length <= AI_JOB_STORE_BUDGET_CHARS);
  const list = (await store.list('d')).map(publicJobRecord);
  assert.equal(list.filter(r => r.payloadDropped).length, 1);
  assert.deepEqual(list.find(r => r.id === 'c').payload, { small: 1 });
});

test('동시에 들어온 변경을 하나도 잃지 않는다', async () => {
  const { store, live } = memoryStore();
  const ids = Array.from({ length: 10 }, (_, i) => 'p' + i);
  ids.forEach(id => live.add(id));
  await Promise.all(ids.map(id => store.start(id, { docId: 'd', action: 'verifyFacts' })));
  const list = await store.list('d');
  assert.equal(list.length, 10);
  assert.ok(list.every(r => r.state === 'running'));
});
