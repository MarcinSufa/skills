# Preflight close, slice teardown, and the reaper

Read this before closing or destroying a slice worktree (Loop step 10): what
`preflight-close.mjs` checks, the six-step teardown order, and what `reap.mjs` does.

## Preflight close (mechanical)

A worktree holding only a brief looks exactly like an executed slice, so the close
requirements are checked mechanically, not by prose. Run, as step 1 of teardown and before
any destroy: `node "${CLAUDE_SKILL_DIR}/scripts/preflight-close.mjs" <worktree> --slice <slice>`.
It verifies five things against `.conduct/`: C1 a ledger row for the slice, C2 a gate file
plus red-first run evidence (or a gate skip, below), C3 two opinion vendors or a stated skip
(never a silent one), C4 a fusion doc with Consensus, Divergence, Discarded and Decision
(Divergence non-empty, or a stated skip), C5 review coverage: every implementer vendor
family named in the ledger's `worker` cell needs a current, independent review leg (no skip
accepted; below). Exit 0 means every check passed; exit 2 means at least one FAIL (each with
a one-line remedy); exit 1 is a usage or environment error. It is strictly read-only, and a
red preflight blocks the close exactly like reap's nonzero exit: fix or state the exception
in the artifacts, never proceed past it.

Run this BEFORE the merge, not after: merging moves the merge-base, so every leg's bound
`diff-sha256` reads as stale (C5 FAIL) against the post-merge state even though nothing about
the reviewed change itself moved. If the merge already happened, pass
`--base <the diff-base a leg's stamped header names>` to check against the state the legs
actually reviewed, instead of re-deriving a base that has since moved.

**C5, review binding (2026-09-24).** The implementer set comes from the ledger's `worker`
cell: strip any `(...)` parenthetical (a denied cast, a note - context, not an implementer),
split what remains on `,` or `+`, map each segment to a vendor family; an empty segment or
one that does not map fails the whole slice closed. Coverage means, for every implementer
family, at least one review leg CURRENT for the slice (its `diff-sha256` line matches a
`slice-state v1` hash computed over the bytes of every path the slice touches - tracked and
untracked, merge-base included, `.conduct/` excluded, no size cap, so a large changed file
such as a lockfile binds and reviews like any other) and independent of that family (a
`review-scope: full` leg from a different family, or a `delta-from: <hash>` chain that
resolves, link by link, to one). Get that hash and the matching patch with
`node preflight-close.mjs <worktree> --slice <slice> --diff-patch`; stamp its three header
lines (`slice-state:`, `diff-base:`, `diff-sha256:`) into the top of the leg file, plus
either `review-scope: full` or `delta-from: <the hash the leg builds on>` (--diff-patch
renders a large or binary file as a one-line stub carrying its own sha256, never dumping it
inline). C5 fails closed, distinctly, on three separate conditions: any path the slice
touches that is still untracked (never `git add`ed - remedy: "git add it or delete it before
close", since a commit will not ship it, however it reviewed); any TRACKED changed path whose
index differs from its worktree bytes (remedy: "stage or revert before close" - a leg binds
to what a commit would actually ship, not to an uncommitted edit only in the working tree;
this compare is git's own `diff --name-only`, so a symlink is judged by its target, never by
reading through it); and missing coverage, whose detail names each present leg and why it
does not count - unbound (and why: no `diff-sha256` line, a duplicate, a bad `review-scope`
or `delta-from`), stale (bound to a `diff-sha256` that is no longer current), or same vendor
family. A gitlink (submodule) change is recorded in the hash as its new commit sha, not
rejected outright - unlike the C2 gate-skip path below, which still rejects any gitlink.

A stated skip is a skip record in `.conduct/skip-<slice>.md`: a `skipped:` line with
comma-separated tokens from `opinion`, `fusion`, `gate`, plus a `reason:` line of at least
40 characters; anything else in the file does not count, and an unknown token invalidates
the whole record for C2, C3 and C4 alike. The `skipped:` label must start the line (only
leading whitespace before it), and a duplicate `skipped:` or `reason:` line, or an empty
token such as a trailing comma, also invalidates the record. The opinion skip may also be
recorded as `skipped` in the ledger's opinion-vendors cell; an existing skip file that is
blank or invalid blocks that fallback.

The `gate` token additionally passes C2 only when: no `gate-<slice>.*` file also exists
(both present fails closed with "choose one"); the diff from `merge-base(HEAD, base)`
through the index AND the working tree, including untracked files and excluding
`.conduct/`, is 1..30 changed lines across 1..2 files with no binary content, taking the
larger changed-line count per path when the index and the working tree disagree (base is
`--base <ref>` or the first of `origin/HEAD`, `origin/main`, `origin/dev`, `main`, `dev`
that resolves); a gitignored file is excluded from that count entirely, since it is never
committed or merged; any gitlink (submodule) change on either side fails the check outright,
regardless of size; each version of a changed path (merge-base, index, worktree) is capped
at 1 MiB before it is ever read; and the same C5 coverage rule above is satisfied for the
ledger row's `worker` cell (every implementer family gets a current, independent, bound
review leg). Any git failure on the gate-skip path fails closed.

