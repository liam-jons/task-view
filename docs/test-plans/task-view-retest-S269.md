# task-view re-test verdicts — KH Subtask ID-20.13 / 20.16 / 20.18 re-test (S269)

<!-- Last verified: 26/05/2026 -->

## Why this doc exists

KH Task ID-20 closed `done` 27/27, but three of its subtask journals
(20.13 / 20.16 / 20.18) claimed **PASS** using **vacuous** tests — they
asserted against on-disk `.md` mirror artefacts, hardcoded literals, and
isolated unit tests, **NOT** the live hydrated viewer. Three real defects
slipped through as PASS:

1. **Cross-record link bug** — SSR views emitted on-disk-mirror hrefs
   (`{id}.md` / `ID-{id}.md`) that 404 on the live server (which routes
   purely on `?record=<id>`). Fixed in fork commit `c6dcdcf`.
2. **`--version` lie** — `apps/server/index.ts` hardcoded
   `console.log("task-view 0.1.0")` while the root `package.json` is
   `0.2.0`; `formatVersion()` read a `__CLI_VERSION__` define that is never
   set (no bundler step), so it would return `task-view dev`.
3. **inv-50 idle browser-close exit** — the 30s idle self-shutdown was
   **removed** in fork commit `8b0d163` (permanent fork divergence). The
   20.18 journal's "S24/inv50 browser-close idle exit (self-exit 0) PASS"
   claim is now **FALSE**.

This re-test asserts against the **LIVE hydrated viewer** (rendered DOM,
URLs, HTTP status, process-alive state) — never disk.

## Run context

- **Executor:** S269 cmux worker (branch `s269-retest-version-fix`).
- **Fork repo HEAD at run time:** `aba4de1` (the `--version` fix commit;
  cross-record fix `c6dcdcf` and idle-removal `8b0d163` already in history).
- **Live surface:** `bun apps/server/index.ts <ledger> --no-browser --port N`
  on fixed ports — task-list `:7801`, backlog `:7802`, roadmap `:7803`.
  One ledger per launch (by design). Driven with the `agent-browser`
  skill (`--session retest`): `snapshot` / `get` / `eval` / `click` /
  `press` against the rendered DOM.
- **Data safety:** canonical KH ledgers were copied to
  `/tmp/tv-retest/docs/reference/` and the servers pointed there; all
  PATCH mutations + per-record `.md` mirror writes landed under `/tmp`.
  The canonical KH ledgers were **never** mutated.
- **Canonical `task-list.json` md5:** `0e6a36b81915c0b89e3ffd0af148b07e`
  at start AND end (unchanged). The /tmp task-list copy was never edited
  (md5 also unchanged); only the /tmp **backlog** copy was mutated by the
  edit-loop scenarios.
- **Test baseline:** `bun test` = **946 pass / 0 fail** before; **946 pass
  / 0 fail** after (one new `expect` assertion, 2347 → 2348). Canonical
  `bun run typecheck` = clean (EXIT 0) before and after.

## Verdict table

