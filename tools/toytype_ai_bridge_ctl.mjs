#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = Number(process.env.TOYTYPE_AI_BRIDGE_PORT || 17644);
const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_PATH = path.join(TOOL_DIR, 'toytype_ai_bridge.mjs');

function parseArgs(argv) {
  const args = argv.slice(2);
  let command = 'restart';
  if (args[0] && !args[0].startsWith('-')) command = args.shift();
  const portIndex = args.indexOf('--port');
  const port = portIndex !== -1 ? Number(args[portIndex + 1]) : DEFAULT_PORT;
  const foreground = args.includes('--foreground') || args.includes('--fg');
  return {
    command,
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT,
    background: !foreground
  };
}

function bridgeLogPath(port) {
  return `/tmp/toytype-ai-bridge-${port}.log`;
}

function printControlCommands(port) {
  console.log(`Stop:    node tools/toytype_ai_bridge_ctl.mjs stop --port ${port}`);
  console.log(`Restart: node tools/toytype_ai_bridge_ctl.mjs restart --port ${port}`);
}

function listenPids(port) {
  const result = spawnSync('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN'], {
    encoding: 'utf8'
  });
  if (result.error) return [];
  return String(result.stdout || '')
    .split(/\s+/)
    .map(value => Number(value))
    .filter(pid => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function stopPort(port) {
  const initial = listenPids(port);
  for (const pid of initial) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (_) {
      // Already gone.
    }
  }
  for (let i = 0; i < 25; i++) {
    const remaining = listenPids(port);
    if (remaining.length === 0) return initial;
    await sleep(120);
  }
  throw new Error(`port ${port} is still in use by PID(s): ${listenPids(port).join(', ')}`);
}

function startForeground(port) {
  console.log(`Starting Toytype AI bridge on http://127.0.0.1:${port}`);
  console.log('Foreground mode: keep this terminal open. Press Ctrl-C to stop.');
  printControlCommands(port);
  const child = spawn(process.execPath, [BRIDGE_PATH, '--port', String(port)], {
    stdio: 'inherit'
  });
  child.on('exit', (code, signal) => {
    if (signal) process.exit(1);
    process.exit(Number.isInteger(code) ? code : 0);
  });
}

function startBackground(port) {
  const logPath = bridgeLogPath(port);
  const out = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [BRIDGE_PATH, '--port', String(port)], {
    detached: true,
    stdio: ['ignore', out, out]
  });
  child.unref();
  console.log(`Started Toytype AI bridge in background on http://127.0.0.1:${port}`);
  console.log(`PID: ${child.pid}`);
  printControlCommands(port);
  console.log(`Log: tail -f ${logPath}`);
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!['restart', 'stop', 'start'].includes(opts.command)) {
    console.error('Usage: node tools/toytype_ai_bridge_ctl.mjs [restart|stop|start] --port 17644 [--foreground]');
    process.exit(2);
  }

  if (opts.command === 'restart' || opts.command === 'stop') {
    const killed = await stopPort(opts.port);
    if (killed.length > 0) {
      console.log(`Stopped PID(s) on port ${opts.port}: ${killed.join(', ')}`);
    } else {
      console.log(`No bridge process was listening on port ${opts.port}.`);
    }
  }

  if (opts.command === 'stop') return;
  if (opts.background) startBackground(opts.port);
  else startForeground(opts.port);
}

main().catch(error => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
