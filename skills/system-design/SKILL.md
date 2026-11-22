---
name: system-design
description: "Designs a system or an architectural change before any code: grills the user one question at a time with a recommended answer, drafts a design doc at docs/designs/<slug>.md from a fixed template, has it reviewed by a fresh reviewer from another vendor, and waits for the user to accept it. Use when the task adds a service, a data model or a cross-component change, or makes a decision costly to reverse; when the user asks for a system design, design doc or architecture; and when `start` stage 2 finds an architectural task. Also runs interview practice: plays the interviewer and scores the user's design against the template."
---

# system-design

Three phases, in order: **Grill**, **Draft**, **Review**, then the user's **acceptance**. No implementation starts before acceptance. Interview practice is a separate mode (below).

## The template

Every phase works against these sections; their order is the order of the doc.

1. **Goal and non-goals**: the outcome, and the scope written as negation (what this design will not do).
2. **Requirements**: functional (what users and callers can do) and non-functional (SLO for latency and availability, scale, durability, accuracy, cost ceiling); each threshold the user gave is quoted verbatim.
3. **Capacity estimates**: requests per second (average and peak, reads and writes apart), storage per year, bandwidth in and out, each computed by a script whose output is pasted, each input named as given or assumed.
4. **API**: each endpoint or message, with inputs, outputs, errors and idempotency; every entity callers read or write gets its writes and its reads, list reads included.
5. **Data model and ownership**: entities, keys, indexes, retention, and an ownership table: each entity, the one component that writes it, the components that read it.
6. **High-level architecture**: a mermaid diagram of components and data flow, plus one line per component.
7. **Deep dives**: the 2 or 3 riskiest parts (picked by blast radius times uncertainty), each with the mechanism, the numbers, and what breaks first under load.
8. **Trade-offs and rejected alternatives**: each alternative, why it lost, and what would make it win.
9. **Failure modes and recovery**: per component and dependency, what fails, how it is detected, the blast radius, and the recovery (retry, fallback, replay, restore), with RPO and RTO where data is at stake.
10. **Security**: authentication, authorization, trust boundaries with input validation, secrets, data at rest and in transit, abuse and rate limits.
11. **Rollout and migration**: phases, feature flags, backfill, dual writes or reads, rollback at each phase.
12. **Verification plan and definition of done**: the tests, load tests, metrics and alerts that prove each requirement, each tied to a section above.
13. **Open questions**: what is still undecided, with an owner.

A section is **settled** when it holds an answer from the user, a decision record from a model panel the user ran (cited, with its dissents), a fact from the code (cited as `file:line`), or an **assumption** labelled `Assumption:` with the value used. "Not applicable" is a settled answer when it carries one line of why.

## Phase 1: Grill

Walk the design tree with the `grilling` skill [not installed: the same method, by hand], with these rules taking precedence over its defaults:

- **One question at a time**, each with your recommended answer and its reason; wait for the answer before the next question. One message or tool call carries exactly one question: never parallel tool calls for questions, never a numbered list of questions outside batch mode. Outside batch mode, count the `?` in each call before sending it: more than one `?` means split it. Pick the next question from the decisions whose prerequisites are settled, highest consequence first: scale and SLO before storage, storage before API details.
- **No item cap.** The tree is as deep as the design needs.
- **Facts come from the code, not the user.** Before asking, look: existing services, schemas, configs, traffic dashboards in the repo, prior docs in `docs/designs/` and ADRs. A question the code answers is answered, with the `file:line`, and never asked. Decisions (scope, trade-offs, SLOs, budget) stay the user's.
- **Batch mode**, only when the user asks for it (async, "send all questions at once"): one coded questionnaire `Q1..Qn` covering every open question whose prerequisites are settled, each with a recommended answer; the user replies by code. Repeat for the questions the answers unblocked.
- A user who says "use your recommendation" or "skip" settles that question as an assumption. Said for all questions: settle each remaining one with your recommendation, without waiting, and still list them before drafting.

- **Stop condition.** Keep asking while an open decision would change a number in Capacity, a component in the architecture or a data store; stop when the only open decisions would change a paragraph, not the shape. Settle those with your recommendation as `Assumption:` and move on. Scope, SLO, cost ceiling and acceptable data loss are always asked, whatever their size, unless the user said skip.

