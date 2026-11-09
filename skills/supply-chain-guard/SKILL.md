---
name: supply-chain-guard
description: Release cooldown for npm, pnpm, yarn, bun, uv and pip, plus a PreToolUse hook that diffs every package or editor extension a Bash command would install against the installed version, checks OSV, and has Claude review only that diff (allow / ask / block). Use when installing, upgrading or reviewing dependencies or VS Code / Cursor extensions, when the guard denied or asked about an install, or when setting the guard up on a host.
---

# supply-chain-guard

Two layers against a trojaned release, such as the `anthropic.claude-code` 2.1.312/2.1.313 builds the Cursor marketplace served on 2026-10-29.

1. **Cooldown.** Package managers skip versions younger than 7 days. Most malicious releases are pulled within hours to days.
2. **Hook.** `hooks/guard.mjs` runs before every Bash call. A command that installs nothing exits in about 30 ms with no output.

## When the guard answers

- **deny.** Do not retry through another route: a different package manager, `curl | tar`, `sh -c`, editing `node_modules`, or downloading the `.vsix` by hand. Show the user the reason verbatim and stop.
- **ask.** The user decides in the permission prompt. Do not argue for approval. Summarise the listed signals in one line each.
- **allow.** The hook adds only a one-line `systemMessage`. It never grants permission, so the normal permission rules still apply.

## What it reviews

| Command | Reviewed as |
| --- | --- |
| `npm i/add/update <pkg>`, `pnpm add/up <pkg>`, `yarn add/up <pkg>`, `bun add <pkg>`, `npx`, `pnpm dlx`, `yarn dlx`, `bunx` | npm package, old vs new tarball |
| `pip install <pkg>`, `python -m pip install`, `uv add`, `uv pip install`, `uv tool install/run`, `uvx`, `pipx install/run` | PyPI release diff using a pure wheel or sdist when needed; pip may select a different artifact, see Limits |
| `cursor`/`windsurf`/`codium --install-extension <id>[@ver]` | Open VSX build, old vs new; `codium` asks when a custom gallery is set; `code` and `code-insiders` IDs ask because they install from the Visual Studio Marketplace, which the guard does not review; local `.vsix` files are reviewed as artifacts |
| `npm update`, `pnpm up`, `uv lock -U`, `pip install -r` with no named package | ask: versions resolve fresh and cannot be diffed one by one |
| `npm install --no-package-lock`/`--package-lock=false` or `npm_config_package_lock=false`; `pnpm install --no-lockfile`/`--lockfile=false`/`--lockfile-only`/`--fix-lockfile`/`--no-frozen-lockfile`/`--no-prefer-frozen-lockfile`/`--update-checksums`/`--force` or matching `PNPM_CONFIG_*`/`npm_config_*` values; `yarn install --no-lockfile`/`--no-immutable`, `YARN_ENABLE_IMMUTABLE_INSTALLS=false` or Berry `--mode=update-lockfile`; `bun install --lockfile-only`/`--package-lock-only`/`--force`, `bun add --lockfile-only` or `BUN_CONFIG_SKIP_LOAD_LOCKFILE`; `pipenv install --skip-lock`/`--ignore-pipfile` or `PIPENV_SKIP_LOCK`/`PIPENV_IGNORE_PIPFILE`, and `pipenv update/lock` | ask: lockfile is skipped, ignored or rewritten with fresh resolution |
| `npm audit fix`, `pnpm audit --fix`, `bun audit fix`, unnamed dedupe, `yarn upgrade-interactive`, `pipx install-all/upgrade-all/reinstall-all/upgrade-shared`, `uv lock/sync --upgrade`/`--upgrade-group`, `uv pip sync/compile`, `uv build` | ask: versions resolve fresh and cannot be diffed one by one |
| `github:`, git or URL sources, `npm:` aliases | ask: not fetchable from a registry |
| `pip download/wheel <pkg>`, `npm pack/cache add/diff <pkg>`, `bun pm diff <pkg>`, targeted `pipx` or `uv` upgrades | target or bulk according to package names and lockfiles |
| `npm stage download <id>`, unpinned `npm diff`, `bun pm diff` | ask: package contents cannot be tied to a reviewable name and version |
| Registry/index flags, registry environment or config-file pointers on any `npm`/`pnpm`/`yarn`/`bun`/`npx`/`bunx`/`pip`/`uv`/`uvx`/`pipx`/`corepack` command | ask: can redirect package downloads |
| Package source config changes in npm, pip, Conda, NuGet, Poetry, Cargo, RubyGems, Bundler, Composer or Go; writes to `.condarc`, `NuGet.Config`, `.cargo/config*` or `.gemrc` | ask: changes the package registry or index config |
| Direct acquisitions through Cargo, Poetry, PDM, Hatch, RubyGems/Bundler, Go, Conda, Composer, .NET, Deno, Pixi or Rye | ask: package manager the guard does not review |
| Bun `BUN_OPTIONS`, `BUN_INSPECT_PRELOAD`, `-e`/`--eval`, `-p`/`--print`, `run -e`/`run -p`, `run -`, interactive `repl`, or module-loading options (`--preload`/`-r`, `--require`, `--import`, `--jsx-import-source`) | `BUN_OPTIONS` and `BUN_INSPECT_PRELOAD` are read; ask when inline or stdin code has a bare import/require, cannot be read statically, or a module-loading option names a bare package; `--no-install` disables it, while `-i` and `--install=auto|fallback|force` control auto-install |
| `yarn set version`, Yarn Berry `init -i/--install`, Classic `yarn policies set-version`, `pnpm self-update/with`, `pnpm runtime set`/`env use`, global npm installs of a manager, pip self-upgrade, pipx `--fetch-python=always|missing` or `interpreter upgrade`, `bun upgrade`, `uv self update`/`python install`/`python upgrade`, Corepack `use/install/prepare/up` or `<pm>@<spec>` | ask: downloads a package manager or runtime release |
| PyPI ranges other than `>=` (`<2`, `~=1.4`, `!=`) | ask: the installed version is not the latest the guard would fetch |
| Manager installs through `xargs` or GNU `parallel`, `... \| sh`, `node $(which npm) i`, unresolved `$PM add` | ask |
| `npm ci`, bare `npm/pnpm/yarn/bun install` with the default registry, `uv sync` with the default index, `pipenv install/sync`, `pnpm install --frozen-lockfile`, `yarn install --pure-lockfile`/`--immutable`, `bun install --frozen-lockfile`/`--no-save`, `uv sync --locked`/`--frozen`, local paths | pass: lockfile or the user's own code, cooldown applies; explicit bypasses such as `--no-package-lock`, `--no-lockfile`, `--lockfile-only`, `--skip-lock`, and `BUN_CONFIG_SKIP_LOAD_LOCKFILE` ask as listed above |

