# Loop details

Every dispatch of a slice step (opinion, gate, implement, review) starts by emitting
`--type task.phase` with a JSON payload file `{taskId: "<step>", phase: "...", attempt: n}`,
where `taskId` matches the step name in the list below.

1. **Brief** the slice (you): read the repo's CLAUDE.md + any active handoff (gate commands, merge
   authority, commit identity, branch/PR convention). Open the brief with the task in your own
   words: what must change, what stays out of scope, and which choices are the operator's (leave
   those open, do not decide them). If you cannot restate it without guessing, ask before
   dispatching. Then answer these in the brief, rewrite it to ask
   for exactly that, name the answer that changed it ("none changed it" if none):
   1. Goal beyond the goal: what does this serve next; can it ask for a durable outcome?
   2. Verb, not noun: what must happen, not which artifact?
   3. Expert: what would a top specialist do that was not asked for, the rawest material they
      start from, their tools beyond reasoning?
   4. Verifier: which step 5 gate, or why none?
   5. Stretch target: one ambitious number beside the realistic one?
   Write `.conduct/brief-<slice>.md`, then
   register the orchestration:
   `node "${CLAUDE_SKILL_DIR}/scripts/conduct-events.mjs" register --slice <slice> --session $CLAUDE_CODE_SESSION_ID --repo <worktree> --vault <memory sink id> [--ticket <ticket id>]`
   (`--vault` is required; pass any label such as `none` when no memory sink is bound).
2. **Worktree** off current origin/main.
3. **Opinion**: if a memory sink is bound, query it for a prior decision on the same question
   first (references/decision-persistence.md); a found decision skips or supersedes the stage.
   Otherwise: one brief, two vendors with roles (Opinion stage), parallel, read-only. Mandatory when non-trivial (taskId: opinion).
   Opinion stage details: references/opinion-fusion.md.
4. **Fusion** - write consensus / divergence / discarded / decision. Freeze the spec on it.
   If a memory sink is bound in this environment, read references/decision-persistence.md and
   write the Decision now, then emit `--type decision.recorded` with a JSON payload file
   containing `{memoryId, ticketId?, phase: "fusion"}`.
5. **Gate**: cross-vendor author writes the executable gate from the spec; verify it FAILS (taskId: gate).
6. **Implement**: route per the table (SDD for Claude workers, `codex exec` cross-vendor) (taskId: implement).
   Worker cannot edit the gate. Worker runs the gate to green.
7. **Per-task review** as SDD prescribes, then **≥1 cross-vendor review leg per implementer
   family** (see Cross-vendor independence rule) (taskId: review). Write the patch FIRST with
   `--diff-patch` and hand it to the leg (see Fusion); stamp its `diff-sha256` header into the
   leg file the vendor returns, plus `review-scope: full` (or, for a narrow re-review after a
   small fix, `delta-from: <the diff-sha256 the leg builds on>`), so `preflight-close.mjs` can
   bind it at close; pick effort and vendor per Token hygiene, above.
   Token hygiene rules: references/token-hygiene.md.
   Fusion details: references/opinion-fusion.md.
8. **Adjudicate** into the fusion doc + route fixes: never fix yourself. Emit `--type review.verdict`
   per adjudicated leg.
9. **Opus whole-branch review**, then hand the PR to the operator to merge (they hold authority), with the slice's `<rule> -> <choice>` lines (SKILL.md, Rule index).
10. **Close**: append the slice's ledger row (spec: references/ledger.md), run `preflight-close.mjs`
   BEFORE merging (a merge moves the merge-base, so every leg's `diff-sha256` reads stale
   afterward - if the merge already happened, pass `--base <the diff-base from the leg's stamped
   header>` to check against the state the legs actually reviewed), then run Slice teardown in its
   fixed order (see references/teardown.md; a red preflight exit blocks the close). Teardown's
   Close step ends the orchestration with `conduct-events.mjs end --terminal closed|abandoned`;
   a slice is not closed before that.

**Escape hatch:** steps 3-5 may be skipped for trivial/mechanical slices - but the conductor must
state which steps it skipped and why, in one line, before dispatching. Silent skipping is a role
violation exactly like implementing yourself. A skip is recorded in `.conduct/skip-<slice>.md` as
a skip record: a `skipped:` line listing which of `opinion`, `fusion`, `gate` are waived, and a
`reason:` line of at least 40 characters; prose elsewhere in the file does not count, the
`skipped:` label must start the line, and a duplicate `skipped:`/`reason:` line or an empty token
(a trailing comma) invalidates the whole record just like an unrecognized token does. The opinion
skip may also be recorded as `skipped` in the ledger's opinion-vendors cell; an existing skip file
that is blank or invalid blocks that fallback. The gate skip (`skipped: gate`) additionally needs,
before `preflight-close.mjs` will accept it: no `gate-<slice>.*` file present at the same time (both
present fails closed, choose one), the merge-base diff (index AND working tree, the larger
changed-line count per path winning) at 1..30 changed lines across 1..2 files excluding `.conduct/`
and excluding any gitignored file, no gitlink (submodule) change on either side, every version of a
changed path (merge-base, index, worktree) under 1 MiB, and the same C5 review-coverage rule
(references/teardown.md) satisfied for the ledger row's `worker` cell - a gate skip waives the gate,
never review independence.

Alternative to running the loop once: to compare two castings on one real slice, read
references/casting-race.md before starting either arm.

Once per machine, before the first slice: install the event hooks (references/per-repo-grounding.md,
which also lists per-repo gotchas).
