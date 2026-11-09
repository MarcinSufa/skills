import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startRegistry } from './registry.mjs';
import { FAKE_KEY, vsxVersions } from './fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(here, '../hooks/guard.mjs');
const FAKE_CLAUDE = path.join(here, 'fake-claude.mjs');
const tmp = (p = 'scg-e2e-') => fs.mkdtempSync(path.join(os.tmpdir(), p));

let registry;
before(async () => (registry = await startRegistry({ malicious: [] })));
after(() => registry.close());

function project(installed) {
  const dir = tmp('scg-proj-');
  if (installed) {
    fs.mkdirSync(path.join(dir, 'node_modules/scg-demo'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules/scg-demo/package.json'), JSON.stringify({ name: 'scg-demo', version: installed }));
  }
  return dir;
}

// The registry lives in this process, so the hook must run asynchronously or it would wait on a blocked server.
function spawnGuard(input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GUARD], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function runGuard(command, { cwd = project('1.0.0'), env = {}, reg = registry, tool = 'Bash' } = {}) {
  const log = path.join(tmp(), 'claude.jsonl');
  const started = process.hrtime.bigint();
  const res = await spawnGuard(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, cwd }), {
    ...process.env,
    ...reg.env,
    SCG_CLAUDE_BIN: FAKE_CLAUDE,
    SCG_STATE_DIR: tmp(),
    FAKE_CLAUDE_LOG: log,
    ...env,
  });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(res.status, 0, res.stderr);
  const out = res.stdout ? JSON.parse(res.stdout) : null;
  const prompts = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  const decision = out?.hookSpecificOutput?.permissionDecision ?? (out ? 'allow' : 'none');
  return { out, decision, prompts, ms };
}

test('a command that installs nothing returns no output and spawns no reviewer', async () => {
  const r = await runGuard('git status && npm run build');
  assert.equal(r.decision, 'none');
  assert.equal(r.prompts.length, 0);
});

test('a benign patch update is reviewed by Claude on its diff and allowed without overriding permissions', async () => {
  const r = await runGuard('npm install scg-demo@1.0.1');
  assert.equal(r.decision, 'allow');
  assert.equal(r.out.hookSpecificOutput, undefined);
  assert.match(r.out.systemMessage, /scg-demo 1\.0\.0 -> 1\.0\.1/);
  assert.equal(r.prompts.length, 1);
  assert.match(r.prompts[0].prompt, /\+exports\.greet = \(name\) => 'hello, '/);
  assert.ok(r.prompts[0].args.includes('--tools') && r.prompts[0].args[r.prompts[0].args.indexOf('--tools') + 1] === '');
});

test('the trojaned npm update is denied on its signals before Claude is asked', async () => {
  const r = await runGuard('cd app && npm i scg-demo@1.0.2', { cwd: project('1.0.1') });
  assert.equal(r.decision, 'deny');
  const reason = r.out.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /ssh-keys in install\.js/);
  assert.match(reason, /install-script in package\.json: "postinstall"/);
  assert.equal(r.prompts.length, 0);
});

test('the trojaned editor extension update is denied', async () => {
  const extDir = tmp('scg-ext-');
  fs.mkdirSync(path.join(extDir, 'scgtest.scg-ext-2.1.311'));
  const r = await runGuard('cursor --install-extension scgtest.scg-ext', { env: { SCG_EXTENSION_DIRS: extDir } });
  assert.equal(r.decision, 'deny');
  assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /scgtest\.scg-ext 2\.1\.311 -> 2\.1\.312[\s\S]*ssh-keys in extension\/extension\.js/);
});

test('Claude can make a verdict stricter but never looser than the signals', async () => {
  assert.equal((await runGuard('npm i scg-demo@1.0.1', { env: { FAKE_VERDICT: 'block' } })).decision, 'deny');
  assert.equal((await runGuard('npm i scg-demo@1.0.2', { cwd: project('1.0.1'), env: { FAKE_VERDICT: 'allow' } })).decision, 'deny');
});

test('a release younger than the cooldown asks even when everything else is clean', async () => {
  const fresh = await startRegistry({ published: { '1.0.0': 40, '1.0.1': 0.4 } });
  try {
    const r = await runGuard('pnpm add scg-demo', { reg: fresh });
    assert.equal(r.decision, 'ask');
    assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /fresh-release: published 0\.4 days ago, cooldown is 7/);
  } finally {
    await fresh.close();
  }
});

