---
name: docs-vs-code-precedence
description: 'Adds one sentence to CLAUDE.md or AGENTS.md so the agent follows the conventions of the existing code, not a stale instruction file, when the two disagree, and names each conflict in its final reply. Use when setting up Claude Code, Codex or another agent that reads CLAUDE.md or AGENTS.md, when a repository instruction file may be stale relative to the code, or when onboarding a team so everyone gets the same precedence rule.'
---

# docs-vs-code-precedence

Agents follow the instruction file over the code it describes. When `CLAUDE.md` or `AGENTS.md` says one convention and the existing code uses another, the agent usually writes new code to match the stale file. One sentence in the instruction file flips that: the agent follows the code and reports the conflict.

## When to use

- Setting up Claude Code, Codex or another agent that reads `CLAUDE.md` or `AGENTS.md`.
- A repository's instruction file may be stale relative to its code.
- Onboarding a team, so everyone gets the same precedence rule.

## The sentence

Copy it verbatim. Do not rephrase it: this exact wording is what was measured.

```text
When a repository's documentation and its existing code disagree, follow the conventions used in the existing code, and in your final reply point out each inconsistency you found between the documentation and the code.
```

| Level | File | Who gets it |
| --- | --- | --- |
| user, Claude Code | `~/.claude/CLAUDE.md` | you, in every repo |
| user, Codex | `~/.codex/AGENTS.md` (or `$CODEX_HOME/AGENTS.md`) | you, in every repo |
| repo | `CLAUDE.md` or `AGENTS.md` at the repo root, whichever the team's agent reads | everyone who clones the repo |

Ask the user which level they want if they did not say. The user-level files are theirs: do not edit them without that answer.

## Install

Each command appends the sentence only when it is not already in the file, creates the file (and its folder) when missing, and copies an existing file to `<file>.bak-YYYY-MM-DD` before it appends.

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
add_rule ~/.claude/CLAUDE.md   # user level, Claude Code
add_rule ~/.codex/AGENTS.md    # user level, Codex
add_rule CLAUDE.md             # repo level, run from the repo root
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
Add-Rule "$HOME\.codex\AGENTS.md"    # user level, Codex
Add-Rule "CLAUDE.md"                 # repo level, run from the repo root
```

Run only the lines for the levels the user chose. For the repo level use `AGENTS.md` instead of `CLAUDE.md` if that is the file the team's agent reads. Git already keeps the old repo file, so delete the repo-level `.bak-*` copy instead of committing it, then commit the change so the team gets it.

## Verify

```bash
grep -F "follow the conventions used in the existing code" ~/.claude/CLAUDE.md ~/.codex/AGENTS.md CLAUDE.md
```

```powershell
Select-String -SimpleMatch -Pattern "follow the conventions used in the existing code" -Path "$HOME\.claude\CLAUDE.md", "$HOME\.codex\AGENTS.md", "CLAUDE.md"
```

Then tell the user to start a new Claude Code or Codex session. A session that is already open loaded the old file and does not see the sentence.

## Caveats

- The sentence covers documentation and existing code that disagree about coding conventions. It does not tell the agent to ignore process rules such as review gates, test requirements or commit signing: keep following those.
- The paper and the replication below used small Python projects. It was not re-tested here on a real application repository, and Codex was not re-run.

## Evidence

Xu and Wu, "Stale Instruction Files Override the Code in Coding Agents: A One-Sentence Fix", arXiv 2610.30571, https://arxiv.org/abs/2610.30571. Data: https://github.com/WenJing95/stale-docs-data

Replication with Claude Code 2.1.310 (`claude-sonnet-5-5`), 18 projects (P01 to P18) x 2 conditions x 1 run, 76 choices per condition, scored with the paper's `judge.py` and `score.py`:

| | followed the stale file | followed the code | neither | conflict named |
| --- | --- | --- | --- | --- |
| without the sentence | 61 of 76 (80.3%) | 11 of 76 (14.5%) | 4 of 76 (5.3%) | 18 of 18 replies |
| with the sentence | 3 of 76 | 69 of 76 (90.8%) | 4 of 76 (5.3%) | 18 of 18 replies |

Tests passed 18 of 18 in both conditions; no run rewrote existing Python (0 of 36 runs deleted 20 or more lines in an existing `.py` file). The paper, Claude only, with more runs (80 runs, 360 choices per condition): without the sentence 86.4% followed the file and 7.5% the code; with it 94.4% followed the code. Across Claude and Codex the paper's test pass rate went from 89.4% to 100%; that lift came from Codex rewrites, which this replication did not run.

Not run: projects P19 to P40, a second run per cell, Codex CLI, and a real application repository.
