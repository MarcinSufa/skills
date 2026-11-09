#!/usr/bin/env node
// Claude Code PreToolUse hook (matcher Bash|PowerShell). Before a `git commit` it runs the same check as the git hook
// on the index: block mode returns a deny with the report as the reason, warn mode a systemMessage. Other commands,
// a clean index and any error exit 0 with no output.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkStaged, report } from './lib.mjs';

// Case-insensitive (PowerShell runs `GIT commit`); `\` and backtick line continuations are joined first.
const COMMIT = /\bgit\b[^|;&\n]*?\bcommit\b/gi;
const unquote = (s) => s.replace(/^["']|["']$/g, '');

// Directories of every `git commit` in the command: the `cd`/`pushd`/`Set-Location <dir>` before it, then each
// `git -C <dir>` in order (git applies them relative to each other), else cwd. Best effort on the command text;
// the git hook is the gate that sees the real repo.
export function commitDirs(command, cwd) {
  const text = command.replace(/[\\`]\r?\n/g, ' ');
  const dirs = [];
  for (const m of text.matchAll(COMMIT)) {
    let dir = cwd;
    for (const c of text.slice(0, m.index).matchAll(/(?:^|[;&|(]\s*)(?:cd|pushd|set-location|sl)\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/gi)) {
      dir = resolve(dir, unquote(c[1]));
    }
    for (const c of m[0].matchAll(/\s-C\s+("[^"]+"|'[^']+'|\S+)/g)) dir = resolve(dir, unquote(c[1]));
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

export function decide(input, env = process.env) {
  const { tool_input: ti = {}, cwd = process.cwd() } = input;
  const dirs = commitDirs(String(ti.command ?? ''), cwd);
  const texts = [];
  let deny = false;
  for (const dir of dirs) {
    let res;
    try { res = checkStaged(dir, env); } catch { continue; }
    const text = [...res.warnings, report(res)].filter(Boolean).join('\n');
    if (!text) continue;
    texts.push(dirs.length > 1 ? `${dir}:\n${text}` : text);
    if (res.mode === 'block' && res.violations.length) deny = true;
  }
  if (!texts.length) return null;
  const text = texts.join('\n');
  if (deny) {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: text } };
  }
  return { systemMessage: text };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  let raw = '';
  for await (const c of process.stdin) raw += c;
  let out = null;
  try { out = decide(JSON.parse(raw || '{}')); } catch { out = null; }
  if (out) console.log(JSON.stringify(out));
}
