/**
 * index-generator.test.ts — verifies the per-mode index.md generator
 * extension (TECH §4.3, PRODUCT inv 14, 20, 47, 52).
 */
import { describe, expect, test } from "bun:test";
import { sep } from "node:path";
import { detectSchema } from "./detect-schema";
import {
  indexMdPath,
  renderIndexMd,
} from "./index-generator";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const taskListFixture = {
  document_name: "Knowledge Hub Task List" as const,
  document_purpose: "fixture",
  related_documents: [],
  tasks: [
    {
      id: "20",
      title: "Twenty",
      description: "d",
      status: "in_progress",
      priority: "must",
      dependencies: [],
      subtasks: [
        {
          id: "1",
          title: "S1",
          description: "S1 desc",
          details: "",
          status: "pending",
          dependencies: [],
          testStrategy: null,
        },
      ],
      updatedAt: "2026-05-21T15:30:00.000Z",
      effort_estimate: null,
      owner: null,
      priority_note: null,
      status_note: null,
      cross_doc_links: [],
      session_refs: [],
      commit_refs: [],
    },
    {
      id: "21",
      title: "Pipe | character title",
      description: "d",
      status: "pending",
      priority: "should",
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
    },
  ],
};

const initiativesFixture = {
  document_name: "Canonical Platform - Initiatives" as const,
  document_purpose: "fixture",
  date: "2026-07-15",
  status: "active",
  related_documents: [],
  last_updated: "fixture",
  initiatives: [
    {
      id: "1",
      title: "Initiative 1",
      description: "Initiative 1 description.",
      status: "active",
      projects: [
        {
          id: "project-a",
          title: "Project A",
          summary: "s",
          description: "d",
          substrate_doc: "",
          status: "idea",
          blocked_by: [],
          blocking: [],
          linked_tasks: ["20", "21"],
          linked_backlog: [],
          originating_session: [],
        },
      ],
      originating_session: [],
      "sub-initiatives": [
        {
          id: "1",
          title: "Nested sub",
          description: "d",
          status: "planned",
          projects: [
            {
              id: "project-b",
              title: "Project B",
              summary: "s",
              description: "d",
              substrate_doc: "",
              status: "backlog",
              blocked_by: [],
              blocking: [],
              linked_tasks: [],
              linked_backlog: [],
              originating_session: [],
            },
          ],
          originating_session: [],
          "sub-initiatives": [],
        },
      ],
    },
    {
      id: "42",
      title: "Initiative 42 | pipe",
      description: "Initiative 42 description.",
      status: "proposed",
      projects: [],
      originating_session: [],
      "sub-initiatives": [],
    },
  ],
};

const backlogFixture = {
  document_name: "Product Backlog",
  document_purpose: "fixture",
  related_documents: [],
  items: [
    {
      id: "1",
      description: "Item 1.",
      type: "feature",
      status: "ready",
      effort_estimate: "S",
      priority: "high",
      track: "Bid",
      dependencies: [],
      session_refs: [],
      commit_refs: [],
      cross_doc_links: [],
      notes: null,
    },
    {
      id: "2",
      description: "Item 2.",
      type: "feature",
      status: "ready",
      effort_estimate: null,
      priority: "high",
      track: "Bid",
      dependencies: [],
      session_refs: [],
      commit_refs: [],
      cross_doc_links: [],
      notes: null,
    },
  ],
};

// ── Task-list index ──────────────────────────────────────────────────────────

describe("renderIndexMd — Task-list (TECH §4.3)", () => {
  test("emits frontmatter + heading + table with required columns", () => {
    const detected = detectSchema(taskListFixture);
    const md = renderIndexMd(detected);
    expect(md).toContain("type: task-list-index");
    expect(md).toContain("item_count: 2");
    expect(md).toContain("# Task list");
    expect(md).toContain(
      "| ID | Title | Status | Priority | Subtasks |",
    );
    // Subtasks cell is completed/total — ID-20 has 1 pending subtask → 0/1.
    expect(md).toContain("| [ID-20](ID-20.md) | Twenty | in_progress | must | 0/1 |");
  });

  test("Subtasks cell reports completed/total (done + cancelled count as complete)", () => {
    const mkSub = (id: string, status: string) => ({
      id,
      title: `S${id}`,
      description: "d",
      details: "",
      status,
      dependencies: [],
      testStrategy: null,
    });
    const fixture = {
      ...taskListFixture,
      tasks: [
        {
          ...taskListFixture.tasks[0],
          id: "30",
          title: "Thirty",
          subtasks: [
            mkSub("1", "done"),
            mkSub("2", "cancelled"),
            mkSub("3", "pending"),
            mkSub("4", "deferred"),
          ],
        },
      ],
    };
    const detected = detectSchema(fixture);
    const md = renderIndexMd(detected);
    // done(1) + cancelled(1) = 2 complete of 4 total.
    expect(md).toContain(
      "| [ID-30](ID-30.md) | Thirty | in_progress | must | 2/4 |",
    );
  });

  test("escapes pipe characters in title cells", () => {
    const detected = detectSchema(taskListFixture);
    const md = renderIndexMd(detected);
    // Title has a `|` — must be escaped as `\|` so the table row is valid GFM
    expect(md).toContain("Pipe \\| character title");
  });

  test("emits empty-state when tasks list is empty (PRODUCT inv 47)", () => {
    const detected = detectSchema({ ...taskListFixture, tasks: [] });
    const md = renderIndexMd(detected);
    expect(md).toContain("_The Task list ledger is empty._");
    expect(md).not.toContain("| ID |");
  });

  test("is byte-identical across regenerations from same input (idempotent)", () => {
    const detected1 = detectSchema(taskListFixture);
    const detected2 = detectSchema(taskListFixture);
    expect(renderIndexMd(detected1)).toBe(renderIndexMd(detected2));
  });
});