- **Requirements list.** Before drafting, write in the chat one line per requirement the user stated or confirmed: each feature, entity, number and threshold, in the user's words.

Phase 1 is done when every section of the template is settled. List the sections and how each was settled (user, code, assumption) in the chat, not in the doc, before drafting.

## Phase 2: Draft

1. Write `docs/designs/<slug>.md` (`<slug>`: kebab-case of the system or change). The repo already keeps design docs elsewhere: use that place and its format, and name the difference to the user. Header: title, date, status `draft`, author (the model), reviewer (filled in Phase 3).
2. Fill the template section by section, in order. Each claim traces to a Phase 1 answer, a cited fact or a labelled assumption; a new decision found while drafting goes back to Phase 1 as one question.
3. Numbers come from one script, never mental arithmetic: every computed figure in the doc (Capacity, deep dives, load-test targets, cost) is an input or an output of one `python3` snippet, with replicas, copies and fan-out (recipients per message, followers per post) as named variables, never folded into a constant. Write it (no Python: `node -e` or any interpreter at hand; none at all: say so in the section and show each formula with its result), run it, and paste its output into Capacity; rerun it whenever an input changes. The section is done when it shows requests per second average and peak (reads and writes apart), storage per year (and over the retention period), and bandwidth in and out at peak.
4. Each threshold the user gave (any number the design must meet: latency, availability, accuracy, data loss, durability, cost and the rest) gets a derivation in the doc that the design meets it (from the script or the mechanism), or an explicit `does not meet: <gap>` with what would close it; the verification plan tests it and never assumes it passes.
5. Start from the simplest design that meets the requirements (one region, one data store, no cache, queue or extra service). Each component or mechanism beyond it names the requirement or Capacity number the simpler choice fails; none, the simpler choice stays. YAGNI cuts mechanisms, never a requirement: every item on the requirements list appears in Requirements and in each section that serves it (API, Data model, Capacity, Security, Failure modes and so on). Deep dives pick the 2 or 3 parts where a wrong choice costs the most to undo, name why each was picked, and compare against that simplest choice.
6. The doc holds the design (and, after Phase 3, its review log) only: assumptions stay inline as `Assumption:` labels, and there is no settled-by table or column; that table, a second assumptions list and the acceptance summary go to the chat.
7. **ADR** only for a decision that is hard to reverse, surprising without context, and the outcome of a real trade-off: a short file in the repo's ADR folder [none: `docs/adr/NNNN-<slug>.md`] with context, decision, consequences, linked from the doc. Every other decision lives in the doc only.

Phase 2 is done when all 13 sections are filled, every item on the requirements list is covered, the Capacity checklist is complete and the mermaid block renders (`mmdc` when installed; otherwise say it was checked by reading only).

## Phase 3: Review

1. Pick the reviewer: a model from a different vendor than the author (a Claude author gets a Codex/GPT reviewer, a Codex/GPT author gets a Claude reviewer), run headless and read-only, with **fresh context**: it gets the doc path, the repo and the brief in [`references/review-brief.md`](references/review-brief.md), never this conversation. No other vendor can run: a fresh subagent of the same vendor, the one exception to the vendor rule; the doc header and the acceptance message both say so.
2. The reviewer checks four lenses (completeness, YAGNI, failure modes, implementation readiness) and rates each finding `blocker`, `major` or `minor`.
3. Verify each `blocker` and `major` yourself against the doc and the code. A finding that holds goes back: a missing decision to Phase 1 as a question, a gap in the text to Phase 2. A finding that does not hold gets one line of why in the review log. `minor` findings go to Open questions or are fixed in place.
4. Round 2 runs on the revised doc with a new fresh reviewer. There is no round 3: findings still open after round 2 go to the user, listed.
5. Append a review log to the doc: per round, the reviewer model, each finding, its severity and what was done.

## Acceptance

Show the user, in the chat: the doc path, the settled-by table, the assumptions, the open findings and the ADRs. The user accepts, or answers with changes (back to the phase they touch). On acceptance set the status to `accepted` with the date. Implementation, including `start` stage 3, begins only after this.

## Interview practice

When the user asks to practise a system design interview: follow [`references/interview.md`](references/interview.md). It plays the interviewer, never writes `docs/designs/` unless asked, and ends with a score against the template.
