import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseExplanation, parseDiff, pathClaims, symbolClaims, numberClaims, checkDeterministic, parseModelJson, modelDiff, report } from '../scripts/explain-check.mjs';

const DIFF = [
  'diff --git a/hooks/lib.mjs b/hooks/lib.mjs',
  '--- a/hooks/lib.mjs',
  '+++ b/hooks/lib.mjs',
  '@@ -1,2 +1,3 @@',
  ' export const LIMIT = 5000;',
  '+export function estimateTokens(text) { return text.length / 4; }',
  '-const old = 1;',
  'diff --git a/README.md b/README.md',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1 @@',
  '+See `BIGFILE_MODE`.',
  '',
].join('\n');

const body = (what, why = 'Big files waste context.', risk = 'A wrong estimate warns on a small file.') =>
  `Intro.\n\n## Explanation\n\nWhat: ${what}\nWhy: ${why}\nRisk: ${risk}\n\n## P0 / Proof\n- Writer: a`;

const rules = (b, d = DIFF) => checkDeterministic(b, d).map((m) => m.rule);

test('parseExplanation reads the three fields and stops at the next heading', () => {
  const ex = parseExplanation(body('adds `estimateTokens()`\nin hooks/lib.mjs'));
  assert.equal(ex.what, 'adds `estimateTokens()`\nin hooks/lib.mjs');
  assert.equal(ex.why, 'Big files waste context.');
  assert.ok(!ex.risk.includes('Writer'));
});

test('parseExplanation accepts bold and sub-heading fields, CRLF, and returns null without the section', () => {
  const ex = parseExplanation('## Explanation\r\n**What:** a\r\n### Why\r\nb\r\n- **Risk**: c\r\n');
  assert.deepEqual(ex, { what: 'a', why: 'b', risk: 'c' });
  assert.equal(parseExplanation('## What changes\nx'), null);
});

test('parseDiff counts added and removed lines per file', () => {
  const f = parseDiff(DIFF);
  assert.deepEqual(f.map((x) => [x.path, x.added, x.removed]), [['hooks/lib.mjs', 1, 1], ['README.md', 1, 0]]);
});

test('pathClaims finds files and dirs, skips URLs, dates and word alternatives', () => {
  assert.deepEqual(pathClaims('edits hooks/lib.mjs and `README.md` in skills/bigfile-guard/'), ['hooks/lib.mjs', 'README.md', 'skills/bigfile-guard']);
  assert.deepEqual(pathClaims('see https://x.com/a/b.md, allow/ask/block, and/or 2026/10'), []);
});

test('symbolClaims takes backticked tokens and bare calls, not paths', () => {
  assert.deepEqual(symbolClaims('calls `estimateTokens()` and parse() with `--base`, edits `hooks/lib.mjs`'), ['estimateTokens()', '--base', 'parse()']);
});

test('numberClaims skips single digits, dates, PR refs and SHAs', () => {
  assert.deepEqual(numberClaims('limit 5000, 3 rounds, #19, 2026-10-10, 83fcbff, ratio 12.5'), ['5000', '12.5']);
});

test('a correct explanation has no mismatches', () => {
  assert.deepEqual(rules(body('`estimateTokens()` in hooks/lib.mjs counts tokens against the 5000 limit; README.md names `BIGFILE_MODE`.')), []);
});

test('a file the diff does not touch is flagged', () => {
  assert.deepEqual(rules(body('`estimateTokens()` in hooks/scan.mjs; README.md.')), ['file_not_in_diff']);
});

test('an invented function is flagged', () => {
  assert.deepEqual(rules(body('`countTokens()` in hooks/lib.mjs; README.md.')), ['symbol_not_in_diff']);
});

test('a wrong number is flagged', () => {
  assert.deepEqual(rules(body('hooks/lib.mjs warns over 8000 tokens; README.md.')), ['number_not_in_diff']);
});

test('missing section and empty fields are flagged', () => {
  assert.deepEqual(rules('no section'), ['no_section']);
  assert.deepEqual(rules('## Explanation\nWhat: hooks/lib.mjs, README.md\nWhy:\nRisk: low'), ['missing_field']);
});

test('paraphrased config, ratios and files said to be unchanged are not claims', () => {
  const d = DIFF.replace('+See `BIGFILE_MODE`.', '+{ "onFailure": "block" } bytes/4');
  assert.deepEqual(rules(body('hooks/lib.mjs sets `onFailure: block`, tokens are bytes/4; README.md. manifest.json and sync.mjs are unchanged.'), d), []);
  assert.deepEqual(rules(body('hooks/x.mjs runs the real gh unchanged; README.md.'), d), ['file_not_in_diff']);
});

test('a big changed file never named is flagged, tests are exempt', () => {
  const big = (p) => [`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`, '@@ -0,0 +1,40 @@', ...Array(40).fill('+x'), ''].join('\n');
  const d = big('skills/x/scan.mjs') + big('skills/x/test/scan.test.mjs');
  assert.deepEqual(rules(body('a new scanner.'), d), ['undescribed_change']);
  assert.deepEqual(rules(body('a new scanner in skills/x.'), d), []);
  assert.deepEqual(rules(body('a new scan step.'), d), []);
});

test('Risk "none" on a diff touching hooks is flagged', () => {
  assert.deepEqual(rules(body('hooks/lib.mjs, README.md', 'x', 'None.')), ['risk_omitted']);
  const docs = 'diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1 +1 @@\n-a\n+b\n';
  assert.deepEqual(rules(body('a.md', 'x', 'none'), docs), []);
});

test('parseModelJson takes the last valid object, tolerating prose and fences', () => {
  assert.deepEqual(parseModelJson('thinking {"x":1}\n```json\n{"mismatches":[],"verdict":"ok"}\n```'), { mismatches: [], verdict: 'ok' });
  assert.equal(parseModelJson('no json'), null);
});

