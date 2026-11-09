# Leg ledger v2 spec

Read this before writing the ledger row at slice close (Loop step 10 in SKILL.md and
references/slice-artifacts.md).

**Leg ledger (casting telemetry, v2 as of 2026-08-26).** At slice close, the conductor appends
ONE row to `.conduct/ledger.md`: `| slice | worker | reviewer(s) | opinion vendors | fix rounds |
defects caught (P1/P2) | solo-ship? | verdict path (e.g. BLOCK,BLOCK,APPROVE) | vendor swaps + why |
cost | date |`.
`defects caught` = real defects a review leg found that the worker's own gate had already passed;
`solo-ship?` = y/n, would a solo merge have shipped them. Those two are the only columns that
answer "what does a second model find that I do not", so they are the ones worth citing outside
this repo. v2 additions: every leg named in `worker`, `reviewer(s)` and `opinion vendors` carries
the EXACT model id plus harness (`gpt-6-luna@codex`, `sonnet-5@agent`, `deepseek-v4-flash@grok-cli`):
the id actually dispatched, per the routing table's Model freshness block, never a tier name
alone; `cost` = reported tokens per leg with a coverage denominator (`in/out per leg, N of M legs
reported`), an unreporting subscription leg is `unknown` (never 0, never dollars, never an estimate;
same rule as teardown's Spend step, see references/teardown.md). Old v1 rows are left as-is; do
not migrate them. Thirty seconds of bookkeeping; over 10-15 slices it turns "which casting works
best" from vibes into data (feeds the future model-arena A/B). No tooling, no automation - a
markdown table row, written by hand.

**Worker cell convention (2026-09-24), read by `preflight-close.mjs` C2/C5.** When a slice had more
than one implementer, list every one in the `worker` cell, joined by `,` or `+`; a parenthetical
note (a denied cast, a fix round label) stays out of the family count, e.g. `deepseek-v4-flash@grok-cli
(core), claude-sonnet-5@agent (fix round 1)` counts as deepseek + anthropic, not the parenthetical
text. Every implementer family named this way needs its own current, independent review leg at
close (see references/teardown.md, C5) - list only models that actually changed the slice, not
ones that were cast and never used.
