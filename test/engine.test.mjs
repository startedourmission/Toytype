// Toytype 매칭 엔진 테스트 — 실행: node test/engine.test.mjs (Node 20+)
// 주의: '초기화 전' 테스트가 가장 먼저 돌아야 하므로 테스트 등록 순서를 바꾸지 말 것.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../engine.js'); // CJS 평가 → globalThis.TypoEngine 생성 (D8: package.json 없음 전제)
const E = globalThis.TypoEngine;

const rulesJson = JSON.parse(readFileSync(new URL('../rules.json', import.meta.url), 'utf8'));
const ALL_IDS = ['convert', 'spelling', 'plural', 'honorific', 'space1', 'space2', 'space3', 'final'];

function synth(categories) {
  return { version: 'test-0', source: 'test', categories };
}
function cat(id, rules) {
  return { id, label: id, defaultOn: true, rules };
}
function initAll() {
  E.init(rulesJson, ALL_IDS);
}
function srcs(res) {
  return res.findings.map((f) => f.src);
}
function deepFreeze(o) {
  Object.freeze(o);
  for (const v of Object.values(o)) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  }
  return o;
}

test('T11a 초기화 전: scan throw, 상태 조회는 안전', () => {
  assert.equal(E.isReady(), false);
  assert.equal(E.version, null);
  assert.deepEqual(E.categories(), []);
  assert.throws(() => E.scan('갯수'), /not initialized/);
});

test('T11b 불량 rulesJson: init throw, 기존 상태 비오염', () => {
  const bads = [
    [null, []],
    ['x', []],
    [{}, []],
    [{ version: 'v', categories: 'x' }, []],
    [synth([{ id: 7, label: 'x', rules: [] }]), []],
    [synth([cat('a', [['x']])]), []],
    [synth([cat('a', [['x', 1]])]), []],
    [synth([cat('a', [['x', 'y']])]), 'not-an-array']
  ];
  for (const [rj, ids] of bads) {
    assert.throws(() => E.init(rj, ids), Error);
  }
  assert.equal(E.isReady(), false); // 실패한 init은 상태를 바꾸지 않는다
});

test('T1 rules.json 구조: 정본 카테고리 8개, 모든 규칙은 [string,string]', () => {
  assert.equal(typeof rulesJson.version, 'string');
  const ids = rulesJson.categories.map((c) => c.id);
  assert.deepEqual([...ids].sort(), [...ALL_IDS].sort());
  for (const c of rulesJson.categories) {
    assert.ok(c.rules.length > 0, `카테고리 ${c.id}에 규칙 없음`);
    assert.equal(typeof c.label, 'string');
    for (const r of c.rules) {
      assert.ok(
        Array.isArray(r) && (r.length === 2 || r.length === 3) && typeof r[0] === 'string' && typeof r[1] === 'string',
        `불량 규칙 (${c.id}): ${JSON.stringify(r)}`
      );
      if (r.length === 3) {
        assert.ok(r[2] && typeof r[2] === 'object' && !Array.isArray(r[2]), `불량 규칙 옵션 (${c.id}): ${JSON.stringify(r)}`);
        for (const key of ['rejectBefore', 'rejectAfter']) {
          if (r[2][key] !== undefined) {
            assert.ok(
              typeof r[2][key] === 'string' || (Array.isArray(r[2][key]) && r[2][key].every((x) => typeof x === 'string')),
              `불량 ${key} 옵션 (${c.id}): ${JSON.stringify(r)}`
            );
          }
        }
      }
    }
  }
});

test('init 반환값·categories()·version', () => {
  const ret = E.init(rulesJson, ALL_IDS);
  assert.equal(ret.version, rulesJson.version);
  const total = rulesJson.categories.reduce((a, c) => a + c.rules.length, 0);
  assert.equal(ret.totalRules, total);
  assert.ok(ret.activeRules > 0 && ret.activeRules <= total);
  assert.equal(E.isReady(), true);
  assert.equal(E.version, rulesJson.version);

  const cats = E.categories();
  assert.deepEqual(cats.map((c) => c.id), rulesJson.categories.map((c) => c.id));
  assert.deepEqual(cats.map((c) => c.ruleCount), rulesJson.categories.map((c) => c.rules.length));
  assert.ok(cats.every((c) => c.enabled === true));

  E.init(rulesJson, ['spelling']); // 재호출 = 전체 리빌드
  for (const c of E.categories()) assert.equal(c.enabled, c.id === 'spelling');
});

test('T2 실데이터: 갯수 검출 (중복 src 동률은 카테고리 순서로 convert)', () => {
  initAll();
  const { findings } = E.scan('갯수를 세어보자');
  assert.deepEqual(findings[0], { start: 0, end: 2, src: '갯수', dst: '개수', cat: 'convert' });
  assert.ok(srcs(E.scan('갯수를 셀 때')).includes('갯수'));
});