test('modelDiff lists every file and cuts long ones', () => {
  const d = modelDiff(DIFF, { perFile: 20, total: 1000 });
  assert.match(d, /Files: hooks\/lib\.mjs \+1 -1; README\.md \+1 -0/);
  assert.match(d, /hooks\/lib\.mjs: cut/);
});

const SCRIPT = fileURLToPath(new URL('../scripts/explain-check.mjs', import.meta.url));
const GOOD = body('`estimateTokens()` in hooks/lib.mjs counts tokens against the 5000 limit; README.md names `BIGFILE_MODE`.');

// A fake codex: reads the prompt from stdin, then acts out `behaviour`, writing its reply to the -o file.
function fakeCodex(dir, behaviour) {
  const p = path.join(dir, `codex-${behaviour}.mjs`);
  fs.writeFileSync(p, `#!/usr/bin/env node
import fs from 'node:fs';
const argv = process.argv.slice(2);
const out = argv[argv.indexOf('-o') + 1];
fs.readFileSync(0, 'utf8');
const b = ${JSON.stringify(behaviour)};
if (b === 'crash') process.exit(3);
if (b === 'hang') setTimeout(() => {}, 60000);
if (b === 'prose') fs.writeFileSync(out, 'I could not decide.');
if (b === 'mismatch') fs.writeFileSync(out, '{"mismatches":[{"field":"what","claim":"c","evidence":"e"}],"verdict":"mismatch"}');
if (b === 'ok') { fs.writeFileSync(out, '{"mismatches":[],"verdict":"ok"}'); console.log('tokens used\\n1,234'); }
`);
  fs.chmodSync(p, 0o755);
  return p;
}

function runCli(args, codex) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, EXPLAIN_CODEX: codex ?? '/nonexistent/codex' } });
}

test('the model path never returns a blocking exit code', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explain-test-'));
  const bodyFile = path.join(dir, 'body.md');
  const diffFile = path.join(dir, 'pr.diff');
  fs.writeFileSync(bodyFile, GOOD);
  fs.writeFileSync(diffFile, DIFF);
  const cases = [
    ['missing', '/nonexistent/codex', /not checked.*codex did not run \(ENOENT\)/],
    ['crash', fakeCodex(dir, 'crash'), /not checked.*codex exited 3/],
    ['hang', fakeCodex(dir, 'hang'), /not checked.*codex timed out after 1 s/],
    ['prose', fakeCodex(dir, 'prose'), /not checked.*no verdict JSON/],
    ['mismatch', fakeCodex(dir, 'mismatch'), /^\[explain-gate\] mismatch[\s\S]*model \(what\): c \| e/],
    ['ok', fakeCodex(dir, 'ok'), /^\[explain-gate\] ok \(warn only\)\n$/],
  ];
  try {
    for (const [name, codex, expected] of cases) {
      const r = runCli(['--body', bodyFile, '--diff', diffFile, '--timeout', '1'], codex);
      assert.equal(r.status, 0, name);
      assert.match(r.stdout, expected, name);
    }
    const j = JSON.parse(runCli(['--body', bodyFile, '--diff', diffFile, '--json'], fakeCodex(dir, 'ok')).stdout);
    assert.equal(j.model.tokens, 1234);
    assert.equal(j.verdict, 'ok');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bad arguments and unreadable files warn and exit 0', () => {
  for (const args of [[], ['--body', '/nonexistent/body.md', '--diff', '/nonexistent/pr.diff']]) {
    const r = runCli(args);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /not checked \(warn only\)/);
  }
});

test('report skips the model when there is no section or --no-model', () => {
  assert.equal(report('no section', DIFF).model, null);
  assert.deepEqual(report(GOOD, DIFF, { model: false }), { verdict: 'ok', deterministic: [], model: null });
});

test('parseModelJson ends on a malformed object at offset 0 and requires a verdict', () => {
  assert.equal(parseModelJson('{"mismatches":[],"verdict":"wat"}'), null);
  assert.equal(parseModelJson('{"mismatches":[]}'), null);
  assert.equal(parseModelJson('{"mismatches":[null],"verdict":"ok"}'), null);
  assert.equal(parseModelJson('{"mismatches":[{"field":"what"}],"verdict":"mismatch"}'), null);
  assert.deepEqual(parseModelJson('{\n  "mismatches": [],\n  "verdict": "ok"\n}'), { mismatches: [], verdict: 'ok' });
});

test('parseDiff keeps hunk lines that look like ---/+++ headers', () => {
  const d = 'diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1,2 +1,2 @@\n--- old rule\n+++ new rule `KEEP_ME`\n';
  assert.deepEqual(parseDiff(d).map((f) => [f.added, f.removed]), [[1, 1]]);
  assert.match(parseDiff(d)[0].text, /KEEP_ME/);
});

test('symbols and numbers match whole tokens, not substrings', () => {
  assert.deepEqual(rules(body('`parse()` in hooks/lib.mjs; README.md.'), DIFF.replace('estimateTokens', 'parseExplanation')), ['symbol_not_in_diff']);
  assert.deepEqual(rules(body('hooks/lib.mjs warns over 500 tokens; README.md.')), ['number_not_in_diff']);
});

test('--json errors are JSON, and importing from stdin exits 0', () => {
  const r = runCli(['--json']);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).verdict, 'not checked');
  const s = spawnSync(process.execPath, ['--input-type=module', '-'], { input: `import ${JSON.stringify(pathToFileURL(SCRIPT).href)};`, encoding: 'utf8' });
  assert.equal(s.status, 0, s.stderr);
});
