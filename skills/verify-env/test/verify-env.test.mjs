import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cmdArgs, CORE, exitCode, mergeProfile, parseVersion, realDeps, runChecks, satisfies, which } from '../scripts/lib.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'verify-env.mjs');

// Fake host: `tools` maps a command name to {dir, out, code} or to a function of args.
function fakeDeps({ platform = 'linux', tools = {}, files = {}, dirs = {}, freeMb = 50000, busy = [], portErrors = {}, env = {}, fileErrors = {} } = {}) {
  const sep = platform === 'win32' ? ';' : ':';
  const P = platform === 'win32' ? path.win32 : path.posix;
  const binDirs = [...new Set(Object.values(tools).map((t) => t.dir || '/fake/bin'))];
  const exe = new Map();
  for (const [name, t] of Object.entries(tools)) exe.set(P.join(t.dir || '/fake/bin', name + (platform === 'win32' ? '.exe' : '')), t);
  const calls = [];
  return {
    calls,
    platform,
    home: '/home/u',
    env: { PATH: binDirs.join(sep), ...env },
    exists: (p) => exe.has(p) || p in files,
    readFile: (p) => { if (p in fileErrors) throw Object.assign(new Error(fileErrors[p]), { code: fileErrors[p] }); if (p in files) return files[p]; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    readdir: (p) => { if (p in fileErrors) throw Object.assign(new Error(fileErrors[p]), { code: fileErrors[p] }); if (p in dirs) return dirs[p]; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    freeMb: () => freeMb,
    run(file, args) {
      calls.push([file, ...args]);
      const t = exe.get(file);
      if (!t) return { code: 127, stdout: '', stderr: '' };
      return { code: t.code ?? 0, stdout: t.out ?? '', stderr: '' };
    },
    portInUse: async (p) => (busy.includes(p) ? true : portErrors[p] ?? false),
  };
}

const okTools = { node: { out: 'v22.1.0' }, git: { out: 'git version 2.43.0' } };
const base = { ...CORE, optional: [], ghAuth: false, minDiskMb: 0 };

test('versions parse and compare', () => {
  assert.deepEqual(parseVersion('v22.23.2'), [22, 23, 2]);
  assert.deepEqual(parseVersion('git version 2.43'), [2, 43, 0]);
  assert.equal(satisfies([22, 1, 0], '>=20'), true);
  assert.equal(satisfies([18, 19, 0], '>=20'), false);
  assert.equal(satisfies([9, 1, 0], '>=9.1'), true);
  assert.equal(satisfies(null, '>=1'), false);
});

test('all required tools present: exit 0', async () => {
  const r = await runChecks(base, fakeDeps({ tools: okTools }));
  assert.deepEqual(r.map((x) => x.status), ['ok', 'ok']);
  assert.equal(exitCode(r), 0);
});

test('missing required tool fails, missing optional warns', async () => {
  const p = mergeProfile(base, { optional: ['npm'] });
  const r = await runChecks(p, fakeDeps({ tools: { node: okTools.node } }));
  assert.equal(r.find((x) => x.id === 'tool:git').status, 'fail');
  assert.equal(r.find((x) => x.id === 'tool:npm').status, 'warn');
  assert.match(r.find((x) => x.id === 'tool:npm').detail, /not on PATH/);
  assert.equal(exitCode(r), 1);
  assert.equal(exitCode(r.filter((x) => x.id !== 'tool:git')), 2);
});

test('version below the profile minimum fails', async () => {
  const p = mergeProfile(base, { versions: { node: '>=24' } });
  const r = await runChecks(p, fakeDeps({ tools: okTools }));
  assert.equal(r[0].status, 'fail');
  assert.match(r[0].detail, /22\.1\.0, needs >=24/);
});

test('gh auth uses the exit code only and never echoes output', async () => {
  const secret = 'Logged in to github.com account someone (keyring) Token: gho_fake123';
  for (const [code, status] of [[0, 'ok'], [1, 'fail']]) {
    const d = fakeDeps({ tools: { ...okTools, gh: { out: secret, code } } });
    const r = await runChecks({ ...base, require: [], ghAuth: true }, d);
    assert.equal(r[0].status, status);
    assert.doesNotMatch(JSON.stringify(r), /gho_|someone|keyring/);
    assert.deepEqual(d.calls.at(-1).slice(1), ['auth', 'status']);
  }
});

test('pathFirst warns when a shim is not ahead of the real tool', async () => {
  const p = mergeProfile({ ...base, require: [] }, { pathFirst: { gh: '~/.claude/home/bin' } });
  const real = await runChecks(p, fakeDeps({ tools: { gh: { dir: '/usr/bin' } } }));
  assert.equal(real[0].status, 'warn');
  assert.match(real[0].detail, /resolves to \/usr\/bin\/gh, expected ~\/.claude\/home\/bin/);
  const shim = await runChecks(p, fakeDeps({ tools: { gh: { dir: '/home/u/.claude/home/bin' } } }));
  assert.equal(shim[0].status, 'ok');
  const win = (dir) => ({ ...fakeDeps({ platform: 'win32', tools: { gh: { dir } }, env: { PATHEXT: '.EXE' } }), home: 'C:\\Users\\u' });
  const winReal = await runChecks(p, win('C:\\Program Files\\GitHub CLI'));
  assert.equal(winReal[0].detail, 'gh resolves to C:\\Program Files\\GitHub CLI\\gh.exe, expected ~\\.claude\\home\\bin first on PATH');
  assert.equal((await runChecks(p, win('C:\\Users\\U\\.claude\\home\\bin')))[0].status, 'ok');
});

test('disk below minimum fails; busy port warns', async () => {
  const p = { ...base, require: [], minDiskMb: 2048, ports: [5003, 5004] };
  const r = await runChecks(p, fakeDeps({ freeMb: 100, busy: [5003] }));
  assert.deepEqual(r.map((x) => [x.id, x.status]), [['disk', 'fail'], ['port:5003', 'warn'], ['port:5004', 'ok']]);
});

test('chromium: missing build fails, AppArmor userns restriction warns', async () => {
  const p = { ...base, require: [], chromium: true };
  const restricted = { '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1\n' };
  const r = await runChecks(p, fakeDeps({ files: restricted, dirs: { '/home/u/.cache/ms-playwright': ['chromium-1248', 'ffmpeg-1011'] } }));
  assert.deepEqual(r.map((x) => [x.id, x.status]), [['chromium', 'ok'], ['chromium-sandbox', 'warn']]);
  const none = await runChecks(p, fakeDeps({}));
  assert.deepEqual(none.map((x) => [x.id, x.status]), [['chromium', 'fail'], ['chromium-sandbox', 'ok']]);
});

test('windows: PATH split on ;, PATHEXT, no userns check', async () => {
  const d = fakeDeps({ platform: 'win32', tools: { node: { dir: 'C:\\tools', out: 'v22.0.0' } }, env: { PATHEXT: '.EXE;.CMD' } });
  assert.equal(which('node', d), 'C:\\tools\\node.exe');
  const r = await runChecks({ ...base, require: ['node'], chromium: true }, d);
  assert.deepEqual(r.map((x) => x.id), ['tool:node', 'chromium']);
  const cache = 'C:\\Users\\u\\AppData\\Local\\ms-playwright';
  const pw = { ...fakeDeps({ platform: 'win32', dirs: { [cache]: ['chromium-1248'] } }), home: 'C:\\Users\\u' };
  assert.deepEqual((await runChecks({ ...base, require: [], chromium: true }, pw)).map((x) => [x.id, x.status, x.detail]),
    [['chromium', 'ok', '1 Playwright chromium build(s) in ~\\AppData\\Local\\ms-playwright']]);
});

test('windows .cmd line survives cmd /s quote stripping with a space in the path', () => {
  const a = cmdArgs('C:\\Program Files\\nodejs\\npm.cmd', ['--version']);
  assert.deepEqual(a.slice(0, 3), ['/d', '/s', '/c']);
  const line = a[3];
  assert.ok(line.startsWith('"') && line.endsWith('"'));
  assert.equal(line.slice(1, -1), '"C:\\Program Files\\nodejs\\npm.cmd" --version');
});

test('review fixes: port errors, POSIX path case, Playwright sentinel, unreadable AppArmor', async () => {
  const ports = await runChecks({ ...base, require: [], ports: [80, 5003] }, fakeDeps({ portErrors: { 80: 'EACCES' } }));
  assert.equal(ports.find((c) => c.id === 'port:80').status, 'warn');
  assert.match(ports.find((c) => c.id === 'port:80').detail, /not checked \(EACCES\)/);
  assert.equal(ports.find((c) => c.id === 'port:5003').status, 'ok');

  const upper = { ...base, require: [], pathFirst: { gh: '/OPT/bin' } };
  assert.equal((await runChecks(upper, fakeDeps({ tools: { gh: { dir: '/opt/bin' } } }))).find((c) => c.id === 'path:gh').status, 'warn');
  const winUpper = { ...base, require: [], pathFirst: { gh: 'C:\\Tools' } };
  const win = fakeDeps({ platform: 'win32', tools: { gh: { dir: 'C:\\tools' } }, env: { PATHEXT: '.EXE' } });
  assert.equal((await runChecks(winUpper, win)).find((c) => c.id === 'path:gh').status, 'ok');

  const hermetic = await runChecks({ ...base, require: [], chromium: true }, fakeDeps({ env: { PLAYWRIGHT_BROWSERS_PATH: '0' } }));
  assert.deepEqual(hermetic.map((c) => [c.id, c.status]), [['chromium', 'warn']]);

  const sysctl = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';
  const denied = await runChecks({ ...base, require: [], chromium: true }, fakeDeps({ fileErrors: { [sysctl]: 'EACCES' } }));
  assert.equal(denied.find((c) => c.id === 'chromium-sandbox').status, 'warn');
  const lockedCache = await runChecks({ ...base, require: [], chromium: true }, fakeDeps({ fileErrors: { '/home/u/.cache/ms-playwright': 'EACCES' } }));
  assert.equal(lockedCache.find((c) => c.id === 'chromium').status, 'warn');
  const absent = await runChecks({ ...base, require: [], chromium: true }, fakeDeps({}));
  assert.equal(absent.find((c) => c.id === 'chromium-sandbox').status, 'ok');
});

test('a timed-out tool is killed with the children it started', async () => {
  if (process.platform === 'win32') return; // taskkill /T path, shebang fake below
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-env-'));
  const tool = path.join(tmp, 'slow');
  const pidFile = path.join(tmp, 'child.pid');
  fs.writeFileSync(tool, `#!/bin/sh\nsleep 30 &\necho $! > ${pidFile}\nwait\n`);
  fs.chmodSync(tool, 0o755);
  const started = Date.now();
  const r = await realDeps({ timeoutMs: 300 }).run(tool, ['--version']);
  assert.equal(r.code, 127);
  assert.ok(Date.now() - started < 5000);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  await new Promise((res) => setTimeout(res, 100));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('profile merge: lists union, required wins over optional, host entry last', () => {
  const p = mergeProfile(CORE, { require: ['pnpm'], versions: { node: '>=20' }, ports: [5003] });
  assert.ok(p.require.includes('pnpm') && !p.optional.includes('pnpm'));
  assert.deepEqual(p.ports, [5003]);
  assert.equal(p.versions.node, '>=20');
});

test('CLI with fake commands on PATH: table, --json, exit codes, host profile', () => {
  if (process.platform === 'win32') return; // fake executables below are shebang scripts
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-env-'));
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  const fake = (name, out, code = 0) => {
    const f = path.join(bin, name);
    fs.writeFileSync(f, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(out)});process.exit(${code});\n`);
    fs.chmodSync(f, 0o755);
  };
  fake('node', 'v22.5.0');
  fake('git', 'git version 2.43.0');
  fake('gh', 'gh version 2.60.0 secret-ish output', 0);
  const profile = path.join(tmp, '.verify-env.json');
  fs.writeFileSync(profile, JSON.stringify({ optional: [], minDiskMb: 1, hosts: { box: { require: ['npm'] } } }));
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: tmp, encoding: 'utf8', env: { PATH: bin, HOME: tmp } });

  const plain = run('--host', 'other');
  assert.equal(plain.status, 2, plain.stderr); // optional npm/pnpm/codex/claude missing -> warnings
  assert.match(plain.stdout, /OK\s+tool:node\s+node 22\.5\.0/);
  assert.match(plain.stdout, /OK\s+gh-auth/);
  assert.doesNotMatch(plain.stdout, /secret-ish/);

  const strict = run('--json', '--host', 'box');
  assert.equal(strict.status, 1);
  const j = JSON.parse(strict.stdout);
  assert.equal(j.exit, 1);
  assert.equal(j.checks.find((c) => c.id === 'tool:npm').status, 'fail');

  fs.writeFileSync(profile, JSON.stringify({ optional: [], require: [], ghAuth: false, minDiskMb: 1 }));
  const core = run();
  assert.equal(core.status, 2); // core optional tools still listed (union), so missing npm warns
  assert.equal(run('--bogus').status, 3);
  assert.equal(run('--profile').status, 3);
  assert.equal(run('--host', '--json').status, 3);
  fs.writeFileSync(profile, JSON.stringify({ ports: 5003 }));
  assert.match(run().stderr, /"ports" has the wrong type/);
  fs.writeFileSync(profile, JSON.stringify({ ports: [70000] }));
  assert.equal(run().status, 3);
  fs.writeFileSync(profile, JSON.stringify({ hosts: { box: { versions: '>=20' } } }));
  assert.equal(run('--host', 'other').status, 3);
  fs.writeFileSync(profile, JSON.stringify({ pathFirst: { gh: null } }));
  assert.match(run().stderr, /pathFirst\.gh must be a string/);
  fs.rmSync(tmp, { recursive: true, force: true });
});
