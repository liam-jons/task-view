# SPEC — Interactive Backlog drag-reorder + keyboard-reorder

Status: ready-to-implement
Owner: task-view fork (Knowledge Hub Task ID-20 follow-on)
Scope: COMPLETE the deferred interactive drag + keyboard reorder layer on the
Backlog index page. The SSR scaffolding already shipped (branch `feat-30.8`,
merged). This SPEC builds the interactive behaviour on top of it.

> This document is drag-reorder ONLY. It does NOT cover the separate
> cross-ledger doc-links 404 defect (QC finding B / OQ-P2). That is a distinct
> gap with its own owner.

---

## 0. Background — what already exists (verified)

The drag-reorder *scaffolding* is live SSR markup with stable `data-*` hooks
but **no JS wiring**. QC confirmed the handle is decorative: dispatching
`dragstart` / `mousedown` / `keydown(ArrowDown)` on a handle fires zero `/api`
requests and leaves row order unchanged. The only working reorder path today is
the rank pencil.
(Root-cause: `/tmp/claude/s271-reports/subo-id-20-exploratory-qc.yaml` finding
A; screenshot `/tmp/claude/s271-reports/qc-backlog-index-draghandles.png`.)

### 0.1 Existing SSR hooks (file:line — verified)

`packages/ui/record-view/backlog-index-view.tsx`:

| Hook | Location | Emitted markup |
|---|---|---|
| Table marker | line 137-141 | `<table class="record-view-backlog-table" data-backlog-table data-supports-drag-reorder="true">` |
| Row marker | line 201-204 | `<tr data-backlog-row="{id}" data-priority-tier="{priority}">` |
| Drag handle | line 205-217 | `<span data-drag-handle="{id}" role="button" tabIndex={0} aria-label="Reorder backlog item {id}" data-keyboard-shortcut="arrow-up,arrow-down,enter">` (glyph `☰`, `aria-hidden`) |
| Rank cell | line 235-257 | `<td class="record-view-rank-cell" data-rank-value="{rank or ''}">` with `.record-view-rank-value` span + the pencil button (suppressed when read-only) |
| Rank pencil | line 242-256 | `<button data-edit-action="open" data-edit-field="items>{id}>rank" data-edit-kind="integer-nullable">` — only rendered when `!useReadOnly()` |

The file header comment `backlog-index-view.tsx:26-31` records the deferral:
*"Interactive drag and keyboard reorder land with the SPA mount, which is out of
30.8 scope."*

### 0.2 The sort contract (verified)

`packages/ui/record-view/backlog-sort.ts` — `sortBacklogItemsForIndex(items)`
sorts by, in order:

1. **priority ordinal** — `PRIORITY_ORDINALS` (line 33-42):
   `must:0, should:1, could:2, future:3, high:4, medium:5, low:6, trigger:7`.
2. **rank within tier, nulls last** — `null` rank sorts after every ranked item
   in the same tier (line 63-70).
3. **id, numeric-friendly** — `"10"` sorts after `"9"` via `parseInt` (line 73-80).
4. stable tiebreaker on input order.

Pure / deterministic / no DOM. This is the contract the persisted ranks MUST
reproduce: **after a reorder PATCH, reloading the page and re-sorting must show
the order the user dropped.**

### 0.3 The schema (verified)

`packages/schemas/src/backlog-schema.ts`:
- `rank: z.number().int().nullable().optional()` (line 156). So a rank is one of:
  an integer, `null`, or **absent** (key omitted entirely). All three are
  schema-valid; `sortBacklogItemsForIndex` treats `null` and absent identically
  (`item.rank ?? null`).
