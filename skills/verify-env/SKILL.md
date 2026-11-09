---
name: verify-env
description: Read-only doctor for the host and session an agent runs in - node/npm/pnpm/git/gh/codex/claude on PATH with versions, gh auth state, a shim ahead of the real tool on PATH, free disk, free ports, Playwright Chromium and its sandbox. Core checks plus a per-repo `.verify-env.json` with per-host entries; table or `--json`; exit 0 ok, 1 fail, 2 warnings. Use before a long run, test suite or E2E session on a new host or account, when a command fails with ENOENT or "not found", or when tests pass in CI but not locally.
---

# verify-env

Answers "can this session run the work" before the work starts, so a missing tool shows up as one line instead of a failed test run to untangle. It only reads: it installs nothing, writes nothing, kills nothing and makes no network calls of its own (`gh auth status` does).

## Run

```
node ~/.claude/skills/verify-env/scripts/verify-env.mjs            # table
node ~/.claude/skills/verify-env/scripts/verify-env.mjs --json     # {exit, checks:[{id,status,detail}]}
node ~/.claude/skills/verify-env/scripts/verify-env.mjs --profile path/to/profile.json --host <name>
```

Exit: `0` all ok, `1` at least one check failed, `2` only warnings, `3` bad arguments or unreadable profile.

## When it reports something

- `FAIL`: the run will break. Fix it or tell the user before starting; do not start a long job and read the error later.
- `WARN`: the run may differ from CI or another host. Note it in the report next to any failure it explains (for example a test that spawns `npm` when `tool:npm` warned).
- Never fix by installing a tool or editing PATH or shell profiles yourself. Report the line and the suggested fix to the user.

## Checks

| id | ok when | missing / wrong |
| --- | --- | --- |
| `tool:<name>` | on PATH, `--version` exits 0, version meets `versions` | `require`: FAIL, `optional`: WARN |
| `gh-auth` | `gh auth status` exits 0 (output is never printed) | FAIL; WARN if no gh |
| `path:<name>` | `<name>` resolves to the `pathFirst` directory | WARN |
| `disk` | free space in home >= `minDiskMb` | FAIL |
| `port:<n>` | nothing listens on 127.0.0.1:n | WARN |
| `chromium` | a `chromium*` build in the Playwright browsers dir | FAIL |
| `chromium-sandbox` (Linux) | AppArmor does not restrict unprivileged user namespaces | WARN (Chromium needs `--no-sandbox`) |

## Profile

Without a profile only the core runs: `require` node, git; `optional` npm, pnpm, gh, codex, claude; `gh-auth`; `disk` 1024 MB. A repo adds `.verify-env.json` at its root (read from the current directory, or pass `--profile`):

```json
{
  "require": ["pnpm"],
  "versions": { "node": ">=20" },
  "ports": [5003],
  "chromium": true,
  "minDiskMb": 2048,
  "hosts": {
    "build-server": { "pathFirst": { "gh": "~/.claude/home/bin" } }
  }
}
```

Example, a profile for a server account (gh shim from this repo, Playwright E2E runs):

```json
{
  "versions": { "node": ">=20" },
  "pathFirst": { "gh": "~/.claude/home/bin" },
  "chromium": true,
  "minDiskMb": 2048
}
```

There it flagged three host traps before any test ran: `tool:npm` missing from the session PATH, `path:gh` resolving to the real gh instead of the shim, and `chromium-sandbox` (AppArmor userns restriction).

`require`, `optional`, `versions` and `pathFirst` merge with the core (a tool in `require` leaves `optional`); other keys replace it. The `hosts` entry whose key equals `--host` (default: the machine's hostname) is merged last. Project-specific E2E checks (who owns the dev port, auth state age, API DNS) do not belong here; they stay in the project's own doctor.

## Known limits

- A tool that does not answer in 10 s is killed with the children it started (process group on Linux and macOS, `taskkill /T /F` on Windows) and reported as exit 127. Windows (`.cmd`/`.bat` through `cmd.exe /d /s /c`, `taskkill`) is checked with fakes only, not on a live host.
- `port:<n>` binds 127.0.0.1:n for a moment (IPv4 only, no owner); a bind error other than "in use" is a WARN with its code.
- `chromium` sees a `chromium*` entry, not a working browser; `PLAYWRIGHT_BROWSERS_PATH=0` (browsers in the project) is a WARN, not checked.

## Tests

`node --test test/*.test.mjs` from this directory. Checks take their OS access through a `deps` object, so the unit tests fake Linux and Windows hosts; one test runs the CLI against fake commands on PATH (skipped on Windows).
