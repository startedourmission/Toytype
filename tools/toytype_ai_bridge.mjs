#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = Number(process.env.TOYTYPE_AI_BRIDGE_PORT || 17644);
const MAX_BODY_BYTES = 50 * 1024 * 1024;
const VERSION = '1.0.0';
const BRIDGE_FILE = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(BRIDGE_FILE), '..');
const BUILTIN_RULES_PATH = path.join(PROJECT_ROOT, 'rules.json');
let activePort = DEFAULT_PORT;
let builtinRulesReferenceCache = null;

const DEFAULT_SETTINGS = {
  provider: 'codex',
  codexCommand: 'codex',
  claudeCommand: 'claude',
  workspaceDir: '~/Dev/Toytype',
  outputDir: '~/.toytype/generated',
  requestTimeoutMs: 10 * 60 * 1000,
  maxDocumentChars: 180000
};

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function expandHome(value) {
  if (typeof value !== 'string' || value === '') return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function mergeSettings(input) {
  const s = input && typeof input === 'object' ? input : {};
  const provider = s.provider === 'claude' ? 'claude' : 'codex';
  return {
    provider,
    codexCommand: typeof s.codexCommand === 'string' && s.codexCommand.trim() ? s.codexCommand.trim() : DEFAULT_SETTINGS.codexCommand,
    claudeCommand: typeof s.claudeCommand === 'string' && s.claudeCommand.trim() ? s.claudeCommand.trim() : DEFAULT_SETTINGS.claudeCommand,
    workspaceDir: expandHome(typeof s.workspaceDir === 'string' && s.workspaceDir.trim() ? s.workspaceDir.trim() : DEFAULT_SETTINGS.workspaceDir),
    outputDir: expandHome(typeof s.outputDir === 'string' && s.outputDir.trim() ? s.outputDir.trim() : DEFAULT_SETTINGS.outputDir),
    requestTimeoutMs: clampNumber(s.requestTimeoutMs, DEFAULT_SETTINGS.requestTimeoutMs, 5000, 60 * 60 * 1000),
    maxDocumentChars: clampNumber(s.maxDocumentChars, DEFAULT_SETTINGS.maxDocumentChars, 1000, 1000000)
  };
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parseCommand(command) {
  const input = String(command || '').trim();
  if (!input) return [];
  const parts = [];
  let cur = '';
  let quote = null;
  let escaped = false;
  for (const ch of input) {
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        parts.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (quote) throw new HttpError(400, 'command has an unterminated quote');
  if (escaped) cur += '\\';
  if (cur) parts.push(cur);
  return parts;
}

function locateCommand(commandSpec) {
  try {
    const parts = parseCommand(commandSpec);
    if (!parts.length) return { available: false, path: '', error: 'empty command' };
    const command = expandHome(parts[0]);
    if (command.includes('/')) {
      fs.accessSync(command, fs.constants.X_OK);
      return { available: true, path: command, error: '' };
    }
    const result = spawnSync('which', [command], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout.trim()) {
      return { available: true, path: result.stdout.trim().split(/\r?\n/)[0], error: '' };
    }
    return { available: false, path: '', error: (result.stderr || 'not found').trim() };
  } catch (error) {
    return { available: false, path: '', error: error.message || String(error) };
  }
}

function tail(s, limit = 4000) {
  s = String(s || '');
  return s.length > limit ? s.slice(s.length - limit) : s;
}

function runCommand(commandSpec, args, options) {
  const parts = parseCommand(commandSpec);
  if (!parts.length) throw new HttpError(400, 'empty command');
  const command = expandHome(parts[0]);
  const finalArgs = parts.slice(1).concat(args || []);
  const timeoutMs = clampNumber(options && options.timeoutMs, DEFAULT_SETTINGS.requestTimeoutMs, 1000, 60 * 60 * 1000);
  const cwd = options && options.cwd ? options.cwd : process.cwd();
  const input = options && typeof options.input === 'string' ? options.input : '';

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, finalArgs, {
      cwd,
      env: Object.assign({}, process.env, { NO_COLOR: '1' }),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 1500);
    }, timeoutMs);

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        signal: null,
        stdout,
        stderr: stderr + (stderr ? '\n' : '') + error.message,
        elapsedMs: Date.now() - startedAt,
        timedOut
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: code,
        signal,
        stdout,
        stderr,
        elapsedMs: Date.now() - startedAt,
        timedOut
      });
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