- The schema does **NOT** enforce uniqueness or contiguity of `rank` within a
  tier (comment line 147-149: *"Schema does NOT enforce uniqueness or contiguity
  within tier"*). Densely-renumbered ranks are therefore legal but not required
  by the schema — they are required by *this SPEC's* persistence model so that
  the dropped visual order is unambiguously reproducible.
- `BacklogItemSchema` is **not** `.strict()` — it silently strips unknown keys.
  The patch-apply walker guards against this with a schema-keyset check
  (`patch-apply.ts:325`); a rank-only patch hits a known field so it is safe.
- `BacklogSchema.superRefine` (line 195-210) enforces **unique item ids** at the
  document level. This runs on every re-parse — including our multi-item reorder
  PATCH — so a reorder can never corrupt the id set.

### 0.4 The SPA client dispatcher (verified)

`apps/server/web/index.tsx` is a **document-level delegated event dispatcher**,
NOT a React mount. It currently wires only the rank pencil edit loop. Mechanics
to reuse verbatim:

- `ensureBaseMtime()` (line 82-93): lazily `GET /api/ledger` for `baseMtime` on
  first save; returns the cached value thereafter.
- After a successful save the dispatcher adopts the returned `newMtime`
  (`saveEditor` line 612: `if (outcome.newMtime) baseMtime = outcome.newMtime;`).
- `resolveRecordId(el)` (line 102-107): falls back to the closest
  `[data-backlog-row]` for index-page affordances. (Not directly needed for the
  multi-item reorder PATCH, which targets one URL but carries many fieldPaths —
  see §4.3.)
- Delegated listeners are registered in `init()` (line 865-871):
  `document.addEventListener("click"/"keydown", …)`. New reorder listeners are
  added here.

### 0.5 The patch builders (verified)

`packages/ui/record-view/edit-dispatch.ts`:
- `buildPatchForKind(kind, fieldPath, rawValue)` (line 143) — `integer` case
  (line 169-172) builds `{ fieldPath, newValue: Number(v) }`. Reorder uses plain
  integer patches (never null — see §4.4), so it can construct
  `{ fieldPath: ["items", id, "rank"], newValue: N }` directly or via
  `buildPatchForKind("integer", …)`.
- `buildMultiPatchRequest(patches, baseMtime)` (line 226-231) — **already exists,
  currently unused** — returns `{ patches: [...patches], baseMtime }`. This is
  the wire shape for the atomic multi-item reorder.
- `buildPatchRequest(patch, base)` (line 218-223) — single-patch variant; not
  used by reorder.
- `recordPatchPath(recordId)` (line 239-241) → `/api/ledger/record/:recordId`.
- `classifySaveResult(json)` (in `edit-state.ts`, imported at index.tsx:64) →
  `ok` / `schema-error` / `walk-error` / `mtime-conflict` /
  `mirror-regen-failed` / `network-error`.

### 0.6 The verified persistence model (state precisely — do not re-derive)

The server `applyPatches` (`packages/server/patch-apply.ts`, called by
`handlePatchRecord` `patch-server.ts:526-702`) walks **each** patch's `fieldPath`
**from the ledger root**. For backlog, `applyBacklogPatch` (line 286-333):
`fieldPath[0]` must be `"items"`, `fieldPath[1]` is the **item id**, `fieldPath[2]`
is the field. **The fieldPath is root-rooted and carries the item id itself.**

THEREFORE:

> A **single** `PATCH /api/ledger/record/:anyId` whose body
> `patches[]` array contains
> `{ fieldPath: ["items","A","rank"], newValue: N }`,
> `{ fieldPath: ["items","B","rank"], newValue: M }`, … for **many** items,
> applies **all** of them to one in-memory `structuredClone` snapshot
> (`patch-server.ts:606-613`), re-parses the **whole** ledger with Zod once
> (so `BacklogSchema.superRefine` unique-id check runs — §0.3), and
> **atomic-writes once** (`atomicWriteFile`, line 655). This is the atomic
> multi-item reorder mechanism.

The `:recordId` in the URL is **only** used for:
1. mirror-regen scoping (see §0.7 — the caveat); the walk ignores it entirely.
2. it does NOT need to be one of the reordered items, but for clarity §4.3
   pins it to a deterministic choice.

mtime check happens once, BEFORE apply (`patch-server.ts:578-601`): if the
on-disk mtime is newer than `baseMtime` → `409 mtime-mismatch` and **nothing is
written**. One PATCH = one mtime check = one optimistic-concurrency unit.

### 0.7 Mirror-staleness caveat (verified) + DECISION

`generateRecordMirror` (`patch-server.ts:669-675`) regenerates the mirror for the
URL's `:recordId` **ONLY**. A multi-item reorder PATCH mutates the `rank` of N
items but the URL names exactly one record — so the other N-1 items' on-disk
`.md` mirrors are left **stale w.r.t. rank**.

This does **not** affect the live viewer: every request re-reads canonical JSON
via `readCanonical` and re-sorts with `sortBacklogItemsForIndex`, so the live
surface is always correct after the write. Staleness is purely an on-disk
`.md`-mirror concern.

**DECISION (mirror staleness): after a successful reorder PATCH, the client
issues `POST /api/ledger/regen` (full mirror regen) so on-disk mirrors stay
consistent with the new ranks.**

Justification:
- The endpoint already exists (`handlePostRegen`, `patch-server.ts:1157-1223`;
  routed at `patch-server.ts:1282`). It runs `generateMirrors` over the *whole*
  ledger and accepts an empty body (line 1164-1167: *"Empty body is acceptable
  for regen"*). Optional `baseMtime` check (line 1193-1206) — we send the
  `newMtime` we just adopted, so it never conflicts with our own write.
- A reorder is the **one** edit kind that intrinsically touches multiple records'
  observable on-disk state, unlike a single-field pencil edit. Leaving N-1
  mirrors stale would mean a `grep` of the `.md` mirrors reports the wrong rank
  for items the user just visibly reordered — a surprising, lasting on-disk
  inconsistency the rank pencil never produces (it touches exactly the one
  record whose mirror it regens).
- The regen is a fire-and-forget follow-up: it runs AFTER the reorder PATCH has
  already returned `ok` and adopted `newMtime`. If the regen request itself
  fails, the canonical + live viewer are still correct; the SPEC treats a failed
  follow-up regen as a **soft** outcome (log to console, no user-facing error,
  no rollback) — identical posture to the server's own `mirror-regen-failed`
  soft path (`patch-server.ts:608` / `saveEditor` line 608).

Rejected alternative (accept rank-only mirror staleness as a known minor): the
on-disk inconsistency is real and lasting, and the fix is one extra cheap POST
to an endpoint that already exists. Not worth the documented wart.

---

## 1. Behaviour invariants

These are numbered `DR-N` (Drag-Reorder). They are the acceptance contract.

**DR-1 — Mouse drag reorder.**
The user grabs a row by its drag handle (`[data-drag-handle]`), drags it to a
new position within the table, and drops. On drop the row moves to the dropped
position in the DOM, the affected ranks are recomputed (§4), and the new order
persists via PATCH (§4.3). After a full page reload the order is unchanged
(DR-5).

**DR-2 — Keyboard reorder.**
With a drag handle focused (it is `tabIndex=0 role="button"`):
- **ArrowUp** moves the row up one position **within its tier** (live DOM move,
  no persist yet); **ArrowDown** moves it down one position within its tier.
  Focus stays on the moved row's handle so repeated presses keep moving the same
  row (WCAG operable — the user can drive the whole reorder from the keyboard).
- **Enter** **commits**: recompute ranks for the affected tier and PATCH (§4.3).
- **Escape** (added for parity, not in the original hook string) **cancels**: any
  un-committed live DOM moves since the handle gained focus are reverted to the
  last committed order, no PATCH.

This is the **arrows-move-live, Enter-commits** model. See §2 for the
justification against the existing `data-keyboard-shortcut="arrow-up,arrow-down,enter"`
hook, the cancel semantics, and the focus-management rules.

**DR-3 — Within-tier only (roadmap-backlog-consolidation inv 10).**
Reorder is confined to a single `data-priority-tier` (priority group). A drop or
keyboard move that would land the row in a different tier is **refused**:
- mouse: the drop is a **no-op / snap-back** — the row returns to its pre-drag
  position, no DOM change, no PATCH (§3.1 defines "different tier" precisely).
- keyboard: ArrowUp at the top of a tier (or ArrowDown at the bottom) is a
  **no-op** — the row does not cross into the adjacent tier.

**DR-4 — Rank rewrite is dense within the affected tier.**
On commit, the affected tier is **densely renumbered** to match its new visual
order: the items in that tier get `rank = 1, 2, 3, …, K` in their new top-to-
bottom order. Only the items whose rank actually **changed** are sent in the
PATCH (§4.2). Items in other tiers are untouched. Algorithm: §4.1.

**DR-5 — Reload survival via the sort contract.**
The persisted ranks MUST reproduce the dropped visual order under
`sortBacklogItemsForIndex` (§0.2). Because the affected tier is densely
renumbered `1..K` top-to-bottom, and the sort is `priority → rank(asc, nulls
last) → id`, the post-reload sort yields exactly the dropped order within that
tier. Verified by the reload-survival test (§10, DR-5 gate).

**DR-6 — Read-only gating.**
On a read-only sibling page (`useReadOnly() === true`; signalled by the
`[data-ledger-banner]` presence and the absence of rank pencils), drag and
keyboard reorder MUST be **inert/absent**. The SSR omits the drag-handle
affordance entirely when read-only (§6, approach: SSR-omit + client guard
belt-and-braces). The launched (editable) backlog is the only surface where
reorder works.

**DR-7 — Rank pencil remains a parallel working path.**
The existing rank pencil (`data-edit-action="open" data-edit-field="items>{id}>rank"`)
continues to work unchanged. Drag-reorder and the pencil are independent paths
to the same `rank` field; neither breaks the other. (Re-verified by the existing
20.24 rank-pencil test staying green.)

**DR-8 — Atomic, single-mtime persistence.**
A reorder commit is **one** `PATCH` request carrying **all** changed-rank patches
(§4.3), subject to a single mtime check. On `409 mtime-mismatch` the DOM reorder
is **rolled back** to the last-known-good order and the user is told to reload
(§4.5). On success the client adopts `newMtime` and fires the follow-up regen
(§0.7).

---

## 2. Keyboard semantics — Enter-vs-arrow decision (DR-2)

**Decision: arrows reorder LIVE in the DOM (no persist); Enter persists the
accumulated reorder.** Escape cancels (reverts to last committed order).

Justification against the existing
`data-keyboard-shortcut="arrow-up,arrow-down,enter"` hook
(`backlog-index-view.tsx:211`):

- The hook string explicitly enumerates **three** keys with distinct roles. If
  each arrow press persisted independently, `enter` would have no role — the hook
  would name a key with nothing to do. The hook's shape (two movement keys + one
  action key) is itself the design signal: arrows move, Enter acts. This SPEC
  honours that.
- **Network economy & atomicity:** moving a row from position 5 to position 1
  with per-arrow persistence would fire 4 PATCHes, each renumbering and
  re-validating the whole ledger, each its own mtime unit — 4 chances to hit a
  409 mid-reorder, leaving a half-applied order. The arrows-live/Enter-commit
  model collapses the whole gesture into ONE atomic PATCH (DR-8), matching the
  mouse-drag drop (also one PATCH). One mental model, one persistence unit, for
  both input modalities.
- **WCAG / operability:** a sighted keyboard user sees the row move on each
  arrow press (live DOM reorder), so there is continuous visual feedback; an AT
  user hears the announcement (§8.3). Enter is the explicit "save my new order"
  affordance. This is operable (2.1.1) and the commit is unambiguous (3.2.2 — no
  surprise context change on each arrow; the change happens on the explicit
  Enter).
- **Escape** is added even though it is not in the hook string, for symmetry
  with the edit form's existing Escape-cancels behaviour (`onKeydown`
  index.tsx:800-803) and to satisfy "no trap" expectations. It is purely
  additive and does not contradict the hook.

