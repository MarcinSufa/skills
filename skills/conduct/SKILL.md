---
name: conduct
description: Multi-model, mixed-vendor orchestration - the driving session specs, dispatches and adjudicates, workers implement. Use when a coding task tempts you to implement it yourself instead of routing it to a worker; when an architecture or spec decision needs more than one vendor's opinion before it is made; or when a non-trivial change needs an independent review leg from a different vendor than the implementer. Triggers - "route this to a worker", "get a second vendor's opinion", "cross-vendor review", "independent review".
---

# Conduct: multi-model orchestration

## Overview

You are the **conductor**, not a player. You spec, decompose, dispatch, adjudicate reviews, and
synthesize. **You never write implementation code yourself**: every code change is routed to a
worker, no matter how small. Workers span vendors (see Cross-vendor independence rule, below).

Three things are multi-vendor, not one: **the decision** (opinion → fusion), **the check**
(gate-before-build), and **the review**. Combine compute, don't select it; the value is in where
the vendors *disagree*.

This is a *working model*, not a per-task speed optimization. Its payoff is a clean orchestrator
context, vendor-independent verification, and a repeatable routing discipline, not shaving minutes
off one small edit. Judge it over the program, not the task.

**REQUIRED SUB-SKILL:** superpowers:subagent-driven-development is the execution engine for
Claude-family workers: `/conduct` routes it, it does not replace SDD's per-task review discipline.
For independent parallel tasks, use superpowers:dispatching-parallel-agents (worktree isolation).

