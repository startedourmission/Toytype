#!/usr/bin/env node
// Toytype — 네이티브 메시징 호스트 1회 설치
// 이걸 한 번 돌려 두면, 이후로는 확장 팝업의 [연결] 버튼만으로 브리지가 뜬다.
//
//   node tools/install_native_host.mjs
//   node tools/install_native_host.mjs --uninstall
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOST_NAME = 'com.toytype.bridge_host';
const HOST_SCRIPT = path.join(TOOL_DIR, 'toytype_native_host.mjs');
const LAUNCHER_PATH = path.join(TOOL_DIR, 'toytype_native_host.sh');
const EXTENSION_ID = 'gaampopggbpabdfceaappkbkknaikfph';

// Chrome 계열마다 호스트 매니페스트를 읽는 위치가 다르다.
const TARGET_DIRS = [
  ['Chrome', 'Google/Chrome/NativeMessagingHosts'],
  ['Chrome Beta', 'Google/Chrome Beta/NativeMessagingHosts'],
  ['Chrome Canary', 'Google/Chrome Canary/NativeMessagingHosts'],
  ['Chromium', 'Chromium/NativeMessagingHosts'],
  ['Edge', 'Microsoft Edge/NativeMessagingHosts'],
  ['Brave', 'BraveSoftware/Brave-Browser/NativeMessagingHosts']
];

function manifestPathFor(relative) {
  return path.join(os.homedir(), 'Library', 'Application Support', relative, HOST_NAME + '.json');
}

// Chrome은 호스트를 셸 없이 실행하므로 node 절대 경로를 박은 런처가 필요하다.
function writeLauncher() {
  const script = [
    '#!/bin/sh',
    '# Toytype 네이티브 호스트 런처 — 설치 시점의 node 경로를 고정한다.',
    'exec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(HOST_SCRIPT) + ' "$@"',
    ''
  ].join('\n');
  fs.writeFileSync(LAUNCHER_PATH, script, { mode: 0o755 });
  fs.chmodSync(LAUNCHER_PATH, 0o755);
}

function install() {
  if (!fs.existsSync(HOST_SCRIPT)) {
    console.error('호스트 스크립트를 찾지 못했습니다: ' + HOST_SCRIPT);
    process.exit(1);
  }
  writeLauncher();

  const manifest = {
    name: HOST_NAME,
    description: 'Toytype local AI bridge launcher',
    path: LAUNCHER_PATH,
    type: 'stdio',
    allowed_origins: ['chrome-extension://' + EXTENSION_ID + '/']
  };

  const installed = [];
  for (const [label, relative] of TARGET_DIRS) {
    const target = manifestPathFor(relative);
    const parent = path.dirname(target);
    // 그 브라우저를 안 쓰면 상위 폴더가 없다 — 굳이 만들지 않는다.
    if (!fs.existsSync(path.dirname(parent))) continue;
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    installed.push(label + ': ' + target);
  }

  if (installed.length === 0) {
    console.error('설치할 브라우저 프로필을 찾지 못했습니다.');
    process.exit(1);
  }

  console.log('Toytype 네이티브 호스트를 설치했습니다.');
  console.log('  node: ' + process.execPath);
  console.log('  런처: ' + LAUNCHER_PATH);
  for (const line of installed) console.log('  ' + line);
  console.log('');
  console.log('확장 ID: ' + EXTENSION_ID);
  console.log('다음: Chrome에서 확장을 새로고침한 뒤, 툴바 팝업에서 [연결]을 누르세요.');
}

function uninstall() {
  const removed = [];
  for (const [label, relative] of TARGET_DIRS) {
    const target = manifestPathFor(relative);
    try {
      fs.unlinkSync(target);
      removed.push(label);
    } catch (_) { /* 없으면 넘어간다 */ }
  }
  try { fs.unlinkSync(LAUNCHER_PATH); } catch (_) {}
  console.log(removed.length ? '호스트 매니페스트를 제거했습니다: ' + removed.join(', ') : '제거할 매니페스트가 없습니다.');
  console.log('브리지 상주도 끄려면 팝업에서 [상주 끄기]를 누르거나:');
  console.log('  launchctl bootout gui/' + process.getuid() + '/com.toytype.aibridge');
}

if (process.argv.includes('--uninstall')) uninstall();
else install();
