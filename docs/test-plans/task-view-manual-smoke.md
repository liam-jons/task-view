# task-view v0.1.0 manual smoke-test — KH Subtask ID-20.16

<!-- Last verified: 22/05/2026 -->

## Run context

- **Executor session:** `kh-prod-readiness-S68` task-view cmux worker
  (`cmux-worker-task-view-20-16-17-8d16ec4`).
- **Task-view repo HEAD at run time:** `8d16ec4` on
  `feat-30.8-rank-drag-reorder` (post-S65 baseline + rank-drag-reorder Wave).
- **Plan source:** `/docs/research/task-view-manual-test-plan-S66.md` in
  the Knowledge Hub production-readiness repo (499 lines, 22+4 numbered
  scenarios).
- **Coverage source:** `/docs/specs/per-task-mirror/PRODUCT.md` in the
  Knowledge Hub production-readiness repo (55 invariants).
- **KH ledger source-of-truth:** branch `production-readiness` of the
  knowledge-hub-production-readiness repo, HEAD `c5029a33` at run start
  (advanced to `242f57cf` during the run — the KH parent session shipped
  Subtask 32.11 flips concurrently per the brief Coordination §). The
  canonical
  `docs/reference/task-list.json` was snapshotted to
  `/tmp/task-list-pre-test-snapshot.json` before execution. Live KH JSON
  was **not** mutated — PATCH scenarios operated against
  `/tmp/kh-canonical/task-list.json` (a `capability_theme`-stripped copy;
  see Side-observation 2).
- **Live KH ledger sizes at run time:** task-list has **30** Tasks; backlog
  has **120** items; roadmap has 0 items in the vendored-incompatible
  `themes[]` shape. The brief expected 60→114 backlog post-30.10 — the
  observed 120 indicates KH-side reshape work has continued past 30.10.
- **20.12 coordination:** mirror commit Subtask **has not shipped** —
  `docs/reference/tasks/`, `roadmap/`, `backlog/` are absent from KH.
  Scenario 1 was executed against the /tmp/ copy per brief
  ("copy outputs to $TMPDIR rather than committing them") so KH worktree
  is unaffected.
- **Baseline test posture:** `bun test` reports **758 pass / 0 fail**
  before AND after the smoke-test run (the S66 brief named 733 — outdated
  pre-rank-drag-reorder count).

## Scope split (three tiers + Vite SPA)

Per S66 SPA-gap finding, the browser-observable surface is split:

1. **Tier 1 — direct HTTP / JSON inspection** of `/api/ledger`,
   `/api/ledger/record/:recordId`, PATCH, POST `/regen`.
2. **Tier 2 — on-disk mirror file rendering** (CommonMark + GFM
   inspection of the YAML frontmatter + body).
3. **Tier 3 — CLI behaviour verification** of `--help`, `--version`,
   `--check`, CWD scan, exit codes, port handling.
4. **Scenario 13** verifies the Vite SPA placeholder source.
5. **Scenarios 14-17 + 18 (SPA-rendered viewer)** are deferred-with-rationale
   to Subtask 20.18 (post-20.17 SPA wiring).

## Pass/fail table

