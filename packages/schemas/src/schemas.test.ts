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
import {
  TaskListSchema,
  parseTaskListWithWarnings,
  FIELD_BUDGETS,
} from "./task-list-schema";
import { RoadmapSchema, parseRoadmapWithWarnings } from "./roadmap-schema";
import { BacklogSchema, parseBacklogWithWarnings } from "./backlog-schema";
import { LEDGER_BUDGETS } from "./ledger-budgets";
import { WorkStatus, TaskListStatus, BacklogStatus, RoadmapStatus, Priority } from "./work-status";

const minimalTaskList = {
  document_name: "Knowledge Hub Task List",
  document_purpose: "Active + recently-closed structured work — Taskmaster JSON shape.",
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
      capability_theme: "1",
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
  themes: [
    {
      id: "1",
      title: "Foundation",
      description: "Build the foundations.",
      time_horizon: "now",
      status: "in_progress",
      linked_tasks: ["20"],
      linked_backlog: [],
      session_refs: [],
      commit_refs: [],
      cross_doc_links: [],
      notes: null,
    },
  ],
};

const minimalBacklog = {
  document_name: "Product Backlog",
  document_purpose: "Forward-looking backlog of unscheduled work items.",
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

  test("RoadmapSchema parses representative themes[] roadmap JSON", () => {
    const result = RoadmapSchema.safeParse(minimalRoadmap);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.document_name).toBe("Knowledge Hub Roadmap");
      expect(result.data.themes[0].id).toBe("1");
      expect(result.data.themes[0].time_horizon).toBe("now");
      expect(result.data.themes[0].linked_tasks).toEqual(["20"]);
    }
  });

  test("RoadmapSchema rejects the retired sections[] shape", () => {
    const legacy = {
      ...minimalRoadmap,
      themes: undefined,
      sections: [],
    };
    delete (legacy as { themes?: unknown }).themes;
    const result = RoadmapSchema.safeParse(legacy);
    expect(result.success).toBe(false);
  });

  test("TaskSchema accepts capability_theme back-link", () => {
    const result = TaskListSchema.safeParse(minimalTaskList);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tasks[0].capability_theme).toBe("1");
    }
  });

  test("SubtaskStatus accepts 'cancelled' (S261/S262 amendment)", () => {
    const withCancelledSubtask = {
      ...minimalTaskList,
      tasks: [
        {
          ...minimalTaskList.tasks[0],
          subtasks: [
            {
              ...minimalTaskList.tasks[0].subtasks[0],
              status: "cancelled",
            },
          ],
        },
      ],
    };
    const result = TaskListSchema.safeParse(withCancelledSubtask);
    expect(result.success).toBe(true);
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

// ── Backlog `rank` field per roadmap-backlog-consolidation PRODUCT inv 3 ─────
// Subtask 30.8 vendor sync.

describe("BacklogItemSchema rank field (roadmap-backlog-consolidation inv 3)", () => {
  const mkItemWithRank = (rank: unknown) => ({
    ...minimalBacklog,
    items: [{ ...minimalBacklog.items[0], rank }],
  });

  test("item omitting rank parses (field is optional)", () => {
    const result = BacklogSchema.safeParse(minimalBacklog);
    expect(result.success).toBe(true);
  });

  test("item with rank: null parses", () => {
    const result = BacklogSchema.safeParse(mkItemWithRank(null));
    expect(result.success).toBe(true);
  });

  test("item with rank: 10 parses", () => {
    const result = BacklogSchema.safeParse(mkItemWithRank(10));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.items[0].rank).toBe(10);
    }
  });

  test("item with rank: -5 parses (no schema-level positive constraint — discipline only)", () => {
    const result = BacklogSchema.safeParse(mkItemWithRank(-5));
    expect(result.success).toBe(true);
  });

  test("item with rank: '10' (string) fails (non-integer)", () => {
    const result = BacklogSchema.safeParse(mkItemWithRank("10"));
    expect(result.success).toBe(false);
  });

  test("item with rank: 1.5 fails (non-integer)", () => {
    const result = BacklogSchema.safeParse(mkItemWithRank(1.5));
    expect(result.success).toBe(false);
  });
});

// ── Budget soft-warnings (ID-90 U0 re-vendor — KH ID-34/{35.13} parity) ──────
// The budget-aware parse helpers surface SOFT warnings sourced from the
// relocated ledger-budgets registry. Never schema rejections (invariant 24):
// over-budget documents still parse.

