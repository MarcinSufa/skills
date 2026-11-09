---
name: start
description: "Use when the user types `@start <task>`. Runs the whole pipeline from one command: sharpen, clarify, implement, gates, cross-model review, lessons."
---

# @start pipeline

I type only `@start <task>`; stages 2-6 start themselves, no further commands from me.

1. Sharpen (you do this yourself; /pstack:sharpen is user-only and cannot be invoked by you): before any tool call or other stage, print 4 one-line answers: what a top expert would do here that I didn't ask for; the rawest material they'd start from; their tools and methods beyond reasoning; what outside the model shows the result is right (for a bug: everything the reporter sees in their repro, such as text, pin, coordinates, badge, each one an assertion with the expected value from the reporter's material or the live system, not from our code). Then my prompt rewritten to ask for exactly that. Never skip this stage, even when a later stage is blocked.
2. Clarify: open architecture or product questions, or additions that grow scope → run the `grilling` skill in place as one coded questionnaire (Q1, O1; max 5 items), wait for my short answer. Nothing open → go on without asking.
3. Implement: first check nobody else is on it: `git fetch --all --prune`, then `git log --remotes --grep <TICKET>` (commit messages on every remote branch, whatever the default is called), `git branch -r --list "*<TICKET>*"` (branch names) and `gh pr list --state all --search <TICKET>` (and again before opening the PR); someone else's branch, PR or merge → stop and report, do not build a parallel fix. Substantive work → the `conduct` skill (when installed) in a worktree: a worker model writes, a model from another vendor reviews, both as named in the user's roster file (see `risk-code-review`). Trivial single-file edit → the driving session writes it directly.
4. Gates: never-do and enforce-spec-gate hooks run on their own; a block is reported, never routed around.
5. Verify and review: before handing over, run superpowers:verification-before-completion; UI change → committed e2e spec + before/after film. Stubs of external APIs copy real recorded responses, redacted (tokens, PII) as in diagnosing-bugs. A "known limit" or "needs BE" goes to QA/Jira only with a probe of the provider's alternative endpoints and its numbers; otherwise it is an open bug. Look up every changed file in the repo's flag catalog (the `flag-matrix` skill says where it lives); a file the catalog lists as a reader means the change reads flags, so run the `flag-matrix` skill before handing over: each flag profile through each lifecycle moment, including a slow server response that echoes an older value back over a newer edit. A project names its own catalog and probe in its CLAUDE.local.md. Work back from QA: also fix the harness that let the bug through (see CLAUDE.md). Then run the `risk-code-review` skill on the final tree: risk tier and door, the reviewers the tier picks, P0 / Proof, fix rounds and the PR body section all live there.
6. Lessons: if the setup has a lessons pipeline (a hook that queues corrections, a curation pass), it runs on its own schedule, not per task.
Stops that stay: stage 2 answer, cost gate, commit/push approval.

Fast path: a trivial single-file edit (under ~30 lines) skips stages 2 and 3 conduct; the driving session writes it directly, stage 5 still runs.
