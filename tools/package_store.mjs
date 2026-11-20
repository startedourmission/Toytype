#!/usr/bin/env node
// Toytype — Chrome 웹 스토어 업로드용 zip 만들기
//
//   npm run package:store   →  dist/toytype-<version>.zip
//
// 확장이 실제로 읽는 파일만 담고, 개발용 manifest "key"(로컬 ID 고정용)는 뺀다.
// 스토어가 ID를 따로 발급하므로 key가 있으면 업로드가 거절된다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INCLUDE = [
  'manifest.json',
  'background.js',
  'engine.js',
  'term-consistency.mjs',
  'ai-job-store.mjs',
  'rules.json',
  'popup.html', 'popup.css', 'popup.js',
  'options.html', 'options.css', 'options.js',
  'content',
  'icons',
  'third_party'
];
const SKIP_NAMES = new Set(['.DS_Store', 'icon-1024.png']);

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
delete manifest.key;

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'toytype-store-'));
function copy(rel) {
  const src = path.join(ROOT, rel);
  const dst = path.join(stage, rel);
  if (SKIP_NAMES.has(path.basename(rel))) return;
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) copy(path.join(rel, name));
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}
for (const rel of INCLUDE) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    console.error('빠진 파일: ' + rel);
    process.exit(1);
  }
  copy(rel);
}
fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// 매니페스트가 가리키는 파일이 모두 들어갔는지 확인
const referenced = [
  manifest.background && manifest.background.service_worker,
  manifest.action && manifest.action.default_popup,
  manifest.options_ui && manifest.options_ui.page,
  ...Object.values(manifest.icons || {}),
  ...(manifest.content_scripts || []).flatMap(cs => [...(cs.js || []), ...(cs.css || [])]),
  ...(manifest.web_accessible_resources || []).flatMap(w => w.resources || [])
].filter(Boolean);
const missing = referenced.filter(rel => !fs.existsSync(path.join(stage, rel)));
if (missing.length) {
  console.error('매니페스트가 참조하지만 zip에 없는 파일: ' + missing.join(', '));
  process.exit(1);
}

const outDir = path.join(ROOT, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'toytype-' + manifest.version + '.zip');
fs.rmSync(out, { force: true });
execFileSync('zip', ['-r', '-X', '-q', out, '.'], { cwd: stage, stdio: 'inherit' });
fs.rmSync(stage, { recursive: true, force: true });

const kb = Math.round(fs.statSync(out).size / 1024);
console.log('만들었습니다: ' + path.relative(ROOT, out) + ' (' + kb + ' KB)');
console.log('manifest "key"는 제거했습니다. 대시보드에서 새 항목으로 올리면 스토어 ID가 발급됩니다.');
