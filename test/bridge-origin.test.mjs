import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRequestOrigin } from '../tools/toytype_ai_bridge.mjs';

const req = (host, origin) => ({ headers: origin === undefined ? { host } : { host, origin } });

test('브리지는 확장 출처와 Origin 없는 로컬 도구만 받는다', () => {
  assert.equal(checkRequestOrigin(req('127.0.0.1:17644', 'chrome-extension://gaampopggbpabdfceaappkbkknaikfph')), 'chrome-extension://gaampopggbpabdfceaappkbkknaikfph');
  assert.equal(checkRequestOrigin(req('localhost:17644', 'safari-web-extension://ABCD-1234')), 'safari-web-extension://ABCD-1234');
  assert.equal(checkRequestOrigin(req('127.0.0.1:17644')), null);
});

test('웹페이지 출처와 다른 Host는 거절한다', () => {
  for (const origin of ['https://evil.example', 'http://127.0.0.1:8000', 'null', 'https://docs.google.com']) {
    assert.throws(() => checkRequestOrigin(req('127.0.0.1:17644', origin)), err => err.status === 403);
  }
  assert.throws(() => checkRequestOrigin(req('attacker.example:17644')), err => err.status === 403);
});