Focus management:
- After an arrow move, programmatic focus is re-applied to the moved row's
  handle (`[data-drag-handle="{id}"]`) so the SAME row keeps moving on repeated
  presses. (Moving the `<tr>` in the DOM does not preserve focus by itself.)
- After Enter (commit) the handle retains focus; on a `409` rollback (DR-8) focus
  also returns to the handle of the row that was being moved.

`aria-live` announcements: §8.3.

---

## 3. Within-tier constraint (DR-3) — exact behaviour

### 3.1 What "tier" means

A row's tier is the value of its `data-priority-tier` attribute
(`backlog-index-view.tsx:203` — the `item.priority` enum value). Two rows are in
the same tier iff their `data-priority-tier` strings are equal. The visual table
is a single `<tbody>` with rows grouped by tier *only because the SSR sort places
them adjacently* — there is no per-tier `<tbody>` or visual separator in the
current markup. The interactive layer therefore determines tier boundaries by
reading `data-priority-tier`, NOT by DOM grouping.

### 3.2 Mouse: cross-tier drop is refused (snap-back)

During a drag the client computes the **insertion index** from the pointer
position (which row it is hovering, above/below midpoint). On drop:

- If the computed insertion position is **within the contiguous run of rows that
  share the dragged row's tier**, the drop is accepted: the row moves to that
  position, ranks recompute, PATCH fires.
