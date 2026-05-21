/**
 * index-views.test.tsx — verifies the Task-list and Roadmap index page
 * renderers (TECH §4.3, PRODUCT inv 14, 47).
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Task } from "@task-view/schemas/task-list";
import type {
  Roadmap,
  RoadmapSection,
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

const mkSection = (overrides: Partial<RoadmapSection> = {}): RoadmapSection => ({
  id: "1",
  parent_id: null,
  number: "1",
  title: "Section 1",
  narrative: null,
  spec_links: [],
  owner: "Engineering",
  table_columns: "item_desc_owner_effort_status",
  items: [],
  ...overrides,
});

const mkRoadmap = (sections: RoadmapSection[]): Roadmap => ({
  document_name: "Knowledge Hub Roadmap",
  document_purpose: "test",
  date: "2026-05-21",
  status: "Active",
  forward_looking_only: true,
  related_documents: [],
  last_updated: "test",
  sections,
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
    expect(html).toContain('href="ID-20.md"');
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

describe("RoadmapIndexView (PRODUCT inv 14)", () => {
  test("renders ID / Title / Owner / Item count columns", () => {
    const roadmap = mkRoadmap([
      mkSection({ id: "1", title: "S1", owner: "Eng" }),
      mkSection({
        id: "3.1",
        title: "S3.1",
        owner: null,
        items: [],
      }),
    ]);
    const html = renderToStaticMarkup(
      <RoadmapIndexView roadmap={roadmap} />,
    );
    expect(html).toContain('<th scope="col">ID</th>');
    expect(html).toContain('<th scope="col">Title</th>');
    expect(html).toContain('<th scope="col">Owner</th>');
    expect(html).toContain('<th scope="col">Item count</th>');
    expect(html).toContain('data-section-row="1"');
    expect(html).toContain('data-section-row="3.1"');
    expect(html).toContain('href="section-1.md"');
    expect(html).toContain('href="section-3.1.md"');
    expect(html).toContain(">Eng<");
    // null owner displays as em-dash
    expect(html).toContain(">—<");
  });

  test("renders item-count per section", () => {
    const roadmap = mkRoadmap([
      mkSection({
        id: "1",
        items: [
          {
            id: "1.1",
            section_id: "1",
            title: "I",
            phase_label: null,
            description: "d",
            effort_estimate: null,
            priority: null,
            priority_note: null,
            severity: null,
            status: null,
            status_note: null,
            owner: null,
            depends_on: [],
            blocks: [],
            coordinates_with: [],
            cross_doc_links: [],
            session_refs: [],
            commit_refs: [],
          },
        ],
      }),
    ]);
    const html = renderToStaticMarkup(
      <RoadmapIndexView roadmap={roadmap} />,
    );
    expect(html).toMatch(/data-section-row="1"[\s\S]*?<td>1<\/td>\s*<\/tr>/);
  });

  test("renders empty-state when sections list is empty (PRODUCT inv 47)", () => {
    const roadmap = mkRoadmap([]);
    const html = renderToStaticMarkup(
      <RoadmapIndexView roadmap={roadmap} />,
    );
    expect(html).toContain('data-empty-ledger="roadmap"');
  });
});
