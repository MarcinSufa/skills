---
name: risk-code-review
description: Use when asked to review a PR or branch (`@review <PR# or branch>`), and as the review step before handing over your own change. Risk-tiered review on two axes (Standards, Spec) by fresh-context reviewers the tier picks, ending with how much human review the change needs.
---

# risk-code-review

Findings are hypotheses for a human, not a verdict. The reviewer never wrote the code and starts in a fresh context, since a context reviewing its own work confirms it.

## Steps

1. **Target.** A PR: `gh pr view <n> --json title,body,author,headRefName,baseRefName,files`, `gh pr diff <n>` and the existing review comments. A branch, your own change, or a PR at a fixed head: `git diff <base>...<head>` (a fixed head takes its file list from this diff, not from `gh`, which shows the PR's current files). Then the raw ticket (key from the title or branch) with the reporter's screenshots, fetched from the tracker, never a summary. No ticket or the tracker unreachable: record why, and the Spec axis reviews against the PR description, or the title, branch and commits when the description is empty, and says which. Done when the diff and the spec source (ticket with attachments, or what replaced it) are saved in the scratchpad.
2. **Tier and door.**
   - Tier: the highest tier any touched file falls in, by the project's tier list (a "Risk tiers" or "Review risk tiers" section in its REVIEW.md, AGENTS.md, CLAUDE.md or CLAUDE.local.md). No list: High for code that saves data, moves money, reads a feature flag or tenant, customer or user settings, or checks permissions (static app settings do not count); Medium for other logic; Low for copy, styles, docs and test-only changes. A small diff keeps its tier.
   - Door: **one-way** when a revert does not undo it (schema or data migration, data written in a new shape, a changed API or message contract, deleted data, deploy or release config, messages sent to people, state changed in the world such as orders released or jobs run); otherwise **two-way**.
   - Blast radius: grep the callers of every changed exported function, and every other reader and writer of each changed table, entity or cache key, and list them.
   Done when the tier names the file that set it and the door names its reason.
3. **Reviews.** The tier picks the reviewers (table below). Each reviewer runs one review per axis, as separate runs with separate briefs, and the findings stay apart:
   - **Standards**: the repo's rules (AGENTS.md, CLAUDE.md, the review rubric its CLAUDE.md names), bugs, security, error handling, data loss.
   - **Spec**: the raw ticket and screenshots against the diff: everything asked is done, every symptom the reporter saw is gone, nothing beyond the ticket was added.
   Every reviewer gets the same brief (diff, ticket, existing review comments to skip) and none sees another reviewer's findings. Depth by tier. High: full diff, and the reviewer runs the tests itself; when they cannot run without installing, it says so, runs targeted probes instead (a script against the changed function), names the tests that cover the change, and missing tests for the change are a P1. Medium: the diff plus one test showing the new behaviour. Low: a quick read, still recorded. High, and any fix in an app that talks to an API, also answers the P0 / Proof questions below.
   Each review returns findings as JSON: `[{ "axis": "standards", "severity": "P0", "confidence": 90, "title": "...", "evidence": "file:line and what it shows" }]`. P0 blocks (wrong behaviour, security, data loss), P1 should be fixed, P2 is a note; confidence is 0-100 after checking the code. Done when every reviewer in the row returned both arrays, or the report names the reviewer that could not run and its error.
4. **Safety fact.** Name the one fact that makes the change safe to merge ("every caller passes a saved id", "the migration only adds a column") and prove it with a command run here (test, grep, query) and its output. When no fact covers the whole change, give the strongest partial one marked partial; nothing provable: say so.
5. **Check the findings.** Open the file:line of every P0 and P1 and confirm the code says what the finding claims; drop each P0 or P1 whose code does not, and report how many were dropped. P2s go to the report unchecked. One review per HEAD: a new review only after the diff changes.
6. **Report.** Head lines, then Standards findings and Spec findings (every P0 whatever its confidence, and P1 at 70+), then below-threshold findings (the rest). Confidence is shown next to each finding, never used to hide a P0: in trials the real bug often came back as a P0 at 55 to 70. Each finding names the reviewers that raised it; one raised by two vendors goes first:
   ```
   Tier: High (src/modules/order/form/pricing/x.ts)   Door: two-way (a revert restores it)
   Safety fact: <fact>, proof: <command> -> <output>
   Human: <row from the table below>
   Writer: <model or person>   Reviewers: <each model that ran, swaps named>
   ```

## Reviewers by tier

The roster names the models per tier and the command that runs each. It comes from the caller's explicit instruction, else the project's REVIEW.md ("Reviewers"), else the roster file the user's CLAUDE.md points to, else this default:

| Tier | Reviewers |
| --- | --- |
| Low, Medium | one fresh-context subagent |
| High | a fresh-context subagent, plus a model from another vendor when one is installed (`codex`, `gemini`, `grok`, `cursor-agent` on PATH), run read-only |

- A reviewer is never the context that wrote or drove the change: a fresh subagent or another CLI, pointed at a brief file in the scratchpad.
- At least one reviewer's vendor differs from every writer of the diff whenever such a model is available; when none is, the report says "same-vendor review".
- A reviewer that cannot run (quota, payment error, timeout) is replaced by the next one in the roster from another vendor than the writer. The report names the swap and the error.
- Run the reviewers in parallel unless the roster says otherwise.

## P0 / Proof questions (High tier, and any fix in an app that talks to an API)

Each answered with file:line, or "none found":
- Where else does the patched pattern live (callers and copies)?
- What happens when the API sends sentinel values (placeholder dates, zero coordinates, 0 or null meaning "none")?
- What state is left when the request fails midway (client form and store, partial commits, cache entries)?
- Code that reads a feature flag or config setting: does the PR show the behaviour per flag value (the `flag-matrix` skill's table), with the cell the change fixes red on the base, or for a new flag, the head with the flag off matching the base?

## Human level

| Change | What the human does |
| --- | --- |
| Low, two-way door | reads the report |
| Medium, two-way door | reads the report and the one test |
| High, a one-way door, no safety fact, or a P0 still open | reads the full diff and watches the film (UI) or runs the repro |

Approving, requesting changes and merging stay with the human at every level.

## Where the result goes

- **Someone else's PR**: the report in chat, plus a draft GitHub review (summary and inline comments on file:line) saved in the scratchpad. It is posted as a `COMMENT` review only after the user's ok. The code stays untouched: review means review only.
- **Own branch or own PR** (your own change, or `@review` on a PR the user opened): a P0 that held at step 5 starts a fix round; the rest goes into the PR body. At most 3 rounds per approach: after the third without "no P0", change the approach, not the patch. A fix round makes the review stale, so it reruns on the delta. When the setup has a round recorder (the user's CLAUDE.md names it), record each round there. The report goes into the PR body under "P0 / Proof", "none found" included.