| #  | Slice   | PRODUCT inv | Verdict   | Evidence                                                                                                | Notes |
|----|---------|-------------|-----------|----------------------------------------------------------------------------------------------------------|-------|
| 1  | 2       | 5, 40       | PARTIAL   | `evidence/s1-server.txt`; `/tmp/kh-canonical/tasks/*.md` × 30                                            | Mirrors written via POST `/api/ledger/regen`. Server bare launch does **not** auto-regen — gap vs. inv 5 "generates on launch". Filename pattern `ID-N.md`, count matches `.tasks \| length` = 30, YAML frontmatter bounded by `---`. |
| 2  | 2       | 5           | PASS      | `evidence/s2-shas-before.txt` vs `evidence/s2-shas-after.txt` (`diff` empty)                            | Byte-identical regen across two server lifecycles. |
| 3  | 2       | 7, 8        | PASS      | `/tmp/kh-canonical/tasks/ID-20.md` lines 1-80                                                            | Frontmatter carries `type: task`, `id: "20"`, `title`, `status`, `priority`, `effort_estimate`, `owner`, `updated`, `session_refs` (array), `commit_refs` (array), `dependencies` (array), `cross_doc_links` (per-entry objects), `priority_note`, `status_note`. Body: H1 + description + `## Subtasks` + per-Subtask `### ID-20.<N>: <title>` blocks with Status / Dependencies / Updated + `**Details:**` + `<info added on ...>` journal blocks preserved verbatim. No agent-browser screenshot (token budget per brief Budget §). |
| 4  | 2       | 5           | PASS      | Orphan `ID-999-orphan.md` written, regen response `mirrorsDeleted: [...]` length 1, file absent post-regen, real-Task mirrors (30) retained. |
| 5  | 2       | 4           | **FAIL** (stop-the-line) | `evidence/s5-server.txt` (server boots OK); `evidence/s5-stderr.txt` (empty); first GET `/api/ledger` returns 422 `{ok:false, error:"unknown-document-name"}` | **Defect:** bare server launch boots with `Server ready at …` even though `document_name: "Unknown Document Type"`. PRODUCT inv 4 requires non-zero exit on load. `--check` path correctly exits 4 (`task-view --check: unknown document_name …`) — only the server-launch path is non-conformant. Recovery is safe (server reveals the error at first `/api/ledger` GET); no canonical mutation possible. |
| 6  | 2       | 48          | **FAIL** (stop-the-line) | `evidence/s6-server.txt` (boots); first GET returns `{ok:false, error:"ledger-read-failed", detail:"JSON Parse error: Unexpected EOF"}` | Same defect class as S5. `--check` path correctly exits 3 with stderr `task-view --check: failed to read or parse … JSON Parse error: Unexpected EOF`. Server-launch path defers the fail-on-load until first HTTP request. |
| 7  | 3       | 4, 36       | PASS      | `evidence/s7-ledger.json`                                                                                | Shape: `{ok:true, kind:"task-list", data:{document_name, document_purpose, last_updated, related_documents, tasks}, mirrorDir:"/tmp/kh-canonical/tasks", mirrorDirName:"tasks", mtime:"<ISO>"}`. `data.tasks` length = 30 (matches `jq '.tasks \| length'`). |
| 8  | 3       | 4, 36       | PASS      | `evidence/s8-record.json`                                                                                | GET `/api/ledger/record/20` → `{ok:true, kind:"task", record:{id:"20", title:"Per-Task .md mirror generator + render surface", subtasks:[…16]}, mirrorFilename:"ID-20.md", mtime:"<ISO>"}`. GET `record/999` → `{ok:false, error:"record-not-found", recordId:"999"}` HTTP 404. |
| 9  | 3       | 29, 36, 38  | PASS      | `evidence/s9-resp.json`, `evidence/s9-body.json`; on-disk JSON + ID-20.md mirror reflect new `status_note` | `{ok:true, recordId:"20", newMtime:"<advanced ISO>", mirrorsWritten:[30 entries], mirrorsDeleted:[]}`. Canonical JSON updated with `"status_note": "S66 manual-test edit — please revert"`; ID-20.md frontmatter shows same string. Reverted at end of batch via second PATCH carrying recorded pre-test value. |
| 10 | 3       | 38          | PASS w/ note | `evidence/s10-resp.json`, `evidence/s10-body.json`; both `status_note` + `priority_note` persisted; mirror mtime advanced exactly once relative to S9 | Single PATCH carrying two field patches → `mirrorsWritten` length 30 (one tick), both fields persisted on disk. **Note:** implementation regenerates **all 30** mirrors, not just the affected `ID-20.md`. PRODUCT inv 38 says "the affected per-record Markdown mirror(s)" — over-regeneration is functionally correct (output matches truth) but wasteful for large ledgers. Tracker candidate for a future Subtask. |
| 11 | 3       | 37          | PASS      | `evidence/s11-resp.json` HTTP 409 `{ok:false, error:"mtime-mismatch", currentMtime:"<ISO>", hint:"ledger changed underneath you — reload from disk and re-apply your edit"}`; SHA-256 of canonical unchanged across PATCH attempt | mtime-collision detection works; canonical byte-identical post-rejection. |
| 12 | 3       | 29          | PASS      | `evidence/s12-resp.json` HTTP 422 `{ok:false, error:"schema-error", issues:[{code:"invalid_value", values:[…8 enum values], path:["tasks",9,"status"], message:"Invalid option: expected one of …"}]}`; canonical SHA-256 unchanged | ZodError surfaced verbatim with path + canonical enum list + offered message. |
| 13 | 4a      | (SPA-gap)   | PARTIAL   | `apps/server/web/index.tsx` lines 12-22                                                                  | Placeholder source contains `<h1>task-view</h1>` + `<p>The viewer SPA is wired in Subtasks 20.9 (read mode) and 20.10 (edit mode).</p>` per S66 plan expected body. **Not exercised in a browser** — would require launching `bun run --cwd apps/server dev` plus an agent-browser screenshot, neither of which adds signal over the static source check. Vite dev server itself is not part of the bundled CLI (`apps/server/index.ts`). |
| 14 | 4a      | (deferred)  | DEFERRED  | —                                                                                                        | SPA-required (frontmatter table rendering). Scoped to Subtask 20.18 per S66 plan §Critical scoping. |
| 15 | 4a      | (deferred)  | DEFERRED  | —                                                                                                        | SPA-required (Subtask block visual styling). Subtask 20.18. |
| 16 | 4a      | (deferred)  | DEFERRED  | —                                                                                                        | SPA-required (broken-target marker visual). Subtask 20.18. |
| 17 | 4a      | (deferred)  | DEFERRED  | —                                                                                                        | SPA-required (Backlog filter URL state). Subtask 20.18. |
| 18 | 4b      | 26-35, 51   | PASS      | `bun test` → 758 pass / 0 fail (baseline holds before AND after PATCH-tier execution)                    | Edit-affordance + textarea + enum-dropdown + array-edit + cross-doc-links-edit + localstorage-drafts + save-error + no-transition-enforcement + details-edit suites all green. In-browser hydration deferred to Subtask 20.18. |
| 19 | 5       | 42          | PASS      | `evidence/s19-help.txt`, `evidence/s19-version.txt`                                                       | `--help` prints usage block naming `--no-browser`, `--port <N>`, `--check`; `--version` prints `task-view 0.1.0`; both exit 0. |
| 20 | 5       | 42, 5       | PASS      | `evidence/s20-check.txt`                                                                                  | `task-view --check: task-list OK (30 mirrors written, 0 orphans deleted).`; exit 0. |
| 21 | 5       | 42, 48      | PASS      | `task-view --check: failed to read or parse … JSON Parse error: Unexpected EOF`; exit code **3** | Matches PRODUCT inv 48 (fail-on-load on bad JSON) for the `--check` path. Server-launch path is the failure surface S6 covers. |
| 22 | 5       | 43          | PASS      | `evidence/s22-multi.txt` — `Found 3 ledger JSON files in <dir>:` numbered list; `Launching against [1].`; second branch zero-ledger → `No known ledger JSON files found in /private/tmp/empty-dir. … Pass an explicit path …` exit 1 | Note: numbered list orders by readdir (alphabetical) so `[1]` is `product-roadmap.json` rather than the brief-imagined `task-list.json`. PRODUCT inv 43 does not constrain ordering — PASS. |
| 23 | edge    | 49          | PARTIAL   | Test fixture set up (`python3 -m http.server 3000`) but task-view bound 3000 anyway — Bun's bind semantics or process timing skipped the collision path. Functionality is covered by `tests/integration/port-retry.test.ts` (green in baseline 758/0). | At-CLI repro of port-exhaustion-after-5 was not forced — practical exhaustion is hard to demonstrate from a sandbox without manual port hold. |
| 24 | edge    | 50          | DEFERRED  | Functionality covered by `tests/integration/browser-close.test.ts` (green in baseline 758/0). 30s wall-clock wait not exercised under the token budget. |
| 25 | edge    | 44          | PARTIAL   | `HOST=0.0.0.0 task-view …` had no effect — CLI does not plumb env vars or a `--hostname` flag through to `startTaskViewServer`. Loopback gating is covered by `tests/integration/loopback-bind.test.ts` (green in baseline) which exercises `startTaskViewServer({hostname:"0.0.0.0"})` directly. |
| 26 | edge    | 6           | **GAP**   | `bun apps/server/index.ts /tmp/kh-canonical/tasks/ID-20.md --no-browser --check` → `task-view --check: failed to read or parse … JSON Parse error: Invalid number` (treats the `.md` mirror as a ledger path) | PRODUCT inv 6 requires walking up to the sibling JSON + preselecting the named record. `packages/server/path-resolution.ts` carries the helper; `apps/server/index.ts` only calls `scanForLedgers` via `inferPathFromCwd`, never the record-path resolver. **Path-resolution wiring missing — open as follow-up Subtask.** |

