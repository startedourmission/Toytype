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

test('로컬 용어 통일: 긴 문서도 빠른 토큰 인덱스로 처리한다', async () => {
  const base = '메소드와 메서드를 함께 설명한다. 메소드 호출과 메서드 정의를 본다. 리눅스와 Linux도 섞여 있다. ';
  const text = base.repeat(Math.ceil(20000 / base.length)).slice(0, 20000);
  const startedAt = Date.now();
  const report = await buildLocalTermConsistencyReport({
    id: 'terms-long-speed-test',
    title: '긴 문서 속도 테스트',
    text
  }, mergeSettings({
    outputDir: '/tmp/toytype-generated-test',
    maxDocumentChars: 30000
  }));
  const elapsedMs = Date.now() - startedAt;

  assert.ok(elapsedMs < 1500, `expected local terms under 1500ms, got ${elapsedMs}ms`);
  assert.ok(report.terms.find(term => term.recommended === '메서드'));
  assert.ok(report.terms.find(term => term.recommended === '리눅스'));
});

// ───────── 혼용 탐지 재현율·오탐 가드 ─────────

async function termRows(text, maxDocumentChars = 100000) {
  const report = await buildLocalTermConsistencyReport({ id: 'terms-recall-test', title: '혼용 탐지 테스트', text }, mergeSettings({
    outputDir: '/tmp/toytype-generated-test',
    maxDocumentChars
  }));
  return report.terms.filter(term => term.kind !== 'particle');
}

function rowWith(rows, ...surfaces) {
  return rows.find(row => surfaces.every(surface => row.variants.some(variant => variant.text === surface)));
}

function countOf(row, surface) {
  const variant = row.variants.find(item => item.text === surface);
  return variant ? variant.count : 0;
}

test('로컬 용어 통일: 사전에 없는 외래어 표기 차이를 조사가 붙어 있어도 찾는다', async () => {
  const rows = await termRows([
    '트랜스포머는 어텐션으로 문맥을 파악합니다. 트랜스포마가 등장하면서 임베딩의 품질이 좋아졌습니다.',
    '임배딩을 저장합니다. 어탠션은 토큰 사이의 관계를 계산합니다.',
    '토크나이저는 문장을 나눕니다. 토크나이져마다 결과가 다릅니다.',
    '에이전트는 도구를 호출합니다. 에이젼트가 여러 개입니다.',
    '엘리먼트를 선택합니다. 엘리멘트의 속성을 봅니다.',
    '인터페이스입니다. 인터훼이스를 구현합니다.'
  ].join(' '));

  for (const [recommended, other] of [['트랜스포머', '트랜스포마'], ['임베딩', '임배딩'], ['어텐션', '어탠션'], ['토크나이저', '토크나이져'], ['에이전트', '에이젼트'], ['엘리먼트', '엘리멘트'], ['인터페이스', '인터훼이스']]) {
    const row = rowWith(rows, recommended, other);
    assert.ok(row, `${recommended}/${other} 혼용을 찾아야 한다`);
    assert.equal(row.recommended, recommended);
  }
});

test('로컬 용어 통일: 조사·서술격이 붙은 표기도 빠짐없이 센다', async () => {
  const rows = await termRows('컴포넌트입니다. 컴포넌트처럼 씁니다. 컴포넌트들이 많습니다. 컴포넌트라고 부릅니다. 콤포넌트까지 봅니다. 콤포넌트가 있습니다.');
  const row = rowWith(rows, '컴포넌트', '콤포넌트');
  assert.ok(row);
  assert.equal(row.recommended, '컴포넌트');
  assert.equal(countOf(row, '컴포넌트'), 4);
  assert.equal(countOf(row, '콤포넌트'), 2);
});

test('로컬 용어 통일: 띄어쓰기만 다른 표기를 찾는다', async () => {
  const rows = await termRows('사용자가 로그인하면 세션이 만들어집니다. 로그 인에 실패하면 오류를 보여 줍니다. 파이프라인은 여러 단계를 잇습니다. 파이프 라인의 각 단계는 독립적입니다. 이 메일은 이메일 주소로 보냅니다.');
  assert.ok(rowWith(rows, '로그인', '로그 인'));
  assert.ok(rowWith(rows, '파이프라인', '파이프 라인'));
  assert.equal(rowWith(rows, '이메일', '이 메일'), undefined);
});

