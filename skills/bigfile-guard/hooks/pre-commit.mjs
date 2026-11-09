#!/usr/bin/env node
// Git pre-commit hook: `node <skill>/hooks/pre-commit.mjs` from .git/hooks/pre-commit (SKILL.md, Install).
// warn (default) prints the report and exits 0; block exits 1; off skips the check.
// Any error (not a repo, git missing) exits 0: the guard never stops a commit because it broke.
import { checkStaged, report } from './lib.mjs';

let res;
try { res = checkStaged(); } catch (e) {
  console.error(`bigfile-guard: check skipped (${e.message.split('\n')[0]})`);
  process.exit(0);
}
for (const w of res.warnings) console.error(w);
const text = report(res);
if (text) console.error(text);
process.exit(text && res.mode === 'block' ? 1 : 0);
