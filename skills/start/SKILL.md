---
name: start
description: "Use when the user types `@start <task>` (or `@start setup`). Runs the whole pipeline from one command by composing other skills: sharpen, clarify (grilling), implement (worktree, conduct), gates, verify and review (flag-matrix, risk-code-review), lessons (promote-lessons). On first use it asks once for the team (conductor, worker, reviewer models) and a default strategy, and saves them in the user's roster file."
---

# @start pipeline

The user types only `@start <task>`; every stage below starts itself. A stage whose skill is not installed runs the fallback in brackets, and the hand-off names the skill that was missing.

Order: stage 1's sharpen output comes first, before any tool call; stage 0 runs right after it, then stages 2 to 6.

## 0. Team and strategy (first use, or `@start setup`)

Read the roster file the user's CLAUDE.md points to (the same file `risk-code-review` reads). If it has a `## Team and strategy` section and the command is not `@start setup`, use it and do not ask. Otherwise:

1. Detect what can run: `command -v claude codex gemini grok cursor-agent` (on Windows also look for `grok.exe` under `~/.grok/bin`), plus the Agent tool's models (opus, sonnet, haiku). A CLI that is present but fails a one-line `--version` is not offered.
2. Ask once, in one `AskUserQuestion` call: conductor (default: the driving session), worker (default: a model from another vendor than the conductor when one runs, else a fresh subagent), reviewer (default: a vendor that differs from the worker), panel (the third consensus voice; default: a third vendor when one runs, else none), default strategy (table below), and, when no roster file exists yet, where to create it.
3. Write the answers to the roster file as:
   ```
   ## Team and strategy
   | Role | Model | Command |
   | --- | --- | --- |
   | Conductor | <model> | the driving session |
   | Worker | <model> | <headless command, brief in a file> |
   | Reviewer | <model> | <headless command, read-only> |
   | Panel | <third model, or none> | <headless command, read-only> |
   Default strategy: <solo | fan-out | consensus | review>
   ```
   No roster file: create it at the answered path, then tell the user to point their CLAUDE.md at it.
   The Reviewer row is the other-vendor reviewer `risk-code-review` adds; its tier table (or the roster's) still decides how many reviewers run and at which depth.
4. A named model that cannot run (quota, payment error, timeout) is swapped for the next one from another vendor (a reviewer never from the worker's vendor); the hand-off names the swap and the error. Ask again only on `@start setup`; with no task after it, `@start setup` has nothing to sharpen: it skips stage 1 and ends once the section is written and shown.

| Strategy | Stage 3 runs as |
| --- | --- |
| solo | the worker implements in one worktree; the reviewer reviews |
| fan-out | the conductor splits the task into independent parts, one worker per worktree in parallel, then merges in order (rules below) |
| consensus | stage 2 puts each open design decision to three models and the conductor decides (rules below); stage 3 then builds as solo |
| review | the task is a PR or branch: skip stages 2 to 4 and the verify part of stage 5; stage 5's `risk-code-review` is the one review |

A task can override the default: `@start --fan-out <task>`, `@start --consensus <task>`, `@start --review <PR# or branch>`.

**Fan-out rules.** Parallel workers multiply token use, and they only pay off when the parts do not depend on each other.
- Use it only when the task splits into 2 to 4 parts that touch disjoint files and need no result from each other. Otherwise say why and run solo.
- Each brief lists the files that part owns; a worker that needs a file outside its list stops and reports.
- Merge one part at a time in the order the briefs were numbered, and run the build and tests after each merge. A part that turns out to need another part's result leaves the fan-out and runs after it, solo.
- A conflict goes back to the worker of the part merged later, with a new brief from the conductor that adds the conflicting files to its list: it merges the integrated branch into its tree and resolves it there. The conductor does not resolve conflicts, and nobody resolves one with a blanket `-X ours` or `-X theirs`.
- Stage 5 reviews the integrated tree, not the parts.

**Consensus rules.** More debate rounds make models drift toward the most forceful answer, so the value is in independent first answers from different vendors.
- The panel is the worker, the reviewer and the Panel row, from at least two vendors. No Panel row, or its model is `none`: the conductor is the third voice and writes its answer before reading the others. Only one vendor can run: say so and ask the user instead.
- Round 1: each model answers alone, from the same brief, without seeing the others. All agree: done, no round 2.
- Round 2, once: each model sees the other answers and may revise, giving the evidence that changed its mind. There is no round 3.
- Still split on a technical decision: the conductor decides on the evidence cited (a file and line, a measurement, a doc), not on the vote count or the confidence of the wording. Product behaviour, added scope and anything only the user can authorise always go to the user in stage 2's questionnaire, agreed or split: the panel's answers are a recommendation shown side by side, not an approval.
- Every outcome, agreed or split, gets a decision record: the question, each model and vendor with its first answer, any revision, the decision and each dissent.
- Consensus is for design decisions that are costly to reverse. A question a test or a probe can answer is answered by running it.

**Cost.** Fan-out and consensus with a per-token model are a paid batch run: before dispatch, state the number of legs (models times rounds, or parts) and the estimated cost (legs times brief and expected answer size in tokens, in money when the price is known), and wait for the user's ok.

## Stages

1. **Sharpen** (do it yourself; never skip, even when a later stage is blocked; the one exception is `@start setup` with no task): before any tool call, print 4 one-line answers: what a top expert would do here that the user did not ask for; the rawest material they would start from; their tools and methods beyond reasoning; what outside the model shows the result is right (for a bug: everything the reporter sees in their repro, each an assertion with the expected value from the reporter's material or the live system, not from the code). Then the user's prompt rewritten to ask for exactly that.
2. **Clarify.** Open architecture or product questions, or additions that grow scope: run `grilling` as one coded questionnaire (Q1, O1; max 5 items) and wait for the short answer. Strategy consensus: put each open decision to the panel first (consensus rules above) and bring the user what those rules send to the user. Nothing open: go on without asking. Fallback: ask the same questionnaire yourself.
3. **Implement.** First check nobody else is on it: `git fetch --all --prune`, then `git log --remotes --grep <ticket>`, `git branch -r --list "*<ticket>*"` and `gh pr list --state all --search <ticket>` (again before opening the PR). No ticket key: the same three searches with two or three distinctive words from the task. Someone else's branch, PR or merge: stop and report, never build a parallel fix. Then `worktree` [`git worktree add` outside the checkout, work in it by absolute path], then `conduct` with the team and strategy from stage 0: the worker writes, the conductor briefs, dispatches and adjudicates. Tell `conduct` the team in the brief; it takes precedence over conduct's own routing table. Strategy consensus: hand `conduct` the stage 2 decision record as the prior decision, so its Opinion stage does not ask the same question again. Fallback without `conduct`: dispatch the worker yourself with a brief file and review its diff; never let the reviewer be the worker's vendor. Trivial single-file edit (under ~30 lines): the fast path below.
4. **Gates.** Hooks (guard rules, spec gates, proof gates) run on their own; a block is reported, never routed around.
5. **Verify and review.** `superpowers:verification-before-completion` [run the build and tests and show their output] before claiming done. UI change: a committed e2e spec and a before/after film. Stubs of external APIs copy real recorded responses, redacted. A "known limit" or "needs backend" is reported only with a probe of the provider's alternative endpoints and its numbers; otherwise it is an open bug. A changed file the project's flag catalog lists as a reader of a flag or config setting: run `flag-matrix` [list each flag value and check the change under it by hand, or say it was not checked]. Work back from QA: a bug fix also fixes the harness that let it through. Then `risk-code-review` on the final tree with the team's reviewer [without the skill: the roster's tier table, if it has one, sets the depth; otherwise a fresh subagent and the team's reviewer each review the diff against the ticket; the hand-off lists their findings]: tier, door, P0 / Proof, fix rounds and the PR body section live there.
6. **Lessons.** `promote-lessons` [nothing to run] runs as a periodic curation pass, not per task; at hand-off, name any correction the user gave during the run so the queue holds it.

Stops that stay: the stage 0 and stage 2 answers when those stages ask, a cost gate before any paid batch run, approval to commit or push.

Fast path: a trivial single-file edit (under ~30 lines) skips stage 2 and stage 3's `conduct`, so conduct's never-implement rule does not apply: the driving session writes it directly. A task run with `--consensus` or `--fan-out` never takes the fast path. Stage 5 still runs.
