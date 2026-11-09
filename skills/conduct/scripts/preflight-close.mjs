#!/usr/bin/env node
// preflight-close.mjs, the conduct slice-close preflight. Strictly read-only: it opens
// a worktree's .conduct/ directory and checks the five mechanical close requirements
// (C1 ledger row, C2 a gate file with red-first evidence, OR a bounded gate-skip diff,
// C3 two-vendor opinions or a stated skip, C4 fusion with all four sections or a stated
// skip, C5 review coverage: every implementer vendor family needs a current, independent
// review leg). C2 and C5 share one family-coverage check, bound to a `slice-state v1` hash
// over the raw bytes of every changed path (merge-base, untracked included, .conduct/
// excluded); a leg is current only when its `diff-sha256` matches that hash, and it also
// checks the index blob against the worktree bytes for every changed path ("stage or
// revert before close"). `--diff-patch <worktree> --slice <s> [--base <ref>]` prints that
// header (`slice-state: v1`, `diff-base:`, `diff-sha256:`) followed by the canonical patch,
// for the conductor to save and stamp into each leg file. Every git call here (rev-parse,
// merge-base, diff --numstat, diff --raw, diff --cached, cat-file, ls-files; execFileSync,
// no shell, a timeout, --no-optional-locks and gitconfig overrides that beat repo/user
// config, never a write) measures the diff from merge-base(HEAD, a resolved base) through
// the index and the working tree, including untracked files; the base is the CLI
// `--base <ref>` flag or the first of origin/HEAD, origin/main, origin/dev, main, dev
// that resolves. It never writes, renames or deletes anything in the checked worktree;
// --self-test builds and removes its own fixtures under the OS temp directory only.
// Node 24, ES modules, no dependencies, Windows first.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const EXIT_ALL_PASS = 0;
const EXIT_CHECK_FAILED = 2; // matches reap's blocking convention: nonzero blocks the close
const EXIT_BAD_INVOCATION = 1;

const VENDOR_PREFIXES = ['codex', 'grok', 'luna', 'sol', 'sonnet', 'opus', 'fable', 'cursor', 'composer', 'deepseek', 'haiku', 'gpt', 'claude'];

