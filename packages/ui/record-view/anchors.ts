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
 * In-page anchor id for a sibling Subtask (`subtask-3`). Used as the
 * fragment in href (`#subtask-3`) AND as the `id` attribute of the
 * Subtask block heading.
 */
export function subtaskAnchorId(subtaskId: number): string {
  return `subtask-${subtaskId}`;
}

/**
 * Href to a sibling Subtask's anchor within the same Task page.
 */
export function subtaskHref(subtaskId: number): string {
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
 * Label for a sibling-Subtask dep link (used inline in the Dependencies
 * row of the Subtask block frontmatter).
 */
export function subtaskDepLabel(
  parentTaskId: string,
  subtaskId: number,
): string {
  return `${TASK_MIRROR_PREFIX}${parentTaskId}.${subtaskId}`;
}

/**
 * Label for a Task-level dep link.
 */
export function taskDepLabel(taskId: string): string {
  return `${TASK_MIRROR_PREFIX}${taskId}`;
}
