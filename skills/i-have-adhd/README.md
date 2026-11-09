# i-have-adhd

**Shapes the agent's answers for a reader with ADHD: the next action first, numbered steps, state restated every turn, concrete time estimates, visible wins, no preamble or closing pleasantries.**

> Based on [ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd) by Ayoub Ghriss, MIT licence. This copy is an earlier version of upstream's `skills/i-have-adhd/SKILL.md` (closest upstream commit `9370202`) with two local changes: the description also tells the agent to apply it on its own before any long final answer, and `disable-model-invocation: true` is removed so the agent can load it unprompted. Upstream has since added persistence rules, a task-tool rule and more overrides; check it before copying this one.

```
/i-have-adhd          # on for the rest of the session
stop adhd mode        # off
```

| | |
| --- | --- |
| **Fires** | on `/i-have-adhd`, and (local change) before any final answer of about 10+ lines after research, investigation or a work task |
| **Does** | applies 10 output rules and a pre-send check to every answer |
| **Breaks its own rules** | when you ask to "explain" or "walk me through", before a destructive action, in a debug spiral, and when the request is ambiguous |
| **Never** | changes what the agent does, only how the answer reads |

## Why

Working memory is small, starting is the hardest step, vague time estimates all feel the same, and buried wins do not register. A short answer is not enough: it has to be shaped so the reader can act on the first line.

## The rules

| # | Rule | Example of good output |
| --- | --- | --- |
| 1 | Lead with the next action | "Run `npm install jsonwebtoken`, then edit `src/auth.ts:42`." |
| 2 | Number multi-step tasks | one bounded action per step |
| 3 | End with one concrete next action | "Next: run `npm test` and paste the first failing line." |
| 4 | Suppress tangents | finish the first issue, offer the second as a question |
| 5 | Restate state every turn | "Step 3 of 5 done: schema updated. Next: backfill." |
| 6 | Specific time estimates | "About 15 minutes if tests cover this. An afternoon if not." |
| 7 | Make completed work visible | "Login now works with magic links. Try: ..." |
| 8 | Matter-of-fact errors | cause and fix, no "uh oh" |
| 9 | Cap lists at 5 | split into "do now" and "later" |
| 10 | No preamble, recap or closer | start with the answer, end when it is done |

Before sending, the agent deletes an announcing first sentence, an "anything else?" last sentence, "by the way" sidebars and empty hedges, then checks that the first and last lines alone say what happened and what to do next.

## Install

The upstream repo has installers for Claude Code and other agents: see its [README](https://github.com/ayghri/i-have-adhd#readme). To copy this version:

```bash
git clone https://github.com/MarcinSufa/skills
cp -r skills/skills/i-have-adhd ~/.claude/skills/
```

## Files

| File | For |
| --- | --- |
| [`SKILL.md`](SKILL.md) | the agent: the rules, the overrides and the pre-send check |
| `README.md` | you |
