# Token hygiene: measurements

The five token-hygiene rules and bulk-read policy moved from SKILL.md. Read the rules below and
the measurements below.

## Token hygiene

Apply on every worker leg, in order - cutting turns is free, cutting checks is not (measurements
behind these rules: references/token-hygiene.md).

1. **Patch, not repo.** Same rule as Fusion's "hand review legs the real diff" - every review leg
   gets `.conduct/<slice>-diff.patch`, not shell access to grep its way to the diff.
   Fusion details: references/opinion-fusion.md.
2. **Effort is a tier, not a default.** `high`/`xhigh` only for legs that DECIDE; a bounded read
   against a written spec runs at `medium`.
3. **Prefer the free cross-vendor reviewer.** A Claude subagent reviewing a non-Anthropic
   implementation satisfies independence at zero marginal cost; reserve per-token Luna for when a
   Claude implemented.
4. **Strip the per-request context tax on EVERY worker leg, not just cheap ones**: skills catalog,
   injected CLAUDE.md and harness prompt ride every turn regardless of task size. Grok-harness legs
   use the token diet (references/grok.md).
5. **Context size.** An implementation subagent gets ONE task per dispatch. A leg that passes
   ~150 turns or ~200k context is not continued: the conductor re-dispatches a fresh leg with a
   short handoff brief (what is done, what proves it, what is left). The global `autoCompactWindow`
   (read it from `~/.claude/settings.json`; it differs per machine) is the backstop, not the plan. Measurements: references/token-hygiene.md,
   Rule 5.

**bulk-read: never Read a big file into the driving session.** Any file over ~350 lines, and any
PDF, that the driver would otherwise `Read` goes through `scripts/bulk-read.mjs` (a cheap per-token
leg) and only cited bullets come back. The driver never Reads the file afterwards: follow a
citation with a narrow `Read` of those lines, or ask bulk-read a sharper question. Before the first
bulk-read call, read references/bulk-read.md (flags, models, chunk ceiling, deny list).

**Measured 2026-08-07 (one casting race):** two review legs over a ~500-line diff burned 1.67M tokens
and $0.11. The diff was ~15k tokens. The 100x gap was not the model and not the prompt; it was an
agent loop re-sending the whole conversation on every turn, on top of a fixed per-request context
tax.

**Rule 1 (patch, not repo) evidence:** Fusion states the rule for CORRECTNESS (a leg without the
patch can invent a false finding); it is also the single largest cost lever in the whole skill: a
reviewer that must `grep` its way to the diff pays for the entire conversation again on every tool
call, 20+ turns instead of 2. Give shell access only when the leg must run something (the gate, a
repro).

**Rule 2 (effort is a tier) evidence:** overriding a profile's default upward "to be safe" is how a
$0.01 leg becomes a $0.06 one with no better finding; verified: in that same race the `high`
reviewer found a subset of what the judge found.

**Rule 3 (prefer the free cross-vendor reviewer) evidence:** when the implementer is NOT Anthropic
and the driving session IS Claude, a Claude subagent review satisfies the independence rule at ZERO
marginal cost (session auth), while a per-token leg bills real money for the same guarantee. Name
the tradeoff out loud: if gate author + reviewer + judge are all Anthropic, the checking layer has
one vendor's blind spots even though the letter of the rule is met; with two or more legs, split
them across vendors and pay for at most one.

**Rule 4 (token diet on every leg) evidence:** measured 2026-09-09 across 946 `deepseek-v4-flash`
turns: each turn carried 33,567 tokens before the worker did anything, and the brief itself was 4%
of that. The rest was the skills catalog (137 skills, ~19k tokens), the injected CLAUDE.md (~12k)
and the harness system prompt. Three things that look like the cause were separated by measurement:
MCP tool schemas (grok loads them on demand via `search_tool`/`use_tool` - sessions with 93 tools
had a SMALLER prefix than sessions with 9, and 946 turns made zero MCP calls), `--disallowed-tools`,
and a project-level `[skills] ignore`. The diet recipe in references/grok.md (revised 2026-09-11,
`scripts/grok-diet.mjs` applies it) combines the effective controls with home vars left real: the
ten `GROK_CLAUDE_*`/`GROK_CURSOR_*` switches alone = -20%, a slim `GROK_HOME` alone = -7%,
switches + slim home + `[skills] ignore` in the diet config.toml = -48% (n=2). The earlier
`USERPROFILE`/`HOME` redirect is retired because it hid the global .gitconfig and broke commits
with "Author identity unknown"; its -7% slim-home gain is kept through `GROK_HOME`. Codex has the same disease and
says so out loud ("Skill descriptions were shortened to fit the skills context budget"); it has a
budget, grok has none.

**Rule 5 (context size) evidence:** measured 2026-09-24 over 40 recent Claude subagent transcripts
in one project. The fixed first-turn prefix was 30k-60k tokens (Sonnet median 58k) while
the brief was ~1% of it. Four Sonnet implementers reached 900k-967k context; the largest made 1477
requests and ~753M summed input tokens with one compaction. The growth came from turn count (978
Bash calls, each output at most ~5k tokens), not from big outputs: every turn re-sends the whole
conversation, so cost is quadratic in turns. One task per dispatch and a fresh leg past ~150 turns
or ~200k context cut the quadratic term; `autoCompactWindow` (read the current value from
`~/.claude/settings.json`; this note was written when it was 200000) only bounds the worst case.

**Do NOT economize on:** the gate (a cheap gate is a gate that misses a bug class), the number of
independent legs on a decision, or the judge in a race. Cutting turns is free; cutting checks is
not.
