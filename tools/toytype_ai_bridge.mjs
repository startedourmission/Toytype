#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = Number(process.env.TOYTYPE_AI_BRIDGE_PORT || 17644);
const MAX_BODY_BYTES = 200 * 1024 * 1024;
const VERSION = '1.0.0';
const BRIDGE_FILE = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(BRIDGE_FILE), '..');
const BUILTIN_RULES_PATH = path.join(PROJECT_ROOT, 'rules.json');
const SENTENCE_SUGGESTION_CATEGORY_ID = 'ai-sentence-suggestions';
const SENTENCE_SUGGESTION_CATEGORY_LABEL = 'AI 문장 제안';
const GENERATED_CLEANUP_DAYS = [1, 7, 30, 60, 180];
const DOWNLOAD_TOKEN_TTL_MS = 10 * 60 * 1000;
let activePort = DEFAULT_PORT;
let builtinRulesReferenceCache = null;
let crc32TableCache = null;
const downloadTokens = new Map();

const DEFAULT_SETTINGS = {
  provider: 'codex',
  codexCommand: 'codex',
  claudeCommand: 'claude',
  workspaceDir: '~/Dev/Toytype',
  outputDir: '~/.toytype/generated',
  requestTimeoutMs: 10 * 60 * 1000,
  maxDocumentChars: 180000,
  proofreadFactCheckEnabled: true,
  proofreadFactCheckCodexModel: 'gpt-5.5',
  proofreadFactCheckCodexReasoningEffort: 'medium',
  proofreadFactCheckClaudeModel: 'sonnet',
  proofreadFactCheckTimeoutMs: 240000,
  questionCodexModel: '',
  questionCodexReasoningEffort: 'low',
  questionClaudeModel: 'fable',
  questionContextBeforeChars: 3500,
  questionContextAfterChars: 2500
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
    maxDocumentChars: clampNumber(s.maxDocumentChars, DEFAULT_SETTINGS.maxDocumentChars, 1000, 1000000),
    proofreadFactCheckEnabled: s.proofreadFactCheckEnabled !== false,
    proofreadFactCheckCodexModel: typeof s.proofreadFactCheckCodexModel === 'string' && s.proofreadFactCheckCodexModel.trim() ? s.proofreadFactCheckCodexModel.trim() : DEFAULT_SETTINGS.proofreadFactCheckCodexModel,
    proofreadFactCheckCodexReasoningEffort: typeof s.proofreadFactCheckCodexReasoningEffort === 'string' && s.proofreadFactCheckCodexReasoningEffort.trim() ? s.proofreadFactCheckCodexReasoningEffort.trim() : DEFAULT_SETTINGS.proofreadFactCheckCodexReasoningEffort,
    proofreadFactCheckClaudeModel: typeof s.proofreadFactCheckClaudeModel === 'string' && s.proofreadFactCheckClaudeModel.trim() ? s.proofreadFactCheckClaudeModel.trim() : DEFAULT_SETTINGS.proofreadFactCheckClaudeModel,
    proofreadFactCheckTimeoutMs: clampNumber(s.proofreadFactCheckTimeoutMs, DEFAULT_SETTINGS.proofreadFactCheckTimeoutMs, 30000, 10 * 60 * 1000),
    questionCodexModel: typeof s.questionCodexModel === 'string' ? s.questionCodexModel.trim() : DEFAULT_SETTINGS.questionCodexModel,
    questionCodexReasoningEffort: typeof s.questionCodexReasoningEffort === 'string' && s.questionCodexReasoningEffort.trim() ? s.questionCodexReasoningEffort.trim() : DEFAULT_SETTINGS.questionCodexReasoningEffort,
    questionClaudeModel: typeof s.questionClaudeModel === 'string' && s.questionClaudeModel.trim() ? s.questionClaudeModel.trim() : DEFAULT_SETTINGS.questionClaudeModel,
    questionContextBeforeChars: clampNumber(s.questionContextBeforeChars, DEFAULT_SETTINGS.questionContextBeforeChars, 500, 20000),
    questionContextAfterChars: clampNumber(s.questionContextAfterChars, DEFAULT_SETTINGS.questionContextAfterChars, 500, 20000)
  };
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function countChars(value) {
  return Array.from(String(value || '')).length;
}

function truncateLogValue(value, max = 96) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatLogValue(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(truncateLogValue(value));
}

