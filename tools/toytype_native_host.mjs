#!/usr/bin/env node
// Toytype — Chrome 네이티브 메시징 호스트
// 확장은 로컬 프로세스를 직접 띄울 수 없다. 이 호스트가 그 역할을 대신해서
// 팝업의 [연결] 한 번으로 브리지를 상주(LaunchAgent)로 올리고 상태를 돌려준다.
//
// 프로토콜: stdin/stdout에 리틀엔디안 uint32 길이 + UTF-8 JSON 본문.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.dirname(TOOL_DIR);
const BRIDGE_PATH = path.join(TOOL_DIR, 'toytype_ai_bridge.mjs');
const LABEL = 'com.toytype.aibridge';
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', LABEL + '.plist');
const LOG_DIR = path.join(os.homedir(), '.toytype', 'logs');
const DEFAULT_PORT = 17644;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

// launchd는 로그인 셸 PATH를 물려받지 않는다. codex/claude/grok을 찾으려면
// 우리가 직접 넣어 줘야 한다 — 브리지가 CLI를 spawn할 때 쓰는 경로다.
function bridgePath() {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local/bin'),
    path.join(home, '.npm-global/bin'),
    path.join(home, '.grok/bin'),
    path.join(home, '.bun/bin'),
    path.join(home, 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ];
  const seen = new Set();
  const parts = [];
  for (const dir of candidates) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    parts.push(dir);
  }
  // 호스트를 띄운 셸 PATH도 뒤에 붙여 둔다 — 위 목록에 없는 설치 경로 대비.
  for (const dir of String(process.env.PATH || '').split(':')) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    parts.push(dir);
  }
  return parts.join(':');
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildPlist(port) {
  const env = {
    HOME: os.homedir(),
    PATH: bridgePath(),
    TOYTYPE_AI_BRIDGE_PORT: String(port)
  };
  const envXml = Object.entries(env)
    .map(([k, v]) => `    <key>${escapeXml(k)}</key><string>${escapeXml(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(BRIDGE_PATH)}</string>
    <string>--port</string><string>${port}</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(REPO_DIR)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${escapeXml(path.join(LOG_DIR, 'bridge.log'))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(path.join(LOG_DIR, 'bridge.log'))}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
</dict>
</plist>
`;
}

function launchctl(args) {
  const res = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  return {
    ok: res.status === 0,
    status: res.status,
    stderr: String(res.stderr || '').trim()
  };
}

function serviceTarget() {
  return 'gui/' + process.getuid() + '/' + LABEL;
}

function isLoaded() {
  return launchctl(['print', serviceTarget()]).ok;
}

function probeHealth(port, timeoutMs = 1500) {
  return new Promise(resolve => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/health', timeout: timeoutMs },
      res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (_) {
            resolve(null);
          }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function waitForHealth(port, totalMs = 12000) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    const health = await probeHealth(port);
    if (health && health.ok) return health;
    await new Promise(r => setTimeout(r, 350));
  }
  return null;
}

// 이미 떠 있으면 아무것도 하지 않는다. 그 외에는 plist를 새로 쓰고 부팅한다.
async function connect(port) {
  const running = await probeHealth(port);
  if (running && running.ok) {
    return { ok: true, alreadyRunning: true, installed: fs.existsSync(PLIST_PATH), health: running, port };
  }

  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(PLIST_PATH, buildPlist(port), 'utf8');

  // 설정이 바뀌었을 수 있으니 항상 내렸다가 다시 올린다.
  if (isLoaded()) launchctl(['bootout', serviceTarget()]);
  const boot = launchctl(['bootstrap', 'gui/' + process.getuid(), PLIST_PATH]);
  if (!boot.ok && !isLoaded()) {
    return { ok: false, error: 'bootstrap_failed', message: boot.stderr || ('launchctl exit ' + boot.status), plistPath: PLIST_PATH };
  }
  launchctl(['kickstart', serviceTarget()]);

  const health = await waitForHealth(port);
  if (!health) {
    return { ok: false, error: 'bridge_not_responding', message: '브리지가 시작되었지만 응답이 없습니다.', logPath: path.join(LOG_DIR, 'bridge.log'), plistPath: PLIST_PATH };
  }
  return { ok: true, alreadyRunning: false, installed: true, health, port, plistPath: PLIST_PATH };
}

async function status(port) {
  const health = await probeHealth(port);
  return {
    ok: true,
    running: !!(health && health.ok),
    installed: fs.existsSync(PLIST_PATH),
    loaded: isLoaded(),
    health: health || null,
    port
  };
}

// 상주를 그만두고 싶을 때 — plist까지 지워서 다음 로그인에 다시 뜨지 않게 한다.
function disconnect() {
  if (isLoaded()) launchctl(['bootout', serviceTarget()]);
  let removed = false;
  try {
    fs.unlinkSync(PLIST_PATH);
    removed = true;
  } catch (_) { /* 원래 없었으면 그대로 성공 */ }
  return { ok: true, removed, loaded: isLoaded() };
}

async function handle(message) {
  const action = message && typeof message.action === 'string' ? message.action : '';
  const rawPort = Number(message && message.port);
  const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : DEFAULT_PORT;
  if (action === 'connect') return connect(port);
  if (action === 'status') return status(port);
  if (action === 'disconnect') return disconnect();
  if (action === 'ping') return { ok: true, pong: true, node: process.version, bridgePath: BRIDGE_PATH };
  return { ok: false, error: 'unknown_action', action };
}

function writeMessage(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function main() {
  let buffer = Buffer.alloc(0);
  let expected = null;

  process.stdin.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (expected === null) {
        if (buffer.length < 4) return;
        expected = buffer.readUInt32LE(0);
        buffer = buffer.subarray(4);
        if (expected > MAX_MESSAGE_BYTES) {
          writeMessage({ ok: false, error: 'message_too_large' });
          process.exit(1);
        }
      }
      if (buffer.length < expected) return;
      const body = buffer.subarray(0, expected);
      buffer = buffer.subarray(expected);
      expected = null;
      let message = null;
      try {
        message = JSON.parse(body.toString('utf8'));
      } catch (error) {
        writeMessage({ ok: false, error: 'invalid_json' });
        continue;
      }
      handle(message).then(writeMessage, error => {
        writeMessage({ ok: false, error: 'host_failed', message: error && error.message ? error.message : String(error) });
      });
    }
  });

  process.stdin.on('end', () => { process.exit(0); });
}

main();
