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
    expect(html).toContain('<th scope="col">ID</th>');
    expect(html).toContain('<th scope="col">Title</th>');
    expect(html).toContain('<th scope="col">Status</th>');
    expect(html).toContain('<th scope="col">Priority</th>');
    expect(html).toContain('<th scope="col">Subtasks</th>');
    expect(html).toContain('data-task-row="20"');
    expect(html).toContain('data-task-row="21"');
    expect(html).toContain('data-task-link="20"');
    expect(html).toContain('href="/?record=20"');
    expect(html).toContain("Twenty-one");
  });

  test("renders subtask count per task", () => {
    const tasks = [
      mkTask({
        id: "20",
        subtasks: [
          {
            id: 1,
            title: "S1",
            description: "S1 desc",
            details: "",
            status: "pending",
            dependencies: [],
            testStrategy: null,
          },
          {
            id: 2,
            title: "S2",
            description: "S2 desc",
            details: "",
            status: "pending",
            dependencies: [],
            testStrategy: null,
          },
        ],
      }),
    ];
    const html = renderToStaticMarkup(<TaskListIndexView tasks={tasks} />);
    // The Subtasks column for ID 20 reports 2
    expect(html).toMatch(/data-task-row="20"[\s\S]*?<td>2<\/td>\s*<\/tr>/);
  });

  test("renders empty-state when tasks list is empty (PRODUCT inv 47)", () => {
    const html = renderToStaticMarkup(<TaskListIndexView tasks={[]} />);
    expect(html).toContain('data-empty-ledger="task-list"');
    expect(html).toContain("Task list ledger is empty");
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
    expect(html).toContain('<th scope="col">ID</th>');
    expect(html).toContain('<th scope="col">Title</th>');
    expect(html).toContain('<th scope="col">Time horizon</th>');
    expect(html).toContain('<th scope="col">Status</th>');
    expect(html).toContain('<th scope="col">Linked tasks</th>');
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
});
