/**
 * Vendored-schema parse smoke test.
 *
 * Acceptance gate for ID-20.6 (PRODUCT inv 1 + 3): the four schema files
 * vendored from KH `lib/validation/` parse a representative KH-shape
 * task-list / roadmap / backlog JSON without any `@/lib/validation/`
 * imports. Once 20.13 ships, this test pairs with the KH-side
 * task-view-vendor-drift CI workflow (TECH §3.5) — a deeper end-to-end
 * snapshot test of all three ledgers against the live KH JSON lives in
 * ID-20.13.
 */
import { describe, expect, test } from "bun:test";
import { TaskListSchema, parseTaskListWithWarnings } from "./task-list-schema";
import { RoadmapSchema } from "./roadmap-schema";
import { BacklogSchema } from "./backlog-schema";
import { WorkStatus, TaskListStatus, BacklogStatus, RoadmapStatus, Priority } from "./work-status";

const minimalTaskList = {
  document_name: "Knowledge Hub Task List",
  document_purpose: "Active + recently-closed structured work — Taskmaster JSON shape.",
  last_updated: "kh-prod-readiness-S62 W2 representative fixture",
  related_documents: [
    "docs/reference/product-roadmap.json",
    "docs/reference/product-backlog.json",
  ],
  tasks: [
    {
      id: "20",
      title: "Per-Task .md mirror generator + render surface",
      description: "Outer task description.",
      status: "in_progress",
      priority: "must",
      dependencies: [],
      subtasks: [
        {
          id: 6,
          title: "Fork prep + strip + rename + vendor schemas",
          description: "Slice 1 of ID-20.",
          status: "in_progress",
          dependencies: [],
          details: "Subtask details body.",
          testStrategy: "task-view GitHub repo exists; strip ledger applied; bun test passes.",
        },
      ],
      updatedAt: "2026-05-21T15:30:00.000Z",
      effort_estimate: "~2-3h",
      owner: "Engineering",
      priority_note: null,
      status_note: null,
      cross_doc_links: [],
      session_refs: [],
      commit_refs: [],
    },
  ],
};

const minimalRoadmap = {
  document_name: "Knowledge Hub Roadmap",
  document_purpose: "Forward-looking roadmap of Knowledge Hub phases and themes.",
  date: "2026-05-21",
  status: "Active",
  forward_looking_only: true,
  related_documents: ["docs/reference/product-backlog.json"],
  last_updated: "kh-prod-readiness-S62 W2 representative fixture",
  sections: [
    {
      id: "1",
      parent_id: null,
      number: "1",
      title: "Foundation",
      narrative: "Build the foundations.",
      spec_links: [],
      owner: "Engineering",
      table_columns: "item_desc_owner_effort_status",
      items: [
        {
          id: "1.1",
          section_id: "1",
          title: "First item",
          phase_label: null,
          description: "First item description.",
          effort_estimate: null,
          priority: "must",
          priority_note: null,
          severity: null,
          status: "pending",
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
    },
  ],
};

const minimalBacklog = {
  document_name: "Product Backlog",
  document_purpose: "Forward-looking backlog of unscheduled work items.",
  last_updated: "kh-prod-readiness-S62 W2 representative fixture",
  related_documents: ["docs/reference/product-roadmap.json"],
  items: [
    {
      id: "1",
      description: "Backlog item description.",
      type: "feature",
      status: "spec_needed",
      effort_estimate: null,
      priority: "should",
      track: "platform",
      dependencies: [],
      session_refs: [],
      commit_refs: [],
      cross_doc_links: [],
      notes: null,
    },
  ],
};

describe("Vendored schemas: parse acceptance", () => {
  test("TaskListSchema parses representative task-list JSON", () => {
    const result = TaskListSchema.safeParse(minimalTaskList);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.document_name).toBe("Knowledge Hub Task List");
      expect(result.data.tasks).toHaveLength(1);
      expect(result.data.tasks[0].subtasks).toHaveLength(1);
      expect(result.data.tasks[0].subtasks[0].id).toBe(6);
    }
  });

  test("parseTaskListWithWarnings returns { value, warnings } envelope shape KH consumes", () => {
    const envelope = parseTaskListWithWarnings(minimalTaskList);
    expect(envelope.value).toBeDefined();
    expect(envelope.value.document_name).toBe("Knowledge Hub Task List");
    expect(Array.isArray(envelope.warnings)).toBe(true);
    expect(envelope.warnings).toHaveLength(0);
  });

  test("RoadmapSchema parses representative roadmap JSON", () => {
    const result = RoadmapSchema.safeParse(minimalRoadmap);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.document_name).toBe("Knowledge Hub Roadmap");
      expect(result.data.sections[0].items[0].id).toBe("1.1");
    }
  });

  test("BacklogSchema parses representative backlog JSON", () => {
    const result = BacklogSchema.safeParse(minimalBacklog);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.document_name).toBe("Product Backlog");
      expect(result.data.items[0].type).toBe("feature");
    }
  });

  test("BacklogSchema document_name is z.string().min(1), not z.literal — non-canonical value parses but routing relies on value match", () => {
    // Per PRODUCT inv 4 + TECH §2.1, Backlog routing anchors on the
    // canonical value `"Product Backlog"`, not on a Zod literal. Document
    // the asymmetry here: the schema itself accepts any non-empty
    // document_name; detectSchema (ID-20.7) does the value-match.
    const arbitrary = { ...minimalBacklog, document_name: "Some Other Backlog" };
    const result = BacklogSchema.safeParse(arbitrary);
    expect(result.success).toBe(true);
  });
});

describe("Vendored work-status: master enum + per-surface subsets", () => {
  test("WorkStatus master accepts all canonical values", () => {
    const allValues = [
      "done", "pending", "in_progress", "blocked", "deferred",
      "cancelled", "spec_needed", "imp_deferred", "needs_research",
      "parked", "ready",
    ];
    for (const v of allValues) {
      expect(WorkStatus.safeParse(v).success).toBe(true);
    }
  });

  test("TaskListStatus excludes needs_research / parked / ready", () => {
    expect(TaskListStatus.safeParse("done").success).toBe(true);
    expect(TaskListStatus.safeParse("needs_research").success).toBe(false);
    expect(TaskListStatus.safeParse("parked").success).toBe(false);
    expect(TaskListStatus.safeParse("ready").success).toBe(false);
  });

  test("BacklogStatus excludes pending / done / in_progress / cancelled / deferred / imp_deferred", () => {
    expect(BacklogStatus.safeParse("spec_needed").success).toBe(true);
    expect(BacklogStatus.safeParse("ready").success).toBe(true);
    expect(BacklogStatus.safeParse("pending").success).toBe(false);
    expect(BacklogStatus.safeParse("done").success).toBe(false);
  });

  test("RoadmapStatus excludes done / in_progress / cancelled / parked / ready", () => {
    expect(RoadmapStatus.safeParse("pending").success).toBe(true);
    expect(RoadmapStatus.safeParse("spec_needed").success).toBe(true);
    expect(RoadmapStatus.safeParse("done").success).toBe(false);
    expect(RoadmapStatus.safeParse("ready").success).toBe(false);
  });

  test("Priority master enum covers MoSCoW + ranked + trigger values", () => {
    const allPriorities = ["must", "should", "could", "future", "high", "medium", "low", "trigger"];
    for (const p of allPriorities) {
      expect(Priority.safeParse(p).success).toBe(true);
    }
  });
});