- If the computed insertion position is **outside** that run (i.e. would place
  the row adjacent to or among rows of a different tier), the drop is **refused**:
  the row snaps back to its original DOM position, no rank change, no PATCH. A
  brief visual "refused" cue MAY be shown (§8.2) but is not required for
  correctness.

"Within the tier's run": because the SSR sort keeps tiers contiguous, the dragged
row's tier occupies a contiguous index range `[tierStart, tierEnd]` in the live
row order. A drop is in-tier iff the target insertion index is in
`[tierStart, tierEnd]` (clamped — dropping exactly at `tierEnd` appends to the
bottom of the tier; dropping at `tierStart` prepends to the top of the tier).
Drop targets are also restricted by only registering drop affordances on rows
whose `data-priority-tier` matches the dragged row (the simplest correct
implementation — see §7).

### 3.3 Keyboard: tier boundary is a hard stop

ArrowUp when the focused row is already the **first** row of its tier → no-op
(does not swap with the last row of the tier above). ArrowDown when it is the
**last** row of its tier → no-op. Within the tier, arrows swap with the adjacent
in-tier neighbour.

---

## 4. Rank rewrite + persistence (DR-4, DR-5, DR-8)

### 4.1 The pure recompute algorithm

A new pure module **`packages/ui/record-view/backlog-reorder.ts`** owns the
rank-recompute logic so it is unit-testable without a DOM (mirrors the existing
`backlog-sort.ts` / `edit-dispatch.ts` pure-module convention).

Proposed API:

```ts
// backlog-reorder.ts (NEW — pure, no DOM, no React, no I/O)
import type { BacklogItem } from "@task-view/schemas/backlog";

/** A single rank assignment to PATCH: items>{id}>rank = rank. */
export interface RankAssignment {
  id: string;
  rank: number;
}

/**
 * Given the FULL set of items in ONE priority tier, in their NEW desired
 * top-to-bottom visual order, return the dense rank assignments (1..K) that
 * reproduce that order under sortBacklogItemsForIndex, AND the subset whose
 * rank actually CHANGED relative to the item's current rank.
 *
 * - `tierItemsInNewOrder`: items of a single tier, already reordered to the
 *   target visual order (caller derives this from the DOM row order).
 * Returns:
 *   - `assignments`: every item's new dense rank (1..K), in order.
 *   - `changed`: only the items whose new rank !== current (item.rank ?? null);
 *     this is the PATCH payload (DR-4 "only changed items").
 */
export function recomputeTierRanks(
  tierItemsInNewOrder: readonly BacklogItem[],
): { assignments: RankAssignment[]; changed: RankAssignment[] };
```

Algorithm (dense renumber 1..K, top-to-bottom):

```
for i, item in enumerate(tierItemsInNewOrder):        // i = 0..K-1
    newRank = i + 1                                   // 1-based dense
    assignments.push({ id: item.id, rank: newRank })
    if ((item.rank ?? null) !== newRank):
        changed.push({ id: item.id, rank: newRank })
```

Notes:
- **1-based, dense, contiguous** within the tier. Schema allows any integers
  (§0.3), but dense 1..K is the simplest order-reproducing scheme and keeps
  numbers small/legible in the rank column.
- Pure: no mutation of inputs; deterministic.

### 4.2 How `null`-rank (and absent-rank) items are handled

`sortBacklogItemsForIndex` sorts `null`/absent ranks **last within tier**, ordered
among themselves by id (§0.2). The DOM order the user sees already reflects this.
When the user drags a row **among or after** the `null`-rank items, the recompute
**assigns those previously-null items a concrete dense rank** equal to their new
visual position. This is intentional and correct:

