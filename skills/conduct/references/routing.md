# Routing details

These model-selection details supplement the routing table in SKILL.md.

Before dispatching a Luna or Sol leg, read references/codex.md. Before a Grok or DeepSeek leg,
read references/grok.md. Before a Composer 2.5 leg, read references/composer.md.

**Model freshness (MANDATORY):** version numbers in this table are
the tier map, not a pin. Before the FIRST dispatch to a vendor in a program, verify what that
vendor's CLI currently defaults to and use the newest tier the routing allows: Grok →
`grok models` (`grok.exe models` on Windows; default marked with `*`), codex → the model list in
`~/.codex/models_cache.json` and the `~/.codex/config.toml` `model =` line (that line can lag:
on one machine it still said `gpt-5.6-luna` after GPT-6 shipped, so it is not proof of the newest tier),
Claude → the Agent tool's model options. Dispatch with the model id explicit (`-m`) so the run
is reproducible, and record the actual id in the ledger row. If the observed default is newer
than what this table names, USE the newer one and update the table in the same session (one
Edit; note the date). This table is the ONLY place in the skill that says which model id to
dispatch; every other section says the tier (Luna, Sol, Grok) and ids elsewhere are format
examples, so a model bump stays a one-row edit.
Lesson: Grok 4.6 shipped and became the CLI default while the table still said 4.5, and the
GPT-6 bump left ten stale `gpt-5.6-*` ids across the contracts. **Exception, Astra:** never a default leg; only for an exceptional leg the operator names (an
impasse after Luna and Sol, or an explicit ask). The freshness rule does not promote Astra.
Codex effort: the global default is the `model_reasoning_effort` line in `~/.codex/config.toml`
and differs per machine (`medium` on one, `xhigh` on another), so pass the tier
explicitly: a leg that decides `-c model_reasoning_effort=high`, a bounded read `medium` (see
Token hygiene rule 2, above).
Token hygiene rules: references/token-hygiene.md.

**Model-choice heuristic:** the master rule - a leg that
*decides* (what we build, whether we merge) rides the top tier (Sol, Opus); a leg that *executes*
or checks a single piece rides the cheap-fast tier (Luna, Sonnet). Mis-tiering down costs
one correction round; mis-tiering up only costs rate limits. Turn-count still dominates token
price: a cheap model needing three correction rounds costs more than the right tier once, so fuzzy
brief or hard TDD → Sonnet, not Luna. The everyday working pair is **Luna writes, Opus reviews**
(replacing "Fable writes, Luna reviews") - the cross-vendor gate holds
(OpenAI implements, Anthropic reviews) and Claude limits go to coordination and review. **Fable is
never dispatched**, in any leg or as conductor.
Grok is Opus-tier at subscription-flat cost (operator assessment, on 4.5) - prefer it when
an implementation leg should also diversify vendors, or when Claude budget is tight. GPT Terra:
skip (Luna beats it on index and speed; a third GPT tier is one more per-dispatch decision).
DeepSeek Flash 4.1 (`deepseek-v4-flash`): overflow tier for reading legs only (per-token, weaker than
Luna) - dispatch when GPT/Claude/Grok limits are exhausted and the leg must read the repo; now
dispatchable as a full reading agent via the Grok CLI (see references/grok.md). Cheap-worker note
(operator observation): DeepSeek/Grok reading legs barely touch Claude limits and the
cross-vendor review keeps quality up - prefer them when Claude budget matters.

**Orchestrator choice:** **Opus 5** conducts every program, both open-decision work (new spec,
divergent legs, architecture) and execution days (plan approved, work = dispatch + collate), and
reviews the Luna implementation legs. Fable never conducts. A
two-vendor impasse = spend a third leg (Sol/Grok) rather than force-adjudicate.
