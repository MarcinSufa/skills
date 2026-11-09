#!/usr/bin/env node
// Real registries + real `claude -p`: verdict and wall time per scenario. Not part of `npm test` (network, model quota).
// Usage: node test/bench.mjs [--runs N] > bench.json

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startRegistry } from './registry.mjs';

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), '../hooks/guard.mjs');
const runs = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 1;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function npmProject(installed) {
  const dir = tmp('scg-bench-');
  for (const [name, version] of Object.entries(installed)) {
    fs.mkdirSync(path.join(dir, 'node_modules', name), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }));
  }
  return dir;
}

function pyProject(name, version) {
  const dir = tmp('scg-bench-py-');
  execFileSync('uv', ['venv', '-q', path.join(dir, '.venv')]);
  execFileSync('uv', ['pip', 'install', '-q', '--no-deps', '--python', path.join(dir, '.venv/bin/python'), `${name}==${version}`]);
  return dir;
}

function extDir(id, version) {
  const dir = tmp('scg-bench-ext-');
  fs.mkdirSync(path.join(dir, `${id}-${version}`));
  return dir;
}

function guard(command, cwd, env) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn(process.execPath, [GUARD], { env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', () => {
      const ms = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
      const json = out ? JSON.parse(out) : null;
      const verdict = { deny: 'block', ask: 'ask' }[json?.hookSpecificOutput?.permissionDecision] ?? (json ? 'allow' : 'pass');
      resolve({ verdict, ms, reason: json?.hookSpecificOutput?.permissionDecisionReason ?? json?.systemMessage ?? '' });
    });
    child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd }));
  });
}

const registry = await startRegistry();
const exfilRegistry = await startRegistry({ published: { '1.0.0': 40, '1.0.1': 30, '1.0.3': 20 } });
const local = registry.env;
const scenarios = [
  { name: 'not an install', expect: 'pass', command: 'git status && npm run build', cwd: npmProject({}) },
  { name: 'fixture: benign patch', expect: 'allow', command: 'npm i scg-demo@1.0.1', cwd: npmProject({ 'scg-demo': '1.0.0' }), env: local },
  { name: 'fixture: trojaned npm update', expect: 'block', command: 'npm i scg-demo@1.0.2', cwd: npmProject({ 'scg-demo': '1.0.1' }), env: local },
  { name: 'fixture: trojaned extension', expect: 'block', command: 'cursor --install-extension scgtest.scg-ext', cwd: npmProject({}), env: { ...local, SCG_EXTENSION_DIRS: extDir('scgtest.scg-ext', '2.1.311') } },
  { name: 'fixture: env exfiltration + prompt injection (signals below floor)', expect: 'block', command: 'npm i scg-demo@1.0.3', cwd: npmProject({ 'scg-demo': '1.0.1' }), env: exfilRegistry.env },
  { name: 'npm lodash 4.17.20 -> 4.17.21', expect: 'allow', command: 'npm i lodash@4.17.21', cwd: npmProject({ lodash: '4.17.20' }) },
  { name: 'npm chalk 5.3.0 -> 5.4.1', expect: 'allow', command: 'pnpm add chalk@5.4.1', cwd: npmProject({ chalk: '5.3.0' }) },
  { name: 'npm axios 1.7.7 -> 1.7.9', expect: 'allow', command: 'npm i axios@1.7.9', cwd: npmProject({ axios: '1.7.7' }) },
  { name: 'npm express 4.21.2 -> 5.1.0 (major)', expect: 'allow', command: 'npm i express@5.1.0', cwd: npmProject({ express: '4.21.2' }) },
  { name: 'npm new install: left-pad', expect: 'allow', command: 'npm i left-pad@1.3.0', cwd: npmProject({}) },
  { name: 'PyPI requests 2.32.2 -> 2.32.3', expect: 'allow', command: 'uv pip install requests==2.32.3', cwd: pyProject('requests', '2.32.2') },
  { name: 'Open VSX redhat.vscode-yaml 1.14.0 -> 1.15.0', expect: 'allow', command: 'cursor --install-extension redhat.vscode-yaml@1.15.0', cwd: npmProject({}), env: { SCG_EXTENSION_DIRS: extDir('redhat.vscode-yaml', '1.14.0') } },
];

const results = [];
for (const s of scenarios) {
  for (let i = 0; i < runs; i++) {
    const state = tmp('scg-bench-state-');
    const cold = await guard(s.command, s.cwd, { ...s.env, SCG_STATE_DIR: state });
    const cached = await guard(s.command, s.cwd, { ...s.env, SCG_STATE_DIR: state });
    results.push({ scenario: s.name, expect: s.expect, verdict: cold.verdict, ok: cold.verdict === s.expect, coldMs: cold.ms, cachedMs: cached.ms, reason: cold.reason });
    process.stderr.write(`${cold.verdict === s.expect ? 'ok  ' : 'MISS'} ${s.name}: ${cold.verdict} cold ${cold.ms} ms, cached ${cached.ms} ms\n`);
  }
}
await Promise.all([registry.close(), exfilRegistry.close()]);
process.stdout.write(JSON.stringify(results, null, 2));