// ── Initiatives index (ID-148.10, repurposed roadmap arm) ─────────────────────

describe("renderIndexMd — Initiatives (ID-148.10)", () => {
  test("emits ONE row per TOP-LEVEL initiative with ID / Title / Status / Projects (recursive count)", () => {
    const detected = detectSchema(initiativesFixture);
    const md = renderIndexMd(detected);
    expect(md).toContain("type: initiatives-index");
    expect(md).toContain("initiative_count: 2");
    expect(md).toContain("# Initiatives");
    expect(md).toContain("| ID | Title | Status | Projects |");
    // Initiative 1 has 1 direct project + 1 nested project (sub-initiative) = 2.
    expect(md).toContain("| [1](1.md) | Initiative 1 | active | 2 |");
    // Pipe in the title is escaped so the table doesn't break.
    expect(md).toContain("| [42](42.md) | Initiative 42 \\| pipe | proposed | 0 |");
  });

  test("emits empty-state when initiatives list is empty", () => {
    const detected = detectSchema({ ...initiativesFixture, initiatives: [] });
    const md = renderIndexMd(detected);
    expect(md).toContain("_The Initiatives ledger has no initiatives._");
  });
});

// ── Backlog index ─────────────────────────────────────────────────────────────

describe("renderIndexMd — Backlog (PRODUCT inv 20)", () => {
  test("emits items table with all required columns", () => {
    const detected = detectSchema(backlogFixture);
    const md = renderIndexMd(detected);
    expect(md).toContain("type: backlog-index");
    expect(md).toContain("item_count: 2");
    expect(md).toContain("# Backlog");
    expect(md).toContain(
      "| ID | Description | Type | Status | Priority | Track | Effort |",
    );
  });

  test("sorts items by track, then status, then numeric id (inv 20)", () => {
    const fixture = {
      ...backlogFixture,
      items: [
        {
          ...backlogFixture.items[0],
          id: "10",
          track: "Bid",
          status: "ready",
        },
        {
          ...backlogFixture.items[0],
          id: "2",
          track: "Bid",
          status: "ready",
        },
        {
          ...backlogFixture.items[0],
          id: "3",
          track: "Bid",
          status: "blocked",
        },
      ],
    };
    const detected = detectSchema(fixture);
    const md = renderIndexMd(detected);
    const rowOrder = [...md.matchAll(/\| \[(\d+)\]/g)].map((m) => m[1]);
    // Bid/blocked first (3), then Bid/ready sorted numerically (2, 10)
    expect(rowOrder).toEqual(["3", "2", "10"]);
  });

  test("emits em-dash for null effort_estimate", () => {
    const detected = detectSchema(backlogFixture);
    const md = renderIndexMd(detected);
    // id=2 has effort_estimate=null
    expect(md).toMatch(/\| \[2\][^|]*\|[^|]*\| feature \| ready \| high \| Bid \| — \|/);
  });

  test("emits empty-state when items list is empty", () => {
    const detected = detectSchema({ ...backlogFixture, items: [] });
    const md = renderIndexMd(detected);
    expect(md).toContain("_The Backlog ledger is empty._");
  });
});

// ── PRODUCT inv 52 — cross-platform path separators ──────────────────────────

describe("indexMdPath (PRODUCT inv 52 cross-platform path separators)", () => {
  test("uses node:path.join → OS-native separator for filesystem path", () => {
    const path = indexMdPath("task-list", `/repo/docs/reference/task-list.json`);
    // Path returned uses OS-native separator (forward on POSIX, back on Win)
    expect(path).toContain(`tasks${sep}index.md`);
  });

  test("Task-list index.md sits inside `tasks/` sibling dir", () => {
    const path = indexMdPath("task-list", `/repo/docs/reference/task-list.json`);
    expect(path).toContain("tasks");
    expect(path.endsWith("index.md")).toBe(true);
  });

  test("Initiatives index.md sits inside `initiatives/` sibling dir (ID-148.10)", () => {
    const path = indexMdPath(
      "initiatives",
      `/repo/docs/reference/initiatives.json`,
    );
    expect(path).toContain("initiatives");
    expect(path.endsWith("index.md")).toBe(true);
  });

  test("Backlog index.md sits inside `backlog/` sibling dir", () => {
    const path = indexMdPath(
      "backlog",
      `/repo/docs/reference/product-backlog.json`,
    );
    expect(path).toContain("backlog");
    expect(path.endsWith("index.md")).toBe(true);
  });

  test("Markdown link hrefs inside index.md always use forward slashes (inv 52)", () => {
    const detected = detectSchema(taskListFixture);
    const md = renderIndexMd(detected);
    // Inspect only the link href positions — `(.+\.md)`-shaped — for
    // backslashes (since cell content may legitimately contain `\|`
    // pipe escapes per GFM).
    const linkHrefs = [...md.matchAll(/\(([^)]+\.md)\)/g)].map((m) => m[1]);
    for (const href of linkHrefs) {
      expect(href).not.toContain("\\");
    }
    expect(linkHrefs).toContain("ID-20.md");
  });
});