test('an OSV malware advisory blocks an otherwise clean update', async () => {
  const flagged = await startRegistry({ malicious: ['scg-demo@1.0.1'] });
  try {
    const r = await runGuard('npm i scg-demo@1.0.1', { reg: flagged });
    assert.equal(r.decision, 'deny');
    assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /MAL-2026-0001/);
  } finally {
    await flagged.close();
  }
});

test('every failure asks, none allows', async () => {
  const cases = {
    'reviewer crashes': { FAKE_VERDICT: 'crash' },
    'reviewer missing': { SCG_CLAUDE_BIN: '/nonexistent/claude' },
    'registry down': { SCG_NPM_REGISTRY: 'http://127.0.0.1:9' },
    'OSV down': { SCG_OSV_URL: 'http://127.0.0.1:9' },
  };
  for (const [name, env] of Object.entries(cases)) {
    const r = await runGuard('npm i scg-demo@1.0.1', { env });
    assert.equal(r.decision, 'ask', name);
    assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /fail/, name);
  }
  const garbage = await spawnGuard('not json', process.env);
  assert.equal(JSON.parse(garbage.stdout).hookSpecificOutput.permissionDecision, 'ask');
});

test('bulk upgrades and non-registry sources ask', async () => {
  assert.equal((await runGuard('npm update')).decision, 'ask');
  assert.equal((await runGuard('npm i github:someone/thing')).decision, 'ask');
  assert.equal((await runGuard('npm i scg-demo@1.0.1 --registry http://127.0.0.1:9')).decision, 'ask');
  assert.equal((await runGuard('echo scg-demo | xargs npm i')).decision, 'ask');
});

test('a registry or index in the hook environment asks without invoking Claude', async () => {
  const r = await runGuard('npm i scg-demo@1.0.1', { env: { PIP_INDEX_URL: 'https://evil.test/simple' } });
  assert.equal(r.decision, 'ask');
  assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /scg-demo with a registry or index set in the environment/);
  assert.equal(r.prompts.length, 0);
});

test('npm registry configuration in the hook environment asks without invoking Claude', async () => {
  const r = await runGuard('npm i scg-demo@1.0.1', { env: { npm_config_registry: 'https://evil.test' } });
  assert.equal(r.decision, 'ask');
  assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /scg-demo with a registry or index set in the environment/);
  assert.equal(r.prompts.length, 0);
});

test('a cached allow is checked against OSV again, so a later malware advisory still blocks', async () => {
  const state = tmp();
  assert.equal((await runGuard('npm i scg-demo@1.0.1', { env: { SCG_STATE_DIR: state } })).decision, 'allow');
  const flagged = await startRegistry({ malicious: ['scg-demo@1.0.1'] });
  try {
    const r = await runGuard('npm i scg-demo@1.0.1', { reg: flagged, env: { SCG_STATE_DIR: state } });
    assert.equal(r.decision, 'deny');
    assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /MAL-2026-0001/);
  } finally {
    await flagged.close();
  }
});

test('a state dir that cannot be written does not soften a block', async () => {
  const notADir = path.join(tmp(), 'file');
  fs.writeFileSync(notADir, '');
  const r = await runGuard('npm i scg-demo@1.0.2', { cwd: project('1.0.1'), env: { SCG_STATE_DIR: notADir } });
  assert.equal(r.decision, 'deny');
});

test('everything taken from the package reaches Claude inside one nonce-delimited untrusted block', async () => {
  const r = await runGuard('npm install scg-demo@1.0.1');
  const prompt = r.prompts[0].prompt;
  const [, nonce] = /<<<UNTRUSTED-([0-9a-f]{16})\n/.exec(prompt);
  const open = prompt.indexOf(`<<<UNTRUSTED-${nonce}\n`);
  assert.ok(prompt.indexOf('Automatic signals') > open);
  assert.ok(prompt.indexOf('+exports.greet') > open);
  assert.ok(prompt.trimEnd().endsWith(`UNTRUSTED-${nonce}>>>`));
  assert.ok(!prompt.slice(open + 30, prompt.lastIndexOf(`UNTRUSTED-${nonce}>>>`)).includes(nonce));
});

test('a repeated install is answered from the verdict cache', async () => {
  const state = tmp();
  const first = await runGuard('npm i scg-demo@1.0.1', { env: { SCG_STATE_DIR: state } });
  const second = await runGuard('npm i scg-demo@1.0.1', { env: { SCG_STATE_DIR: state } });
  assert.equal(second.decision, 'allow');
  assert.equal(second.prompts.length, 0);
  assert.match(fs.readFileSync(path.join(state, 'log.jsonl'), 'utf8'), /"cached":true/);
  assert.ok(first.ms > 0);
});

