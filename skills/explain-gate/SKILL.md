---
name: explain-gate
description: Checks a PR description's "## Explanation" section (What / Why / Risk) against the PR diff with deterministic rules and an optional codex read, and prints warnings only; it never blocks. Use when writing or reviewing a PR description, when an explain-gate report needs reading, or when setting the check up for a repo.
---

# explain-gate

An author (often an agent) can hand in a PR whose description says things the diff does not do. The proof gate checks that a review and proof exist, not that the author understands the change. This check compares the author's own explanation with the diff and reports claims that do not match.

It only warns. The script exits 0 on every path: mismatches found, no section, bad arguments, codex missing, codex timeout, codex reply without JSON. When the model could not run, the report says `not checked` instead of `ok`.

## The Explanation section (recommended, not required)

A PR without the section is not rejected anywhere; the check then reports `no_section` and skips the model.

```markdown
## Explanation

What: what the diff changes: files, functions, flags, behaviour before and after. Files and names in `backticks`. If something is deliberately NOT changed, write "X is unchanged".

Why: the reason. Numbers and incidents from outside the diff (measurements, reports) come with their source.

Risk: what can break and for whom: what runs automatically, what can block work, what is hard to undo. "None" only for changes with no runtime effect (text, typos).
```

Write it in your own words, not copied from commits or a model's answer.

## Run

```sh
gh pr view N --json body -q .body > /tmp/body.md
gh pr diff N > /tmp/pr.diff
node "$HOME/.claude/skills/explain-gate/scripts/explain-check.mjs" --body /tmp/body.md --diff /tmp/pr.diff
```

| Flag / env | Effect |
| --- | --- |
| `--no-model` | deterministic rules only: milliseconds, no network |
| `--json` | full report as JSON (`verdict`, `deterministic[]`, `model`) |
| `--timeout <sec>` / `EXPLAIN_TIMEOUT` | codex time limit, default 900 |
| `EXPLAIN_CODEX` | codex binary, default `codex` |

`verdict` is `mismatch`, `ok` or `not checked`. Each finding is a claim to verify by hand, not a fact: fix the description if the finding holds, ignore it if not.

## What it checks

Deterministic rules:

- `no_section`, `missing_field`: no `## Explanation`, or an empty What / Why / Risk.
- `file_not_in_diff`: a path in the text the diff does not touch (sentences "X is unchanged" are skipped).
- `symbol_not_in_diff`: a backticked token or `name()` in What / Risk that appears nowhere in the diff.
- `number_not_in_diff`: a 2+ digit number in What absent from the diff. Weak on big diffs, where most numbers occur somewhere.
- `undescribed_change`: a non-test file with 30+ changed lines the text never names.
- `risk_omitted`: Risk "none" on a diff touching `hooks/`, `bin/`, `manifest.json`, `sync.mjs`, `release.mjs`, `.github/`, or removing 20+ lines.

Model: `codex exec --sandbox read-only`, prompt on stdin, reply `{"mismatches":[{field,claim,evidence}],"verdict":"ok|mismatch"}`. It gets the file list and the diff cut to 6000 chars per file and 60000 in total. It looks for wrong files, functions or numbers, reversed behaviour, a motivation the diff contradicts, a significant omitted change, and a Risk that denies a risk the diff creates. Incomplete Risk and outside numbers in Why are not reported.

## Install

Nothing is enabled by default: `manifest.json`, the hooks and the `gh` proof gate do not call this script. Run it by hand, or wire it into a repo's own PR flow as a warning. Do not make a PR wait on it.

## Limits

- Measured on 6 PRs with one planted error each plus 6 correct explanations, 2 runs each (2026-11-04): the checker caught the planted error in 12/12 runs; the model alone flagged 1 of 10 runs on the 5 truly correct explanations. The prompt was tuned on that same set, so the false alarm rate is optimistic.
- One run is noisy: the model's verdict agreed between two runs on 10 of 12 cases.
- Cost per check: median about 19 s and 10.5k tokens, up to 145 s and 56k tokens on a 435 KB diff.
- Rules miss some wrong claims: a flag or dotted name matches as a substring (`--base` passes when the diff has `--baseline`), a path matches a longer one, and paths with spaces or git-quoted paths are not parsed.
- On a cut diff the model can miss or misreport what lies in the cut part.
- The diff goes to the codex provider, the same exposure as a codex review.

## Test

`node --test skills/explain-gate/test/*.test.mjs`
