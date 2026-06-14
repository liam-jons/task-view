# Continuation handoff — task-view QoL (session 2)

Self-contained handoff to finish the task-view quality-of-life work. The prior
session implemented Tasks 1–7 (TDD, all committed + tagged locally). This doc
lets a fresh session complete the release + Tasks 8–9 with no prior memory.

---

## ▶ Kickoff prompt (paste into the new session)

> Continue the task-view QoL work in `/Users/liamj/Documents/development/task-view`.
> Read `docs/specs/qol-improvements/CONTINUATION.md`, then `PLAN.md` (same dir),
> then `docs/specs/editable-ledger-switch/SPEC.md`. Tasks 1–7 are done, committed
> on `main`, and tagged `v0.7.0-task-view` (local only). Do, in order:
> (1) finish the release — push + KH cache (§Release; was blocked on SSH creds);
> (2) Task 8 — editable ledger switch, Option A, per its SPEC (TDD);
> (3) Task 9 — Option B ctx unification (follow-up).
> Use the `test-driven-development` + `planning-and-task-breakdown` skills. Keep
> `bun test` and `bun run typecheck` green after every step. The caveman hook
> mangles tool OUTPUT (substitutes `task-view`→`n`, tag strings→`l`); if exact
> strings matter (esp. reading the Knowledge Hub repo) say `stop caveman` first.

---

## Where we are

**7/9 tasks complete.** Full suite **1455 pass / 0 fail**, typecheck clean.

| # | Task | State | Verified |
|---|------|-------|----------|
| 1 | Drag handle-only `draggable` (unblock copy-paste) | done | happy-dom DOM test |
| 2 | "Back to…" returns to page point (`#record-<id>`) | done | live curl |
| 3 | Keyword search (task-list/roadmap/backlog) | done | live curl (`?q=` 35→1) |
| 4 | Column sort (task-list + roadmap) | done | live curl |
| 5 | Hide done/cancelled (task-list) | done | live curl (`?excludeDone=1` 35→12) |
| 6 | Ledger compaction (`--compact`) | done | CLI smoke (1382→903 B) |
| 7 | Close-tab-on-exit (SSE + overlay) | done | real-server SSE test |
| 8 | **Editable ledger switch (Option A)** | **TODO** | — |
| 9 | **Option B ctx unification (follow-up)** | **TODO** | — |

**Local git state on `main`** (NOT pushed — see §Release):
```
2bbe473  feat(server): close-tab-on-exit — SSE shutdown + overlay      (Task 7)
9f90153  docs(spec): editable-ledger-switch design                     (Task 8 design)
dc74d42  feat(server): ledger compaction — --compact                   (Task 6)
5f3a879  feat(viewer): search, sort, hide-done, page-point, copy-paste (Tasks 1–5)
```
Tag `v0.7.0-task-view` → `2bbe473` (annotated, local). Working tree: clean
except this CONTINUATION.md (uncommitted — commit it with the rest).

> ⚠️ Spec line-anchors are STALE. Tasks 6–7 inserted code into `patch-server.ts`,
> `apps/server/web/index.tsx`, `render-viewer.tsx`, `url-state.ts`, so the line
> numbers in `editable-ledger-switch/SPEC.md` (captured pre-edit) have shifted.
> **Re-grep every anchor** (commands given in §Task 8) — do not trust the numbers.

---

## Release (finish first — credential-gated)

The prior session COULD NOT push: `git fetch`/`push` → `Permission denied
(publickey)` (agent env has no SSH key). The user runs these in their own shell
(the `!` prefix runs a command in-session with their creds).

1. **Push task-view** (fetch first — local `origin/main` ref is week-stale, true
   divergence unknown until fetched; it's a solo repo so a fast-forward is
   expected):
   ```
   git fetch origin && git status -sb
   git push origin main && git push origin v0.7.0-task-view
   ```
