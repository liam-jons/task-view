# {20.29} Cross-ledger navigation — DESIGN + PLAN

Status: DRAFT (authored by Planner; uncommitted). Authoritative deliverable is the
Planner's returned message — this file is a working aid for the Executor.

Fork: `/Users/liamj/Documents/development/task-view` (separate repo from KH).
Parent: KH Task ID-20 (task-view render surface), lands as Subtask {20.29}.

## 0. Problem (verified against the running code, not re-derived)

`renderViewer()` (`packages/server/render-viewer.tsx`) is a synchronous pure function that
takes ONE parsed `detected` ledger and routes purely on `?record=<id>`. The launched
server holds exactly one `ledgerPath` (`RequestContext`, `patch-server.ts:116`); every
request `readCanonical(ctx.ledgerPath)` fresh (no parsed cache).

The roadmap theme renderer ALREADY emits cross-ledger affordances:
`roadmap-theme-view.tsx:119-135` renders `linked_tasks` and `linked_backlog` as
`MaybeRecordLink` with `href = recordRouteHref(id)` → `/?record=<id>`. But:

1. In production, `render-viewer.tsx:179` builds the ledger context with ONLY
   `{ roadmap: detected.data }`, so `taskIds` / `backlogItemIds` are EMPTY →
   `existsFor(id)` is always `false` → every `linked_tasks` / `linked_backlog` link
   renders with the strikethrough `(missing)` broken-target treatment.
2. Even if it rendered live, `/?record=15` resolves against the LAUNCHED roadmap ledger,
   where theme id `15` does not exist → `renderNotFound("roadmap-theme", "15")` → HTTP 404.

The unit test `roadmap-theme-view.test.tsx:119` PASSES because it injects
`tasks: [mkTask("20")]` into `buildLedgerContext` — exactly the S269 false-confidence
trap: green unit test, broken live viewer. {20.29} closes this read-side gap and makes the
fix observable against a real running server.

## 1. Real data verified in live fixtures (`tests/fixtures/live-ledgers/`)

| Edge | Field (real name) | Direction | Verified count | Example |
| --- | --- | --- | --- | --- |
| Task → Roadmap | `task.capability_theme` (string \| null, optional) | forward | 23 / 35 tasks set | task `6` → theme `10`; task `9` → theme `11` |
| Roadmap → Task | `theme.linked_tasks` (string[]) | forward | 27 refs, 25 unique | theme `10` → `[6,7,8,10,15,16,18,...]`; theme `3` → `[28,45,46]` |
| Roadmap → Backlog | `theme.linked_backlog` (string[]) | forward | 113 refs | theme `1` → `[40,42,43,44]`; theme `2` → `[54,55,56,57]` |
| Backlog → * | (none) | — | — | backlog items have NO `capability_theme` / `linked_tasks` |
| any → file | `cross_doc_links[]` (DocLink {path, anchor, raw}) | forward | 5 task entries target sibling JSON | `docs/reference/task-list.json#id-20`, `#id-34` |

- Theme ids `3, 8, 10, 11` (the distinct `capability_theme` values) all resolve to real
  themes. `linked_tasks` ids resolve to real tasks; `linked_backlog` ids resolve to real
  backlog items. All ids are bare-digit (no `ID-` prefix) in BOTH the pointer field and
  the target record's `.id`.
- `document_name` values: `Knowledge Hub Task List`, `Knowledge Hub Roadmap`,
  `Product Backlog` (`detect-schema.ts:38-42`). Note the live fixture roadmap is
  `Knowledge Hub Roadmap` (NOT `product-roadmap.json`-named in resolveTransactionSiblings,
  which hardcodes task-list + backlog only — the nav path must map all three).

## 2. URL scheme (back-compatible)

`/?ledger=<task-list|roadmap|backlog>&record=<id>`

- `ledger` omitted → launched ledger (bare `/?record=<id>` unchanged — full back-compat).
- `ledger` present + equals the launched ledger's slug → identical to omitting it.
- `ledger` present + names a SIBLING → server resolves sibling `document_name` → path via
  `scanForLedgers(dirname(ctx.ledgerPath))`, reads it with `readCanonical`, renders that
  ledger's record.
- Slug ↔ document_name map (stable, server-owned):
  `task-list ↔ "Knowledge Hub Task List"`, `roadmap ↔ "Knowledge Hub Roadmap"`,
  `backlog ↔ "Product Backlog"`.

## 3. Composition with inv 43 + 20.15

- **One-ledger-per-launch preserved.** The launched `ledgerPath` stays the single mutation
  target. Siblings are loaded READ-ONLY, per-request, only to render a nav target.
- **Sibling records are READ-ONLY in nav (recommended + ratified call).** When a page is
  served for a sibling ledger, the renderer suppresses ALL edit affordances (no
  `FieldPencil`, no `data-edit-*`) and shows a read-only banner. Justification: inv 43's
  contract is a single editable ledger per launch; the patch/create/delete/transaction
  endpoints all bind `ctx.ledgerPath` and have no sibling-write path. Allowing sibling
  edits would silently break that contract and require a write-side redesign. Read-only is
  the safe default; editing a sibling means relaunching task-view against it.
