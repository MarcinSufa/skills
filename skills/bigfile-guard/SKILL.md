---
name: bigfile-guard
description: Git pre-commit hook and Claude Code PreToolUse hook that flag staged text files over about 5000 tokens when they are new or grew, with exemptions for lockfiles, minified, vendored, generated and dataset files. Warns by default; blocks only when a repo opts in. Use when a commit reported "bigfile-guard", when a file has to be split or exempted, or when setting the guard up in a repo or on a host.
---

# bigfile-guard

Agents read large files in parts and edit them less reliably. The guard stops the growth of large files at commit time; it does not touch files that already exist and do not grow.

## Rule

A staged text file is reported when all of these hold:

- its estimate is over the limit (default 5000 tokens),
- it is new, or larger than in `HEAD` (a rename compares against the old path),
- it is not exempt.

Binary files (a NUL byte in the first 8000 bytes) are skipped. Tokens are `max(bytes/4, words*1.3)`; no tokenizer runs offline, so the limit is approximate.

Default exemptions: lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `*.lock`, `go.sum`, `bun.lockb`), `*.min.js`, `*.min.mjs`, `*.min.css`, `*.map`, `*.snap`, `__snapshots__`, `vendor`, `third_party`, `node_modules`, `dist`, `build`, `generated`, `*.generated.*`, `*_generated.*`, `*.pb.go`, `fixtures`, `__fixtures__`, `testdata`, `eval/**/data/**`, `*.log`, `*.patch`, `*.diff`, `.conduct/**`, `graphify-out/**`. A repo adds globs in `.bigfile-allow` at its root (read from the index, so it counts once staged), one per line, `#` for comments. A glob without `/` matches the file name anywhere; with `/` it matches the repo-relative path.

## When the guard reports a file

- Split the file along its seams (one module per concern, tests next to the module they test) and commit the split.
- If the file is generated, vendored or a dataset, add a glob to `.bigfile-allow` in the same commit and say why in the message.
- In block mode do not commit with `--no-verify` or move the content to another big file to get past the hook. Ask the user.

## Config

| Setting | Env (wins) | git config | Default |
| --- | --- | --- | --- |
| Mode: `warn` (report, exit 0), `block` (git hook exits 1, Claude hook denies), `off` | `BIGFILE_MODE` | `bigfile.mode` | `warn` |
| Limit in tokens | `BIGFILE_LIMIT` | `bigfile.limit` | `5000` |

When both are set, the stricter wins (`off` < `warn` < `block`, the lower limit), so `BIGFILE_MODE=off git commit` does not undo a repo's `block`. An unknown mode or a limit that is not a positive integer prints a warning and is ignored, so a typo is never stricter than `warn` and never looser than the other source. Any error inside the guard (not a repo, git missing) lets the commit through.

## Install

Nothing is enabled by default; `manifest.json` does not list these hooks. Opt in per repo or per host.

Git hook, per repo (`.git/hooks/pre-commit`, executable):

```sh
#!/bin/sh
exec node "$HOME/.claude/skills/bigfile-guard/hooks/pre-commit.mjs"
```

If the repo already has a pre-commit hook, add the `node` line to it instead of replacing it. Block mode for that repo: `git config bigfile.mode block`.

Claude Code hook, per host (`~/.claude/settings.json`, or the skills repo `manifest.json` if it should go to every host):

```json
{ "event": "PreToolUse", "matcher": "Bash|PowerShell", "command": "node \"{HOME}/.claude/skills/bigfile-guard/hooks/claude-pretooluse.mjs\"", "timeout": 10 }
```

It runs only on commands containing `git ... commit` (any case, across `\` or backtick line continuations) and checks the index of the directory each commit in the command runs in, read from the command text: the `cd`/`pushd`/`Set-Location <dir>` before it, then every `git -C <dir>` in order, else the hook's cwd. In block mode it denies with the report as the reason, so the agent sees which file to split; in warn mode it adds a `systemMessage`. With both hooks installed the report shows twice in warn mode.

## Limits

- `git commit --no-verify` skips the git hook. The Claude hook sees only the command text: aliases, scripts and `git commit -a` / `git commit <path>` (files staged by the commit itself) are not checked by it; the git hook still checks those.
- The Claude hook reads the command text, not the shell: `$repo`, `~`, `--git-dir`/`--work-tree` are not resolved (the check is skipped or runs on the cwd), and `echo 'git commit'` counts as a commit. It denies only when the index really has a violation. The git hook is the gate; the Claude hook tells the agent why.
- A staged blob git cannot read is estimated from its size (`git cat-file -s`), so it is never passed as empty.
- The estimate can be off by tens of percent, more for non-English text.
- Growth of an already big file counts at any size, even one line. Measured on the last 50 commits of two repos at limit 5000, this rule would have flagged 32% and 62% of commits, so `block` is not the default.

## Test

`node --test skills/bigfile-guard/test/*.test.mjs`
