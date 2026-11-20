import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RULES_PATH, lintRules, formatRules } from '../tools/rules_tool.mjs';

const data = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));

test('자체 사전 rules.json에 오류가 없다', () => {
  const { errors } = lintRules(data);
  assert.deepEqual(errors, []);
});

test('rules.json은 한 줄에 규칙 하나 형식이다 (npm run rules:format)', () => {
  assert.equal(fs.readFileSync(RULES_PATH, 'utf8'), formatRules(data));
});

test('검사 도구가 대표적인 사전 오류를 잡는다', () => {
  const { errors, warnings } = lintRules({
    categories: [
      { id: 'a', rules: [['x', 'y'], ['x', 'y'], ['k', 'k'], ['z\u0008', 'w'], ['p', 'q'], ['q', 'p'], ['것', ' 것']] },
      { id: 'b', rules: [['x', 'z'], ['m', 'n', { rejectAfter: 1 }]] }
    ]
  });
  assert.equal(errors.length, 5);
  assert.equal(warnings.length, 2);
});
