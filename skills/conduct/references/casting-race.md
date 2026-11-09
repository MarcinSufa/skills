# Casting race (optional, arena v0)

Read this when the operator wants to compare two castings on one real slice instead of running
the loop once, before starting either arm.

When the operator wants to COMPARE castings, run one real slice as a race instead of a single
pipeline. Never on synthetic briefs - the losing diff is the only waste, the winner ships.

1. **One brief, frozen first.** Write `brief-<slice>.md` as usual; it must not name any model.
   Same gate authored once, before either arm starts (gate author = a vendor in NEITHER casting).
2. **Two arms, two worktrees.** Each arm is a full casting (worker + reviewer from different
   vendors), e.g. arm A: DeepSeek worker + Luna reviewer; arm B: Grok worker + Sonnet reviewer.
   Arms run in parallel, isolated worktrees, identical brief + gate. No arm sees the other's
   output - independence exactly as in the opinion stage.
3. **Blind judging.** When both arms pass their gate + review, the conductor strips vendor
   identity (diff files named `arm-a.patch` / `arm-b.patch`, no model names inside) and dispatches
   a judge leg from a vendor that appears in NEITHER casting, with the brief + gate + both
   patches. Judge output: verdict per arm on correctness/design/tests, then a pick with reasons.
   Optionally a second judge from yet another vendor; judge divergence is adjudicated by the
   conductor like any review divergence (fusion table, never majority vote).
4. **Hard metrics beat judge vibes.** Record per arm in `.conduct/ledger.md` (one row per arm,
   tagged `race:<slice>`, per references/ledger.md's column spec): fix rounds to green, defects
   caught, wall time, per-token cost, gate failures. A judge pick that contradicts the metrics is
   a divergence to explain, not to average.
5. **Winner merges** through the normal steps 7-9 (its review already counts); loser's worktree
   is deleted. The race result (both rows + judge verdict path) goes into the slice-close memory.

Caveats (from external benchmark data, 2026-08-07): one race is an anecdote - only a series on
real tasks is signal; include an occasional SOLO arm (one strong model, no delegation) as
baseline, because solo wins on small cohesive tasks more often than orchestration pride expects;
harness identity matters as much as model identity, so the arm label always names both
(e.g. `deepseek@grok-cli`). Cost gate applies: state the estimated per-arm cost before dispatch.
