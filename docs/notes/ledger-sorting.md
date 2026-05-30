# Note: ledger sorting (future enhancement)

Status: **investigated, not scheduled.** Captures what enabling user-driven
sorting on the ledger index views would require. Written 2026-05-30 alongside
the filter-bug fix (which sorting would reuse the wiring pattern of).

## TL;DR

| Ledger | Feasibility | Blocker |
|--------|-------------|---------|
| task-list | Easy | none — read-only list, raw array order today |
| roadmap | Easy | none — read-only list, raw array order today |
| backlog | Medium–high | collides with `rank` + drag-reorder |

The two read-only index views can gain sorting cheaply. The backlog cannot
without a design decision, because its order is a persisted, user-owned `rank`
that drag-reorder mutates.

## How ordering works today

- **Backlog** — hardcoded sort `priority → rank (nulls last within tier) → id`
  in `sortBacklogItemsForIndex` (`packages/ui/record-view/backlog-sort.ts:52`),
  applied at `backlog-index-view.tsx:75`. Tiers render contiguous; drag-reorder
  mutates `rank` within a tier (client: `apps/server/web/index.tsx`, tier-run
  bounds ~`:924`, cross-tier refusal ~`:1310`; rank recompute in
  `packages/ui/record-view/backlog-reorder.ts`).
- **task-list** — no sort. Renders `tasks[]` in JSON array order
  (`packages/ui/record-view/task-list-index-view.tsx`).
- **roadmap** — no sort. Renders `themes[]` in array order
  (`packages/ui/record-view/roadmap-index-view.tsx`).

## The pattern to reuse (filters)

Sorting should mirror the filter round-trip exactly:

1. SSR decodes URL state → applies it before render.
   Filter side: `decodeBacklogFilters` (`url-state.ts:62`) called at
   `packages/server/render-viewer.tsx:232`, applied via `applyBacklogFilters`.
2. SSR emits inert controls carrying `data-*` hooks.
3. Client wires a `change`/`click` listener that rebuilds the query string and
   navigates. Filter side: `wireBacklogFilters()` in `apps/server/web/index.tsx`
   (added 2026-05-30), modelled on `wireThemePicker()` (~`:857`).

State in the URL keeps the view bookmarkable/shareable (PRODUCT inv 23).

## Work to add sorting (task-list + roadmap only)

- New `task-list-sort.ts`, `roadmap-sort.ts` mirroring `backlog-sort.ts`
  (pure sort fn `(items, sort) => sorted[]`). + unit tests.
- Generalise `BacklogFilterState` (`url-state.ts:48`) to carry a `sort`
  field, e.g. `{ field: string | null; direction: "asc" | "desc" }`; add
  `decodeSort`/`encodeSort` and fold into the existing decode/encode round-trip.
- Index views: call the sort helper after filtering; render clickable column
  headers (`data-sort-trigger="<field>"`) with an asc/desc indicator.
- Client: add `wireSortControl()` (mirror `wireThemePicker`/`wireBacklogFilters`)
  → encode sort to URL → navigate. Wire in `init()`.

Rough effort: ~3–5 days incl. tests for the two read-only views.

## The backlog problem

A user sort conflicts with the persisted `rank` model:

- Sorting by anything other than priority breaks the **tier-contiguity**
  invariant the drag-reorder DOM logic depends on.
- A non-rank sort overrides the user's manually-set order; after a drag the
  ranks change and a live sort would make rows jump.

Options if backlog sorting is ever required (decreasing safety):

1. **Reject** sort on backlog — it stays a rank/prioritisation board. (Lowest
   risk; recommended default.)
2. **Within-tier ephemeral sort** — sort only inside each priority tier; drag
   still writes rank. Needs defined post-drag re-apply behaviour.
3. **Disable drag while a sort is active** — mixed interaction model + a
   "reset sort" affordance.

Defer until there's a product decision on rank-vs-sort.

## Related

UI delete of a backlog record was investigated the same day: the server
endpoint **already exists** (`DELETE /api/ledger/record/:recordId`,
`packages/server/patch-server.ts:862`), so that work is client-wiring only —
the riskiest part there is dangling refs (other items' `dependencies[]`,
roadmap `linked_backlog[]`), which the schema does not enforce.
