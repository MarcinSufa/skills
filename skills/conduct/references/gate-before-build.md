## Gate-before-build - write the check before the work

**MANDATORY for non-trivial slices.** Review is the binding constraint of agentic engineering; a gate
written *before* implementation converts review from a judgement call into a command that exits 0 or 1.

1. **Gate author ≠ implementer vendor.** Route the gate to the cross-vendor leg (or vice versa) -
   this also satisfies the independence rule up front rather than after the fact (see Cross-vendor
   independence rule).
2. The gate author reads the spec/brief ONLY - not the implementation, which does not exist yet.
   It writes an **executable** gate (script or test file) at `.conduct/gate-<slice>.*`, plus a
   fail-message per assertion. The fail messages are the feedback channel back to the builder.
3. **Run the gate before implementation starts.** It must FAIL. A gate that passes against an empty
   tree asserts nothing - send it back. Failing is necessary but not sufficient: have the gate
   author also **prove satisfiability** - apply the intended fix in a throwaway copy (never the real
   tree), reach green, then delete the copy. Rules out a gate that is red because it is impossible
   rather than because the code is wrong. Satisfiability still ≠ correctness - a too-wide gate
   passes wrong implementations; that is what the review legs are for.
3b. **Mock symmetry rule (earned 2026-07-28):** every side of the surface the diff touches must be
   discriminating in the gate. An F1 gate argument-keyed the READ path (`decrypt` succeeded only
   with the right key) but stubbed the WRITE path (`encrypt` accepted anything) - it went 8/8 green
   on code that 500'd on the primary journey, because the defect was on the write side. If the gate
   mocks reads discriminating and writes as no-ops (or vice versa), the unasserted side is where
   the bug ships.
3c. **Public-entry assertion rule (earned 2026-09-09):** every gate must include at least one
   assertion that enters through the public entry point (the CLI argv or the top-level exported
   function) and asserts on the normalised artifact, never only on internal helpers or literals
   the gate itself wrote. In one project a gate went 55/55 green while the real route
   still carried hardcoded literals, because its "config-wired" assertion called a helper instead
   of entering through the evaluation path; a cross-vendor reviewer caught it.
4. The implementer is briefed with the gate path and told: **you may not edit the gate file.** If
   the gate is wrong, the worker reports it; the conductor routes the fix back to the gate author.
5. Implementation ends by running the gate. Fail → the fail-message output goes back to the builder
   verbatim as the next brief. Pass → proceed to the review legs (the gate replaces none of them; it
   removes the mechanical findings so reviewers spend attention on judgement).

The gate is a slice artifact, not a deliverable - keep it in `.conduct/`, out of the shipped diff,
unless it graduates into a real test (often it should; say so at hand-off).
