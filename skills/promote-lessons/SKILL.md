---
name: promote-lessons
description: Curator for a self-improving guardrail pipeline. Scans recent corrections and incidents, classifies each lesson (mechanically checkable: a guard-hook rule delta; procedural: a skill or CLAUDE.md delta), proposes itemized DeltaPatches, gets explicit human approval via AskUserQuestion, applies the deltas, and records each approved rule with a link to its incident. Use when asked to "promote lessons", "curate corrections", "turn incidents into rules", or as a periodic curation pass.
---

# /promote-lessons: lesson curator

Turns lessons (corrections, incidents, repeated feedback) into **enforced rules**, **improved skills** and **updated docs**: proposed by you, approved by the human, measured by tests and evals. Nothing self-applies silently.

## Setup this skill reads

Names below are placeholders; the user's global `CLAUDE.md` (or a host file it points to) says where each one lives. A source that is not configured is skipped, never invented.

| Placeholder | What it is |
|---|---|
| `<rules>` | the JSON rules file of a PreToolUse guard hook that allows, asks or denies tool calls by glob or regex |
| `<rules-test>` | that hook's test file |
| `<guard>` | the hook script itself, which reads one tool-call JSON on stdin |
| `<block-log>` | the hook's JSONL log of fired rules |
| `<lesson-queue>` | a JSONL queue a Stop hook appends correction signals to |
| `<summaries>` | per-session summaries with a `## Rules` section, if your setup writes them |
| memory store | a memory tool (MCP or files) holding corrections and feedback, if any |

## Pipeline targets

| Lesson kind | Delta target |
|---|---|
| Mechanically checkable, global (bad command pattern, secret access) | `<rules>` |
| Mechanically checkable, repo-specific (protected paths) | the repo's own guard rules file, via a normal PR (repo workflow rules apply) |
| Procedural or judgment-based | the relevant `SKILL.md`, `CLAUDE.md`, or memory feedback file |

## Workflow

### 1. SCAN
Gather candidate lessons from these sources since the last curation pass:

**a. Lesson queue, read FIRST.** `<lesson-queue>` holds one candidate per line:
`{ts, sessionId, signal, snippet, confidence, status}`. Take entries with `status: "pending"`:
correction signals caught in real sessions, the freshest input. Parse line by line; skip malformed
lines, never abort on one. An absent file means no queued lessons; continue with b, c and d.

**b. Memory store.** Search for corrections, then skills, then recent feedback-flavored facts
(queries like "never", "always", "burned", "incident", "don't").

**c. Block log** `<block-log>`. It records that a rule *fired* (`{ts, tool, decision, ruleId,
target, ...}`) but **not** the human's approve or deny, so "ask, then approved" is not observable.
Real signals: a **`deny` on a benign-looking `target`** is a false positive to loosen (for example
a `grep` with `.env.` mid-token); an incident with **no** matching entry is a possibly missing
rule (confirm by replaying it through `<guard>`).

**d. Session summaries** `<summaries>`, every one (the dedup below makes a re-scan a no-op, so no
watermark is kept). Read the bullets under `## Rules` whose source tag says the lesson is new
(from the user, observed, or from the conversation). Skip bullets that cite an existing source
(a memory, a CLAUDE.md, the system prompt): those rules are already in place. Append each new one
to `<lesson-queue>` as `{ts, sessionId, signal: "summary", snippet: <bullet>, confidence: "high",
status: "pending"}`, skipping a `sessionId` + `snippet` pair already in the queue, so the
end-of-run status marking covers them too. A summary bullet and a hook entry from the same session
that state the same lesson become one candidate.

Skip lessons already recorded (rules whose `derivedFrom` cites the incident, or memory entries
linked to it).

**End of run: mark queue entries processed.** Re-read `<lesson-queue>` immediately before writing,
set each handled entry's `status` to its disposition (`promoted`, `rejected`, `deferred`), and write
the whole file back, **keeping any `pending` entries appended meanwhile** (re-read then write keeps
the race with the append-only hook small). Handled lessons then do not resurface.

### 2. CLASSIFY
For each candidate, decide:
- **Mechanically checkable?** Can a glob on a file path or a regex on a command catch it with low false-positive risk? Then a rule delta. Tier: `deny` only for patterns with real incident history and near-zero legitimate use; otherwise `ask`.
- **Procedural?** Then a skill or doc delta (a sentence in the right SKILL.md or CLAUDE.md section beats a brittle regex). Name the target skill: a lesson about how a skill runs belongs in that SKILL.md, not in CLAUDE.md.
- **Neither, or a one-off?** Leave it where it is; note why.

### 3. PROPOSE: DeltaPatch
One DeltaPatch per lesson. **Itemized ops only, NEVER full-file rewrites** (avoids context collapse, ACE arXiv 2510.04618):

```json
{
  "reasoning": "Why this lesson, why this tier, what false positives were considered, incident evidence.",
  "ops": [
    { "op": "add_rule", "target": "<rules>",
      "rule": { "id": "...", "tier": "ask", "match": {"tool": "bash", "pattern": "..."},
                "reason": "...", "derivedFrom": "<incident id or memory id> (<incident>)" } },
    { "op": "modify_rule", "target": "<rules>", "id": "...", "set": { "match.pattern": "..." } },
    { "op": "remove_rule", "target": "<rules>", "id": "..." },
    { "op": "append_section", "target": "<SKILL.md path>", "anchor": "## <section>", "text": "..." }
  ]
}
```

### 4. APPROVE: human gate (MANDATORY)
Present each DeltaPatch via `AskUserQuestion`: one question per patch, the `reasoning` in the description, options **Apply**, **Apply with edits**, **Reject**, **Defer**. If the guard hook ask-protects its own rules file, the apply step is gated twice.

### 5. APPLY + FITNESS GATE
- Apply approved ops with `Edit` (itemized, never a file rewrite).
- **Rule deltas:** add a test case for the new rule to `<rules-test>` first, run it, AND replay the recent block log: every previously allowed benign target must still be allowed. Regression: revert the delta, report.
- **Skill deltas (keep if better):** if the target skill has an `evals.json` (binary assertions only), run each eval in a **fresh `claude -p` session** (the Skill tool pins skills to the session-start cache, so an in-session re-run tests the stale version). One change per iteration: score improves or holds, commit (if the skill is in a repo); score drops, revert. No evals.json: apply, but flag the skill as eval-less in the report.
- **Repo deltas:** open a normal PR (worktree off the default branch, cross-model review, the human merges). Never push to the default branch.

`evals.json` shape (next to the skill). **Assert types are `output_contains` and `file_exists`
ONLY, never `command_succeeds`** (it would run an arbitrary string, remote code execution if
`evals.json` content is ever influenced):
```json
{ "evals": [ { "id": "...", "prompt": "...", "assert": { "type": "output_contains|file_exists", "value": "..." } } ] }
```

### 6. RECORD
If a memory store is configured, write each applied rule to it as a constraint: the rule, tier and reason, linked to its incident. This closes the loop: incident, rule, enforcement, durable memory.

### 7. REPORT
Lessons scanned, classified, proposed, approved, applied, recorded; eval scores before and after; block-log tuning notes (false-positive fires and the proposed loosening; uncaught incidents and the proposed new rules).

## Hard constraints
- **Never** apply a delta without the AskUserQuestion approval (step 4).
- **Never** rewrite a rules file wholesale: ops only.
- **Never** read secret files while testing rules: pipe simulated tool-call JSON into `<guard>` instead.
- One change per fitness iteration; revert on regression.