async function runProvider(provider, prompt, settings, options = {}) {
  if (provider === 'claude') return runClaude(prompt, settings, options);
  return runCodex(prompt, settings, options);
}

async function runCodex(prompt, settings, options = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toytype-codex-'));
  const lastMessagePath = path.join(tmpDir, 'last-message.txt');
  const args = [
    'exec',
    '-C', settings.workspaceDir,
    '-s', 'read-only',
    '--skip-git-repo-check',
    '--ephemeral',
    '--color', 'never',
    '--output-last-message', lastMessagePath,
    '-'
  ];
  const result = await runCommand(settings.codexCommand, args, {
    cwd: settings.workspaceDir,
    input: prompt,
    timeoutMs: options.timeoutMs || settings.requestTimeoutMs
  });
  let response = '';
  try {
    response = fs.readFileSync(lastMessagePath, 'utf8');
  } catch (_) {
    response = result.stdout;
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  return Object.assign({ provider: 'codex', response }, result);
}

async function runClaude(prompt, settings, options = {}) {
  const args = [
    '-p',
    '--output-format', 'text',
    '--permission-mode', 'dontAsk',
    '--tools', '',
    '--no-session-persistence'
  ];
  const result = await runCommand(settings.claudeCommand, args, {
    cwd: settings.workspaceDir,
    input: prompt,
    timeoutMs: options.timeoutMs || settings.requestTimeoutMs
  });
  return Object.assign({ provider: 'claude', response: result.stdout }, result);
}

function readBuiltinRulesReference() {
  if (builtinRulesReferenceCache !== null) return builtinRulesReferenceCache;
  try {
    builtinRulesReferenceCache = fs.readFileSync(BUILTIN_RULES_PATH, 'utf8');
  } catch (_) {
    builtinRulesReferenceCache = '';
  }
  return builtinRulesReferenceCache;
}

function buildProofreadPrompt(document, settings) {
  const title = document.title || document.id || 'Google Docs document';
  const docId = document.id || '';
  const url = document.url || '';
  const sourceText = String(document.text || '');
  const truncated = sourceText.length > settings.maxDocumentChars;
  const text = truncated ? sourceText.slice(0, settings.maxDocumentChars) : sourceText;
  const refs = bookEditingReferenceInstructions();
  const builtinRules = readBuiltinRulesReference();
  const today = new Date().toISOString().slice(0, 10);

  return [
    'You are generating supplemental Toytype-compatible JSON for Korean book manuscript editing.',
    '',
    'Use the book-editing manuscript review mode, the existing Toytype rules.json reference, and the document text below. Return only one valid JSON object. Do not wrap it in markdown.',
    refs,
    projectSpecificRuleInstructions(),
    '',
    'Hard requirements:',
    '- Output JSON must have version, source, categories.',
    '- Each category.rules item must be [sourceText, replacementText]. Use optional third item {"rejectBefore":[],"rejectAfter":[]} only when a rule needs context exceptions.',
    '- sourceText must be exact text found in the document and should usually be at least 8 Korean characters unless it is a clear typo.',
    '- Do not include uncertain fixes in rules. Put uncertain or structural issues only in notes.',
    '- Do not rewrite long paragraphs. Generate precise, safe replacements for local awkward phrasing and sentence-level polish only.',
    '- Existing rules.json already covers simple spelling, spacing, notation, and common typo replacements. Do not duplicate corrections already covered by those deterministic rules.',
    '- The Toytype project-specific rules section has higher priority than generic Korean spacing advice.',
    '- Prioritize 비문, awkward/unclear phrasing, local 윤문, factual/content errors, duplicated content, repeated explanations, and document-specific terminology/content consistency.',
    '- Simple typos or spacing fixes should be suggested only when they are important and not already covered by rules.json.',
    '- Avoid code identifiers, URLs, file paths, shell commands, and quoted code strings unless the fix is unquestionably textual and safe.',
    '- English glosses may be superscript annotations in Google Docs. The text export can show them directly after Korean text, so consecutive Korean-English or English-English terms are not automatically errors.',
    '- Do not add parentheses around English glosses or propose wrapping adjacent English glosses in parentheses.',
    '- Prefer categories book-editing-proofread, book-editing-terms, book-editing-technical, book-editing-format.',
    '- Limit rules to the most important 120 items.',
    '',
    `Use version "${today}".`,
    `Use source "book-editing:${title || docId}".`,
    '',
    'Document metadata:',
    JSON.stringify({ title, docId, url, truncated, textChars: sourceText.length, includedChars: text.length, rulesReferenceChars: builtinRules.length }, null, 2),
    '',
    'Existing Toytype rules.json reference:',
    'These deterministic rules are already applied by Toytype. Use them to avoid duplicating simple spelling/spacing/notation fixes and to focus on higher-level manuscript issues.',
    '<<<TOYTYPE_RULES_JSON',
    builtinRules || '{"categories":[]}',
    'TOYTYPE_RULES_JSON',
    '',
    'Document text:',
    '<<<TOYTYPE_DOCUMENT_TEXT',
    text,
    'TOYTYPE_DOCUMENT_TEXT'
  ].join('\n');
}

function projectSpecificRuleInstructions() {
  return `Toytype project-specific rules (high priority):
- The built-in rules intentionally prefer 붙여쓰기 for many auxiliary-verb-style forms. Do not "correct" these into spaced forms.
- Keep forms like "해두면", "해둔", "해둡니다", "해주면", "해준", "해줍니다", "해줄", "해보면", "해본", "해볼", "해냈", "해넣" as joined text when they already appear joined.
- Do not propose replacements such as "해두면" -> "해 두면", "해주면" -> "해 주면", "...어두면" -> "...어 두면", "...아두면" -> "...아 두면", or "...여두면" -> "...여 두면".
- The same applies to project rules that join "어 보/어 주/어 둡" style fragments into "어보/어주/어둡". Treat those joined forms as intentional Toytype style, not spacing errors.
- Do not make style-only compression rules such as "하기 위해서" -> "하려면". Keep "하기 위해서" unless there is a concrete 비문 or content problem beyond length/style preference.
- When a candidate is only generic Korean spacing advice and conflicts with these house rules, omit it.`;
}

function bookEditingReferenceInstructions() {
  return `Book-editing proofread guidance distilled for Toytype:
- Treat editing as preserving the author's text while finding precise, safe corrections.
- Treat the built-in rules.json as the first-pass typo/spacing/style rule set. Your role is the second-pass manuscript reviewer.
- Focus on 비문, awkward/unclear phrasing, local 윤문, factual/content errors, duplicated content, repeated explanations, flow problems, and document-specific terminology/content consistency.
- Do not spend output on simple typos, spacing, notation changes, or common replacements already covered by rules.json unless the context makes the deterministic rule unsafe or insufficient.
- Follow Toytype project-specific spacing rules even when they differ from generic Korean spacing advice.
- Do not rewrite paragraphs or restructure the manuscript. Toytype rules are exact search/replace pairs, so only include corrections that can be safely applied as text replacement.
- Put uncertain factual issues, structural issues, author-confirmation items, duplicated-content observations, or long rewrite issues in notes only.
- Keep code, URLs, file paths, shell commands, JSON, identifiers, and quoted code strings untouched unless the correction is definitely safe.
- Treat adjacent English glosses as intentional when they may be superscript bilingual annotations from Google Docs; do not wrap them in parentheses.
- Prefer Korean book style: formal polite prose when correcting endings, consistent terms, no decorative special characters in body prose, and Korean publication spelling conventions.

Toytype JSON schema:
{
  "version": "YYYY-MM-DD",
  "source": "book-editing:{document title or id}",
  "categories": [
    {
      "id": "book-editing-proofread",
      "label": "원고 교열 제안",
      "defaultOn": true,
      "rules": [
        ["원문에서 찾을 정확한 텍스트", "수정할 텍스트"],
        ["문맥 예외가 필요한 텍스트", "수정할 텍스트", {"rejectBefore": ["직전 문자열"], "rejectAfter": ["직후 문자열"]}]
      ]
    }
  ],
  "notes": [
    {
      "category": "book-editing-proofread",
      "source": "원문에서 찾을 정확한 텍스트",
      "replacement": "수정할 텍스트",
      "location": "H2 title or approximate line",
      "severity": "critical|major|minor",
      "reason": "short reason"
    }
  ]
}`;
}

function extractJsonObject(text) {
  const input = String(text || '');
  for (let start = input.indexOf('{'); start !== -1; start = input.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < input.length; i++) {
      const ch = input[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = input.slice(start, i + 1);
          try {
            return JSON.parse(candidate);
          } catch (_) {
            break;
          }
        }
      }
    }
  }
  throw new HttpError(502, 'AI response did not contain a valid JSON object', { responseTail: tail(input) });
}