2. **Knowledge Hub cache** (after the tag is pushed). KH couples to task-view 3
   ways: (a) **vendored modules** in `knowledge-hub/lib/ledger/`
   (`record-mutate`, `detect-schema`, `patch-apply`) pinned to `TASK_VIEW_TAG`;
   (b) a **`.cache/task-view-<tag>` symlink** → the task-view repo, used to RUN
   the server; (c) a **`task-view-vendor-drift.yml`** CI check.
   - **Vendor drift is clean** — this release does NOT touch the vendored
     modules, so the vendored copies still match the tag. No re-vendor needed.
   - Create the run-cache symlink (mirrors the v0.6.0 one):
     ```
     ln -sfn /Users/liamj/Documents/development/task-view \
       /Users/liamj/Documents/development/knowledge-hub/.cache/task-view-v0.7.0-task-view
     ```
   - Bump `TASK_VIEW_TAG` `v0.6.0-task-view` → `v0.7.0-task-view` in KH and
     commit + push KH. **The exact pin file wasn't pinned down** (caveman hook
     mangled the KH reads). To locate it cleanly: `stop caveman`, then in
     `knowledge-hub/`: `rg -n "v0\.6\.0-task-view|TASK_VIEW_TAG" --glob '!.cache/**' --glob '!node_modules'`
     — likely `lib/ledger/README.md` + a config/const consumed by
     `scripts/ledger-server-lifecycle.ts` (`resolveTag` / spawn-tag sidecar at
     `.cache/ledger-server/spawn-tag.json`).

---

## Task 8 — Editable ledger switch (Option A)

Full design: `docs/specs/editable-ledger-switch/SPEC.md` (committed). The user
chose **Option 2 (runtime editable switching)** and asked to *simplify/rebuild
where sensible*. The design's decisive finding:

> The slug-routing write seam already supports per-request editable sibling
> writes. So this is a **viewer + client** change that **DELETES** the stale
> read-only-sibling model — not a write-side rebuild.

**Re-grep the live anchors first** (numbers shifted post Tasks 6–7):
```
rg -n "effCtx|slugMatch|resolveLedgerPathByName" packages/server/patch-server.ts   # the write seam
rg -n "handleGetRoot|renderSiblingLedger|readOnly: true|decodeLedgerParam" packages/server/patch-server.ts
rg -n "renderSiblingLedger|readOnly|LedgerBanner|data-ledger-banner" packages/server/render-viewer.tsx
rg -n "baseMtime|ensureBaseMtime|data-ledger-banner" apps/server/web/index.tsx     # client single-ledger state
rg -n "recordPatchPath|recordDeletePath" packages/ui/record-view/edit-dispatch.ts  # bare write URLs
rg -n "LedgerSlug" packages/ui/record-view/anchors.ts                              # UI knows 3 slugs; server 5
```

**The gap (SPEC §1):** (a) GET / forces `readOnly:true` for siblings in
`renderSiblingLedger`; (b) no UI to switch ledgers; (c) the client is
single-ledger — `baseMtime` is one global, write URLs are bare (never slugged).

**TDD slices (SPEC §5) — failing test first each:**
1. **Server renders a sibling EDITABLE.** Rewrite the `patch-server.test.ts`
   assertions that currently expect `not.toContain("data-edit-action")` +
   `data-ledger-banner` on `/?ledger=…` → expect edit affordances +
   `data-ledger-switcher`. Impl: drop `readOnly:true` in `renderSiblingLedger`.
2. **`renderViewer` switcher replaces the banner.** Rewrite `render-viewer.test.tsx`
   read-only/banner assertions; `ledger-banner.test.tsx` → `ledger-switcher.test.tsx`.
   New `packages/ui/record-view/ledger-switcher.tsx` (nav of dir's
   viewer-renderable ledgers → `/?ledger=<slug>`, active one `aria-current`),
   mounted by `renderViewer`. Remove the sibling `readOnly` branch.
3. **Slug-aware client write URLs (pure).** `recordPatchPath("20","roadmap")` →
   `/api/ledger/roadmap/record/20`; bare back-compat preserved. `edit-dispatch.ts`.
4. **Per-slug client mtime + active-slug.** `baseMtime: Map<slug,string>`;
   `ensureBaseMtime(slug)` GETs `/api/ledger/<slug>`; `activeSlug()` from
   `?ledger=` (or an SSR `data-active-ledger` hook); thread slug into
   `saveEditor`/delete/reorder/`fireRegen`/`scanBacklogReferences`; remove the
   `[data-ledger-banner]` mutation guards. (Test pattern: append a DOM test to
   `tests/integration/dispatcher-enum-raw.test.tsx`, export the client fn — see
   §Conventions.)
5. **E2E editable switch** in `patch-server-slug-routing.test.ts` (it already
   drives real servers across siblings): launch on task-list; GET
   `/?ledger=roadmap&record=10` is editable; a slug-routed PATCH lands in roadmap,
   task-list untouched; switch to backlog, write lands in backlog.
6. **Regression guard:** bare routes → launch, inv-44 loopback,
   `cross-ledger.test.ts`, `daemon-lifecycle.test.ts` stay green (additive on the
   substrate).