**Paths:** `${CLAUDE_SKILL_DIR}` is this skill's directory (the one holding this SKILL.md and
`scripts/`). The references/*.md files use the same placeholder unexpanded: substitute that directory.

## Rule index

Read the full section for any rule you apply. Each entry names when it applies and where it lives.

- **Brief.** Opening a slice, before any dispatch. (The loop step 1, references/loop.md)
- **Iron Rule.** About to change product or test code. Route it to a worker. (The Iron Rule)
- **Flat dispatch.** Any dispatch or re-dispatch into a worktree. (The Iron Rule, Flat dispatch)
- **Cross-vendor independence.** Picking a reviewer or a gate author. (Cross-vendor independence rule)
- **Token hygiene.** Writing any worker leg's brief. (Token hygiene, references/token-hygiene.md)
- **Bulk-read.** About to read a file of ~350+ lines or any PDF. (references/bulk-read.md)
- **Routing.** Picking the worker and transport for a leg. (Routing table, references/routing.md)
- **Opinion stage.** Choosing the approach for a non-trivial slice. (references/opinion-fusion.md)
- **Fusion.** After opinion or review legs return. (references/opinion-fusion.md)
- **Gate-before-build.** Before implementing a non-trivial slice. (references/gate-before-build.md)
- **Escape hatch.** Skipping opinion, fusion or gate on a trivial slice. (references/loop.md)
- **Slice artifacts.** Creating any `.conduct/` file. (references/slice-artifacts.md)
- **Decision persistence.** A memory sink is bound. (references/decision-persistence.md)
- **Ledger.** Closing a slice, before preflight. (references/ledger.md)
- **Preflight close and teardown.** Closing a slice. (references/teardown.md)
- **Casting race.** The operator asks to compare two castings on one slice. (references/casting-race.md)

**Rule to decision.** Every fusion Decision and the step 9 hand-off message to the operator name
each rule that shaped a choice and the specific choice it changed, as `<rule> -> <choice>`. Cite only rules whose section
you read this session. A rule you followed by default without it changing anything is not cited;
if none changed a choice, write "no rule changed a choice".

## The Iron Rule

**The conductor never implements.** The driving session issues no `Edit`/`Write` to product or test
code; it routes the change to a worker. This holds even when the task is trivial, mechanical,
tightly coupled, or "faster to just do."

**Violating the letter of this rule is violating the spirit of it.** Doing "just the easy files"
yourself and delegating only the hard part is the exact failure this rule forbids.

| Rationalization (seen in the wild) | Reality |
|---|---|
| "It's a few small files; delegating is theater, overhead > the work." | The payoff isn't per-task speed; it's clean context + vendor-independent review + a repeatable pipeline. Route it. |
| "The work is sequential and coupled; subagents only help when parallel." | SDD dispatches coupled tasks sequentially to ONE worker in the slice worktree: coherent diff, no cross-contamination, and you keep the conductor role. Coupling is not a license to implement. |
| "Parallel agents in one tree cross-contaminate commits." | True, so coupled work goes to one sequential worker (SDD), and genuinely-parallel work gets one worktree per worker (dispatching-parallel-agents). Neither is a reason to do it yourself. |
| "I already hold the context; a subagent would just re-derive it." | Then put that context in the task brief. Briefing IS the conductor's job; it's not overhead, it's the work. |
| "I'll do steps 0-4 myself and delegate only the review." | Doing 0-4 is implementing. The review-only split is the signature failure. |
| "Recon/grep isn't implementation." | Read-only recon to write a brief is allowed. The instant you Edit/Write code or tests, you've broken role. |

**Red flags (STOP, you're about to break role):**
- Reaching for `Edit`/`Write` on a source/test file (`.ts`, `.tsx`, `.js`, spec files…).
- "For a slice this size I'd just…" / "The coordination cost exceeds…"
- Planning your "literal first action" as an edit rather than a brief or a dispatch.
- Routing the review but keeping the edit.
- **Deciding the approach solo**, then dispatching it as settled; deciding from one model's context
  is the same failure as implementing from it. Run the opinion stage.
- **Letting the implementer's vendor also write the gate**: a gate you wrote for yourself is not a
  check, it's a restatement.
- **Reporting "both legs agreed"** without having captured where they diverged. Two legs that produce
  zero divergence on a non-trivial slice usually means the briefs were contaminated.

**Allowed for the conductor:** read-only recon (Grep/Read/Glob) to write briefs; running the gate to
read failures; writing task briefs, specs, plans; adjudicating reviews; git orchestration (worktrees,
operator-authorized merges); synthesis and handoff. Everything that touches code content is a worker.
Sessions started with `claude --settings "${CLAUDE_SKILL_DIR}/settings/conductor-settings.json"` enforce this
with a PreToolUse hook (`scripts/conductor-guard.mjs`): a blocked write means brief it and dispatch a worker, not retry it another way.

**Flat dispatch.** The driving session dispatches every leg itself; a worker never dispatches legs of
its own. The harness can force a subagent to hand back while its background legs keep writing, and
those legs are then invisible to you: in one run, a leg judged dead was dispatched again and two
writers edited one worktree. At every dispatch, note the vendor, the handle (Agent id, background
task id, or pid of a `codex`/`grok` process) and the worktree. Before re-dispatching into a worktree,
stop every handle noted for it (TaskStop, or kill the pid) and confirm it is gone; a Bash-launched
`codex`/`grok` leg is absent from ListAgents and often carries the worktree only as its cwd.

## Cross-vendor independence rule

Every non-trivial slice gets, for **every implementer vendor family named in the ledger's `worker`
cell**, a review leg from a different family, current for the slice's `slice-state` hash (see
Preflight close, references/teardown.md C5) - a leg bound to a state the slice has since moved past
does not count, no matter which vendor wrote it. If a Claude implemented, the independent leg is GPT
Luna/Sol (codex), Grok, or Composer, not another Claude. An Opus whole-branch review is still
valuable, but Claude-on-Claude does **not** satisfy independence. The same rule binds the gate author
(see Gate-before-build): whoever writes the gate must not be the vendor that implements against it.

Gate-before-build details: references/gate-before-build.md.

This is the single home for the rule; other sections point back here instead of restating it.

## Token hygiene

1. **Patch, not repo.** Every review leg gets `.conduct/<slice>-diff.patch`, not shell access to reconstruct the diff.
2. **Effort is a tier, not a default.** `high`/`xhigh` only for legs that DECIDE; a bounded read against a written spec runs at `medium`.
3. **Prefer the free cross-vendor reviewer.** A Claude reviewer of a non-Anthropic implementation satisfies independence at zero marginal cost; reserve per-token Luna for Claude implementations.
4. **Strip the per-request context tax on EVERY worker leg, not just cheap ones**: skills catalog, injected CLAUDE.md and harness prompt; Grok-harness legs use the token diet (references/grok.md).
5. **Context size.** An implementation subagent gets ONE task per dispatch; past ~150 turns or ~200k context, re-dispatch a fresh leg with a short handoff brief; `autoCompactWindow` is the backstop, not the plan.

**bulk-read:** never Read a big file (~350+ lines, any PDF) into the driving session; use `scripts/bulk-read.mjs`.

Apply on every worker leg, in order. Measurements and full rules: references/token-hygiene.md.

## Routing table (v1)

A team named by the caller (a brief, the `start` skill, the user's roster file) takes precedence over this table: use its worker and reviewer for the rows they cover, and this table only for what the team leaves open. The models below are one working setup, not a requirement; a model you cannot run is replaced by another of the same class, as long as the independence rule above still holds. A decision record handed in by the caller counts as a prior decision for the Opinion stage.

| Task class | Worker | Transport |
|---|---|---|
| Orchestration: specs, briefs, dispatch, adjudication, fix triage, synthesis | **You (the conductor)** | the driving session |
| DEFAULT implementation legs (approved plan, clear brief) | **GPT-6 Luna** (was Fable 5) | same transport as the Luna row below; the conductor (Opus) reviews |
| Hard TDD, multi-step slices, fuzzy briefs; per-task (spec + quality) reviews | **Sonnet 5** | Agent tool, `model: sonnet` |
| Adversarial / whole-branch reviews; hard debugging; huge-context diffs | **Opus 5** | Agent tool, `model: opus` |
| Trivial mechanical fixups, bulk renames, doc syncs | **Haiku 4.5** | Agent tool, `model: haiku` |
| DEFAULT cross-vendor leg: per-slice review, second opinions, race judging, GPT-side implementation, high-volume/mechanical | **GPT-6 Luna** (`gpt-6-luna`, 2026-09-22; was GPT-5.6 Luna) | `codex exec -m gpt-6-luna` headless in the task worktree (also via the `/codex` skill where installed); per-token API variant `codex exec -p luna-api` with selectable reasoning effort, only where that profile is configured (see references/codex.md) |
| Decision-grade GPT ONLY: plan/spec review before approval; adversarial/whole-branch review before merge; hard debug after a failed Luna/Sonnet leg; diff too big to fit twice | **GPT-6.1 Sol** (`gpt-6.1-sol`, dispatch verified 2026-10-29 with codex-cli 0.159.2; was `gpt-6-sol`) | `codex exec -m gpt-6.1-sol` headless in the task worktree |
| Cross-vendor review: spec-vs-evidence challenge leg; TDD implementation legs (Opus-tier quality, subscription-flat cost) | **Grok 4.7** (`grok-4.7`, CLI default 2026-09-23) | `grok` headless in the task worktree (`grok.exe` on Windows): read-only sandbox for reviews, `--permission-mode bypassPermissions` for implementation (`acceptEdits` silently writes nothing; see references/grok.md) |
| Third-vendor PR review | **Composer 2.5** | **Cursor GitHub App** auto-review on push (subscription-absorbed; login `cursor[bot]`), once installed on the repo |
| Third-vendor pre-PR spec review / select tasks | **Composer 2.5** | **Cursor Background Agents API** when `CURSOR_API_KEY` is set (usage-billed ~$0.50-2/task); else manual paste-back (see references/composer.md) |
| PR-time review | **Copilot** | GitHub `requested_reviewers` (standing Mode X: Claude fixes, Copilot reviews) |
| Overflow worker (reading legs only) | **DeepSeek Flash 4.1** (`deepseek-v4-flash`) | `grok -m deepseek-v4-flash` headless (Grok CLI harness; per-token `DEEPSEEK_API_KEY`). **DeepSeek V4 Pro is NEVER dispatched** (only Flash, no Pro via API, in any leg). |

Model freshness, model-choice guidance, and orchestrator details: references/routing.md.

## The loop (per slice)

Lifecycle, skip rules, event hooks, and casting races: references/loop.md.

1. **Brief** the slice (you): read the repo's CLAUDE.md + active handoff; restate the task in your own words, answer the five questions, name the answer that changed it ("none changed it" if none), write `.conduct/brief-<slice>.md`, then register orchestration.
2. **Worktree** off current origin/main.
3. **Opinion**: if a memory sink is bound, query it for a prior decision on the same question first; a found decision skips or supersedes the stage. Otherwise, two vendors in parallel, read-only; mandatory when non-trivial.
4. **Fusion**: write consensus / divergence / discarded / decision (with its `<rule> -> <choice>` lines, see Rule index) and freeze the spec; if a memory sink is bound, write the Decision and emit `--type decision.recorded` with a JSON payload file containing `{memoryId, ticketId?, phase: "fusion"}`.
5. **Gate**: cross-vendor author writes the executable gate from the spec; verify it FAILS.
6. **Implement**: route per the table (SDD for Claude workers, `codex exec` cross-vendor); worker cannot edit the gate and runs it to green.
7. **Per-task review** as SDD prescribes, then **≥1 cross-vendor review leg per implementer family** on the real `--diff-patch`.
8. **Adjudicate** into the fusion doc + route fixes: never fix yourself; emit `--type review.verdict` per adjudicated leg.
9. **Opus whole-branch review**, then hand the PR to the operator to merge (they hold authority), with the slice's `<rule> -> <choice>` lines.
10. **Close**: append the ledger row, run `preflight-close.mjs` BEFORE merging, then run Slice teardown in its fixed order.

Opinion and fusion procedures: references/opinion-fusion.md.

## Gate-before-build

For non-trivial slices, write and validate an independent executable gate before implementation.
Full protocol: references/gate-before-build.md.

## Slice artifacts

Artifact layout and naming convention: references/slice-artifacts.md.
