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
import { recordRouteHref } from "./anchors";

export const TaskListIndexView: React.FC<{
  tasks: readonly Task[];
}> = ({ tasks }) => {
  return (
    <article
      className="record-view-task-list-index"
      data-record-kind="task-list-index"
    >
      <header>
        <h1>Task list</h1>
        <p
          className="record-view-task-list-index-count"
          data-task-count={tasks.length}
        >
          {tasks.length} Task{tasks.length === 1 ? "" : "s"}
        </p>
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
      ) : (
        <table
          className="record-view-task-list-table"
          data-task-list-table
        >
          <thead>
            <tr>
              <th scope="col">ID</th>
              <th scope="col">Title</th>
              <th scope="col">Status</th>
              <th scope="col">Priority</th>
              <th scope="col">Subtasks</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.id} data-task-row={task.id}>
                <td>
                  <a
                    href={recordRouteHref(task.id)}
                    data-task-link={task.id}
                  >
                    ID-{task.id}
                  </a>
                </td>
                <td>{task.title}</td>
                <td>{task.status}</td>
                <td>{task.priority}</td>
                <td>{task.subtasks.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </article>
  );
};
