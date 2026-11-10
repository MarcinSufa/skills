# docs-vs-code-precedence

**One sentence in `CLAUDE.md` or `AGENTS.md` that makes the agent follow the existing code, not a stale instruction file, when the two disagree, and name each conflict in its final reply.**

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/docs-vs-code-precedence-dark.png">
    <img alt="When the instruction file and the code disagree, the code wins. One sentence in CLAUDE.md or AGENTS.md, at user or repo level: the agent follows the conventions of the existing code and names each conflict in its final reply; process rules such as review gates and commit signing still apply. Example: CLAUDE.md says test with unittest, every existing test uses pytest; the agent writes a pytest test and its reply points out the conflict. In the replication it followed the code in 69 of 76 choices with the sentence, up from 11 of 76 without." src="assets/docs-vs-code-precedence-light.png" width="880">
  </picture>
</p>

```text
When a repository's documentation and its existing code disagree, follow the conventions used in the existing code, and in your final reply point out each inconsistency you found between the documentation and the code.
```

| | |
| --- | --- |
| **Fires** | in every session that loads the file, whenever the instruction file and the existing code disagree about a convention |
| **Does** | the agent writes code the way the existing code does, then lists each conflict it found so you can fix the file |
| **Never** | overrides process rules: review gates, test requirements and commit signing still apply |
| **Needs** | an agent that reads `CLAUDE.md` (Claude Code) or `AGENTS.md` (Codex and others); a new session after you add it |

## Why

Instruction files go stale: the code moves to pytest, a new logger or another naming style, and `CLAUDE.md` still describes the old way. Agents then follow the file and write new code that does not match the code around it. In our replication of the paper below, Claude Code followed the stale file in 61 of 76 choices without the sentence, and followed the code in 69 of 76 with it.

## Install

Add the sentence at user level (you, in every repo) or at repo level (everyone who clones the repo, no per-person setup). Each command appends only when the sentence is missing, creates the file when there is none, and copies an existing file to `<file>.bak-YYYY-MM-DD` first.

Linux or macOS (bash):

```bash
add_rule() {
  f=$1
  s="When a repository's documentation and its existing code disagree, follow the conventions used in the existing code, and in your final reply point out each inconsistency you found between the documentation and the code."
  mkdir -p "$(dirname "$f")"
  if [ -f "$f" ] && grep -qF "$s" "$f"; then echo "already in $f"; return; fi
  if [ -f "$f" ]; then
    b="$f.bak-$(date +%F)"; [ -e "$b" ] || cp "$f" "$b"
    printf '\n%s\n' "$s" >> "$f"
  else
    printf '%s\n' "$s" > "$f"
  fi
  echo "added to $f"
}
add_rule ~/.claude/CLAUDE.md                        # user level, Claude Code
add_rule "${CODEX_HOME:-$HOME/.codex}/AGENTS.md"   # user level, Codex
add_rule CLAUDE.md                                  # repo level, run from the repo root
```

Windows (PowerShell):

```powershell
function Add-Rule($Path) {
  $s = "When a repository's documentation and its existing code disagree, follow the conventions used in the existing code, and in your final reply point out each inconsistency you found between the documentation and the code."
  $dir = Split-Path -Parent $Path
  if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  if (Test-Path $Path) {
    if (Select-String -Path $Path -SimpleMatch -Quiet -Pattern $s) { "already in $Path"; return }
    $b = "$Path.bak-$(Get-Date -Format yyyy-MM-dd)"
    if (-not (Test-Path $b)) { Copy-Item $Path $b }
    Add-Content -Path $Path -Value "`n$s" -Encoding ascii
  } else {
    Set-Content -Path $Path -Value $s -Encoding ascii
  }
  "added to $Path"
}
Add-Rule "$HOME\.claude\CLAUDE.md"   # user level, Claude Code
$codex = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { "$HOME\.codex" }
Add-Rule "$codex\AGENTS.md"         # user level, Codex
Add-Rule "CLAUDE.md"                 # repo level, run from the repo root
```

Keep the lines you need. Codex reads `$CODEX_HOME/AGENTS.md` when `CODEX_HOME` is set. For the repo level, use `AGENTS.md` if that is the file your team's agent reads, delete the `.bak-*` copy (git keeps the old version) and commit the change.

To let an agent do it, copy the skill and ask it to "add the docs-vs-code rule":

```bash
git clone https://github.com/MarcinSufa/skills
cp -r skills/skills/docs-vs-code-precedence ~/.claude/skills/
```

## Verify

```bash
grep -F "follow the conventions used in the existing code" ~/.claude/CLAUDE.md "${CODEX_HOME:-$HOME/.codex}/AGENTS.md" CLAUDE.md
```

```powershell
$codex = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { "$HOME\.codex" }
Select-String -SimpleMatch -Pattern "follow the conventions used in the existing code" -Path "$HOME\.claude\CLAUDE.md", "$codex\AGENTS.md", "CLAUDE.md"
```

List only the files you added the sentence to (`AGENTS.md` instead of `CLAUDE.md` for a repo that uses it). Each one should print the sentence.

Then start a new Claude Code or Codex session. A session that is already open loaded the old file.

## Evidence

Paper: Xu and Wu, "Stale Instruction Files Override the Code in Coding Agents: A One-Sentence Fix", [arXiv 2610.30571](https://arxiv.org/abs/2610.30571). Data and classifiers: [WenJing95/stale-docs-data](https://github.com/WenJing95/stale-docs-data).

Our replication: Claude Code 2.1.310 (`claude-sonnet-5-5`), 18 projects (P01 to P18) x 2 conditions x 1 run, 76 choices per condition, scored with the paper's `judge.py` and `score.py`.

| | followed the stale file | followed the code | neither | conflict named |
| --- | --- | --- | --- | --- |
| without the sentence | 61 of 76 (80.3%) | 11 of 76 (14.5%) | 4 of 76 (5.3%) | 18 of 18 replies |
| with the sentence | 3 of 76 | 69 of 76 (90.8%) | 4 of 76 (5.3%) | 18 of 18 replies |

- Tests passed 18 of 18 in both conditions. No run rewrote existing Python: 0 of 36 runs deleted 20 or more lines in an existing `.py` file.
- The paper, Claude only, with more runs (80 runs, 360 choices per condition): without the sentence 86.4% followed the file and 7.5% the code; with it 94.4% followed the code.
- Across Claude and Codex the paper's test pass rate went from 89.4% to 100%. That lift came from Codex rewrites, which we did not run.

## Limits

- It covers documentation and existing code that disagree about coding conventions. It does not tell the agent to skip process rules such as review gates or commit signing.
- The paper and our replication used small Python projects. It was not re-tested on a real application repository.
- Not run: projects P19 to P40, a second run per cell, and Codex CLI.

## Files

| File | For |
| --- | --- |
| [`SKILL.md`](SKILL.md) | the agent: when to add the sentence, the install and verify steps, the caveats |
| `README.md` | you |