test('without the guard the trojaned update really plants the key (in a temp HOME)', async () => {
  const home = tmp('scg-home-');
  const cwd = project();
  fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"victim","version":"1.0.0"}');
  await promisify(execFile)('npm', ['install', 'scg-demo@1.0.2', '--registry', registry.env.SCG_NPM_REGISTRY, '--no-audit', '--no-fund'], {
    cwd,
    env: { ...process.env, HOME: home, npm_config_cache: path.join(home, '.npm'), npm_config_userconfig: path.join(home, '.npmrc') },
  });
  assert.equal(fs.readFileSync(path.join(home, '.ssh/authorized_keys'), 'utf8').trim(), FAKE_KEY);
});

function localVsix(files, version) {
  const root = tmp('scg-vsix-');
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), file.endsWith('package.json') ? JSON.stringify({ ...JSON.parse(body), version }) : body);
  }
  const base = path.join(tmp('scg-vsix-out-'), 'ext');
  execFileSync('python3', ['-I', '-c', 'import sys, shutil; shutil.make_archive(sys.argv[1], "zip", sys.argv[2])', base, root]);
  fs.renameSync(`${base}.zip`, `${base}.vsix`);
  return `${base}.vsix`;
}

function installedExtension(version) {
  const extDir = tmp('scg-ext-');
  fs.mkdirSync(path.join(extDir, `scgtest.scg-ext-${version}`));
  return extDir;
}

test('a local vsix is reviewed even when it carries the installed version number', async () => {
  const trojan = localVsix(vsxVersions['2.1.312'], '2.1.311');
  const r = await runGuard(`code --install-extension ${trojan}`, { env: { SCG_EXTENSION_DIRS: installedExtension('2.1.311') } });
  assert.equal(r.decision, 'deny');
});

test('the verdict cache is bound to the artifact, not to its version number', async () => {
  const env = { SCG_EXTENSION_DIRS: installedExtension('2.1.311'), SCG_STATE_DIR: tmp() };
  const clean = await runGuard(`code --install-extension ${localVsix(vsxVersions['2.1.311'], '2.1.312')}`, { env });
  assert.equal(clean.decision, 'allow');
  const trojan = await runGuard(`code --install-extension ${localVsix(vsxVersions['2.1.312'], '2.1.312')}`, { env });
  assert.equal(trojan.decision, 'deny');
});

test('Visual Studio Marketplace extension ids ask without invoking Claude', async () => {
  const reg = await startRegistry();
  try {
    const r = await runGuard('code --install-extension scgtest.scg-ext', { reg });
    assert.equal(r.decision, 'ask');
    assert.equal(r.prompts.length, 0);
  } finally {
    await reg.close();
  }
});

test('VSCodium extension ids ask when a custom gallery is set', async () => {
  const r = await runGuard('codium --install-extension scgtest.scg-ext', {
    env: { VSCODE_GALLERY_SERVICE_URL: 'https://e.example' },
  });
  assert.equal(r.decision, 'ask');
  assert.equal(r.prompts.length, 0);
});

test('remote Open VSX artifacts with the same bytes hit cache and changed bytes miss it', async () => {
  const cleanManifest = JSON.stringify({
    ...JSON.parse(vsxVersions['2.1.311']['extension/package.json']),
    version: '2.1.312',
  });
  const cleanExtensions = {
    ...vsxVersions,
    '2.1.312': {
      ...vsxVersions['2.1.311'],
      'extension/package.json': cleanManifest,
    },
  };
  const clean = await startRegistry({ extensionVersions: cleanExtensions });
  const trojan = await startRegistry();
  const env = { SCG_EXTENSION_DIRS: installedExtension('2.1.311'), SCG_STATE_DIR: tmp() };
  try {
    const first = await runGuard('codium --install-extension scgtest.scg-ext', { reg: clean, env });
    const second = await runGuard('codium --install-extension scgtest.scg-ext', { reg: clean, env });
    assert.equal(first.decision, 'allow');
    assert.equal(second.decision, 'allow');
    assert.equal(second.prompts.length, 0);
    const changed = await runGuard('codium --install-extension scgtest.scg-ext', { reg: trojan, env });
    assert.equal(changed.decision, 'deny');
    assert.match(changed.out.hookSpecificOutput.permissionDecisionReason, /ssh-keys/);
  } finally {
    await clean.close();
    await trojan.close();
  }
});

test('a PowerShell install the parser cannot read asks', async () => {
  const r = await runGuard('Start-Process npm -ArgumentList "install evil"', { tool: 'PowerShell' });
  assert.equal(r.decision, 'ask');
  assert.equal(r.prompts.length, 0);
});
