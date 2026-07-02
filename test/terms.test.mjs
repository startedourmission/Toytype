import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLocalTermConsistencyReport,
  mergeSettings
} from '../tools/toytype_ai_bridge.mjs';

test('로컬 용어 통일: garu-ko와 규칙 사전으로 혼용 용어를 찾는다', async () => {
  const report = await buildLocalTermConsistencyReport({
    id: 'terms-local-test',
    title: '용어 통일 테스트',
    text: '메소드와 메서드를 함께 설명한다. 메소드 호출과 메서드 정의를 본다. 리눅스와 Linux도 섞여 있다.'
  }, mergeSettings({
    outputDir: '/tmp/toytype-generated-test',
    maxDocumentChars: 10000
  }));

  assert.equal(report.provider, 'local');
  assert.match(report.model, /^garu-ko/);

  const method = report.terms.find(term => term.recommended === '메서드');
  assert.ok(method);
  assert.deepEqual(method.variants.map(variant => variant.text).sort(), ['메서드', '메소드']);

  const linux = report.terms.find(term => term.recommended === '리눅스');
  assert.ok(linux);
  assert.deepEqual(linux.variants.map(variant => variant.text).sort(), ['Linux', '리눅스']);
});

test('로컬 용어 통일: 한 표기만 있으면 혼용으로 보지 않는다', async () => {
  const report = await buildLocalTermConsistencyReport({
    id: 'terms-single-test',
    title: '단일 표기 테스트',
    text: '메서드 호출과 메서드 정의를 설명한다. 리눅스 환경에서 실행한다.'
  }, mergeSettings({
    outputDir: '/tmp/toytype-generated-test',
    maxDocumentChars: 10000
  }));

  assert.equal(report.terms.find(term => term.recommended === '메서드'), undefined);
  assert.equal(report.terms.find(term => term.recommended === '리눅스'), undefined);
});

test('로컬 용어 통일: 영문 약어 뒤 조사 오류를 찾는다', async () => {
  const report = await buildLocalTermConsistencyReport({
    id: 'terms-particle-test',
    title: '조사 오류 테스트',
    text: 'AI을 쓰고 URL가 보이고 JSON는 형식이다. API을 호출하고 CLI은 도구다. Git를 쓴다. URL으로 이동한다. GPT-4을 쓴다. HTML5은 표준이다. MCP를 쓴다.'
  }, mergeSettings({
    outputDir: '/tmp/toytype-generated-test',
    maxDocumentChars: 10000
  }));

  const recommended = new Set(report.terms.filter(term => term.kind === 'particle').map(term => term.recommended));
  assert.ok(recommended.has('AI를'));
  assert.ok(recommended.has('URL이'));
  assert.ok(recommended.has('JSON은'));
  assert.ok(recommended.has('API를'));
  assert.ok(recommended.has('CLI는'));
  assert.ok(recommended.has('Git을'));
  assert.ok(recommended.has('URL로'));
  assert.ok(recommended.has('GPT-4를'));
  assert.ok(recommended.has('HTML5는'));
  assert.equal(recommended.has('MCP를'), false);
});

test('로컬 용어 통일: 올바른 영문 약어 조사는 오탐으로 보지 않는다', async () => {
  const report = await buildLocalTermConsistencyReport({
    id: 'terms-particle-clean-test',
    title: '조사 정상 테스트',
    text: 'AI를 쓰고 URL이 보이고 JSON은 형식이다. API를 호출하고 CLI는 도구다. Git을 쓴다. URL로 이동한다. GPT-4를 쓴다. HTML5는 표준이다. MCP를 쓴다.'
  }, mergeSettings({
    outputDir: '/tmp/toytype-generated-test',
    maxDocumentChars: 10000
  }));

  assert.equal(report.terms.some(term => term.kind === 'particle'), false);
});