function validateToytypeJson(json) {
  if (!json || typeof json !== 'object') throw new HttpError(502, 'Toytype JSON must be an object');
  if (typeof json.version !== 'string' || !json.version.trim()) throw new HttpError(502, 'Toytype JSON missing version');
  if (typeof json.source !== 'string' || !json.source.trim()) throw new HttpError(502, 'Toytype JSON missing source');
  if (!Array.isArray(json.categories) || json.categories.length === 0) throw new HttpError(502, 'Toytype JSON missing categories');
  for (let i = 0; i < json.categories.length; i++) {
    const cat = json.categories[i];
    if (!cat || typeof cat !== 'object' || typeof cat.id !== 'string' || !Array.isArray(cat.rules)) {
      throw new HttpError(502, `invalid category at index ${i}`);
    }
    for (let j = 0; j < cat.rules.length; j++) {
      const rule = cat.rules[j];
      if (!Array.isArray(rule) || rule.length < 2 || typeof rule[0] !== 'string' || typeof rule[1] !== 'string') {
        throw new HttpError(502, `invalid rule at ${cat.id}[${j}]`);
      }
      if (rule.length > 3) throw new HttpError(502, `invalid rule length at ${cat.id}[${j}]`);
      if (rule.length === 3 && !validRuleOptions(rule[2])) {
        throw new HttpError(502, `invalid rule options at ${cat.id}[${j}]`);
      }
    }
  }
  if (json.notes !== undefined && !Array.isArray(json.notes)) throw new HttpError(502, 'notes must be an array when present');
  return json;
}

function validRuleOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return validStringList(value.rejectBefore) && validStringList(value.rejectAfter);
}

function validStringList(value) {
  return value === undefined ||
    typeof value === 'string' ||
    (Array.isArray(value) && value.every(item => typeof item === 'string'));
}

function normalizeGeneratedToytypeJson(json, document) {
  if (!json || typeof json !== 'object') return json;
  const today = new Date().toISOString().slice(0, 10);
  if (typeof json.version !== 'string' || !json.version.trim()) {
    json.version = today;
  }
  if (typeof json.source !== 'string' || !json.source.trim()) {
    json.source = 'book-editing:' + (document.title || document.id || 'Google Docs document');
  }
  return json;
}

function countRules(json) {
  return json.categories.reduce((sum, cat) => sum + (Array.isArray(cat.rules) ? cat.rules.length : 0), 0);
}

function compactToytypeJson(json, documentText) {
  const text = typeof documentText === 'string' ? documentText : '';
  let compacted = 0;
  let dropped = 0;
  for (const cat of json.categories) {
    if (!cat || !Array.isArray(cat.rules)) continue;
    const nextRules = [];
    const seen = new Set();
    for (const rule of cat.rules) {
      const original = [String(rule[0]), String(rule[1])];
      const options = rule.length === 3 && validRuleOptions(rule[2]) ? cloneRuleOptions(rule[2]) : null;
      const compact = compactRule(original[0], original[1], text);
      if (!compact) {
        dropped++;
        continue;
      }
      if (compact[0] !== original[0] || compact[1] !== original[1]) compacted++;
      const key = compact[0] + '\u0000' + compact[1] + '\u0000' + JSON.stringify(options || {});
      if (seen.has(key)) {
        dropped++;
        continue;
      }
      seen.add(key);
      nextRules.push(options ? [compact[0], compact[1], options] : compact);
    }
    cat.rules = nextRules;
  }
  return { json, compacted, dropped };
}