test('T3 실데이터: space1 선행 공백 포함 매칭', () => {
  initAll();
  const f = E.scan('지금 부터').findings.find((x) => x.src === ' 부터');
  assert.ok(f, "' 부터' 미검출");
  assert.equal(f.start, 2); // 공백 위치
  assert.equal(f.end, 5);
  assert.equal(f.cat, 'space1');
  assert.equal(f.dst, '부터');
});

test('실데이터: 타겟·초기 값·할때 검출', () => {
  initAll();
  let f = E.scan('타겟 고객').findings.find((x) => x.src === '타겟');
  assert.ok(f, "'타겟' 미검출");
  assert.deepEqual(f, { start: 0, end: 2, src: '타겟', dst: '타깃', cat: 'spelling' });

  f = E.scan('초기 값 설정').findings.find((x) => x.src === '초기 값');
  assert.ok(f, "'초기 값' 미검출");
  assert.equal(f.dst, '초깃값');

  f = E.scan('할때').findings.find((x) => x.src === '할때');
  assert.ok(f, "'할때' 미검출");
  assert.equal(f.dst, '할 때');
  assert.equal(f.cat, 'convert'); // convert·plural·space1·space2 중복 → 카테고리 순서 우선
});

test('실데이터: 요구사항 표기로 통일', () => {
  initAll();
  assert.equal(E.scan('요구사항을 정리한다').findings.length, 0);

  const f = E.scan('요구 사항을 정리한다').findings.find((x) => x.src === '요구 사항');
  assert.ok(f, "'요구 사항' 미검출");
  assert.equal(f.dst, '요구사항');
});

test('T4 가드 A: ASCII 단어 경계 (합성)', () => {
  E.init(synth([cat('convert', [['Git', '깃']])]), ['convert']);
  assert.equal(E.scan('GitHub').findings.length, 0);
  assert.equal(E.scan('MyGit').findings.length, 0);
  const { findings } = E.scan('Git을 쓴다');
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0], { start: 0, end: 3, src: 'Git', dst: '깃', cat: 'convert' });
});

test('가드 A: 한글 src는 ASCII 경계 검사 없음 (합성)', () => {
  E.init(synth([cat('convert', [['갯수', '개수']])]), ['convert']);
  assert.equal(E.scan('X갯수Y').findings.length, 1);
});

test('T5 가드 B: URL·코드 토큰 내부 미검출 (합성)', () => {
  E.init(synth([cat('convert', [['갯수', '개수'], ['Git', '깃']])]), ['convert']);
  assert.deepEqual(srcs(E.scan('https://github.com/Git 갯수')), ['갯수']);
  assert.equal(E.scan('model.fit(Git)').findings.length, 0);
  assert.equal(E.scan('Git 사용법').findings.length, 1); // 3자·특수문자 없음 → 통과
  assert.equal(E.scan('갯수,').findings.length, 1);      // 한글 포함 토큰은 ASCII-only 아님 → 통과
});

test('가드 B 실데이터: URL·식별자 안 IOS 미검출, 단독은 검출', () => {
  initAll();
  assert.ok(!srcs(E.scan('https://example.com/IOS')).includes('IOS'));
  assert.ok(!srcs(E.scan('BIOS')).includes('IOS')); // 가드 A: 'B' 뒤
  const f = E.scan('IOS 출시').findings.find((x) => x.src === 'IOS');
  assert.ok(f, "단독 'IOS' 미검출");
  assert.equal(f.dst, 'iOS');
});

test('파이프라인 규칙 제외: 선두 공백 추가형(dst=" "+src)은 init에서 비활성 (합성)', () => {
  // "것"→" 것"은 시트의 순차 매크로 — 정상 합성어(이것·그때·매개변수)에서 전부
  // 발화하므로 점검출 규칙으로 쓰지 않는다. activeRules에서 빠져야 한다.
  const ret = E.init(synth([cat('space1', [['것', ' 것'], [' 부터', '부터']])]), ['space1']);
  assert.equal(ret.activeRules, 1);
  assert.equal(E.scan('이것을 할 것').findings.length, 0); // 합성어·정상 표기 미발화
  assert.equal(E.scan('지금 부터').findings.length, 1);     // 공백 제거형은 정상 동작
});

