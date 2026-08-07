// content/docs.js의 선택 영역 글자수 집계와 푸터 상태 문구 정리 검증.
// docs.js는 Docs 페이지용 클래식 스크립트라 chrome.*·DOM에 의존하므로,
// 최소 스텁을 깔고 평가한 뒤 globalThis.ToytypeDocsInternal 훅만 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadDocsInternal() {
  const src = readFileSync(new URL('../content/docs.js', import.meta.url), 'utf8');
  const listeners = {
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}
  };
  const el = () => ({
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    appendChild() {}, remove() {}, addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [], attachShadow: () => ({ appendChild() {} }),
    textContent: '', innerHTML: '', children: [], focus() {}
  });
  const sandbox = {
    console,
    setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; },
    clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    chrome: {
      runtime: { getURL: () => '', sendMessage: () => {}, onMessage: listeners, id: 'test' },
      storage: { local: { get: (_k, cb) => cb && cb({}), set() {} }, onChanged: listeners }
    },
    document: Object.assign(el(), {
      createElement: el, getElementById: () => null, readyState: 'complete',
      documentElement: el(), body: el(), title: '', hasFocus: () => true
    }),
    location: { href: 'https://docs.google.com/document/d/TEST/edit', pathname: '/document/d/TEST/edit' },
    navigator: { platform: 'MacIntel', userAgent: 'test', clipboard: { writeText: async () => {} } },
    fetch: async () => ({ ok: false, text: async () => '' }),
    MutationObserver: class { observe() {} disconnect() {} },
    getSelection: () => null,
    performance: { now: () => 0 },
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    Event: class {}, KeyboardEvent: class {}, MouseEvent: class {},
    addEventListener() {}, removeEventListener() {}, postMessage() {}
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'content/docs.js' });
  const internal = sandbox.ToytypeDocsInternal;
  assert.ok(internal, 'ToytypeDocsInternal 훅이 노출되어야 한다');
  return internal;
}

const I = loadDocsInternal();

test('선택 글자수: 공백 포함/제외와 단어 수를 함께 센다', () => {
  const s = I.countTextStats('안녕 하세요 반갑습니다');
  assert.equal(s.chars, 12);
  assert.equal(s.charsNoSpace, 10);
  assert.equal(s.words, 3);
});

test('선택 글자수: 줄바꿈과 탭도 공백으로 본다', () => {
  const s = I.countTextStats('첫 줄\n둘째\t줄');
  assert.equal(s.chars, 8);
  assert.equal(s.charsNoSpace, 5);
  assert.equal(s.words, 4);
});

test('선택 글자수: 이모지 서로게이트 쌍을 한 글자로 센다', () => {
  const s = I.countTextStats('감사🙏');
  assert.equal(s.chars, 3);
  assert.equal(s.charsNoSpace, 3);
  assert.equal(s.words, 1);
});

test('선택 글자수: 앞뒤 공백만 있으면 단어 수는 0이다', () => {
  const s = I.countTextStats('   \n  ');
  assert.equal(s.chars, 6);
  assert.equal(s.charsNoSpace, 0);
  assert.equal(s.words, 0);
});

test('선택 글자수: 빈 문자열은 모두 0이다', () => {
  const s = I.countTextStats('');
  assert.equal(s.chars, 0);
  assert.equal(s.charsNoSpace, 0);
  assert.equal(s.words, 0);
});

test('선택 구간 잘라내기: 오프셋대로 본문을 자른다', () => {
  assert.equal(I.sliceSelectedText('가나다라마', [{ start: 1, end: 4 }]), '나다라');
});

test('선택 구간 잘라내기: 역방향 드래그도 정방향으로 본다', () => {
  assert.equal(I.sliceSelectedText('가나다라마', [{ start: 4, end: 1 }]), '나다라');
});

test('선택 구간 잘라내기: 접힌 커서는 선택이 아니다', () => {
  assert.equal(I.sliceSelectedText('가나다라마', [{ start: 2, end: 2 }]), '');
});

test('선택 구간 잘라내기: 본문 길이를 넘는 오프셋은 세지 않는다', () => {
  assert.equal(I.sliceSelectedText('가나다', [{ start: 0, end: 99 }]), '');
});

test('선택 구간 잘라내기: 선택 정보가 없으면 빈 문자열이다', () => {
  assert.equal(I.sliceSelectedText('가나다', null), '');
  assert.equal(I.sliceSelectedText('가나다', []), '');
  assert.equal(I.sliceSelectedText(null, [{ start: 0, end: 2 }]), '');
});

test('푸터 상태: 상세가 요약을 되풀이하면 앞머리를 잘라낸다', () => {
  assert.equal(
    I.stripStatusHeadEcho('AI 교정 완료 · JSON 업로드됨: 12건', 'AI 교정 완료'),
    'JSON 업로드됨: 12건'
  );
});

test('푸터 상태: 상세가 요약과 똑같으면 비운다', () => {
  assert.equal(I.stripStatusHeadEcho('AI 교정 완료', 'AI 교정 완료'), '');
});

test('푸터 상태: 겹치지 않는 상세는 그대로 둔다', () => {
  assert.equal(I.stripStatusHeadEcho('본문 읽는 중', 'AI 교정 중'), '본문 읽는 중');
});

test('푸터 상태: 빈 상세는 빈 문자열로 정규화한다', () => {
  assert.equal(I.stripStatusHeadEcho('', 'AI 교정 중'), '');
  assert.equal(I.stripStatusHeadEcho('   ', 'AI 교정 중'), '');
  assert.equal(I.stripStatusHeadEcho(null, 'AI 교정 중'), '');
});
