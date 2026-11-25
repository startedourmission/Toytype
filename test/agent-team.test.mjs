import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlanWorkPrompt, parsePlanWork, buildSurveyRulesPrompt, parseSurveyRules, buildProofreadChunkPrompt, parseShareNotes } from '../tools/toytype_ai_bridge.mjs';

const input = { instruction: '문제 절의 힌트를 지워', docs: [
  { id: 'd1', title: '5장', sections: [{ i: 0, head: '5.1 스택', chars: 3000 }, { i: 1, head: '문제', chars: 900 }] },
  { id: 'd2', title: '6장', sections: [{ i: 0, head: '6.1 큐', chars: 2000 }] }
] };

test('팀 계획: 목차와 지시가 프롬프트에 들어간다', () => {
  const p = buildPlanWorkPrompt(input);
  assert.match(p, /TOYTYPE_OUTLINE/);
  assert.match(p, /문제 절의 힌트를 지워/);
  assert.match(p, /"targeted\|all\|whole"/);
});

test('팀 계획: 모르는 문서·구간 번호는 버리고 scope를 정리한다', () => {
  const plan = parsePlanWork(JSON.stringify({ scope: 'targeted', targets: [{ doc: 'd1', sections: [1, 1, 9] }, { doc: 'x', sections: [0] }], brief: '힌트 줄만 지움', note: '문제 절 1곳' }), input);
  assert.deepEqual(plan.targets, [{ doc: 'd1', sections: [1] }]);
  assert.equal(plan.scope, 'targeted');
  assert.equal(plan.needsSurvey, false);
  const whole = parsePlanWork(JSON.stringify({ scope: 'whole', targets: [{ doc: 'd1', sections: [0] }] }), input);
  assert.equal(whole.needsSurvey, true);
  assert.deepEqual(whole.targets, []);
  assert.equal(parsePlanWork('not json', input), null);
  assert.equal(parsePlanWork(JSON.stringify({ scope: 'weird' }), input).scope, 'all');
});

test('규칙 훑기: 원고 본문과 규칙·질문을 다룬다', () => {
  const p = buildSurveyRulesPrompt({ instruction: '용어 통일', docs: [{ title: '1장', text: '자료 구조와 자료구조' }], plan: { brief: '용어만', rules: [] } });
  assert.match(p, /TOYTYPE_DOCUMENT_TEXT/);
  assert.match(p, /Team plan from the lead/);
  const out = parseSurveyRules(JSON.stringify({ rules: ['‘자료 구조’ → ‘자료구조’', ''], note: '규칙 1개' }));
  assert.deepEqual(out.rules, ['‘자료 구조’ → ‘자료구조’']);
});

test('구간 에이전트: 팀 계획·게시판을 받고 share를 돌려준다', () => {
  const p = buildProofreadChunkPrompt({ text: '본문', instruction: '용어 통일', plan: { brief: '용어만 고침', rules: ['자료구조로 붙여 씀'] }, team: [{ from: '에이전트 2 · 5장', note: '문제 절은 “문제 N”으로 시작' }] });
  assert.match(p, /Team plan from the lead/);
  assert.match(p, /자료구조로 붙여 씀/);
  assert.match(p, /Team board/);
  assert.match(p, /\[에이전트 2 · 5장\] 문제 절은/);
  assert.match(p, /"share":\[\]/);
  assert.doesNotMatch(buildProofreadChunkPrompt({ text: '본문' }), /Team board/);
  assert.deepEqual(parseShareNotes(JSON.stringify({ share: ['a', '', 'b', 'c', 'd'] })), ['a', 'b', 'c']);
  assert.deepEqual(parseShareNotes('x'), []);
});

test('구간 교정: 규칙 후보를 받지 않고, 기계적 맞춤법·윤문을 하지 말라고 한다', () => {
  const p = buildProofreadChunkPrompt({ text: '됬다', ruleCandidates: [{ id: 0, source: '됬', replacement: '됐', context: '⟦됬⟧다' }] });
  assert.doesNotMatch(p, /RULE_HINTS|RULE_CANDIDATES|rejectRules/);
  assert.match(p, /Do not do mechanical spelling/);
  assert.match(p, /Do NOT do 윤문/);
});

test('규칙 거르기: 무시·질문 id를 아는 후보로만 받는다', async () => {
  const { buildRuleTriagePrompt, parseRuleTriage } = await import('../tools/toytype_ai_bridge.mjs');
  const p = buildRuleTriagePrompt({ title: '5장', candidates: [{ id: 0, source: '저장 할', replacement: '저장할', context: '데이터를 ⟦저장 할⟧ 때' }] });
  assert.match(p, /TOYTYPE_RULE_CANDIDATES/);
  assert.match(p, /"ignore"/);
  const out = parseRuleTriage(JSON.stringify({ ignore: [1, 9, 1], questions: [
    { topic: '로그인', question: '로그 인/로그인 중 무엇으로?', options: ['로그인', '로그 인'], ids: [2, 7] },
    { question: '선택지 하나', options: ['A'], ids: [0] },
    { question: 'id 없음', options: ['A', 'B'], ids: [42] }
  ] }), [0, 1, 2, 3]);
  assert.deepEqual(out.ignore, [1]);
  assert.equal(out.questions.length, 1);
  assert.deepEqual(out.questions[0].ids, [2]);
  assert.equal(parseRuleTriage('x', [0]), null);
});

test('첨자는 서식: 유니코드 첨자·^로 바꾸는 구간 수정은 버린다', async () => {
  const { parseProofreadChunkFindings } = await import('../tools/toytype_ai_bridge.mjs');
  const text = '복잡도는 O(N2)이고 i2를 더한 뒤 결과를 출력합니다';
  const out = parseProofreadChunkFindings(JSON.stringify({ findings: [
    { source: 'O(N2)', replacement: 'O(N²)', reason: '위 첨자' },
    { source: 'i2를', replacement: 'i^2를', reason: '제곱' },
    { source: '출력합니다', replacement: '출력한다', reason: '문체' }
  ] }), text);
  assert.deepEqual(out.map(f => f.source), ['출력합니다']);
});

test('첫 언급: 이전 장 병기 목록과 못 읽은 장이 프롬프트에 들어간다', () => {
  const p = buildProofreadChunkPrompt({ text: '해시 테이블hash table은', firstMentions: [{ term: '해시 테이블', en: 'hash table', where: '12장 해시' }], unreadChapters: ['03장 배열'] });
  assert.match(p, /First-mention rule/);
  assert.match(p, /FIRST_MENTIONS/);
  assert.match(p, /hash table/);
  assert.match(p, /03장 배열/);
});

test('도해 점검: OCR 줄과 주변 글이 프롬프트에 들어가고 지적만 받는다', async () => {
  const { buildFigureTextPrompt, parseFigureFindings } = await import('../tools/toytype_ai_bridge.mjs');
  const p = buildFigureTextPrompt({ title: '5장', index: 2, context: '그림 5-2 스택 구조', ocr: { lines: [{ text: '데이타 삽입' }] }, canSeeImage: true, imagePath: '/tmp/x.png' });
  assert.match(p, /TOYTYPE_OCR_LINES/);
  assert.match(p, /데이타 삽입/);
  assert.match(p, /그림 5-2/);
  const out = parseFigureFindings(JSON.stringify({ text: '스택', findings: [{ found: '데이타', suggestion: '데이터', reason: '외래어 표기' }, { found: 'a', suggestion: 'a' }] }));
  assert.deepEqual(out.findings.map(f => f.found), ['데이타']);
  assert.equal(parseFigureFindings('x'), null);
});
