#!/usr/bin/env node
// explain-gate: checks the author's `## Explanation` (What / Why / Risk) against the PR diff.
// Warn only: every path exits 0, including a missing body, a missing codex, a model timeout or a crash.
// Usage: node explain-check.mjs --body <file> --diff <file> [--no-model] [--json] [--timeout <sec>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const FIELDS = ['what', 'why', 'risk'];
export const BIG_FILE_LINES = 30;
const NO_RISK = /^(none|no risk|n\/?a|nothing|brak|-)\.?$/i;
const RISKY_PATH = /(^|\/)(hooks\/|bin\/|manifest\.json$|sync\.mjs$|release\.mjs$|\.github\/)/;
const TEST_PATH = /(^|\/)(test|tests|__tests__|fixtures?)\/|\.test\.[cm]?[jt]s$|\.spec\.[cm]?[jt]s$/;

// The `## Explanation` section: from its heading to the next heading of the same or higher level.
// Fields are `What:` / `**What**:` / `### What` lines; a field runs to the next field or the end.
export function parseExplanation(body) {
  const lines = String(body).replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^#{1,6}\s*explanation\s*$/i.test(l.trim()));
  if (start < 0) return null;
  const level = lines[start].trim().match(/^#+/)[0].length;
  const section = [];
  for (const line of lines.slice(start + 1)) {
    const h = line.trim().match(/^(#+)\s/);
    if (h && h[1].length <= level) break;
    section.push(line);
  }
  const fields = { what: '', why: '', risk: '' };
  let current = null;
  for (const line of section) {
    const m = line.match(/^\s*(?:[-*]\s*)?(?:#{1,6}\s*)?(?:\*\*)?(what|why|risk)(?:\*\*)?\s*:?(?:\*\*)?\s*(.*)$/i);
    if (m && (/:/.test(line) || /^\s*#/.test(line))) {
      current = m[1].toLowerCase();
      fields[current] += m[2] + '\n';
    } else if (current) {
      fields[current] += line + '\n';
    }
  }
  for (const k of FIELDS) fields[k] = fields[k].trim();
  return fields;
}

// Unified diff -> [{ path, added, removed, text }], text being the +/- and context lines.
export function parseDiff(diff) {
  const files = [];
  let cur = null;
  let inHunk = false;
  for (const line of String(diff).split('\n')) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m) {
      cur = { path: m[2], added: 0, removed: 0, text: '' };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (line.startsWith('@@')) inHunk = true;
    if (!cur || !inHunk) continue;
    if (line.startsWith('+')) cur.added++;
    else if (line.startsWith('-')) cur.removed++;
    cur.text += line + '\n';
  }
  return files;
}

const PATH_RE = /(?:^|[\s`'"(\[])((?:[\w.-]+\/)*[\w.-]*[\w-]\.(?:m?js|cjs|ts|tsx|jsx|json|md|py|sh|cmd|ps1|ya?ml|html|css|toml|txt)|(?:[\w.-]+\/)+[\w.-]+\/?)(?=$|[\s`'",;:)\]])/g;

// Path-like claims: a word with a known extension or with a slash. URLs are skipped.
export function pathClaims(text) {
  const out = new Set();
  for (const m of String(text).matchAll(PATH_RE)) {
    const p = m[1].replace(/[/.]+$/, '');
    if (/^(https?:|www\.)/.test(p) || /\/\//.test(p) || /^[\d./]+$/.test(p) || !/[a-z]/i.test(p)) continue;
    if (/\s/.test(p) || p.split('/').some((s) => s === '' || /^\d+$/.test(s))) continue;
    // "and/or", "allow/ask/block": slash-separated plain words without a dot are alternatives, not paths
    if (!p.includes('.') && p.split('/').length > 1 && !/[-_]/.test(p) && p.split('/').every((s) => /^[a-z]+$/i.test(s)) && !text.includes(p + '/')) {
      if (!/^(hooks|bin|skills|docs|test|tests|src|lib)\//.test(p)) continue;
    }
    out.add(p);
  }
  return [...out];
}

// A claimed path matches a diff file when it is that file, a suffix of it, or a directory above it.
export function pathInDiff(claim, files) {
  const c = claim.replace(/^\.\//, '');
  return files.some((f) => f.path === c || f.path.endsWith('/' + c) || f.path.startsWith(c + '/') || f.path.includes('/' + c + '/'));
}

// Backticked tokens and bare `name()` calls: identifiers, flags, env vars.
export function symbolClaims(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/`([^`\n]{2,80})`/g)) {
    const t = m[1].trim();
    if (!pathClaims(' ' + t + ' ').length) out.add(t);
  }
  for (const m of String(text).matchAll(/\b([A-Za-z_$][\w$]{2,})\(\)/g)) out.add(m[1] + '()');
  return [...out];
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function symbolInDiff(sym, files) {
  const s = sym.replace(/\(\)$/, '');
  const token = new RegExp(`(?<![\\w$])${escapeRe(s)}(?![\\w$])`);
  if (files.some((f) => (/^[\w$]+$/.test(s) ? token.test(f.text) : f.text.includes(s)) || f.path.includes(s))) return true;
  const words = s.match(/[A-Za-z_$][\w$-]{2,}/g) ?? [];
  return words.length > 1 && words.every((w) => files.some((f) => f.text.includes(w)));
}

// "manifest.json and sync.mjs are unchanged": a file the text says is NOT changed is not a claim.
const NEGATED_AFTER = /^[`'"]?(?:(?!\.\s)[^,;]){0,40}?\b(is|are|stays?|remains?)\s+(unchanged|untouched|not (changed|touched|modified))\b/i;
export function negatedPath(text, p) {
  for (let i = text.indexOf(p); i >= 0; i = text.indexOf(p, i + 1)) {
    if (!NEGATED_AFTER.test(text.slice(i + p.length))) return false;
  }
  return true;
}

// Numbers with 2+ digits (counts, limits, ports). Dates and PR/issue refs (#12) are skipped.
export function numberClaims(text) {
  const out = new Set();
  const t = String(text).replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ').replace(/#\d+/g, ' ').replace(/\b[0-9a-f]{7,40}\b/g, ' ');
  for (const m of t.matchAll(/(?<![\w.])(\d{2,}(?:[.,]\d+)?)(?![\w])/g)) out.add(m[1]);
  return [...out];
}

// Deterministic rules. Returns [{ rule, field, detail }].
export function checkDeterministic(body, diff) {
  const ex = parseExplanation(body);
  if (!ex) return [{ rule: 'no_section', field: null, detail: 'PR body has no "## Explanation" section' }];
  const files = parseDiff(diff);
  const out = [];
  for (const k of FIELDS) if (!ex[k]) out.push({ rule: 'missing_field', field: k, detail: `"${k}" is empty` });

  for (const k of FIELDS) {
    for (const p of pathClaims(ex[k])) {
      if (!pathInDiff(p, files) && !negatedPath(ex[k], p)) out.push({ rule: 'file_not_in_diff', field: k, detail: `names ${p}, which the diff does not touch` });
    }
  }
  for (const k of ['what', 'risk']) {
    for (const s of symbolClaims(ex[k])) {
      if (!symbolInDiff(s, files)) out.push({ rule: 'symbol_not_in_diff', field: k, detail: `names \`${s}\`, which appears nowhere in the diff` });
    }
  }
  const diffText = files.map((f) => f.text).join('\n');
  for (const n of numberClaims(ex.what)) {
    if (!new RegExp(`(?<![\\d.])${escapeRe(n)}(?![\\d]|\\.\\d)`).test(diffText)) out.push({ rule: 'number_not_in_diff', field: 'what', detail: `the number ${n} appears nowhere in the diff` });
  }

  const allText = `${ex.what}\n${ex.why}\n${ex.risk}`;
  const named = pathClaims(allText);
  const lower = allText.toLowerCase();
  for (const f of files) {
    if (f.added + f.removed < BIG_FILE_LINES || TEST_PATH.test(f.path)) continue;
    const base = path.posix.basename(f.path);
    const stem = base.replace(/\.[^.]+$/, '');
    const dir = path.posix.dirname(f.path);
    const mentioned = named.some((p) => pathInDiff(p, [f])) || lower.includes(base.toLowerCase()) ||
      (stem.length > 3 && new RegExp(`\\b${stem.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)) || (dir !== '.' && lower.includes(dir.toLowerCase()));
    if (!mentioned) out.push({ rule: 'undescribed_change', field: 'what', detail: `${f.path} (+${f.added} -${f.removed}) is not mentioned` });
  }

  const risky = files.filter((f) => RISKY_PATH.test(f.path) && !TEST_PATH.test(f.path));
  const removed = files.reduce((n, f) => n + f.removed, 0);
  if (ex.risk && NO_RISK.test(ex.risk.trim()) && (risky.length || removed >= 20)) {
    const why = risky.length ? `touches ${risky.map((f) => f.path).join(', ')}` : `removes ${removed} lines`;
    out.push({ rule: 'risk_omitted', field: 'risk', detail: `Risk says "${ex.risk.trim()}" but the diff ${why}` });
  }
  return out;
}

// Diff for the model: every file's stats, then each file's hunks cut at perFile chars, all cut at total.
export function modelDiff(diff, { perFile = 6000, total = 60000 } = {}) {
  const files = parseDiff(diff);
  let out = 'Files: ' + files.map((f) => `${f.path} +${f.added} -${f.removed}`).join('; ') + '\n\n';
  for (const f of files) {
    if (out.length >= total) {
      out += `[diff cut at ${total} chars]\n`;
      break;
    }
    const t = f.text.length > perFile ? f.text.slice(0, perFile) + `\n[${f.path}: cut, ${f.text.length} chars]\n` : f.text;
    out += `=== ${f.path}\n${t}\n`;
  }
  return out.slice(0, total + 200);
}

export function modelPrompt(ex, diff) {
  return [
    'You check whether a PR author understands their own change. Compare the explanation with the diff.',
    'A mismatch is a claim that would make a reviewer believe something false about the diff: a file, function, flag or behaviour the diff does not contain or contradicts;',
    'a number that disagrees with the diff; a behaviour described in reverse; a motivation the diff contradicts; a significant change in the diff the explanation omits;',
    'a Risk that denies a risk the diff plainly creates (says none or opt-in while the diff makes something run automatically, removes a safeguard, or deletes data).',
    'Not mismatches: simplifications and missing detail; a Risk that is incomplete but denies nothing; numbers, incidents or decisions in Why that come from outside the diff (they cannot be checked against it).',
    'The diff may be cut; do not report what lies in a cut part.',
    'Reply with JSON only, no prose: {"mismatches":[{"field":"what|why|risk","claim":"...","evidence":"..."}],"verdict":"ok|mismatch"}',
    '',
    `EXPLANATION\nWhat: ${ex.what}\nWhy: ${ex.why}\nRisk: ${ex.risk}`,
    '',
    'DIFF',
    modelDiff(diff),
  ].join('\n');
}

// Last {...} in the text, parsed; null when none parses.
export function parseModelJson(text) {
  const s = String(text);
  const entry = (m) => m && typeof m === 'object' && ['field', 'claim', 'evidence'].every((k) => typeof m[k] === 'string');
  const valid = (v) => Array.isArray(v?.mismatches) && v.mismatches.every(entry) && (v.verdict === 'ok' || v.verdict === 'mismatch');
  for (let i = s.lastIndexOf('{"mismatches"'); i >= 0; i = i > 0 ? s.lastIndexOf('{"mismatches"', i - 1) : -1) {
    for (let j = s.lastIndexOf('}'); j > i; j = s.lastIndexOf('}', j - 1)) {
      try {
        const v = JSON.parse(s.slice(i, j + 1));
        if (valid(v)) return v;
      } catch {}
    }
  }
  const m = s.match(/\{[\s\S]*\}/);
  try {
    const v = JSON.parse(m?.[0]);
    if (valid(v)) return v;
  } catch {}
  return null;
}

// Codex reads the prompt from stdin (`-`), so a 60k-char diff never hits an argv limit.
// Any failure (codex missing, timeout, non-zero exit, no JSON) comes back as `checked: false`.
export function runModel(ex, diff, { timeoutSec = 900, codex = process.env.EXPLAIN_CODEX || 'codex' } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'explain-'));
  const last = path.join(tmp, 'last.txt');
  const t0 = Date.now();
  const r = spawnSync(codex, ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', tmp, '-o', last, '-'], {
    input: modelPrompt(ex, diff),
    encoding: 'utf8',
    timeout: timeoutSec * 1000,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
  });
  const ms = Date.now() - t0;
  const all = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const tok = all.match(/tokens used\s*\n?\s*([\d,]+)/i);
  let lastText = '';
  try {
    lastText = fs.readFileSync(last, 'utf8');
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
  const base = { exit: r.status, ms, tokens: tok ? Number(tok[1].replace(/,/g, '')) : null };
  if (r.error) return { ...base, checked: false, reason: r.error.code === 'ETIMEDOUT' ? `codex timed out after ${timeoutSec} s` : `codex did not run (${r.error.code ?? r.error.message})` };
  if (r.status !== 0) return { ...base, checked: false, reason: `codex exited ${r.status ?? r.signal}` };
  const parsed = parseModelJson(lastText) ?? parseModelJson(r.stdout ?? '');
  if (!parsed) return { ...base, checked: false, reason: 'codex reply had no verdict JSON', raw: lastText.slice(0, 2000) };
  return { ...base, checked: true, result: parsed };
}

export function report(body, diff, { model = true, timeoutSec } = {}) {
  const deterministic = checkDeterministic(body, diff);
  const ex = parseExplanation(body);
  const m = model && ex ? runModel(ex, diff, { timeoutSec }) : null;
  const verdict = deterministic.length || m?.result?.verdict === 'mismatch' ? 'mismatch' : m && !m.checked ? 'not checked' : 'ok';
  return { verdict, deterministic, model: m };
}

export function main(argv, out = process.stdout) {
  try {
    const arg = (n) => {
      const i = argv.indexOf(n);
      return i >= 0 ? argv[i + 1] : undefined;
    };
    if (!arg('--body') || !arg('--diff')) throw new Error('usage: explain-check.mjs --body <file> --diff <file> [--no-model] [--json] [--timeout <sec>]');
    const timeoutSec = Number(arg('--timeout') ?? process.env.EXPLAIN_TIMEOUT ?? 900);
    const r = report(fs.readFileSync(arg('--body'), 'utf8'), fs.readFileSync(arg('--diff'), 'utf8'), {
      model: !argv.includes('--no-model'),
      timeoutSec: Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec : 900,
    });
    if (argv.includes('--json')) {
      out.write(JSON.stringify(r, null, 2) + '\n');
    } else {
      out.write(`[explain-gate] ${r.verdict} (warn only)\n`);
      for (const d of r.deterministic) out.write(`- rule ${d.rule}${d.field ? ` (${d.field})` : ''}: ${d.detail}\n`);
      for (const m of r.model?.result?.mismatches ?? []) out.write(`- model (${m.field}): ${m.claim} | ${m.evidence}\n`);
      if (r.model && !r.model.checked) out.write(`- model not checked: ${r.model.reason}\n`);
    }
  } catch (e) {
    if (argv.includes('--json')) out.write(JSON.stringify({ verdict: 'not checked', error: e.message }, null, 2) + '\n');
    else out.write(`[explain-gate] not checked (warn only): ${e.message}\n`);
  }
  return 0;
}

const isEntry = () => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
};
if (isEntry()) process.exitCode = main(process.argv.slice(2));
