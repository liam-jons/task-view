/**
 * end-to-end-render.test.tsx — round-trip integration test exercising
 * the full 20.9 read pipeline:
 *
 *   typed-record fixture
 *      → mirror-generator (text mirror)
 *      → structured-frontmatter parser (typed back)
 *      → TaskListView / RoadmapItemView / BacklogItemView renderer
 *
 * This is the closest analogue in the colocated layout to TECH §4.2's
 * `tests/integration/*-render.test.ts` rows. It verifies the SPA's
 * standalone .md fallback path (per the 20.7 Executor's flag about
 * cross_doc_links parsing) end-to-end.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { detectSchema } from "../../server/detect-schema";
import { renderIndexMd } from "../../server/index-generator";
import type { Task } from "@task-view/schemas/task-list";
import { BacklogItemView } from "./backlog-item-view";
import { RoadmapItemView } from "./roadmap-item-view";
import {
  extractFrontmatterRaw,
  parseStructuredFrontmatter,
} from "./structured-frontmatter";
import { TaskListView } from "./task-list-view";
import { buildLedgerContext, type NavStripData } from "./types";

const NAV: NavStripData = {
  prevHref: null,
  prevLabel: null,
  nextHref: null,
  nextLabel: null,
  indexHref: "/",
  indexLabel: "Index",
};

const taskListFixture = {
  document_name: "Knowledge Hub Task List" as const,
  document_purpose: "fixture",
  last_updated: "fixture",
  related_documents: [],
  tasks: [
    {
      id: "20",
      title: "End-to-end Task",
      description: "Roundtrip description.",
      status: "in_progress",
      priority: "must",
      dependencies: ["19"],
      subtasks: [
        {
          id: 1,
          title: "First",
          description: "First subtask.",
          details:
            "Details prose.\n\n<info added on 2026-05-21T16:00:00.000Z>\nJournal.\n</info added on 2026-05-21T16:00:00.000Z>",
          status: "done",
          dependencies: [],
          testStrategy: "Acceptance.",
        },
        {
          id: 2,
          title: "Second",
          description: "Second subtask.",
          details: "Details.",
          status: "pending",
          dependencies: [1],
          testStrategy: null,
        },
      ],
      updatedAt: "2026-05-21T15:30:00.000Z",
      effort_estimate: "~2h",
      owner: "Engineering",
      priority_note: null,
      status_note: null,
      cross_doc_links: [
        {
          path: "docs/specs/per-task-mirror/PRODUCT.md",
          anchor: null,
          raw: "PRODUCT.md",
        },
      ],
      session_refs: ["kh-prod-readiness-S63"],
      commit_refs: ["abc1234"],
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
      id: "45",
      description: "Promotion-ready item.",
      type: "feature" as const,
      status: "blocked" as const,
      effort_estimate: "S",
      priority: "high" as const,
      track: "Bid",
      dependencies: ["999"],
      session_refs: [],
      commit_refs: [],
      cross_doc_links: [],
      notes: "Notes prose.",
      details: "Promotion brief.",
      testStrategy: "Promotion acceptance.",
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
      id: "3.1",
      parent_id: null,
      number: "3.1",
      title: "Section 3.1",
      narrative: null,
      spec_links: [],
      owner: "Engineering",
      table_columns: "item_desc_owner_effort_status" as const,
      items: [
        {
          id: "3.1.8",
          section_id: "3.1",
          title: "Item 3.1.8",
          phase_label: null,
          description: "Item description.",
          effort_estimate: "M",
          priority: "should" as const,
          priority_note: null,
          severity: null,
          status: "pending" as const,
          status_note: null,
          owner: null, // → should inherit from section
          depends_on: [],
          blocks: [],
          coordinates_with: [],
          cross_doc_links: [],
          session_refs: [],
          commit_refs: [],
        },
      ],
    },
  ],
};

// ── Task-list end-to-end ─────────────────────────────────────────────────────

describe("Task-list end-to-end render (inv 7-13 happy path)", () => {
  test("typed Task → TaskListView yields a page with all required surfaces", () => {
    const detected = detectSchema(taskListFixture);
    expect(detected.kind).toBe("task-list");
    if (detected.kind !== "task-list") return;
    const task = detected.data.tasks[0];
    const ledger = buildLedgerContext({
      tasks: detected.data.tasks,
      existingPaths: new Set([
        "docs/specs/per-task-mirror/PRODUCT.md",
      ]),
    });
    const html = renderToStaticMarkup(
      <TaskListView task={task} ledger={ledger} nav={NAV} />,
    );
    // Inv 7: frontmatter + description + Subtasks + nav strip
    expect(html).toContain("ID-20: End-to-end Task");
    expect(html).toContain("data-nav-strip");
    expect(html).toContain("Roundtrip description");
    // Inv 8: Subtask blocks with details + journal
    expect(html).toContain('<h3>ID-20.1: First</h3>');
    expect(html).toContain('data-segment="journal"');
    expect(html).toContain('data-journal-timestamp="2026-05-21T16:00:00.000Z"');
    // Inv 9 negative: with 2 subtasks, no empty-state placeholder
    expect(html).not.toContain("data-empty-subtasks");
    // Inv 11: cross-doc-link renders live (path is in existingPaths)
    expect(html).toContain('href="docs/specs/per-task-mirror/PRODUCT.md"');
    // Inv 12: missing Task dep → '(missing)' marker + page-top warning
    expect(html).toContain("ID-19");
    expect(html).toContain("(missing)");
    expect(html).toContain("data-page-top-warning");
    // Inv 13: sibling-Subtask dep renders as #subtask-1 anchor
    expect(html).toContain('href="#subtask-1"');
    expect(html).toContain('id="subtask-1"');
    expect(html).toContain('id="subtask-2"');
  });
});

// ── Backlog end-to-end ────────────────────────────────────────────────────────

describe("Backlog end-to-end render (inv 21-25 happy path)", () => {
  test("typed BacklogItem → BacklogItemView yields blocked banner + promotion-ready badge", () => {
    const detected = detectSchema(backlogFixture);
    expect(detected.kind).toBe("backlog");
    if (detected.kind !== "backlog") return;
    const item = detected.data.items[0];
    const ledger = buildLedgerContext({
      backlogItems: detected.data.items,
    });
    const html = renderToStaticMarkup(
      <BacklogItemView item={item} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain("45: Promotion-ready item");
    expect(html).toContain("data-blocked-banner");
    expect(html).toContain("data-promotion-ready");
    expect(html).toContain('data-section="details"');
    expect(html).toContain('data-section="test-strategy"');
    // Missing dep + page-top warning
    expect(html).toContain("data-page-top-warning");
    expect(html).toContain("999");
  });
});

// ── Roadmap end-to-end ────────────────────────────────────────────────────────

describe("Roadmap end-to-end render (inv 16-18 happy path)", () => {
  test("typed RoadmapItem with null owner → inheritance qualifier rendered", () => {
    const detected = detectSchema(roadmapFixture);
    expect(detected.kind).toBe("roadmap");
    if (detected.kind !== "roadmap") return;
    const item = detected.data.sections[0].items[0];
    const ledger = buildLedgerContext({ roadmap: detected.data });
    const html = renderToStaticMarkup(
      <RoadmapItemView item={item} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain("3.1.8: Item 3.1.8");
    expect(html).toContain("(inherited from §3.1)");
    expect(html).toContain('data-inherited-from="3.1"');
    // Section ID is linked back to section page
    expect(html).toContain('href="section-3.1.md"');
  });
});

// ── Mirror frontmatter round-trip ────────────────────────────────────────────

describe("Mirror frontmatter round-trip via structured-frontmatter parser", () => {
  test("renderIndexMd output parses back through parseStructuredFrontmatter", () => {
    const detected = detectSchema(taskListFixture);
    const md = renderIndexMd(detected);
    const fm = extractFrontmatterRaw(md);
    expect(fm).not.toBeNull();
    if (fm === null) return;
    const parsed = parseStructuredFrontmatter(fm);
    expect(parsed.type).toBe("task-list-index");
    expect(parsed.item_count).toBe("1");
  });

  test("nested DocLink array parses out of a hand-rolled mirror body", () => {
    // Simulate a generator-emitted Task mirror frontmatter
    const body = `type: task
id: "20"
title: "End-to-end"
status: pending
priority: must
effort_estimate: "~2h"
owner: Engineering
updated: "2026-05-21T15:30:00.000Z"
session_refs: [kh-prod-readiness-S63]
commit_refs: [abc1234]
dependencies: [19]
cross_doc_links:
  - path: docs/specs/per-task-mirror/PRODUCT.md
    anchor: null
    raw: PRODUCT.md
  - path: docs/specs/per-task-mirror/TECH.md
    anchor: "#section-4"
    raw: "TECH §4"
priority_note: null
status_note: null`;
    const fm = parseStructuredFrontmatter(body);
    expect(fm.type).toBe("task");
    expect(fm.cross_doc_links).toEqual([
      {
        path: "docs/specs/per-task-mirror/PRODUCT.md",
        anchor: null,
        raw: "PRODUCT.md",
      },
      {
        path: "docs/specs/per-task-mirror/TECH.md",
        anchor: "#section-4",
        raw: "TECH §4",
      },
    ]);
  });
});

// ── Helper used by callers to extract a typed Task from detection ────────────
export function _typedTaskListFixture(): Task {
  const detected = detectSchema(taskListFixture);
  if (detected.kind !== "task-list") throw new Error("fixture broken");
  return detected.data.tasks[0];
}