function cloneRuleOptions(options) {
  const out = {};
  if (options.rejectBefore !== undefined) out.rejectBefore = cloneStringListOption(options.rejectBefore);
  if (options.rejectAfter !== undefined) out.rejectAfter = cloneStringListOption(options.rejectAfter);
  return out;
}

function cloneStringListOption(value) {
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string');
  return typeof value === 'string' ? value : [];
}

function compactRule(src, dst, documentText) {
  if (typeof src !== 'string' || typeof dst !== 'string') return null;
  if (!src.trim() || src === dst) return null;
  const prefix = commonPrefixLength(src, dst);
  const suffix = commonSuffixLength(src, dst, prefix);
  if (prefix === 0 && suffix === 0) return [src, dst];
  const originalCount = documentText ? countOccurrences(documentText, src) : 0;
  for (const maxContext of [10, 18, 32, 56, 96]) {
    const candidate = compactRuleWithContext(src, dst, prefix, suffix, maxContext);
    if (!candidate || candidate[0] === candidate[1] || !candidate[0].trim()) continue;
    if (candidate[0].length >= src.length && candidate[1].length >= dst.length) continue;
    if (documentText && originalCount > 0) {
      const candidateCount = countOccurrences(documentText, candidate[0], originalCount + 1);
      if (candidateCount > originalCount) continue;
    }
    return candidate;
  }
  return [src, dst];
}

function compactRuleWithContext(src, dst, prefix, suffix, maxContext) {
  const srcCoreEnd = src.length - suffix;
  const dstCoreEnd = dst.length - suffix;
  let start = prefix;
  const leftLimit = Math.max(0, prefix - maxContext);
  while (start > leftLimit && !isRuleBoundary(src[start - 1])) start--;
  if (start > leftLimit && start === prefix && prefix > 0) {
    start--;
    while (start > leftLimit && !isRuleBoundary(src[start - 1])) start--;
  }

  let right = 0;
  const rightLimit = Math.min(suffix, maxContext);
  let sawRightWord = false;
  while (right < rightLimit) {
    const ch = src[srcCoreEnd + right];
    right++;
    if (!isRuleBoundary(ch)) {
      sawRightWord = true;
    } else if (sawRightWord) {
      break;
    }
  }
  const compactSrc = src.slice(start, srcCoreEnd + right);
  const compactDst = dst.slice(start, dstCoreEnd + right);
  return [compactSrc, compactDst];
}

function commonPrefixLength(a, b) {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLength(a, b, prefix) {
  const max = Math.min(a.length, b.length) - prefix;
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

function isRuleBoundary(ch) {
  return !ch || /[\s.,!?;:()[\]{}"'“”‘’<>《》「」『』·…—-]/.test(ch);
}

function countOccurrences(text, needle, stopAfter = Infinity) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(needle, index)) !== -1) {
    count++;
    if (count >= stopAfter) return count;
    index += Math.max(1, needle.length);
  }
  return count;
}

function sanitizeFilename(name) {
  return String(name || 'document')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'document';
}

