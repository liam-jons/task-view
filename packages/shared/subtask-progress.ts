/**
 * subtask-progress.ts — shared "how many Subtasks are complete" helper.
 *
 * Single source of truth for what counts as a COMPLETE Subtask across the
 * task-view surfaces: the UI index cell + open-count sort (`@task-view/ui`)
 * and the markdown mirror generator (`@task-view/server`). It lives here in
 * `@task-view/shared` — the zero-dependency leaf both packages already import —
 * so the "cancelled counts as done" rule is defined ONCE, and NOT in the
 * vendored `@task-view/schemas` bundle (which is drift-watched against upstream
 * KH — a UI/display rule must not diverge it).
 *
 * Runtime-agnostic: a pure function over `{ status }` — no schema import, no I/O.
 */

/**
 * Subtask statuses that count as "complete" for progress display.
 * `cancelled` counts as complete alongside `done` (owner decision): a Task
 * carrying cancelled Subtasks would otherwise read as forever-unfinished.
 */
export const COMPLETE_SUBTASK_STATUSES: ReadonlySet<string> = new Set([
  "done",
  "cancelled",
]);

/** Count of Subtasks that count as complete (status `done` or `cancelled`). */
export function doneSubtaskCount(
  subtasks: readonly { status: string }[],
): number {
  let done = 0;
  for (const s of subtasks) {
    if (COMPLETE_SUBTASK_STATUSES.has(s.status)) done += 1;
  }
  return done;
}