`pnpm_config_trust_lockfile=true` makes pnpm skip the release-age check for entries already in the lockfile; new resolutions remain checked.
Use it only on one `pnpm install --frozen-lockfile` line in the merge queue, CI, or a session worktree; never export it or use it for add, update, or bump. The guard asks otherwise, and global cooldown files stay unchanged.

Commands chained with `&&`, `;` or `|`, wrapped in `sudo`, `env`, `timeout`, `corepack` or `sh -c "..."`, inside `$(...)`, backticks, `eval`, `if/then` or `{ }`, or handed to `npx -c`, `npm exec -c`, `pnpm dlx -c`, `npx <cmd>` or `pnpm/yarn/bun exec`, are split and each part is checked. Heredoc bodies are data for `cat`, `tee`, `git` and `gh`, parsed when a shell reads them, and ask when another command's body mentions an install.
- Literal `echo` and `printf` input piped directly to a shell is parsed; expanded input and xargs/parallel shell commands ask.

## Verdict

The verdict is the stricter of the signal floor and Claude's review. Text inside a package can make the verdict stricter but never looser.

| Floor | Signals |
| --- | --- |
| block | `ssh-keys` (authorized_keys, `~/.ssh`, id_* keys), `reverse-tunnel` (`ssh -R`, `/dev/tcp`, `nc -e`), OSV `MAL-*` advisory |
| ask | `install-script` (new or changed pre/post/install/prepare), `persistence` (cron, shell rc, LaunchAgents, systemd user, autostart, Run keys), `credential-access`, `dynamic-code` (eval, new Function, vm), `obfuscation` (base64 blobs, hex runs, fromCharCode), `ip-literal`, `pth-startup-hook`, `unscannable` (a code file that is binary or over 4 MB), `fresh-release` (younger than the cooldown), a medium signal in an entry file that never had that capability (`loadTime`), any guard failure |
| Claude decides | `process-exec`, `raw-socket`, `new-endpoint`, `size-jump`, `binary-added`, `symlink`, `eager-activation`, `entry-changed`, `build-script`, non-malware OSV advisories |

