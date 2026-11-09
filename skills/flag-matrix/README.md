# flag-matrix

**Tests a change that reads a feature flag or config setting across every flag profile and every moment the code reads it, in any repo.**

| | |
| --- | --- |
| **Fires** | when the change touches code that reads a flag or setting, when someone asks "does X work on dev / staging / prod", and to build the repo's flag catalog |
| **Builds once per repo** | `docs/flags.md`: every flag, where its value comes from, the override order, values per environment, who reads it (file:line) and when |
| **Per change** | the flags the diff reads, a profiles x moments table, a parameterized test in the repo's own harness, the table in the PR |
| **Never** | changes shared settings (tenant, org, environment config): it reads them and records them |

## Why

A flag doubles the paths through the code, and the bug usually sits in the path nobody ran. A real case: a backend change made a form report required fields as missing. On the test environment every "required" setting was on and every test started from a filled form, so all tests were green. In production the form showed "field is required" on first open and on every keystroke, for fields the user had not touched yet. The matrix catches it in the first cell: production profile, first open, assertion "nothing shown for an untouched field". It went red on the release tag and green on the fix.

## The matrix

```
                 all off   flag A only   override (project > customer)   prod values
first load        PASS        PASS              PASS                      FAIL: toast for untouched PO
config late       PASS        PASS              n/a                        PASS
customer pick     PASS        FAIL: ...         PASS                       PASS
save              unreachable (shared tenant setting, for QA)
reopen            PASS        PASS              PASS                       PASS
```

- **Profiles** (columns): everything off, each flag on alone at its level, each override, the production combination, the environment where the bug was seen.
- **Moments** (rows): every point the catalog says the value is read or refreshed, including the response that arrives late while the user types.
- **Red first**: the cell the change fixes must fail on the base. A matrix that is green there is missing an axis.

## The catalog

`docs/flags.md`, committed, one row per flag. Building it means searching flag libraries, config files, build defines, backend settings at every level, permissions and test overrides; [CATALOG.md](CATALOG.md) lists the sources and the row format. AGENTS.md gets one line pointing at it, so every agent working in the repo knows the flags exist before it touches them.

## Files

| File | For |
| --- | --- |
| [`SKILL.md`](SKILL.md) | the agent: the steps |
| [`CATALOG.md`](CATALOG.md) | the agent, when it builds or refreshes the catalog |
| `README.md` | you |

`risk-code-review` asks for this table on every change that reads a flag.
