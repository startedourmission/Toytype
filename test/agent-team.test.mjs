import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlanWorkPrompt, parsePlanWork, buildSurveyRulesPrompt, parseSurveyRules, buildProofreadChunkPrompt } from '../tools/toytype_ai_bridge.mjs';

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

test('구간 교정: 계획·규칙을 받고, 게시판·share는 없다', () => {
  const p = buildProofreadChunkPrompt({ text: '본문', instruction: '용어 통일', plan: { brief: '용어만 고침', rules: ['자료구조로 붙여 씀'] }, team: [{ from: 'x', note: '문제 절은 “문제 N”으로 시작' }] });
  assert.match(p, /Team plan from the lead/);
  assert.match(p, /자료구조로 붙여 씀/);
  assert.doesNotMatch(p, /Team board|"share"|문제 N/);
});

test('구간 교정: 규칙 후보를 받지 않고, 기계적 맞춤법·윤문을 하지 말라고 한다', () => {
  const p = buildProofreadChunkPrompt({ text: '됬다', ruleCandidates: [{ id: 0, source: '됬', replacement: '됐', context: '⟦됬⟧다' }] });
  assert.doesNotMatch(p, /RULE_HINTS|RULE_CANDIDATES|rejectRules/);
  assert.match(p, /No 윤문 unless asked/);
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

test('구간 메모: 고칠 곳 없다는 말은 비우고, 알릴 거리는 남긴다', async () => {
  const { parseProofreadChunkNote, buildProofreadChunkPrompt } = await import('../tools/toytype_ai_bridge.mjs');
  for (const n of ['고칠 곳이 없습니다.', '수정할 부분이 없습니다', '이 구간에는 고칠 것이 딱히 없습니다.']) {
    assert.equal(parseProofreadChunkNote(JSON.stringify({ note: n })), '', n);
  }
  const keep = '‘해시 테이블’이 처음 나오는데 원어 병기가 없습니다.';
  assert.equal(parseProofreadChunkNote(JSON.stringify({ note: keep })), keep);
  assert.equal(parseProofreadChunkNote(JSON.stringify({ note: '존댓말 3곳을 통일했습니다.' })), '존댓말 3곳을 통일했습니다.');
  assert.doesNotMatch(buildProofreadChunkPrompt({ text: '본문' }), /"note"/);
});

test('구간 결함 표시: 원문에 있는 인용만 받아 위치를 짚는다', async () => {
  const { parseProofreadChunkFlags } = await import('../tools/toytype_ai_bridge.mjs');
  const text = '09 다음 트리를 보고 답하세요.\n*\n출력 결과\n';
  const out = parseProofreadChunkFlags(JSON.stringify({ flags: [
    { quote: '다음 트리를 보고', issue: '그림 2: 노드 값 7이 본문과 다름' },
    { quote: '없는 문구', issue: 'x' },
    { quote: '출력 결과', issue: '' }
  ] }), text);
  assert.deepEqual(out, [{ quote: '다음 트리를 보고', issue: '그림 2: 노드 값 7이 본문과 다름', offset: 3 }]);
});

test('질문: 작업 방식을 묻는 질문은 버리고 원고 내용 선택만 남긴다', async () => {
  const { parseQuestions } = await import('../tools/toytype_ai_bridge.mjs');
  const out = parseQuestions(JSON.stringify({ questions: [
    { question: '코드나 출력 결과에서 오류를 찾으면 원고를 직접 고칠까요, 아니면 위치와 수정안만 표시해 둘까요?', options: ['확실한 오류는 직접 수정', '모두 표시만 하고 수정안 제시'] },
    { question: '워밍업 문항이 비어 있는 곳은 에이전트가 내용을 새로 채울까요?', options: ['새로 작성', '빈 곳만 표시'] },
    { question: '그림 설명과 값이 맞는지만 점검하면 될까요?', options: ['대조만', '빠진 곳까지'] },
    { topic: '자료구조', question: '‘자료 구조’와 ‘자료구조’ 중 어느 쪽으로 통일할까요?', options: ['자료구조', '자료 구조'] }
  ] }));
  assert.equal(out.length, 1);
  assert.equal(out[0].topic, '자료구조');
});

test('구간 교정: 지시에 그림이 있으면 붙인 그림 목록을 프롬프트에 넣는다', async () => {
  const { buildProofreadChunkPrompt } = await import('../tools/toytype_ai_bridge.mjs');
  const p = buildProofreadChunkPrompt({ text: '다음 트리를 보세요.\n*\n그림 3-1 이진 트리', instruction: '그림이 본문과 맞는지 봐 줘', figureInfo: [{ n: 3, before: '다음 트리를 보세요.', after: '그림 3-1 이진 트리' }] });
  assert.match(p, /FIGURES: the figure images/);
  assert.match(p, /image 1 = 그림 3/);
  assert.doesNotMatch(buildProofreadChunkPrompt({ text: '본문' }), /FIGURES:/);
});

test('뽑은 글자 한계: 없다·비었다는 지적과 개체 자리(*)를 건드리는 수정은 버린다', async () => {
  const { parseProofreadChunkFlags, parseProofreadChunkFindings, buildProofreadChunkPrompt } = await import('../tools/toytype_ai_bridge.mjs');
  const text = '순서도를 보세요.\n*\n출력 결과\n워밍업 문항\n';
  const flags = parseProofreadChunkFlags(JSON.stringify({ flags: [
    { quote: '순서도를 보세요.', issue: "순서도 그림 누락 — '*' 자리만 있음" },
    { quote: '출력 결과', issue: '출력 결과 비어 있음 — 55' },
    { quote: '워밍업 문항', issue: '워밍업 문항 내용 비어 있음' },
    { quote: '순서도를 보세요.', issue: '그림 3: 본문은 55인데 그림은 50' }
  ] }), text);
  assert.deepEqual(flags.map(f => f.issue), ['그림 3: 본문은 55인데 그림은 50']);
  const f = parseProofreadChunkFindings(JSON.stringify({ findings: [{ source: '보세요.\n*\n', replacement: '보세요.\n', reason: 'x', category: '기타' }] }), text);
  assert.equal(f.length, 0);
  assert.match(buildProofreadChunkPrompt({ text: '본문' }), /don't call anything missing or empty/);
});

test('구간 교정: 앞뒤 글을 맥락으로 받고, 지적(flags)은 그림이 있을 때만', async () => {
  const { buildProofreadChunkPrompt } = await import('../tools/toytype_ai_bridge.mjs');
  const p = buildProofreadChunkPrompt({ text: 'while (p) { prev = p; }', before: '간단히 하려고 예외 처리는 생략합니다.', after: '다음 절에서는' });
  assert.match(p, /BEFORE_SECTION\n간단히 하려고/);
  assert.match(p, /AFTER_SECTION/);
  assert.match(p, /flags: only for problems inside attached figure images/);
  assert.doesNotMatch(buildProofreadChunkPrompt({ text: '본문' }), /BEFORE_SECTION/);
});

test('서식 수정: 서식 묶음을 프롬프트에 넣고, format 수정은 원문과 같아도 받는다', async () => {
  const { buildProofreadChunkPrompt, parseProofreadChunkFindings } = await import('../tools/toytype_ai_bridge.mjs');
  const text = '스택은 LIFO 구조입니다. 큐는 FIFO입니다.';
  const p = buildProofreadChunkPrompt({ text, instruction: '하이라이트 배경색 해제', formatRuns: [{ text: 'LIFO 구조', at: 4, highlight: '#ffff00' }] });
  assert.match(p, /FORMATTING:/);
  assert.match(p, /"highlight":"#ffff00"/);
  const out = parseProofreadChunkFindings(JSON.stringify({ findings: [
    { source: 'LIFO 구조', replacement: 'LIFO 구조', reason: '배경색 해제', category: '서식', format: { highlight: 'none', size: 99 } },
    { source: 'FIFO', replacement: 'FIFO', reason: 'x', category: '기타' },
    { source: '큐는', replacement: '큐는', format: { highlight: 'yellow' } }
  ] }), text);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].format, { highlight: 'none' });
  assert.doesNotMatch(buildProofreadChunkPrompt({ text }), /FORMATTING:/);
});
