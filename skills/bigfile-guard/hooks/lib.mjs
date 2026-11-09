// bigfile-guard core, shared by the git pre-commit hook and the Claude Code PreToolUse hook. No dependencies.
// A staged text file is a violation when it is over the token limit, not exempt, and either new or larger than in HEAD.
// A big file that stays the same size or shrinks passes, so existing big files never stop a commit that does not grow them.
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

export const DEFAULT_LIMIT = 5000;
export const MODES = ['warn', 'block', 'off'];

// Globs without a `/` match the file name anywhere; globs with a `/` match the repo-relative path.
export const DEFAULT_ALLOW = [
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '*.lock', 'go.sum', 'bun.lockb',
  '*.min.js', '*.min.mjs', '*.min.css', '*.map', '*.snap', '**/__snapshots__/**',
  '**/vendor/**', '**/third_party/**', '**/node_modules/**',
  '**/dist/**', '**/build/**', '**/generated/**', '*.generated.*', '*_generated.*', '*.pb.go',
  '**/fixtures/**', '**/__fixtures__/**', '**/testdata/**', 'eval/**/data/**',
  '*.log', '*.patch', '*.diff', '.conduct/**', 'graphify-out/**',
];

export function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

// bytes/4 fits English prose and code; words*1.3 catches text with many short words. The max of the two is the
// estimate. No tokenizer runs offline, so treat the limit as approximate (tens of percent).
export function estimate(buf) {
  const bytes = Math.ceil(buf.length / 4);
  const words = Math.ceil((buf.toString('utf8').match(/\S+/g) || []).length * 1.3);
  return { bytes, words, tokens: Math.max(bytes, words) };
}

export function globToRe(g) {
  const src = g.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]').replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*');
  return new RegExp('^' + src + '$');
}

export function matcher(patterns) {
  const res = patterns.map((p) => ({ re: globToRe(p), base: !p.includes('/') }));
  return (path) => res.some(({ re, base }) => re.test(base ? basename(path) : path));
}

// Extra globs from `.bigfile-allow` as staged in the index, so an unstaged or untracked edit cannot exempt a file.
export function parseAllow(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

export function loadAllow(root) {
  const staged = blob(root, ':.bigfile-allow');
  return [...DEFAULT_ALLOW, ...(staged ? parseAllow(staged.toString('utf8')) : [])];
}

// newBuf null (blob too big to read or unreadable): newSize (bytes) gives a bytes/4 estimate, so a read failure
// never turns into an empty file that passes.
export function classify(change, limit, isAllowed) {
  const { path, oldBuf, newBuf, newSize = 0 } = change;
  if (newBuf && isBinary(newBuf)) return { path, status: 'binary' };
  const now = newBuf ? estimate(newBuf).tokens : Math.ceil(newSize / 4);
  if (now <= limit) return { path, status: 'ok', now };
  const before = oldBuf && !isBinary(oldBuf) ? estimate(oldBuf).tokens : null;
  if (before !== null && now <= before) return { path, status: 'ok-existing', now, before };
  if (isAllowed(path)) return { path, status: 'allowed', now, before };
  return { path, status: before === null ? 'new-over' : 'grew-over', now, before };
}

export const isViolation = (r) => r.status === 'new-over' || r.status === 'grew-over';

// Mode and limit come from the env and from `git config`; the stricter of the two wins (off < warn < block, the
// lower limit), so `BIGFILE_MODE=off git commit` cannot undo a repo's `bigfile.mode block`. A value that is not
// valid falls back to the default with a warning: a typo is never stricter than warn, nor looser than the other source.
function parseMode(raw, warnings) {
  if (!raw) return null;
  const m = raw.trim().toLowerCase();
  if (MODES.includes(m)) return m;
  warnings.push(`bigfile-guard: unknown mode "${raw}", ignored (valid: ${MODES.join(', ')})`);
  return null;
}

function parseLimit(raw, warnings) {
  if (!raw) return null;
  const v = String(raw).trim();
  if (/^\d+$/.test(v) && Number(v) > 0) return Number(v);
  warnings.push(`bigfile-guard: limit "${v}" is not a positive integer, ignored`);
  return null;
}

export function resolveConfig({ env = process.env, gitConfig = () => '' } = {}) {
  const warnings = [];
  const modes = [parseMode(env.BIGFILE_MODE, warnings), parseMode(gitConfig('bigfile.mode'), warnings)].filter(Boolean);
  const order = ['off', 'warn', 'block'];
  const mode = modes.length ? modes.reduce((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a)) : 'warn';
  const limits = [parseLimit(env.BIGFILE_LIMIT, warnings), parseLimit(gitConfig('bigfile.limit'), warnings)].filter(Boolean);
  const limit = limits.length ? Math.min(...limits) : DEFAULT_LIMIT;
  return { mode, limit, warnings };
}

export function git(cwd, args, opts = {}) {
  return execFileSync('git', args, { cwd, maxBuffer: 1 << 28, ...opts });
}

export function blob(cwd, spec) {
  try { return git(cwd, ['cat-file', 'blob', spec], { stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
}

// Parse `git diff --name-status -z` into [{ status, path, oldPath }], deletions dropped.
export function parseNameStatus(out) {
  const parts = out.toString().split('\0').filter(Boolean);
  const res = [];
  for (let i = 0; i < parts.length;) {
    const st = parts[i++];
    if (st[0] === 'R' || st[0] === 'C') res.push({ status: st[0], oldPath: parts[i++], path: parts[i++] });
    else res.push({ status: st[0], path: parts[i++], oldPath: parts[i - 1] });
  }
  return res.filter((e) => e.status !== 'D');
}

export function blobSize(cwd, spec) {
  try { return Number(git(cwd, ['cat-file', '-s', spec], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()) || 0; }
  catch { return 0; }
}

// Checks the index of the repo at cwd. Throws when cwd is not inside a git work tree.
export function checkStaged(cwd = process.cwd(), env = process.env) {
  const root = git(cwd, ['rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  const gitConfig = (k) => { try { return git(root, ['config', k], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
  const { mode, limit, warnings } = resolveConfig({ env, gitConfig });
  if (mode === 'off') return { mode, limit, warnings, violations: [], results: [] };
  const isAllowed = matcher(loadAllow(root));
  let hasHead = true;
  try { git(root, ['rev-parse', '-q', '--verify', 'HEAD'], { stdio: 'ignore' }); } catch { hasHead = false; }
  const entries = parseNameStatus(git(root, ['diff', '--cached', '--name-status', '-z', '-M']));
  const results = entries.map((e) => {
    const newBuf = blob(root, `:${e.path}`);
    return classify({
      path: e.path,
      oldBuf: e.status === 'A' || !hasHead ? null : blob(root, `HEAD:${e.oldPath}`),
      newBuf,
      newSize: newBuf ? 0 : blobSize(root, `:${e.path}`),
    }, limit, isAllowed);
  });
  return { mode, limit, warnings, violations: results.filter(isViolation), results };
}

export function report({ mode, limit, violations }) {
  if (!violations.length) return '';
  const lines = violations.map((v) =>
    `  ${v.status === 'new-over' ? 'NEW ' : 'GREW'} ${v.path}  ~${v.now} tok${v.before ? ` (was ~${v.before})` : ''}`);
  return [
    `bigfile-guard: ${violations.length} file(s) over ${limit} tokens (mode=${mode}):`,
    ...lines,
    '  Split the file, or add a glob to .bigfile-allow if it is generated or vendored.',
  ].join('\n');
}
