# Opinion and fusion

## Opinion stage - decide with two vendors, not one

**MANDATORY before any non-trivial slice's spec is frozen.** A slice is non-trivial if it changes
architecture, data shape, a public contract, or spans >1 file of real logic. Trivial/mechanical work
(renames, doc syncs, single-line fixes) skips this - say so explicitly, don't skip silently.

The conductor decides *how* to build. Deciding solo, from one model's context, is the same failure as
implementing solo. So:

1. Write ONE decision brief - the question, the constraints, the evidence (live logs, timings, repro).
2. Dispatch it **unchanged** to two different vendors **in parallel**, read-only. Claude leg = Agent
   tool (`Explore`/`Plan`, no Edit/Write). Cross-vendor leg = `codex exec … < /dev/null` or Grok with
   `--sandbox read-only`. Neither sees the other's answer - independence is the whole point.
   Keep the brief byte-identical, append one role line per leg (carries no other leg's answer).
   Architecture, data-shape or public-contract slices: one leg is the **red team** (find holes,
   propose and grade nothing), the other assesses the approach.
3. Capture both to `.conduct/opinion-<slice>-<vendor>.md`.

Do NOT summarize one opinion into the other's prompt. Contaminated opinions are one opinion.

## Fusion - the divergence is the output

After the opinion legs return, the conductor writes `.conduct/fusion-<slice>.md` with exactly four
sections:

| Section | What goes in it |
|---|---|
| **Consensus** | What both vendors independently agreed on. Lowest information - treat as settled, move on. |
| **Divergence** | Where they disagreed, and *why* each chose what it chose. **This is the reason the stage exists.** |
| **Discarded** | What one proposed and the fusion rejected, with the rejection reason. |
| **Decision** | The single call the conductor is making, which inputs drove it, and one `<rule> -> <choice>` line per rule that changed it (SKILL.md, Rule index). |

Rules:
- **Divergence is never resolved by majority vote or by picking the more confident tone.** Two legs
  cannot vote. Resolve on evidence, or spend one more leg (third vendor / a spike) specifically on the
  divergent point.
- Complementary ≠ contradictory. If both are right about different cases, keep both and say when each
  applies.
- Same four sections apply when adjudicating **review** legs, not just opinions. A review finding that
  only one vendor raised is a divergence, not noise - record why it was accepted or rejected.
- **Hand review legs the real diff (earned 2026-07-28; bound 2026-09-24).** Run
  `node "${CLAUDE_SKILL_DIR}/scripts/preflight-close.mjs" <worktree> --slice <slice> --diff-patch
  > .conduct/<slice>-diff.patch` and point every review leg at that file, never at raw `git diff`
  output. A leg without shell access that reconstructs a diff by comparing checkouts can produce a
  confident, fully-detailed FALSE finding: one leg "found" unauthorized scope creep, complete with
  an invented provenance story, by diffing against a stale branch. `--diff-patch` also stamps a
  `slice-state: v1` / `diff-base:` / `diff-sha256:` header onto the patch; copy the `diff-sha256`
  line verbatim into the top of the leg file the vendor returns, plus `review-scope: full` (or
  `delta-from: <hash>` for a narrow re-review). C5 at close time only accepts a leg whose
  `diff-sha256` still matches the slice's current state (or a `delta-from:` chain back to one
  that does): a leg reviewing a diff nobody can now reproduce does not count. Corollary: **conductor
  verifies structural claims** (is X in the diff at all?) with `git diff | grep` before routing any
  finding as work. Also the single largest cost lever in the skill: turn-cost data in
  references/token-hygiene.md.
- If the fusion has an empty Divergence section on a non-trivial slice, suspect contaminated
  opinions (same vendor twice, or one leg's answer leaked into the other's brief).