describe("parseTaskListWithWarnings budget soft-warnings (ID-90 U0 / invariant 41)", () => {
  const mkTaskList = (taskOverrides: object, subtaskOverrides: object = {}) => ({
    ...minimalTaskList,
    tasks: [
      {
        ...minimalTaskList.tasks[0],
        ...taskOverrides,
        subtasks: [
          { ...minimalTaskList.tasks[0].subtasks[0], ...subtaskOverrides },
        ],
      },
    ],
  });

  test("FIELD_BUDGETS is re-exported from task-list-schema and sourced from the registry", () => {
    expect(FIELD_BUDGETS.taskDescription).toBe(LEDGER_BUDGETS.task.description);
    expect(FIELD_BUDGETS.taskStatusNote).toBe(LEDGER_BUDGETS.task.status_note);
    expect(FIELD_BUDGETS.subtaskDescription).toBe(LEDGER_BUDGETS.subtask.description);
    expect(FIELD_BUDGETS.subtaskTestStrategy).toBe(LEDGER_BUDGETS.subtask.testStrategy);
  });

  test("over-budget task description still PARSES (no .max()) and emits a soft warning", () => {
    const doc = mkTaskList({
      description: "d".repeat(FIELD_BUDGETS.taskDescription + 1),
    });
    const { value, warnings } = parseTaskListWithWarnings(doc);
    expect(value.tasks).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].taskId).toBe("20");
    expect(warnings[0].message).toContain("description");
    expect(warnings[0].message).toContain(`budget ${FIELD_BUDGETS.taskDescription}`);
  });

  test("over-budget task status_note emits a soft warning", () => {
    const doc = mkTaskList({
      status_note: "n".repeat(FIELD_BUDGETS.taskStatusNote + 1),
    });
    const { warnings } = parseTaskListWithWarnings(doc);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("status_note");
  });

  test("over-budget subtask description emits a soft warning naming N.M", () => {
    const doc = mkTaskList(
      {},
      { description: "s".repeat(FIELD_BUDGETS.subtaskDescription + 1) },
    );
    const { warnings } = parseTaskListWithWarnings(doc);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("Subtask 20.6");
    expect(warnings[0].message).toContain(`budget ${FIELD_BUDGETS.subtaskDescription}`);
  });

  test("over-budget subtask testStrategy emits a soft warning", () => {
    const doc = mkTaskList(
      {},
      { testStrategy: "t".repeat(FIELD_BUDGETS.subtaskTestStrategy + 1) },
    );
    const { warnings } = parseTaskListWithWarnings(doc);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("testStrategy");
  });

  test("within-budget document emits zero warnings", () => {
    const { warnings } = parseTaskListWithWarnings(minimalTaskList);
    expect(warnings).toHaveLength(0);
  });

  test("subtask details is NOT budgeted — long details emit no warning", () => {
    const doc = mkTaskList({}, { details: "j".repeat(10000) });
    const { warnings } = parseTaskListWithWarnings(doc);
    expect(warnings).toHaveLength(0);
  });
});

describe("parseRoadmapWithWarnings theme budget soft-warnings ({35.13} parity)", () => {
  test("over-budget theme description still parses and emits a themeId-scoped warning", () => {
    const doc = {
      ...minimalRoadmap,
      themes: [
        {
          ...minimalRoadmap.themes[0],
          description: "d".repeat(LEDGER_BUDGETS.theme.description + 1),
        },
      ],
    };
    const { value, warnings } = parseRoadmapWithWarnings(doc);
    expect(value.themes).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].themeId).toBe("1");
    expect(warnings[0].message).toContain(`budget ${LEDGER_BUDGETS.theme.description}`);
  });

  test("over-budget theme notes emits a soft warning (null notes guarded)", () => {
    const doc = {
      ...minimalRoadmap,
      themes: [
        {
          ...minimalRoadmap.themes[0],
          notes: "n".repeat(LEDGER_BUDGETS.theme.notes + 1),
        },
      ],
    };
    const { warnings } = parseRoadmapWithWarnings(doc);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("notes");
  });

  test("12-theme soft ceiling still surfaces with themeCount", () => {
    const themes = Array.from({ length: 13 }, (_, i) => ({
      ...minimalRoadmap.themes[0],
      id: String(i + 1),
    }));
    const { warnings } = parseRoadmapWithWarnings({ ...minimalRoadmap, themes });
    const ceiling = warnings.find((w) => w.themeCount !== undefined);
    expect(ceiling).toBeDefined();
    expect(ceiling?.themeCount).toBe(13);
  });

  test("within-budget roadmap emits zero warnings", () => {
    const { warnings } = parseRoadmapWithWarnings(minimalRoadmap);
    expect(warnings).toHaveLength(0);
  });
});

describe("parseBacklogWithWarnings item budget soft-warnings ({35.13} parity)", () => {
  test("BacklogItemSchema accepts the optional title field ({35.14})", () => {
    const doc = {
      ...minimalBacklog,
      items: [{ ...minimalBacklog.items[0], title: "Short heading" }],
    };
    const result = BacklogSchema.safeParse(doc);
    expect(result.success).toBe(true);
  });

  test("over-budget item title still parses and emits an itemId-scoped warning", () => {
    const doc = {
      ...minimalBacklog,
      items: [
        {
          ...minimalBacklog.items[0],
          title: "t".repeat(LEDGER_BUDGETS.item.title + 1),
        },
      ],
    };
    const { value, warnings } = parseBacklogWithWarnings(doc);
    expect(value.items).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].itemId).toBe("1");
    expect(warnings[0].message).toContain(`budget ${LEDGER_BUDGETS.item.title}`);
  });

  test("over-budget item description emits a soft warning", () => {
    const doc = {
      ...minimalBacklog,
      items: [
        {
          ...minimalBacklog.items[0],
          description: "d".repeat(LEDGER_BUDGETS.item.description + 1),
        },
      ],
    };
    const { warnings } = parseBacklogWithWarnings(doc);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("description");
  });

  test("within-budget backlog emits zero warnings", () => {
    const { warnings } = parseBacklogWithWarnings(minimalBacklog);
    expect(warnings).toHaveLength(0);
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
