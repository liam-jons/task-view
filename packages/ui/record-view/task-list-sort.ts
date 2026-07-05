/**
 * record-view/task-list-sort.ts — pure sort for the Task-list index page
 * (docs/notes/ledger-sorting.md). Mirrors backlog-sort.ts: pure, deterministic,
 * stable (decorate-sort-undecorate), no React/DOM/I/O.
 *
 * `sort.field === null` (or an unrecognised field) keeps the ledger's natural
 * (JSON array) order — the default the index has always rendered. Sortable
 * columns: id (numeric), title, status (both alphabetic), priority (canonical
 * MoSCoW→ranked ordinal, reused from backlog-sort), subtasks (open count =
 * total − done, so Tasks still carrying unfinished Subtasks sort apart from
 * fully-resolved ones).
 */
import type { SortState } from "./url-state";
import { PRIORITY_ORDINALS } from "./backlog-sort";
import { doneSubtaskCount } from "@task-view/shared/subtask-progress";

type SortableTask = {
  id: string;
  title: string;
  status: string;
  priority: string;
  subtasks: readonly { status: string }[];
};

const TASK_SORT_FIELDS = new Set<string>([
  "id",
  "title",
  "status",
  "priority",
  "subtasks",
]);

/** Numeric-friendly id compare so "10" sorts after "9", not after "1". */
function numericIdCompare(a: string, b: string): number {
  const an = Number.parseInt(a, 10);
  const bn = Number.parseInt(b, 10);
  if (!Number.isNaN(an) && !Number.isNaN(bn) && an !== bn) return an - bn;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function byString(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

function taskFieldCompare(
  field: string,
  a: SortableTask,
  b: SortableTask,
): number {
  switch (field) {
    case "id":
      return numericIdCompare(a.id, b.id);
    case "title":
      return byString(a.title, b.title);
    case "status":
      return byString(a.status, b.status);
    case "priority":
      return (
        (PRIORITY_ORDINALS[a.priority as keyof typeof PRIORITY_ORDINALS] ?? 99) -
        (PRIORITY_ORDINALS[b.priority as keyof typeof PRIORITY_ORDINALS] ?? 99)
      );
    case "subtasks":
      // Sort by OPEN subtask count (total − done) rather than raw total, so a
      // done Task hiding a deferred Subtask surfaces alongside other unfinished
      // work rather than reading as complete.
      return (
        (a.subtasks.length - doneSubtaskCount(a.subtasks)) -
        (b.subtasks.length - doneSubtaskCount(b.subtasks))
      );
    default:
      return 0;
  }
}

export function sortTasksForIndex<T extends SortableTask>(
  tasks: readonly T[],
  sort: SortState,
): T[] {
  if (sort.field === null || !TASK_SORT_FIELDS.has(sort.field)) {
    return [...tasks];
  }
  const field = sort.field;
  const decorated = tasks.map((task, idx) => ({ task, idx }));
  decorated.sort((a, b) => {
    const c = taskFieldCompare(field, a.task, b.task);
    if (c !== 0) return sort.dir === "desc" ? -c : c;
    return a.idx - b.idx; // stable tiebreak — preserve input order
  });
  return decorated.map((d) => d.task);
}
