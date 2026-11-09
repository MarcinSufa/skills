# Composer 2.5 contract (GitHub App + API, paste-back as fallback)

Read this before dispatching or expecting a Composer 2.5 leg (Cursor GitHub App, Background
Agents API, or manual paste-back).

- **PR reviews:** the Cursor GitHub App auto-reviews pushes on enrolled repos as `cursor[bot]`
  (subscription-absorbed). Treat its review like Copilot's: one more leg to adjudicate. If it
  hasn't reviewed within ~5 min of a push, don't block on it.
- **Pre-PR / headless dispatch:** when `CURSOR_API_KEY` is set, use the Cursor Background Agents
  API (usage-billed; mention cost when proposing it for large batches). No key set → **manual
  paste-back**: generate the fenced prompt (reuse a spec-review prompt generator where you have
  one), hand it to the operator, treat the reply as one more review leg.
- Headless CLI depends on the machine. Windows: no headless `cursor-agent` CLI (verified), so
  the API/App are the only automated routes there. Linux: `cursor-agent` can be installed (`cursor-agent --version` 2026.10.22-27dcf5f; `-p/--print`, `--output-format`,
  `--model`, `--sandbox`), but this contract does not route Composer legs through it; adding
  that route is a routing decision for the operator, not something to try mid-slice.
- Do **not** claim a Composer leg ran unless the App posted a review, the API returned a result,
  or the operator pasted a reply back.
