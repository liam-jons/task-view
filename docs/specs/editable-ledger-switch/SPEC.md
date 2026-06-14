# SPEC — Runtime editable ledger switching

Status: DESIGN (ratified direction: user chose runtime-editable switching over a
view-only switcher, 2026-06-13, with the explicit steer "don't rush — research,
spec, simplify, adapt/rebuild if it makes sense"). Supersedes the read-only
posture of `docs/specs/cross-ledger-nav/SPEC.md` §3 / OQ-P3.

## 0. Decisive finding (verified against running code)

The write path **already supports per-request editable sibling writes.** The
slug-routing seam at `packages/server/patch-server.ts:2523-2542` rewrites the
request's effective ledger:

```
let effCtx = ctx;                                            // :2523
const slugMatch = path.match(/^\/api\/ledger\/([^/]+)(\/.*)?$/);   // :2524
if (slugMatch && LEDGER_SLUGS.includes(slugMatch[1])) {     // :2526
  effCtx = { ...ctx, ledgerPath: resolvedPath };            // :2541 (resolveLedgerPathByName)
  apiPath = `/api/ledger${slugMatch[2] ?? ""}`;             // :2542
}
```

**Every** mutating handler binds `effCtx.ledgerPath`, not `ctx.ledgerPath`:
POST record (`:2563`), transaction (`:2570`), POST subtask (`:2584`), DELETE
subtask (`:2601`), PATCH record (`:2619`), DELETE record (`:2624`), POST regen
(`:2636`). `withPathLock(effCtx.ledgerPath, …)` gives per-ledger mutual
exclusion. This seam shipped in ID-90 U9 and is proven end-to-end in
`packages/server/patch-server-slug-routing.test.ts` (writes land in the named
sibling; the launch ledger is untouched).

**Therefore editable switching is a VIEWER + CLIENT change, not a write-side
rebuild.** The `cross-ledger-nav` SPEC chose read-only because "the endpoints all
bind `ctx.ledgerPath` and have no sibling-write path" — that premise is now
**stale**. The read-only-sibling model is load-bearing complexity propping up a
constraint that no longer exists.

## 1. The gap (precise)

Three things, all viewer/client side:

- **(a) GET / forces `readOnly` for siblings.** `handleGetRoot`
  (`patch-server.ts:333`) computes `launchedSlug` (`:397`) and `requestedSlug =
  decodeLedgerParam(search)` (`:404`); when they differ it calls
  `renderSiblingLedger` (`:407`, def `:475`) which passes `readOnly: true`
  (`:516`) into `renderViewer`, suppressing every `data-edit-*` hook and mounting
  the read-only `LedgerBanner`. This is pure renderer policy — the server would
  accept slug-routed writes to that same sibling.
- **(b) No UI to switch.** The only cross-ledger affordance is the banner's
  "Back to launched ledger" link. `GET /api/health` already returns
  `documents: [{slug, document_name, path}]` for the launch directory — the data
  a switcher needs.
- **(c) Client is single-ledger.** In `apps/server/web/index.tsx`, `baseMtime`
  is one module-level `let` (`:97`) seeded once from **bare** `/api/ledger`
  (`ensureBaseMtime` `:99`). Every write URL is **bare** — `recordPatchPath`
  (`edit-dispatch.ts:239`) → `/api/ledger/record/:id`, never a slug. So even if
  the SSR made a sibling editable, the client would POST edits to the launch
  ledger.

Mirror scope (`resolveMirrorDir` derives from the ledger path), path-mutex
(per-path), and the port-file `ledgerDir` (the directory) need **no change** —
they are already directory-correct.

## 2. Design — Option A (recommended): generalise the seam

Treat `?ledger=<slug>` as the **active editable** selector, not a read-only
viewer selector.

- **Server.** `handleGetRoot` / `renderSiblingLedger` render the requested
  viewer-renderable sibling **editable** (drop `readOnly: true`); pass the active
  slug + the directory document registry into `renderViewer` in place of the
  read-only flag. The slug write seam (`:2523-2542`) is unchanged.
- **Client.** Replace the single `baseMtime` with `Map<slug,string>`;
  `ensureBaseMtime(slug)` fetches `/api/ledger/<slug>`; `activeSlug()` reads
  `?ledger=` (or an SSR `data-active-ledger` hook). Thread the slug into every
  write URL helper (`recordPatchPath(id, slug?)` → `/api/ledger/<slug>/record/:id`
  when active, bare otherwise for back-compat) across `saveEditor`,
  `deleteBacklogRecord`, the reorder commit, `fireRegen`, `scanBacklogReferences`.
  Remove the `[data-ledger-banner]` mutation guards (`:1038`, `:1803`).
- **UI.** New `packages/ui/record-view/ledger-switcher.tsx` (replaces
  `ledger-banner.tsx`): a nav/`<select>` of the directory's viewer-renderable
  ledgers → `/?ledger=<slug>`, active one marked `aria-current="page"`. Mounted
  by `renderViewer` on every page (launched + sibling).

**Invariant impact.** RELAXES inv 43 / OQ-P3 ("one editable per launch") →
"one editable per request, any sibling in the launch directory" — exactly the
contract the U9 seam already implements + tests. KEEPS inv 44 (loopback-only —
routing not binding), mtime + per-path mutex (untouched, now exercised from the
viewer too), and umbrellas/retro having no viewer surface (switcher filters to
task-list/roadmap/backlog).

**Security.** Unchanged. `?ledger=` is validated against `LEDGER_SLUGS` and
resolved only within `dirname(ledgerPath)` via `scanForLedgers` (the directory is
the allow-list). A slug can never escape the launch directory.

## 3. Simplification this DELETES (the user invited rebuild/simplify)

Making siblings editable lets us remove, not just modify:

1. The `readOnly` sibling special-case threaded through `render-viewer.tsx`
   (`renderViewer`, `renderRecordMarkup`, every kind branch) and the
   `ReadOnlyProvider`/`useReadOnly` consumers in `backlog-item-view.tsx`,
   `backlog-index-view.tsx`, `field-pencil.tsx`. (If a *deliberate* view-only
   mode is ever wanted, keep the mechanism but decouple it from "is a sibling".)
2. `ledger-banner.tsx` + the `data-ledger-banner` client guards (`index.tsx:1038,
   1803` and the drag/reorder banner-guards) — they exist solely to stop a
   sibling page leaking a mutation; once siblings are legitimately editable they
   are meaningless.
3. (Follow-up, Option B) the dual `effCtx`/`ctx` + GET-/-bypasses-the-seam
   asymmetry — two mechanisms for "which ledger does this request mean."

Verdict: unifying around "directory of editable ledgers, one active" is **net
simpler** than today's launched-one + read-only-siblings split.

## 4. Option B (follow-up refactor, not gating the feature)

Replace `RequestContext.ledgerPath: string` with `ledgerDir` + a per-request
`activeLedger`, and a single `resolveActiveLedger(ctx, slug | null)` consumed by
GET /, the JSON API, and health alike — collapsing the dual path. Higher churn
(~81 `patch-server.test.ts` servers construct via `opts.ledgerPath`); pure
code-altitude win, no new capability. Do it AFTER Option A lands and is green.

## 5. TDD slices (`bun test`; failing-test-first each)

1. **Server renders a sibling EDITABLE.** Rewrite the `patch-server.test.ts`
   assertions that currently expect `not.toContain("data-edit-action")` +
   `data-ledger-banner` on `/?ledger=…` (the read-only expectation) to expect
   edit affordances + a `data-ledger-switcher`. Impl: drop `readOnly:true` in
   `renderSiblingLedger`.
2. **`renderViewer` switcher (replaces banner).** Rewrite `render-viewer.test.tsx`
   read-only/banner assertions; `ledger-banner.test.tsx` → `ledger-switcher.test.tsx`.
   Impl: new switcher component + mount; remove sibling `readOnly` branch.
3. **Slug-aware client write URLs (pure).** `recordPatchPath("20","roadmap")` →
   `/api/ledger/roadmap/record/20`; bare back-compat preserved. Impl:
   `edit-dispatch.ts:239,269`.
4. **Per-slug client mtime + active-slug.** Two edits to different slugs each send
   that slug's own `baseMtime` (no cross-ledger 409). Impl: `index.tsx` `baseMtime`
   Map, `ensureBaseMtime(slug)`, `activeSlug()`; remove banner guards.
5. **E2E editable switch on a real server** in `patch-server-slug-routing.test.ts`:
   launch on task-list; GET `/?ledger=roadmap&record=10` editable; slug-routed
   PATCH lands in roadmap, task-list untouched; switch to backlog, write lands in
   backlog. (Glue; passes once 1-4 land.)
6. **Regression guard:** bare routes → launch (`slug-routing.test.ts`), inv 44
   loopback, `cross-ledger.test.ts`, `daemon-lifecycle.test.ts` all stay green —
   proving the change is additive on the write/lifecycle substrate.

## 6. Open questions / product calls

- **OQ-1 `?ledger=` semantics:** ratified = "switch active editable". If a
  deliberate read-only viewing mode is still wanted, make it an explicit toggle
  decoupled from sibling-ness (§3.1). *Default: no separate read-only mode.*
- **OQ-2 allow-list:** the launch directory IS the allow-list (any
  `KNOWN_DOCUMENT_NAME` sibling editable). *Default: keep; no narrower restriction.*
- **OQ-3 in-flight edits on switch:** switching is a navigation (SSR reload), so an
  open inline editor is abandoned like any nav today. *Default: accept; revisit an
  "unsaved edits" guard only if requested.*
- **OQ-4 umbrellas/retro:** no viewer surface — appear in `/api/health` but NOT in
  the switcher; remain edit-via-API-only. *Default: confirmed.*
