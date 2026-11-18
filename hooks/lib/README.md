# Prompt-source guard

`is-real-user-prompt.mjs` answers one question for a prompt hook: did a person type this prompt?

Claude Code fires `UserPromptSubmit` (command, http and mcp_tool hooks) and the mod event `prompt.submit` for more
than typed prompts: Code Mode code output and Poll, scheduled tasks, `/loop` wakeups, background subagent reports,
peer and channel messages. A hook that stores, embeds or answers prompts must not treat those as user input.

## API

- `classifyPromptSource(input)` returns `"user"`, `"non-user"` or `"unknown"`.
- `isRealUserPrompt(input)` is true only for `"user"`.
- `shouldSkipPrompt(input)` is true for `"non-user"` and `"unknown"`.

Input may be the command-hook payload (`{ prompt, source, hook_event_name }`) or the mod event
(`{ text, origin: { kind }, isMeta, source }`). Every signal present must say user:

| Signal | user | non-user | anything else |
|---|---|---|---|
| `source` | `user` | `poll_event`, `sdk`, `system`, `loop_wakeup`, `schedule_wakeup` | unknown |
| `origin.kind` | `composer`, `bridge` | `sdk`, `task-notification`, `peer` and the other injected kinds; `handback: true` | unknown (`unclassified`) |
| `isMeta: true` | | non-user | |

Prompt text is never inspected.

## Rules for callers

- Use the verdict only to skip side effects (ingest, memory lookup, labels, context injection). Never block or drop
  the prompt because of it: a blocking `UserPromptSubmit` verdict rejects a Code Mode poll event.
- Omitted `source` is unknown and skipped. Claude Code 2.1.327 omits `source` on typed prompts as well (only the
  poll path sets `poll_event`), so a command hook using this guard ingests nothing until Claude Code sends
  `source: "user"`. Missing an ingest is the accepted cost; ingesting code output is not.
- Apply it only to Claude Code payloads. Other agents (Codex, Cursor) have no `source` field.

## Vendoring

Copy the file instead of depending on this repo at runtime. Put a first-line comment naming this path and the
sha256 of the copied version, and port only the export syntax (CommonJS or TypeScript) if the target needs it.
