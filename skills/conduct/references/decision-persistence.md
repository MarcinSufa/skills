# Decision persistence (optional, off unless the environment binds it)

Read before the opinion stage (query) and at fusion (write) when a memory sink is bound (see the
environment's conduct-binding skill, when present).

`.conduct/` dies with the worktree. The **Decision** section of a fusion doc is the one artifact worth
outliving the slice: it is the thing a future session would otherwise re-litigate from scratch.

This skill does **not** name a memory system. If (and only if) the environment binds a durable
memory sink (a memory MCP server, a project decision log, an ADR directory), the conductor writes the
Decision there at fusion time. If no sink is bound, skip this silently; `.conduct/` is enough.

**Contract for a bound sink** (whatever backs it):

| Field | Content |
|---|---|
| Question | The decision brief's question, one line. |
| Decision | The call made. |
| Inputs | Which vendors gave opinions; link/path to each `.conduct/opinion-*` file. |
| Divergence | Where the legs disagreed and how it was resolved (evidence, extra leg, spike). |
| Discarded | What was rejected and why: the part that stops a future session re-proposing it. |

Rules:
- **Write at fusion time, not at hand-off.** A slice that gets abandoned still produced a real decision.
- Persist the **Decision + Divergence + Discarded** only. Do not dump raw opinion legs into the sink;
  they belong in `.conduct/`; the sink is for what was concluded, not what was said.
- One decision per record. A slice with three decisions writes three.
- Before opening the opinion stage, **query the sink first** for a prior decision on the same
  question. A re-litigated decision is a wasted pair of opinion legs, and if you're overturning a
  prior decision, say so explicitly and supersede the old record rather than adding a contradicting one.
- Never let a sink write failure block the slice. Log it, keep the `.conduct/` copy, move on.
