# Prompt-source guard

`is-real-user-prompt.mjs` answers one question for a prompt hook: did a person type this prompt?

Claude Code fires `UserPromptSubmit` (command, http and mcp_tool hooks) and the mod event `prompt.submit` for more
than typed prompts: Code Mode code output and Poll, scheduled tasks, `/loop` wakeups, background subagent reports,
peer and channel messages. A hook that stores, embeds or answers prompts must not treat those as user input.

## API (v2, fail-open)

- `classifyPromptSource(input)` returns `"user"`, `"non-user"` or `"unknown"`.
- `isRealUserPrompt(input)` is true for `"user"` and `"unknown"`.
- `shouldSkipPrompt(input)` is true only for `"non-user"`.

Input may be the command-hook payload (`{ prompt, source, hook_event_name }`) or the mod event
(`{ text, origin: { kind }, isMeta, source }`). Only an explicit non-user signal skips; any one of them wins:

| Signal | user | non-user (skip) | anything else |
|---|---|---|---|
| `source` | `user` | `poll_event`, `sdk`, `system`, `loop_wakeup`, `schedule_wakeup` | unknown, ingested (omitted, other strings, non-strings) |
| `origin.kind` | `composer`, `bridge` | every other non-empty kind (`sdk`, `task-notification`, `peer`, `unclassified`, ...) | unknown, ingested (no origin, no kind) |
| `isMeta: true` | | non-user | |

A non-object input (missing payload, array, string) is unknown and ingested. Prompt text is never inspected.

## Rules for callers

- Use the verdict only to skip side effects (ingest, memory lookup, labels, context injection). Never block or drop
  the prompt because of it: a blocking `UserPromptSubmit` verdict rejects a Code Mode poll event.
- Omitted `source` counts as user. Claude Code 2.1.327 omits `source` on typed prompts (only the poll path sets
  `poll_event`), so failing closed would stop all prompt ingest. v1 failed closed; v2 (2026-11-18) fails open.
- Apply it only where the payload can carry these fields. Other agents (Codex, Cursor) have no `source` field and
  are ingested either way.

## Vendoring

Copy the file instead of depending on this repo at runtime. Put a first-line comment naming this path and the
sha256 of the copied version, and port only the export syntax (CommonJS or TypeScript) if the target needs it.
