import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { parseCliArgs } from '../tools/toytype_native_host.mjs';

test('LaunchAgent CLI accepts supported actions and rejects invalid ports before side effects', () => {
  assert.deepEqual(parseCliArgs(['--connect']), { action: 'connect', port: 17644 });
  assert.deepEqual(parseCliArgs(['--status', '--port', '18000']), { action: 'status', port: 18000 });
  assert.deepEqual(parseCliArgs(['--disconnect']), { action: 'disconnect', port: 17644 });
  for (const args of [[], ['--unknown'], ['--connect', '--port'], ['--connect', '--port', '0'],
    ['--connect', '--port', '65536'], ['--connect', '--port', '1.5'], ['--connect', '--port', 'abc']]) {
    assert.throws(() => parseCliArgs(args));
  }
});

test('Chrome origin argument still selects the framed native messaging protocol', () => {
  const result = spawnSync(process.execPath, [
    new URL('../tools/toytype_native_host.mjs', import.meta.url).pathname,
    'chrome-extension://test/'
  ], { input: Buffer.alloc(0), encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

function popup(protocol, healthy = false) {
  let nativeCalls = 0;
  const context = vm.createContext({
    document: { getElementById: () => ({}) },
    setTimeout: () => 0,
    chrome: { runtime: {
      getURL: () => protocol + '//test/',
      sendMessage: async () => healthy
        ? { ok: true, port: 18000, version: '1.0.0' }
        : { ok: false, error: 'bridge_unavailable' },
      sendNativeMessage: (_host, _message, callback) => {
        nativeCalls++;
        callback({ ok: true, alreadyRunning: true });
      }
    } }
  });
  const source = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
  vm.runInContext(source.replace(/\ninit\(\);\s*$/, ''), context);
  vm.runInContext(`
    render = () => {};
    settings = { externalFeaturesEnabled: true };
    ai.bridgeUrl = 'http://127.0.0.1:18000';
  `, context);
  return { run: code => vm.runInContext(code, context), nativeCalls: () => nativeCalls };
}

test('Safari shows the LaunchAgent command without calling the Chrome native host', async () => {
  const p = popup('safari-web-extension:');
  await p.run('connectBridge()');
  assert.equal(p.nativeCalls(), 0);
  assert.equal(p.run('bridgeState.state'), 'error');
  assert.equal(p.run('nativeHostReady'), false);
  assert.equal(p.run('nativeHostInstallCommand()'), 'node tools/toytype_native_host.mjs --connect --port 18000');
  assert.match(p.run('statusText'), /Safari/);
});

test('Safari reconnects to an existing HTTP bridge without native messaging', async () => {
  const p = popup('safari-web-extension:', true);
  await p.run('connectBridge()');
  assert.equal(p.run('bridgeState.state'), 'ok');
  assert.equal(p.nativeCalls(), 0);
});

test('Chrome keeps native host startup', async () => {
  const p = popup('chrome-extension:', true);
  await p.run('connectBridge()');
  assert.equal(p.nativeCalls(), 1);
  assert.equal(p.run('bridgeState.state'), 'ok');
  assert.equal(p.run('nativeHostInstallCommand()'), 'node tools/install_native_host.mjs');
});
