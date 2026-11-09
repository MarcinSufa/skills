# Per-repo grounding: gotchas and setup

`/conduct` is repo-agnostic. When reading the repo's CLAUDE.md and any active handoff (Loop step 1,
every slice start), never assume defaults hold, e.g. a machine's Node may be off PATH, a repo's
build may skip type-checking (run the explicit typecheck), and the operator may hold sole merge
authority (no autopilot merge loop).

When several worktrees of this repo run dev servers at once, read references/portless-preview.md
before starting one.

Event hooks: install once per machine from the junction path, never from a worktree:
`node "${CLAUDE_SKILL_DIR}/scripts/install-hooks.mjs" --settings ~/.claude/settings.json --scripts-dir "${CLAUDE_SKILL_DIR}/scripts"`, then restart Claude Code. `--uninstall` reverses it.
