import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkStaged, classify, estimate, matcher, resolveConfig, DEFAULT_LIMIT } from '../hooks/lib.mjs';
import { decide, commitDirs } from '../hooks/claude-pretooluse.mjs';

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks');
const PRE_COMMIT = join(HOOKS, 'pre-commit.mjs');
const CLAUDE_HOOK = join(HOOKS, 'claude-pretooluse.mjs');

// A run inside a git hook leaks GIT_DIR / GIT_INDEX_FILE; the temp repos must not see them, nor the host's mode.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && !k.startsWith('BIGFILE_')));
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_') || k.startsWith('BIGFILE_')) delete process.env[k];
ENV.GIT_CONFIG_GLOBAL = process.env.GIT_CONFIG_GLOBAL = '/dev/null';
ENV.GIT_CONFIG_NOSYSTEM = process.env.GIT_CONFIG_NOSYSTEM = '1';

const big = (tok) => 'word '.repeat(Math.ceil(tok * 4 / 5));
function repo(t) {
  const d = mkdtempSync(join(tmpdir(), 'bfg-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const g = (...a) => execFileSync('git', a, { cwd: d, env: ENV });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  const put = (p, c) => { mkdirSync(dirname(join(d, p)), { recursive: true }); writeFileSync(join(d, p), c); g('add', p); };
  const commit = () => g('commit', '-qm', 'x', '--no-verify');
  return { d, g, put, commit };
}
const statuses = (res) => res.violations.map((x) => [x.path, x.status]);

test('estimate: max of bytes/4 and words*1.3', () => {
  const e = estimate(Buffer.from(big(6000)));
  assert.equal(e.bytes, 6000);
  assert.equal(e.tokens, Math.max(e.bytes, e.words));
});

test('new file over limit is a violation', (t) => {
  const r = repo(t); r.put('a.md', big(6000));
  assert.deepEqual(statuses(checkStaged(r.d, ENV)), [['a.md', 'new-over']]);
});

test('existing file growing over limit is a violation; unchanged big file is not', (t) => {
  const r = repo(t); r.put('g.md', big(4000)); r.put('keep.md', big(9000)); r.commit();
  r.put('g.md', big(5500)); r.put('other.txt', 'small');
  assert.deepEqual(statuses(checkStaged(r.d, ENV)), [['g.md', 'grew-over']]);
});

test('big file that shrinks does not block', (t) => {
  const r = repo(t); r.put('s.md', big(9000)); r.commit(); r.put('s.md', big(8000));
  assert.equal(checkStaged(r.d, ENV).violations.length, 0);
});

test('renamed big file compares against its old path', (t) => {
  const r = repo(t); r.put('old.md', big(9000)); r.commit();
  r.g('mv', 'old.md', 'new.md');
  assert.equal(checkStaged(r.d, ENV).violations.length, 0);
});

test('exemptions: default lockfile and .bigfile-allow glob', (t) => {
  const r = repo(t); r.put('package-lock.json', big(9000)); r.put('data/x.json', big(9000));
  r.put('.bigfile-allow', '# generated\r\ndata/*.json\r\n');
  assert.equal(checkStaged(r.d, ENV).violations.length, 0);
});

test('exemptions: *.min.mjs and eval/**/data/**', (t) => {
  const r = repo(t);
  r.put('public/pdf.worker.min.mjs', big(9000));
  r.put('eval/bench/data/set.json', big(9000));
  r.put('eval/data/top.json', big(9000));
  r.put('eval/bench/run.mjs', big(9000));
  r.put('src/data/x.json', big(9000));
  assert.deepEqual(statuses(checkStaged(r.d, ENV)), [['eval/bench/run.mjs', 'new-over'], ['src/data/x.json', 'new-over']]);
});

test('.bigfile-allow counts only as staged, not from the working tree', (t) => {
  const r = repo(t); r.put('data/x.json', big(9000));
  writeFileSync(join(r.d, '.bigfile-allow'), 'data/*.json\n');
  assert.deepEqual(statuses(checkStaged(r.d, ENV)), [['data/x.json', 'new-over']]);
  r.g('add', '.bigfile-allow');
  assert.equal(checkStaged(r.d, ENV).violations.length, 0);
});

test('binary file is ignored', (t) => {
  const r = repo(t); r.put('img.bin', Buffer.concat([Buffer.from([0]), Buffer.alloc(100000, 65)]));
  assert.equal(checkStaged(r.d, ENV).violations.length, 0);
});

test('git hook: warn exits 0 with the report, block exits 1, off is silent', (t) => {
  const r = repo(t); r.put('a.md', big(6000));
  const run = (mode) => spawnSync('node', [PRE_COMMIT], { cwd: r.d, env: { ...ENV, BIGFILE_MODE: mode }, encoding: 'utf8' });
  const w = run('warn'); assert.equal(w.status, 0); assert.match(w.stderr, /NEW +a\.md/);
  assert.equal(run('block').status, 1);
  const off = run('off'); assert.equal(off.status, 0); assert.equal(off.stderr, '');
});

test('git hook: mode and limit from git config', (t) => {
  const r = repo(t); r.put('a.md', big(6000));
  const run = () => spawnSync('node', [PRE_COMMIT], { cwd: r.d, env: ENV, encoding: 'utf8' });
  assert.equal(run().status, 0);
  r.g('config', 'bigfile.mode', 'block');
  assert.equal(run().status, 1);
  r.g('config', 'bigfile.limit', '10000');
  assert.equal(run().status, 0);
});

test('git hook runs from a real pre-commit and default mode never blocks', (t) => {
  const r = repo(t);
  writeFileSync(join(r.d, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\nexec node "${PRE_COMMIT}"\n`, { mode: 0o755 });
  r.put('a.md', big(6000));
  const c = spawnSync('git', ['commit', '-qm', 'big'], { cwd: r.d, env: ENV, encoding: 'utf8' });
  assert.equal(c.status, 0);
  assert.match(c.stderr, /NEW +a\.md/);
  r.g('config', 'bigfile.mode', 'block');
  r.put('b.md', big(6000));
  assert.equal(spawnSync('git', ['commit', '-qm', 'big2'], { cwd: r.d, env: ENV }).status, 1);
});

test('git hook outside a repo exits 0', (t) => {
  const d = mkdtempSync(join(tmpdir(), 'bfg-norepo-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  assert.equal(spawnSync('node', [PRE_COMMIT], { cwd: d, env: { ...ENV, GIT_CEILING_DIRECTORIES: dirname(d) } }).status, 0);
});

test('config: invalid mode or limit is ignored with a warning', () => {
  const c = resolveConfig({ env: { BIGFILE_MODE: 'blokc', BIGFILE_LIMIT: '-3' } });
  assert.equal(c.mode, 'warn');
  assert.equal(c.limit, DEFAULT_LIMIT);
  assert.equal(c.warnings.length, 2);
  const g = resolveConfig({ env: {}, gitConfig: (k) => ({ 'bigfile.mode': 'BLOCK', 'bigfile.limit': '8000' })[k] });
  assert.deepEqual([g.mode, g.limit, g.warnings], ['block', 8000, []]);
  assert.equal(resolveConfig({ env: { BIGFILE_LIMIT: '5e3' } }).limit, DEFAULT_LIMIT);
  const typo = resolveConfig({ env: { BIGFILE_MODE: 'blokc' }, gitConfig: (k) => (k === 'bigfile.mode' ? 'block' : '') });
  assert.equal(typo.mode, 'block');
});

test('config: the stricter of env and git config wins', () => {
  const repoBlock = (k) => ({ 'bigfile.mode': 'block', 'bigfile.limit': '8000' })[k];
  assert.equal(resolveConfig({ env: { BIGFILE_MODE: 'off' }, gitConfig: repoBlock }).mode, 'block');
  assert.equal(resolveConfig({ env: { BIGFILE_MODE: 'warn' }, gitConfig: repoBlock }).mode, 'block');
  assert.equal(resolveConfig({ env: { BIGFILE_MODE: 'block' }, gitConfig: (k) => (k === 'bigfile.mode' ? 'off' : '') }).mode, 'block');
  assert.equal(resolveConfig({ env: { BIGFILE_LIMIT: '20000' }, gitConfig: repoBlock }).limit, 8000);
  assert.equal(resolveConfig({ env: { BIGFILE_LIMIT: '3000' }, gitConfig: repoBlock }).limit, 3000);
  assert.equal(resolveConfig({ env: { BIGFILE_MODE: 'off' } }).mode, 'off');
});

test('git hook: BIGFILE_MODE=off does not undo a repo set to block', (t) => {
  const r = repo(t); r.put('a.md', big(6000)); r.g('config', 'bigfile.mode', 'block');
  assert.equal(spawnSync('node', [PRE_COMMIT], { cwd: r.d, env: { ...ENV, BIGFILE_MODE: 'off' } }).status, 1);
});

test('unreadable staged blob is estimated from its size, not passed as empty', () => {
  const allow = () => false;
  assert.equal(classify({ path: 'huge.txt', oldBuf: null, newBuf: null, newSize: 400_000_000 }, 5000, allow).status, 'new-over');
  assert.equal(classify({ path: 'small.txt', oldBuf: null, newBuf: null, newSize: 100 }, 5000, allow).status, 'ok');
});

test('glob matcher', () => {
  const m = matcher(['*.min.js', '**/vendor/**', 'docs/*.md', 'eval/**/data/**']);
  assert.ok(m('a/b/c.min.js')); assert.ok(m('x/vendor/y/z.mjs')); assert.ok(m('vendor/z.mjs'));
  assert.ok(m('docs/a.md')); assert.ok(!m('docs/sub/a.md')); assert.ok(!m('src/a.js'));
  assert.ok(m('eval/a/b/data/c/d.json')); assert.ok(!m('x/eval/a/data/d.json'));
});

test('claude hook: only git commit commands are checked', () => {
  assert.deepEqual(commitDirs('ls -la', '/r'), []);
  assert.deepEqual(commitDirs('git status && npm test', '/r'), []);
  assert.deepEqual(commitDirs('git commit -m x', '/r'), ['/r']);
  assert.deepEqual(commitDirs('git -C sub commit -m x', '/r'), ['/r/sub']);
  assert.deepEqual(commitDirs('git -C "/a b" commit', '/r'), ['/a b']);
});

test('claude hook: PowerShell casing, line continuations and cd before the commit', () => {
  assert.deepEqual(commitDirs('GIT Commit -m x', '/r'), ['/r']);
  assert.deepEqual(commitDirs('git `\n  commit -m x', '/r'), ['/r']);
  assert.deepEqual(commitDirs('git \\\n  commit -m x', '/r'), ['/r']);
  assert.deepEqual(commitDirs('cd sub && git commit -m x', '/r'), ['/r/sub']);
  assert.deepEqual(commitDirs('cd /a && cd b; git -C c commit', '/r'), ['/a/b/c']);
  assert.deepEqual(commitDirs('Set-Location "C D"; git commit', '/r'), ['/r/C D']);
  assert.deepEqual(commitDirs('git -C /wrong -C /target commit', '/r'), ['/target']);
  assert.deepEqual(commitDirs('git -C a -C b commit', '/r'), ['/r/a/b']);
  assert.deepEqual(commitDirs('git -C \\\n/target commit', '/r'), ['/target']);
  assert.deepEqual(commitDirs('git commit -m a; git -C /other commit -m b', '/r'), ['/r', '/other']);
});

test('claude hook: warn gives a systemMessage, block denies, clean index is silent', (t) => {
  const r = repo(t);
  const input = { tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, cwd: r.d };
  assert.equal(decide(input, ENV), null);
  r.put('a.md', big(6000));
  assert.match(decide(input, ENV).systemMessage, /NEW +a\.md/);
  const deny = decide(input, { ...ENV, BIGFILE_MODE: 'block' }).hookSpecificOutput;
  assert.equal(deny.permissionDecision, 'deny');
  assert.match(deny.permissionDecisionReason, /a\.md/);
  assert.equal(decide({ ...input, tool_input: { command: 'git status' } }, { ...ENV, BIGFILE_MODE: 'block' }), null);
  const sub = { tool_input: { command: `cd ${JSON.stringify(r.d)} && git commit -m x` }, cwd: tmpdir() };
  assert.equal(decide(sub, { ...ENV, BIGFILE_MODE: 'block' }).hookSpecificOutput.permissionDecision, 'deny');
  const clean = repo(t);
  const two = { tool_input: { command: `git commit -m a && git -C ${JSON.stringify(r.d)} commit -m b` }, cwd: clean.d };
  assert.equal(decide(two, { ...ENV, BIGFILE_MODE: 'block' }).hookSpecificOutput.permissionDecision, 'deny');
});

test('claude hook process: prints JSON on stdout, nothing on bad input', (t) => {
  const r = repo(t); r.put('a.md', big(6000));
  const run = (stdin, env = ENV) => spawnSync('node', [CLAUDE_HOOK], { input: stdin, env, encoding: 'utf8' });
  const out = run(JSON.stringify({ tool_input: { command: 'git commit -m x' }, cwd: r.d }), { ...ENV, BIGFILE_MODE: 'block' });
  assert.equal(out.status, 0);
  assert.equal(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const bad = run('not json');
  assert.equal(bad.status, 0); assert.equal(bad.stdout, '');
});