**Simplification this DELETES (SPEC §3):** the `readOnly` sibling special-case
(through `render-viewer.tsx` + `ReadOnlyProvider`/`useReadOnly` consumers),
`ledger-banner.tsx`, and the `[data-ledger-banner]` client guards (drag/reorder
banner-guards + the mutation guards).

**Open questions (SPEC §6, defaults chosen — confirm with user if needed):**
`?ledger=` = switch-editable (no separate read-only mode); directory = allow-list;
nav abandons open edits; umbrellas/retro hidden from the switcher (no viewer
surface). **Live gate:** launch on one ledger, switch editable target in-browser,
confirm the write lands in the switched ledger and others are untouched.

---

## Task 9 — Option B ctx unification (follow-up, non-gating)

After Task 8 is green. Replace `RequestContext.ledgerPath: string` with
`ledgerDir` + per-request `activeLedger`, and a single
`resolveActiveLedger(ctx, slug|null)` consumed by GET /, the JSON API, and health
— collapsing the dual `effCtx`/`ctx` path. ~81 `patch-server.test.ts` servers
construct via `opts.ledgerPath` → migrate. Pure code-altitude win, no new
capability. SPEC §4.

---

## Conventions & gotchas (read before coding)

- **Test cmd:** `bun test`. **Typecheck:** `bun run typecheck` (covers
  `packages/{shared,server,ui,schemas}` — NOT `apps/` or `tests/`; bun still runs
  those test files). Keep both green after every change.
- **TDD discipline:** red → green → refactor. The repo's tests are the spec.
- **Client (SPA) DOM tests:** `apps/server/web/index.tsx` is a delegated-event
  dispatcher, NOT a React mount. To unit-test client wiring: `export` the function
  from `index.tsx` and call it directly in `tests/integration/dispatcher-enum-raw.test.tsx`
  (the ONE file that owns the happy-dom + dispatcher-module lifecycle —
  `GlobalRegistrator` is a process singleton; a SEPARATE happy-dom file that
  imports the dispatcher module corrupts that file's listeners. Always append
  here). happy-dom DOES allow setting `window.location.search` (used by the
  search/sort/exclude tests).
- **Filter/search/sort/flag URL round-trip** (the reuse pattern): pure
  decode/encode/apply + `matchesQuery` + `nextSearchForQuery`/`nextSortForField`/
  `nextSearchForFlag` in `packages/ui/record-view/url-state.ts` (all preserve
  other params); SSR decodes in `render-viewer.tsx` + passes to the view; client
  `wire*` reads the control and navigates. New filter fields are **optional** on
  the state interface so existing `{q}`-style literals don't churn; `decode*`
  always populates them.
- **Slug write seam:** `patch-server.ts` `effCtx` — every mutating handler binds
  `effCtx.ledgerPath`, so `/api/ledger/:slug/...` already writes the named sibling
  (proven in `patch-server-slug-routing.test.ts`). This is why Task 8 is small.
- **`detectSchema(parsed)` THROWS** (`.parse`) on an invalid doc — wrap in
  try/catch (see `compact-done.ts` `runCompaction`).
- **`TaskListSchema` is `.strict()`** — doc fields are exactly
  `document_name`/`document_purpose`/`related_documents`/`tasks`(+`_idHighWater?`);
  NO `last_updated`. Subtask = `{id,title,description,details,status,dependencies,testStrategy}`.
- **Version is decoupled from the tag** — `package.json` stays `0.2.0` across all
  `v0.x-task-view` tags. Do NOT bump package.json; the tag is the release marker.
- **Caveman hook mangles tool OUTPUT** (not just chat) — `task-view`→`n`,
  tags→`l`. Say `stop caveman` before any read where exact strings matter
  (esp. the Knowledge Hub repo files for the release).
- **Unsandbox** (`dangerouslyDisableSandbox: true`) is needed to read the KH
  repos (outside cwd) and for git network ops (which then fail on SSH auth anyway
  — hand pushes to the user via `!`).

## New files created this session (for orientation)
- `packages/ui/record-view/{index-search,sortable-header}.tsx`,
  `{task-list-sort,roadmap-sort}.ts` (+ tests)
- `packages/server/compact-done.ts` (+ test); `--compact` CLI in `apps/server/index.ts`;
  `./compact-done` export in `packages/server/package.json`
- `packages/server/shutdown-events.test.ts`; SSE channel in `patch-server.ts`;
  overlay in `apps/server/web/index.tsx`
- specs: `docs/specs/{editable-ledger-switch,ledger-compaction,qol-improvements}/`
