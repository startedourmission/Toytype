// content/docs.js의 단락 스타일 셋팅 정리 로직 검증.
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
const TEMP = I.STYLE_PRESET_TEMP_TEXT;

function harness({ text, onBackspace, onUndo }) {
  const calls = { backspace: 0, undo: 0, selections: [] };
  let current = text;
  const deps = {
    getText: async () => current,
    selectRange: async (start, end) => { calls.selections.push([start, end]); },
    backspace: async () => { calls.backspace++; if (onBackspace) current = onBackspace(current, calls.backspace); },
    undo: async () => { calls.undo++; if (onUndo) current = onUndo(current, calls.undo); },
    delay: async () => {}
  };
  return { deps, calls, text: () => current };
}

test('임시 텍스트가 없으면 아무 조작도 하지 않는다', async () => {
  const h = harness({ text: '깨끗한 본문입니다.' });
  assert.equal(await I.removeStylePresetTempText({ enterCreated: true }, h.deps), true);
  assert.equal(h.calls.backspace, 0);
  assert.equal(h.calls.undo, 0);
});

test('Backspace가 성공하면 실행취소를 보내지 않는다', async () => {
  const h = harness({ text: '본문입니다.\n' + TEMP, onBackspace: () => '본문입니다.' });
  assert.equal(await I.removeStylePresetTempText({ enterCreated: true }, h.deps), true);
  assert.equal(h.calls.backspace, 1);
  assert.equal(h.calls.undo, 0, '실행취소는 최후 수단이라 호출되면 안 된다');
});

test('enterCreated면 앞 개행까지 선택 범위에 포함한다', async () => {
  const body = '본문입니다.';
  const h = harness({ text: body + '\n' + TEMP, onBackspace: () => body });
  await I.removeStylePresetTempText({ enterCreated: true }, h.deps);
  assert.deepEqual(h.calls.selections[0], [body.length, body.length + 1 + TEMP.length]);
});

test('enterCreated가 아니면 개행을 지우지 않는다', async () => {
  const body = '본문입니다.';
  const h = harness({ text: body + '\n' + TEMP, onBackspace: () => body + '\n' });
  await I.removeStylePresetTempText({ enterCreated: false }, h.deps);
  assert.deepEqual(h.calls.selections[0], [body.length + 1, body.length + 1 + TEMP.length]);
});

test('Backspace가 듣지 않으면 실행취소로 복구한다', async () => {
  const h = harness({ text: '본문입니다.\n' + TEMP, onUndo: () => '본문입니다.' });
  assert.equal(await I.removeStylePresetTempText({ enterCreated: true }, h.deps), true);
  assert.equal(h.calls.backspace, I.STYLE_PRESET_CLEANUP_ATTEMPTS, '먼저 Backspace를 상한까지 시도한다');
  assert.equal(h.calls.undo, 1);
});

test('실행취소는 임시 텍스트가 사라지는 즉시 멈춘다 — 사용자 편집 보호', async () => {
  // 2번째 실행취소에서 사라지고, 그 뒤로는 사용자 편집이 남아 있다.
  const history = ['사용자편집3', '사용자편집2', '사용자편집1'];
  const h = harness({
    text: '사용자편집3\n' + TEMP,
    onUndo: (_cur, n) => (n >= 2 ? history[Math.min(n - 2, history.length - 1)] : '사용자편집3\n' + TEMP)
  });
  assert.equal(await I.removeStylePresetTempText({ enterCreated: true }, h.deps), true);
  assert.equal(h.calls.undo, 2, '필요한 만큼만 실행취소해야 한다');
  assert.equal(h.text(), '사용자편집3', '사용자 편집을 더 되돌리면 안 된다');
});

test('복구 불가하면 상한까지만 시도하고 false를 돌려준다', async () => {
  const h = harness({ text: '본문입니다.\n' + TEMP });   // 아무것도 텍스트를 바꾸지 않음
  assert.equal(await I.removeStylePresetTempText({ enterCreated: true }, h.deps), false);
  assert.equal(h.calls.undo, I.STYLE_PRESET_UNDO_ATTEMPTS);
});

test('실패 문구는 stylePresetOp 접두어를 떼고 사용자에게 보여준다', () => {
  assert.equal(
    I.styleShortErrorText(new Error('stylePresetOp menu failed: 스타일 메뉴가 열리지 않았습니다')),
    '스타일 메뉴가 열리지 않았습니다'
  );
  assert.equal(I.styleShortErrorText(new Error('')), '알 수 없는 오류 · 콘솔 확인');
  assert.equal(I.styleShortErrorText(null), '알 수 없는 오류 · 콘솔 확인');
  assert.ok(I.styleShortErrorText(new Error('가'.repeat(200))).endsWith('…'), '긴 메시지는 잘라야 한다');
});
