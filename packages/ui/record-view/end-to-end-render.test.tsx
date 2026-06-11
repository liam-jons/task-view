/**
 * end-to-end-render.test.tsx — round-trip integration test exercising
 * the full 20.9 read pipeline:
 *
 *   typed-record fixture
 *      → mirror-generator (text mirror)
 *      → structured-frontmatter parser (typed back)
 *      → TaskListView / RoadmapThemeView / BacklogItemView renderer
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
import { RoadmapThemeView } from "./roadmap-theme-view";
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
  related_documents: [],
  tasks: [
    {
      id: "20",
      title: "End-to-end Task",
      description: "Roundtrip description.",
      status: "in_progress",
      priority: "must",
      dependencies: ["19"],
      capability_theme: "3",
      subtasks: [
        {
          id: "1",
          title: "First",
          description: "First subtask.",
          details:
            "Details prose.\n\n<info added on 2026-05-21T16:00:00.000Z>\nJournal.\n</info added on 2026-05-21T16:00:00.000Z>",
          status: "done",
          dependencies: [],
          testStrategy: "Acceptance.",
        },
        {
          id: "2",
          title: "Second",
          description: "Second subtask.",
          details: "Details.",
          status: "pending",
          dependencies: ["1"],
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
  themes: [
    {
      id: "3",
      title: "Theme 3",
      description: "Theme description.",
      time_horizon: "now" as const,
      status: "in_progress" as const,
      linked_tasks: ["20"],
      linked_backlog: ["45"],
      session_refs: ["kh-prod-readiness-S63"],
      commit_refs: ["abc1234"],
      cross_doc_links: [
        {
          path: "docs/specs/per-task-mirror/TECH.md",
          anchor: "#section-3-1",
          raw: "TECH §3.1",
        },
      ],
      notes: "Theme notes prose.",
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
    // Inv 7: frontmatter + description + Subtasks + nav strip.
    // ID-20.25: title/heading split the editable text into a
    // .record-view-field-value span beside the id prefix.
    expect(html).toContain("ID-20: ");
    expect(html).toContain(
      '<span class="record-view-field-value">End-to-end Task</span>',
    );
    expect(html).toContain("data-nav-strip");
    expect(html).toContain("Roundtrip description");
    // Inv 8: Subtask blocks with details + journal
    expect(html).toContain(
      '<span class="record-view-field-value">First</span>',
    );
    expect(html).toContain("ID-20.1: ");
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
    // ID-20.25: description split into a .record-view-field-value span.
    expect(html).toContain("45: ");
    expect(html).toContain(
      '<span class="record-view-field-value">Promotion-ready item.</span>',
    );
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

describe("Roadmap end-to-end render (themes[] happy path — ID-20.19)", () => {
  test("typed RoadmapTheme → RoadmapThemeView yields all theme surfaces", () => {
    const detected = detectSchema(roadmapFixture);
    expect(detected.kind).toBe("roadmap");
    if (detected.kind !== "roadmap") return;
    const theme = detected.data.themes[0];
    // Build a ledger that knows the linked Task + Backlog ids so the
    // cross-record links resolve live (not broken-target).
    const ledger = buildLedgerContext({
      roadmap: detected.data,
      tasks: [
        {
          id: "20",
          title: "Linked task",
          description: "d",
          status: "in_progress",
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
        },
      ],
      backlogItems: [
        {
          id: "45",
          description: "Linked backlog item",
          type: "feature",
          status: "blocked",
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
      existingPaths: new Set(["docs/specs/per-task-mirror/TECH.md"]),
    });
    const html = renderToStaticMarkup(
      <RoadmapThemeView theme={theme} ledger={ledger} nav={NAV} />,
    );
    // ID-20.25: title split into a .record-view-field-value span.
    expect(html).toContain("3: ");
    expect(html).toContain(
      '<span class="record-view-field-value">Theme 3</span>',
    );
    expect(html).toContain("Theme description");
    // time_horizon + status frontmatter rows
    expect(html).toContain('data-frontmatter-row="time_horizon"');
    expect(html).toContain('data-frontmatter-row="status"');
    // {20.29}: linked_tasks / linked_backlog are CROSS-ledger edges now —
    // they route to the sibling task-list / backlog ledgers (live, not
    // missing, because the sibling ids are threaded into the LedgerContext).
    expect(html).toContain('data-section="linked_tasks"');
    expect(html).toContain('href="/?ledger=task-list&amp;record=20"');
    expect(html).toContain('data-cross-ledger="task-list"');
    expect(html).not.toContain("(missing)");
    // linked_backlog resolves to the backlog sibling ledger
    expect(html).toContain('data-section="linked_backlog"');
    expect(html).toContain('href="/?ledger=backlog&amp;record=45"');
    expect(html).toContain('data-cross-ledger="backlog"');
    // cross_doc_links render
    expect(html).toContain('href="docs/specs/per-task-mirror/TECH.md#section-3-1"');
    // notes section
    expect(html).toContain('data-section="notes"');
    expect(html).toContain("Theme notes prose");
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
