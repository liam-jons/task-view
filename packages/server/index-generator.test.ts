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
  last_updated: "fixture",
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
          id: 1,
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

const roadmapFixture = {
  document_name: "Knowledge Hub Roadmap" as const,
  document_purpose: "fixture",
  date: "2026-05-21",
  status: "Active" as const,
  forward_looking_only: true as const,
  related_documents: [],
  last_updated: "fixture",
  sections: [
    {
      id: "1",
      parent_id: null,
      number: "1",
      title: "Section 1",
      narrative: null,
      spec_links: [],
      owner: "Engineering",
      table_columns: "item_desc_owner_effort_status" as const,
      items: [],
    },
    {
      id: "3.1",
      parent_id: null,
      number: "3.1",
      title: "Section 3.1",
      narrative: null,
      spec_links: [],
      owner: null,
      table_columns: "item_desc_owner_effort_status" as const,
      items: [],
    },
  ],
};

const backlogFixture = {
  document_name: "Product Backlog",
  document_purpose: "fixture",
  last_updated: "fixture",
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
    expect(md).toContain("| [ID-20](ID-20.md) | Twenty | in_progress | must | 1 |");
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

// ── Roadmap index ─────────────────────────────────────────────────────────────

describe("renderIndexMd — Roadmap (PRODUCT inv 14)", () => {
  test("emits sections table with ID / Title / Owner / Item count", () => {
    const detected = detectSchema(roadmapFixture);
    const md = renderIndexMd(detected);
    expect(md).toContain("type: roadmap-index");
    expect(md).toContain("section_count: 2");
    expect(md).toContain("# Roadmap");
    expect(md).toContain("| ID | Title | Owner | Item count |");
    expect(md).toContain(
      "| [§1](section-1.md) | Section 1 | Engineering | 0 |",
    );
    expect(md).toContain("| [§3.1](section-3.1.md) | Section 3.1 | — | 0 |");
  });

  test("emits empty-state when sections list is empty", () => {
    const detected = detectSchema({ ...roadmapFixture, sections: [] });
    const md = renderIndexMd(detected);
    expect(md).toContain("_The Roadmap ledger has no sections._");
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

  test("Roadmap index.md sits inside `roadmap/` sibling dir", () => {
    const path = indexMdPath(
      "roadmap",
      `/repo/docs/reference/product-roadmap.json`,
    );
    expect(path).toContain("roadmap");
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
