/**
 * record-view/anchors.ts — in-page anchor builders for sibling-Subtask
 * deps (PRODUCT inv 13, TECH §4.4).
 *
 * "Within a Task page, sibling Subtask links resolve to in-page anchors
 *  (`#subtask-${subtaskId}`) generated via Plannotator's `slugify.ts`."
 *
 * The id is the Subtask integer id (1..N within the parent Task). We use
 * the deterministic `subtask-${id}` form (no slugify needed because the
 * id is already a bare integer); the slugify helper from the upstream
 * parser is reserved for heading-derived anchors per its own contract.
 *
 * The live-server cross-record href builder (`recordRouteHref`) also
 * lives here so the per-mode renderers don't duplicate route logic.
 */

const TASK_MIRROR_PREFIX = "ID-";

/**
 * The three cross-ledger nav slugs ({20.29}, SPEC §2). Declared in the UI
 * layer (and mirrored server-side in `packages/server/cross-ledger.ts`)
 * because `packages/ui` must not import from `packages/server` — the slug
 * string set is a tiny, stable contract shared by both. Keep the two in
 * sync (both derive from the same SPEC §2 table).
 */
export type LedgerSlug = "task-list" | "roadmap" | "backlog";

/**
 * In-page anchor id for a sibling Subtask (`subtask-3`). Used as the
 * fragment in href (`#subtask-3`) AND as the `id` attribute of the
 * Subtask block heading.
 */
export function subtaskAnchorId(subtaskId: string): string {
  return `subtask-${subtaskId}`;
}

/**
 * Href to a sibling Subtask's anchor within the same Task page.
 */
export function subtaskHref(subtaskId: string): string {
  return `#${subtaskAnchorId(subtaskId)}`;
}

/**
 * Href to another record's page on the live loopback server, from any
 * record or index page.
 *
 * The server routes every record kind (Task / Roadmap theme / Backlog
 * item) purely on the `?record=<id>` query param — see
 * `packages/server/render-viewer.tsx`. The record id is unique within a
 * ledger and the server already knows the ledger kind, so one builder
 * serves all three kinds. There is no per-kind `.md` route on the live
 * surface: the `ID-{id}.md` / `{id}.md` filenames exist only as on-disk
 * mirrors, emitted independently by `mirror-generator.ts` /
 * `index-generator.ts`.
 */
export function recordRouteHref(recordId: string): string {
  return `/?record=${encodeURIComponent(recordId)}`;
}

/**
 * Href to a record in a SIBLING ledger ({20.29}, SPEC §5 slice 2).
 *
 * Form: `/?ledger=<slug>&record=<id>`. The server (handleGetRoot) parses
 * the `ledger` slug, resolves the sibling ledger's path in the launched
 * ledger's directory, and renders that sibling's record READ-ONLY.
 *
 * The slug is a server-controlled literal (never user input here) so it is
 * emitted verbatim; only the record id is URL-encoded. Distinct from
 * `recordRouteHref`, which stays the intra-ledger (launched-ledger) form
 * and must remain byte-for-byte back-compatible (`/?record=<id>`).
 */
export function crossLedgerRecordHref(
  slug: LedgerSlug,
  recordId: string,
): string {
  return `/?ledger=${slug}&record=${encodeURIComponent(recordId)}`;
}

/**
 * Label for a sibling-Subtask dep link (used inline in the Dependencies
 * row of the Subtask block frontmatter).
 */
export function subtaskDepLabel(
  parentTaskId: string,
  subtaskId: string,
): string {
  return `${TASK_MIRROR_PREFIX}${parentTaskId}.${subtaskId}`;
}

/**
 * Label for a Task-level dep link.
 */
export function taskDepLabel(taskId: string): string {
  return `${TASK_MIRROR_PREFIX}${taskId}`;
}