**Verdict roll-up:** 14 PASS / 2 FAIL (stop-the-line: S5, S6) / 5 PARTIAL (S1, S13, S23, S25, S10*) / 1 GAP (S26) / 5 DEFERRED (S14, S15, S16, S17, S24).

\* S10 marked PASS-with-note above; counted as PASS in the roll-up.

## Stop-the-line escalation

S5 + S6 are listed as stop-the-line FAILs in the brief. Both are **the same defect class** — bare server-launch path does not enforce PRODUCT inv 4 + 48 on load. Mitigations that limit the blast radius:

- `--check` path correctly returns non-zero exit codes (4 and 3 respectively).
- Server-launch path's first `/api/ledger` GET returns HTTP 422 with the same diagnostic. No canonical data can be mutated against a malformed/unknown ledger because every write path goes through `readCanonical` which fails on the same parse/document-name step.
- Net user impact: a developer who runs `task-view <bad-ledger>` sees `Server ready at …` followed by a 422 in the browser — not a silent partial-render.

Because the data-safety contract is held by the deeper layers, the FAIL is **a UX defect, not a data-corruption defect**. Recommended remediation Subtask:

> **Subtask 20.X — Fail-on-load at server launch.** Move the
> `readCanonical` + `detectSchema` invocation into `apps/server/index.ts`
> ahead of `startTaskViewServer` so launching against an unparseable /
> unknown-document_name ledger exits non-zero before the port bind, with
> the formatted Zod error / `document_name` diagnostic on stderr.

