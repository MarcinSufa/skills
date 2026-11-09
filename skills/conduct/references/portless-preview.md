# Portless preview (per-worktree dev servers)

Read this before starting a dev server in a worktree while other worktrees of the same repo may
already be running one.

When several worktrees of one repo run dev servers at once, ports collide (3000/3100) and
nobody knows which URL belongs to which branch. Route previews through portless, pinned via
npx with zero package.json changes: the wrapper
`${CLAUDE_SKILL_DIR}/scripts/portless-preview.mjs` wraps
`PORTLESS_HTTPS=0 npx -y portless@0.15.5 run <dev command>` and forwards any extra flags untouched.
Invoke it as: `node "${CLAUDE_SKILL_DIR}/scripts/portless-preview.mjs" <dev command>`.
Portless binds a random free port from the 4000-4999 pool and names a per-branch
subdomain; the wrapper then prints ONE grepable line carrying both addresses:

    PORTLESS_PREVIEW browser=http://<branch>.<app>.localhost node=http://127.0.0.1:<port>

Two-address contract; this OVERRIDES the portless banner. The banner claims the subdomain
"(auto-resolves to 127.0.0.1)" with no OS caveat. On Windows that holds only for browsers
and curl >= 7.85; the OS resolver gives Node and Python ENOTFOUND on `*.localhost`. So the
`.localhost` URL is for a human in a browser ONLY; Node, Playwright and every script MUST
use the literal `http://127.0.0.1:<port>` from the line above. If the line never appears,
the wrapper prints `PORTLESS_PREVIEW banner-incomplete` (child died or banner unparsed) or
`PORTLESS_PREVIEW preflight-failed` (Node below 24) on stderr and exits nonzero.

Known side effect: `portless run` auto-starts a detached proxy daemon if none is running.
That daemon survives the dev server, the wrapper and the whole session; with `PORTLESS_HTTPS=0` it
listens on port 80. Stop it with `portless proxy stop`. By default portless also syncs
`*.localhost` entries into the OS `hosts` file (it succeeds in an elevated terminal); set
`PORTLESS_SYNC_HOSTS=0` to forbid touching `hosts`. Nothing starts at import time, but
running the wrapper starts the dev server AND, when absent, that proxy daemon; do so only
on an explicit operator or briefed-worker instruction. If portless misbehaves, diagnose
with `npx -y portless@0.15.5 doctor` before killing processes or editing routes.