- **Reuses `scanForLedgers` exactly as the txn endpoint does** (`patch-server.ts:862-883`
  `resolveTransactionSiblings`). New helper `resolveLedgerPathByName(ledgerPath, name)`
  shares the same scan + `byName` map shape.

## 4. Edge model + reverse/missing handling

- Forward edges drive nav from the field-bearing side:
  - Roadmap theme page: `linked_tasks` → `ledger=task-list&record=<id>`; `linked_backlog`
    → `ledger=backlog&record=<id>`.
  - Task page: `capability_theme` → `ledger=roadmap&record=<themeId>` (new chip).
- Reverse edges WITHOUT a typed field are NOT synthesised in {20.29} (scope guard):
  - Backlog → Roadmap / Task: no pointer field exists. Out of scope. A future inverse
    index (computed from the sibling roadmap's `linked_backlog`) is a separate Subtask —
    flagged as OQ-P1 (cross-Task, needs Orchestrator).
  - Task → linked siblings beyond `capability_theme`: covered by the roadmap hub; not
    duplicated on the Task page.
- `cross_doc_links` whose `path` is a sibling ledger JSON + `#id-N` anchor: KEEP the
  existing doc-link affordance (20.27) as the default (it is a file-path link, semantically
  distinct). Do NOT auto-promote to a record jump in {20.29} — flagged OQ-P2 (anchor
  grammar `#id-N` → record id is a parsing decision; defer).
- Broken cross-ledger target (sibling exists, record id absent): render `BrokenLink`
  `(missing)` exactly as intra-ledger, computed against the SIBLING's id set the server now
  resolves.

## 5. Server resolution (handleGetRoot / renderViewer)

`handleGetRoot` is already `async` and holds `ctx.ledgerPath`. New flow:

1. Parse `ledger` slug from `search`. If absent or equals launched slug → existing path
   unchanged.
2. If a sibling slug: `targetPath = await resolveLedgerPathByName(ctx.ledgerPath, name)`.
   - `null` (sibling file not in dir) → 404 HTML "Linked ledger not available" + back link.
3. `siblingCanonical = await readCanonical(targetPath)`; on read/parse failure → 404 HTML
   (not 500 — a broken sibling is a navigation dead-end, not a server fault) with a
   diagnostic + back link.
4. Pass the sibling `detected` + a `readOnly: true` flag into `renderViewer`. Record lookup
   inside `renderViewer` is unchanged (`find(t => t.id === record)`); missing → existing
   `renderNotFound` (404).

Cross-ledger LINK BUILDING (the read fix): the renderer needs each linked record's id set
to compute `exists`. Two viable approaches — Executor picks during slice 2:
- (A) Thread sibling id sets into `buildLedgerContext` at render time (server reads sibling
  ledgers once per request to populate `taskIds` / `backlogItemIds` for the CURRENT page's
  outbound links). Most faithful to broken-target semantics.
- (B) Render outbound cross-ledger links as live `<a>` UNCONDITIONALLY (no pre-flight
  existence check) and let the target navigation 404 surface the break. Cheaper; loses the
  inline `(missing)` marker. Recommend (A) for roadmap→task/backlog (the high-traffic edge)
  and accept that capability_theme (single value) can use either.

## 6. UX

- **Cross-ledger links carry a leaving-ledger signal.** New `CrossLedgerLink` primitive
  (or a `crossLedger` prop on `MaybeRecordLink`) renders `data-cross-ledger="<slug>"` plus a
  small trailing glyph/badge (e.g. ` ↗` or a `[roadmap]` tag) so the user sees the link
  leaves the current ledger. Distinct from intra-ledger `data-record-link`.
- **capability_theme chip** on the Task frontmatter card: a new row "Capability theme" →
  clickable chip `theme N: <title>` linking to `?ledger=roadmap&record=<themeId>`. Theme
  title resolved server-side from the sibling roadmap (or shown as bare id if sibling
  absent).
- **"Which ledger am I in" + getting back:** when viewing a SIBLING (read-only), the
  nav-strip / a banner shows: ledger name badge ("Roadmap — read-only, launched ledger is
  Task List"), and a "Back to launched ledger" link (to `/`). The nav-strip's prev/next
  stay WITHIN the sibling ledger; `indexHref` for a sibling points at
  `?ledger=<sibling>` (sibling index) and a separate "launched ledger" link returns to `/`.
- Affordances render in the existing surfaces: roadmap `linked_tasks` / `linked_backlog`
  sections (already present, fixed to be live + cross-ledger), Task frontmatter card (new
  capability_theme row).

## 7. Implementation plan (TDD slices)

Test command in this fork is `bun test` (NOT `bun run test`; root `package.json` script is
`"test": "bun test"`). Each slice: write the failing test first, then the impl.

1. **Slug ↔ document_name map + sibling path resolver.**
   - New: `packages/server/cross-ledger.ts` — `LEDGER_SLUGS`, `slugForDocumentName()`,
     `documentNameForSlug()`, `resolveLedgerPathByName(ledgerPath, name)` (wraps
     `scanForLedgers(dirname(ledgerPath))`, returns path | null).
   - Test: `packages/server/cross-ledger.test.ts` — slug round-trips; resolver returns the
     right sibling path against `tests/fixtures/live-ledgers/`; returns null when absent.
2. **URL parse + outbound href builder.**
   - Modify: `packages/ui/record-view/anchors.ts` — add
     `crossLedgerRecordHref(slug, id)` → `/?ledger=<slug>&record=<id>`. Keep
     `recordRouteHref` for intra-ledger.
   - Modify: `packages/ui/record-view/url-state.ts` — add `decodeLedgerParam(search)` →
     slug | null.
   - Tests: extend `anchors.test.ts`, `url-state.test.ts`.
3. **Cross-ledger link primitive + leaving-ledger signal.**
   - Modify: `packages/ui/record-view/broken-target.tsx` — add `CrossLedgerRecordLink`
     (or `crossLedger?: slug` on `MaybeRecordLink`) emitting `data-cross-ledger`.
   - Test: `broken-target.test.tsx` — live link has `data-cross-ledger`, missing → broken.
4. **Wire roadmap theme outbound edges to cross-ledger (the visible read fix).**
   - Modify: `roadmap-theme-view.tsx` — `linked_tasks` → `crossLedgerRecordHref('task-list', id)`,
     `linked_backlog` → `crossLedgerRecordHref('backlog', id)`; `existsFor` reads a sibling
     id set threaded via `LedgerContext` (approach A).
   - Modify: `types.ts` `LedgerContext` + `buildLedgerContext` — accept optional sibling id
     sets.
   - Test: update `roadmap-theme-view.test.tsx` expectations to the new hrefs.
5. **capability_theme chip on Task page.**
   - Modify: `task-list-view.tsx` — add "Capability theme" frontmatter row (only when
     `task.capability_theme` set) → `crossLedgerRecordHref('roadmap', themeId)`.
   - Test: `task-list-view.test.tsx`.
6. **Server sibling read + render (the route fix).**
   - Modify: `render-viewer.tsx` — `renderViewer` accepts the (already-read) sibling
     `detected` + `readOnly` flag; populate sibling id sets for outbound links; suppress
     edit affordances when `readOnly`.
   - Modify: `patch-server.ts` `handleGetRoot` — parse `ledger`, resolve sibling path,
     `readCanonical(siblingPath)`, render; 404 HTML on absent/broken sibling.
   - Tests: `render-viewer.test.tsx` (readOnly suppresses pencils; cross-ledger record
     resolves), `patch-server.test.ts` (GET `/?ledger=roadmap&record=10` → 200 with theme
     content; `?ledger=task-list&record=15` from a roadmap launch → 200 task content;
     absent sibling → 404; bare `/?record=` unchanged).
7. **Read-only banner + "back to launched ledger".**
   - New: `packages/ui/record-view/ledger-banner.tsx` — banner naming the sibling ledger +
     launched-ledger return link; mounted by `renderViewer` when `readOnly`.
   - Test: `ledger-banner.test.tsx` + assertion in `render-viewer.test.tsx`.

### Agent-browser-observable behaviours (the live gate)
- Launch `task-view tests/fixtures/live-ledgers/product-roadmap.json --no-browser`; GET
  `/?record=10` → DOM contains `data-section="linked_tasks"` with a live `<a>` whose href
  is `/?ledger=task-list&record=6` (NOT `(missing)`, NOT `/?record=6`).
- Click that link → server returns 200, page shows `data-record-kind="task"`
  `data-record-id="6"` with the real Task 6 title, AND a read-only ledger banner.
- Launch against `task-list.json`; GET `/?record=6` → frontmatter card has a "Capability
  theme" chip linking to `/?ledger=roadmap&record=10`; click → 200 theme 10 page.
- GET `/?ledger=roadmap&record=999` → 404. GET `/?ledger=task-list&record=10` when the
  task-list sibling is absent from the dir → 404 "linked ledger not available".

## 8. OQs
- **OQ-P1 (cross-Task, escalate):** Backlog → Roadmap/Task reverse nav needs either a new
  schema pointer field on KH backlog items OR a server-computed inverse index. Decision
  changes KH ledger schema → Orchestrator/Curator call. NOT decided here.
- **OQ-P2 (in-fork, deferred):** Should a `cross_doc_links` entry whose path is a sibling
  ledger JSON + `#id-N` anchor become a record jump? Default: keep as doc-link (20.27).
  Revisit as a follow-on once the anchor→id grammar is ratified.
- **OQ-P3 (in-fork, resolve = read-only):** Sibling editability — resolved READ-ONLY (§3).
  If Liam wants sibling editing, that is a new Task touching the write-side contract.