This is recorded as a recommended follow-on Subtask alongside Subtask 20.18 (SPA scenarios).

## Coverage matrix vs PRODUCT.md (55 invariants)

| inv | Scenario(s) | Verdict | Coverage source / deferred rationale |
|-----|-------------|---------|---------------------------------------|
| 1   | —           | (repo)  | Fork identity — Slice 1 verified by Checker review of fork-prep commits + `package.json` name/version + LICENSE files. |
| 2   | 19, 20, 21, 22 | PASS | Dual entry — CLI path verified. Plugin slash-command path covered by `tests/integration/plugin-launch.test.ts` (green in 758/0). |
| 3   | 7, 8        | PASS    | Vendored Zod schemas — JSON shape implies parse worked end-to-end. |
| 4   | 5, 7, 8     | FAIL    | Launch-path enforcement missing (S5 FAIL); GET-path enforcement (S7, S8) correct. |
| 5   | 1, 2, 4, 20 | PARTIAL | Mirror generation idempotency + orphan delete + `--check` sync all PASS; **launch-time auto-regen missing** (S1 PARTIAL). |
| 6   | 26          | GAP     | Record-level path resolution wiring missing in `apps/server/index.ts`. |
| 7   | 3           | PASS    | Frontmatter + description + Subtasks section verified in `ID-20.md`. |
| 8   | 3, 18       | PASS    | Subtask block markup + journal-block preservation. |
| 9   | (covered by fixture) | DEFERRED | Empty Subtasks section — covered by `empty-ledger-task-list.json` fixture in `task-view-fixtures/` but visual verification SPA-only; defer to 20.18. |
| 10  | 3, 18       | PASS    | CommonMark + GFM markdown floor — verified in mirror rendering + `markdown-renderer.test.tsx`. |
| 11  | 3           | PARTIAL | Cross-doc-link rendering in mirror YAML preserved; **visual broken-target marker SPA-only** (defer to 20.18). |
| 12  | 3           | PARTIAL | Dependencies rendering in mirror; broken-target page-top warning SPA-only. |
| 13  | 3           | PARTIAL | Sibling-Subtask in-page anchor preserved in mirror; active-scroll behaviour SPA-only. |
| 14-19 | (deferred) | DEFERRED | **Roadmap mode** — requires SPA. Additionally blocked by Side-observation 1 (live KH roadmap is `themes[]` shape; vendored schema requires `sections[]`). Defer to 20.18 **after** re-vendor (Side-observation 1). |
| 20-25 | (deferred) | DEFERRED | Backlog mode — requires SPA. Defer to 20.18. |
| 26-28 | 18         | PASS    | Edit affordances SSR + helpers covered by suite; in-browser deferred to 20.18. |
| 29  | 12          | PASS    | Schema validation + ZodError surface verified at JSON wire. |
| 30-33 | 18         | PASS    | Enum dropdowns + no transition enforcement — SSR coverage. |
| 34-35 | 18         | PASS    | Array editors + DocLink form — SSR coverage. |
| 36  | 9, 10, 11   | PASS    | Atomic write — temp + rename + no partial file on 409. |
| 37  | 11          | PASS    | mtime collision → 409 + hint message verified. localStorage draft preservation deferred to 20.18. |
| 38  | 10          | PASS w/ note | Multi-field single regen tick verified. Implementation regenerates all mirrors not just affected — over-eager, candidate for follow-up Subtask. |
| 39  | 4, 11       | PASS    | External regen detection (mtime); orphan deletion. |
| 40  | 1           | PARTIAL | Mirror absence tolerance — POST regen path works; bare server-launch auto-regen missing (same root cause as S1). |
| 41  | (deferred)  | DEFERRED | Plugin slash command — `claude plugins list` exercise out of agent-browser scope. |
| 42  | 19, 20, 21  | PASS    | CLI flag surface complete. |
| 43  | 22          | PASS    | CWD scan numbered + zero-ledger friendly miss. |
| 44  | 25          | PARTIAL | Loopback gate covered by unit test; CLI does not expose `--hostname` or env passthrough. |
| 45  | (transitive) | PASS   | Cross-project — exercised via stripped KH ledger + fixtures. |
| 46  | (out-of-scope) | DEFERRED | ID-22 ledger relocation — re-verify post-ID-22. |
| 47  | (fixture)    | PARTIAL | Empty-ledger fixture authored at `task-view-fixtures/empty-ledger-task-list.json`; empty-state page render SPA-only. |
| 48  | 6, 21       | FAIL/PASS | `--check` path PASS (S21); server-launch path FAIL (S6). |
| 49  | 23          | PARTIAL | Unit-test coverage; CLI repro inconclusive. |
| 50  | 24          | DEFERRED | Unit-test coverage; 30s wall-clock not exercised. |
| 51  | 18          | PASS    | localStorage draft helpers covered by SSR suite. |
| 52  | (transitive) | PASS   | Cross-platform — mirror filenames + forward-slash hrefs verified in `ID-20.md`. |
| 53  | (deferred)  | DEFERRED | Keyboard nav — SPA-only. |
| 54  | 3           | PASS    | Plain-text status / priority dropdowns — no colour tokens in mirror frontmatter. |
| 55  | 3, 19       | PARTIAL | Mirror frontmatter preserves canonical ISO 8601 (no DD/MM/YYYY conversion in mirrors); CLI `--help` output is UK-English-neutral (no "color"/"organization" strings); display-formatting DD/MM/YYYY check belongs to the SPA layer (20.18). |

