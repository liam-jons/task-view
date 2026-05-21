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
 * Repo-relative href builders for cross-record links also live here so
 * the per-mode renderers don't duplicate path logic.
 */

const TASK_MIRROR_PREFIX = "ID-";
const TASK_MIRROR_EXT = ".md";

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
 * Href to another Task's mirror file from any Task page.
 * Form: `ID-{taskId}.md` (sibling-directory relative).
 */
export function taskMirrorHref(taskId: string): string {
  return `${TASK_MIRROR_PREFIX}${taskId}${TASK_MIRROR_EXT}`;
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

/**
 * Href to a Roadmap item page (cross-record link).
 */
export function roadmapItemHref(itemId: string): string {
  return `${itemId}.md`;
}

/**
 * Href to a Roadmap section page.
 */
export function roadmapSectionHref(sectionId: string): string {
  return `section-${sectionId}.md`;
}

/**
 * Href to a Backlog item page.
 */
export function backlogItemHref(itemId: string): string {
  return `${itemId}.md`;
}
