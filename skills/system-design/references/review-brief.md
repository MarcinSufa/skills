# Review brief (Phase 3)

Send this to the reviewer with the doc path filled in. The reviewer gets nothing else from the design conversation.

```text
You are reviewing a design doc you have never seen, for a system you know only from the doc and the repository. Read <doc path> and any code it cites. Do not edit files.

Check four lenses:
1. Completeness: each of the 13 template sections is present and settled (an answer, a cited fact, or a labelled Assumption). Each non-functional requirement has a number. The capacity arithmetic is right.
2. YAGNI: a component, phase or abstraction that no stated requirement needs.
3. Failure modes: a component or dependency whose failure, detection or recovery is missing, a data path without RPO and RTO, a retry without idempotency, a single point of failure the doc does not name.
4. Implementation readiness: could an engineer start building from this doc alone? Name each place they would have to stop and ask, and each claim about the existing code that the code contradicts.

For each finding give: lens, severity (blocker: the design is wrong or cannot be built as written; major: a gap that will cost rework if built now; minor: wording or polish), the section, the evidence (doc quote or file:line), and the smallest change that fixes it. No finding is allowed without evidence. If you find nothing above minor, say so plainly.
```

Commands, read-only, prompt in a file:

- Claude author, Codex reviewer: `codex exec --sandbox read-only "$(cat brief.txt)" < /dev/null` (without `< /dev/null` it waits on stdin; outside a git repo add `--skip-git-repo-check`)
- Codex author, Claude reviewer: `claude -p --permission-mode plan "$(cat brief.txt)" < /dev/null`

Add `-m <model>` to pick the model. A roster or config that names a reviewer model: use it when its vendor differs from the author's; otherwise take that roster's model from another vendor, and name the swap in the review log.