function add(list, value) {
  list[list.length] = value;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readTextIfFile(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function listConduct(conductDir) {
  try {
    return readdirSync(conductDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
}

const MIN_LEG_CHARS = 50; // an "opinion" or "review" shorter than this is not one
const MAX_LEDGER_BYTES = 5 * 1024 * 1024;
const RED_INDICATOR_RE = /\bfail|\bred\b|✗|exit code 1|assertions/i;

// The ledger is a markdown table; the row for a slice is the line whose first cell,
// trimmed, equals the slice token (case-insensitive, so S20 and s20 are one slice).
function findLedgerRow(ledgerLines, slice) {
  const want = slice.toLowerCase();
  for (let i = 0; i < ledgerLines.length; i += 1) {
    const line = ledgerLines[i];
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    // cells[0] is the empty string before the leading pipe
    if (cells.length > 1 && cells[1].toLowerCase() === want) return { line, index: i };
  }
  return null;
}

function isTableSeparator(line) {
  return /^\s*\|[\s:|-]*-[\s:|-]*\|?\s*$/.test(line);
}

// A ledger cell is resolved against the header of the table that CONTAINS the slice row
// (the row immediately above that table's |---| separator), never against an earlier
// table that happens to mention the same header word.
function findLedgerCell(ledgerLines, rowIndex, headerNameRe) {
  let separatorIndex = -1;
  for (let i = rowIndex - 1; i >= 0; i -= 1) {
    if (isTableSeparator(ledgerLines[i])) {
      separatorIndex = i;
      break;
    }
    if (!ledgerLines[i].trimStart().startsWith('|')) return null;
  }
  if (separatorIndex < 1) return null;
  const header = ledgerLines[separatorIndex - 1];
  if (!header.trimStart().startsWith('|')) return null;
  const headerIndex = header.split('|').findIndex((cell) => headerNameRe.test(cell));
  if (headerIndex === -1) return null;
  const rowCells = ledgerLines[rowIndex].split('|').map((cell) => cell.trim());
  return headerIndex < rowCells.length ? rowCells[headerIndex] : null;
}

function findOpinionVendorsCell(ledgerLines, rowIndex) {
  return findLedgerCell(ledgerLines, rowIndex, /opinion/i);
}

function findWorkerCell(ledgerLines, rowIndex) {
  return findLedgerCell(ledgerLines, rowIndex, /worker/i);
}

// The skip record grammar (spec: fusion-gateskip.md, Decision item 1): a `skipped:` line
// listing comma-separated tokens from {opinion, fusion, gate} (any unknown token makes the
// whole record invalid) and a `reason:` line of at least this many characters. Nothing else
// in the file counts, so prose mentioning a token is not a skip.
const SKIP_TOKENS = new Set(['opinion', 'fusion', 'gate']);
const MIN_SKIP_REASON_CHARS = 40;

function parseSkipRecord(text) {
  if (text === null) return { valid: false, tokens: new Set(), invalidReason: 'no skip file' };
  let tokens = new Set();
  let tokensValid = false;
  let reasonOk = false;
  let skippedLineCount = 0;
  let reasonLineCount = 0;
  for (const line of text.split(/\r?\n/)) {
    const skippedMatch = /^\s*skipped\s*:\s*(.*)$/i.exec(line);
    if (skippedMatch) {
      skippedLineCount += 1;
      // No filtering out empty entries: "gate," (a trailing comma) must not silently
      // become "gate" - an empty token is exactly as invalid as an unrecognized one.
      const raw = skippedMatch[1].split(',').map((token) => token.trim().toLowerCase());
      tokens = new Set(raw);
      tokensValid = raw.length > 0 && raw.every((token) => SKIP_TOKENS.has(token));
    }
    const reasonMatch = /^\s*reason\s*:\s*(.*)$/i.exec(line);
    if (reasonMatch) {
      reasonLineCount += 1;
      reasonOk = reasonMatch[1].trim().length >= MIN_SKIP_REASON_CHARS;
    }
  }
  // A second skipped:/reason: line is not "the latest wins" - it makes the record
  // ambiguous (which one did the operator mean?), so it invalidates the whole record
  // rather than silently taking the first or the last.
  let invalidReason = null;
  if (skippedLineCount === 0) invalidReason = 'no "skipped:" line';
  else if (skippedLineCount > 1) invalidReason = 'more than one "skipped:" line';
  else if (!tokensValid) invalidReason = `the "skipped:" line must list only ${[...SKIP_TOKENS].join(', ')}, with no empty entries`;
  else if (reasonLineCount === 0) invalidReason = 'no "reason:" line';
  else if (reasonLineCount > 1) invalidReason = 'more than one "reason:" line';
  else if (!reasonOk) invalidReason = `the "reason:" line is under ${MIN_SKIP_REASON_CHARS} characters`;
  const valid = invalidReason === null;
  return { valid, tokens: valid ? tokens : new Set(), invalidReason };
}

// Vendor family map for the C2 gate-skip independence check (spec: fusion-gateskip.md,
// Decision item 2). Every VENDOR_PREFIXES entry (used for C5's review-leg filenames) maps
// to exactly one family here; the ledger worker cell is free text, matched loosely.
const VENDOR_FAMILIES = {
  openai: ['codex', 'luna', 'sol', 'gpt'],
  anthropic: ['claude', 'sonnet', 'opus', 'fable', 'haiku'],
  xai: ['grok'],
  deepseek: ['deepseek'],
  cursor: ['cursor', 'composer'],
};

// Family comes from the MODEL, not the harness: a ledger worker cell like
// "deepseek-v4-flash@grok-cli" runs a DeepSeek model through a Grok-branded harness, so
// only the part before "@" is considered, and only as a LEADING token - a substring match
// anywhere would wrongly catch "grok" inside "grok-cli", or "sol" inside unrelated text
// like "console".
function vendorFamily(text) {
  if (!text) return null;
  const modelPart = text.split('@')[0].trim().toLowerCase();
  if (modelPart === '') return null;
  for (const [family, keys] of Object.entries(VENDOR_FAMILIES)) {
    const leadingTokenRe = new RegExp(`^(?:${keys.map(escapeRegExp).join('|')})\\b`, 'i');
    if (leadingTokenRe.test(modelPart)) return family;
  }
  return null;
}

// Implementer set extraction (spec: fusion-reviewbind.md, Decision item 1): strip balanced
// parentheses (a parenthetical model mention is context, not an implementer - a denied cast,
// a note), split what remains on "," and "+", vendorFamily() each trimmed segment. An empty
// segment (blank cell, stray comma) or any segment that does not map to a known family fails
// the whole set closed - a worker cell this preflight cannot parse gets no benefit of the
// doubt.
function implementerFamilies(workerCell) {
  if (!workerCell) return null;
  let stripped = workerCell;
  let previous;
  do {
    previous = stripped;
    stripped = stripped.replace(/\([^()]*\)/g, '');
  } while (stripped !== previous);
  const segments = stripped.split(/[,+]/).map((segment) => segment.trim());
  const families = new Set();
  for (const segment of segments) {
    if (segment === '') return null;
    const family = vendorFamily(segment);
    if (family === null) return null;
    families.add(family);
  }
  return families.size > 0 ? families : null;
}

// Shared by C2 (independence check) and C5 (review-leg presence): every substantive
// <vendor>-<slice>*.md file, in listing order. C2 must scan all of them for one that is
// independent of the worker - stopping at the first leg found (as opposed to the first
// INDEPENDENT one) can reject a slice that has a perfectly good independent leg sitting
// right after a same-family one.
function findReviewLegs(names, conductDir, s) {
  const reviewRe = new RegExp(`^(${VENDOR_PREFIXES.join('|')})-${s}([._-].*)?\\.md$`, 'i');
  const legs = [];
  for (const name of names) {
    const match = reviewRe.exec(name);
    if (match === null) continue;
    const text = readTextIfFile(path.join(conductDir, name));
    if (text !== null && text.trim().length >= MIN_LEG_CHARS) add(legs, { name, vendor: match[1].toLowerCase(), text });
  }
  return legs;
}

// Leg binding lines (spec: fusion-reviewbind.md, Decision item 4): each recognized at line
// start, anywhere in the file. Exactly one `diff-sha256:` and exactly one `review-scope:`
// line whose value is exactly `full`, OR exactly one `delta-from:` line and no
// `review-scope:` line at all - every `review-scope:` line is counted regardless of its
// value, so `review-scope: partial` next to a later `review-scope: full` is two scope lines
// (ambiguous, unbound), not a bare pass-through for the one that happens to say `full`.
function parseLegBinding(text) {
  const diffLines = [];
  const scopeValues = [];
  const deltaValues = [];
  for (const line of text.split(/\r?\n/)) {
    // Every line starting with the label counts, whatever follows it - an invalid value
    // (e.g. "TBD") must still count toward "duplicate diff-sha256 lines", the same way a
    // malformed review-scope/delta-from line already does below, or a leg with one valid
    // and one placeholder line would wrongly bind to the valid one.
    const diffMatch = /^\s*diff-sha256\s*:(.*)$/i.exec(line);
    if (diffMatch) add(diffLines, diffMatch[1].trim());
    const scopeMatch = /^\s*review-scope\s*:(.*)$/i.exec(line);
    if (scopeMatch) add(scopeValues, scopeMatch[1].trim().toLowerCase());
    const deltaMatch = /^\s*delta-from\s*:(.*)$/i.exec(line);
    if (deltaMatch) add(deltaValues, deltaMatch[1].trim().toLowerCase());
  }
  if (diffLines.length === 0) return { ok: false, reason: 'no diff-sha256 line' };
  if (diffLines.length > 1) return { ok: false, reason: 'duplicate diff-sha256 lines' };
  const diffMatch64 = /^[0-9a-f]{64}$/i.exec(diffLines[0]);
  if (diffMatch64 === null) return { ok: false, reason: 'diff-sha256 is not a 64-hex hash' };
  const diffSha256 = diffMatch64[0].toLowerCase();
  const scopeLineCount = scopeValues.length + deltaValues.length;
  if (scopeLineCount === 0) return { ok: false, reason: 'no review-scope or delta-from line' };
  if (scopeLineCount > 1) return { ok: false, reason: 'more than one review-scope/delta-from line' };
  if (scopeValues.length === 1) {
    return scopeValues[0] === 'full'
      ? { ok: true, diffSha256, scope: 'full', deltaFrom: null }
      : { ok: false, reason: `review-scope is "${scopeValues[0]}", not "full"` };
  }
  const deltaMatch64 = /^[0-9a-f]{64}$/.exec(deltaValues[0]);
  return deltaMatch64 === null
    ? { ok: false, reason: 'delta-from is not a 64-hex hash' }
    : { ok: true, diffSha256, scope: 'delta', deltaFrom: deltaMatch64[0] };
}

// Whether leg `candidate` qualifies as independent evidence for implementer family `family`
// (spec item 5): its own vendor family must differ from `family`, and it is either a full
// review or a delta whose `delta-from` chain resolves, hash by hash, to a full leg with
// every link's family also different from `family`. `legsByHash` need not be current legs -
// an earlier full review stays a valid chain anchor after the slice has moved on from it.
function legIndependentFor(candidate, family, legsByHash, visited) {
  if (visited.has(candidate)) return false; // cycle guard; a real chain never revisits a leg
  visited.add(candidate);
  if (vendorFamily(candidate.vendor) === family) return false;
  if (candidate.binding.scope === 'full') return true;
  const ancestors = legsByHash.get(candidate.binding.deltaFrom) ?? [];
  return ancestors.some((ancestor) => legIndependentFor(ancestor, family, legsByHash, visited));
}

// Coverage (spec item 5, D2): for every implementer family, at least one CURRENT
// (diff-sha256 == currentHash) leg independent of that family, per legIndependentFor above.
// Returns, per family, the qualifying leg or null - never a boolean, so callers can name the
// leg that closed the gap and the one that didn't.
function familyCoverage(families, legs, currentHash) {
  const bound = legs
    .map((leg) => ({ ...leg, binding: parseLegBinding(leg.text) }))
    .filter((leg) => leg.binding.ok);
  const legsByHash = new Map();
  for (const leg of bound) {
    const list = legsByHash.get(leg.binding.diffSha256) ?? [];
    list.push(leg);
    legsByHash.set(leg.binding.diffSha256, list);
  }
  const currentLegs = bound.filter((leg) => leg.binding.diffSha256 === currentHash);
  const coverage = new Map();
  for (const family of families) {
    const qualifying = currentLegs.find((leg) => legIndependentFor(leg, family, legsByHash, new Set())) ?? null;
    coverage.set(family, qualifying);
  }
  return coverage;
}

// A one-line reason a single leg does not qualify for `family`, for the C5/C2 "missing
// coverage" detail: unbound (and why - no diff-sha256, a duplicate, a bad scope), stale
// (bound to a state that is no longer current), or same vendor family. A leg that IS current
// and independent but whose delta chain still fails to resolve gets the generic fallback -
// legIndependentFor does not track which link in a chain broke, only whether one did.
function legFailureReason(leg, family, currentHash) {
  const binding = parseLegBinding(leg.text);
  if (!binding.ok) return `${leg.name}: unbound (${binding.reason})`;
  if (binding.diffSha256 !== currentHash) return `${leg.name}: stale (bound to a different diff-sha256)`;
  if (vendorFamily(leg.vendor) === family) return `${leg.name}: same vendor family (${family})`;
  return `${leg.name}: its delta-from chain does not resolve to a full review outside ${family}`;
}

const GIT_TIMEOUT_MS = 10_000;
const SLICE_BASE_CANDIDATES = ['origin/HEAD', 'origin/main', 'origin/dev', 'main', 'dev'];
const GATE_SKIP_MIN_LINES = 1;
const GATE_SKIP_MAX_LINES = 30;
const GATE_SKIP_MIN_FILES = 1;
const GATE_SKIP_MAX_FILES = 2;

// A repo or user gitconfig can change what a diff reports (diff.ignoreSubmodules=all
// hides gitlink changes entirely; core.quotepath can mangle non-ASCII paths). These -c
// overrides go on EVERY git invocation in the skip path, command-line config beats
// repo/user config, so a hostile or stale .git/config cannot suppress what gets measured.
const GIT_GLOBAL_ARGS = ['-c', 'diff.ignoreSubmodules=none', '-c', 'core.quotepath=false', '--no-optional-locks', '--literal-pathspecs'];
// Same principle, for the `git diff` subcommand specifically: never let ext-diff/textconv
// filters or a submodule-ignore setting rewrite what a diff call reports. --full-index keeps
// a rendered patch's "index" line at full length; --no-abbrev is the separate flag that
// controls --raw's sha1 columns (--full-index does not touch those) - without it, a repo's
// core.abbrev or git's own default abbreviates them, and an abbreviated all-zero "added"
// placeholder is not the same string as a 40-hex one, breaking baseOid detection.
const DIFF_OVERRIDE_ARGS = ['--ignore-submodules=none', '--no-ext-diff', '--no-textconv', '--full-index', '--no-abbrev', '--no-color'];

// git prints an all-zero sha for "no object on this side" (a raw-diff addition/deletion);
// its length can still vary by git version/config, so this checks the digits, not a fixed
// 40-character literal.
function isZeroSha(sha) {
  return /^0+$/.test(sha);
}

// An output-size limit must not read as a git failure.
const GIT_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

function runGitReadOnlyBuffer(cwd, args) {
  try {
    return execFileSync('git', [...GIT_GLOBAL_ARGS, ...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

function runGitReadOnly(cwd, args) {
  const buffer = runGitReadOnlyBuffer(cwd, args);
  return buffer === null ? null : buffer.toString('utf8');
}

// Parses `git diff --numstat -z` output (NUL-delimited "added\tdeleted\tpath" records)
// into path -> { binary, added, deleted }.
function parseNumstatZ(output) {
  const map = new Map();
  for (const record of output.split('\0')) {
    if (record === '') continue;
    const [added, deleted, ...rest] = record.split('\t');
    const file = rest.join('\t');
    if (file.startsWith('.conduct/')) continue;
    if (added === '-' || deleted === '-') map.set(file, { binary: true, added: null, deleted: null });
    else map.set(file, { binary: false, added: Number(added), deleted: Number(deleted) });
  }
  return map;
}

function measurementLines(entry) {
  return entry === undefined || entry.binary ? 0 : entry.added + entry.deleted;
}

// `git diff --raw -z` records look like ":<old_mode> <new_mode> <old_sha> <new_sha> <status>"
// NUL, "<path>" NUL, repeated (--no-renames keeps it to one path per record). Parsed once
// into structured rows and reused for both the gitlink check and the add/delete
// classification below, so status comes from git's own verdict, not from a line-count
// heuristic that cannot tell "empty file added" from "nothing changed".
function parseRawZ(output) {
  const tokens = output.split('\0');
  const rows = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const match = /^:(\S+) (\S+) (\S+) (\S+) (\S)/.exec(tokens[i]);
    if (match === null) continue;
    const file = tokens[i + 1] ?? '';
    if (!file.startsWith('.conduct/')) {
      add(rows, { oldMode: match[1], newMode: match[2], oldSha: match[3], newSha: match[4], status: match[5], file });
    }
    i += 1; // the path token was just consumed
  }
  return rows;
}

// Mode 160000 is a gitlink (submodule pointer); a mechanical slice never legitimately
// touches one, so any gitlink row on either side is a hard stop - counted separately from
// numstat's line/file thresholds, never waved through by size.
function rawDiffHasGitlink(rows) {
  return rows.some((row) => row.oldMode === '160000' || row.newMode === '160000');
}

function rawStatusMap(rows) {
  const map = new Map();
  for (const row of rows) map.set(row.file, row.status);
  return map;
}

// A commit ships the INDEX, not the working tree: `git add` then `git restore --worktree`
// leaves a big staged change with a working tree that looks untouched. Measuring only the
// worktree diff misses it entirely, so both sides are measured and, per path, the larger
// changed-line count wins; either side flagging binary makes the path binary.
function mergeTrackedMeasurements(worktreeMap, indexMap) {
  const combined = new Map();
  for (const file of new Set([...worktreeMap.keys(), ...indexMap.keys()])) {
    const w = worktreeMap.get(file);
    const i = indexMap.get(file);
    combined.set(file, { binary: Boolean(w?.binary) || Boolean(i?.binary), lines: Math.max(measurementLines(w), measurementLines(i)) });
  }
  return combined;
}

function resolveSliceBase(worktreePath, baseArg) {
  const candidates = baseArg ? [baseArg] : SLICE_BASE_CANDIDATES;
  for (const ref of candidates) {
    const out = runGitReadOnly(worktreePath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (out !== null && out.trim() !== '') return { ref, sha: out.trim() };
  }
  return null;
}

// A NUL byte anywhere (not just in a leading probe window, which a crafted file can pad
// past) or content that is not valid UTF-8 both mean this is not a text file whose line
// count means anything.
function isBinaryContent(buffer) {
  if (buffer.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return false;
  } catch {
    return true;
  }
}

function countFileLines(buffer) {
  if (buffer.length === 0) return 0;
  const parts = buffer.toString('utf8').split(/\r?\n/);
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

const MAX_TRACKED_BLOB_BYTES = 1024 * 1024; // 1 MiB; also keeps blob reads well under execFileSync's default maxBuffer

// `git cat-file -e <spec>` exits 0 when the object exists. Only a real (numeric) exit
// status counts as "the object is missing" - a spawn failure, timeout or signal is a
// genuine error and must never be read as evidence of absence.
function gitObjectPresence(cwd, spec) {
  try {
    execFileSync('git', [...GIT_GLOBAL_ARGS, 'cat-file', '-e', spec], { cwd, timeout: GIT_TIMEOUT_MS, stdio: 'ignore' });
    return 'present';
  } catch (error) {
    return typeof error?.status === 'number' ? 'absent' : 'error';
  }
}

function gitBlobSize(cwd, spec) {
  const out = runGitReadOnly(cwd, ['cat-file', '-s', spec]);
  if (out === null) return null;
  const size = Number(out.trim());
  return Number.isInteger(size) ? size : null;
}

// Reads and binary-checks one git-object version (merge-base or index) of a tracked path.
// Absence is accepted only when git PROVES the object is missing AND the measured diff
// already implied that absence (expectedAbsent); any other outcome - a git error, an
// oversized blob, an unreadable blob, or an absence the diff did not predict - fails
// closed instead of being silently treated as "not binary".
function checkBlobVersion(cwd, spec, label, file, expectedAbsent) {
  const presence = gitObjectPresence(cwd, spec);
  if (presence === 'error') return `could not determine whether the ${label} of ${file} exists`;
  if (presence === 'absent') {
    return expectedAbsent ? null : `the ${label} of ${file} is missing, but the measured diff did not expect that`;
  }
  const size = gitBlobSize(cwd, spec);
  if (size === null) return `could not read the size of the ${label} of ${file}`;
  if (size > MAX_TRACKED_BLOB_BYTES) return `the ${label} of ${file} is ${size} bytes, over the ${MAX_TRACKED_BLOB_BYTES}-byte gate-skip cap`;
  const content = runGitReadOnlyBuffer(cwd, ['cat-file', 'blob', spec]);
  if (content === null) return `could not read the ${label} of ${file}`;
  return isBinaryContent(content) ? `binary content in the ${label} of ${file}` : null;
}

// The worktree side has no git object to probe for existence; ENOENT is the only
// legitimate absence, any other stat/read error fails closed.
function checkWorktreeVersion(worktreePath, file) {
  const absPath = path.join(worktreePath, file);
  let stats;
  try {
    stats = statSync(absPath);
  } catch (error) {
    return error?.code === 'ENOENT' ? null : `could not stat the worktree file ${file}`;
  }
  if (stats.size > MAX_TRACKED_BLOB_BYTES) return `the worktree file ${file} is ${stats.size} bytes, over the ${MAX_TRACKED_BLOB_BYTES}-byte gate-skip cap`;
  let content;
  try {
    content = readFileSync(absPath);
  } catch {
    return `could not read the worktree file ${file}`;
  }
  return isBinaryContent(content) ? `binary content in the worktree file ${file}` : null;
}

// The gate-skip diff: merge-base(HEAD, base) through the working tree, staged, unstaged
// and untracked, excluding .conduct/, reusing collectSliceStateInputs' base resolution and
// raw-diff rows (defined below) so this and the slice-state hash never diverge on which
// paths count; the only git calls this adds are the two --numstat reads (a shared raw diff
// has no line counts). Any git failure fails closed with a remedy, never a crash; a binary
// row (tracked, numstat prints "-\t-") or an unreadable untracked file also fails closed
// rather than guessing a line count. Unlike slice-state, a gitlink row is a hard stop here
// regardless of size - a mechanical gate-skip has no business touching a submodule pointer.
function evaluateGateSkipDiff(worktreePath, baseArg) {
  const inputs = collectSliceStateInputs(worktreePath, baseArg, 'gate skip');
  if (!inputs.ok) return inputs;
  const { base, mergeBaseSha, worktreeRows, cachedRows, untrackedFiles } = inputs;
  if (rawDiffHasGitlink(worktreeRows) || rawDiffHasGitlink(cachedRows)) {
    return { ok: false, detail: `gate skip: submodule change needs a real gate (base ${base.ref})`, remedy: 'add the gate for a slice that touches a submodule/gitlink' };
  }
  const worktreeNumstatOut = runGitReadOnly(worktreePath, ['diff', '--no-renames', ...DIFF_OVERRIDE_ARGS, '--numstat', '-z', mergeBaseSha]);
  const cachedNumstatOut = runGitReadOnly(worktreePath, ['diff', '--cached', '--no-renames', ...DIFF_OVERRIDE_ARGS, '--numstat', '-z', mergeBaseSha]);
  if (worktreeNumstatOut === null || cachedNumstatOut === null) {
    return { ok: false, detail: `gate skip: git diff --numstat against ${base.ref} failed`, remedy: 'ensure the worktree is a readable git repository' };
  }
  const worktreeNumstatMap = parseNumstatZ(worktreeNumstatOut);
  const indexNumstatMap = parseNumstatZ(cachedNumstatOut);
  const trackedMeasurements = mergeTrackedMeasurements(worktreeNumstatMap, indexNumstatMap);
  const worktreeStatusMap = rawStatusMap(worktreeRows);
  const indexStatusMap = rawStatusMap(cachedRows);

  let lines = 0;
  let files = 0;
  let binary = false;
  for (const measurement of trackedMeasurements.values()) {
    if (measurement.binary) {
      binary = true;
      continue;
    }
    lines += measurement.lines;
    files += 1;
  }
  for (const file of untrackedFiles) {
    const absPath = path.join(worktreePath, file);
    let stats;
    try {
      stats = statSync(absPath);
    } catch {
      binary = true;
      continue;
    }
    // Same cap as every tracked version, checked before the read: an untracked file is
    // not exempt from the size limit just because it has no git object to size first.
    if (stats.size > MAX_TRACKED_BLOB_BYTES) {
      return { ok: false, detail: `gate skip: the untracked file ${file} is ${stats.size} bytes, over the ${MAX_TRACKED_BLOB_BYTES}-byte gate-skip cap`, remedy: 'keep every changed file under the gate-skip size cap, or add the gate' };
    }
    let content;
    try {
      content = readFileSync(absPath);
    } catch {
      binary = true;
      continue;
    }
    if (isBinaryContent(content)) {
      binary = true;
      continue;
    }
    lines += countFileLines(content);
    files += 1;
  }

  if (binary) {
    return { ok: false, detail: `gate skip: binary content in the diff (base ${base.ref}, ${lines} changed line(s) in ${files} file(s))`, remedy: 'a gate skip cannot cover a binary change; add the gate instead' };
  }
  if (files < GATE_SKIP_MIN_FILES || files > GATE_SKIP_MAX_FILES || lines < GATE_SKIP_MIN_LINES || lines > GATE_SKIP_MAX_LINES) {
    return {
      ok: false,
      detail: `gate skip: base ${base.ref}, ${lines} changed line(s) in ${files} file(s) (need ${GATE_SKIP_MIN_LINES}..${GATE_SKIP_MAX_LINES} lines across ${GATE_SKIP_MIN_FILES}..${GATE_SKIP_MAX_FILES} files, excluding .conduct/)`,
      remedy: `keep the gate-skip slice to ${GATE_SKIP_MIN_LINES}..${GATE_SKIP_MAX_LINES} changed lines across ${GATE_SKIP_MIN_FILES}..${GATE_SKIP_MAX_FILES} files, or add the gate`,
    };
  }

  // git's own numstat binary detection only probes a leading window of each blob, so a
  // tracked file can clear the check above and still be binary past that window. This
  // full-buffer re-check is bounded to the (at most 2) tracked paths already in the
  // measured diff, and only runs once the cheap thresholds already passed - a slice that
  // is already going to fail does not need the extra reads. It checks all THREE versions
  // of each path (merge-base blob, index blob, worktree file): a deletion can leave
  // nothing to read in the index or the worktree, so only the merge-base blob still
  // proves whether that deleted content was binary. Expected absence comes from git's own
  // --raw status letter (A/D), not from a 0/0 line count, which an empty file also has.
  for (const file of trackedMeasurements.keys()) {
    const expectedAbsentAtMergeBase = worktreeStatusMap.get(file) === 'A' || indexStatusMap.get(file) === 'A';
    const expectedAbsentAtIndex = indexStatusMap.get(file) === 'D';

    const failure =
      checkBlobVersion(worktreePath, `${mergeBaseSha}:${file}`, 'merge-base blob', file, expectedAbsentAtMergeBase) ??
      checkBlobVersion(worktreePath, `:${file}`, 'index blob', file, expectedAbsentAtIndex) ??
      checkWorktreeVersion(worktreePath, file);
    if (failure !== null) {
      return { ok: false, detail: `gate skip: ${failure} (base ${base.ref}, ${lines} changed line(s) in ${files} file(s))`, remedy: 'a gate skip needs every version of a changed path to be a small, readable, non-binary file; add the gate instead' };
    }
  }

  return { ok: true, base, lines, files };
}

// ---- slice-state v1 (spec: fusion-reviewbind.md, Decision items 2-3): a hash over the raw
// bytes of every path the slice touches, binding a review leg to exactly the state it saw.

const MAX_SLICE_STATE_BLOB_BYTES = MAX_TRACKED_BLOB_BYTES;
const SLICE_STATE_VERSION = 'v1';

function pathsFromRows(rows) {
  return rows.map((row) => row.file);
}

// Resolves the merge-base and both raw-diff row sets (worktree, index) plus the untracked
// listing that make up path set D; everything else in this section, and evaluateGateSkipDiff
// above, builds on this one read, so C2 and C5 never repeat the git calls or diverge on which
// paths count. `label` prefixes every detail message ('slice-state' or 'gate skip') so a
// caller's error text stays in its own voice without a second, duplicate implementation. A
// gitlink (submodule) row is left for the caller to judge: slice-state records it as content
// (see gitlinkFactFor), gate-skip still rejects it outright.
function collectSliceStateInputs(worktreePath, baseArg, label = 'slice-state') {
  const base = resolveSliceBase(worktreePath, baseArg);
  if (base === null) {
    const tried = baseArg ? [baseArg] : SLICE_BASE_CANDIDATES;
    return { ok: false, detail: `${label}: could not resolve a base ref (tried ${tried.join(', ')})`, remedy: 'pass --base <ref>, or ensure one of origin/HEAD, origin/main, origin/dev, main, dev resolves' };
  }
  const mergeBaseOut = runGitReadOnly(worktreePath, ['merge-base', 'HEAD', base.sha]);
  if (mergeBaseOut === null || mergeBaseOut.trim() === '') {
    return { ok: false, detail: `${label}: could not compute merge-base(HEAD, ${base.ref})`, remedy: 'ensure HEAD and the base ref share history' };
  }
  const mergeBaseSha = mergeBaseOut.trim();
  const worktreeRawOut = runGitReadOnly(worktreePath, ['diff', '--no-renames', ...DIFF_OVERRIDE_ARGS, '--raw', '-z', mergeBaseSha]);
  const cachedRawOut = runGitReadOnly(worktreePath, ['diff', '--cached', '--no-renames', ...DIFF_OVERRIDE_ARGS, '--raw', '-z', mergeBaseSha]);
  if (worktreeRawOut === null || cachedRawOut === null) {
    return { ok: false, detail: `${label}: git diff --raw against ${base.ref} failed`, remedy: 'ensure the worktree is a readable git repository' };
  }
  const worktreeRows = parseRawZ(worktreeRawOut);
  const cachedRows = parseRawZ(cachedRawOut);
  const untrackedOut = runGitReadOnly(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (untrackedOut === null) {
    return { ok: false, detail: `${label}: git ls-files --others failed`, remedy: 'ensure the worktree is a readable git repository' };
  }
  const untrackedFiles = untrackedOut.split('\0').filter((file) => file !== '' && !file.startsWith('.conduct/'));
  const paths = new Set([...pathsFromRows(worktreeRows), ...pathsFromRows(cachedRows), ...untrackedFiles]);
  const indexEntries = collectIndexEntries(worktreePath, paths);
  if (indexEntries === null) {
    return { ok: false, detail: `${label}: git ls-files -s failed`, remedy: 'ensure the worktree is a readable git repository' };
  }
  const filemodeEnabled = coreFilemodeEnabled(worktreePath);
  const indexWorktreeDiffPaths = collectIndexWorktreeDiffPaths(worktreePath);
  if (indexWorktreeDiffPaths === null) {
    return { ok: false, detail: `${label}: git diff --name-only (index vs worktree) failed`, remedy: 'ensure the worktree is a readable git repository' };
  }
  return { ok: true, base, mergeBaseSha, worktreeRows, cachedRows, untrackedFiles, paths, indexEntries, filemodeEnabled, indexWorktreeDiffPaths };
}

// The set of paths where the index currently differs from the working tree - git's own diff
// engine decides this (never dereferencing a symlink, unlike `hash-object` on its target),
// so a symlink pointing anywhere no longer produces a false "stage or revert". Untracked
// paths never appear here (a plain `git diff` with no ref only ever compares tracked paths),
// which is exactly the exemption C5's mismatch check needs. core.filemode=false for this one
// diff: shipModeFor already takes a chmod-only staged mode from the index unconditionally, so
// a worktree file whose real permission bit hasn't caught up is not a "stage or revert" case.
function collectIndexWorktreeDiffPaths(worktreePath) {
  const out = runGitReadOnly(worktreePath, ['-c', 'core.filemode=false', 'diff', '--no-renames', ...DIFF_OVERRIDE_ARGS, '--name-only', '-z']);
  if (out === null) return null;
  return new Set(out.split('\0').filter((file) => file !== '' && !file.startsWith('.conduct/')));
}

// Splits pathspec args across multiple git invocations so the combined argv (plus git's own
// prefix args) stays well under a shell/OS command-line limit - a slice can touch thousands
// of paths even though this project's own is always small.
const LS_FILES_ARG_BATCH_BYTES = 30_000;

function batchPathsByByteLength(paths, maxBytes) {
  const batches = [];
  let current = [];
  let currentBytes = 0;
  for (const p of paths) {
    const bytes = Buffer.byteLength(p, 'utf8') + 1;
    if (current.length > 0 && currentBytes + bytes > maxBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(p);
    currentBytes += bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

// `git ls-files -s` always prints full 40-hex blob ids and never abbreviates, so this map is
// the one authoritative source for "what mode and blob does the index currently hold for
// this path" - used for both the digest's ship-mode field and the C5 index/worktree compare,
// replacing an earlier version derived from --cached --raw rows (subject to the same
// abbreviation risk --no-abbrev above fixes for the base/worktree side). Restricted to path
// set D (batched): a full-index read costs nothing on this project but is needless work, and
// on a real repo with a large tree it is the one call that actually needs the argv batching.
function collectIndexEntries(worktreePath, paths) {
  const pathList = [...paths];
  if (pathList.length === 0) return new Map();
  const map = new Map();
  for (const batch of batchPathsByByteLength(pathList, LS_FILES_ARG_BATCH_BYTES)) {
    const out = runGitReadOnly(worktreePath, ['ls-files', '-s', '-z', '--', ...batch]);
    if (out === null) return null;
    for (const record of out.split('\0')) {
      if (record === '') continue;
      // 40 hex for a sha1 repo, 64 for a sha256 one (`git init --object-format=sha256`);
      // either is a real, full-length oid, never abbreviated by ls-files -s.
      const match = /^(\d+) ([0-9a-f]{40}|[0-9a-f]{64}) \d+\t([\s\S]*)$/.exec(record);
      if (match !== null) map.set(match[3], { mode: match[1], oid: match[2] });
    }
  }
  return map;
}

// core.filemode is git's own auto-detected (or operator-set) answer to "does this
// filesystem's executable bit mean anything"; unreadable/unset defaults to false (matching
// this project's Windows-first default) rather than guessing a platform.
function coreFilemodeEnabled(worktreePath) {
  const out = runGitReadOnly(worktreePath, ['config', '--type=bool', 'core.filemode']);
  return out !== null && out.trim() === 'true';
}

function rowByFile(rows) {
  const map = new Map();
  for (const row of rows) map.set(row.file, row);
  return map;
}

function framedField(value) {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

const STREAM_CHUNK_BYTES = 64 * 1024;

// Streams a file through sha256 in fixed-size chunks so a file of any size is hashed without
// ever holding the whole thing in memory - a multi-hundred-MB lockfile must bind exactly like
// a 10-byte one; the digest is a hash, not a review artifact.
function sha256OfFile(absPath) {
  let fd;
  try {
    fd = openSync(absPath, 'r');
  } catch {
    return null;
  }
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(STREAM_CHUNK_BYTES);
    let bytesRead;
    do {
      bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
    return hash.digest('hex');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

// One path's worktree content: the sha256 of its bytes ('-' when the path is gone), with no
// size cap - a review binding must not depend on how big a legitimately changed file is. A
// symlink is hashed by its target text, not by trying to read through it - the target is the
// reviewable content, the pointed-at file is someone else's.
function readWorktreeContentFact(worktreePath, file) {
  const absPath = path.join(worktreePath, file);
  let stats;
  try {
    stats = lstatSync(absPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, hash: '-' };
    return { ok: false, detail: `slice-state: could not stat the worktree file ${file}` };
  }
  if (stats.isSymbolicLink()) {
    let target;
    try {
      target = readlinkSync(absPath);
    } catch {
      return { ok: false, detail: `slice-state: could not read the symlink ${file}` };
    }
    return { ok: true, hash: createHash('sha256').update(Buffer.from(target, 'utf8')).digest('hex') };
  }
  if (!stats.isFile()) return { ok: false, detail: `slice-state: ${file} is neither a regular file nor a symlink` };
  const hash = sha256OfFile(absPath);
  if (hash === null) return { ok: false, detail: `slice-state: could not read the worktree file ${file}` };
  return { ok: true, hash };
}

// The mode the digest records, and the mode a commit would actually ship: the index mode
// when the path is currently in the index (unconditionally - `update-index --chmod` changes
// this without touching a single content byte, and that change must be visible here even
// though it never appears in the sha256 above), else the mode `git add` would assign to this
// worktree path right now (120000 for a symlink; 100755 only when core.filemode says the
// executable bit means something on this filesystem; else 100644; '-' when nothing is there
// to add).
function shipModeFor(worktreePath, file, indexEntries, filemodeEnabled) {
  const entry = indexEntries.get(file);
  if (entry !== undefined) return { ok: true, mode: entry.mode };
  const absPath = path.join(worktreePath, file);
  let stats;
  try {
    stats = lstatSync(absPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, mode: '-' };
    return { ok: false, detail: `slice-state: could not stat the worktree file ${file}` };
  }
  if (stats.isSymbolicLink()) return { ok: true, mode: '120000' };
  if (!stats.isFile()) return { ok: false, detail: `slice-state: ${file} is neither a regular file nor a symlink` };
  const executable = filemodeEnabled && (stats.mode & 0o111) !== 0;
  return { ok: true, mode: executable ? '100755' : '100644' };
}

// baseOid comes from either raw-diff row's old side (identical value on both, since both
// diffs are against the same merge-base); an all-zero sha (git's convention for "did not
// exist on this side") becomes '-', matching the other fact fields.
function baseOidFor(file, worktreeRowMap, cachedRowMap) {
  const row = worktreeRowMap.get(file) ?? cachedRowMap.get(file);
  if (row === undefined) return '-';
  return isZeroSha(row.oldSha) ? '-' : row.oldSha;
}

// A gitlink (submodule pointer, mode 160000) has no file bytes to hash; its content IS the
// commit sha git already reports on the changed side of the row. C2's gate-skip still
// rejects any gitlink outright (see evaluateGateSkipDiff); slice-state instead records it,
// so a submodule bump binds and reviews like any other change.
function gitlinkFactFor(row) {
  if (row.newMode !== '160000') return { mode: '-', hash: '-' }; // removed
  return { mode: '160000', hash: isZeroSha(row.newSha) ? '-' : row.newSha };
}

// Computes the slice-state v1 digest over path set D and, in the same pass (so it never
// re-reads a path twice), the first untracked path (never `git add`ed - it will not ship)
// and the first tracked path where the index differs from the worktree ("stage or revert
// before close"); C5 folds both conditions into PASS/FAIL, distinctly. The "differs" check
// is `collectIndexWorktreeDiffPaths` membership - git's own diff engine, not a build-your-own
// oid compare, so a symlink is judged the same way git judges it (by target, never followed).
function computeSliceState(worktreePath, baseArg) {
  const inputs = collectSliceStateInputs(worktreePath, baseArg);
  if (!inputs.ok) return inputs;
  const { base, mergeBaseSha, worktreeRows, cachedRows, untrackedFiles, paths, indexEntries, filemodeEnabled, indexWorktreeDiffPaths } = inputs;
  const worktreeRowMap = rowByFile(worktreeRows);
  const cachedRowMap = rowByFile(cachedRows);
  const untrackedFileSet = new Set(untrackedFiles);
  const sortedPaths = [...paths].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  const hash = createHash('sha256');
  let mismatchPath = null;
  let firstUntrackedPath = null;
  for (const file of sortedPaths) {
    const row = worktreeRowMap.get(file) ?? cachedRowMap.get(file);
    const isGitlink = row !== undefined && (row.oldMode === '160000' || row.newMode === '160000');
    let contentFact;
    let modeFact;
    if (isGitlink) {
      const fact = gitlinkFactFor(row);
      contentFact = { ok: true, hash: fact.hash };
      modeFact = { ok: true, mode: fact.mode };
    } else {
      contentFact = readWorktreeContentFact(worktreePath, file);
      if (!contentFact.ok) return { ok: false, detail: contentFact.detail, remedy: 'ensure every changed path is a readable file or a readable symlink' };
      modeFact = shipModeFor(worktreePath, file, indexEntries, filemodeEnabled);
      if (!modeFact.ok) return { ok: false, detail: modeFact.detail, remedy: 'ensure every changed path is a readable file or a readable symlink' };
    }
    const baseOid = baseOidFor(file, worktreeRowMap, cachedRowMap);
    hash.update(framedField(file));
    hash.update(framedField(baseOid));
    hash.update(framedField(modeFact.mode));
    hash.update(framedField(contentFact.hash));
    if (untrackedFileSet.has(file)) {
      if (firstUntrackedPath === null) firstUntrackedPath = file;
    } else if (mismatchPath === null && indexWorktreeDiffPaths.has(file)) {
      mismatchPath = file;
    }
  }
  return { ok: true, base, mergeBaseSha, digest: hash.digest('hex'), mismatchPath, firstUntrackedPath, sortedPaths, untrackedFiles, indexEntries, filemodeEnabled };
}

// Whether either version of a tracked path (the merge-base blob or the current worktree
// file) is too large or binary to dump inline - same cap and same binary test as the
// untracked-hunk stub below, checked before any content is read into memory.
function trackedVersionNeedsStub(worktreePath, mergeBaseSha, file) {
  const baseSpec = `${mergeBaseSha}:${file}`;
  if (gitObjectPresence(worktreePath, baseSpec) === 'present') {
    const size = gitBlobSize(worktreePath, baseSpec);
    if (size === null || size > MAX_TRACKED_BLOB_BYTES) return true;
    const content = runGitReadOnlyBuffer(worktreePath, ['cat-file', 'blob', baseSpec]);
    if (content === null || isBinaryContent(content)) return true;
  }
  const absPath = path.join(worktreePath, file);
  try {
    const stats = lstatSync(absPath);
    if (stats.isFile()) {
      if (stats.size > MAX_TRACKED_BLOB_BYTES) return true;
      if (isBinaryContent(readFileSync(absPath))) return true;
    }
  } catch {
    // absent or unreadable worktree side: nothing here to flag, the real diff call below
    // will surface a genuine read failure on its own.
  }
  return false;
}

// One tracked path's stub, mirroring renderUntrackedHunk's format but for a MODIFY rather
// than a new file: the header's old/new mode and oid come from this path's own raw diff row
// (queried fresh, since renderTrackedPatch is not handed the row maps computeSliceState
// already built). The sha256 is the worktree bytes when the file still exists, else the
// merge-base blob's - always the version C5's digest actually hashed for this path.
function renderTrackedStub(worktreePath, mergeBaseSha, file) {
  const rawOut = runGitReadOnly(worktreePath, ['diff', '--no-renames', ...DIFF_OVERRIDE_ARGS, '--raw', '-z', mergeBaseSha, '--', file]);
  if (rawOut === null) return null;
  const row = parseRawZ(rawOut).find((r) => r.file === file);
  if (row === undefined) return '';
  const header = [`diff --git a/${file} b/${file}`];
  if (row.oldMode !== row.newMode) header.push(`old mode ${row.oldMode}`, `new mode ${row.newMode}`);
  header.push(`index ${row.oldSha}..${row.newSha}`, `--- a/${file}`, `+++ b/${file}`);
  let hash;
  if (isZeroSha(row.newSha)) {
    const content = runGitReadOnlyBuffer(worktreePath, ['cat-file', 'blob', `${mergeBaseSha}:${file}`]);
    if (content === null) return null;
    hash = createHash('sha256').update(content).digest('hex');
  } else {
    hash = sha256OfFile(path.join(worktreePath, file));
    if (hash === null) return null;
  }
  return [...header, `large or binary file omitted, sha256 ${hash}`].join('\n') + '\n';
}

// The canonical patch for --diff-patch: tracked changes rendered one path at a time (pathspec
// set D already excludes .conduct/, so a leg never sees the conductor's own bookkeeping),
// plus one manually rendered "new file" hunk per untracked path - `git diff` never shows an
// untracked file on its own. A path whose merge-base or worktree version is over the size cap
// or binary gets the same stub the untracked case already uses, instead of being dumped
// inline - the whole point of P1.1 is that size no longer blocks binding, not that it makes a
// leg scroll through a multi-MB text diff.
function renderTrackedPatch(worktreePath, mergeBaseSha, trackedFiles) {
  const parts = [];
  for (const file of trackedFiles) {
    if (trackedVersionNeedsStub(worktreePath, mergeBaseSha, file)) {
      const stub = renderTrackedStub(worktreePath, mergeBaseSha, file);
      if (stub === null) return null;
      parts.push(stub);
      continue;
    }
    const diff = runGitReadOnly(worktreePath, ['diff', '--no-renames', ...DIFF_OVERRIDE_ARGS, mergeBaseSha, '--', file]);
    if (diff === null) return null;
    parts.push(diff);
  }
  return parts.join('');
}

// The header's "new file mode" must be the SAME mode the digest recorded for this path
// (shipModeFor) - not a hardcoded 100644, which would silently drop an executable bit or a
// symlink flag from the patch a leg is asked to review. A large or binary file is never
// dumped inline (impractical to review, and the whole point of P1.1 is that size no longer
// blocks binding) - it gets a one-line stub carrying the same sha256 the digest hashed, so a
// leg can still see that a specific version of the file is what's under review.
function renderUntrackedHunk(worktreePath, file, indexEntries, filemodeEnabled) {
  const modeFact = shipModeFor(worktreePath, file, indexEntries, filemodeEnabled);
  if (!modeFact.ok || modeFact.mode === '-') return null;
  const absPath = path.join(worktreePath, file);
  let stats;
  try {
    stats = lstatSync(absPath);
  } catch {
    return null;
  }
  const header = [`diff --git a/${file} b/${file}`, `new file mode ${modeFact.mode}`, `index 0000000..0000000`, '--- /dev/null', `+++ b/${file}`];
  if (stats.isSymbolicLink()) {
    const target = readlinkSync(absPath);
    return [...header, '@@ -0,0 +1 @@', `+${target}`, '\\ No newline at end of file'].join('\n') + '\n';
  }
  if (stats.size > MAX_SLICE_STATE_BLOB_BYTES) {
    const hash = sha256OfFile(absPath);
    if (hash === null) return null;
    return [...header, `large or binary file omitted, sha256 ${hash}`].join('\n') + '\n';
  }
  let content;
  try {
    content = readFileSync(absPath);
  } catch {
    return null;
  }
  if (isBinaryContent(content)) {
    return [...header, `large or binary file omitted, sha256 ${createHash('sha256').update(content).digest('hex')}`].join('\n') + '\n';
  }
  const text = content.toString('utf8');
  const lines = text.length === 0 ? [] : text.split(/\r?\n/);
  const trailingNewline = text.endsWith('\n');
  if (trailingNewline) lines.pop();
  const body = lines.map((line) => `+${line}`);
  if (!trailingNewline && body.length > 0) body.push('\\ No newline at end of file');
  return [...header, `@@ -0,0 +1,${lines.length} @@`, ...body].join('\n') + '\n';
}

function renderDiffPatch(worktreePath, baseArg) {
  const before = computeSliceState(worktreePath, baseArg);
  if (!before.ok) return { ok: false, detail: before.detail, remedy: before.remedy ?? 'ensure the worktree is a readable git repository' };
  const untrackedSet = new Set(before.untrackedFiles);
  const trackedFiles = before.sortedPaths.filter((file) => !untrackedSet.has(file));
  const trackedPatch = renderTrackedPatch(worktreePath, before.mergeBaseSha, trackedFiles);
  if (trackedPatch === null) {
    return { ok: false, detail: `diff-patch: git diff against ${before.base.ref} failed`, remedy: 'ensure the worktree is a readable git repository' };
  }
  const untrackedHunks = [];
  for (const file of before.untrackedFiles) {
    const hunk = renderUntrackedHunk(worktreePath, file, before.indexEntries, before.filemodeEnabled);
    if (hunk === null) {
      return { ok: false, detail: `diff-patch: could not render the untracked file ${file}`, remedy: `ensure ${file} is a readable file or symlink` };
    }
    untrackedHunks.push(hunk);
  }
  const patchBody = trackedPatch + untrackedHunks.join('');
  const after = computeSliceState(worktreePath, baseArg);
  if (!after.ok) return { ok: false, detail: after.detail, remedy: after.remedy ?? 'ensure the worktree is a readable git repository' };
  if (after.digest !== before.digest) {
    return { ok: false, detail: 'diff-patch: state changed while rendering', remedy: 're-run --diff-patch; nothing was written' };
  }
  const header = [`slice-state: ${SLICE_STATE_VERSION}`, `diff-base: ${before.mergeBaseSha}`, `diff-sha256: ${before.digest}`, ''].join('\n');
  return { ok: true, text: header + '\n' + patchBody };
}

// A section heading is a markdown heading, a bold line, or a table header cell; a prose
// line that merely starts with the word ("Consensus was reached") is not a heading.
function isSectionHeading(line, name) {
  if (new RegExp(String.raw`^\s*#{1,6}\s+(?:\*\*)?${name}\b`, 'i').test(line)) return true;
  if (new RegExp(String.raw`^\s*\*\*\s*${name}\b[^*]*\*\*\s*:?\s*$`, 'i').test(line)) return true;
  if (line.trimStart().startsWith('|')) {
    const cellRe = new RegExp(String.raw`^\*{0,2}\s*${name}\s*:?\s*\*{0,2}$`, 'i');
    return line.split('|').some((cell) => cellRe.test(cell.trim()));
  }
  return false;
}

function isAnyHeading(line) {
  return /^\s*#{1,6}\s+\S/.test(line) || /^\s*\*\*[^*]+\*\*\s*:?\s*$/.test(line);
}

function divergenceHasContent(fusionText) {
  const lines = fusionText.split(/\r?\n/);
  let inDivergence = false;
  for (const line of lines) {
    if (!inDivergence) {
      if (isSectionHeading(line, 'Divergence')) inDivergence = true;
      continue;
    }
    if (isAnyHeading(line) || ['Consensus', 'Discarded', 'Decision'].some((name) => isSectionHeading(line, name))) return false;
    if (line.trim() !== '' && !/^\s*[-=|:\s]+$/.test(line)) return true;
  }
  return false;
}

function runChecks(worktreePath, slice, baseArg = null) {
  const conductDir = path.join(worktreePath, '.conduct');
  const names = listConduct(conductDir) ?? [];
  const s = escapeRegExp(slice);
  const results = [];
  const ledgerPath = path.join(conductDir, 'ledger.md');
  let ledgerTooLarge = false;
  try {
    ledgerTooLarge = statSync(ledgerPath).size > MAX_LEDGER_BYTES;
  } catch {
    ledgerTooLarge = false; // a missing ledger is reported as missing, not as too large
  }
  const ledgerText = ledgerTooLarge ? null : readTextIfFile(ledgerPath);
  const ledgerLines = ledgerText === null ? [] : ledgerText.split(/\r?\n/);
  const ledgerRow = ledgerText === null ? null : findLedgerRow(ledgerLines, slice);

  if (ledgerTooLarge) {
    add(results, { id: 'C1 ledger', pass: false, detail: `ledger too large (over ${MAX_LEDGER_BYTES} bytes); refusing to read it`, remedy: 'shrink .conduct/ledger.md; a leg ledger this size is not a ledger' });
  } else if (ledgerText === null) {
    add(results, { id: 'C1 ledger', pass: false, detail: '.conduct/ledger.md missing or unreadable', remedy: 'create .conduct/ledger.md with a table row for this slice' });
  } else if (ledgerRow === null) {
    add(results, { id: 'C1 ledger', pass: false, detail: `no table row whose first cell is "${slice}"`, remedy: `add the | ${slice} | ... row to .conduct/ledger.md` });
  } else {
    add(results, { id: 'C1 ledger', pass: true, detail: `row found for "${slice}"` });
  }

  const gateFileRe = new RegExp(`^gate-${s}\\.`, 'i');
  const gateFiles = names.filter((name) => gateFileRe.test(name));

  const skipFileName = names.find((name) => new RegExp(`^skip-${s}\\.md$`, 'i').test(name)) ?? null;
  const skipText = skipFileName === null ? null : readTextIfFile(path.join(conductDir, skipFileName));
  const skipFileExists = skipFileName !== null;
  const skipRecord = parseSkipRecord(skipText);
  // The ledger-cell opinion fallback is blocked only when a skip file exists AND its
  // record is invalid (a blank file counts as invalid) - a valid record that skips only
  // "gate" or "fusion" must not itself disable the separate ledger-cell mechanism.
  const skipRecordInvalid = skipFileExists && !skipRecord.valid;
  const skipInvalidNote = skipRecordInvalid ? ` (skip file ${skipFileName} is invalid: ${skipRecord.invalidReason})` : '';
  const reviewLegs = findReviewLegs(names, conductDir, s);
  const workerCell = ledgerRow === null ? null : findWorkerCell(ledgerLines, ledgerRow.index);
  const implementerSet = implementerFamilies(workerCell);
  // A git call only when there is at least one leg to judge - with none, C5 fails on
  // absence alone and C2's gate-skip path (if taken) fails on absence the same way.
  const sliceState = reviewLegs.length > 0 ? computeSliceState(worktreePath, baseArg) : null;
  const families = implementerSet === null ? null : [...implementerSet];
  // Computed once, shared by C2's gate-skip path and C5 below - both judge the identical
  // (implementer set, review legs, current hash) triple, so they must reach the identical
  // coverage verdict, never a second implementation that could quietly diverge from it.
  const coverage = sliceState !== null && sliceState.ok && families !== null
    ? familyCoverage(families, reviewLegs, sliceState.digest)
    : null;
  const missingFamily = coverage === null ? null : families.find((family) => coverage.get(family) === null) ?? null;

  if (skipRecord.valid && skipRecord.tokens.has('gate')) {
    if (gateFiles.length > 0) {
      add(results, { id: 'C2 gate  ', pass: false, detail: `choose one: both ${gateFiles[0]} and a gate skip (skipped: gate, in ${skipFileName}) are present`, remedy: `remove the "gate" token from ${skipFileName}, or delete ${gateFiles[0]}` });
    } else if (implementerSet === null) {
      add(results, { id: 'C2 gate  ', pass: false, detail: `gate skip requires an independent review leg, but the ledger worker cell ("${workerCell ?? ''}") does not map to known vendor families`, remedy: 'record recognizable vendor(s) (joined by "," or "+") in the ledger worker cell' });
    } else {
      // The diff's own shape (size, binary, gitlink, base) is checked before independence:
      // a slice that cannot even qualify for a gate skip on its diff alone should say so,
      // not report a coverage gap that a real gate-skip diff would never have reached.
      const diffResult = evaluateGateSkipDiff(worktreePath, baseArg);
      if (!diffResult.ok) {
        add(results, { id: 'C2 gate  ', pass: false, detail: diffResult.detail, remedy: diffResult.remedy });
      } else if (sliceState === null || !sliceState.ok) {
        add(results, {
          id: 'C2 gate  ',
          pass: false,
          detail: sliceState === null ? `gate skip requires a substantive review leg from a vendor family other than the worker's; none found` : sliceState.detail,
          remedy: sliceState === null ? `add a substantive <vendor>-${slice}.md review leg` : sliceState.remedy,
        });
      } else if (missingFamily !== null) {
        add(results, {
          id: 'C2 gate  ',
          pass: false,
          detail: `gate skip requires, for implementer family ${missingFamily}, a current (diff-sha256 ${sliceState.digest}) review leg from a different family: ${reviewLegs.length === 0 ? 'no review legs present' : reviewLegs.map((leg) => legFailureReason(leg, missingFamily, sliceState.digest)).join('; ')}`,
          remedy: `save a <vendor>-${slice}.md leg bound to diff-sha256 ${sliceState.digest} (see --diff-patch) from a vendor family other than ${missingFamily}`,
        });
      } else {
        add(results, { id: 'C2 gate  ', pass: true, detail: `gate skip: base ${diffResult.base.ref}, ${diffResult.lines} changed line(s) in ${diffResult.files} file(s), coverage for ${families.join(', ')} bound to ${sliceState.digest}` });
      }
    }
  } else {
    // A red-evidence file must SAY something: the filename alone proves nothing, so the
    // content has to be non-empty and carry a failure indicator.
    const redNameRe = new RegExp(`^gate-${s}.*red.*\\.(txt|md)$`, 'i');
    const namedRedFiles = names.filter((name) => redNameRe.test(name));
    let redEvidence = null;
    let hollowRedFile = null;
    for (const name of namedRedFiles) {
      const text = readTextIfFile(path.join(conductDir, name));
      if (text !== null && text.trim() !== '' && RED_INDICATOR_RE.test(text)) {
        redEvidence = name;
        break;
      }
      hollowRedFile = name;
    }
    if (redEvidence === null) {
      const runFileRe = new RegExp(`(^gate-${s}.*\\.(md|txt|log)$)|(^.*${s}.*satisfiability.*\\.md$)`, 'i');
      for (const name of names.filter((n) => runFileRe.test(n) && !redNameRe.test(n))) {
        const text = readTextIfFile(path.join(conductDir, name));
        if (text !== null && /\bred\b/i.test(text)) {
          redEvidence = name;
          break;
        }
      }
    }
    if (gateFiles.length === 0) {
      add(results, { id: 'C2 gate  ', pass: false, detail: `no gate-${slice}.* file${skipInvalidNote}`, remedy: `add the executable gate as .conduct/gate-${slice}.<ext>, or state a gate skip in skip-${slice}.md` });
    } else if (redEvidence === null && hollowRedFile !== null) {
      add(results, { id: 'C2 gate  ', pass: false, detail: `red-evidence file ${hollowRedFile} is empty or carries no failure indicator`, remedy: `record the red run output into ${hollowRedFile}` });
    } else if (redEvidence === null) {
      add(results, { id: 'C2 gate  ', pass: false, detail: `gate exists (${gateFiles[0]}) but no red-first evidence`, remedy: 'record the red run output' });
    } else {
      add(results, { id: 'C2 gate  ', pass: true, detail: `${gateFiles[0]}; red evidence in ${redEvidence}` });
    }
  }

  const opinionRe = new RegExp(`^opinion-${s}-(.+)\\.md$`, 'i');
  const vendors = new Set();
  for (const name of names) {
    const match = opinionRe.exec(name);
    if (match === null) continue;
    const text = readTextIfFile(path.join(conductDir, name));
    if (text !== null && text.trim().length >= MIN_LEG_CHARS) vendors.add(match[1].toLowerCase());
  }
  const opinionCell = ledgerRow === null ? null : findOpinionVendorsCell(ledgerLines, ledgerRow.index);
  const ledgerSkip = opinionCell !== null && /skipped/i.test(opinionCell);
  const fileSkipsOpinion = skipRecord.valid && skipRecord.tokens.has('opinion');
  if (vendors.size >= 2) {
    add(results, { id: 'C3 opinions', pass: true, detail: `vendors: ${[...vendors].join(', ')}` });
  } else if (fileSkipsOpinion) {
    add(results, { id: 'C3 opinions', pass: true, detail: `skip declared in ${skipFileName}` });
  } else if (!skipRecordInvalid && ledgerSkip) {
    add(results, { id: 'C3 opinions', pass: true, detail: 'skip declared in the ledger opinion-vendors cell' });
  } else {
    add(results, { id: 'C3 opinions', pass: false, detail: `${vendors.size} substantive opinion vendor(s) found (files under ${MIN_LEG_CHARS} chars do not count), no stated skip${skipInvalidNote}`, remedy: `add a second substantive opinion-${slice}-<vendor>.md, or state the skip (skipped: opinion, reason: ...) in skip-${slice}.md, or the ledger opinion-vendors cell` });
  }

  // A skip covers fusion only when the skip file's parsed record lists the "fusion" token;
  // the ledger cell speaks for opinion vendors only, so it never waives the fusion doc.
  const fusionSkipped = skipRecord.valid && skipRecord.tokens.has('fusion');
  const fusionName = names.find((name) => new RegExp(`^fusion-${s}\\.md$`, 'i').test(name)) ?? null;
  const fusionText = fusionName === null ? null : readTextIfFile(path.join(conductDir, fusionName));
  if (fusionSkipped) {
    add(results, { id: 'C4 fusion', pass: true, detail: `covered by the stated skip in ${skipFileName}` });
  } else if (fusionText === null) {
    add(results, { id: 'C4 fusion', pass: false, detail: `no fusion-${slice}.md${skipInvalidNote}`, remedy: `write .conduct/fusion-${slice}.md with Consensus, Divergence, Discarded and Decision sections` });
  } else {
    const missing = ['Consensus', 'Divergence', 'Discarded', 'Decision'].filter(
      (name) => !fusionText.split(/\r?\n/).some((line) => isSectionHeading(line, name)),
    );
    if (missing.length > 0) {
      add(results, { id: 'C4 fusion', pass: false, detail: `${fusionName} lacks section(s): ${missing.join(', ')}`, remedy: `add the missing section heading(s) to ${fusionName}` });
    } else if (!divergenceHasContent(fusionText)) {
      add(results, { id: 'C4 fusion', pass: false, detail: `${fusionName} has an empty Divergence section`, remedy: 'write the actual divergence (or state "none observed" as content) under the Divergence heading' });
    } else {
      add(results, { id: 'C4 fusion', pass: true, detail: `${fusionName} carries all four sections with Divergence content` });
    }
  }

  if (reviewLegs.length === 0) {
    add(results, { id: 'C5 review', pass: false, detail: `no substantive <vendor>-${slice}*.md review leg of at least ${MIN_LEG_CHARS} chars (vendors: ${VENDOR_PREFIXES.join(', ')})`, remedy: `run at least one independent review leg and save it as .conduct/<vendor>-${slice}.md; no skip is accepted here` });
  } else if (implementerSet === null) {
    add(results, { id: 'C5 review', pass: false, detail: `the ledger worker cell ("${workerCell ?? ''}") does not map to known vendor families`, remedy: 'record recognizable vendor(s) (joined by "," or "+", parenthetical notes ignored) in the ledger worker cell' });
  } else if (!sliceState.ok) {
    add(results, { id: 'C5 review', pass: false, detail: sliceState.detail, remedy: sliceState.remedy });
  } else if (sliceState.firstUntrackedPath !== null) {
    add(results, {
      id: 'C5 review',
      pass: false,
      detail: `${sliceState.firstUntrackedPath} is untracked (never staged) - a commit will not ship it`,
      remedy: `git add it or delete it before close`,
    });
  } else if (sliceState.mismatchPath !== null) {
    add(results, { id: 'C5 review', pass: false, detail: `the index for ${sliceState.mismatchPath} differs from its worktree bytes`, remedy: 'stage or revert before close' });
  } else if (missingFamily !== null) {
    add(results, {
      id: 'C5 review',
      pass: false,
      detail: `no current (diff-sha256 ${sliceState.digest}), independent review leg for implementer family ${missingFamily}: ${reviewLegs.map((leg) => legFailureReason(leg, missingFamily, sliceState.digest)).join('; ')}`,
      remedy: `run --diff-patch, save a bound <vendor>-${slice}.md (full or a delta-from chain) from a vendor family other than ${missingFamily}`,
    });
  } else {
    const namedLegs = families.map((family) => coverage.get(family).name).join(', ');
    add(results, { id: 'C5 review', pass: true, detail: `current (diff-sha256 ${sliceState.digest}) coverage for ${families.join(', ')} via ${namedLegs}` });
  }
  return results;
}

function printResults(results) {
  let failures = 0;
  for (const result of results) {
    console.log(`${result.id}  ${result.pass ? 'PASS' : 'FAIL'}  ${result.detail}`);
    if (!result.pass) {
      failures += 1;
      console.log(`  remedy: ${result.remedy}`);
    }
  }
  console.log(`preflight-close: ${results.length - failures} of ${results.length} checks pass.`);
  return failures === 0 ? EXIT_ALL_PASS : EXIT_CHECK_FAILED;
}

// ---- Self-test fixtures. Each builds a throwaway worktree under os.tmpdir, runs the
// checks in-process, and asserts both the exit class and WHICH checks failed, so a
// check failing for the wrong reason is caught, not just any red.
function writeFixture(dir, files) {
  mkdirSync(path.join(dir, '.conduct'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, '.conduct', name), content);
  }
}

const SUBSTANTIVE = 'this text is long enough to clear the fifty-character content floor for a leg file.\n';

function passingFilesFor(slice) {
  return {
    'ledger.md': [
      '| slice | worker | reviewer(s) | opinion vendors | date |',
      '|---|---|---|---|---|',
      `| ${slice} | fable | luna | grok, sol | 2026-08-26 |`,
    ].join('\n'),
    [`gate-${slice}.mjs`]: 'process.exit(0);\n',
    [`gate-${slice}-red.txt`]: 'FAIL: 0 of 3 assertions pass (red-first run)\n',
    [`opinion-${slice}-grok.md`]: `grok opinion: ${SUBSTANTIVE}`,
    [`opinion-${slice}-sol.md`]: `sol opinion: ${SUBSTANTIVE}`,
    [`fusion-${slice}.md`]: [
      '## Consensus',
      'both vendors agree on the shape',
      '## Divergence',
      'grok wants a cap, sol does not',
      '## Discarded',
      'the cap-free variant',
      '## Decision',
      'ship with the cap',
    ].join('\n'),
    [`luna-${slice}.md`]: `review verdict: APPROVE. ${SUBSTANTIVE}`,
  };
}

const PASSING_FILES = passingFilesFor('demo');

const DECOY_LEDGER = [
  '| notes | opinion summary |',
  '|---|---|',
  '| meta | skipped in the wrong table |',
  '',
  '| slice | worker | reviewer(s) | opinion vendors | date |',
  '|---|---|---|---|---|',
  '| demo | fable | luna | grok only | 2026-08-26 |',
].join('\n');

function fixtureVariant(overrides, removals = []) {
  const files = { ...PASSING_FILES, ...overrides };
  for (const name of removals) delete files[name];
  return files;
}

// ---- Gate-skip (C2 skip path) fixtures. These are git-backed: git init inside the temp
// root, commit .conduct/ as the base, then let the case add its own tracked or untracked
// changes on top.
function gitQuiet(dir, ...args) {
  execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args], { cwd: dir, stdio: 'ignore', timeout: 15_000 });
}

// A C1/C3/C4-focused fixture needs no slice change of its own (path set D is empty either
// way), but it still needs to be a real repo: C5 binds to a git-computed hash, so a fixture
// with no git history at all fails C5 closed, the same way a careless close would.
function gitBackedFixture(files) {
  return (dir) => {
    mkdirSync(dir, { recursive: true });
    gitQuiet(dir, 'init', '-b', 'main');
    gitQuiet(dir, 'config', 'user.name', 'Selftest Fixture');
    gitQuiet(dir, 'config', 'user.email', 'selftest@example.invalid');
    writeFixture(dir, files);
    gitQuiet(dir, 'add', '.');
    gitQuiet(dir, 'commit', '-m', 'base');
  };
}

// Runs after every fixture is built (git-backed or not): computes the real slice-state
// digest and prefixes any substantive, not-already-bound <vendor>-<slice>*.md file with a
// genuine `diff-sha256: <hash>\nreview-scope: full` binding. A fixture whose point IS an
// unbound or absent leg is untouched (nothing to bind, or a file already carrying its own
// `diff-sha256:` line); a fixture with no git repository at all is untouched too - a case
// that deliberately stays non-git is testing exactly that failure, honestly.
function autoBindLegs(dir, slice, baseArg) {
  const state = computeSliceState(dir, baseArg);
  if (!state.ok) return;
  const conductDir = path.join(dir, '.conduct');
  let names;
  try {
    names = readdirSync(conductDir);
  } catch {
    return;
  }
  const legRe = new RegExp(`^(${VENDOR_PREFIXES.join('|')})-${escapeRegExp(slice)}([._-].*)?\\.md$`, 'i');
  for (const name of names) {
    if (!legRe.test(name)) continue;
    const filePath = path.join(conductDir, name);
    const original = readTextIfFile(filePath);
    if (original === null || original.trim().length < MIN_LEG_CHARS) continue;
    if (/^\s*diff-sha256\s*:/im.test(original)) continue;
    writeFileSync(filePath, `diff-sha256: ${state.digest}\nreview-scope: full\n\n${original}`);
  }
}

const SELF_TEST_CASES = [
  { name: 'full pass', build: gitBackedFixture(PASSING_FILES), expectExit: EXIT_ALL_PASS, expectFailed: [] },
  {
    name: 'missing ledger row',
    // No row for "demo" means no worker cell either, so C5 (which reads the same ledger row
    // for implementer families) fails closed alongside C1, not in spite of it.
    build: gitBackedFixture(fixtureVariant({ 'ledger.md': '| slice | worker | reviewer(s) | opinion vendors | date |\n|---|---|---|---|---|\n| other | x | y | z | d |' })),
    expectExit: EXIT_CHECK_FAILED,
    expectFailed: ['C1', 'C5'],
  },
  {
    name: 'gate without red evidence',
    build: gitBackedFixture(fixtureVariant({}, ['gate-demo-red.txt'])),
    expectExit: EXIT_CHECK_FAILED,
    expectFailed: ['C2'],
  },
  {
    name: 'one-vendor opinions without skip',
    build: gitBackedFixture(fixtureVariant({}, ['opinion-demo-sol.md'])),
    expectExit: EXIT_CHECK_FAILED,
    expectFailed: ['C3'],
  },
  {
    name: 'skip declared in ledger cell',
    build: gitBackedFixture(fixtureVariant(
      { 'ledger.md': '| slice | worker | reviewer(s) | opinion vendors | date |\n|---|---|---|---|---|\n| demo | fable | luna | skipped (slice IS the gates) | 2026-08-26 |' },
      ['opinion-demo-grok.md', 'opinion-demo-sol.md'],
    )),
    expectExit: EXIT_ALL_PASS,
    expectFailed: [],
  },
  {
    name: 'fusion missing Divergence content',
    build: gitBackedFixture(fixtureVariant({
      'fusion-demo.md': '## Consensus\nagreement\n## Divergence\n## Discarded\nnothing\n## Decision\nship\n',
    })),
    expectExit: EXIT_CHECK_FAILED,
    expectFailed: ['C4'],
  },
  {
    name: 'no review leg',
    files: fixtureVariant({}, ['luna-demo.md']),
    expectExit: EXIT_CHECK_FAILED,
    expectFailed: ['C5'],
  },
  {
    name: 'empty red-evidence file',
    build: gitBackedFixture(fixtureVariant({ 'gate-demo-red.txt': '   \n' })),
    expectExit: EXIT_CHECK_FAILED,
    expectFailed: ['C2'],
  },
  {
    name: 'two empty opinion files',
    build: gitBackedFixture(fixtureVariant({ 'opinion-demo-grok.md': '', 'opinion-demo-sol.md': '  \n' })),
    expectExit: EXIT_CHECK_FAILED,
    expectFailed: ['C3'],
  },
  {
    name: 'empty review file',
    files: fixtureVariant({ 'luna-demo.md': '\n' }),
    expectExit: EXIT_CHECK_FAILED,
    expectFailed: ['C5'],
  },
  {
    name: 'decoy opinion table above the real ledger',
    build: gitBackedFixture(fixtureVariant({ 'ledger.md': DECOY_LEDGER }, ['opinion-demo-grok.md', 'opinion-demo-sol.md'])),
    expectExit: EXIT_CHECK_FAILED,
    expectFailed: ['C3'],
  },
  {
    name: 'fusion with prose lines, not headings',
    build: gitBackedFixture(fixtureVariant({
      'fusion-demo.md': [
        'Consensus was reached quickly on the shape',
        'Divergence remained on caps',
        'some divergence detail here',
        'Discarded the alternative outright',
        'Decision is to ship',
      ].join('\n'),
    })),
    expectExit: EXIT_CHECK_FAILED,
    expectFailed: ['C4'],
  },
  {
    name: 'slice name with a regex metachar',
    slice: 'a+b',
    build: gitBackedFixture(passingFilesFor('a+b')),
    expectExit: EXIT_ALL_PASS,
    expectFailed: [],
  },
];

function writeRepoFile(dir, relPath, content) {
  const target = path.join(dir, relPath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

// Writes a file AND stages it - most fixtures below want a real slice change that ships,
// not a demonstration of the untracked-path check (that has its own dedicated fixtures).
function writeAndStageFile(dir, relPath, content) {
  writeRepoFile(dir, relPath, content);
  gitQuiet(dir, 'add', '--', relPath);
}

function makeChangedLines(count) {
  return Array.from({ length: count }, (_, i) => `changed line ${i + 1}`).join('\n') + '\n';
}

const GATE_SKIP_RECORD = 'skipped: gate\nreason: This diff is small, mechanical, and independently reviewed by a different vendor family.\n';

function gateSkipFiles({ keepGateFile = false } = {}) {
  const removals = ['gate-demo-red.txt'];
  if (!keepGateFile) removals.push('gate-demo.mjs');
  return fixtureVariant({ 'skip-demo.md': GATE_SKIP_RECORD }, removals);
}

function gitFixtureFor(conductFiles, configure = () => {}, beforeCommit = () => {}) {
  return (dir) => {
    mkdirSync(dir, { recursive: true });
    gitQuiet(dir, 'init', '-b', 'main');
    gitQuiet(dir, 'config', 'user.name', 'Selftest Fixture');
    gitQuiet(dir, 'config', 'user.email', 'selftest@example.invalid');
    writeFixture(dir, conductFiles);
    writeRepoFile(dir, 'seed.txt', 'base\n');
    beforeCommit(dir);
    gitQuiet(dir, 'add', '.');
    gitQuiet(dir, 'commit', '-m', 'base');
    configure(dir);
  };
}

SELF_TEST_CASES.push(
  {
    name: 'gate skip passes with a small independent diff',
    build: gitFixtureFor(gateSkipFiles(), (dir) => writeAndStageFile(dir, 'change.txt', makeChangedLines(5))),
    expectExit: EXIT_ALL_PASS,
    expectFailed: [],
  },
  {
    name: 'gate skip fails when the diff exceeds the line cap',
    build: gitFixtureFor(gateSkipFiles(), (dir) => writeAndStageFile(dir, 'change.txt', makeChangedLines(31))),
    expectExit: EXIT_CHECK_FAILED,
    expectFailed: ['C2'],
  },
  {
    name: 'gate file and gate skip together fail with choose one',
    build: gitFixtureFor(gateSkipFiles({ keepGateFile: true }), (dir) => writeAndStageFile(dir, 'change.txt', makeChangedLines(5))),
    expectExit: EXIT_CHECK_FAILED,
    expectFailed: ['C2'],
  },
  {
    name: 'gate skip fails when the review leg shares the worker vendor family',
    build: gitFixtureFor(
      fixtureVariant(
        { 'skip-demo.md': GATE_SKIP_RECORD, 'opus-demo.md': SUBSTANTIVE },
        ['gate-demo.mjs', 'gate-demo-red.txt', 'luna-demo.md'],
      ),
      (dir) => writeRepoFile(dir, 'change.txt', makeChangedLines(5)),
    ),
    expectExit: EXIT_CHECK_FAILED,
    // opus shares the worker's (fable's) anthropic family: C5's coverage check fails on
    // the exact same fact C2's does, not a separate defect.
    expectFailed: ['C2', 'C5'],
  },
  {
    name: 'gate skip fails closed when the worktree is not a git repository',
    // Deliberately not git-backed (and not auto-bound): with no repository at all, neither
    // C2's coverage nor C5's hash can be computed, so both fail closed.
    files: gateSkipFiles(),
    noAutoBind: true,
    expectExit: EXIT_CHECK_FAILED,
    expectFailed: ['C2', 'C5'],
  },
  {
    name: 'unknown skip token invalidates the record for C2, C3 and C4',
    build: gitBackedFixture(fixtureVariant(
      { 'skip-demo.md': 'skipped: gate, fusion, vendorx\nreason: This diff is small, mechanical, and independently reviewed by a different vendor family.\n' },
      ['gate-demo.mjs', 'gate-demo-red.txt', 'opinion-demo-sol.md', 'fusion-demo.md'],
    )),
    expectExit: EXIT_CHECK_FAILED,
    expectFailed: ['C2', 'C3', 'C4'],
  },
  {
    name: 'red as a substring of another word does not satisfy the fallback',
    build: gitBackedFixture(fixtureVariant({ 'gate-demo-notes.md': 'required checks were reported\n' }, ['gate-demo-red.txt'])),
    expectExit: EXIT_CHECK_FAILED,
    expectFailed: ['C2'],
  },
  {
    name: 'red as a whole word satisfies the fallback',
    build: gitBackedFixture(fixtureVariant({ 'gate-demo-notes.md': 'red run\n' }, ['gate-demo-red.txt'])),
    expectExit: EXIT_ALL_PASS,
    expectFailed: [],
  },
);

function ledgerWithWorker(worker) {
  return ['| slice | worker | reviewer(s) | opinion vendors | date |', '|---|---|---|---|---|', `| demo | ${worker} | luna | grok, sol | 2026-08-26 |`].join('\n');
}

SELF_TEST_CASES.push(
  {
    // A gitignored file is never committed or merged, so it is not part of what the
    // slice ships and must not count; the .gitignore edit itself is a real slice change
    // and does count. No .gitignore in the base commit: it arrives as part of the diff,
    // same as any other edit.
    name: 'ignored files do not count, the .gitignore change does',
    build: gitFixtureFor(gateSkipFiles(), (dir) => {
      writeAndStageFile(dir, '.gitignore', 'dist/\n');
      writeRepoFile(dir, path.join('dist', 'large.js'), makeChangedLines(1000));
      writeAndStageFile(dir, 'tiny.js', makeChangedLines(1));
    }),
    expectExit: EXIT_ALL_PASS,
    expectFailed: [],
  },
  {
    name: 'vendor family comes from the model, not the whole worker cell',
    build: gitFixtureFor(
      fixtureVariant(
        {
          'ledger.md': ledgerWithWorker('deepseek-v4-flash@grok-cli'),
          'skip-demo.md': GATE_SKIP_RECORD,
          'deepseek-demo.md': SUBSTANTIVE,
        },
        ['gate-demo.mjs', 'gate-demo-red.txt', 'luna-demo.md'],
      ),
      (dir) => writeRepoFile(dir, 'change.txt', makeChangedLines(5)),
    ),
    expectExit: EXIT_CHECK_FAILED,
    // The deepseek leg IS the deepseek implementer family: C5's coverage fails for the
    // same reason C2's independence check does.
    expectFailed: ['C2', 'C5'],
  },
  {
    name: 'an untracked file with a NUL past the probe window is still binary',
    build: gitFixtureFor(gateSkipFiles(), (dir) => writeRepoFile(dir, 'change.bin', Buffer.concat([Buffer.alloc(8000, 'A'), Buffer.from([0])]))),
    expectExit: EXIT_CHECK_FAILED,
    // The file is also never staged: C5 fails on that alone, independent of the binary check.
    expectFailed: ['C2', 'C5'],
  },
  {
    name: 'a duplicate skipped line invalidates the record',
    build: gitFixtureFor(
      fixtureVariant(
        { 'skip-demo.md': 'skipped: gate\nskipped: unauthorized\nreason: This diff is small, mechanical, and independently reviewed by a different vendor family.\n' },
        ['gate-demo.mjs', 'gate-demo-red.txt'],
      ),
      (dir) => writeRepoFile(dir, 'change.txt', makeChangedLines(5)),
    ),
    expectExit: EXIT_CHECK_FAILED,
    // change.txt is also never staged: C5 fails on that alone, independent of the invalid skip.
    expectFailed: ['C2', 'C5'],
  },
  {
    name: 'a blank skip file still blocks the ledger-cell fallback',
    build: gitBackedFixture(fixtureVariant(
      {
        'ledger.md': '| slice | worker | reviewer(s) | opinion vendors | date |\n|---|---|---|---|---|\n| demo | fable | luna | skipped | 2026-08-26 |',
        'skip-demo.md': '',
      },
      ['opinion-demo-grok.md', 'opinion-demo-sol.md'],
    )),
    expectExit: EXIT_CHECK_FAILED,
    expectFailed: ['C3'],
  },
  {
    name: 'the independence scan checks every review leg, not just the first',
    build: gitFixtureFor(
      fixtureVariant(
        {
          'ledger.md': ledgerWithWorker('gpt-6-sol@codex'),
          'skip-demo.md': GATE_SKIP_RECORD,
          'opus-demo.md': SUBSTANTIVE,
        },
        ['gate-demo.mjs', 'gate-demo-red.txt'],
      ),
      (dir) => writeAndStageFile(dir, 'change.txt', makeChangedLines(5)),
    ),
    expectExit: EXIT_ALL_PASS,
    expectFailed: [],
  },
  {
    // Stays untracked on purpose: the point is gate-skip's OWN untracked-listing/counting
    // path for a filename most parsers mishandle - C5's separate untracked-path rule fires
    // too, honestly, but is not what this fixture is testing.
    name: 'an untracked filename with a leading space is counted, not corrupted',
    build: gitFixtureFor(gateSkipFiles(), (dir) => writeRepoFile(dir, ' leading.txt', makeChangedLines(1))),
    expectExit: EXIT_CHECK_FAILED,
    expectFailed: ['C5'],
  },
  {
    // The ledger-cell fallback must be blocked only by an INVALID skip file, not by any
    // skip file's mere presence: a slice can legitimately skip the gate while still
    // relying on the ledger cell for the opinion skip.
    name: 'a valid gate-only skip record does not block the ledger-cell opinion fallback',
    build: gitFixtureFor(
      fixtureVariant(
        {
          'ledger.md': '| slice | worker | reviewer(s) | opinion vendors | date |\n|---|---|---|---|---|\n| demo | fable | luna | skipped | 2026-08-26 |',
          'skip-demo.md': GATE_SKIP_RECORD,
        },
        ['gate-demo.mjs', 'gate-demo-red.txt', 'opinion-demo-grok.md', 'opinion-demo-sol.md'],
      ),
      (dir) => writeAndStageFile(dir, 'change.txt', makeChangedLines(5)),
    ),
    expectExit: EXIT_ALL_PASS,
    expectFailed: [],
  },
  {
    // An added empty tracked file has numstat "0 added, 0 deleted" - indistinguishable
    // from "unchanged" by line counts alone. Addition/deletion must come from the --raw
    // status letter, not from added>0/deleted>0.
    name: 'an added empty tracked file does not confuse the deep binary check',
    build: gitFixtureFor(gateSkipFiles(), (dir) => {
      writeAndStageFile(dir, '.gitkeep', '');
      writeAndStageFile(dir, 'change.txt', makeChangedLines(1));
    }),
    expectExit: EXIT_ALL_PASS,
    expectFailed: [],
  },
  {
    name: 'a deleted empty tracked file does not confuse the deep binary check',
    build: gitFixtureFor(
      gateSkipFiles(),
      (dir) => {
        gitQuiet(dir, 'rm', 'empty.txt');
        writeAndStageFile(dir, 'tiny.txt', makeChangedLines(1));
      },
      (dir) => writeRepoFile(dir, 'empty.txt', ''),
    ),
    expectExit: EXIT_ALL_PASS,
    expectFailed: [],
  },
  {
    // Stage a big change to a tracked file, then restore ONLY the working-tree copy to
    // HEAD. The working tree now looks unchanged; the index (what a commit would ship)
    // still carries the big change. A worktree-only diff sees nothing for this file.
    name: 'a staged change survives a working-tree revert and still counts',
    build: gitFixtureFor(gateSkipFiles(), (dir) => {
      writeRepoFile(dir, 'tracked.txt', 'original line\n');
      gitQuiet(dir, 'add', 'tracked.txt');
      gitQuiet(dir, 'commit', '-m', 'add tracked file');
      writeRepoFile(dir, 'tracked.txt', makeChangedLines(1000));
      gitQuiet(dir, 'add', 'tracked.txt');
      gitQuiet(dir, 'restore', '--source=HEAD', '--worktree', '--', 'tracked.txt');
      writeRepoFile(dir, 'tiny.txt', makeChangedLines(1));
    }),
    expectExit: EXIT_CHECK_FAILED,
    // The same staged/worktree divergence is exactly C5's "stage or revert" condition.
    expectFailed: ['C2', 'C5'],
  },
  {
    // A newly staged file whose only NUL byte sits past git's own ~8000-byte numstat
    // binary probe is reported as ordinary text by git itself; the deep per-path check
    // must catch what numstat missed.
    name: 'a tracked binary file past the numstat probe window is still binary',
    build: gitFixtureFor(gateSkipFiles(), (dir) => {
      writeRepoFile(dir, 'payload.txt', Buffer.concat([Buffer.alloc(8000, 'A'), Buffer.from([0])]));
      gitQuiet(dir, 'add', 'payload.txt');
    }),
    expectExit: EXIT_CHECK_FAILED,
    expectFailed: ['C2'],
  },
  {
    name: 'an empty skip token (a trailing comma) invalidates the record',
    build: gitFixtureFor(
      fixtureVariant(
        { 'skip-demo.md': 'skipped: gate,\nreason: This diff is small, mechanical, and independently reviewed by a different vendor family.\n' },
        ['gate-demo.mjs', 'gate-demo-red.txt'],
      ),
      (dir) => writeRepoFile(dir, 'change.txt', makeChangedLines(5)),
    ),
    expectExit: EXIT_CHECK_FAILED,
    // change.txt is also never staged: C5 fails on that alone, independent of the invalid skip.
    expectFailed: ['C2', 'C5'],
  },
  {
    // Stage a >1 MiB blob (a NUL past the numstat probe window, so git's own numstat
    // still calls it text), then overwrite the WORKING COPY with small text without
    // re-staging. Reading the index blob without a size check first risks an
    // execFileSync maxBuffer failure, which a catch-all would misread as "absent".
    name: 'an oversized staged blob fails on size, never on a swallowed read error',
    build: gitFixtureFor(gateSkipFiles(), (dir) => {
      const bigBinary = Buffer.concat([Buffer.alloc(8000, 'A'), Buffer.from([0]), Buffer.alloc(2 * 1024 * 1024, 'B')]);
      writeRepoFile(dir, 'payload.dat', bigBinary);
      gitQuiet(dir, 'add', 'payload.dat');
      writeRepoFile(dir, 'payload.dat', 'small text\n');
    }),
    expectExit: EXIT_CHECK_FAILED,
    // The oversized index blob is also unverifiable for C5's stage/worktree comparison,
    // which conservatively counts an unreadable-size index blob as a mismatch.
    expectFailed: ['C2', 'C5'],
  },
  {
    // Commit a binary blob (part of the merge-base), then stage its deletion (`git rm`
    // removes it from both the index and the working tree). Nothing left to read on
    // either of those two sides - only the merge-base blob still proves this was ever
    // binary, so the deep check must fetch that version too, not just index/worktree.
    name: 'a staged deletion of a committed binary blob is still binary',
    build: gitFixtureFor(
      gateSkipFiles(),
      (dir) => gitQuiet(dir, 'rm', 'payload.bin'),
      (dir) => writeRepoFile(dir, 'payload.bin', Buffer.concat([Buffer.alloc(8000, 'A'), Buffer.from([0])])),
    ),
    expectExit: EXIT_CHECK_FAILED,
    expectFailed: ['C2'],
  },
  {
    // `update-index --cacheinfo 160000,...` stages a gitlink without needing a real
    // submodule checkout. `diff.ignoreSubmodules all` is a repo config an operator (or an
    // attacker) can set to make `git diff`/numstat hide submodule changes entirely.
    name: 'a repo config that hides gitlink changes does not hide them here',
    build: gitFixtureFor(gateSkipFiles(), (dir) => {
      gitQuiet(dir, 'config', 'diff.ignoreSubmodules', 'all');
      const fakeGitlinkSha = '1'.repeat(40);
      for (const sub of ['sub-a', 'sub-b', 'sub-c']) {
        gitQuiet(dir, 'update-index', '--add', '--cacheinfo', `160000,${fakeGitlinkSha},${sub}`);
      }
      writeRepoFile(dir, 'tiny.txt', makeChangedLines(1));
    }),
    expectExit: EXIT_CHECK_FAILED,
    // The hidden gitlink also blocks slice-state (C5 fails closed the same way).
    expectFailed: ['C2', 'C5'],
  },
  {
    name: 'a valid opinion skip passes C3 without two opinion vendors',
    build: gitBackedFixture(fixtureVariant(
      { 'skip-demo.md': 'skipped: opinion\nreason: This diff is small, mechanical, and independently reviewed by a different vendor family.\n' },
      ['opinion-demo-grok.md', 'opinion-demo-sol.md'],
    )),
    expectExit: EXIT_ALL_PASS,
    expectFailed: [],
  },
  {
    name: 'a valid fusion skip passes C4 without a fusion doc',
    build: gitBackedFixture(fixtureVariant(
      { 'skip-demo.md': 'skipped: fusion\nreason: This diff is small, mechanical, and independently reviewed by a different vendor family.\n' },
      ['fusion-demo.md'],
    )),
    expectExit: EXIT_ALL_PASS,
    expectFailed: [],
  },
  {
    name: 'a reason under 40 characters invalidates the record',
    build: gitBackedFixture(fixtureVariant(
      { 'skip-demo.md': 'skipped: opinion\nreason: too short\n' },
      ['opinion-demo-grok.md', 'opinion-demo-sol.md'],
    )),
    expectExit: EXIT_CHECK_FAILED,
    expectFailed: ['C3'],
  },
  {
    name: 'an unmappable worker cell fails the gate skip',
    build: gitFixtureFor(
      fixtureVariant({ 'ledger.md': ledgerWithWorker('someone'), 'skip-demo.md': GATE_SKIP_RECORD }, ['gate-demo.mjs', 'gate-demo-red.txt']),
      (dir) => writeRepoFile(dir, 'change.txt', makeChangedLines(5)),
    ),
    expectExit: EXIT_CHECK_FAILED,
    // implementerFamilies(workerCell) is the same null for C2 and C5 alike.
    expectFailed: ['C2', 'C5'],
  },
  {
    // Exercises the --base plumbing: a large change lands on a commit AFTER the branch
    // point, so the default auto-probed base (main) would see it; --base HEAD does not.
    name: '--base overrides the auto-probed base',
    build: gitFixtureFor(gateSkipFiles(), (dir) => {
      gitQuiet(dir, 'checkout', '-b', 'work');
      writeRepoFile(dir, 'change.txt', makeChangedLines(31));
      gitQuiet(dir, 'add', 'change.txt');
      gitQuiet(dir, 'commit', '-m', 'large slice change');
      writeAndStageFile(dir, 'small.txt', makeChangedLines(7));
    }),
    baseArg: 'HEAD',
    expectExit: EXIT_ALL_PASS,
    expectFailed: [],
  },
  {
    name: 'a red-evidence file containing "redacted" is not treated as red evidence',
    build: gitBackedFixture(fixtureVariant({ 'gate-demo-red.txt': 'redacted output; no problems\n' })),
    expectExit: EXIT_CHECK_FAILED,
    expectFailed: ['C2'],
  },
  {
    name: 'an untracked file over the size cap fails before it is read in full',
    build: gitFixtureFor(gateSkipFiles(), (dir) => writeRepoFile(dir, 'huge.txt', makeChangedLines(100_000))),
    expectExit: EXIT_CHECK_FAILED,
    // Over both caps: gate-skip's own (numstat-driven) limit and slice-state's read cap.
    expectFailed: ['C2', 'C5'],
    detailIncludes: `${MAX_TRACKED_BLOB_BYTES}-byte gate-skip cap`,
  },
);

// ---- reviewbind fixtures: implementer-family parsing, VENDOR_PREFIXES additions, leg
// binding shapes, and the multi-family coverage rule (spec: fusion-reviewbind.md).
SELF_TEST_CASES.push(
  {
    name: 'a gpt vendor prefix is recognized as a review leg',
    build: gitBackedFixture(fixtureVariant({ 'gpt-demo.md': `gpt opinion: ${SUBSTANTIVE}` }, ['luna-demo.md'])),
    expectExit: EXIT_ALL_PASS,
    expectFailed: [],
  },
  {
    name: 'a worker cell joined by "+" lists every implementer family',
    build: gitBackedFixture(fixtureVariant({ 'ledger.md': ledgerWithWorker('fable+grok-4.7@grok-cli') })),
    expectExit: EXIT_ALL_PASS,
    expectFailed: [],
  },
  {
    name: 'a review-scope value other than full leaves a leg unbound',
    build: (dir) => {
      gitBackedFixture(PASSING_FILES)(dir);
      const state = computeSliceState(dir, null);
      writeFileSync(path.join(dir, '.conduct', 'luna-demo.md'), `diff-sha256: ${state.digest}\nreview-scope: partial\n\n${SUBSTANTIVE}`);
    },
    noAutoBind: true,
    expectExit: EXIT_CHECK_FAILED,
    expectFailed: ['C5'],
  },
  {
    name: 'a two-link delta chain resolves to its full ancestor',
    build: (dir) => {
      gitBackedFixture(fixtureVariant({}, ['luna-demo.md']))(dir);
      const h0 = computeSliceState(dir, null).digest;
      writeFileSync(path.join(dir, '.conduct', 'luna-demo.md'), `diff-sha256: ${h0}\nreview-scope: full\n\n${SUBSTANTIVE}`);
      writeAndStageFile(dir, 'change-a.txt', makeChangedLines(1));
      const h1 = computeSliceState(dir, null).digest;
      writeFileSync(path.join(dir, '.conduct', 'luna-demo-mid.md'), `diff-sha256: ${h1}\ndelta-from: ${h0}\n\n${SUBSTANTIVE}`);
      writeAndStageFile(dir, 'change-b.txt', makeChangedLines(1));
      const h2 = computeSliceState(dir, null).digest;
      writeFileSync(path.join(dir, '.conduct', 'luna-demo-head.md'), `diff-sha256: ${h2}\ndelta-from: ${h1}\n\n${SUBSTANTIVE}`);
    },
    noAutoBind: true,
    expectExit: EXIT_ALL_PASS,
    expectFailed: [],
  },
);

// `selfTest()` reads `testCase.baseArg` only after `build(dir)` returns, so a build that
// needs a base PINNED to the state before its own commits (else this single-branch repo's
// "main" candidate moves forward with HEAD and swallows the diff) sets it on the case object
// itself, via closure, once the pin point is known.
function reviewbindUntrackedBaseOidSurvivesStagingCase() {
  const testCase = {
    // `git diff --raw` abbreviates its sha1 columns by default, --full-index included (an
    // added file's old side prints as "0000000", not 40 zeros) - without --no-abbrev,
    // baseOid flips from '-' to the literal abbreviated string the moment an untracked file
    // is staged, breaking a binding that never touched a byte.
    name: 'a binding on an untracked file survives staging and then a commit',
    noAutoBind: true,
    expectExit: EXIT_ALL_PASS,
    expectFailed: [],
  };
  testCase.build = (dir) => {
    gitBackedFixture(fixtureVariant({}, ['luna-demo.md']))(dir);
    const pinnedBase = runGitReadOnly(dir, ['rev-parse', 'HEAD']).trim();
    testCase.baseArg = pinnedBase;
    writeRepoFile(dir, 'new.txt', 'hello\n');
    const h0 = computeSliceState(dir, pinnedBase).digest;
    writeFileSync(path.join(dir, '.conduct', 'luna-demo.md'), `diff-sha256: ${h0}\nreview-scope: full\n\n${SUBSTANTIVE}`);
    gitQuiet(dir, 'add', 'new.txt');
    const h1 = computeSliceState(dir, pinnedBase).digest;
    if (h1 !== h0) throw new Error(`baseOid binding broke on staging: ${h0} -> ${h1}`);
    gitQuiet(dir, 'commit', '-m', 'add new.txt');
    const h2 = computeSliceState(dir, pinnedBase).digest;
    if (h2 !== h0) throw new Error(`baseOid binding broke on commit: ${h0} -> ${h2}`);
  };
  return testCase;
}

// ---- Slice-state binding fixtures: autocrlf line-ending conversion, an index mode change
// the digest must still see, an untracked-file binding surviving staging and a commit, and
// review-scope lines that must all be counted, not just the ones matching a value regex.
SELF_TEST_CASES.push(
  {
    // core.autocrlf=true (this repo's own default): `git add` stores LF in the index while
    // the worktree keeps CRLF. Comparing raw worktree bytes to the index blob would call
    // this a mismatch even though the file is correctly staged; the digest must compare via
    // git's own clean-filtered oid instead.
    name: 'a correctly staged CRLF file under core.autocrlf is not a stage-or-revert mismatch',
    build: (dir) => {
      gitBackedFixture(fixtureVariant({}, ['luna-demo.md']))(dir);
      gitQuiet(dir, 'config', 'core.autocrlf', 'true');
      writeFileSync(path.join(dir, 'crlf.txt'), 'line one\r\nline two\r\n');
      gitQuiet(dir, 'add', 'crlf.txt');
      const state = computeSliceState(dir, null);
      writeFileSync(path.join(dir, '.conduct', 'luna-demo.md'), `diff-sha256: ${state.digest}\nreview-scope: full\n\n${SUBSTANTIVE}`);
    },
    noAutoBind: true,
    expectExit: EXIT_ALL_PASS,
    expectFailed: [],
  },
  {
    // `update-index --chmod=+x` changes what a commit ships (the index mode) without
    // touching a single content byte or the worktree file's own permission bits. A digest
    // keyed on worktree lstat mode cannot see this; keyed on the index mode, it must.
    name: 'an index mode change after binding makes the leg stale',
    build: (dir) => {
      gitBackedFixture(fixtureVariant({}, ['luna-demo.md']))(dir);
      writeRepoFile(dir, 'script.sh', 'echo hi\n');
      gitQuiet(dir, 'add', 'script.sh');
      const state = computeSliceState(dir, null);
      writeFileSync(path.join(dir, '.conduct', 'luna-demo.md'), `diff-sha256: ${state.digest}\nreview-scope: full\n\n${SUBSTANTIVE}`);
      gitQuiet(dir, 'update-index', '--chmod=+x', 'script.sh');
    },
    noAutoBind: true,
    expectExit: EXIT_CHECK_FAILED,
    expectFailed: ['C5'],
  },
  reviewbindUntrackedBaseOidSurvivesStagingCase(),
  {
    // A `review-scope: partial` line and a later `review-scope: full` line must count as
    // TWO scope declarations (ambiguous, unbound) - not as one "full" plus one line that
    // simply failed to match a full-only regex and was silently dropped.
    name: 'a partial review-scope line next to a full one leaves the leg unbound',
    build: (dir) => {
      gitBackedFixture(PASSING_FILES)(dir);
      const state = computeSliceState(dir, null);
      writeFileSync(
        path.join(dir, '.conduct', 'luna-demo.md'),
        `diff-sha256: ${state.digest}\nreview-scope: partial\nreview-scope: full\n\n${SUBSTANTIVE}`,
      );
    },
    noAutoBind: true,
    expectExit: EXIT_CHECK_FAILED,
    expectFailed: ['C5'],
  },
  {
    // A compound value ("partial, files A and B") still counts as a `review-scope:` line -
    // the count must not depend on the value regex matching, or a later literal `full` line
    // slips through as the only counted one.
    name: 'a compound review-scope value next to a full one leaves the leg unbound',
    build: (dir) => {
      gitBackedFixture(PASSING_FILES)(dir);
      const state = computeSliceState(dir, null);
      writeFileSync(
        path.join(dir, '.conduct', 'luna-demo.md'),
        `diff-sha256: ${state.digest}\nreview-scope: partial, files A and B\nreview-scope: full\n\n${SUBSTANTIVE}`,
      );
    },
    noAutoBind: true,
    expectExit: EXIT_CHECK_FAILED,
    expectFailed: ['C5'],
  },
);

function gitSupportsSha256() {
  const probeDir = path.join(os.tmpdir(), `preflight-close-sha256-probe-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(probeDir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', '--object-format=sha256'], { cwd: probeDir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

// `selfTest()` reads `testCase.skip` only after `build(dir)` returns (same closure pattern
// used above for a pinned base), so a build that needs a local git feature this machine's
// git may lack sets it there instead of leaving a half-built fixture for runChecks to choke on.
function reviewbindSha256ObjectFormatCase() {
  const testCase = {
    name: 'a sha256 (object-format) repo is not mistaken for an abbreviated sha1 oid',
    noAutoBind: true,
    expectExit: EXIT_ALL_PASS,
    expectFailed: [],
  };
  testCase.build = (dir) => {
    if (!gitSupportsSha256()) {
      testCase.skip = 'this git build has no sha256 object-format support';
      return;
    }
    mkdirSync(dir, { recursive: true });
    gitQuiet(dir, 'init', '-b', 'main', '--object-format=sha256');
    gitQuiet(dir, 'config', 'user.name', 'Selftest Fixture');
    gitQuiet(dir, 'config', 'user.email', 'selftest@example.invalid');
    writeFixture(dir, fixtureVariant({}, ['luna-demo.md']));
    gitQuiet(dir, 'add', '.');
    gitQuiet(dir, 'commit', '-m', 'base');
    writeRepoFile(dir, 'change.txt', 'hello\n');
    gitQuiet(dir, 'add', 'change.txt');
    const state = computeSliceState(dir, null);
    if (!state.ok) throw new Error(`sha256 repo: computeSliceState failed: ${state.detail}`);
    writeFileSync(path.join(dir, '.conduct', 'luna-demo.md'), `diff-sha256: ${state.digest}\nreview-scope: full\n\n${SUBSTANTIVE}`);
  };
  return testCase;
}

SELF_TEST_CASES.push(reviewbindSha256ObjectFormatCase());

SELF_TEST_CASES.push(
  {
    // Two implementer families (fable, anthropic; grok, xai) via "+". A grok (xai) leg
    // covers fable's family (xai != anthropic) but IS the worker's other family, so it does
    // not cover itself - one leg covering some families is not coverage for all of them.
    name: 'a two-family worker cell is not covered by a leg sharing one of the families',
    build: gitBackedFixture(fixtureVariant(
      { 'ledger.md': ledgerWithWorker('fable+grok-4.7@grok-cli'), 'grok-demo.md': `grok review: ${SUBSTANTIVE}` },
      ['luna-demo.md'],
    )),
    expectExit: EXIT_CHECK_FAILED,
    expectFailed: ['C5'],
  },
  {
    name: 'a dangling delta-from (no matching ancestor hash) fails C5',
    build: (dir) => {
      gitBackedFixture(fixtureVariant({}, ['luna-demo.md']))(dir);
      const state = computeSliceState(dir, null);
      writeFileSync(path.join(dir, '.conduct', 'luna-demo.md'), `diff-sha256: ${state.digest}\ndelta-from: ${'a'.repeat(64)}\n\n${SUBSTANTIVE}`);
    },
    noAutoBind: true,
    expectExit: EXIT_CHECK_FAILED,
    expectFailed: ['C5'],
  },
  {
    name: 'a duplicate diff-sha256 line leaves a leg unbound',
    build: (dir) => {
      gitBackedFixture(PASSING_FILES)(dir);
      const state = computeSliceState(dir, null);
      writeFileSync(
        path.join(dir, '.conduct', 'luna-demo.md'),
        `diff-sha256: ${state.digest}\ndiff-sha256: ${state.digest}\nreview-scope: full\n\n${SUBSTANTIVE}`,
      );
    },
    noAutoBind: true,
    expectExit: EXIT_CHECK_FAILED,
    expectFailed: ['C5'],
  },
  {
    // An invalid diff-sha256 value must still count as a diff-sha256 line, or a leg with one
    // placeholder line and one valid line would wrongly bind to the valid one instead of
    // being rejected as a duplicate.
    name: 'a diff-sha256 line with an invalid value counts toward duplicate detection',
    build: (dir) => {
      gitBackedFixture(fixtureVariant({}, ['luna-demo.md']))(dir);
      const state = computeSliceState(dir, null);
      writeFileSync(
        path.join(dir, '.conduct', 'luna-demo.md'),
        `diff-sha256: TBD\ndiff-sha256: ${state.digest}\nreview-scope: full\n\n${SUBSTANTIVE}`,
      );
    },
    noAutoBind: true,
    expectExit: EXIT_CHECK_FAILED,
    expectFailed: ['C5'],
  },
  {
    // The parenthetical is a denied/considered cast, not an implementer: deepseek must not
    // enter the family set, so the single luna leg (openai, independent of fable's anthropic)
    // is sufficient coverage.
    name: 'a parenthetical worker-cell mention is stripped before family extraction',
    build: gitBackedFixture(fixtureVariant({ 'ledger.md': ledgerWithWorker('fable (deepseek-v4-flash@grok-cli considered, declined)') })),
    expectExit: EXIT_ALL_PASS,
    expectFailed: [],
  },
);

function canCreateSymlinks() {
  const probeDir = path.join(os.tmpdir(), `preflight-close-symlink-probe-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(probeDir, { recursive: true });
    writeFileSync(path.join(probeDir, 'target.txt'), 'x');
    symlinkSync('target.txt', path.join(probeDir, 'link.txt'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

// A staged symlink is unchanged in the worktree; the mismatch check must not falsely flag
// it. Skips (rather than fails) on a machine that cannot create symlinks at all (this
// project's own Windows dev box among them, confirmed via fs.symlinkSync EPERM without
// Developer Mode or admin rights) - a skip here is an environment fact, not a defect.
function reviewbindSymlinkCase() {
  const testCase = {
    name: 'a staged symlink is not a false stage-or-revert mismatch',
    noAutoBind: true,
    expectExit: EXIT_ALL_PASS,
    expectFailed: [],
  };
  testCase.build = (dir) => {
    if (!canCreateSymlinks()) {
      testCase.skip = 'this environment cannot create symlinks (no developer mode / admin rights)';
      return;
    }
    gitBackedFixture(fixtureVariant({}, ['luna-demo.md']))(dir);
    writeRepoFile(dir, 'target.txt', 'hello\n');
    symlinkSync('target.txt', path.join(dir, 'link.txt'));
    gitQuiet(dir, 'add', '--', 'target.txt', 'link.txt');
    const state = computeSliceState(dir, null);
    if (!state.ok) throw new Error(`expected slice-state to succeed for a staged symlink: ${state.detail}`);
    if (state.mismatchPath !== null) throw new Error(`expected no mismatch, got a false positive on ${state.mismatchPath}`);
    writeFileSync(path.join(dir, '.conduct', 'luna-demo.md'), `diff-sha256: ${state.digest}\nreview-scope: full\n\n${SUBSTANTIVE}`);
  };
  return testCase;
}

SELF_TEST_CASES.push(reviewbindSymlinkCase());

// The old (pre-fix) index/worktree diff, kept independent of collectIndexWorktreeDiffPaths so
// a reverted fix still fails the case below instead of being masked by a platform skip.
function rawIndexWorktreeDiffPaths(dir) {
  const out = runGitReadOnly(dir, ['diff', '--no-renames', ...DIFF_OVERRIDE_ARGS, '--name-only', '-z']);
  return out === null ? new Set() : new Set(out.split('\0').filter((file) => file !== ''));
}

// `git update-index --chmod` edits only the index record, so under core.filemode=true (forced
// here since it auto-detects false on this project's own Windows dev box) the real on-disk
// file never catches up - exactly the divergence P2.7 must not read as "stage or revert".
// Skips (rather than fails) when this git build doesn't reproduce that divergence at all.
function reviewbindFilemodeCase() {
  const testCase = {
    name: 'a staged mode-only change under core.filemode=true is not a false stage-or-revert mismatch',
    noAutoBind: true,
    expectExit: EXIT_ALL_PASS,
    expectFailed: [],
  };
  testCase.build = (dir) => {
    gitBackedFixture(fixtureVariant({}, ['luna-demo.md']))(dir);
    gitQuiet(dir, 'config', 'core.filemode', 'true');
    writeAndStageFile(dir, 'script.sh', '#!/bin/sh\necho hi\n');
    gitQuiet(dir, 'commit', '-m', 'add script');
    gitQuiet(dir, 'update-index', '--chmod=+x', 'script.sh');
    if (!rawIndexWorktreeDiffPaths(dir).has('script.sh')) {
      testCase.skip = 'this git build does not report a mode-only difference under core.filemode=true';
      return;
    }
    const state = computeSliceState(dir, null);
    if (!state.ok) throw new Error(`expected slice-state to succeed for a mode-only change: ${state.detail}`);
    if (state.mismatchPath !== null) throw new Error(`expected no mismatch for a mode-only change, got ${state.mismatchPath}`);
    writeFileSync(path.join(dir, '.conduct', 'luna-demo.md'), `diff-sha256: ${state.digest}\nreview-scope: full\n\n${SUBSTANTIVE}`);
  };
  return testCase;
}

SELF_TEST_CASES.push(reviewbindFilemodeCase());

// Many committed, never-touched .conduct/ files: tracked (so they land in a real `ls-files
// -s`), but always excluded from the slice itself (same `.conduct/` filter parseRawZ and the
// untracked/cached listings already apply), so they inflate only the FULL index, never
// path set D.
function bulkConductFileNames(count, fillerLength) {
  const names = [];
  for (let i = 0; i < count; i += 1) {
    names.push(`bulk-${'a'.repeat(fillerLength)}-${String(i).padStart(5, '0')}.txt`);
  }
  return names;
}

function bulkConductFiles(count, fillerLength) {
  const files = {};
  for (const name of bulkConductFileNames(count, fillerLength)) files[name] = '';
  return files;
}

SELF_TEST_CASES.push({
  // 11,000 long-named tracked paths push the repo's full `git ls-files -s -z` past 1 MiB;
  // the actual slice is one new small file. Proves collectIndexEntries reads only path set D.
  name: 'a large index (full ls-files output over 1 MiB) does not fail C5',
  build: (dir) => {
    gitBackedFixture(fixtureVariant(bulkConductFiles(11_000, 40), ['luna-demo.md']))(dir);
    const fullIndexBytes = Buffer.byteLength(runGitReadOnly(dir, ['ls-files', '-s', '-z']) ?? '', 'utf8');
    if (fullIndexBytes <= 1024 * 1024) {
      throw new Error(`expected the repo's full ls-files -s output to exceed 1 MiB, got ${fullIndexBytes} bytes`);
    }
    writeAndStageFile(dir, 'change.txt', 'one line\n');
    const state = computeSliceState(dir, null);
    if (!state.ok) throw new Error(`expected slice-state to succeed against a large full index: ${state.detail}`);
    writeFileSync(path.join(dir, '.conduct', 'luna-demo.md'), `diff-sha256: ${state.digest}\nreview-scope: full\n\n${SUBSTANTIVE}`);
  },
  noAutoBind: true,
  expectExit: EXIT_ALL_PASS,
  expectFailed: [],
});

SELF_TEST_CASES.push(
  {
    // No size cap on the slice-state hash: a large tracked, staged file (a lockfile is the
    // real-world case) must still bind and pass, not fail closed on size alone.
    name: 'a tracked file over 1 MiB no longer blocks the slice-state hash',
    build: (dir) => {
      gitBackedFixture(fixtureVariant({}, ['luna-demo.md']))(dir);
      writeRepoFile(dir, 'big.txt', Buffer.alloc(2 * 1024 * 1024, 'A'));
      gitQuiet(dir, 'add', 'big.txt');
      const state = computeSliceState(dir, null);
      if (!state.ok) throw new Error(`expected slice-state to succeed for a 2 MiB tracked file: ${state.detail}`);
      writeFileSync(path.join(dir, '.conduct', 'luna-demo.md'), `diff-sha256: ${state.digest}\nreview-scope: full\n\n${SUBSTANTIVE}`);
    },
    noAutoBind: true,
    expectExit: EXIT_ALL_PASS,
    expectFailed: [],
  },
  {
    // Same stub treatment untracked large/binary files already get (P1.1): a staged 2 MiB
    // change to an already-tracked file, embedded inline, would be impractical to review.
    name: 'a staged 2 MiB tracked change renders as a stub in --diff-patch',
    build: (dir) => {
      gitFixtureFor(
        fixtureVariant({}, ['luna-demo.md']),
        (existing) => writeAndStageFile(existing, 'big.txt', Buffer.alloc(2 * 1024 * 1024, 'A')),
        (existing) => writeRepoFile(existing, 'big.txt', 'small\n'),
      )(dir);
      const rendered = renderDiffPatch(dir, null);
      if (!rendered.ok) throw new Error(`expected --diff-patch to succeed for a 2 MiB tracked change: ${rendered.detail}`);
      if (!/large or binary file omitted, sha256 [0-9a-f]{64}/.test(rendered.text)) {
        throw new Error('expected a stub line for the 2 MiB tracked change, got the whole diff inline');
      }
      const state = computeSliceState(dir, null);
      if (!state.ok) throw new Error(`expected slice-state to succeed: ${state.detail}`);
      const headerMatch = /^diff-sha256: ([0-9a-f]{64})$/m.exec(rendered.text);
      if (headerMatch === null || headerMatch[1] !== state.digest) {
        throw new Error('expected the --diff-patch header hash to equal what C5 recomputes');
      }
      writeFileSync(path.join(dir, '.conduct', 'luna-demo.md'), `diff-sha256: ${state.digest}\nreview-scope: full\n\n${SUBSTANTIVE}`);
    },
    noAutoBind: true,
    expectExit: EXIT_ALL_PASS,
    expectFailed: [],
  },
  {
    // A submodule bump (gitlink) is recorded as content (the new commit sha), not rejected
    // outright - C2's gate-skip keeps its own, stricter gitlink rejection (unaffected here,
    // since no skip token is in play).
    // A real nested repo, checked out at the exact commit the gitlink stages - so the index
    // and worktree genuinely agree, and the only thing under test is whether computeSliceState
    // accepts the gitlink at all (a fake cacheinfo-only gitlink with no matching checkout
    // would rightly trip the separate "stage or revert" check, which is not what P2.6 is about).
    name: 'a gitlink (submodule) content change binds and passes C5',
    build: (dir) => {
      gitBackedFixture(fixtureVariant({}, ['luna-demo.md']))(dir);
      const subDir = path.join(dir, 'sub-a');
      mkdirSync(subDir, { recursive: true });
      gitQuiet(subDir, 'init', '-b', 'main');
      gitQuiet(subDir, 'config', 'user.name', 'Selftest Fixture');
      gitQuiet(subDir, 'config', 'user.email', 'selftest@example.invalid');
      writeFileSync(path.join(subDir, 'file.txt'), 'sub content\n');
      gitQuiet(subDir, 'add', '.');
      gitQuiet(subDir, 'commit', '-m', 'sub base');
      const subHead = runGitReadOnly(subDir, ['rev-parse', 'HEAD']).trim();
      gitQuiet(dir, 'update-index', '--add', '--cacheinfo', `160000,${subHead},sub-a`);
      const state = computeSliceState(dir, null);
      if (!state.ok) throw new Error(`expected slice-state to succeed for a gitlink change: ${state.detail}`);
      if (state.mismatchPath !== null) throw new Error(`expected no mismatch, got ${state.mismatchPath}`);
      writeFileSync(path.join(dir, '.conduct', 'luna-demo.md'), `diff-sha256: ${state.digest}\nreview-scope: full\n\n${SUBSTANTIVE}`);
    },
    noAutoBind: true,
    expectExit: EXIT_ALL_PASS,
    expectFailed: [],
  },
  {
    name: 'an untracked path never staged fails C5 with a distinct remedy',
    build: gitFixtureFor(PASSING_FILES, (dir) => writeRepoFile(dir, 'new.txt', 'hello\n')),
    expectExit: EXIT_CHECK_FAILED,
    expectFailed: ['C5'],
    detailIncludes: 'is untracked (never staged)',
  },
);

SELF_TEST_CASES.push({
  name: 'a tracked path with glob characters appears in --diff-patch',
  build: (dir) => {
    gitFixtureFor(
      fixtureVariant({}, ['luna-demo.md']),
      (existing) => {
        writeAndStageFile(existing, 'app/[slug].tsx', 'export default function Slug() {\n  return "new";\n}\n');
        writeAndStageFile(existing, 'app/s.tsx', 'export default function S() {\n  return "s-new";\n}\n');
      },
      (existing) => {
        writeRepoFile(existing, 'app/[slug].tsx', 'export default function Slug() {\n  return "old";\n}\n');
        writeRepoFile(existing, 'app/s.tsx', 'export default function S() {\n  return "s";\n}\n');
      },
    )(dir);
    const rendered = renderDiffPatch(dir, null);
    if (!rendered.ok) throw new Error(`expected --diff-patch to succeed for glob-shaped tracked paths: ${rendered.detail}`);
    const slugHeaderCount = rendered.text.split('diff --git a/app/[slug].tsx b/app/[slug].tsx').length - 1;
    const sHeaderCount = rendered.text.split('diff --git a/app/s.tsx b/app/s.tsx').length - 1;
    if (slugHeaderCount !== 1) {
      throw new Error(`expected exactly one diff header for app/[slug].tsx, got ${slugHeaderCount}:\n${rendered.text}`);
    }
    if (sHeaderCount !== 1) {
      throw new Error(`expected exactly one diff header for app/s.tsx, got ${sHeaderCount}:\n${rendered.text}`);
    }
    const state = computeSliceState(dir, null);
    if (!state.ok) throw new Error(`expected slice-state to succeed: ${state.detail}`);
    writeFileSync(path.join(dir, '.conduct', 'luna-demo.md'), `diff-sha256: ${state.digest}\nreview-scope: full\n\n${SUBSTANTIVE}`);
  },
  noAutoBind: true,
  expectExit: EXIT_ALL_PASS,
  expectFailed: [],
});

function selfTest() {
  const root = path.join(os.tmpdir(), `preflight-close-selftest-${process.pid}-${Date.now()}`);
  let mismatches = 0;
  let skipped = 0;
  try {
    for (const testCase of SELF_TEST_CASES) {
      const dir = path.join(root, testCase.name.replace(/[^a-z0-9]+/gi, '-'));
      try {
        if (testCase.build) testCase.build(dir);
        else writeFixture(dir, testCase.files);
      } catch (error) {
        mismatches += 1;
        console.log(`SELFTEST FAIL  ${testCase.name}: build threw - ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      // A fixture that needs an environment feature this machine's git lacks (sha256
      // object-format support, symlink creation) sets `skip` on itself during build, rather
      // than being silently counted as a pass or reported as a false failure.
      if (testCase.skip) {
        skipped += 1;
        console.log(`SELFTEST SKIP  ${testCase.name}: ${testCase.skip}`);
        continue;
      }
      if (!testCase.noAutoBind) autoBindLegs(dir, testCase.slice ?? 'demo', testCase.baseArg ?? null);
      const results = runChecks(dir, testCase.slice ?? 'demo', testCase.baseArg ?? null);
      const failed = results.filter((r) => !r.pass).map((r) => r.id.trim().split(' ')[0]);
      const exit = failed.length === 0 ? EXIT_ALL_PASS : EXIT_CHECK_FAILED;
      const exitOk = exit === testCase.expectExit;
      const failedOk = failed.length === testCase.expectFailed.length && testCase.expectFailed.every((id) => failed.includes(id));
      const detailOk = !testCase.detailIncludes || results.some((r) => !r.pass && r.detail.includes(testCase.detailIncludes));
      if (exitOk && failedOk && detailOk) {
        console.log(`SELFTEST PASS  ${testCase.name}`);
      } else {
        mismatches += 1;
        const detailNote = detailOk ? '' : `; no failed check's detail includes "${testCase.detailIncludes}"`;
        console.log(
          `SELFTEST FAIL  ${testCase.name}: expected exit ${testCase.expectExit} failing [${testCase.expectFailed.join(', ')}], got exit ${exit} failing [${failed.join(', ')}]${detailNote}`,
        );
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const rendererOk = selfTestRenderer();
  if (!rendererOk) mismatches += 1;
  // +1: the renderer check above runs unconditionally alongside SELF_TEST_CASES, so it is
  // part of both the pass count and the total, not a bonus check the denominator forgets.
  const total = SELF_TEST_CASES.length - skipped + 1;
  console.log(
    `SELFTEST ${mismatches === 0 ? 'PASS' : 'FAIL'}: ${total - mismatches} of ${total} cases match${skipped ? ` (${skipped} skipped)` : ''}.`,
  );
  return mismatches === 0 ? EXIT_ALL_PASS : EXIT_CHECK_FAILED;
}

// Unit-level check of the --diff-patch untracked-hunk renderer: needs no git repository at
// all, so it runs the same on every platform, including one (Windows) where a real chmod
// cannot make a file executable to set up an end-to-end fixture.
function selfTestRenderer() {
  const dir = path.join(os.tmpdir(), `preflight-close-selftest-renderer-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'script.sh'), 'echo hi\n');
    const indexEntries = new Map([['script.sh', { mode: '100755', oid: 'a'.repeat(40) }]]);
    const hunk = renderUntrackedHunk(dir, 'script.sh', indexEntries, true);
    const ok = hunk !== null && /^new file mode 100755$/m.test(hunk);
    console.log(ok
      ? 'SELFTEST PASS  renderUntrackedHunk records the ship mode (100755), not a hardcoded 100644'
      : `SELFTEST FAIL  renderUntrackedHunk records the ship mode: got ${JSON.stringify(hunk)}`);
    return ok;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === '--self-test') return selfTest();
  let worktree = null;
  let slice = null;
  let base = null;
  let diffPatch = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--slice') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--') || slice !== null) {
        console.error('preflight-close: --slice requires exactly one value');
        return EXIT_BAD_INVOCATION;
      }
      slice = value;
      i += 1;
    } else if (argv[i] === '--base') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--') || base !== null) {
        console.error('preflight-close: --base requires exactly one value');
        return EXIT_BAD_INVOCATION;
      }
      base = value;
      i += 1;
    } else if (argv[i] === '--diff-patch') {
      diffPatch = true;
    } else if (argv[i].startsWith('--')) {
      console.error(`preflight-close: unknown flag: ${argv[i]}`);
      return EXIT_BAD_INVOCATION;
    } else if (worktree === null) {
      worktree = argv[i];
    } else {
      console.error('preflight-close: exactly one worktree path is accepted');
      return EXIT_BAD_INVOCATION;
    }
  }
  if (worktree === null || slice === null) {
    console.error('preflight-close: usage: node preflight-close.mjs <worktree-path> --slice <slice-name> [--base <ref>] [--diff-patch] | --self-test');
    return EXIT_BAD_INVOCATION;
  }
  const abs = path.normalize(path.resolve(worktree));
  if (!existsSync(abs)) {
    console.error(`preflight-close: worktree path does not exist: ${abs}`);
    return EXIT_BAD_INVOCATION;
  }
  if (diffPatch) {
    const rendered = renderDiffPatch(abs, base);
    if (!rendered.ok) {
      console.error(`preflight-close: ${rendered.detail}`);
      console.error(`  remedy: ${rendered.remedy}`);
      return EXIT_BAD_INVOCATION; // any git failure or a state change while rendering
    }
    process.stdout.write(rendered.text);
    return EXIT_ALL_PASS;
  }
  console.log(`preflight-close: ${abs} --slice ${slice}`);
  return printResults(runChecks(abs, slice, base));
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`preflight-close: internal failure: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = EXIT_BAD_INVOCATION;
}
