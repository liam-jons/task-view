/**
 * record-view/task-list-index-view.tsx — Task-list index page renderer.
 *
 * Per TECH §4.3: "Task-list mode gets a similar `index.md` at
 * `tasks/index.md` listing every Task with id, title, status, priority,
 * plus a count of Subtasks."
 *
 * Also covers PRODUCT inv 47 (empty ledger empty-state page) for the
 * Task-list mode.
 */
import React from "react";
import type { Task } from "@task-view/schemas/task-list";
import { activeRecordHref, indexRowAnchorId, type LedgerSlug } from "./anchors";
import { PriorityBadge, StatusBadge } from "./status-badge";
import { IndexSearchBox } from "./index-search";
import { SortableColumnHeader } from "./sortable-header";
import { sortTasksForIndex } from "./task-list-sort";
import {
  applyTaskListFilters,
  type SortState,
  type TaskListFilterState,
} from "./url-state";

export const TaskListIndexView: React.FC<{
  tasks: readonly Task[];
  filters?: TaskListFilterState;
  sort?: SortState;
  activeSlug?: LedgerSlug | null;
}> = ({ tasks, filters, sort, activeSlug }) => {
  const f = filters ?? { q: null };
  const s = sort ?? { field: null, dir: "asc" };
  const visible = sortTasksForIndex(applyTaskListFilters(tasks, f), s);
  return (
    <article
      className="record-view-task-list-index"
      data-record-kind="task-list-index"
    >
      <header>
        <h1>Task list</h1>
        <p
          className="record-view-task-list-index-count"
          data-task-count={visible.length}
          data-task-total={tasks.length}
        >
          {visible.length} Task{visible.length === 1 ? "" : "s"}
        </p>
        {tasks.length === 0 ? null : (
          <div className="record-view-index-controls">
            <IndexSearchBox q={f.q ?? null} />
            <label className="record-view-exclude-done">
              <input
                type="checkbox"
                data-exclude-done-control
                defaultChecked={f.excludeDone ?? false}
              />{" "}
              Hide done / cancelled
            </label>
          </div>
        )}
      </header>

      {tasks.length === 0 ? (
        <p
          className="record-view-empty-ledger"
          data-empty-ledger="task-list"
        >
          <em>The Task list ledger is empty. Add Tasks via the
          canonical creation path (workflow-curator skill or manual
          JSON edit).</em>
        </p>
      ) : visible.length === 0 ? (
        <p className="record-view-empty-filtered" data-empty-filtered>
          <em>No Tasks match the search.</em>
        </p>
      ) : (
        <table
          className="record-view-task-list-table"
          data-task-list-table
        >
          <thead>
            <tr>
              <SortableColumnHeader field="id" label="ID" sort={s} />
              <SortableColumnHeader field="title" label="Title" sort={s} />
              <SortableColumnHeader field="status" label="Status" sort={s} />
              <SortableColumnHeader
                field="priority"
                label="Priority"
                sort={s}
              />
              <SortableColumnHeader
                field="subtasks"
                label="Subtasks"
                sort={s}
              />
            </tr>
          </thead>
          <tbody>
            {visible.map((task) => (
              <tr
                key={task.id}
                id={indexRowAnchorId(task.id)}
                data-task-row={task.id}
              >
                <td>
                  <a
                    href={activeRecordHref(task.id, activeSlug)}
                    data-task-link={task.id}
                  >
                    ID-{task.id}
                  </a>
                </td>
                <td>{task.title}</td>
                <td>
                  <StatusBadge status={task.status} />
                </td>
                <td>
                  <PriorityBadge priority={task.priority} />
                </td>
                <td>{task.subtasks.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </article>
  );
};
