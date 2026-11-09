---
name: worktree
description: Use before the first file edit of a substantive task (feature slice, bug fix, spec/plan work, anything ending in a commit) in a shared checkout. Creates an isolated git worktree, says how to work in it from the launch dir, and when to keep or remove it.
---

# Worktree isolation

Shared checkout: in-place edits clobber other sessions' branch, stash, dev server. Before the first file edit of a substantive task (feature slice, bug fix, spec/plan work, anything ending in a commit):
1. `git worktree add "<tree>" -b <branch> origin/HEAD` (the remote default branch) unless told otherwise, where `<tree>` = `<worktree-root>/<slug>` (`<worktree-root>`: host file).
2. Work in `<tree>` from the launch dir: Read, Edit, Write, Grep and Glob always get an absolute path inside `<tree>`; every shell command starts with `cd "<tree>" &&` (tests, package scripts and builds run from cwd, so this prefix is what keeps them off the shared checkout). If `<tree>` belongs to a different repo than the launch dir, read its `CLAUDE.md` first, since the session loaded only the launch dir's; its `.claude/settings` hooks don't run either, so if that repo depends on them, stop and ask for a session launched in `<tree>`. Why not `EnterWorktree`: entering any path outside the repo's `.claude/worktrees/` always asks for approval (no allow rule suppresses it), and an unattended session waits on that prompt for hours (once 42 h on a server). Its `name` form puts trees under `.claude/worktrees/` (broke a gitlink; vitest/eslint glob into copies).
3. Commit and push from `<tree>`. `git worktree remove "<tree>"` once pushed and the PR is merged, closed or abandoned; keep it only while the PR is open or work is unfinished, and say so in the final answer.
4. Don't rely on step 3 to clean up (dead sessions never finish it); pruning is per host (host file `~/.claude/home/hosts/<host>.md`).
5. exoloop creates its own trees (no step 1), and step 2 applies with `<tree>` = `<tmpdir>/exoloop-worktrees/<repo>-<hash>/<planId>/<taskId>`, override `EXOLOOP_WORKTREE_ROOT`; prune scans it.
- A worktree is ~600 MB (2026-09-02: 173 trees froze the machine): never leave `node_modules` behind after the PR merges.
- File-writing subagents: `isolation: "worktree"` (Agent tool, or `opts.isolation` in Workflow). One writer per tree.
- Exempt: conversational, read-only investigation, review-only, trivial single-file edit asked in place. Unsure: ask.
- Fresh tree lacks gitignored config (env files, Playwright storageState, app config such as `public/config/app.json`): copy from main checkout before app/e2e.