A pattern counts only when the new version has more matches than the old one. A first install has no old version, so endpoints are informational there.

Claude runs as `claude -p --tools "" --strict-mcp-config --setting-sources local` from an empty temp dir. It sees the signals, OSV results and up to 60 000 characters of unified diff, flagged and entry files first. Verdicts are cached for 30 days per `ecosystem|name|old|new|artifact hash|model` in `~/.cache/supply-chain-guard/verdicts/`, except while the release is inside the cooldown. A cached verdict is still checked against OSV, so a malware advisory published later blocks. Every non-pass decision is appended to `~/.cache/supply-chain-guard/log.jsonl`.

Fail-safe: a registry, OSV or Claude error, a timeout past `SCG_BUDGET_MS`, unparseable input, a zip64 or encrypted archive, or a hash mismatch all produce ask, never a silent allow. Register the hook with `"onFailure": "block"` (Claude Code 2.1.295 or later) so a crash or a killed hook blocks too.

## Limits

- Config file contents are not read, so an existing `trustLockfile: true` or lower `minimumReleaseAge` in `pnpm-workspace.yaml` or pnpm's global `config.yaml` is not seen. Files read by `source`/`.` (or dot-sourced PowerShell scripts) are not read either, so a variable set there is not seen. Changes made with Claude's Edit/Write tools are also not seen; commands that write these settings ask. Git hooks, Git config helpers and package scripts are not read, just like config file contents.
- Code held in inherited environment variables is not inspected when the command text mentions no install.
- Only packages named in the command are diffed. A bare install without a lockfile resolves the ranges in `package.json` or `pyproject.toml`, but those packages are not named in the command, so only the cooldown applies. Transitive dependencies and lockfile installs rely on the cooldown.
- For PyPI, the guard reviews the newest release (or pinned release) as a pure wheel or sdist. pip may install an older release compatible with the running Python or a platform-specific wheel, which may differ from the review; the cooldown still applies.
- Code run from a file by an interpreter or build command (`python setup.py`, `node install.js`, `make`) is not inspected.
- The old version is read from the hook's cwd (`node_modules`, `.venv`, `VIRTUAL_ENV`), not from `--prefix`, `-g` or a later `cd`. A wrong old version widens the diff; a matching one allows with no diff, because a published registry version does not change. `npx`, `npm exec`, `pnpm exec` or `bunx` runs an already installed package from disk without a diff when its version matches the registry, because nothing is fetched; that code came through an install. A local `.vsix` is always diffed against the registry build of the installed version.
- Project and user config files are not read; Bun `run`, `install` and `add` also load project `.env` files. Registry/index flags or environment, config-file pointers and source config changes ask for any supported manager command. Read-only config references pass unless an output option is present. Directory selectors (--prefix, -C, --cwd, --dir, --directory, --project) work like cd, so the project config they reach is not read.
- An install inside an environment runner asks because it can load environment from project files; a manager reading its own config, including Bun's default env file, remains a limit.
- Unsupported direct acquisitions and Deno remote specifiers ask without a package diff; named Pipenv install/upgrade specs are diffed.
- Unsupported manager acquisitions and source-config subcommands ask; documented command runners parse the command they execute.
- Runners and builds that install declared dependencies themselves (pixi run, hatch run, cargo/go/dotnet build) are not reviewed, like lockfile installs.
- Corepack shims download the version pinned in `package.json` `packageManager` on first use without a review. pnpm may switch to the version in `packageManager` or `devEngines.packageManager` on a plain command; its default `pmOnFail: download` can be turned off with `pmOnFail: ignore` (formerly `managePackageManagerVersions: false`). Yarn Berry's `.yarnrc.yml` `yarnPath` selects a project binary for commands in that directory. pnpm can install a project runtime declared in `devEngines.runtime` or `engines.runtime`, and uv can fetch a missing Python for commands such as `uv venv` or `uvx`; project pins and available runtimes are not inspected. See [pnpm package manager pins](https://pnpm.io/package_json#packageManager), [pnpm `pmOnFail`](https://pnpm.io/settings/cli#pmOnFail), [pnpm runtimes](https://pnpm.io/package_json#devEngines.runtime), [Yarn `yarnPath`](https://yarnpkg.com/configuration/yarnrc#yarnPath), [uv Python downloads](https://docs.astral.sh/uv/guides/install-python/), and [Corepack](https://nodejs.org/download/release/v20.17.0/docs/api/corepack.html).
- Pipx's `PIPX_FETCH_PYTHON=always|missing` and deprecated `PIPX_FETCH_MISSING_PYTHON` environment settings can fetch Python for supported commands; the hook checks CLI flags but does not inspect these settings.
- Files changed with Claude's Edit or Write tools, including `package.json` overrides and `.npmrc`, are not inspected; the hook only sees Bash commands.
- PowerShell command strings and stdin are parsed; encoded input asks and pwsh positional script files remain a limit.