test('로컬 용어 통일: 영문 대소문자·한영 혼용·약어를 한 행으로 묶는다', async () => {
  const rows = await termRows([
    'React는 라이브러리입니다. 리액트에서는 화면을 나눕니다.',
    'Javascript 코드를 작성할 때는 JavaScript 문법을 따릅니다. 자바 스크립트 엔진은 다릅니다. 자바스크립트는 쉽습니다.',
    '응답은 JSON으로 옵니다. json 형식은 읽기 쉽습니다.',
    '정보는 데이터베이스에 저장합니다. 데이타베이스를 설계합니다. DB에 접속합니다. 데이터 베이스가 느립니다.',
    '서브클래스는 메서드를 재정의합니다. 하위 클래스에서 재정의한 메서드가 호출됩니다.',
    '스트림릿(Streamlit)으로 화면을 만듭니다. Streamlit은 쉽습니다. 스트림릿을 실행합니다.'
  ].join(' '));

  assert.ok(rowWith(rows, 'React', '리액트'));
  const js = rowWith(rows, 'JavaScript', 'Javascript', '자바스크립트', '자바 스크립트');
  assert.ok(js);
  assert.notEqual(js.recommended, 'Javascript');
  assert.equal(rowWith(rows, 'JSON', 'json').recommended, 'JSON');
  assert.equal(rowWith(rows, '데이터베이스', '데이타베이스', '데이터 베이스', 'DB').recommended, '데이터베이스');
  assert.ok(rowWith(rows, '서브클래스', '하위 클래스'));
  const gloss = rowWith(rows, '스트림릿', 'Streamlit');
  assert.ok(gloss);
  // 괄호 속 병기는 사용 횟수에서 뺀다.
  assert.equal(countOf(gloss, 'Streamlit'), 1);
  assert.equal(countOf(gloss, '스트림릿'), 2);
});

test('로컬 용어 통일: 괄호 병기만 있고 본문은 한 표기면 혼용이 아니다', async () => {
  const rows = await termRows('쿠버네티스(Kubernetes)는 컨테이너를 관리합니다. 쿠버네티스 클러스터는 노드로 구성됩니다. 함수(function)는 function 키워드로 선언합니다.');
  assert.deepEqual(rows, []);
});

test('로컬 용어 통일: 닮았지만 다른 말은 묶지 않는다', async () => {
  const rows = await termRows([
    '프로세서는 프로세스를 번갈아 실행합니다. 컨트롤러는 컨트롤 흐름을 넘깁니다. 컴파일러는 코드를 컴파일합니다.',
    '클래식 음악 예제의 클래스 이름을 정합니다. 함수형 언어에서는 함수를 인수로 넘깁니다.',
    '세션은 다음 섹션에서 다룹니다. 버전 정보는 버튼 옆에 표시합니다. 인스턴스를 띄우고 인스턴트 메시지를 보냅니다.',
    '사용자가 로그인하면 로그를 남기고, 로그아웃하면 세션을 지웁니다. 스케줄러가 스케줄을 실행합니다.',
    '익스포트와 임포트, 포트와 파트, 코드와 카드, 노드와 모드를 구분합니다. 첫 포스트는 퍼스트 클래스 함수를 다룹니다.',
    '메트릭은 대시보드에 표시하고 매트릭스 연산은 GPU에서 합니다. 스트림은 스트링을 읽습니다. 라우터는 라우트를 고릅니다.',
    '확장성과 확정성은 다릅니다. 저장소를 만들고 조정소에 알립니다. 반환값과 변환값을 확인합니다. 안정성과 안전성을 구분합니다.',
    '복잡도와 정확도를 봅니다. 전문가가 추가로 결과를 확인합니다. 워크플로 정의는 매크로 없이 작성합니다.',
    '결과는 String 타입이며 string 키워드로 선언합니다. Map 객체와 map 함수는 다릅니다. git commit 명령으로 Git 저장소에 올립니다.',
    'user.name 값과 getName() 호출, docker logs 명령을 Docker 문서에서 확인합니다.'
  ].join(' '));
  assert.deepEqual(rows.map(row => row.variants.map(variant => variant.text).join('/')), []);
});

test('로컬 용어 통일: 한 표기만 있는 긴 사전 용어가 짧은 용어의 혼용을 가리지 않는다', async () => {
  const rows = await termRows('버전 관리는 깃으로 합니다. 버젼이 바뀌면 노트를 씁니다. 셸 스크립트를 씁니다. 쉘 명령어는 4장에서 다룹니다.');
  assert.equal(rowWith(rows, '버전', '버젼').recommended, '버전');
  assert.equal(rowWith(rows, '셸', '쉘').recommended, '셸');
});

test('로컬 용어 통일: 혼용이 12건을 넘어도, 4만 자 뒤에 있어도 보여 준다', async () => {
  const pairs = [['컴포넌트', '콤포넌트'], ['메서드', '메소드'], ['디렉터리', '디렉토리'], ['애플리케이션', '어플리케이션'], ['아키텍처', '아키텍쳐'],
    ['캐시', '캐쉬'], ['스케줄', '스케쥴'], ['버전', '버젼'], ['릴리스', '릴리즈'], ['엘리먼트', '엘리멘트'], ['프로퍼티', '프라퍼티'],
    ['컨테이너', '콘테이너'], ['라이선스', '라이센스'], ['메시지', '메세지'], ['트랜잭션', '트랜젝션'], ['대시보드', '대쉬보드']];
  const mixed = pairs.map(([a, b]) => `${a}를 설명합니다. ${b}도 봅니다.`).join(' ');
  const rows = await termRows(mixed);
  for (const [a, b] of pairs) assert.ok(rowWith(rows, a, b), `${a}/${b}`);

  const filler = '이 문단은 분량을 채우기 위한 평범한 문장입니다. ';
  const longText = '임베딩을 계산합니다. ' + filler.repeat(Math.ceil(45000 / filler.length)) + '임배딩은 벡터입니다.';
  assert.ok(longText.indexOf('임배딩') > 40000);
  assert.ok(rowWith(await termRows(longText, 180000), '임베딩', '임배딩'));
});
