/**
 * status-badge.test.tsx — OQ-4 status/priority badge contract.
 *
 * Asserts the data hooks (data-status / data-priority) the CSS attribute
 * selectors key on, and that the badge TEXT is the RAW value (not humanised)
 * so the enum edit pre-select's textContent match keeps working.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusBadge, PriorityBadge } from "./status-badge";
import { TaskListIndexView } from "./task-list-index-view";
import type { Task } from "@task-view/schemas/task-list";

describe("StatusBadge / PriorityBadge", () => {
  test("status badge emits data-status hook + raw value text", () => {
    const html = renderToStaticMarkup(<StatusBadge status="in_progress" />);
    expect(html).toContain('class="record-view-status-badge"');
    expect(html).toContain('data-status="in_progress"');
    // RAW value (not 'in progress') — preserves the dispatcher's enum
    // pre-select exact-match (textContent === option value).
    expect(html).toContain(">in_progress</span>");
  });

  test("priority badge emits data-priority hook + raw value text", () => {
    const html = renderToStaticMarkup(<PriorityBadge priority="high" />);
    expect(html).toContain('class="record-view-priority-badge"');
    expect(html).toContain('data-priority="high"');
    expect(html).toContain(">high</span>");
  });
});

describe("index tables render status/priority as badges (OQ-4)", () => {
  const mkTask = (over: Partial<Task>): Task =>
    ({
      id: "20",
      title: "T",
      status: "in_progress",
      priority: "must",
      effort_estimate: "M",
      owner: null,
      updatedAt: "2026-01-01",
      session_refs: [],
      commit_refs: [],
      dependencies: [],
      cross_doc_links: [],
      priority_note: null,
      status_note: null,
      description: "",
      subtasks: [],
      ...over,
    }) as unknown as Task;

  test("task-list index status/priority cells carry the data hooks", () => {
    const html = renderToStaticMarkup(
      <TaskListIndexView tasks={[mkTask({})]} />,
    );
    expect(html).toContain('data-status="in_progress"');
    expect(html).toContain('data-priority="must"');
  });
});