## Settings

| Env | Default | Meaning |
| --- | --- | --- |
| `SCG_COOLDOWN_DAYS` | `7` | Releases younger than this ask |
| `SCG_MODEL` | `sonnet` | Reviewer model. Haiku measured slower and gave false alarms on axios 1.7.7 to 1.7.9 |
| `SCG_BUDGET_MS` | `100000` | Whole-hook budget, keep it under the hook `timeout` |
| `SCG_STATE_DIR` | `~/.cache/supply-chain-guard` | Verdict cache and log |
| `SCG_NPM_REGISTRY`, `SCG_PYPI_URL`, `SCG_VSX_API`, `SCG_OSV_URL` | public registries | Mirrors and tests |
| `SCG_EXTENSION_DIRS` | `~/.cursor/extensions`, `~/.vscode/extensions`, and their `-server` variants | Where installed extension versions are read |
| `SCG_CLAUDE_BIN` | `claude` | Reviewer binary |

## Install

Hook entry (the skills repo `manifest.json` renders it into `~/.claude/settings.json`):

```json
{ "event": "PreToolUse", "matcher": "Bash|PowerShell", "command": "node \"{HOME}/.claude/skills/supply-chain-guard/hooks/guard.mjs\"", "timeout": 120, "onFailure": "block" }
```

Cooldown, 7 days, each verified against the docs and, where the tool is installed, by resolving a release younger than 7 days:

| Tool | Minimum version | Per-user setting | Command |
| --- | --- | --- | --- |
| pnpm 11 | 11 (default 1 day) | `minimumReleaseAge: 10080` (minutes) in `~/.config/pnpm/config.yaml` | `pnpm config set --location=global minimumReleaseAge 10080` |
| pnpm 10 | 10.16 | `minimum-release-age=10080` in `~/.config/pnpm/rc`; pnpm 10 does not read `config.yaml`, and a project with `packageManager: pnpm@10.x` runs pnpm 10 even under pnpm 11 | edit the file |
| npm | 11.10 (10.x ignores the key) | `min-release-age=7` (days) in `~/.npmrc` | `npm config set min-release-age 7 --location=user` |
| yarn berry | 4.10 | `npmMinimalAgeGate: 7d` in `~/.yarnrc.yml` | `yarn config set --home npmMinimalAgeGate 7d` |
| bun | 1.3 | `[install]` `minimumReleaseAge = 604800` (seconds) in `~/.bunfig.toml` | edit the file (docs only, not run) |
| uv | 0.9.17 | `exclude-newer = "7 days"` in `~/.config/uv/uv.toml` (also covers `uv pip`) | edit the file |
| pip | 26.1 | `[install]` `uploaded-prior-to = P7D` in the user `pip.conf` | `pip config --user set install.uploaded-prior-to P7D` |

To take a release inside the window on purpose, override once on the command line, such as `pnpm add x --config.minimumReleaseAge=0`. The hook still asks about it.

## Maintain

- `npm test` runs the hermetic suite against a local registry, Open VSX and OSV stand-in (`test/registry.mjs`) and a fake reviewer (`test/fake-claude.mjs`).
- `node test/bench.mjs --runs 3 > bench.json` runs real registries and the real reviewer, and prints verdicts and cold and cached latency per scenario.
- A new red flag goes in the `RULES` table in `hooks/scan.mjs`, with a case in `test/scan.test.mjs`.