## Slice teardown

Teardown is the one destructive recipe in this skill: six steps, fixed order, run at every
slice end, so everything that deletes anything is named in one place. Owner per step:

1. **Spend** (prose): record what each leg reported, with a coverage denominator
   (`N across 2/4 legs`); an unreported subscription leg is `unknown`, never `0`,
   never dollars, never an estimate.
2. **Artifacts** (both): the script enumerates `.conduct/`; the conductor copies the durable
   part (ledger row, decisions) to the memory sink, because `.conduct/` dies with the worktree.
3. **Harvest** (prose): secure the work product as a pushed branch or an exported patch;
   harvest NEVER means merging, and the script cannot commit, merge, push, or open a PR.
4. **Revoke** (prose): strip temporary allow rules and credential-shaped leftovers
   from the settings files by hand. This cannot be automated: see below.
5. **Destroy** (script): remove the slice worktree, exactly one per run, guarded, confirmed.
6. **Close** (both): the script exits nonzero while owned actionable leftovers remain, so a
   red report blocks the close; the ledger row is closed by hand. End the orchestration with
   `node "${CLAUDE_SKILL_DIR}/scripts/conduct-events.mjs" end --terminal closed|abandoned`.

Revoke cannot be automated: a leftover allow rule carrying a live credential is structurally
identical to the hundreds of legitimate entries. The operator searches the settings files for
credential-shaped literals, deletes the entries by hand, and rotates every credential found,
because deleting the text does not un-leak it.

## The reaper

The reaper is report-first. Invoke it as: `node "${CLAUDE_SKILL_DIR}/scripts/reap.mjs"`.
Every run sweeps the current working directory plus one level of its children for
repositories; root arguments add extra roots to that sweep, they never replace it.
It prints the primary checkout as `PRIMARY` (never a candidate, outside the four counts) and
classifies every other discovered worktree as owned-and-actionable, blocked-with-reasons,
stale-but-unowned, or active-or-indeterminate, and exits nonzero while owned actionable
leftovers exist. Ownership is a `.conduct/` directory holding at least one `brief-*.md` file;
path and branch names (`race/*`, `*-review`, living under a shared worktree root) carry no authority to
destroy and are not marked in the report. Destruction is `--destroy <exact canonical path>`
plus typed confirmation; the script prints the exact git command first, never forces, never
deletes a branch, never edits a settings file, never signals a process, and refuses to
destroy any worktree whose path contains a scratchpad segment. An interrupted destroy is
recoverable: `.conduct/` is staged aside under a manifest-backed transaction, every later
run reconciles that staged sibling first, and the close stays red until none remains.

If five consecutive slice closes still leave owned leftovers in the report, that is the
evidence that justifies a hook; do not add one before that five-slice trigger fires.
