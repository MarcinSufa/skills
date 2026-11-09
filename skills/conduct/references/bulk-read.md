# bulk-read: usage

The rule (never Read a big file into the driving session) is summarized in SKILL.md and detailed in
references/token-hygiene.md. This file holds the invocation details.

`node "${CLAUDE_SKILL_DIR}/scripts/bulk-read.mjs" <file>... --question "<q>" [--model flash|luna] [--max-bullets 40] [--json] [--dry-run]`

- `flash` = DeepSeek v4 Flash via `DEEPSEEK_API_KEY` (default); `luna` = Luna via
  `OPENAI_PLATFORM_KEY`. The script pins its own model ids, separate from the routing table.
- Bullets cite `path:line` (`path:pN` for PDFs, whose lines reach the worker prefixed `pN|`).
- PDFs need PyMuPDF (`import fitz`) in `python3` (`python` on Windows); `BULK_READ_PYTHON`
  overrides the interpreter. Without it a PDF exits 3.
- stderr carries model, chunks, token counts, dropped uncited lines, bullets cut by
  `--max-bullets` and a cost estimate, never file contents. Under `--json` the bullets and those
  metrics go to stdout as one object instead.
- A billed run refuses more than 20 chunks (`BULK_READ_MAX_CHUNKS`); `--dry-run` shows the plan
  and warns.
- Paths with a segment containing any token from `BULK_READ_DENY_PATHS` (`;`-separated,
  case-insensitive, e.g. `acme;client-repo`) are refused with exit 4 before any network call.
  There is no default deny list: set it to keep client code away from third-party models.
