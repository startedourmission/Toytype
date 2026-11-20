#!/usr/bin/env node
// Toytype 자체 사전(rules.json) 관리 도구 — rules.json이 정본이다.
//
//   node tools/rules_tool.mjs check    문제 검사 (오류가 있으면 종료 코드 1)
//   node tools/rules_tool.mjs format   한 줄에 규칙 하나 형식으로 다시 쓰고 version을 오늘 날짜로
//   node tools/rules_tool.mjs stats    카테고리별 규칙 수
//
// 규칙 한 줄: ["오기", "교정"] 또는 ["오기", "교정", {옵션}]
//   옵션: rejectBefore / rejectAfter (문자열 또는 문자열 배열), allowCodeToken (true)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RULES_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'rules.json');
const OPTION_KEYS = new Set(['rejectBefore', 'rejectAfter', 'allowCodeToken']);
// 탭·줄바꿈 외의 제어문자, 제로폭 문자, BOM
const BAD_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f​-‍⁠﻿]/;

function isStringList(v) {
  return typeof v === 'string' || (Array.isArray(v) && v.every(x => typeof x === 'string'));
}

export function lintRules(data) {
  const errors = [];
  const warnings = [];
  if (!data || !Array.isArray(data.categories)) {
    errors.push('categories 배열이 없습니다');
    return { errors, warnings };
  }
  const catIds = new Set();
  const bySrc = new Map(); // src -> [{cat, dst}]
  for (const cat of data.categories) {
    if (!cat || typeof cat.id !== 'string') { errors.push('id 없는 카테고리'); continue; }
    if (catIds.has(cat.id)) errors.push(`카테고리 id 중복: ${cat.id}`);
    catIds.add(cat.id);
    if (!Array.isArray(cat.rules)) { errors.push(`${cat.id}: rules 배열이 없습니다`); continue; }
    const seen = new Set();
    cat.rules.forEach((rule, i) => {
      const at = `${cat.id}#${i + 1}`;
      if (!Array.isArray(rule) || rule.length < 2 || rule.length > 3 ||
          typeof rule[0] !== 'string' || typeof rule[1] !== 'string') {
        errors.push(`${at}: 형식 오류 ${JSON.stringify(rule)}`);
        return;
      }
      const [src, dst, opts] = rule;
      const show = `${at} ${JSON.stringify(src)}→${JSON.stringify(dst)}`;
      if (src.trim() === '') errors.push(`${show}: 오기가 비어 있음`);
      if (src === dst) errors.push(`${show}: 오기와 교정이 같음`);
      if (BAD_CHARS.test(src) || BAD_CHARS.test(dst)) errors.push(`${show}: 제어문자·제로폭 문자 포함`);
      if (rule.length === 3) {
        if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
          errors.push(`${show}: 옵션은 객체여야 함`);
        } else {
          for (const k of Object.keys(opts)) {
            if (!OPTION_KEYS.has(k)) errors.push(`${show}: 알 수 없는 옵션 ${k}`);
          }
          if ('rejectBefore' in opts && !isStringList(opts.rejectBefore)) errors.push(`${show}: rejectBefore 형식 오류`);
          if ('rejectAfter' in opts && !isStringList(opts.rejectAfter)) errors.push(`${show}: rejectAfter 형식 오류`);
          if ('allowCodeToken' in opts && opts.allowCodeToken !== true) errors.push(`${show}: allowCodeToken은 true만 허용`);
        }
      }
      const key = src + '\u0001' + dst;
      if (seen.has(key)) errors.push(`${show}: 같은 카테고리 안 중복`);
      seen.add(key);
      if (dst === ' ' + src) warnings.push(`${show}: 앞 공백 삽입형 — 엔진이 무시하는 규칙`);
      if (!bySrc.has(src)) bySrc.set(src, []);
      bySrc.get(src).push({ cat: cat.id, dst });
    });
  }
  // 카테고리 사이 충돌: 같은 오기를 서로 다르게 고침 / A→B 와 B→A
  for (const [src, list] of bySrc) {
    const dsts = new Set(list.map(x => x.dst));
    if (dsts.size > 1) {
      warnings.push(`${JSON.stringify(src)}: 교정이 여러 개 — ${list.map(x => `${x.cat}:${JSON.stringify(x.dst)}`).join(', ')}`);
    }
    for (const { cat, dst } of list) {
      const back = bySrc.get(dst);
      if (back && back.some(b => b.dst === src)) {
        if (src < dst) errors.push(`서로 되돌리는 규칙: ${JSON.stringify(src)}↔${JSON.stringify(dst)} (${cat})`);
      }
    }
  }
  return { errors, warnings };
}

// 한 줄에 규칙 하나. diff와 손 편집이 쉽도록 한다.
export function formatRules(data) {
  const lines = ['{'];
  lines.push(`  "version": ${JSON.stringify(data.version)},`);
  lines.push('  "categories": [');
  data.categories.forEach((cat, ci) => {
    lines.push('    {');
    lines.push(`      "id": ${JSON.stringify(cat.id)},`);
    lines.push(`      "label": ${JSON.stringify(cat.label)},`);
    lines.push(`      "defaultOn": ${JSON.stringify(cat.defaultOn !== false)},`);
    lines.push('      "rules": [');
    cat.rules.forEach((rule, ri) => {
      lines.push('        ' + JSON.stringify(rule) + (ri < cat.rules.length - 1 ? ',' : ''));
    });
    lines.push('      ]');
    lines.push('    }' + (ci < data.categories.length - 1 ? ',' : ''));
  });
  lines.push('  ]');
  lines.push('}');
  return lines.join('\n') + '\n';
}

function load() {
  return JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
}

function main(cmd) {
  const data = load();
  if (cmd === 'check') {
    const { errors, warnings } = lintRules(data);
    for (const w of warnings) console.log('경고  ' + w);
    for (const e of errors) console.log('오류  ' + e);
    console.log(`\n오류 ${errors.length}건 · 경고 ${warnings.length}건`);
    process.exit(errors.length ? 1 : 0);
  } else if (cmd === 'format') {
    const { errors } = lintRules(data);
    if (errors.length) {
      console.error(`오류 ${errors.length}건이 있어 저장하지 않았습니다. check로 확인하세요.`);
      process.exit(1);
    }
    const out = {
      version: new Date().toISOString().slice(0, 10),
      categories: data.categories
    };
    fs.writeFileSync(RULES_PATH, formatRules(out));
    console.log('rules.json 정리 완료 · version ' + out.version);
  } else if (cmd === 'stats') {
    let total = 0;
    for (const cat of data.categories) {
      total += cat.rules.length;
      console.log(`${cat.id.padEnd(10)} ${String(cat.rules.length).padStart(5)}  ${cat.label}`);
    }
    console.log(`${'합계'.padEnd(9)} ${String(total).padStart(5)}`);
  } else {
    console.log('사용법: node tools/rules_tool.mjs <check|format|stats>');
    process.exit(cmd ? 1 : 0);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]);
}
