import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFormatCheckPrompt, parseFormatFindings } from '../tools/toytype_ai_bridge.mjs';

test('서식 점검: 문단 번호와 설명이 있는 지적만 남기고 범주를 정리한다', () => {
  const out = parseFormatFindings('x ' + JSON.stringify({ findings: [
    { at: 12, category: '코너', issue: '[주의]와 [경고]가 섞였습니다', suggestion: '[경고]로 통일', source: '[주의]', replacement: '[경고]' },
    { at: 'x', issue: '번호 없음' },
    { at: 3, category: '이상한', issue: '범주 모름', suggestion: '' },
    { at: 4, issue: '' }
  ] }));
  assert.deepEqual(out.map(f => [f.at, f.category]), [[12, '코너'], [3, '기타']]);
  assert.equal(out[0].replacement, '[경고]');
  assert.equal(out[1].source, undefined);
});

test('서식 점검: 서식 고칠 방법(fix)은 허용된 모양만 받는다', () => {
  const out = parseFormatFindings(JSON.stringify({ findings: [
    { at: 1, issue: '크기', fix: { type: 'fontSize', value: 10 } },
    { at: 2, issue: '첨자', fix: { type: 'script', kind: 'sup', text: '2', on: true } },
    { at: 3, issue: '이상한 fix', fix: { type: 'deleteAll' } },
    { at: 4, issue: '글꼴', fix: { type: 'fontFamily', value: 'Roboto Mono' } }
  ] }));
  assert.deepEqual(out.map(f => f.fix || null), [{ type: 'fontSize', value: 10 }, { type: 'script', kind: 'sup', text: '2', on: true }, null, { type: 'fontFamily', value: 'Roboto Mono' }]);
});

test('서식 점검: 프롬프트에 요약본과 규칙 지적이 들어간다', () => {
  const prompt = buildFormatCheckPrompt({ transcript: '#1 [body 10pt Arimo] 본문', stats: { body: 10 }, ruleFindings: [{ at: 1, issue: '크기' }] });
  assert.match(prompt, /TOYTYPE_FORMAT_TRANSCRIPT/);
  assert.match(prompt, /RULE_FINDINGS/);
  assert.match(prompt, /\[1:1 코칭\]/);
});

test('애매한 선택: 질문은 선택지가 둘 이상인 것만 받는다', async () => {
  const { parseQuestions, buildFormatCheckPrompt } = await import('../tools/toytype_ai_bridge.mjs');
  const qs = parseQuestions(JSON.stringify({ questions: [
    { topic: '원어 대소문자', question: '원어 병기를 어떻게 쓸까요?', options: ['Data Structure', 'data structure'] },
    { topic: '하나뿐', question: '선택지 하나', options: ['A'] },
    { question: '', options: ['A', 'B'] }
  ] }));
  assert.deepEqual(qs.map(q => q.topic), ['원어 대소문자']);
  const prompt = buildFormatCheckPrompt({ transcript: '#1 [body] x', decisions: ['원어 대소문자: data structure'] });
  assert.match(prompt, /Editor decisions already made/);
  assert.match(prompt, /원어 대소문자: data structure/);
});
