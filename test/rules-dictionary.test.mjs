import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
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

// ── 오검출(false positive) 회귀 ── 실제 사전을 전 카테고리로 켜고 검사한다.
// 문장은 모두 테스트용으로 지은 것이다.
const require = createRequire(import.meta.url);
require('../engine.js');
const Engine = globalThis.TypoEngine;

function scanAll(text) {
  Engine.init(data, data.categories.map(c => c.id));
  return Engine.scan(text, { limit: 1000 }).findings;
}

function assertNoFinding(text, src) {
  const hits = scanAll(text).filter(f => f.src === src);
  assert.deepEqual(hits, [], `"${text}"에서 ${JSON.stringify(src)} 규칙이 발화하면 안 된다`);
}

function assertFinding(text, src, dst) {
  const hit = scanAll(text).find(f => f.src === src);
  assert.ok(hit, `"${text}"에서 ${JSON.stringify(src)} 규칙이 발화해야 한다`);
  assert.equal(hit.dst, dst);
}

test('보조 용언 붙여쓰기 규칙이 뒤 낱말(보내다·보고서·줄다·줄)을 삼키지 않는다', () => {
  assertNoFinding('메시지를 적어 보내면 됩니다.', '어 보');
  assertNoFinding('파일을 압축해 보냅니다.', '해 보');
  assertNoFinding('양식에 맞춰 보고서를 씁니다.', '맞춰 보');
  assertNoFinding('메뉴를 선택해 보고서를 저장합니다.', '해 보고');
  assertNoFinding('한 줄을 덧붙여 보냅니다.', '붙여 보');
  assertNoFinding('쓸 일이 없어 줄어드는 양이 적습니다.', '어 줄');
  assertNoFinding('표를 만들어 줄마다 색을 넣습니다.', '어 줄');
  assertNoFinding('항목을 정리해 두 개로 나눕니다.', '정리해 두');
  assertFinding('옵션을 변경해 보니 빨라졌습니다.', '해 보', '해보');
  assertFinding('대신 만들어 줄 수 있습니다.', '어 줄', '어줄');
});

test('"~화 하/한" 규칙이 "하나"와 수 관형사 "한"을 잡지 않는다', () => {
  assertNoFinding('대화 하나에 파일을 여러 개 올립니다.', '화 하');
  assertNoFinding('만화 한 장에 네 장면을 담습니다.', '화 한');
  assertFinding('코드를 최적화 한 뒤 실행합니다.', '화 한', '화한');
});

test('"X 합" 규칙이 명사 "합"(더한 값)을 붙이지 않는다', () => {
  assertNoFinding('최대 추가 합을 계산합니다.', '추가 합');
  assertNoFinding('선택 합과 기준값을 비교합니다.', '선택 합');
  assertFinding('항목을 추가 합니다.', '추가 합', '추가합');
});

test('낱말 속 글자에 걸리는 맞춤법 규칙을 문맥으로 막는다', () => {
  assert.equal(scanAll('청구지 주소를 입력합니다. 도구지만 쓰기 나름입니다.').some(f => f.dst.includes('굳이')), false);
  assertFinding('그렇게 구지 나눌 필요는 없습니다.', ' 구지 ', ' 굳이 ');
  assertNoFinding('군더더기 없이 답합니다.', '더더');
  assertNoFinding('빈 말풍선을 하나 둡니다.', '빈 말');
  assertNoFinding('맥에서는 응용 프로그램 폴더에 있습니다.', '응용 프로그램');
});

test('한 낱말인 "한곳에"·부사 "한번"은 띄우라고 하지 않는다', () => {
  assertNoFinding('자료를 한곳에 모아 둡니다.', '한곳');
  assertNoFinding('파일을 한번 열어 봅시다.', '한번');
  assertFinding('세 작업을 한번에 처리합니다.', '한번', '한 번');
});

test('"의 수"·"경우에" 축약 규칙이 뜻을 바꾸는 자리에서는 멈춘다', () => {
  assertNoFinding('N개의 수가 주어집니다.', '의 수');
  assertNoFinding('1부터 N까지의 수를 더합니다.', '의 수');
  assertFinding('간선의 수를 셉니다.', '의 수', ' 수');
  assertNoFinding('최악의 경우에도 O(log N)입니다.', '의 경우에');
  assertNoFinding('최악의 경우에도 O(log N)입니다.', '경우에');
  assertNoFinding('이 경우에는 예외가 발생합니다.', '경우에');
  assertNoFinding('모든 경우에 원복이 필요한 것은 아닙니다.', '경우에');
  assertFinding('값이 없는 경우에는 0을 반환합니다.', '경우에', '때에');
});

test('"~기 위해서"로 끝나는 문장·보기를 "~려면"으로 바꾸지 않는다', () => {
  assertNoFinding('② 두 값을 구별하기 위해서\n③ 다음 보기', '하기 위해서');
  assertNoFinding('표를 만들기 위해서입니다.', '만들기 위해서');
  assertNoFinding('될 수 있는 대로 빨리 끝냅니다.', '될 수 있는');
  assertFinding('값을 구별하기 위해서 표시를 둡니다.', '하기 위해서', '하려면');
});