### Invariants intentionally NOT covered (with justification)

- **inv 14-25 (Roadmap + Backlog modes)**: blocked by SPA wiring (20.17) and partially by schema drift (Side-obs 1). Defer to 20.18.
- **inv 23, 24, 25, 26-28, 30-33, 51, 53**: SPA-only — defer to 20.18.
- **inv 41 (plugin slash command)**: requires real Claude Code plugin install path. Out of agent-browser scope.
- **inv 46 (ID-22 ledger relocation)**: forward-compat check; re-verify post-ID-22.

## Side-observations (for Curator triage)

1. **Schema drift — Roadmap `themes[]` vs vendored `sections[]`.** Live KH
   `docs/reference/product-roadmap.json` (branch `production-readiness`)
   uses the `themes[]` shape ratified in KH Subtask 30.12 (PR-C reshape).
   The vendored `packages/schemas/src/roadmap-schema.ts` (Wave A.1 vintage)
   still requires the legacy `sections[]` shape. As a result, task-view
   **cannot parse the live KH product-roadmap.json**. Re-vendor is
   required before any of Roadmap-mode invariants 14-19 can be exercised
   against real KH data. Recommended Subtask: **Re-vendor schemas from
   knowledge-hub-production-readiness `lib/validation/` after 30.x reshape
   land.**

2. **Schema drift — `Task.capability_theme` field.** Live KH
   `task-list.json` carries `capability_theme: "<theme-id>"` on every
   Task entry (introduced in KH Phase B). The vendored `TaskSchema` is
   declared `.strict()` and rejects the field. Effect: a fresh task-view
   pointed at live KH `task-list.json` returns HTTP 500 / 422 errors on
   every `/api/ledger` and `--check` invocation. **All scenarios in this
   report ran against a stripped copy** (`jq '.tasks |=
   map(del(.capability_theme))' > /tmp/kh-canonical/task-list.json`).
   Same recommended re-vendor Subtask as #1; alternatively, soften the
   vendored `TaskSchema` to `.passthrough()` so future KH additions don't
   break ingestion.

