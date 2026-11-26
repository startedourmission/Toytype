import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProofreadChunkPrompt, parseProofreadChunkFindings, parseProofreadChunkNote } from '../tools/toytype_ai_bridge.mjs';

const TEXT = '이 함수는 리스트를 정렬합니다. 정렬된 결과을 반환 합니다. 코드는 sort()를 씁니다.';

test('구간 교정: 원문에 있는 문구만 남기고 위치순으로 정렬한다', () => {
  const response = 'noise {"findings":[' +
    '{"source":"반환 합니다","replacement":"반환합니다","reason":"띄어쓰기","category":"맞춤법"},' +
    '{"source":"결과을","replacement":"결과를","reason":"조사","category":"맞춤법"},' +
    '{"source":"없는 문구","replacement":"x"},' +
    '{"source":"결과을","replacement":"결과를"},' +
    '{"source":"같음","replacement":"같음"}]} tail';
  const out = parseProofreadChunkFindings(response, TEXT);
  assert.deepEqual(out.map(f => f.source), ['결과을', '반환 합니다']);
  assert.equal(out[0].offset, TEXT.indexOf('결과을'));
  assert.equal(out[1].category, '맞춤법');
});

test('구간 교정: JSON이 없으면 빈 목록', () => {
  assert.deepEqual(parseProofreadChunkFindings('모르겠습니다', TEXT), []);
});

test('구간 교정 프롬프트: 구간 번호와 본문을 담는다', () => {
  const prompt = buildProofreadChunkPrompt({ title: '09장', text: TEXT, chunkIndex: 2, chunkCount: 5 });
  assert.match(prompt, /"section":3,"of":5/);
  assert.ok(prompt.includes(TEXT));
});

test('구간 교정: 에이전트 보고 문장과 지시를 다룬다', () => {
  assert.equal(parseProofreadChunkNote('{"note":"존댓말 2곳을 통일했습니다","findings":[]}'), '존댓말 2곳을 통일했습니다');
  assert.equal(parseProofreadChunkNote('없음'), '');
  const prompt = buildProofreadChunkPrompt({ text: TEXT, instruction: '합니다체로 통일' });
  assert.ok(prompt.includes('<<<합니다체로 통일>>>'));
});

test('구간 교정 프롬프트: 앞선 대화 요약을 넣는다', () => {
  const prompt = buildProofreadChunkPrompt({ text: TEXT, instruction: '아까처럼 해 줘', history: [{ instruction: '합니다체로 통일', result: '12장 3곳', changes: ['했다 → 했습니다 [적용]'] }] });
  assert.ok(prompt.includes('TOYTYPE_SESSION_HISTORY'));
  assert.ok(prompt.includes('합니다체로 통일'));
  assert.ok(!buildProofreadChunkPrompt({ text: TEXT }).includes('TOYTYPE_SESSION_HISTORY'));
});
