# Building a flag catalog

The catalog is a committed file in the repo (default `docs/flags.md`), shared by the team and by every agent. It answers three questions per flag: where the value comes from, who reads it, and when.

## Find the flags

Start from the repo itself: find where the app loads its configuration at startup and where it fetches settings, and follow every object it stores them in to its readers. A response that carries a config object usually carries more: list its other fields that differ per customer, project, plant or user, they are flags too. Then search every source below. Each hit is a flag or is listed under "Ignored" with the reason. Done when every config response the app loads has all its per-entity fields traced to their readers and no source below is unsearched. A settings object with more than 30 fields: trace the readers the next change needs, mark the section partial and give the grep that finds the rest. A backend that serves settings to a client: fields only the client reads are flags too, with "reader in <client repo>".

- Feature flag libraries and their keys: LaunchDarkly, Unleash, GrowthBook, ConfigCat, Flagsmith, OpenFeature, Split, or a home-made `features` module.
- Config files read at runtime or build time: `app.json`, `appsettings*.json`, `config/*`, `.env*` examples, build defines (`import.meta.env`, `process.env`, `define`), with keys like `enable*`, `use*`, `*Enabled`, `feature*`, `new*`.
- Settings served by the backend: config or settings endpoints and their DTOs, at every level (tenant or org, company, plant or site, customer, project, user). Booleans and enums that change behaviour count, and so do `*Required`, `*Visible`, `allow*` and `restrict*` fields. An override the backend resolves out of sight is a row marked "resolved server-side (inferred)", naming the screen that edits it and the DTO that carries the result.
- **Derived server data**: a response the server builds by reading its own settings, with no flag name on the client side (validation results and warnings, required or allowed lists, computed defaults or options). Each such field is a row whose source is the setting behind it. Find them by **provenance**: send the same request under two profiles (two customers, users or tenants) or two environments and diff the responses, or open the server code that builds it; a field that differs is a flag. Its readers are the client code that shows or branches on it.
- Permissions and roles the code checks before showing or allowing something. Catalog the mechanism (how a check is written, where the list comes from, what happens when loading it fails) and how to grep every check; list individual checks only for the modules a change touches.
- Overrides used in testing (localStorage keys, query params, headers, env vars) and where they are read.
- Caches that delay a new value (session or auth caches, service workers, memoized config) with their lifetime, and config that arrives outside the API (server-rendered HTML, a host page).

## Find the moments

For each config response, list every call site that applies it (grep the functions that map or store it); in a backend, every call site that reads the value, and every place one flag is read through a different mechanism (startup wiring, a separate service's own key). For each user action or backend event (request, job, startup, config reload) (first load, entity pick, plant or site change, save, reopen, copy, cache expiry), mark which of its values that action re-applies. An action that re-applies some values of a response but not others is a "not refreshed" moment for the rest. Done when every config response has this list.

## Entry format

One table row per flag, grouped by level:

| Flag | Level and override | Source | Default | Value per environment | Readers (file:line) | Read at (moments) |
| --- | --- | --- | --- | --- | --- | --- |
| `poNumberRequired` | tenant < customer < project | `GET /api/settings`, then each draft response | false | dev on, staging on, prod off | `checkout/po.validator.ts:41` | first load, customer pick, reopen; not on site change |

- **Value per environment**: for file or env config, one cell with the values in the header's environment order, separated by `/`; for values stored per tenant or entity, `per <level>` and the query that reads one.
- **Read at** is filled in on every row, from "Find the moments": the moments the value is read or refreshed, and the moments it is *not* refreshed when a reader might expect it, since that gap is where stale-value bugs live. A section-wide moments table may sit next to the rows, never in place of them.
- Values per environment come from reading them (a command or request), never from memory; write the command once in the header. When reading needs access you lack, write `unread`: every matrix cell that depends on it is unreachable until someone runs the command.
- Note how the reader parses the value (a raw env string, `!!value`, a strict `=== true`). When an "off" value can read as on (the string `"false"` is truthy), that value is its own profile and a finding.
- Readers found by grep and not yet opened are marked `(g)`; the step that uses the flag opens them.

## Header

Above the tables:

- Per environment: how to read its current values (the request or command), and which flags may be changed there for a test (local override, own test data) and which are shared and only read.
- How a test sets each kind of flag (override key, fixture, mocked response).
- The date and commit the catalog was checked against. Entries drift: the step that uses an entry re-verifies its readers.

## Findings

Defects the search turns up go in their own list, not under "Ignored": a key the code reads that no config supplies, a value supplied but never read, a flag enforced only in a client, a permission check that fails open, a value never refreshed where a reader expects it, environment names that disagree between config and code.

## Ignored

Hits that are not behaviour flags (pure display constants, dead keys neither read nor supplied), each with the reason, so the next search does not redo them.