function formatLogFields(fields) {
  const parts = [];
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${key}=${formatLogValue(value)}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

function bridgeLog(event, fields) {
  console.log(`[${new Date().toISOString()}] ${event}${formatLogFields(fields)}`);
}

function bridgeError(event, fields) {
  console.error(`[${new Date().toISOString()}] ${event}${formatLogFields(fields)}`);
}

function requestDocumentSummary(body) {
  const document = body && body.document && typeof body.document === 'object' ? body.document : {};
  const docId = document.id || extractDocId(document.url);
  const before = typeof document.contextBefore === 'string' ? document.contextBefore : document.textBefore;
  const after = typeof document.contextAfter === 'string' ? document.contextAfter : document.textAfter;
  return {
    docId,
    title: document.title,
    textChars: typeof document.text === 'string' ? countChars(document.text) : undefined,
    selectedChars: typeof document.selectedText === 'string' ? countChars(document.selectedText) : undefined,
    beforeChars: typeof before === 'string' ? countChars(before) : undefined,
    afterChars: typeof after === 'string' ? countChars(after) : undefined,
    insertionChars: typeof document.insertionSource === 'string' ? countChars(document.insertionSource) : undefined,
    targetPercent: document.targetPercent
  };
}

function aiRequestLogFields(body) {
  const settings = mergeSettings(body && body.settings);
  const provider = body && body.provider === 'claude' ? 'claude' : settings.provider;
  return Object.assign({
    provider,
    timeoutMs: body && body.timeoutMs
  }, requestDocumentSummary(body));
}

function aiResultLogFields(payload, elapsedMs) {
  return {
    provider: payload && payload.provider,
    model: payload && payload.model,
    elapsedMs,
    runElapsedMs: payload && payload.elapsedMs,
    fileName: payload && payload.fileName,
    ruleCount: payload && payload.ruleCount,
    chars: payload && payload.chars,
    targetPercent: payload && payload.targetPercent,
    sourceChars: payload && payload.sourceChars,
    replacementChars: payload && payload.replacementChars
  };
}

function aiErrorLogFields(error, elapsedMs) {
  return {
    elapsedMs,
    status: error && error.status,
    message: error && error.message,
    exitCode: error && error.details && error.details.exitCode,
    timedOut: error && error.details && error.details.timedOut,
    model: error && error.details && error.details.model
  };
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
  if (typeof options.model === 'string' && options.model.trim()) {
    args.splice(1, 0, '--model', options.model.trim());
  }
  if (typeof options.reasoningEffort === 'string' && options.reasoningEffort.trim()) {
    args.splice(1, 0, '-c', `model_reasoning_effort="${options.reasoningEffort.trim()}"`);
  }
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
    '--no-session-persistence'
  ];
  if (options.allowWebTools === true) {
    args.push('--tools', 'WebFetch,WebSearch');
  } else {
    args.push('--tools', '');
  }
  if (typeof options.model === 'string' && options.model.trim()) {
    args.push('--model', options.model.trim());
  }
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

function buildProofreadPrompt(document, settings, factCheck) {
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
    manuscriptNotationInstructions(),
    '',
    'Hard requirements:',
    '- Output JSON must have version, source, categories.',
    '- Each category.rules item must be [sourceText, replacementText]. Use optional third item {"rejectBefore":[],"rejectAfter":[]} only when a rule needs context exceptions.',
    '- sourceText must be exact text found in the document and should usually be at least 8 Korean characters unless it is a clear typo.',
    '- Do not include uncertain fixes in rules. Put uncertain or structural issues only in notes.',
    '- Use the fact-check subagent report below as external evidence. Convert only high-confidence contradicted factual issues with exact safe replacements into rules.',
    '- Put medium-confidence, unverifiable, or context-dependent factual issues in notes only. Do not invent replacement facts.',
    '- When a factual note cites web evidence, preserve the source URLs in the note object.',
    '- Do not rewrite long paragraphs. Generate precise, safe replacements for local awkward phrasing and sentence-level polish only.',
    '- Existing rules.json already covers simple spelling, spacing, notation, and common typo replacements. Do not duplicate corrections already covered by those deterministic rules.',
    '- The Toytype project-specific rules section has higher priority than generic Korean spacing advice.',
    '- Prioritize 비문, awkward/unclear phrasing, local 윤문, factual/content errors, duplicated content, repeated explanations, and document-specific terminology/content consistency.',
    '- Simple typos or spacing fixes should be suggested only when they are important and not already covered by rules.json.',
    '- Avoid code identifiers, URLs, file paths, shell commands, and quoted code strings unless the fix is unquestionably textual and safe.',
    '- English glosses may be superscript annotations in Google Docs. The text export can show them directly after Korean text, so consecutive Korean-English or English-English terms are not automatically errors.',
    '- Do not add parentheses around English glosses or propose wrapping adjacent English glosses in parentheses.',
    '- Prefer categories book-editing-proofread, book-editing-terms, book-editing-technical, book-editing-format.',
    '- Use category label "기술 및 내용 정확성" for book-editing-technical.',
    '- For every book-editing-technical rule, add a matching notes item with category "book-editing-technical", exact source, exact replacement, and a concise Korean reason. Toytype shows that reason under the item.',
    '- Limit rules to the most important 120 items.',
    '',
    `Use version "${today}".`,
    `Use source "book-editing:${title || docId}".`,
    '',
    'Document metadata:',
    JSON.stringify({ title, docId, url, truncated, textChars: sourceText.length, includedChars: text.length, rulesReferenceChars: builtinRules.length }, null, 2),
    '',
    'Fact-check subagent report:',
    'Use this report for factual/content-error review. It was produced before this pass by a web-enabled fact-checker. If it is unavailable or marks a claim as unverifiable, do not turn that item into an automatic replacement rule.',
    '<<<TOYTYPE_FACT_CHECK_JSON',
    JSON.stringify(factCheck && factCheck.report ? factCheck.report : { ok: false, claims: [], notes: ['fact-check report unavailable'] }, null, 2),
    'TOYTYPE_FACT_CHECK_JSON',
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

function buildProofreadFactCheckPrompt(document, settings, provider, model) {
  const title = document.title || document.id || 'Google Docs document';
  const docId = document.id || '';
  const url = document.url || '';
  const sourceText = String(document.text || '');
  const maxChars = Math.min(settings.maxDocumentChars, 120000);
  const truncated = sourceText.length > maxChars;
  const text = truncated ? sourceText.slice(0, maxChars) : sourceText;
  const today = new Date().toISOString().slice(0, 10);

  return [
    'You are the Toytype factual verification subagent for a Korean manuscript proofread.',
    '',
    'Use web search/fetch tools when available. For Claude, WebFetch and WebSearch are enabled for this pass. For Codex, use the available web/search/fetch capability if the runtime provides it.',
    'Your job is not style editing. Verify concrete factual claims that could be wrong or stale: dates, names, organizations, product behavior, legal/technical claims, historical claims, statistics, URLs, and cross-document consistency claims.',
    '',
    'Hard requirements:',
    '- Return only one valid JSON object. No markdown.',
    '- Check claims carefully with external sources when possible. Prefer primary or authoritative sources.',
    '- Do not send automatic rewrite rules. This is only an evidence report for the next proofread pass.',
    '- Every claim item must include exact sourceText copied from the manuscript.',
    '- If you cannot verify a claim with available sources, use status "unverifiable"; do not guess.',
    '- Use status "contradicted" only when the manuscript conflicts with reliable evidence.',
    '- Include suggestedReplacement only when the corrected wording is directly supported and safe.',
    '- Keep quotes short. Store URLs for evidence in sources.',
    '- Limit to the most important 40 claim items.',
    '',
    'Allowed status values: supported, contradicted, unverifiable, needs_context.',
    'Allowed confidence values: high, medium, low.',
    '',
    'Document metadata:',
    JSON.stringify({ title, docId, url, provider, model, today, truncated, textChars: sourceText.length, includedChars: text.length }, null, 2),
    '',
    'Required JSON shape:',
    JSON.stringify({
      ok: true,
      checkedAt: today,
      provider,
      model,
      webAccess: 'used|unavailable|partial',
      claims: [{
        sourceText: 'exact manuscript text',
        status: 'supported|contradicted|unverifiable|needs_context',
        confidence: 'high|medium|low',
        finding: 'short Korean finding',
        suggestedReplacement: 'safe replacement text or empty string',
        sources: [{
          title: 'source title',
          url: 'https://example.com',
          publisher: 'publisher',
          date: 'YYYY-MM-DD or empty',
          evidence: 'short evidence summary'
        }]
      }],
      notes: ['short note']
    }, null, 2),
    '',
    'Document text:',
    '<<<TOYTYPE_DOCUMENT_TEXT',
    text,
    'TOYTYPE_DOCUMENT_TEXT'
  ].join('\n');
}

async function runProofreadFactCheck(document, settings, provider, totalTimeoutMs) {
  if (settings.proofreadFactCheckEnabled === false) {
    return {
      enabled: false,
      provider,
      model: '',
      elapsedMs: 0,
      report: { ok: false, webAccess: 'disabled', claims: [], notes: ['fact-check disabled'] }
    };
  }
  const model = proofreadFactCheckModel(provider, settings);
  const timeoutMs = Math.min(
    settings.proofreadFactCheckTimeoutMs,
    Math.max(30000, Math.floor(Number(totalTimeoutMs || settings.requestTimeoutMs) * 0.4))
  );
  const prompt = buildProofreadFactCheckPrompt(document, settings, provider, model);
  bridgeLog('AI proofread fact-check start', {
    provider,
    model,
    docId: document.id || extractDocId(document.url),
    title: document.title,
    textChars: countChars(document.text),
    timeoutMs
  });
  const run = await runProvider(provider, prompt, settings, {
    model,
    reasoningEffort: provider === 'codex' ? settings.proofreadFactCheckCodexReasoningEffort : undefined,
    allowWebTools: provider === 'claude',
    timeoutMs
  });
  if (!run.ok) {
    bridgeError('AI proofread fact-check failed', {
      provider,
      model,
      elapsedMs: run.elapsedMs,
      exitCode: run.exitCode,
      timedOut: run.timedOut
    });
    throw new HttpError(502, `${provider} fact-check exited with code ${run.exitCode}`, {
      exitCode: run.exitCode,
      signal: run.signal,
      timedOut: run.timedOut,
      model,
      stdout: tail(run.stdout),
      stderr: tail(run.stderr)
    });
  }
  const report = normalizeFactCheckReport(extractJsonObject(run.response), document, {
    provider,
    model,
    elapsedMs: run.elapsedMs
  });
  bridgeLog('AI proofread fact-check done', {
    provider,
    model,
    elapsedMs: run.elapsedMs,
    webAccess: report.webAccess,
    claimCount: Array.isArray(report.claims) ? report.claims.length : 0
  });
  return {
    enabled: true,
    provider,
    model,
    elapsedMs: run.elapsedMs,
    report,
    stdoutTail: tail(run.stdout, 1200),
    stderrTail: tail(run.stderr, 1200)
  };
}

function proofreadFactCheckModel(provider, settings) {
  return provider === 'claude' ? settings.proofreadFactCheckClaudeModel : settings.proofreadFactCheckCodexModel;
}

function normalizeFactCheckReport(report, document, meta) {
  if (!report || typeof report !== 'object') {
    throw new HttpError(502, 'fact-check response must be a JSON object');
  }
  const text = String(document.text || '');
  const claims = Array.isArray(report.claims) ? report.claims : [];
  const outClaims = [];
  for (const claim of claims.slice(0, 60)) {
    if (!claim || typeof claim !== 'object') continue;
    const sourceText = typeof claim.sourceText === 'string' ? claim.sourceText : '';
    if (!sourceText.trim()) continue;
    const status = normalizeFactCheckStatus(claim.status);
    const confidence = normalizeFactCheckConfidence(claim.confidence);
    outClaims.push({
      sourceText,
      inDocument: text.includes(sourceText),
      status: text.includes(sourceText) ? status : 'unverifiable',
      confidence,
      finding: typeof claim.finding === 'string' ? claim.finding.slice(0, 600) : '',
      suggestedReplacement: typeof claim.suggestedReplacement === 'string' ? claim.suggestedReplacement : '',
      sources: normalizeFactCheckSources(claim.sources)
    });
    if (outClaims.length >= 40) break;
  }
  return {
    ok: report.ok !== false,
    checkedAt: typeof report.checkedAt === 'string' && report.checkedAt ? report.checkedAt : new Date().toISOString(),
    provider: meta.provider,
    model: meta.model,
    elapsedMs: meta.elapsedMs,
    webAccess: typeof report.webAccess === 'string' && report.webAccess ? report.webAccess : 'partial',
    claims: outClaims,
    notes: Array.isArray(report.notes)
      ? report.notes.filter(note => typeof note === 'string').map(note => note.slice(0, 600)).slice(0, 20)
      : []
  };
}

function normalizeFactCheckStatus(value) {
  const status = String(value || '').toLowerCase();
  if (status === 'supported' || status === 'contradicted' || status === 'unverifiable' || status === 'needs_context') return status;
  return 'unverifiable';
}

function normalizeFactCheckConfidence(value) {
  const confidence = String(value || '').toLowerCase();
  if (confidence === 'high' || confidence === 'medium' || confidence === 'low') return confidence;
  return 'low';
}

function normalizeFactCheckSources(sources) {
  if (!Array.isArray(sources)) return [];
  return sources
    .filter(source => source && typeof source === 'object')
    .map(source => ({
      title: typeof source.title === 'string' ? source.title.slice(0, 200) : '',
      url: typeof source.url === 'string' ? source.url.slice(0, 500) : '',
      publisher: typeof source.publisher === 'string' ? source.publisher.slice(0, 120) : '',
      date: typeof source.date === 'string' ? source.date.slice(0, 80) : '',
      evidence: typeof source.evidence === 'string' ? source.evidence.slice(0, 500) : ''
    }))
    .filter(source => source.url || source.title || source.evidence)
    .slice(0, 5);
}

function buildQuestionPrompt(document, settings) {
  const title = document.title || document.id || 'Google Docs document';
  const docId = document.id || '';
  const url = document.url || '';
  const before = String(document.contextBefore || document.textBefore || '').slice(-settings.questionContextBeforeChars);
  const after = String(document.contextAfter || document.textAfter || '').slice(0, settings.questionContextAfterChars);
  const meta = {
    title,
    docId,
    url,
    cursorOffset: Number.isFinite(Number(document.cursorOffset)) ? Number(document.cursorOffset) : null,
    totalChars: Number.isFinite(Number(document.totalChars)) ? Number(document.totalChars) : null,
    beforeChars: before.length,
    afterChars: after.length
  };

  return [
    'You write Korean reader prompts ("발문") for a manuscript.',
    '',
    'Generate one Korean 발문 to insert at the current cursor position.',
    'Use the surrounding manuscript context to make it specific and natural.',
    manuscriptNotationInstructions(),
    '',
    'Hard requirements:',
    '- Return only the text to insert. No markdown, no heading, no label, no quotes, no bullets, no explanation.',
    '- Write about 200 Korean characters. Target 160-240 characters.',
    '- Use one compact paragraph.',
    '- Make it a thoughtful reader-facing prompt or question that connects the preceding and following context.',
    '- Do not summarize the whole document. Do not mention AI, cursor, context, or this instruction.',
    '- Preserve the manuscript tone. Avoid exaggerated marketing copy.',
    '',
    'Document metadata:',
    JSON.stringify(meta, null, 2),
    '',
    'Text before cursor:',
    '<<<TOYTYPE_CONTEXT_BEFORE',
    before,
    'TOYTYPE_CONTEXT_BEFORE',
    '',
    'Text after cursor:',
    '<<<TOYTYPE_CONTEXT_AFTER',
    after,
    'TOYTYPE_CONTEXT_AFTER'
  ].join('\n');
}

function buildLengthAdjustmentPrompt(document) {
  const selectedText = String(document.selectedText || '');
  const targetPercent = clampNumber(document.targetPercent, 100, 10, 500);
  const contextBefore = String(document.contextBefore || '').slice(-1200);
  const contextAfter = String(document.contextAfter || '').slice(0, 1200);
  const currentChars = Array.from(selectedText).length;
  const targetChars = Math.max(1, Math.round(currentChars * targetPercent / 100));
  const title = document.title || document.id || 'Google Docs document';
  const meta = {
    title,
    docId: document.id || '',
    targetPercent,
    currentChars,
    targetChars,
    selectionStart: Number.isFinite(Number(document.selectionStart)) ? Number(document.selectionStart) : null,
    selectionEnd: Number.isFinite(Number(document.selectionEnd)) ? Number(document.selectionEnd) : null
  };

  return [
    'You adjust the length of a selected Korean manuscript sentence or passage.',
    '',
    'Return only one valid Toytype-compatible JSON object. Do not wrap it in markdown.',
    manuscriptNotationInstructions(),
    '',
    'Hard requirements:',
    '- Output JSON must have version, source, categories.',
    `- Include exactly one rule whose sourceText is exactly the selected text below.`,
    '- The replacement must preserve the meaning, tone, terminology, and factual claims.',
    `- Adjust the replacement length toward ${targetPercent}% of the selected text. Target about ${targetChars} Korean characters; naturalness is more important than exact count.`,
    '- If shortening, remove redundancy rather than changing the point.',
    '- If lengthening, add clarifying connective detail grounded only in the provided context. Do not invent facts.',
    '- Return no notes outside JSON.',
    '- Use category id "ai-sentence-suggestions" and label "AI 문장 제안".',
    '',
    'Document metadata:',
    JSON.stringify(meta, null, 2),
    '',
    'Context before selection:',
    '<<<TOYTYPE_CONTEXT_BEFORE',
    contextBefore,
    'TOYTYPE_CONTEXT_BEFORE',
    '',
    'Selected text:',
    '<<<TOYTYPE_SELECTED_TEXT',
    selectedText,
    'TOYTYPE_SELECTED_TEXT',
    '',
    'Context after selection:',
    '<<<TOYTYPE_CONTEXT_AFTER',
    contextAfter,
    'TOYTYPE_CONTEXT_AFTER',
    '',
    'Required JSON shape:',
    JSON.stringify({
      version: 'YYYY-MM-DD',
      source: 'sentence-suggestions:' + title,
      categories: [{
        id: SENTENCE_SUGGESTION_CATEGORY_ID,
        label: SENTENCE_SUGGESTION_CATEGORY_LABEL,
        defaultOn: true,
        rules: [[selectedText, 'length-adjusted replacement']]
      }]
    }, null, 2)
  ].join('\n');
}

function cheapModelForProvider(provider, settings) {
  return provider === 'claude' ? settings.questionClaudeModel : settings.questionCodexModel;
}

function projectSpecificRuleInstructions() {
  return `Toytype project-specific rules (high priority):
- The built-in rules intentionally prefer 붙여쓰기 for many auxiliary-verb-style forms. Do not "correct" these into spaced forms.
- Keep forms like "해두면", "해둔", "해둡니다", "해주면", "해준", "해줍니다", "해줄", "해보면", "해본", "해볼", "해냈", "해넣" as joined text when they already appear joined.
- Do not propose replacements such as "해두면" ➝ "해 두면", "해주면" ➝ "해 주면", "...어두면" ➝ "...어 두면", "...아두면" ➝ "...아 두면", or "...여두면" ➝ "...여 두면".
- The same applies to project rules that join "어 보/어 주/어 둡" style fragments into "어보/어주/어둡". Treat those joined forms as intentional Toytype style, not spacing errors.
- Do not make style-only compression rules such as "하기 위해서" ➝ "하려면". Keep "하기 위해서" unless there is a concrete 비문 or content problem beyond length/style preference.
- When a candidate is only generic Korean spacing advice and conflicts with these house rules, omit it.`;
}

function manuscriptNotationInstructions() {
  return `Manuscript notation rules (high priority):
- Use "➝" as the only arrow symbol in generated or replacement text. Do not use "->", "→", "⇒", or "=>".
- Wrap buttons, menu items that must be clicked, and keyboard shortcuts/keys in square brackets. Examples: [확인], [Code 탭], [Enter], [⌘S].
- For Mac keyboard shortcuts, use "⌥" for Option and "⌘" for Command. Do not spell those modifier keys as Option, 옵션, Command, 커맨드, or Cmd in replacement text.
- For Toytype JSON rules, sourceText must still be copied exactly from the document even when it violates these notation rules. Apply these rules to replacementText, generated 발문 text, and notes.`;
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
- Use these category labels when possible: book-editing-proofread = "원고 교열", book-editing-terms = "용어 일관성", book-editing-technical = "기술 및 내용 정확성", book-editing-format = "형식".
- Every rule in book-editing-technical must have a matching notes item whose category/source/replacement match the rule and whose reason explains why the correction is needed.
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

function normalizeGeneratedQuestionText(text) {
  let out = String(text || '').trim();
  out = out.replace(/^```(?:text|markdown|md)?\s*/i, '').replace(/\s*```$/i, '').trim();
  out = out.replace(/^(?:발문|AI\s*발문|삽입\s*발문)\s*[:：]\s*/i, '').trim();
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'"))) {
    out = out.slice(1, -1).trim();
  }
  out = out
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*[-*]\s+/, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!out) throw new HttpError(502, 'AI response did not contain question text', { responseTail: tail(text) });
  return out;
}

function firstReplacementFromToytypeJson(json) {
  if (!json || typeof json !== 'object') return '';
  if (typeof json.replacement === 'string' && json.replacement.trim()) return json.replacement;
  if (typeof json.text === 'string' && json.text.trim()) return json.text;
  if (!Array.isArray(json.categories)) return '';
  for (const cat of json.categories) {
    if (!cat || !Array.isArray(cat.rules)) continue;
    for (const rule of cat.rules) {
      if (Array.isArray(rule) && typeof rule[1] === 'string' && rule[1].trim()) {
        return rule[1];
      }
    }
  }
  return '';
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

function extractImagesFromDocx(body) {
  const document = body.document && typeof body.document === 'object' ? body.document : {};
  if (!document.id) document.id = extractDocId(document.url);
  const base64 = typeof document.docxBase64 === 'string' ? document.docxBase64 : '';
  if (!base64.trim()) throw new HttpError(400, 'document.docxBase64 is required');

  let docx = null;
  try {
    docx = Buffer.from(base64, 'base64');
  } catch (_) {
    throw new HttpError(400, 'invalid docxBase64');
  }
  if (!docx || docx.length < 64) throw new HttpError(400, 'empty DOCX payload');

  const zip = readZipEntries(docx);
  const relationships = parseDocxRelationships(zip);
  const orderedTargets = parseDocxImageTargets(zip, relationships);
  const images = [];
  const skippedImages = [];
  for (const target of orderedTargets) {
    const entry = zip.get(target) || zip.get(decodeURIComponentSafe(target));
    if (!entry || entry.dir) continue;
    const data = inflateZipEntry(docx, entry);
    const skipReason = skipExtractedImageReason(target, data);
    if (skipReason) {
      skippedImages.push({ sourcePath: target, reason: skipReason, bytes: data.length });
      continue;
    }
    images.push({
      sourcePath: target,
      data
    });
  }

  if (!images.length) {
    return {
      ok: true,
      imageCount: 0,
      docxBytes: docx.length,
      fileName: '',
      displayName: '',
      outputPath: '',
      skippedImageCount: skippedImages.length,
      skippedImages
    };
  }

  const width = Math.max(3, String(images.length).length);
  const files = images.map((image, index) => ({
    name: String(index + 1).padStart(width, '0') + imageExtension(image.sourcePath, image.data),
    data: image.data
  }));
  const zipBuffer = createStoredZip(files);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const docId = sanitizeFilename(document.id || extractDocId(document.url) || document.title || 'document');
  const fileName = `${docId}-images-${stamp}.zip`;
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toytype-images-'));
  const outputPath = path.join(outputDir, fileName);
  fs.writeFileSync(outputPath, zipBuffer);
  const download = createDownloadToken(outputPath, fileName, 'application/zip', {
    deleteAfterDownload: true,
    cleanupDir: outputDir
  });
  return {
    ok: true,
    imageCount: images.length,
    skippedImageCount: skippedImages.length,
    docxBytes: docx.length,
    zipBytes: zipBuffer.length,
    fileName,
    displayName: `이미지-${stamp}.zip`,
    outputPath,
    temporary: true,
    downloadToken: download.token,
    downloadUrlPath: download.urlPath,
    files: files.map((file, index) => ({
      fileName: file.name,
      sourcePath: images[index].sourcePath,
      bytes: file.data.length
    })),
    skippedImages
  };
}

function readZipEntries(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const total = buffer.readUInt16LE(eocdOffset + 10);
  const cdSize = buffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (cdOffset + cdSize > buffer.length) throw new HttpError(400, 'invalid DOCX central directory');
  const entries = new Map();
  entries.buffer = buffer;
  let offset = cdOffset;
  for (let i = 0; i < total; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new HttpError(400, 'invalid DOCX central directory entry');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nameBuffer = buffer.subarray(offset + 46, offset + 46 + nameLength);
    const name = nameBuffer.toString(flags & 0x0800 ? 'utf8' : 'utf8');
    entries.set(normalizeZipPath(name), {
      name: normalizeZipPath(name),
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      dir: /\/$/.test(name)
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(buffer) {
  const min = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= min; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new HttpError(400, 'invalid DOCX zip footer');
}

function inflateZipEntry(zipBuffer, entry) {
  if (zipBuffer.readUInt32LE(entry.localOffset) !== 0x04034b50) throw new HttpError(400, 'invalid DOCX local header');
  const nameLength = zipBuffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = zipBuffer.readUInt16LE(entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > zipBuffer.length) throw new HttpError(400, 'invalid DOCX entry size');
  const compressed = zipBuffer.subarray(dataStart, dataEnd);
  if (entry.method === 0) return Buffer.from(compressed);
  if (entry.method === 8) return zlib.inflateRawSync(compressed);
  throw new HttpError(400, 'unsupported DOCX compression method: ' + entry.method);
}

function readZipText(zip, zipBuffer, fileName) {
  const entry = zip.get(fileName);
  if (!entry || entry.dir) return '';
  return inflateZipEntry(zipBuffer, entry).toString('utf8');
}

function parseDocxRelationships(zip) {
  const relEntry = zip.get('word/_rels/document.xml.rels');
  if (!relEntry) throw new HttpError(400, 'DOCX document relationships not found');
  const relXml = inflateZipEntryFromMap(zip, relEntry).toString('utf8');
  const out = new Map();
  const relRe = /<Relationship\b[^>]*>/g;
  let match = null;
  while ((match = relRe.exec(relXml)) !== null) {
    const attrs = xmlAttrs(match[0]);
    const id = attrs.Id || attrs.id;
    const type = attrs.Type || attrs.type || '';
    const target = attrs.Target || attrs.target || '';
    const targetMode = attrs.TargetMode || attrs.targetMode || '';
    if (!id || !target || targetMode === 'External' || !/\/image$/i.test(type)) continue;
    out.set(id, normalizeRelationshipTarget('word', target));
  }
  return out;
}

function inflateZipEntryFromMap(zip, entry) {
  const source = zip.buffer;
  if (source) return inflateZipEntry(source, entry);
  throw new HttpError(500, 'zip source buffer missing');
}

function parseDocxImageTargets(zip, relationships) {
  const docEntry = zip.get('word/document.xml');
  if (!docEntry) throw new HttpError(400, 'DOCX document.xml not found');
  const documentXml = inflateZipEntryFromMap(zip, docEntry).toString('utf8');
  const targets = [];
  const tagRe = /<(?:a:blip|asvg:svgBlip|v:imagedata)\b[^>]*>/g;
  let match = null;
  while ((match = tagRe.exec(documentXml)) !== null) {
    const attrs = xmlAttrs(match[0]);
    const relId = attrs['r:embed'] || attrs['r:id'] || attrs['r:link'];
    const target = relId && relationships.get(relId);
    if (target) targets.push(target);
  }
  return targets;
}

function xmlAttrs(tag) {
  const attrs = {};
  const attrRe = /([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g;
  let match = null;
  while ((match = attrRe.exec(tag)) !== null) {
    attrs[match[1]] = decodeXmlAttr(match[2]);
  }
  return attrs;
}

function decodeXmlAttr(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function normalizeRelationshipTarget(baseDir, target) {
  const raw = String(target || '').replace(/\\/g, '/');
  if (raw.startsWith('/')) return normalizeZipPath(raw.slice(1));
  return normalizeZipPath(path.posix.join(baseDir, raw));
}

function normalizeZipPath(value) {
  return path.posix.normalize(String(value || '').replace(/\\/g, '/')).replace(/^(\.\.\/)+/, '');
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

function imageExtension(sourcePath, data) {
  const ext = path.posix.extname(String(sourcePath || '')).toLowerCase();
  if (/^\.(png|jpe?g|gif|bmp|webp|tiff?|svg|emf|wmf)$/.test(ext)) return ext === '.jpeg' ? '.jpg' : ext;
  if (data && data.length >= 12) {
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return '.png';
    if (data[0] === 0xff && data[1] === 0xd8) return '.jpg';
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return '.gif';
    if (data[0] === 0x42 && data[1] === 0x4d) return '.bmp';
    if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  }
  return '.bin';
}

function skipExtractedImageReason(sourcePath, data) {
  if (!data || data.length === 0) return 'empty-file';
  const size = imageDimensions(sourcePath, data);
  if (size && size.width <= 2 && size.height <= 2) return 'tiny-placeholder';
  return '';
}

function imageDimensions(sourcePath, data) {
  const ext = path.posix.extname(String(sourcePath || '')).toLowerCase();
  if (ext === '.png' || (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47)) {
    if (data.length >= 24) return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    return null;
  }
  if (ext === '.gif' || (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46)) {
    if (data.length >= 10) return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
    return null;
  }
  if (ext === '.bmp' || (data[0] === 0x42 && data[1] === 0x4d)) {
    if (data.length >= 26) return { width: Math.abs(data.readInt32LE(18)), height: Math.abs(data.readInt32LE(22)) };
    return null;
  }
  if (ext === '.jpg' || ext === '.jpeg' || (data[0] === 0xff && data[1] === 0xd8)) {
    return jpegDimensions(data);
  }
  return null;
}

function jpegDimensions(data) {
  if (!data || data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = data[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const length = data.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > data.length) break;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
    }
    offset += 2 + length;
  }
  return null;
}

function createStoredZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { time, date } = dosDateTime(new Date());
  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data || '');
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuffer.copy(local, 30);
    localParts.push(local, data);

    const central = Buffer.alloc(46 + nameBuffer.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuffer.copy(central, 46);
    centralParts.push(central);
    offset += local.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat(localParts.concat(centralParts, eocd));
}

function dosDateTime(dateObj) {
  const date = dateObj instanceof Date ? dateObj : new Date();
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function crc32(buffer) {
  const table = crc32Table();
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = table[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function crc32Table() {
  if (crc32TableCache) return crc32TableCache;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  crc32TableCache = table;
  return table;
}

function createDownloadToken(outputPath, fileName, contentType, options = {}) {
  pruneDownloadTokens();
  const token = randomUUID();
  downloadTokens.set(token, {
    outputPath,
    fileName,
    contentType: contentType || 'application/octet-stream',
    deleteAfterDownload: options.deleteAfterDownload === true,
    cleanupDir: typeof options.cleanupDir === 'string' ? options.cleanupDir : '',
    expiresAt: Date.now() + DOWNLOAD_TOKEN_TTL_MS
  });
  return {
    token,
    urlPath: '/fs/download?token=' + encodeURIComponent(token)
  };
}

function pruneDownloadTokens() {
  const now = Date.now();
  for (const [token, entry] of downloadTokens) {
    if (!entry || entry.expiresAt <= now) {
      cleanupDownloadEntry(entry);
      downloadTokens.delete(token);
    }
  }
}

function sendDownload(res, url) {
  pruneDownloadTokens();
  const token = url.searchParams.get('token') || '';
  const entry = downloadTokens.get(token);
  if (!entry) throw new HttpError(404, 'download token not found or expired');
  if (entry.expiresAt <= Date.now()) {
    downloadTokens.delete(token);
    throw new HttpError(404, 'download token expired');
  }
  let stat = null;
  try {
    stat = fs.statSync(entry.outputPath);
  } catch (_) {
    throw new HttpError(404, 'download file not found');
  }
  if (!stat.isFile()) throw new HttpError(404, 'download target is not a file');
  res.writeHead(200, {
    'content-type': entry.contentType,
    'content-length': String(stat.size),
    'content-disposition': contentDispositionAttachment(entry.fileName),
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-private-network': 'true'
  });
  const stream = fs.createReadStream(entry.outputPath);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    downloadTokens.delete(token);
    cleanupDownloadEntry(entry);
  };
  stream.on('close', cleanup);
  stream.on('error', cleanup);
  res.on('close', cleanup);
  stream.pipe(res);
}

function cleanupDownloadEntry(entry) {
  if (!entry || entry.deleteAfterDownload !== true) return;
  try {
    if (entry.outputPath) fs.rmSync(entry.outputPath, { force: true });
  } catch (_) {}
  try {
    if (entry.cleanupDir) fs.rmSync(entry.cleanupDir, { recursive: true, force: true });
  } catch (_) {}
}

function contentDispositionAttachment(fileName) {
  const safe = String(fileName || 'download.bin').replace(/[\\/\r\n"]/g, '_');
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeRFC5987ValueChars(safe)}`;
}

function encodeRFC5987ValueChars(value) {
  return encodeURIComponent(value).replace(/['()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
}

function sentenceSuggestionFileName(document) {
  const docId = sanitizeFilename(document && (document.id || extractDocId(document.url)) || 'document');
  return `${docId}-문장제안.json`;
}

function isSentenceSuggestionFileName(fileName) {
  return /-문장제안\.json$/i.test(String(fileName || ''));
}

function createSentenceSuggestionJson(document) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    version: today,
    source: 'sentence-suggestions:' + (document.title || document.id || 'Google Docs document'),
    categories: [{
      id: SENTENCE_SUGGESTION_CATEGORY_ID,
      label: SENTENCE_SUGGESTION_CATEGORY_LABEL,
      defaultOn: true,
      rules: []
    }],
    notes: [],
    documentId: document.id || '',
    documentTitle: document.title || '',
    documentUrl: document.url || ''
  };
}

function sentenceSuggestionCategory(json) {
  if (!json || typeof json !== 'object') throw new HttpError(502, 'Toytype JSON must be an object');
  if (!Array.isArray(json.categories)) json.categories = [];
  let cat = json.categories.find(item => item && item.id === SENTENCE_SUGGESTION_CATEGORY_ID);
  if (!cat) {
    cat = {
      id: SENTENCE_SUGGESTION_CATEGORY_ID,
      label: SENTENCE_SUGGESTION_CATEGORY_LABEL,
      defaultOn: true,
      rules: []
    };
    json.categories.push(cat);
  }
  if (!Array.isArray(cat.rules)) cat.rules = [];
  if (!cat.label) cat.label = SENTENCE_SUGGESTION_CATEGORY_LABEL;
  return cat;
}

function buildSentenceSuggestionJson(document, rule, note) {
  const json = createSentenceSuggestionJson(document);
  sentenceSuggestionCategory(json).rules.push(rule);
  if (note && typeof note === 'object') json.notes.push(note);
  return validateToytypeJson(json);
}

function appendSentenceSuggestionJson(incoming, document, settings) {
  fs.mkdirSync(settings.outputDir, { recursive: true });
  const fileName = sentenceSuggestionFileName(document);
  const outputPath = path.join(settings.outputDir, fileName);
  let json = createSentenceSuggestionJson(document);
  try {
    if (fs.existsSync(outputPath)) {
      json = validateToytypeJson(normalizeGeneratedToytypeJson(JSON.parse(fs.readFileSync(outputPath, 'utf8')), document));
    }
  } catch (_) {
    json = createSentenceSuggestionJson(document);
  }

  json.version = new Date().toISOString().slice(0, 10);
  json.source = 'sentence-suggestions:' + (document.title || document.id || 'Google Docs document');
  json.documentId = document.id || '';
  json.documentTitle = document.title || '';
  json.documentUrl = document.url || '';
  if (!Array.isArray(json.notes)) json.notes = [];

  const target = sentenceSuggestionCategory(json);
  const seen = new Set(target.rules.map(rule => JSON.stringify(rule)));
  for (const cat of incoming.categories || []) {
    if (!cat || !Array.isArray(cat.rules)) continue;
    for (const rule of cat.rules) {
      if (!Array.isArray(rule) || typeof rule[0] !== 'string' || typeof rule[1] !== 'string') continue;
      if (!rule[0].trim() || rule[0] === rule[1]) continue;
      const nextRule = rule.length === 3 && validRuleOptions(rule[2])
        ? [rule[0], rule[1], cloneRuleOptions(rule[2])]
        : [rule[0], rule[1]];
      const key = JSON.stringify(nextRule);
      if (seen.has(key)) continue;
      seen.add(key);
      target.rules.push(nextRule);
    }
  }
  if (Array.isArray(incoming.notes)) {
    json.notes.push(...incoming.notes.filter(note => note && typeof note === 'object'));
  }
  validateToytypeJson(json);
  fs.writeFileSync(outputPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
  return { fileName, displayName: generatedJsonDisplayName(fileName), outputPath, json };
}

function deleteSentenceSuggestionRule(body) {
  const settings = mergeSettings(body.settings);
  const document = body.document && typeof body.document === 'object' ? body.document : {};
  if (!document.id) document.id = extractDocId(document.url);
  const request = body.rule && typeof body.rule === 'object' ? body.rule : {};
  const sourceText = typeof request.sourceText === 'string' ? request.sourceText : '';
  const replacementText = typeof request.replacementText === 'string' ? request.replacementText : '';
  const categoryId = typeof request.categoryId === 'string' && request.categoryId ? request.categoryId : SENTENCE_SUGGESTION_CATEGORY_ID;
  const ruleIndex = Number.isInteger(Number(request.ruleIndex)) ? Number(request.ruleIndex) : -1;
  if (!sourceText && !replacementText) throw new HttpError(400, 'rule.sourceText or rule.replacementText is required');

  const fileName = sentenceSuggestionFileName(document);
  const outputPath = path.join(settings.outputDir, fileName);
  let json = null;
  try {
    json = validateToytypeJson(normalizeGeneratedToytypeJson(JSON.parse(fs.readFileSync(outputPath, 'utf8')), document));
  } catch (error) {
    throw new HttpError(404, 'sentence suggestion JSON not found', { fileName, outputPath });
  }

  const cat = json.categories.find(item => item && item.id === categoryId && Array.isArray(item.rules));
  if (!cat) throw new HttpError(404, 'sentence suggestion category not found', { fileName, categoryId });

  let deleteIndex = -1;
  if (ruleIndex >= 0 && ruleIndex < cat.rules.length && sentenceSuggestionRuleMatches(cat.rules[ruleIndex], request)) {
    deleteIndex = ruleIndex;
  } else {
    deleteIndex = cat.rules.findIndex(rule => sentenceSuggestionRuleMatches(rule, request));
  }
  if (deleteIndex < 0) {
    throw new HttpError(404, 'sentence suggestion rule not found', {
      fileName,
      categoryId,
      sourceText,
      replacementText
    });
  }

  const removed = cat.rules.splice(deleteIndex, 1)[0];
  const removedNotes = pruneSentenceSuggestionNotes(json, categoryId, removed);
  json.version = new Date().toISOString().slice(0, 10);
  json.documentId = document.id || json.documentId || '';
  json.documentTitle = document.title || json.documentTitle || '';
  json.documentUrl = document.url || json.documentUrl || '';
  fs.writeFileSync(outputPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
  return {
    ok: true,
    deleted: true,
    fileName,
    displayName: generatedJsonDisplayName(fileName),
    outputPath,
    json,
    removedRule: removed,
    removedNotes,
    ruleCount: countRules(json)
  };
}

function pruneSentenceSuggestionNotes(json, categoryId, rule) {
  if (!json || !Array.isArray(json.notes) || !Array.isArray(rule)) return 0;
  const before = json.notes.length;
  json.notes = json.notes.filter(note => !sentenceSuggestionNoteMatchesRule(note, categoryId, rule));
  return before - json.notes.length;
}

function sentenceSuggestionNoteMatchesRule(note, categoryId, rule) {
  if (!note || typeof note !== 'object') return false;
  const noteCategory = typeof note.category === 'string' ? note.category : note.categoryId;
  if (noteCategory && noteCategory !== categoryId) return false;
  const source = typeof note.source === 'string' ? note.source : note.sourceText;
  const replacement = typeof note.replacement === 'string' ? note.replacement : note.replacementText;
  return source === rule[0] && replacement === rule[1];
}

function sentenceSuggestionRuleMatches(rule, request) {
  if (!Array.isArray(rule) || typeof rule[0] !== 'string' || typeof rule[1] !== 'string') return false;
  if (typeof request.sourceText === 'string' && rule[0] !== request.sourceText) return false;
  if (typeof request.replacementText === 'string' && rule[1] !== request.replacementText) return false;
  if (request.options && validRuleOptions(request.options)) {
    const options = rule.length === 3 && validRuleOptions(rule[2]) ? cloneRuleOptions(rule[2]) : {};
    return JSON.stringify(options) === JSON.stringify(cloneRuleOptions(request.options));
  }
  return true;
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
    if (isSentenceSuggestionFileName(name)) continue;
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
  if (isSentenceSuggestionFileName(fileName)) return '문장제안.json';
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

function generatedCleanupDays(value) {
  const n = Number(value);
  if (GENERATED_CLEANUP_DAYS.includes(n)) return n;
  throw new HttpError(400, 'invalid cleanup days', {
    allowedDays: GENERATED_CLEANUP_DAYS
  });
}

function isGeneratedCleanupFileName(fileName) {
  const name = String(fileName || '');
  return isSentenceSuggestionFileName(name) || !!extractGeneratedJsonStamp(name);
}

function cleanupGeneratedJsonFiles(body) {
  const settings = mergeSettings(body.settings);
  const days = generatedCleanupDays(body.days);
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  let names = [];
  try {
    names = fs.readdirSync(settings.outputDir);
  } catch (_) {
    return {
      ok: true,
      cleaned: true,
      outputDir: settings.outputDir,
      days,
      cutoffMs,
      deleted: 0,
      skipped: 0,
      ignored: 0,
      deletedFiles: []
    };
  }

  let skipped = 0;
  let ignored = 0;
  const deletedFiles = [];
  for (const name of names) {
    if (!/\.json$/i.test(name) || !isGeneratedCleanupFileName(name)) {
      ignored++;
      continue;
    }
    const filePath = path.join(settings.outputDir, name);
    let stat = null;
    let json = null;
    try {
      stat = fs.lstatSync(filePath);
      if (!stat.isFile()) {
        skipped++;
        continue;
      }
      if (stat.mtimeMs >= cutoffMs) {
        skipped++;
        continue;
      }
      json = validateToytypeJson(normalizeGeneratedToytypeJson(JSON.parse(fs.readFileSync(filePath, 'utf8')), {}));
      fs.unlinkSync(filePath);
      deletedFiles.push({
        fileName: name,
        displayName: generatedJsonDisplayName(name),
        mtimeMs: stat.mtimeMs,
        ruleCount: countRules(json)
      });
    } catch (_) {
      skipped++;
    }
  }

  return {
    ok: true,
    cleaned: true,
    outputDir: settings.outputDir,
    days,
    cutoffMs,
    deleted: deletedFiles.length,
    skipped,
    ignored,
    deletedFiles: deletedFiles.slice(0, 100),
    deletedFilesTruncated: deletedFiles.length > 100
  };
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

  const totalTimeoutMs = clampNumber(body.timeoutMs, settings.requestTimeoutMs, 30000, settings.requestTimeoutMs);
  const factCheck = await runProofreadFactCheck(document, settings, provider, totalTimeoutMs);
  const remainingTimeoutMs = Math.max(30000, totalTimeoutMs - Math.ceil(Number(factCheck.elapsedMs || 0)) - 5000);
  const prompt = buildProofreadPrompt(document, settings, factCheck);
  bridgeLog('AI proofread main start', {
    provider,
    docId: document.id || extractDocId(document.url),
    title: document.title,
    textChars: countChars(document.text),
    timeoutMs: remainingTimeoutMs
  });
  const run = await runProvider(provider, prompt, settings, { timeoutMs: remainingTimeoutMs });
  if (!run.ok) {
    bridgeError('AI proofread main failed', {
      provider,
      elapsedMs: run.elapsedMs,
      exitCode: run.exitCode,
      timedOut: run.timedOut
    });
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
    factCheck: {
      enabled: factCheck.enabled,
      provider: factCheck.provider,
      model: factCheck.model,
      elapsedMs: factCheck.elapsedMs,
      webAccess: factCheck.report && factCheck.report.webAccess || '',
      claimCount: factCheck.report && Array.isArray(factCheck.report.claims) ? factCheck.report.claims.length : 0
    },
    fileName: file.fileName,
    displayName: file.displayName,
    outputPath: file.outputPath,
    elapsedMs: run.elapsedMs,
    stdoutTail: tail(run.stdout, 1200),
    stderrTail: tail(run.stderr, 1200)
  };
}

async function generateQuestion(body) {
  const settings = mergeSettings(body.settings);
  const provider = body.provider === 'claude' ? 'claude' : settings.provider;
  const document = body.document && typeof body.document === 'object' ? body.document : {};
  if (!document.id) document.id = extractDocId(document.url);
  const hasBefore = typeof document.contextBefore === 'string' || typeof document.textBefore === 'string';
  const hasAfter = typeof document.contextAfter === 'string' || typeof document.textAfter === 'string';
  if (!hasBefore && !hasAfter) {
    throw new HttpError(400, 'document.contextBefore or document.contextAfter is required');
  }

  const insertionSource = String(document.insertionSource || '');
  const insertionPrefixLength = clampNumber(document.insertionPrefixLength, 0, 0, insertionSource.length);
  if (!insertionSource.trim()) {
    throw new HttpError(400, 'document.insertionSource is required for suggestion JSON');
  }

  const prompt = buildQuestionPrompt(document, settings);
  const model = cheapModelForProvider(provider, settings);
  const run = await runProvider(provider, prompt, settings, {
    model,
    reasoningEffort: provider === 'codex' ? settings.questionCodexReasoningEffort : undefined,
    timeoutMs: clampNumber(body.timeoutMs, Math.min(settings.requestTimeoutMs, 180000), 5000, settings.requestTimeoutMs)
  });
  if (!run.ok) {
    throw new HttpError(502, `${provider} exited with code ${run.exitCode}`, {
      exitCode: run.exitCode,
      signal: run.signal,
      timedOut: run.timedOut,
      model,
      stdout: tail(run.stdout),
      stderr: tail(run.stderr)
    });
  }
  const text = normalizeGeneratedQuestionText(run.response);
  const replacement = insertionSource.slice(0, insertionPrefixLength) + text + insertionSource.slice(insertionPrefixLength);
  const json = buildSentenceSuggestionJson(document, [insertionSource, replacement], {
    category: SENTENCE_SUGGESTION_CATEGORY_ID,
    type: 'ai-question',
    source: insertionSource,
    replacement,
    createdAt: new Date().toISOString(),
    reason: '커서 위치 기준 AI 발문 삽입 제안'
  });
  const file = appendSentenceSuggestionJson(json, document, settings);
  return {
    ok: true,
    provider,
    model,
    text,
    json: file.json,
    ruleCount: countRules(file.json),
    fileName: file.fileName,
    displayName: file.displayName,
    outputPath: file.outputPath,
    chars: Array.from(text).length,
    elapsedMs: run.elapsedMs,
    stdoutTail: tail(run.stdout, 1200),
    stderrTail: tail(run.stderr, 1200)
  };
}

async function generateLengthAdjustment(body) {
  const settings = mergeSettings(body.settings);
  const provider = body.provider === 'claude' ? 'claude' : settings.provider;
  const document = body.document && typeof body.document === 'object' ? body.document : {};
  if (!document.id) document.id = extractDocId(document.url);
  const selectedText = String(document.selectedText || '');
  const targetPercent = clampNumber(document.targetPercent, 100, 10, 500);
  if (!selectedText.trim()) throw new HttpError(400, 'document.selectedText is required');

  const prompt = buildLengthAdjustmentPrompt(Object.assign({}, document, { targetPercent }));
  const model = cheapModelForProvider(provider, settings);
  const run = await runProvider(provider, prompt, settings, {
    model,
    reasoningEffort: provider === 'codex' ? settings.questionCodexReasoningEffort : undefined,
    timeoutMs: clampNumber(body.timeoutMs, Math.min(settings.requestTimeoutMs, 180000), 5000, settings.requestTimeoutMs)
  });
  if (!run.ok) {
    throw new HttpError(502, `${provider} exited with code ${run.exitCode}`, {
      exitCode: run.exitCode,
      signal: run.signal,
      timedOut: run.timedOut,
      model,
      stdout: tail(run.stdout),
      stderr: tail(run.stderr)
    });
  }

  const aiJson = extractJsonObject(run.response);
  const replacement = firstReplacementFromToytypeJson(aiJson);
  if (!replacement.trim()) {
    throw new HttpError(502, 'AI response did not contain a replacement', { responseTail: tail(run.response) });
  }
  const json = buildSentenceSuggestionJson(document, [selectedText, replacement], {
    category: SENTENCE_SUGGESTION_CATEGORY_ID,
    type: 'length-adjustment',
    targetPercent,
    source: selectedText,
    replacement,
    createdAt: new Date().toISOString(),
    reason: `선택 문장 길이 ${targetPercent}% 조절`
  });
  const file = appendSentenceSuggestionJson(json, document, settings);
  return {
    ok: true,
    provider,
    model,
    json: file.json,
    ruleCount: countRules(file.json),
    fileName: file.fileName,
    displayName: file.displayName,
    outputPath: file.outputPath,
    targetPercent,
    sourceChars: Array.from(selectedText).length,
    replacementChars: Array.from(replacement).length,
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
    'access-control-allow-private-network': 'true',
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

async function sendLoggedAiJson(res, action, body, handler) {
  const startedAt = Date.now();
  bridgeLog(`${action} start`, aiRequestLogFields(body));
  try {
    const payload = await handler(body);
    bridgeLog(`${action} done`, aiResultLogFields(payload, Date.now() - startedAt));
    sendJson(res, 200, payload);
  } catch (error) {
    bridgeError(`${action} failed`, aiErrorLogFields(error, Date.now() - startedAt));
    throw error;
  }
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
  if (req.method === 'GET' && url.pathname === '/fs/download') {
    sendDownload(res, url);
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
    await sendLoggedAiJson(res, 'AI proofread', body, generateProofread);
    return;
  }
  if (url.pathname === '/ai/question') {
    await sendLoggedAiJson(res, 'AI question', body, generateQuestion);
    return;
  }
  if (url.pathname === '/ai/adjust-length') {
    await sendLoggedAiJson(res, 'AI adjust-length', body, generateLengthAdjustment);
    return;
  }
  if (url.pathname === '/docs/extract-images') {
    sendJson(res, 200, extractImagesFromDocx(body));
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
  if (url.pathname === '/fs/cleanup-generated') {
    sendJson(res, 200, cleanupGeneratedJsonFiles(body));
    return;
  }
  if (url.pathname === '/fs/delete-sentence-suggestion') {
    sendJson(res, 200, deleteSentenceSuggestionRule(body));
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
      console.error(`Restart: node tools/toytype_ai_bridge_ctl.mjs restart --port ${port}`);
      console.error(`Stop:    node tools/toytype_ai_bridge_ctl.mjs stop --port ${port}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Toytype AI bridge: http://127.0.0.1:${port}`);
    console.log('Mode: foreground server. Keep this terminal open; press [Ctrl-C] to stop.');
    console.log('Restart from another terminal (background):');
    console.log(`  node tools/toytype_ai_bridge_ctl.mjs restart --port ${port}`);
    console.log(`Stop: node tools/toytype_ai_bridge_ctl.mjs stop --port ${port}`);
    console.log(`Log after background restart: tail -f /tmp/toytype-ai-bridge-${port}.log`);
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