test('가드 D: 말미 공백 추가형("➊"→"➊ ")은 단어에 붙었을 때만 검출 (합성)', () => {
  E.init(synth([cat('final', [['➊', '➊ ']])]), ['final']);
  assert.equal(E.scan('➊클릭').findings.length, 1);   // 한글에 붙음 → 검출
  assert.equal(E.scan('➊run').findings.length, 1);    // 영숫자에 붙음 → 검출
  assert.equal(E.scan('➊ 클릭').findings.length, 0);  // 이미 공백 → 미검출
  assert.equal(E.scan('순서 ➊').findings.length, 0);  // 문서 끝 경계 → 미검출
  assert.equal(E.scan('➊, 다음').findings.length, 0); // 구두점 앞 → 미검출

  // 공백 추가형이 아닌 규칙(공백 제거·내부 삽입)은 가드 D 영향 없음
  E.init(synth([cat('space1', [[' 부터', '부터'], ['할때', '할 때']])]), ['space1']);
  assert.equal(E.scan('지금 부터 할때').findings.length, 2);
});

test('파이프라인 제외 실데이터: 정상 표기(이것·매개변수·셀 때)는 미검출, 붙은 형태는 검출', () => {
  initAll();
  // 시트의 보정 규칙("이 것"→"이것", "매개 변수"→"매개변수")이 정답으로 보증하는 형태들
  assert.equal(E.scan('셀 때 다시 본다').findings.length, 0);
  assert.equal(E.scan('이것은 매개변수다').findings.length, 0);
  assert.equal(E.scan('그때 한때 점심때').findings.length, 0);
  // 붙은 형태는 명시적 합성 규칙으로 잡힌다
  assert.ok(srcs(E.scan('콜백함수를 쓴다')).includes('콜백함수'));
  // 실데이터에 선두 공백 추가형 규칙이 실제로 존재하는지 (제외 대상 존재 보증)
  const space1 = rulesJson.categories.find((c) => c.id === 'space1');
  assert.ok(space1.rules.some(([s, d]) => d === ' ' + s), 'space1에 공백 추가형 규칙 없음');
});

test('가드 B 확장: 한글 경로 URL 토큰 내부 미검출 (합성)', () => {
  E.init(synth([cat('convert', [['쉘', '셸']])]), ['convert']);
  assert.equal(E.scan('https://ko.wikipedia.org/wiki/쉘 참고').findings.length, 0);
  assert.equal(E.scan('쉘 스크립트').findings.length, 1); // URL 아닌 한글 토큰은 검출
});

test('캡 정확성: 정확히 limit건이면 truncated=false (합성)', () => {
  E.init(synth([cat('convert', [['갯수', '개수']])]), ['convert']);
  const exact = E.scan('갯수 '.repeat(10), { limit: 10 });
  assert.equal(exact.findings.length, 10);
  assert.equal(exact.truncated, false);
});

test('T6 가드 C: 결과 캡', () => {
  E.init(synth([cat('convert', [['갯수', '개수']])]), ['convert']);
  const res = E.scan('갯수 '.repeat(600));
  assert.equal(res.findings.length, 500); // 기본 limit
  assert.equal(res.truncated, true);

  const res10 = E.scan('갯수 '.repeat(600), { limit: 10 });
  assert.equal(res10.findings.length, 10);
  assert.equal(res10.truncated, true);

  const res2 = E.scan('갯수 갯수');
  assert.equal(res2.findings.length, 2);
  assert.equal(res2.truncated, false);

  assert.deepEqual(E.scan('갯수', { limit: 0 }), { findings: [], truncated: true });
});

test('T7 카테고리 필터', () => {
  E.init(synth([cat('convert', [['갯수', '개수']]), cat('spelling', [['타겟', '타깃']])]), ['spelling']);
  assert.deepEqual(srcs(E.scan('갯수 타겟')), ['타겟']);
  // 실데이터: 전 카테고리 OFF면 아무것도 안 잡는다
  const ret = E.init(rulesJson, []);
  assert.equal(ret.activeRules, 0);
  assert.equal(E.scan('갯수를 세어보자').findings.length, 0);
});

test('T8 leftmost-longest·타이브레이크', () => {
  E.init(synth([cat('convert', [['할때', '할 때'], ['할때에', '할 때에']])]), ['convert']);
  let res = E.scan('할때에');
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0].src, '할때에'); // 긴 쪽 우선

  E.init(synth([cat('convert', [['할때에', '할 때에'], ['할때', '할 때']])]), ['convert']);
  res = E.scan('할때에');
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0].src, '할때에'); // 규칙 순서와 무관

  E.init(synth([cat('a', [['갯수', 'A']]), cat('b', [['갯수', 'B']])]), ['a', 'b']);
  assert.equal(E.scan('갯수').findings[0].dst, 'A'); // 같은 길이 → 카테고리 순서

  E.init(synth([cat('a', [['갯수', '먼저'], ['갯수', '나중']])]), ['a']);
  assert.equal(E.scan('갯수').findings[0].dst, '먼저'); // 카테고리 내 규칙 순서
});

