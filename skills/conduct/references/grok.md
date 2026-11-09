# Grok (xAI) reviewer contract (first validated live 2026-07-09 on grok-4.5; the id to dispatch is in the routing table)

Read this before dispatching a Grok or DeepSeek leg (headless `grok`), for either implementation
or review. Covers the DeepSeek Flash overflow route and the token-diet recipe.

- Binary: Linux/macOS `~/.grok/bin/grok`, normally on PATH (check `command -v grok`; else call
  `"$HOME/.grok/bin/grok"`). Windows: `~/.grok/bin/grok.exe`, NOT on the tool-shell PATH there;
  call it by full path (`& "$env:USERPROFILE\.grok\bin\grok.exe"`). Commands below say `grok`.
  Auth = Grok Build subscription OAuth (`~/.grok/auth.json`); do NOT set `XAI_API_KEY`.
- Dispatch a headless review: write the brief to a file (avoids quoting pain), then
  `--prompt-file <brief> --cwd <worktree> --sandbox read-only
  --disallowed-tools "search_replace,write_to_file,run_terminal_cmd,Agent" --max-turns 20
  --output-format streaming-json`, stdout captured to `.conduct/grok-<slice>.jsonl`; the
  conductor reads the verdict from the last `assistant` line of that file (one `node -e` filter),
  never from the raw stream.
- **Implementation dispatch:** `--permission-mode bypassPermissions` (standing decision; confine
  to a disposable worktree), NO `--sandbox read-only`, do NOT disallow
  `run_terminal_cmd` (the worker must run the gate). GOTCHA: `--permission-mode acceptEdits` is
  parsed but NOT enforced headless (grok docs 22-permissions "wiring note"): edits silently no-op;
  only `bypassPermissions` takes effect via the flag. Always smoke-test writes landed (check
  `git status` after the run: a run can exit 0 having written nothing). Raise `--max-turns` (~60)
  for multi-task briefs. No `--best-of-n` flag in grok 1.0.46 (rejected with exit 2;
  checked 2026-10-29). Best-of-N is session-only via built-in `best-of-n` skill /
  `best-of-n-runner` subagent, untested from conduct; do not rely on it in dispatch.
  In a Claude Code session under auto mode, the permission classifier can deny the
  `bypassPermissions` dispatch itself (seen once: denied before any spend). That is a
  casting event, not a failure of the slice: recast the leg to another implementer, and record the
  swap and its reason in the ledger's `vendor swaps` column.
- **Token diet: DEFAULT for every grok-harness dispatch** (revised 2026-09-11; first-turn
  prompt_tokens 29,240 → 15,157 = −48%, n=2, DeepSeek Flash). Do NOT redirect `USERPROFILE`/`HOME`: grok has documented compat switches with highest precedence
  (`~/.grok/docs/user-guide/05-configuration.md`, Harness Compatibility), and `[skills] ignore`
  loads only from `GROK_HOME/config.toml`:

  ```
  GROK_CLAUDE_SKILLS_ENABLED=false GROK_CLAUDE_AGENTS_ENABLED=false GROK_CLAUDE_MCPS_ENABLED=false \
  GROK_CLAUDE_HOOKS_ENABLED=false  GROK_CLAUDE_RULES_ENABLED=false \
  GROK_CURSOR_SKILLS_ENABLED=false GROK_CURSOR_AGENTS_ENABLED=false GROK_CURSOR_MCPS_ENABLED=false \
  GROK_CURSOR_HOOKS_ENABLED=false  GROK_CURSOR_RULES_ENABLED=false \
  GROK_HOME=<diet dir> \
    grok --prompt-file <brief> -m <model> --permission-mode bypassPermissions \
         --max-turns 80 --output-format plain
  ```

  `scripts/grok-diet.mjs` runs this recipe; custom model ids copy their `[model.<id>]` block from
  `~/.grok/config.toml`, while built-in Grok ids run without a model block (built-in ids usually
  have no block there).
  `<diet dir>` is a throwaway holding a copy of `~/.grok/auth.json`, `~/.grok/models_cache.json`
  and a `config.toml` with ONLY the `[model.<id>]` block the leg needs plus
  `[skills]\nignore = ["~/.agents/skills", "~/.claude/skills", "~/.claude/plugins"]`. Switches
  alone = −20%; slim home alone = −7%; switches + slim home + ignore list = −48%. Home vars stay
  real, so git identity, pnpm store and Git Credential Manager are untouched (the old
  `USERPROFILE` recipe broke commits with "Author identity unknown"). Usage log lands in
  `<diet dir>/logs/unified.jsonl`, read it from there. An automated loop runner should apply this
  by default; this recipe is for hand-dispatched conduct legs.
  `[plugins] enabled=false` is not a valid key, grok refuses to start.
- **`--reasoning-effort low` does nothing on a real task** (measured 2026-09-09): reasoning stayed
  at 77% of output against a 76% baseline. A single-question A/B showed −47% and did not survive
  contact with a multi-turn task. Do not budget for it. Token hygiene's effort-tier item (see
  references/token-hygiene.md) still holds for codex profiles; this is a DeepSeek-through-grok
  finding only.
- Brief it evidence-heavy (live logs, transcripts, repro timings): its first review run challenged
  the SPEC against live evidence where the Claude legs verified spec compliance; that's its niche.
- Its findings are one leg for you to adjudicate, not gospel. Any **code** Grok writes gets the
  same per-task review as a Claude worker's code (see the skill's Cross-vendor independence rule:
  Grok must not review its own implementation).
- **DeepSeek Flash 4.1 rides the Grok CLI harness** (verified live 2026-08-07): dispatch
  `grok -m deepseek-v4-flash --prompt-file <brief> --cwd <worktree> --sandbox read-only
  --max-turns 20 --output-format streaming-json`. Custom model in `~/.grok/config.toml`; bills per-token
  against `DEEPSEEK_API_KEY`, NOT the flat Grok Build subscription. The available reading-leg id is
  `deepseek-v4-flash`. Verify real routing in session `signals.json` via
  `primaryModelId: deepseek-v4-flash`, not a silent Grok fallback. Codex CANNOT host DeepSeek
  (codex dropped `wire_api = "chat"`; DeepSeek has no Responses API) and Luna will NOT run through
  the Grok CLI (OpenAI rejects function tools with reasoning_effort on chat/completions) - the
  pairing is fixed, don't retry it. Headless Grok has no `--prompt` flag: `--prompt-file` is
  mandatory. Judge-only legs on an existing diff: a plain `curl` to DeepSeek `/v1/chat/completions` is cheaper than the agent loop - reserve the loop for workers that must read the repo or run the gate. The `acceptEdits` no-op gotcha above applies to DeepSeek dispatches too (same harness).
  TOML gotcha: model ids containing a dot MUST be quoted in the header (`[model."gpt-5.6-x"]`);
  unquoted dots nest the table and the CLI reports "unknown model id".
