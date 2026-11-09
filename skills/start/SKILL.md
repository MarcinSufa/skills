---
name: start
description: Use when the user types `@start <task>` (or `@start setup`). Runs the whole pipeline from one command by composing other skills: sharpen, clarify (grilling), implement (worktree, conduct), gates, verify and review (flag-matrix, risk-code-review), lessons (promote-lessons). On first use it asks once for the team (conductor, worker, reviewer models) and a default strategy, and saves them in the user's roster file.
---

# @start pipeline

The user types only `@start <task>`; every stage below starts itself. A stage whose skill is not installed runs its fallback, and the hand-off names the skill that was missing.

## 0. Team and strategy (first use, or `@start setup`)

Read the roster file the user's CLAUDE.md points to (the same file `risk-code-review` reads). If it has a `## Team and strategy` section, use it and do not ask. Otherwise:

1. Detect what can run: `command -v claude codex gemini grok cursor-agent` (on Windows also look for `grok.exe` under `~/.grok/bin`), plus the Agent tool's models (opus, sonnet, haiku). A CLI that is present but fails a one-line `--version` is not offered.
2. Ask once, in one `AskUserQuestion` call: conductor (default: the driving session), worker (default: a model from another vendor than the conductor when one runs, else a fresh subagent), reviewer (default: a vendor that differs from the worker), default strategy (table below).
3. Write the answers to the roster file as:
   ```
   ## Team and strategy
   | Role | Model | Command |
   | --- | --- | --- |
   | Conductor | <model> | the driving session |
   | Worker | <model> | <headless command, brief in a file> |
   | Reviewer | <model> | <headless command, read-only> |
   Default strategy: <solo | fan-out | consensus | review>
   ```
   No roster file: create one where the user says, then tell them to point their CLAUDE.md at it.
4. A named model that cannot run (quota, payment error, timeout) is swapped for the next one from another vendor; the hand-off names the swap and the error. Ask again only on `@start setup`.

| Strategy | Stage 3 runs as |
| --- | --- |
| solo | the worker implements in one worktree; the reviewer reviews |
| fan-out | the conductor splits the task into independent parts, one worker per worktree in parallel, then merges in order |
| consensus | three models (at least two vendors) answer each open design decision independently; still split after round 2 (each sees the others' answers), the conductor decides and records the split |
| review | the task is a PR or branch: skip stages 2 to 4 and run `risk-code-review` on it |

A task can override the default: `@start --fan-out <task>`, `@start --consensus <task>`, `@start --review <PR# or branch>`.

## Stages

1. **Sharpen** (do it yourself; never skip, even when a later stage is blocked): before any tool call, print 4 one-line answers: what a top expert would do here that the user did not ask for; the rawest material they would start from; their tools and methods beyond reasoning; what outside the model shows the result is right (for a bug: everything the reporter sees in their repro, each an assertion with the expected value from the reporter's material or the live system, not from the code). Then the user's prompt rewritten to ask for exactly that.
2. **Clarify.** Open architecture or product questions, or additions that grow scope: run `grilling` as one coded questionnaire (Q1, O1; max 5 items) and wait for the short answer. Strategy consensus: put each open decision to the three models first and bring the user only what they could not settle. Nothing open: go on without asking. Fallback: ask the same questionnaire yourself.
3. **Implement.** First check nobody else is on it: `git fetch --all --prune`, then `git log --remotes --grep <ticket>`, `git branch -r --list "*<ticket>*"` and `gh pr list --state all --search <ticket>` (again before opening the PR). Someone else's branch, PR or merge: stop and report, never build a parallel fix. Then `worktree`, then `conduct` with the team and strategy from stage 0: the worker writes, the conductor briefs, dispatches and adjudicates. Fallback without `conduct`: dispatch the worker yourself with a brief file and review its diff; never let the reviewer be the worker's vendor. Trivial single-file edit (under ~30 lines): the driving session writes it directly.
4. **Gates.** Hooks (guard rules, spec gates, proof gates) run on their own; a block is reported, never routed around.
5. **Verify and review.** `superpowers:verification-before-completion` before claiming done. UI change: a committed e2e spec and a before/after film. Stubs of external APIs copy real recorded responses, redacted. A "known limit" or "needs backend" is reported only with a probe of the provider's alternative endpoints and its numbers; otherwise it is an open bug. A changed file the project's flag catalog lists as a reader of a flag or config setting: run `flag-matrix`. Work back from QA: a bug fix also fixes the harness that let it through. Then `risk-code-review` on the final tree with the team's reviewer: tier, door, P0 / Proof, fix rounds and the PR body section live there.
6. **Lessons.** `promote-lessons` runs as a periodic curation pass, not per task; at hand-off, name any correction the user gave during the run so the queue holds it.

Stops that stay: the stage 0 and stage 2 answers, a cost gate before any paid batch run, approval to commit or push.

Fast path: a trivial single-file edit skips stage 2 and stage 3's `conduct`; stage 5 still runs.