- Example: tier `must` shows `[A(rank 1), B(rank 2), C(null), D(null)]` (C,D
  sorted last, by id). User drags `A` to the bottom → new visual order
  `[B, C, D, A]`. Recompute → `B:1, C:2, D:3, A:4`. `changed` = `{B:1, C:2, D:3,
  A:4}` (every one moved). C and D were `null`, now `2` and `3` — they are
  "pulled into" the explicit ordering because the user's drop established a
  definite position for them relative to A.
- This means a single reorder of one item can flip several `null` items to
  explicit ranks. That is the **correct and only** way to make the dropped order
  reproducible under the sort: a `null` row that is now visually *above* a ranked
  row cannot stay `null` (it would sort after the ranked row on reload, breaking
  DR-5). Densely renumbering the whole tier on every commit guarantees DR-5.
- A row dropped at a position where all rows below it remain `null` and unmoved:
  those `null` rows below are NOT in `changed` only if their position is
  unchanged AND they were already `null` AND no ranked row now sits below them.
  In practice the dense renumber assigns them ranks too if anything above them
  changed order; the `changed` filter (`newRank !== current`) keeps the PATCH
  minimal but DR-5 always holds because `assignments` is internally consistent.

> Practical rule the implementer can rely on: **always recompute the ENTIRE
> affected tier densely**, then PATCH only the diff. Never try to patch a single
> moved row's rank in isolation — that cannot guarantee DR-5 when `null`s or rank
> gaps are involved.

### 4.3 The PATCH

One request, built with the existing helper:

```ts
const patches = changed.map(({ id, rank }) =>
  buildPatchForKind("integer", ["items", id, "rank"], String(rank)),
);
const body = buildMultiPatchRequest(patches, baseMtime);  // edit-dispatch.ts:226
await fetch(recordPatchPath(recordId), {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
```

- `recordId` for the URL: use the `id` of the **dragged/moved row** (a stable,
  obvious choice and it scopes the single mirror regen to that record before the
  full regen runs anyway — §0.7). The server walk ignores the URL id; the item
  ids in each `fieldPath[1]` drive the writes (§0.6).
- The body shape is exactly what `handlePatchRecord` requires:
  `{ patches: FieldPatch[], baseMtime }` (`patch-server.ts:540-552`).