test('T9 비중첩·오름차순·slice 일치 (실데이터)', () => {
  initAll();
  const text = '갯수를 셀 때 갯수가 늘어났다. 지금 부터 타겟 고객의 초기 값을 정리해보자. 할때마다 다르다.';
  const { findings } = E.scan(text);
  assert.ok(findings.length >= 3);
  let prevEnd = -1;
  for (const f of findings) {
    assert.ok(f.start >= prevEnd, `겹침/역순: ${JSON.stringify(f)}`);
    assert.ok(f.end > f.start);
    assert.equal(text.slice(f.start, f.end), f.src);
    prevEnd = f.end;
  }
});

test('규칙 필터링: src===dst·공백 src 무시, dst 빈 문자열(삭제 규칙) 허용', () => {
  const ret = E.init(synth([cat('a', [['같다', '같다'], ['   ', 'x'], ['', 'y'], ['반드시 ', '']])]), ['a']);
  assert.equal(ret.activeRules, 1);
  const { findings } = E.scan('반드시 확인');
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0], { start: 0, end: 4, src: '반드시 ', dst: '', cat: 'a' });
});

test('규칙 옵션: rejectBefore/rejectAfter 문맥 예외는 치환 후보보다 우선한다', () => {
  const ret = E.init(synth([cat('a', [
    ['의 수', ' 수', { rejectAfter: ['많'] }],
    ['끔하', '끔 하', { rejectBefore: ['깔'] }]
  ])]), ['a']);
  assert.equal(ret.activeRules, 2);
  assert.equal(E.scan('그의 수많은 예외').findings.length, 0);
  assert.equal(E.scan('목록의 수를 센다').findings.length, 1);
  assert.equal(E.scan('깔끔하게 정리').findings.length, 0);
  assert.equal(E.scan('매끔하게 정리').findings.length, 1);
});

test('실데이터: "의 수많"과 "깔끔하" 부분 문자열 오검출 제외', () => {
  initAll();
  assert.ok(!srcs(E.scan('그의 수많은 조건을 본다')).includes('의 수'));
  assert.ok(srcs(E.scan('목록의 수를 센다')).includes('의 수'));
  assert.ok(!srcs(E.scan('깔끔하게 정리한다')).includes('끔하'));
});

test('실데이터: "많을수록"은 "을수" 규칙으로 오검출하지 않는다', () => {
  initAll();
  assert.ok(!srcs(E.scan('조건이 많을수록 느려진다')).includes('을수'));
  assert.ok(srcs(E.scan('문서를 읽을수 있다')).includes('을수'));
});

test('실데이터: "이 때문"은 "이 때" 규칙으로 오검출하지 않는다', () => {
  initAll();
  assert.ok(!srcs(E.scan('이 때문이라고 볼 수 있다')).includes('이 때'));
  assert.ok(!srcs(E.scan('이 때문에 실패했다')).includes('이 때'));
  assert.ok(srcs(E.scan('이 때 다시 확인한다')).includes('이 때'));
});

test('입력 불변: frozen rulesJson으로 init·scan 정상 동작', () => {
  const rj = deepFreeze(synth([cat('convert', [['갯수', '개수']])]));
  E.init(rj, Object.freeze(['convert']));
  assert.equal(E.scan('갯수').findings.length, 1);
});

test('scan 입력 검증: 문자열 아니면 throw', () => {
  initAll();
  assert.throws(() => E.scan(null));
  assert.throws(() => E.scan(123));
});

test('T10 성능: init 후 100,000자 스캔 ≤ 1500ms', () => {
  const t0 = performance.now();
  initAll();
  const initMs = performance.now() - t0;
  assert.ok(initMs <= 1500, `init ${initMs.toFixed(0)}ms`);

  const base = '이 문서는 오탈자 검사 엔진의 처리 속도를 측정하기 위해 만든 평범한 예시 문장이다. ';
  const parts = [];
  let len = 0;
  let typos = 0;
  while (len < 100000) {
    parts.push(base);
    len += base.length;
    if (parts.length % 40 === 0 && typos < 50) {
      parts.push('갯수를 세어보자. ');
      len += 10;
      typos++;
    }
  }
  assert.equal(typos, 50);
  const text = parts.join('');
  assert.ok(text.length >= 100000);

  const t1 = performance.now();
  const res = E.scan(text, { limit: 1000000 });
  const scanMs = performance.now() - t1;
  assert.ok(scanMs <= 1500, `scan ${scanMs.toFixed(0)}ms (findings ${res.findings.length})`);
  assert.ok(res.findings.filter((f) => f.src === '갯수').length >= 50);
});