function writeGeneratedJson(json, document, settings) {
  fs.mkdirSync(settings.outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const docId = sanitizeFilename(document.id || extractDocId(document.url) || 'document');
  json.documentId = document.id || '';
  json.documentTitle = document.title || '';
  json.documentUrl = document.url || '';
  const fileName = generatedJsonFileName(docId, stamp);
  const outputPath = path.join(settings.outputDir, fileName);
  fs.writeFileSync(outputPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
  return { fileName, displayName: generatedJsonDisplayName(fileName), outputPath };
}

function migrateGeneratedJsonFiles(settings, document) {
  const docId = document && (document.id || extractDocId(document.url));
  if (!docId) return { renamed: 0, skipped: 0 };
  const safeDocId = sanitizeFilename(docId);
  const title = String(document.title || '').trim();
  let names = [];
  try {
    names = fs.readdirSync(settings.outputDir);
  } catch (_) {
    return { renamed: 0, skipped: 0 };
  }
  let renamed = 0;
  let skipped = 0;
  for (const name of names) {
    if (!/\.json$/i.test(name)) continue;
    const existingStamp = extractGeneratedJsonStamp(name);
    if (existingStamp && name === generatedJsonFileName(safeDocId, existingStamp)) continue;
    const filePath = path.join(settings.outputDir, name);
    let json = null;
    try {
      json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
      skipped++;
      continue;
    }
    const fileDocId = String(json.documentId || extractDocId(json.documentUrl || json.url || json.source || '') || '').trim();
    const source = String(json.source || '');
    const titlePrefix = title ? sanitizeFilename(title) : '';
    const sameDocument = fileDocId === docId ||
      generatedJsonFileNameMatchesPrefix(name, safeDocId) ||
      (title && (source === 'book-editing:' + title || generatedJsonFileNameMatchesPrefix(name, titlePrefix)));
    if (!sameDocument) {
      skipped++;
      continue;
    }
    const stamp = existingStamp || new Date(fs.statSync(filePath).mtimeMs).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const nextName = generatedJsonFileName(safeDocId, stamp);
    const nextPath = path.join(settings.outputDir, nextName);
    if (filePath === nextPath || fs.existsSync(nextPath)) {
      skipped++;
      continue;
    }
    json.documentId = docId;
    if (document.title) json.documentTitle = document.title;
    if (document.url) json.documentUrl = document.url;
    fs.writeFileSync(filePath, JSON.stringify(json, null, 2) + '\n', 'utf8');
    fs.renameSync(filePath, nextPath);
    renamed++;
  }
  return { renamed, skipped };
}

function generatedJsonFileName(docId, stamp) {
  return `${docId}-${stamp}.json`;
}

function extractGeneratedJsonStamp(fileName) {
  const match = String(fileName || '').match(/(?:-toytype)?-(\d{8}T\d{6}Z)\.json$/);
  return match ? match[1] : '';
}

function generatedJsonFileNameMatchesPrefix(fileName, prefix) {
  const name = String(fileName || '');
  const safePrefix = String(prefix || '');
  const stamp = extractGeneratedJsonStamp(name);
  if (!safePrefix || !stamp) return false;
  return name === generatedJsonFileName(safePrefix, stamp) || name === `${safePrefix}-toytype-${stamp}.json`;
}

function generatedJsonDisplayName(fileName) {
  const stamp = extractGeneratedJsonStamp(fileName);
  return stamp ? `ai 검토-${stamp}.json` : String(fileName || 'ai 검토.json');
}

function generatedJsonMatchesDocument(json, fileName, document) {
  const docId = String(document && (document.id || extractDocId(document.url)) || '').trim();
  const safeDocId = sanitizeFilename(docId);
  const title = String(document && document.title || '').trim();
  const fileDocId = String(json.documentId || extractDocId(json.documentUrl || json.url || json.source || '') || '').trim();
  const source = String(json.source || '');
  const documentTitle = String(json.documentTitle || '').trim();
  if (docId && generatedJsonFileNameMatchesPrefix(fileName, safeDocId)) return true;
  if (docId && fileDocId === docId) return true;
  if (title && documentTitle === title) return true;
  if (title && (source === 'book-editing:' + title || generatedJsonFileNameMatchesPrefix(fileName, sanitizeFilename(title)))) return true;
  return false;
}

function listGeneratedJsonFiles(body) {
  const settings = mergeSettings(body.settings);
  const document = body.document && typeof body.document === 'object' ? body.document : {};
  if (!document.id) document.id = extractDocId(document.url);
  const migration = migrateGeneratedJsonFiles(settings, document);
  let names = [];
  try {
    names = fs.readdirSync(settings.outputDir);
  } catch (_) {
    return {
      ok: true,
      outputDir: settings.outputDir,
      migratedFiles: migration.renamed,
      files: []
    };
  }
  const files = [];
  for (const name of names) {
    if (!/\.json$/i.test(name)) continue;
    const outputPath = path.join(settings.outputDir, name);
    let stat = null;
    let raw = null;
    try {
      stat = fs.statSync(outputPath);
      if (!stat.isFile()) continue;
      raw = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    } catch (_) {
      continue;
    }
    if (!raw || typeof raw !== 'object' || !generatedJsonMatchesDocument(raw, name, document)) continue;
    let json = null;
    try {
      json = validateToytypeJson(normalizeGeneratedToytypeJson(raw, document));
    } catch (_) {
      continue;
    }
    files.push({
      fileName: name,
      displayName: generatedJsonDisplayName(name),
      outputPath,
      mtimeMs: stat.mtimeMs,
      version: json.version,
      ruleCount: countRules(json),
      json
    });
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.fileName.localeCompare(b.fileName));
  return {
    ok: true,
    outputDir: settings.outputDir,
    migratedFiles: migration.renamed,
    files: files.slice(0, 50)
  };
}

function openPathCommand(targetPath) {
  if (process.platform === 'darwin') return { command: 'open', args: [targetPath] };
  if (process.platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', targetPath] };
  return { command: 'xdg-open', args: [targetPath] };
}

async function openOutputDir(body) {
  const settings = mergeSettings(body.settings);
  fs.mkdirSync(settings.outputDir, { recursive: true });
  const opener = openPathCommand(settings.outputDir);
  const run = await runCommand(opener.command, opener.args, {
    cwd: process.cwd(),
    timeoutMs: 10000
  });
  if (!run.ok) {
    throw new HttpError(502, 'failed to open output directory', {
      outputDir: settings.outputDir,
      exitCode: run.exitCode,
      signal: run.signal,
      stdout: tail(run.stdout),
      stderr: tail(run.stderr)
    });
  }
  return { ok: true, opened: true, outputDir: settings.outputDir };
}

function extractDocId(urlOrId) {
  const value = String(urlOrId || '');
  let m = value.match(/\/document\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  m = value.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]+$/.test(value)) return value;
  return '';
}

async function generateProofread(body) {
  const settings = mergeSettings(body.settings);
  const provider = body.provider === 'claude' ? 'claude' : settings.provider;
  const document = body.document && typeof body.document === 'object' ? body.document : {};
  if (typeof document.text !== 'string' || !document.text.trim()) {
    throw new HttpError(400, 'document.text is required');
  }
  if (!document.id) document.id = extractDocId(document.url);

  const prompt = buildProofreadPrompt(document, settings);
  const run = await runProvider(provider, prompt, settings);
  if (!run.ok) {
    throw new HttpError(502, `${provider} exited with code ${run.exitCode}`, {
      exitCode: run.exitCode,
      signal: run.signal,
      timedOut: run.timedOut,
      stdout: tail(run.stdout),
      stderr: tail(run.stderr)
    });
  }
  const json = validateToytypeJson(normalizeGeneratedToytypeJson(extractJsonObject(run.response), document));
  const compact = compactToytypeJson(json, document.text);
  const migration = migrateGeneratedJsonFiles(settings, document);
  const file = writeGeneratedJson(json, document, settings);
  return {
    ok: true,
    provider,
    json,
    ruleCount: countRules(json),
    compactedRules: compact.compacted,
    droppedRules: compact.dropped,
    migratedFiles: migration.renamed,
    fileName: file.fileName,
    displayName: file.displayName,
    outputPath: file.outputPath,
    elapsedMs: run.elapsedMs,
    stdoutTail: tail(run.stdout, 1200),
    stderrTail: tail(run.stderr, 1200)
  };
}

async function testProvider(body) {
  const settings = mergeSettings(body.settings);
  const provider = body.provider === 'claude' ? 'claude' : settings.provider;
  const expected = provider === 'claude' ? 'TOYTYPE_CLAUDE_OK' : 'TOYTYPE_CODEX_OK';
  const run = await runProvider(provider, `Reply exactly ${expected}`, settings, {
    timeoutMs: clampNumber(body.timeoutMs, 120000, 5000, settings.requestTimeoutMs)
  });
  const response = String(run.response || '').trim();
  return {
    ok: run.ok && response.includes(expected),
    provider,
    expected,
    response,
    exitCode: run.exitCode,
    signal: run.signal,
    timedOut: run.timedOut,
    elapsedMs: run.elapsedMs,
    stdoutTail: tail(run.stdout),
    stderrTail: tail(run.stderr)
  };
}

function health(settingsInput) {
  const settings = mergeSettings(settingsInput);
  return {
    ok: true,
    version: VERSION,
    port: activePort,
    tools: {
      codex: locateCommand(settings.codexCommand),
      claude: locateCommand(settings.claudeCommand)
    },
    settings: {
      provider: settings.provider,
      workspaceDir: settings.workspaceDir,
      outputDir: settings.outputDir,
      requestTimeoutMs: settings.requestTimeoutMs,
      maxDocumentChars: settings.maxDocumentChars
    }
  };
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new HttpError(400, 'invalid JSON body', { error: error.message }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'content-length': Buffer.byteLength(data)
  });
  res.end(data);
}

function sendError(res, error) {
  const status = error && error.status ? error.status : 500;
  sendJson(res, status, {
    ok: false,
    error: error && error.message ? error.message : String(error),
    details: error && error.details !== undefined ? error.details : undefined
  });
}

async function route(req, res) {
  if (req.method === 'OPTIONS') {
    sendJson(res, 200, { ok: true });
    return;
  }
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, health({}));
    return;
  }
  if (req.method !== 'POST') throw new HttpError(404, 'not found');
  const body = await readRequestBody(req);
  if (url.pathname === '/health') {
    sendJson(res, 200, health(body.settings));
    return;
  }
  if (url.pathname === '/ai/test') {
    sendJson(res, 200, await testProvider(body));
    return;
  }
  if (url.pathname === '/ai/proofread') {
    sendJson(res, 200, await generateProofread(body));
    return;
  }
  if (url.pathname === '/fs/list-generated') {
    sendJson(res, 200, listGeneratedJsonFiles(body));
    return;
  }
  if (url.pathname === '/fs/open-output-dir') {
    sendJson(res, 200, await openOutputDir(body));
    return;
  }
  throw new HttpError(404, 'not found');
}

function startServer(port = DEFAULT_PORT) {
  activePort = port;
  const server = http.createServer((req, res) => {
    route(req, res).catch(error => sendError(res, error));
  });
  server.on('error', error => {
    if (error && error.code === 'EADDRINUSE') {
      console.error(`Toytype AI bridge is already running or port ${port} is in use.`);
      console.error(`If Toytype is already working, you do not need to start another bridge.`);
      console.error(`Check the current process with: lsof -nP -iTCP:${port} -sTCP:LISTEN`);
      process.exitCode = 1;
      return;
    }
    throw error;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Toytype AI bridge listening on http://127.0.0.1:${port}`);
  });
  return server;
}

function main() {
  const portIndex = process.argv.indexOf('--port');
  const port = portIndex !== -1 ? Number(process.argv[portIndex + 1]) : DEFAULT_PORT;
  startServer(Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT);
}

if (process.argv[1] && path.resolve(process.argv[1]) === BRIDGE_FILE) {
  main();
}

export {
  extractJsonObject,
  validateToytypeJson,
  extractDocId,
  mergeSettings,
  compactToytypeJson,
  buildProofreadPrompt,
  health
};