3. **Auto-regen on launch missing.** PRODUCT inv 5 + inv 40 imply that
   pointing task-view at a ledger generates mirrors as part of "routing
   succeeds". Current implementation only regenerates mirrors on POST
   `/api/ledger/regen`, on PATCH, or under `--check`. Bare server launch
   prints `Server ready at …` without writing any mirror file. The SPA
   would normally trigger regen via its first GET; SPA-gap means there's
   no trigger. **Subtask 20.17 should wire `generateMirrors()` into the
   GET `/` handler (or directly into `startTaskViewServer`) so the
   first-launch experience matches PRODUCT inv 40's "robust to mirror
   absence … generates them on the fly" promise.**

4. **Launch-path fail-on-load missing (S5/S6 root cause).** PRODUCT
   inv 4 + inv 48 require non-zero exit on load when `document_name` is
   unknown or JSON is unparseable. Server-launch path defers the failure
   until first `/api/ledger` GET. Mitigations: `--check` path enforces
   correctly (S20/S21); deeper write paths all gate on `readCanonical`
   so no canonical mutation can occur. **Remediation Subtask:** move the
   `readCanonical` + `detectSchema` invocation into `apps/server/index.ts`
   ahead of `startTaskViewServer` so the process exits before port bind.

5. **Multi-field PATCH over-regenerates.** PRODUCT inv 38 says
   "the affected per-record Markdown mirror(s)" — implementation
   regenerates **all** mirrors on every PATCH (`mirrorsWritten` length
   = full ledger size). Functionally correct; wasteful at the 30-record
   scale, more wasteful as KH grows. **Optimisation candidate Subtask.**

6. **Record-level path resolution not wired into CLI (S26).** PRODUCT
   inv 6 calls for `task-view docs/reference/tasks/ID-20.md` → walk up
   to sibling JSON + preselect record. Helper exists at
   `packages/server/path-resolution.ts`. `apps/server/index.ts`'s
   `inferPathFromCwd` only invokes `scanForLedgers`. **Wiring Subtask:**
   detect `.md` suffix on positional arg + delegate to the resolver
   before falling through to `existsSync` checks.

7. **Numbered-list ordering (S22).** The CWD scan numbered list orders
   by readdir (alphabetical). `[1]` for the multi-ledger fixture dir is
   `product-roadmap.json` rather than the brief-imagined
   `task-list.json`. PRODUCT inv 43 does not constrain ordering — not a
   defect — but worth noting if KH wants a deterministic
   "task-list first" preference.

## Teardown verification

- KH canonical task-list.json **was not mutated by this smoke-test** —
  all PATCH operations ran against `/tmp/kh-canonical/task-list.json`,
  not the KH worktree. `git -C
  /Users/liamj/Documents/development/knowledge-hub-production-readiness
  status docs/reference/` reports no modifications.
- The KH canonical SHA-256 **does** differ from the snapshot taken at
  run start because the KH parent session committed Subtask 32.11 flips
  (commits `51da4ae3` + `242f57cf`) on `production-readiness` during the
  run. Those commits touch `task-list.json` independently of the
  smoke-test and are out-of-scope to this report.
- `bun test` post-run: 758 pass / 0 fail (matches pre-run baseline).
- Fixture artefacts committed under `docs/test-plans/task-view-fixtures/`.

## Follow-up Subtasks recommended for KH session

| Slot | Subject | Rationale |
|------|---------|-----------|
| 20.18 | SPA-rendered scenario coverage (14-17 + 23-28 + 30-33 + 51 + 53) | Already planned by S66 — runs after 20.17 SPA wiring lands. |
| 20.19 (proposed) | Re-vendor schemas from KH `lib/validation/` post-30.x reshape | Side-observation 1+2 — without it, task-view cannot parse live KH ledgers. |
| 20.20 (proposed) | Launch-path fail-on-load for bad document_name / parse failure | Side-observation 4 — closes S5+S6 FAIL. |
| 20.21 (proposed) | Wire record-level path resolution into CLI entrypoint | Side-observation 6 — closes S26 GAP. |
| 20.22 (proposed) | Auto-regenerate mirrors on `startTaskViewServer` boot | Side-observation 3 — closes S1 PARTIAL (becomes PASS post-20.17 or here directly). |
| 20.23 (proposed) | Restrict multi-field PATCH regen to affected mirrors only | Side-observation 5 — perf optimisation. |
