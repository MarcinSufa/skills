## Slice artifacts

Everything the conductor produces lands in `.conduct/` in the slice worktree, so the record survives
context loss and the operator can audit any leg:

```
.conduct/
  brief-<slice>.md              # the spec/brief
  opinion-<slice>-<vendor>.md   # one per opinion leg
  fusion-<slice>.md             # consensus / divergence / discarded / decision
  gate-<slice>.{sh,ts,py}       # executable gate + fail messages
  <vendor>-<slice>.md           # review leg outputs (codex-, grok-, …)
  events.ndjson                 # NDJSON event stream (leg lifecycle from hooks, semantics from the conductor)
  ledger.md                     # leg ledger - one row per closed slice, spec in references/ledger.md
```

**Slice token convention:** Every artifact of a slice carries the SAME slice token in its file name, the token is the first cell of the slice's ledger row, verbatim. All artifacts follow the pattern: brief-<slice>.md, opinion-<slice>-<vendor>.md, fusion-<slice>.md, gate-<slice>.<ext>, <vendor>-<slice>.md, skip-<slice>.md. Sub-artifacts append suffixes AFTER the token, never replace it. preflight-close.mjs matches artifacts by this token, so a drifted token (S20 files vs an s20-close ledger row) fails the close even when the work is done.

Before writing the ledger row at slice close, read references/ledger.md for the v2 column spec.
