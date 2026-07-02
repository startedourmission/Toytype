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

test('실데이터: 살펴 보/살펴 봅 붙여쓰기', () => {
  initAll();
  assert.ok(srcs(E.scan('코드를 살펴 보자')).includes('살펴 보'));

  const f = E.scan('예제를 살펴 봅니다').findings.find((x) => x.src === '살펴 봅');
  assert.ok(f, "'살펴 봅' 미검출");
  assert.equal(f.dst, '살펴봅');
});

test('실데이터: 따라가는 붙여 쓰고 따라 가만 잡는다', () => {
  initAll();
  assert.ok(!srcs(E.scan('문맥을 따라가 보자')).includes('따라가'));

  const f = E.scan('문맥을 따라 가자').findings.find((x) => x.src === '따라 가');
  assert.ok(f, "'따라 가' 미검출");
  assert.equal(f.dst, '따라가');
});

test('실데이터: 기록하고는 붙여 쓰고 기록 하고만 잡는다', () => {
  initAll();
  assert.ok(!srcs(E.scan('내용을 기록하고 저장한다')).includes('록하고'));
  assert.ok(!srcs(E.scan('자료를 등록하고 수록하고 마친다')).includes('록하고'));

  const f = E.scan('내용을 기록 하고 저장한다').findings.find((x) => x.src === '기록 하고');
  assert.ok(f, "'기록 하고' 미검출");
  assert.equal(f.dst, '기록하고');
});

test('실데이터: 단독 서브는 하위로 바꾸지 않는다', () => {
  initAll();
  assert.ok(!srcs(E.scan('서브 명령을 실행한다')).includes('서브'));

  const f = E.scan('서브패키지를 확인한다').findings.find((x) => x.src === '서브패키지');
  assert.ok(f, "'서브패키지' 미검출");
  assert.equal(f.dst, '서브 패키지');
});

test('실데이터: 자격 증명은 자격증명으로 붙이지 않는다', () => {
  initAll();
  assert.ok(!srcs(E.scan('자격 증명을 설정한다')).includes('자격 증명'));
});

test('실데이터: 요청 제거 룰은 더 이상 잡지 않는다', () => {
  initAll();
  const findings = E.scan('이것입니다. 이것 입니다. 되어 줄 수 있다. 스크린샷. 하지만, 계속한다. 텍스트: 예시. 결과: 성공. 코드: 0. 예제: 입력. 예: 출력. 페이지: 1').findings;
  assert.ok(!findings.some((x) => x.src === '것입니다' && x.dst === '겁니다'));
  assert.ok(!findings.some((x) => x.src === '것 입니다' && x.dst === '겁니다'));
  assert.ok(!findings.some((x) => x.src === '되어 줄' && x.dst === '되어줄'));
  assert.ok(!findings.some((x) => x.src === '스크린샷' && x.dst === '스크린숏'));
  assert.ok(!findings.some((x) => x.src === '하지만,' && x.dst === '하지만'));
  assert.ok(!findings.some((x) => x.src === '텍스트:' && x.dst === '텍스트 :'));
  assert.ok(!findings.some((x) => x.src.endsWith(':') && x.dst === x.src.replace(/:$/, ' :')));
});

test('실데이터: 포맷팅은 포매팅으로만 통일한다', () => {
  initAll();
  const f = E.scan('출력 포맷팅을 조정한다').findings.find((x) => x.src === '포맷팅');
  assert.ok(f, "'포맷팅' 미검출");
  assert.equal(f.dst, '포매팅');
  assert.ok(!srcs(E.scan('출력 포매팅을 조정한다')).includes('포매팅'));
});

test('실데이터: 운영체제 표기는 macOS·리눅스·윈도우로 통일', () => {
  initAll();
  assert.equal(E.scan('macOS에서 실행한다').findings.length, 0);
  assert.equal(E.scan('리눅스Linux와 윈도우Windows를 병기한다').findings.length, 0);
  assert.equal(E.scan('Linux리눅스와 Windows윈도우를 병기한다').findings.length, 0);

  let f = E.scan('맥 OS X에서 실행한다').findings.find((x) => x.src === '맥 OS X');
  assert.ok(f, "'맥 OS X' 미검출");
  assert.equal(f.dst, 'macOS');

  f = E.scan('Linux에서 실행한다').findings.find((x) => x.src === 'Linux');
  assert.ok(f, "'Linux' 미검출");
  assert.equal(f.dst, '리눅스');

  f = E.scan('리눅스(Linux)를 지원한다').findings.find((x) => x.src === 'Linux');
  assert.ok(f, "괄호 병기 'Linux' 미검출");
  assert.equal(f.dst, '리눅스');

  f = E.scan('Windows에서 실행한다').findings.find((x) => x.src === 'Windows');
  assert.ok(f, "'Windows' 미검출");
  assert.equal(f.dst, '윈도우');

  f = E.scan('윈도우즈 환경').findings.find((x) => x.src === '윈도우즈');
  assert.ok(f, "'윈도우즈' 미검출");
  assert.equal(f.dst, '윈도우');
});

test('실데이터: 동글뱅이 숫자는 앞뒤 띄어쓰기를 잡지 않는다', () => {
  initAll();
  assert.equal(E.scan('➌에서 테스트를 작성했다').findings.length, 0);
  assert.equal(E.scan('➍에서 확인한다').findings.length, 0);
  assert.equal(E.scan('➊ 클릭하고 ➋ 에서 확인한다').findings.length, 0);
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
  // 선두 공백 추가형(dst=" "+src)은 엔진이 어차피 비활성화하는 죽은 규칙이라 실데이터에서 제거됐다.
  // (엔진의 제외 동작 자체는 위 "파이프라인 규칙 제외 (합성)" 테스트가 보증한다.)
  for (const c of rulesJson.categories) {
    assert.ok(!c.rules.some(([s, d]) => d === ' ' + s), `${c.id}에 죽은 선두 공백 추가형 규칙이 남아 있음`);
  }
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
