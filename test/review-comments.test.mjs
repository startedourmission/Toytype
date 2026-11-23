import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewCommentsPrompt, parseReviewDecisions } from '../tools/toytype_ai_bridge.mjs';

const ITEMS = [
  { id: 's1', type: 'suggestion', author: '편집자', request: '바꾸기', context: '배열을 ⟦-사용한다⟧⟦+사용합니다⟧.' },
  { id: 'c1', type: 'comment', author: '검토자', request: 'LIFO도 적어 주세요', anchor: '후입선출', context: '스택은 후입선출 구조다.' },
  { id: 'c2', type: 'comment', author: '검토자', request: '그림 새로', context: '그림 3-1' }
];

test('댓글 반영: 형식에 맞는 결정만 남기고 문맥에 없는 고침은 넘긴다', () => {
  const response = JSON.stringify({ note: 'ok', decisions: [
    { id: 's1', decision: 'accept', reason: '문체 통일' },
    { id: 'c1', decision: 'edit', source: '후입선출', replacement: '후입선출(LIFO)', reason: '요청 반영' },
    { id: 'c2', decision: 'edit', source: '없는 문구', replacement: 'x' },
    { id: 's1', decision: 'reject' },
    { id: 's1x', decision: 'reject' },
    { id: 'zz', decision: 'accept' },
    { id: 'c1', decision: 'accept' }
  ] });
  const out = parseReviewDecisions('noise ' + response, ITEMS);
  assert.deepEqual(out.map(d => [d.id, d.decision]), [['s1', 'accept'], ['c1', 'edit'], ['c2', 'skip']]);
  assert.equal(out[1].replacement, '후입선출(LIFO)');
});

test('댓글 반영: 제안 거절은 하지 않고 남겨 둔다', () => {
  const out = parseReviewDecisions(JSON.stringify({ decisions: [{ id: 's1', decision: 'reject', reason: '틀림' }] }), ITEMS);
  assert.deepEqual(out.map(d => [d.id, d.decision]), [['s1', 'skip']]);
});

test('댓글 반영: 프롬프트에 항목이 들어간다', () => {
  const prompt = buildReviewCommentsPrompt({ title: '3장', items: ITEMS });
  assert.match(prompt, /TOYTYPE_REVIEW_ITEMS/);
  assert.match(prompt, /LIFO도 적어 주세요/);
});