- `buildPatchForKind("integer", …)` emits `{ fieldPath, newValue: Number(rank) }`
  (`edit-dispatch.ts:169-172`) — an integer, never `null` (reorder always assigns
  a concrete rank; clearing-to-null is the pencil's `integer-nullable` job, §4.4).
- If `changed` is empty (the user dropped a row back where it started, or an
  arrow-move net-cancelled), **no PATCH is sent** and the commit is a silent
  no-op.

### 4.4 Why reorder never writes `null`

The pencil uses `integer-nullable` (empty input → `null`, "unset"). Reorder uses
`integer` and always assigns `1..K`. A reorder commit therefore can only *remove*
nullness (pull a `null` item into the explicit order, §4.2), never introduce it.
This keeps the two paths cleanly separated and keeps DR-5 trivially satisfiable.

### 4.5 Optimistic concurrency (DR-8)

- `baseMtime` is obtained via the existing `ensureBaseMtime()` (lazy
  `GET /api/ledger`), shared with the pencil path.
- One PATCH → one mtime check (`patch-server.ts:578-601`).
- `classifySaveResult(json)` outcomes:
  - `ok` / `mirror-regen-failed` → adopt `newMtime`; commit the DOM order
    (already moved); then fire `POST /api/ledger/regen` (§0.7). `mirror-regen-failed`
    is soft: the canonical was written, the live order is correct — treat as
    success for the reorder (same as `saveEditor` line 608).
  - `mtime-conflict` (409) → canonical NOT mutated. **Roll back** the DOM to the
    last-known-good order, adopt the returned `currentMtime` as the new base, and
    surface an inline "ledger changed — reload" message near the table. (Unlike
    the pencil, there is no open form to keep; the reorder's correctness lives in
    DOM order, so rollback is mandatory.)
  - `schema-error` (422) / `walk-error` (400) → should not occur for a
    well-formed dense renumber against existing item ids, but defensively: roll
    back the DOM and show the error. (A `walk-error` would mean a row's
    `data-backlog-row` id is stale vs. canonical — reload is the remedy.)
  - `network-error` → roll back DOM, show retry hint.

"Last-known-good order" = the row order snapshot captured at the start of the
gesture (mouse: at `dragstart`; keyboard: at the first arrow press after the
handle gained focus / after the last commit). The implementation captures the
ordered list of `data-backlog-row` ids and can restore by re-appending rows in
that order.

---

## 5. Sort-contract reproduction (DR-5) — worked guarantee

Claim: after committing a within-tier reorder with §4.1's dense renumber, a full
reload reproduces the dropped order.

Proof sketch (cite `backlog-sort.ts`):
- Reload re-reads canonical, runs `sortBacklogItemsForIndex` (line 75 of
  `backlog-index-view.tsx`).
- Tiers are ordered by `PRIORITY_ORDINALS` — untouched by a within-tier reorder,
  so tier blocks land in the same relative positions.
- **Within the reordered tier**, every item now has a distinct dense rank
  `1..K` matching its dropped visual position (no `null`s remain among reordered
  items — §4.2). The sort's step 2 (`rank asc, nulls last`, `backlog-sort.ts:63-70`)
  orders them `1,2,…,K` — exactly the dropped order. The id tiebreaker (step 3)
  never engages because all ranks are distinct.
- Untouched tiers keep their existing ranks/nulls and sort as before.

∴ the reloaded order == the dropped order. The §10 DR-5 gate verifies this on the
LIVE viewer (reorder, hard reload, assert order).

---

## 6. Read-only gating (DR-6) — CRITICAL

A read-only sibling page is rendered when `renderViewer` is called with
`readOnly: true`; it wraps the body in `<ReadOnlyProvider readOnly={true}>`
(`render-viewer.tsx:169-171`, mounting `read-only-context.tsx`), prepends the
`[data-ledger-banner]` (`render-viewer.tsx:132-140`), and `BacklogItemRow` already
reads `useReadOnly()` to suppress the rank pencil (`backlog-index-view.tsx:198-199,
242-256`).

**Today the drag handle still renders on a read-only page** (only the pencil is
gated). This SPEC closes that.

**Decision: SSR-omit the handle when read-only, AND add a client-side guard
(belt-and-braces).**

1. **SSR omit (primary).** In `BacklogItemRow`, gate the drag-handle markup on
   `!readOnly`, the same way the pencil is gated:
   ```tsx
   const readOnly = useReadOnly();              // already present, line 199
   …
   <td className="record-view-drag-cell">
     {readOnly ? null : (
       <span data-drag-handle={item.id} role="button" tabIndex={0} … >
         <span aria-hidden="true">{"☰"}</span>
       </span>
     )}
   </td>
   ```
   With the handle absent, no `[data-drag-handle]` reaches the served HTML, so the
   delegated reorder listeners have nothing to attach to — exactly the same
   posture the read-only context gives the edit dispatcher (`read-only-context.tsx:13-15`).
   Also drop (or keep but it is harmless) `data-supports-drag-reorder` — see §7 note.
   The `<th>`/drag-cell gutter MAY remain as an empty column for layout stability,
   or be omitted; either is acceptable as long as no handle/affordance is present.
   (Keep the `.sr-only` "Reorder" header only if the gutter column remains; if the
   column is dropped on read-only, drop the header cell too so the table's column
   count stays consistent.)

2. **Client guard (defence in depth).** The reorder wiring keys off
   `[data-drag-handle]` and the `[data-supports-drag-reorder="true"]` table; with
   SSR-omit there is nothing to wire. As an explicit guard, the client init for
   reorder also checks `document.querySelector("[data-ledger-banner]")` — if a
   banner is present (read-only sibling), it does NOT register the reorder
   listeners at all. This guarantees inertness even if a future SSR change
   regressed the omit.

The launched (editable) backlog page (no banner, pencils present, `useReadOnly()
=== false`) is the **only** surface where reorder is active.

---

## 7. Hooks to build on + new hooks needed

### 7.1 Reuse (no new SSR needed for these)

| Need | Existing hook | Source |
|---|---|---|
| Find the table / feature-detect | `[data-backlog-table][data-supports-drag-reorder="true"]` | `backlog-index-view.tsx:137-141` |
| Locate a row by id | `[data-backlog-row="{id}"]` | line 201-202 |
| Read a row's tier | `data-priority-tier` on the `<tr>` | line 203 |
| Grab point / keyboard target | `[data-drag-handle="{id}"]` (`role=button tabindex=0`) | line 205-217 |
| Read current rank without re-parsing | `data-rank-value` on the rank cell (`""` = unset) | line 235-237 |
| Build the PATCH | `buildPatchForKind("integer", …)`, `buildMultiPatchRequest`, `recordPatchPath` | `edit-dispatch.ts` |
| mtime / classify | `ensureBaseMtime`, `classifySaveResult` | `index.tsx:82`, `edit-state.ts` |

The `BacklogItem` objects needed by `recomputeTierRanks` (§4.1) are NOT serialised
into the page (the dispatcher is data-free by design, index.tsx:6-12). The client
reconstructs the minimal `{ id, rank }` shape per row from the DOM:
`data-backlog-row` (id) + `data-rank-value` (rank: `""` → `null`, else
`Number(...)`). So `recomputeTierRanks` should accept the **minimal** shape it
needs rather than the full `BacklogItem`:

> Refinement: define `recomputeTierRanks` over a minimal `{ id: string; rank:
> number | null }[]` (call it `RankedRow`) so the pure module has zero schema
> coupling and the client can build inputs straight from the DOM. The full
> `BacklogItem` is a structural supertype, so existing-item arrays still satisfy
> it in unit tests.

### 7.2 New hooks / attributes

- **`draggable` attribute:** **the client sets `draggable="true"`** on each row
  (or on the handle) at wire time, NOT the SSR. Rationale: (a) keeps the SSR a
  pure static render with no behaviour-implying attributes that would mislead a
  no-JS client (the QC finding was precisely that decorative drag affordance is
  misleading); (b) `draggable` only means something with JS listeners attached,
  so coupling them is correct; (c) it keeps DR-6 trivial — if the client never
  wires (read-only / no banner check fails), nothing is `draggable`. The client
  sets `draggable="true"` only on rows in the editable launched page.
- No other new SSR attributes are required. The `data-supports-drag-reorder` flag
  remains the feature switch the client reads. (On read-only SSR-omit per §6 you
  MAY also omit `data-supports-drag-reorder`; the client banner-guard makes this
  belt-and-braces.)
- A small CSS addition (§8) for drag/drop visual states — class names only, no
  new data hooks.

---

## 8. UX

### 8.1 Drag affordance feedback (DR-1)
- The handle shows `cursor: grab` (and `grabbing` while dragging) — CSS on
  `[data-drag-handle]`.
- The dragged row gets a `.record-view-row-dragging` class (reduced opacity /
  subtle elevation) for the duration of the drag.
- The current drop target shows a `.record-view-drop-target` indicator (e.g. a
  2px top/bottom border on the row the drop would insert before/after). Only
  in-tier rows ever receive this class (§3.2), giving the user implicit feedback
  that cross-tier drops are not available.
- Use semantic theme tokens, not raw colours (roadmap-backlog-consolidation inv
  14 — same constraint the view header cites).

### 8.2 Cross-tier refusal cue (DR-3)
- On a refused drop, the row snaps back (no animation required). A transient
  `.record-view-row-refused` flash (e.g. brief outline) MAY be added; optional,
  not a correctness requirement.

### 8.3 Keyboard feedback + announcements (DR-2)
- The moved row briefly takes `.record-view-row-keyboard-moved` (visual pulse)
  so a sighted keyboard user sees the move.
- An `aria-live="polite"` status region (a visually-hidden `<div role="status">`
  the client creates once and appends to the table container) announces each
  move: e.g. *"Item {id} moved to position {n} of {K} in {tier}."* and the
  commit: *"Order saved."* / on rollback: *"Could not save — ledger changed,
  please reload."* This satisfies WCAG status-message requirements (4.1.3).

### 8.4 Pencil coexistence (DR-7)
- The rank pencil stays exactly as is and is visually unchanged. After a
  drag/keyboard commit, the rank cells' visible values and `data-rank-value`
  attributes are updated in place (the client writes the new dense rank into
  `.record-view-rank-value` text + `data-rank-value`) so a subsequent pencil
  open reads the fresh rank (mirrors `commitDisplay`'s `data-rank-value` write,
  index.tsx:684-694). This avoids a stale pencil after a reorder.

---

## 9. Implementation slicing plan

Sequential slices (they share `backlog-index-view.tsx`, `apps/server/web/index.tsx`,
`edit-dispatch.ts`, and the new `backlog-reorder.ts`). Each slice is
agent-browser-verified on the LIVE viewer before the next begins.

> Conventions: tests run with `bun test` (root script); typecheck with
> `bun run typecheck`. The SPA client uses **relative** imports (NOT `@task-view`
> aliases) because `Bun.build` resolves by filesystem path (see
> `apps/server/web/index.tsx:40-53`). So the client's import of
> `backlog-reorder.ts` must be the relative
> `../../../packages/ui/record-view/backlog-reorder` form.

**Slice A — Pure recompute core + drag mechanics + within-tier DOM reorder +
cross-tier refusal (no persistence yet).**
- NEW `packages/ui/record-view/backlog-reorder.ts` (`recomputeTierRanks`, §4.1)
  over the minimal `RankedRow` shape (§7.1). Unit tests (§10).
- In `apps/server/web/index.tsx`: add reorder wiring — feature-detect
  `[data-supports-drag-reorder]` + the banner guard (§6.2); set `draggable="true"`
  on launched-page rows; wire `dragstart`/`dragover`/`drop`/`dragend` to perform
  a within-tier DOM move and refuse cross-tier (§3.2). No PATCH yet — drop just
  reorders the DOM and logs the would-be `changed` set.
- CSS (§8.1/8.2) in the record-view stylesheet.
- Verify (agent-browser): drag moves the row in the DOM; a cross-tier drag snaps
  back; no network fires yet.

**Slice B — Rank-rewrite + persistence (multi-patch PATCH) + reload survival.**
- Wire the drop handler to: build `changed` via `recomputeTierRanks`, PATCH via
  `buildMultiPatchRequest` (§4.3), handle `classifySaveResult` outcomes (§4.5),
  adopt `newMtime`, update in-place rank cells (§8.4), then fire `POST
  /api/ledger/regen` (§0.7).
- Verify (agent-browser): drag → observe ONE PATCH with multiple `items>{id}>rank`
  patches → reload → order survives (DR-5). Observe the follow-up regen POST.

**Slice C — Keyboard reorder reusing the same core.**
- Add `keydown` handling on `[data-drag-handle]`: ArrowUp/ArrowDown live-move
  within tier (DR-2/DR-3), Enter commits via the same Slice-B persistence path,
  Escape reverts. Focus management + `aria-live` announcements (§8.3).
- Verify (agent-browser): focus a handle, ArrowDown × N, Enter → PATCH → reload
  survives; arrow at tier boundary is a no-op; Escape reverts un-committed moves.

**Slice D — Read-only gating + integration + tests hardening.**
- `backlog-index-view.tsx`: SSR-omit the drag handle (and optionally the gutter
  column / `data-supports-drag-reorder`) when `useReadOnly()` (§6.1).
- Confirm the client banner-guard (§6.2) is in place.
- Full test pass (§10) + the complete live agent-browser gate (vi).
- Verify (agent-browser): a read-only sibling backlog page shows no working drag
  and no `[data-drag-handle]`.

---

## 10. Test + verification plan

### 10.1 Unit tests (`bun test`)
New `packages/ui/record-view/backlog-reorder.test.ts` for `recomputeTierRanks`
(pure, no DOM):
- dense renumber 1..K for a simple tier reorder; `changed` = only moved items.
- `null`/absent-rank items pulled into explicit ranks when reordered above/among
  them (§4.2 worked example: `[A1,B2,C∅,D∅]` → drag A to bottom →
  `B:1,C:2,D:3,A:4`, all in `changed`).
- no-op when the order is unchanged → `changed` empty.
- idempotence: feeding the output order back in yields `changed` empty.
- **Cross-check against the real sort:** for each test, assert that applying
  `assignments` to the items and running `sortBacklogItemsForIndex` reproduces
  the input visual order (directly ties the unit test to DR-5 / `backlog-sort.ts`).

Plus: existing `backlog-sort.test.ts` and the 20.24 rank-pencil tests must stay
green (DR-7).

### 10.2 Typecheck
`bun run typecheck` clean (the new module has its own coverage under
`packages/ui/tsconfig.json`; the client import is relative so no alias-export
gotcha — cf. MEMORY note on `.ts` subpath exports).

### 10.3 NON-NEGOTIABLE live agent-browser gate
Launch the real fixture and drive the browser:

```
bun apps/server/index.ts tests/fixtures/live-ledgers/product-backlog.json \
  --no-browser --port <P>
```

(`tests/fixtures/live-ledgers/product-backlog.json` exists — verified.) Then via
the agent-browser CLI, on `http://127.0.0.1:<P>/` (the backlog index):

- **(i) DOM order changed** — drag a row within its tier; assert the
  `[data-backlog-row]` id sequence changed as dropped.
- **(ii) a rank PATCH fired** — observe the network: exactly ONE
  `PATCH /api/ledger/record/:id` whose JSON body `patches[]` carries multiple
  `{ fieldPath: ["items", "{id}", "rank"], newValue: <int> }` entries; assert
  `{patches, baseMtime}` shape; assert the follow-up `POST /api/ledger/regen`.
- **(iii) order SURVIVES a reload** — hard-reload `/`; assert the
  `[data-backlog-row]` sequence equals the dropped order (DR-5).
- **(iv) cross-tier drop refused** — drag a row toward a different
  `data-priority-tier`; assert the DOM order is unchanged AND no PATCH fired.
- **(v) keyboard reorder works** — focus a `[data-drag-handle]`, press
  ArrowDown a few times (assert live DOM move within tier, no PATCH), press
  Enter (assert ONE PATCH), reload (assert survival); press ArrowUp at a tier top
  → assert no-op.
- **(vi) read-only sibling shows no working drag** — launch a *different* ledger
  as the editable one with this backlog as a sibling (the cross-ledger nav target
  used by {20.29}), navigate to the read-only backlog sibling, assert
  `[data-ledger-banner]` present, `document.querySelectorAll("[data-drag-handle]").length
  === 0`, and that a drag attempt + ArrowDown produce no DOM change and no PATCH.

Reference for the prior failure this gate guards against: QC root-cause
`/tmp/claude/s271-reports/subo-id-20-exploratory-qc.yaml` finding A
(decorative-handle, zero `[draggable]`, zero `/api` on drag) and screenshot
`/tmp/claude/s271-reports/qc-backlog-index-draghandles.png`.

---

## 11. Out of scope

- Cross-ledger doc-links 404 (QC finding B / OQ-P2) — separate defect.
- Cross-tier *promotion* (changing an item's `priority`) — that is the pencil's /
  curator's job, not reorder (DR-3 forbids cross-tier moves).
- Drag-reorder on the roadmap / task-list index pages — backlog only (the rank
  field and inv-10 sort are backlog-specific).
- Multi-row / range selection drag — single-row reorder only.

---

## 12. Summary of decisions (for the implementer)

1. **Rank recompute:** dense renumber the affected tier `1..K` top-to-bottom on
   every commit; PATCH only the changed subset; never write `null` (reorder only
   removes nullness). Pure helper `recomputeTierRanks` in new
   `packages/ui/record-view/backlog-reorder.ts` over a minimal
   `{id, rank}` shape.
2. **Keyboard:** arrows move LIVE within-tier (no persist), Enter commits one
   atomic PATCH, Escape reverts — justified by the 3-key hook string and atomic
   single-mtime persistence.
3. **Mirror staleness:** after a successful reorder PATCH, fire
   `POST /api/ledger/regen` (full regen, endpoint already exists) — a soft
   follow-up; failure does not roll back the (correct) canonical/live order.
4. **Read-only gating:** SSR-omit the handle when `useReadOnly()` (primary) PLUS
   a client banner-guard that skips wiring when `[data-ledger-banner]` is present
   (defence in depth). `draggable="true"` is set by the CLIENT, never the SSR.
