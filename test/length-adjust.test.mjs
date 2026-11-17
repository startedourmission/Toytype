import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLengthAdjustmentPrompt,
  extractJsonObject,
  parseLengthAdjustmentReplacement
} from '../tools/toytype_ai_bridge.mjs';

const LONG_SOURCE = '연결 리스트란?\n배열은 데이터를 물리적으로 연속된 공간에 저장합니다.\u000b'.repeat(12);

test('길이 조절 프롬프트는 원문을 JSON에 다시 베끼라고 하지 않는다', () => {
  const prompt = buildLengthAdjustmentPrompt({ id: 'doc', selectedText: LONG_SOURCE, targetChars: 300 });
  assert.doesNotMatch(prompt, /length-adjusted replacement/);
  assert.match(prompt, /\{"replacement":"<adjusted text>"\}/);
  // 원문은 선택 영역 블록에 한 번만 들어간다
  assert.equal(prompt.split(LONG_SOURCE).length - 1, 1);
});

test('replacement 형식 응답에서 고쳐 쓴 문장을 꺼낸다', () => {
  const out = parseLengthAdjustmentReplacement('{"replacement": "짧게 고친 문장입니다."}', LONG_SOURCE);
  assert.equal(out, '짧게 고친 문장입니다.');
});

test('예전 Toytype 규칙 형식 응답도 읽는다', () => {
  const res = JSON.stringify({ version: 'x', source: 'y', categories: [{ id: 'c', rules: [['원문', '새 문장']] }] });
  assert.equal(parseLengthAdjustmentReplacement(res, '원문'), '새 문장');
});

test('문자열 안에 날것의 줄바꿈·제어 문자가 있어도 읽는다', () => {
  const res = '```json\n{"replacement": "첫 문단입니다.\n둘째 문단\u000b입니다."}\n```';
  assert.equal(parseLengthAdjustmentReplacement(res, LONG_SOURCE), '첫 문단입니다.\n둘째 문단\u000b입니다.');
  assert.deepEqual(extractJsonObject('{"a": "x\ny"}'), { a: 'x\ny' });
});

test('예시 자리표시자를 그대로 돌려주면 제안으로 저장하지 않는다', () => {
  for (const placeholder of ['length-adjusted replacement', '<adjusted text>']) {
    const res = JSON.stringify({ categories: [{ rules: [[LONG_SOURCE, placeholder]] }] });
    assert.throws(() => parseLengthAdjustmentReplacement(res, LONG_SOURCE), /placeholder/);
  }
});

test('자리표시자 뒤에 진짜 답이 있으면 진짜 답을 쓴다', () => {
  const res = '{"replacement": "<adjusted text>"}\n{"replacement": "진짜로 고친 문장"}';
  assert.equal(parseLengthAdjustmentReplacement(res, LONG_SOURCE), '진짜로 고친 문장');
});
