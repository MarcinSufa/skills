# Codex (GPT Luna / Sol) worker contract

Read this before dispatching a Luna or Sol leg (`codex exec`), for either implementation or review.

- Model: **always pass `-m` explicitly** with the Luna id for execute/check legs and the Sol id
  for decision-grade legs, both taken from the routing table. `~/.codex/config.toml` is GLOBAL and
  its default can change under you; never rely on a bare `codex exec`. Subscription auth (ChatGPT
  login) only, **never set `OPENAI_API_KEY`**. If a model id errors, report to the operator instead
  of silently falling back.
- Dispatch headless: `codex exec -m <model> "<prompt>" < /dev/null` with cwd = the task/slice worktree.
  **Stdin MUST be closed** or the run hangs on "Reading additional input from stdin...".
  **Never spawn codex from an Electron main process or any long-lived app**: native spawn
  crashes have been seen there; shell only.
- Feed it the same task-brief file the SDD workers use. Capture BOTH: the verdict with
  `--output-last-message .conduct/<vendor>-<slice>.md` (read it whole) AND the event stream with
  `--json > .conduct/<vendor>-<slice>.jsonl` (never read it as the verdict; conduct-events parses
  it for usage, program 2 for spans). Both flags together are verified on codex 0.144 (still listed
  in `codex exec --help` on 0.159.2).
- **Luna per-token API route (opt-in variant; the profile is not on every machine, so check it
  exists first):** Luna is cheap enough
  to run per-token; Sol deliberately stays subscription-only. Dispatch:
  `codex exec -p luna-api -c model_reasoning_effort=high --skip-git-repo-check --sandbox read-only
  --output-last-message .conduct/luna-<slice>.md "<prompt>" < /dev/null`. The profile
  (`~/.codex/luna-api.config.toml`, layered via `-p`) bills against user env var
  `OPENAI_PLATFORM_KEY` - deliberately NOT `OPENAI_API_KEY`, so the base config stays on ChatGPT
  subscription auth. `-p luna-api` must be passed on EVERY invocation; without it the dispatch
  silently rides the subscription instead of the per-token key. The profile pins its own `model =`
  line, separate from the global config, so a model bump must update both (per-token GPT-6 Luna
  verified 2026-09-23): check it against the routing table and record the id the leg actually ran. Effort selectable
  via `-c model_reasoning_effort=low|medium|high` - the whole reason this route exists.
  `--skip-git-repo-check` required outside a trusted git repo. Use this route when the ChatGPT
  subscription is rate-limited or when a leg needs a specific effort tier; also the escape valve
  when the subscription usage cap is hit mid-program.
- **Running vitest inside the Windows sandbox (verified 2026-09-25, codex 0.155.1, vitest 4.0.18 /
  vite 7.3.1; still true 2026-10-26 on codex 0.162.1, where the run hangs after the error instead
  of exiting):** under `-s workspace-write` with `[windows] sandbox = "unelevated"`, every spawn
  with stdio pipes fails `spawn EPERM` (esbuild service, vite's `net use` probe, vitest fork pool);
  `network_access=true` does not help, and `elevated` fails its ACL refresh without admin. The fix is a
  vitest wrapper script of your own (not shipped with this skill): tell the leg to run
  `node <your-wrapper>/vitest.mjs run <filter>` from the package dir instead of `npx vitest`. The
  wrapper swaps esbuild for in-process esbuild-wasm, turns the sync
  `net use` throw into a callback error, and adds `--pool=threads --configLoader runner`. Proof: Luna
  reported the same `13 failed | 67 passed (80)` as an unsandboxed run, identical failing tests.
  Put the same rule in `~/.codex/AGENTS.md` so a Luna leg finds the wrapper unprompted (verified
  on a web app repo, jsdom + react plugin, `180 passed (180)` same as unsandboxed). Do not write "your
  sandbox cannot run vitest" into briefs any more. Configs using `__dirname` get cwd, so run from
  the directory holding the vitest config. Limits: `build`-based paths (plugins needing fs, dep optimizer) and pool forks still cannot run;
  esbuild-wasm is pinned to 0.27.3, so bump it in that folder if a repo's vite ships another esbuild.
  Windows only: on a Linux host (codex 0.156.1) plain `vitest run` passes inside
  `codex sandbox -P :workspace` with the default fork pool, so legs there need no wrapper.
- Trusted for implementation legs, not just review (its adversarial review once found 4 FATAL +
  6 MAJOR findings that three Claude legs missed).
- Its findings come back as **text for you to adjudicate**: one review leg, not gospel.
- Any **code** codex writes gets the same per-task review as a Claude worker's code.
