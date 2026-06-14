# Implementation Plan — task-view QoL improvements

## Overview

Seven usability improvements to the task-view viewer/editor, derived from Liam's
rough notes (2026-06-13) + agent investigation + KH cross-repo research. Each is
landed test-first (`bun test`) and verified before the next. Two carry their own
design specs: `../editable-ledger-switch/SPEC.md`, `../ledger-compaction/SPEC.md`.

Test cmd: `bun test`. Typecheck: `bun run typecheck`. The SPA client
(`apps/server/web/index.tsx`) imports pure modules by **relative** path (Bun.build
resolves by filesystem path), not `@task-view/*` aliases.

## Architecture decisions

- **Reuse the filter URL round-trip** (`url-state.ts` decode/encode + SSR apply +
  client `wire*` navigate) for search, sort, and the done/cancelled view-filter —
  it is the established, bookmarkable (inv 23) pattern.
- **Per-surface URL-state** (`TaskListFilterState`, `RoadmapFilterState`) rather
  than overloading the backlog-specific `BacklogFilterState`; backlog gains only
  `q`.
- **Backlog sort deferred** — collides with persisted `rank` + drag-reorder
  (`docs/notes/ledger-sorting.md`). Search applies to all three; sort to
  task-list + roadmap only.
- **Drag fix = handle-only `draggable`** — the SPEC already says "grab by the
  handle"; the bug is the client setting `draggable` on the whole `<tr>`.
- **Editable switch = generalise the existing slug write seam**, delete the stale
  read-only-sibling model (not a write-side rebuild). See its SPEC.
- **Compaction = native in-process replication** of KH `ledger-compact-done.ts`.
- **Close-tab = SSE shutdown signal + "server stopped" overlay.** True auto-close
  of an OS-opened tab is impossible (`window.close()` is blocked for non-script-
  opened tabs); the overlay is the honest deliverable.

## Task list

| # | Task | Size | Deps | Spec |
|---|------|------|------|------|
| 1 | Drag handle-only `draggable` (unblock copy-paste) | S | — | — |
| 2 | "Back to…" returns to page point (row anchors + `/#record-<id>`) | S | — | — |
| 3 | Keyword search (task-list / roadmap / backlog) | M | — | — |
| 4 | Sorting (task-list + roadmap index) | M | 3 | `ledger-sorting.md` |
| 5 | Hide done/cancelled view-filter (task-list) | S | 3 | — |
| 6 | Ledger compaction (archive done/cancelled journals) | L→slices | — | `ledger-compaction` |
| 7 | Close-tab-on-exit (SSE shutdown + overlay) | M | — | — |
| 8 | Editable ledger switch (Option A) | L→slices | — | `editable-ledger-switch` |
| 8b | (Follow-up) Option B ctx unification | M | 8 | same |

### Phase 1 — Quick wins
- Task 1: Drag handle-only draggable
- Task 2: Back-to page-point restoration

**Checkpoint 1:** `bun test` + `bun run typecheck` green; live agent-browser:
backlog rows text-selectable AND drag still works; click into a record → Back →
lands on the originating row.

### Phase 2 — Index-view interaction layer (shared plumbing, TDD'd separately)
- Task 3: Keyword search
- Task 4: Sorting (task-list + roadmap)
- Task 5: Hide done/cancelled filter

**Checkpoint 2:** search/sort/exclude compose in one URL-state per surface; round-
trip bookmarkable; existing backlog filters still green.

### Phase 3 — Server features
- Task 6: Ledger compaction (slices per its SPEC §7)
- Task 7: Close-tab-on-exit

**Checkpoint 3:** compaction dry-run + real run on a temp ledger shrinks JSON,
idempotent; SIGINT emits shutdown, client shows overlay.

### Phase 4 — Editable ledger switch
- Task 8: Option A slices 1-6 (editable-ledger-switch SPEC §5)
- Task 8b: Option B unification (separate, non-gating)

**Checkpoint 4:** launch on one ledger, switch editable target in-browser, write
lands in the switched ledger, others untouched; read-only-sibling complexity
removed; full suite green.

## Risks and mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Drag fix regresses keyboard reorder (DR-2) / read-only gating (DR-6) | Med | Keyboard path is pointer-free (untouched); add a "rows not `draggable`" regression test + live select-text check |
| Editable-switch test churn (rewriting read-only assertions) | Med | Slice 1-2 explicitly rewrite the stale assertions; regression-guard slice 6 keeps substrate green |
| Compaction data loss | High | Archive-before-truncate, refuse-overwrite, atomic apply, dry-run, abort-on-first-failure (KH safety model) |
| Close-tab over-promises auto-close | Low | Ship overlay as the deliverable; `window.close()` best-effort only, documented |
| Per-slug client mtime regressions in switch | Med | Slice 4 unit-proves distinct baseMtime per slug; no shared base |

## Open questions (defaults chosen; flag if wrong)

- Search scope = title + id per surface (not hidden body fields). *Default.*
- Hide-done is a boolean toggle (`excludeDone=1`), not a full status picker.
- Editable-switch OQ-1..4 — see its SPEC; defaults: switch-editable semantics,
  directory-as-allow-list, nav abandons open edits, umbrellas/retro hidden from
  switcher.
- Compaction OQ-1..3 — task-list only, neutral provenance, threshold 400.

## Out of scope
- bl-296 (daemon-identity `.cache`), bl-194 (flip-subtask CLI trigger) — server/CLI
  infra, tracked separately in the KH backlog.
- Backlog index sorting (rank conflict).
- Cross-tier drag promotion; multi-row drag.
