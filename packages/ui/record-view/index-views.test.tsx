/**
 * index-views.test.tsx — verifies the Task-list and Initiatives index page
 * renderers (TECH §4.3, PRODUCT inv 14, 47; ID-148.10 repurposes the
 * roadmap arm).
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Task } from "@task-view/schemas/task-list";
import type {
  InitiativesDocument,
  Initiative,
  Project,
} from "@task-view/schemas/initiatives";
import { TaskListIndexView } from "./task-list-index-view";
import { InitiativesIndexView } from "./initiatives-index-view";

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

const mkProject = (overrides: Partial<Project> = {}): Project => ({
  id: "sample-project",
  title: "Sample project",
  summary: "s",
  description: "d",
  substrate_doc: "",
  status: "idea",
  blocked_by: [],
  blocking: [],
  linked_tasks: [],
  linked_backlog: [],
  originating_session: [],
  ...overrides,
});

const mkInitiative = (overrides: Partial<Initiative> = {}): Initiative => ({
  id: "1",
  title: "Initiative 1",
  description: "Initiative 1 description.",
  status: "active",
  projects: [],
  originating_session: [],
  "sub-initiatives": [],
  ...overrides,
});

const mkInitiativesDoc = (
  initiatives: Initiative[],
): InitiativesDocument => ({
  document_name: "Canonical Platform - Initiatives",
  document_purpose: "test",
  date: "2026-07-15",
  status: "active",
  related_documents: [],
  last_updated: "test",
  initiatives,
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

// ── Initiatives index (ID-148.10, repurposed roadmap arm) ────────────────────

describe("InitiativesIndexView (top-level initiatives only — INV-9)", () => {
  test("renders ID / Title / Status / Projects columns", () => {
    const doc = mkInitiativesDoc([
      mkInitiative({ id: "1", title: "I1", status: "active" }),
      mkInitiative({
        id: "42",
        title: "I42",
        status: "proposed",
      }),
    ]);
    const html = renderToStaticMarkup(
      <InitiativesIndexView initiatives={doc} />,
    );
    expect(html).toContain('data-sort-trigger="id"');
    expect(html).toContain('data-sort-trigger="title"');
    expect(html).toContain('data-sort-trigger="status"');
    expect(html).toContain('data-sort-trigger="project_count"');
    expect(html).toContain('data-initiative-row="1"');
    expect(html).toContain('data-initiative-row="42"');
    expect(html).toContain('href="/?record=1"');
    expect(html).toContain('href="/?record=42"');
    // initiative count reported
    expect(html).toContain('data-initiative-count="2"');
    expect(html).toContain("2 initiatives");
  });

  test("each initiative row carries id=\"record-{id}\" for back-to-page-point", () => {
    const doc = mkInitiativesDoc([
      mkInitiative({ id: "1" }),
      mkInitiative({ id: "42" }),
    ]);
    const html = renderToStaticMarkup(
      <InitiativesIndexView initiatives={doc} />,
    );
    expect(html).toContain('id="record-1"');
    expect(html).toContain('id="record-42"');
  });

  test("renders RECURSIVE project count per top-level initiative (INV-13)", () => {
    const doc = mkInitiativesDoc([
      mkInitiative({
        id: "1",
        projects: [mkProject({ id: "direct" })],
        "sub-initiatives": [
          {
            id: "1",
            title: "Sub",
            description: "d",
            status: "planned",
            projects: [mkProject({ id: "nested" })],
            originating_session: [],
            "sub-initiatives": [],
          },
        ],
      }),
    ]);
    const html = renderToStaticMarkup(
      <InitiativesIndexView initiatives={doc} />,
    );
    // 1 direct + 1 nested = 2
    expect(html).toMatch(/data-initiative-row="1"[\s\S]*?<td>2<\/td>\s*<\/tr>/);
  });

  test("renders empty-state when initiatives list is empty (PRODUCT inv 47)", () => {
    const doc = mkInitiativesDoc([]);
    const html = renderToStaticMarkup(
      <InitiativesIndexView initiatives={doc} />,
    );
    expect(html).toContain('data-empty-ledger="initiatives"');
  });

  test("renders a keyword search box and filters initiatives by q (title/id)", () => {
    const doc = mkInitiativesDoc([
      mkInitiative({ id: "1", title: "Platform" }),
      mkInitiative({ id: "2", title: "Growth" }),
    ]);
    const filtered = renderToStaticMarkup(
      <InitiativesIndexView initiatives={doc} filters={{ q: "growth" }} />,
    );
    expect(filtered).toContain("data-search-control");
    expect(filtered).toContain('data-initiative-row="2"');
    expect(filtered).not.toContain('data-initiative-row="1"');
  });

  test("sorts initiatives by the active column (id asc) and exposes aria-sort", () => {
    const doc = mkInitiativesDoc([
      mkInitiative({ id: "2" }),
      mkInitiative({ id: "10" }),
      mkInitiative({ id: "1" }),
    ]);
    const html = renderToStaticMarkup(
      <InitiativesIndexView
        initiatives={doc}
        sort={{ field: "id", dir: "asc" }}
      />,
    );
    const order = [...html.matchAll(/data-initiative-row="(\d+)"/g)].map(
      (m) => m[1],
    );
    expect(order).toEqual(["1", "2", "10"]);
    expect(html).toContain('aria-sort="ascending"');
  });
});
