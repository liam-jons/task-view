/**
 * index-views.test.tsx — verifies the Task-list and Roadmap index page
 * renderers (TECH §4.3, PRODUCT inv 14, 47).
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Task } from "@task-view/schemas/task-list";
import type {
  Roadmap,
  RoadmapTheme,
} from "@task-view/schemas/roadmap";
import { TaskListIndexView } from "./task-list-index-view";
import { RoadmapIndexView } from "./roadmap-index-view";

const mkTask = (overrides: Partial<Task> = {}): Task => ({
  id: "20",
  title: "Task title",
  description: "Description.",
  status: "pending",
  priority: "must",
  dependencies: [],
  subtasks: [],
  updatedAt: "2026-05-21T15:30:00.000Z",
  effort_estimate: null,
  owner: null,
  priority_note: null,
  status_note: null,
  cross_doc_links: [],
  session_refs: [],
  commit_refs: [],
  ...overrides,
});

const mkTheme = (overrides: Partial<RoadmapTheme> = {}): RoadmapTheme => ({
  id: "1",
  title: "Theme 1",
  description: "Theme 1 description.",
  time_horizon: "now",
  status: "in_progress",
  linked_tasks: [],
  linked_backlog: [],
  session_refs: [],
  commit_refs: [],
  cross_doc_links: [],
  notes: null,
  ...overrides,
});

const mkRoadmap = (themes: RoadmapTheme[]): Roadmap => ({
  document_name: "Knowledge Hub Roadmap",
  document_purpose: "test",
  date: "2026-05-21",
  status: "Active",
  forward_looking_only: true,
  related_documents: [],
  last_updated: "test",
  themes,
});

// ── Task-list index ──────────────────────────────────────────────────────────

describe("TaskListIndexView (TECH §4.3)", () => {
  test("renders ID / Title / Status / Priority / Subtasks columns", () => {
    const tasks = [
      mkTask({ id: "20", title: "Twenty" }),
      mkTask({ id: "21", title: "Twenty-one" }),
    ];
    const html = renderToStaticMarkup(<TaskListIndexView tasks={tasks} />);
    // Columns are sortable headers (clickable, aria-sort) — one per field.
    expect(html).toContain('data-sort-trigger="id"');
    expect(html).toContain('data-sort-trigger="title"');
    expect(html).toContain('data-sort-trigger="status"');
    expect(html).toContain('data-sort-trigger="priority"');
    expect(html).toContain('data-sort-trigger="subtasks"');
    expect(html).toContain('data-task-row="20"');
    expect(html).toContain('data-task-row="21"');
    expect(html).toContain('data-task-link="20"');
    expect(html).toContain('href="/?record=20"');
    expect(html).toContain("Twenty-one");
  });

  test("each task row carries id=\"record-{id}\" so a back link can scroll to it", () => {
    const tasks = [mkTask({ id: "20" }), mkTask({ id: "21" })];
    const html = renderToStaticMarkup(<TaskListIndexView tasks={tasks} />);
    expect(html).toContain('id="record-20"');
    expect(html).toContain('id="record-21"');
  });

  test("renders completed/total subtasks per task (done + cancelled count as complete)", () => {
    const mkSub = (id: string, status: string) => ({
      id,
      title: `S${id}`,
      description: `S${id} desc`,
      details: "",
      status,
      dependencies: [],
      testStrategy: null,
    });
    const tasks = [
      mkTask({
        id: "20",
        subtasks: [
          mkSub("1", "done"),
          mkSub("2", "cancelled"),
          mkSub("3", "pending"),
          mkSub("4", "deferred"),
        ] as Task["subtasks"],
      }),
    ];
    const html = renderToStaticMarkup(<TaskListIndexView tasks={tasks} />);
    // done(1) + cancelled(1) = 2 complete of 4 total → "2/4"
    expect(html).toMatch(/data-task-row="20"[\s\S]*?<td>2\/4<\/td>\s*<\/tr>/);
  });

  test("subtasks cell reads 0/0 for an atomic Task with no subtasks", () => {
    const tasks = [mkTask({ id: "20", subtasks: [] })];
    const html = renderToStaticMarkup(<TaskListIndexView tasks={tasks} />);
    expect(html).toMatch(/data-task-row="20"[\s\S]*?<td>0\/0<\/td>\s*<\/tr>/);
  });

  test("renders empty-state when tasks list is empty (PRODUCT inv 47)", () => {
    const html = renderToStaticMarkup(<TaskListIndexView tasks={[]} />);
    expect(html).toContain('data-empty-ledger="task-list"');
    expect(html).toContain("Task list ledger is empty");
  });

  test("renders a keyword search box and filters rows by q (title/id)", () => {
    const tasks = [
      mkTask({ id: "20", title: "Auth flow" }),
      mkTask({ id: "21", title: "Billing" }),
    ];
    const all = renderToStaticMarkup(<TaskListIndexView tasks={tasks} />);
    expect(all).toContain("data-search-control");
    const filtered = renderToStaticMarkup(
      <TaskListIndexView tasks={tasks} filters={{ q: "auth" }} />,
    );
    expect(filtered).toContain('data-task-row="20"');
    expect(filtered).not.toContain('data-task-row="21"');
    // the search box reflects the active query
    expect(filtered).toContain('value="auth"');
  });

  test("filtered-to-empty shows a no-matches state, not the empty-ledger state", () => {
    const tasks = [mkTask({ id: "20", title: "Auth" })];
    const html = renderToStaticMarkup(
      <TaskListIndexView tasks={tasks} filters={{ q: "zzz" }} />,
    );
    expect(html).toContain("data-empty-filtered");
    expect(html).not.toContain("data-empty-ledger");
  });

  test("sorts rows by the active column (id desc) and exposes aria-sort", () => {
    const tasks = [mkTask({ id: "2" }), mkTask({ id: "10" }), mkTask({ id: "1" })];
    const html = renderToStaticMarkup(
      <TaskListIndexView tasks={tasks} sort={{ field: "id", dir: "desc" }} />,
    );
    const order = [...html.matchAll(/data-task-row="(\d+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["10", "2", "1"]);
    expect(html).toContain('aria-sort="descending"');
  });

  test("renders a 'hide done/cancelled' toggle that excludes those statuses", () => {
    const tasks = [
      mkTask({ id: "1", status: "done" }),
      mkTask({ id: "2", status: "in_progress" }),
      mkTask({ id: "3", status: "cancelled" }),
    ];
    const all = renderToStaticMarkup(<TaskListIndexView tasks={tasks} />);
    expect(all).toContain("data-exclude-done-control");

    const hidden = renderToStaticMarkup(
      <TaskListIndexView tasks={tasks} filters={{ q: null, excludeDone: true }} />,
    );
    expect(hidden).toContain('data-task-row="2"');
    expect(hidden).not.toContain('data-task-row="1"');
    expect(hidden).not.toContain('data-task-row="3"');
    // the checkbox reflects the active state
    expect(hidden).toContain("checked");
  });
});

// ── Roadmap index ─────────────────────────────────────────────────────────────

describe("RoadmapIndexView (themes[] — ID-20.19)", () => {
  test("renders ID / Title / Time horizon / Status / Linked tasks columns", () => {
    const roadmap = mkRoadmap([
      mkTheme({ id: "1", title: "T1", time_horizon: "now", status: "in_progress" }),
      mkTheme({
        id: "42",
        title: "T42",
        time_horizon: "later",
        status: "pending",
      }),
    ]);
    const html = renderToStaticMarkup(
      <RoadmapIndexView roadmap={roadmap} />,
    );
    expect(html).toContain('data-sort-trigger="id"');
    expect(html).toContain('data-sort-trigger="title"');
    expect(html).toContain('data-sort-trigger="time_horizon"');
    expect(html).toContain('data-sort-trigger="status"');
    expect(html).toContain('data-sort-trigger="linked_tasks"');
    expect(html).toContain('data-theme-row="1"');
    expect(html).toContain('data-theme-row="42"');
    expect(html).toContain('href="/?record=1"');
    expect(html).toContain('href="/?record=42"');
    expect(html).toContain(">now<");
    expect(html).toContain(">later<");
    // theme count reported
    expect(html).toContain('data-theme-count="2"');
    expect(html).toContain("2 themes");
  });

  test("each theme row carries id=\"record-{id}\" for back-to-page-point", () => {
    const roadmap = mkRoadmap([mkTheme({ id: "1" }), mkTheme({ id: "42" })]);
    const html = renderToStaticMarkup(<RoadmapIndexView roadmap={roadmap} />);
    expect(html).toContain('id="record-1"');
    expect(html).toContain('id="record-42"');
  });

  test("renders linked-task count per theme", () => {
    const roadmap = mkRoadmap([
      mkTheme({ id: "1", linked_tasks: ["20", "21", "22"] }),
    ]);
    const html = renderToStaticMarkup(
      <RoadmapIndexView roadmap={roadmap} />,
    );
    expect(html).toMatch(/data-theme-row="1"[\s\S]*?<td>3<\/td>\s*<\/tr>/);
  });

  test("renders empty-state when themes list is empty (PRODUCT inv 47)", () => {
    const roadmap = mkRoadmap([]);
    const html = renderToStaticMarkup(
      <RoadmapIndexView roadmap={roadmap} />,
    );
    expect(html).toContain('data-empty-ledger="roadmap"');
  });

  test("renders a keyword search box and filters themes by q (title/id)", () => {
    const roadmap = mkRoadmap([
      mkTheme({ id: "1", title: "Platform" }),
      mkTheme({ id: "2", title: "Growth" }),
    ]);
    const filtered = renderToStaticMarkup(
      <RoadmapIndexView roadmap={roadmap} filters={{ q: "growth" }} />,
    );
    expect(filtered).toContain("data-search-control");
    expect(filtered).toContain('data-theme-row="2"');
    expect(filtered).not.toContain('data-theme-row="1"');
  });

  test("sorts themes by the active column (id asc) and exposes aria-sort", () => {
    const roadmap = mkRoadmap([
      mkTheme({ id: "2" }),
      mkTheme({ id: "10" }),
      mkTheme({ id: "1" }),
    ]);
    const html = renderToStaticMarkup(
      <RoadmapIndexView roadmap={roadmap} sort={{ field: "id", dir: "asc" }} />,
    );
    const order = [...html.matchAll(/data-theme-row="(\d+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["1", "2", "10"]);
    expect(html).toContain('aria-sort="ascending"');
  });
});