| Scenario | Invariant(s) | Verdict | Observed evidence (live viewer) |
| --- | --- | --- | --- |
| **A** — cross-record link routing | inv 11/12 + nav | **PASS** | Backlog item 34's dependency link to 33 has `href="/?record=33"` (NOT `33.md`). Clicking it → URL `http://localhost:7802/?record=33`, HTTP 200, page rendered "33: Multi-client auth domain allowlist (table-driven)". All index-table links use `/?record=<id>`; **zero** `.md` hrefs anywhere in the page body. Confirms fix `c6dcdcf`. |
| **A (broken target)** — missing-dep marker + warning | inv 11/12 | **PASS** | Backlog item 52 references missing dep `P0-TX-OPTION-E`. Rendered as `<span class="record-view-broken-link">P0-TX-OPTION-E (missing)</span>` — a **non-anchor** (non-clickable), `text-decoration: line-through`, reddish colour, opacity 0.6. Page-top warning `<div class="record-view-page-top-warning">`: "Warning: This Backlog item references dependencies that don't exist in the ledger: P0-TX-OPTION-E". |
| **B** — `--version` (pre-fix) | inv (version reporting) | **FAIL → FIXED** | Pre-fix stdout: `task-view 0.1.0` (both `--version` and `-v`). Real version is `0.2.0`. Fixed in `aba4de1`; post-fix stdout `task-view 0.2.0` via `--version`, `-v`, AND `node bin/task-view.js --version`. See "before → after" below. |
| **C** — inv-50 idle (no self-exit) | inv 50 (fork-diverged) | **PASS (correct fork behaviour)** | Loaded a page on `:7801`, then left idle with **no** further requests for **41 s** (>35 s). Server PID 76275 still ALIVE (`kill -0` succeeds); `curl http://localhost:7801/` → HTTP 200; `curl .../?record=9` → HTTP 200. The old 20.18 journal's "self-exit 0 after idle" PASS is **FALSE** — fork commit `8b0d163` removed the 30s idle shutdown; server stays up until SIGTERM/Ctrl-C. |
| inv7 — frontmatter table renders rows | inv 7 | **PASS** | Task 9 (`:7801`): `.record-view-frontmatter-card` present with 9 rows (Status `in_progress`, Priority `must`, Effort estimate, Owner, Updated, Session refs, …). |
| inv8 — subtask blocks + status-enum edit affordances | inv 8 | **PASS** | Task 9: 24 `[id^=subtask-]` blocks; each carries 6 edit pencils incl. `Edit status for Subtask ID-9.N` (status-enum affordance) plus title/dependencies/description/test-strategy/details. |
| inv23 — backlog filter URL state | inv 23 | **PASS** | Loaded `:7802/?status=parked&priority=medium`. Both dropdowns pre-populated (`status=parked`, `priority=medium`); row set filtered to exactly the 3 matching items (33, 34, 52); URL retained verbatim (bookmarkable). |
| edit loop — Save (free-text) | inv 27/29 | **PASS** | Item 52 description pencil → textarea (pre-filled raw) + Save/Cancel. Edited + Save → `PATCH /api/ledger/record/52` 200, value re-rendered in place (editor closed), and the **/tmp backlog JSON actually mutated** (md5 changed `d0e831…` → `c36d88…`; later edits tracked likewise). |
| edit loop — Esc discards | inv 27 | **PASS** | Opened editor, typed, pressed `Escape` → editor closed, the typed text did **not** render in the body, and the /tmp file md5 was **unchanged** (no PATCH fired). |
| edit loop — Cmd/Ctrl+Enter saves | inv 27 | **PASS** | Opened editor, set value, dispatched `Meta+Enter` → editor closed, new value rendered in place, /tmp file mutated (md5 changed; item 52 description = "S269 saved via CMD-ENTER"). (Binding is `Mod+Enter` = `metaKey||ctrlKey`, per `packages/ui/shortcuts/core.ts`.) |
| edit loop — 409 stale mtime | inv 37 | **PASS** | Captured the client baseMtime, bumped the /tmp file out-of-band (item 34 notes), then PATCHed item 52 with the now-stale baseMtime via the live server → **HTTP 409** `{ error: "mtime-mismatch", hint: "ledger changed underneath you …", currentMtime }`. File md5 **unchanged** (item 52 stayed "clean-baseline-409v2"; **no mutation**). SPA `classifySaveResult` maps `mtime-mismatch` → `mtime-conflict` → `renderInlineError` (form stays open, draft kept) per `apps/server/web/index.tsx:622-626`. |
| edit loop — 422 schema-invalid | inv 29 | **PASS** | PATCHed item 52 `priority` = `NOT-A-VALID-PRIORITY` against the live server → **HTTP 422** `{ error: "schema-error", issues: [{ message: "Invalid option: expected one of \"must\"\|\"should\"\|…" }] }`. File md5 **unchanged** (priority stayed `medium`; **no mutation**). SPA maps `schema-error` → `renderInlineError` (inline error, form stays open with draft) per `index.tsx:617-620`. |

## `--version` before → after

| | stdout |
| --- | --- |
| **Before** (`main` / pre-fix) | `task-view 0.1.0` |
| **After** (`aba4de1`) | `task-view 0.2.0` |

Verified post-fix via all three invocation paths: `bun apps/server/index.ts
--version`, `bun apps/server/index.ts -v`, and `node bin/task-view.js
--version` (the real install path). The version is now sourced from the
ROOT `package.json` via Bun's native JSON import (`../../package.json` from
`apps/server/cli.ts`), routed through `formatVersion()` and used by both
`cli.ts` and the `--version` branch in `index.ts`.

## inv-50 finding (explicit)

The ID-20.18 journal's claim **"S24/inv50 browser-close idle exit (self-exit
0) PASS"** is **FALSE** for the fork. Fork commit `8b0d163`
(`fix(server): remove 30s idle browser-close shutdown`) **permanently
removed** the PRODUCT-inv-50 idle self-exit. The correct, current behaviour
is: **the server runs until Ctrl-C / SIGTERM and does NOT self-exit on
idle.** This re-test confirmed the server was still alive and serving HTTP
200 after a 41-second idle window.

## Which prior journal claims were vacuous

- **20.13 / 20.16 / 20.18 cross-record link "PASS":** vacuous — asserted
  against on-disk `.md` mirror filenames, which is exactly the wrong target
  (the live server 404s those and routes on `?record=`). The live re-test
  (Scenario A) confirms the corrected behaviour now ships (`c6dcdcf`): every
  cross-record href is `/?record=<id>` and clicking navigates correctly.
- **`--version` "PASS":** vacuous — any check that accepted `task-view
  0.1.0` (or `dev`) was asserting a hardcoded/never-set literal, not the
  real tool version. Now fixed and asserted against the canonical root
  `package.json` so it tracks future bumps.
- **20.18 inv-50 "self-exit 0 after idle" PASS:** false against the fork —
  the behaviour was removed before that journal was written. The live
  re-test asserts the correct post-`8b0d163` behaviour (stays up).

## Cleanup

All three servers (`:7801` / `:7802` / `:7803`) were killed; the
`agent-browser --session retest` session was closed. The canonical KH
`task-list.json` md5 was `0e6a36b81915c0b89e3ffd0af148b07e` at start and
end (unchanged). No push, no tag.
