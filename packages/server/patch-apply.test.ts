/**
 * Tests for patch-apply — TECH §5.2 + §5.5 patch application algorithm.
 *
 * The pure-logic core: walk a FieldPath, replace the leaf, re-parse via
 * the matching Zod schema. The patch server (Slice 4) composes this
 * primitive with the mtime check + atomic write + mirror regen pieces.
 *
 * Covers (per TECH §5.2 + §5.5 + PRODUCT inv 38):
 *   - Task-level field replacement (status, priority, description, ...).
 *   - Subtask-level field replacement (status, details, dependencies, ...).
 *   - Roadmap section-level + item-level fields.
 *   - Backlog item-level fields.
 *   - Multi-patch single-pass (multiple FieldPatches in one call).
 *   - Walk errors (unknown task id, unknown subtask id, wrong head, ...).
 *   - Schema errors (e.g. invalid enum value) surface as ZodError result.
 *   - Empty patches array rejected (no-op should not write).
 */
import { describe, expect, test } from "bun:test";
import {
  applyTaskListPatches,
  applyRoadmapPatches,
  applyBacklogPatches,
  applyPatches,
  type FieldPatch,
} from "./patch-apply";
import { TaskListSchema } from "@task-view/schemas/task-list";
import { RoadmapSchema } from "@task-view/schemas/roadmap";
import { BacklogSchema } from "@task-view/schemas/backlog";

// ── Fixture builders ──────────────────────────────────────────────────────────

function makeTaskList() {
  return TaskListSchema.parse({
    document_name: "Knowledge Hub Task List",
    document_purpose: "Active + recently-closed structured work — Taskmaster JSON shape.",
    last_updated: "kh-prod-readiness-S63 representative fixture",
    related_documents: [],
    tasks: [
      {
        id: "20",
        title: "Per-Task mirror",
        description: "Outer task description.",
        status: "in_progress",
        priority: "must",
        dependencies: [],
        subtasks: [
          {
            id: 1,
            title: "Slice 1",
            description: "First slice.",
            details: "Details for slice 1.",
            status: "done",
            dependencies: [],
            testStrategy: "test strategy 1",
            updatedAt: "2026-05-21T15:30:00.000Z",
          },
          {
            id: 2,
            title: "Slice 2",
            description: "Second slice.",
            details: "Details for slice 2.",
            status: "pending",
            dependencies: [1],
            testStrategy: null,
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
      {
        id: "30",
        title: "Sibling task",
        description: "Outer description.",
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
  });
}

function makeRoadmap() {
  return RoadmapSchema.parse({
    document_name: "Knowledge Hub Roadmap",
    document_purpose: "Forward-looking roadmap.",
    date: "2026-05-21",
    status: "Active",
    forward_looking_only: true,
    related_documents: [],
    last_updated: "kh-prod-readiness-S63 representative fixture",
    sections: [
      {
        id: "1",
        parent_id: null,
        number: "1",
        title: "Foundation",
        narrative: "Initial narrative.",
        spec_links: [],
        owner: "Engineering",
        table_columns: "item_desc_owner_effort_status",
        items: [
          {
            id: "1.1",
            section_id: "1",
            title: "Item one",
            description: "Item one description.",
            phase_label: null,
            priority: "high",
            priority_note: null,
            severity: null,
            status: "pending",
            status_note: null,
            owner: null,
            effort_estimate: null,
            depends_on: [],
            blocks: [],
            coordinates_with: [],
            session_refs: [],
            commit_refs: [],
            cross_doc_links: [],
          },
        ],
      },
    ],
  });
}

function makeBacklog() {
  return BacklogSchema.parse({
    document_name: "Product Backlog",
    document_purpose: "Forward-looking backlog.",
    last_updated: "kh-prod-readiness-S63 representative fixture",
    related_documents: [],
    items: [
      {
        id: "30",
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
  });
}

// ── Task-list patches ─────────────────────────────────────────────────────────

describe("applyTaskListPatches — Task-level field replacement", () => {
  test("replaces Task.status by id", () => {
    const snapshot = makeTaskList();
    const result = applyTaskListPatches(snapshot, [
      { fieldPath: ["tasks", "20", "status"], newValue: "done" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed.tasks[0].status).toBe("done");
    }
  });

  test("replaces Task.priority by id", () => {
    const snapshot = makeTaskList();
    const result = applyTaskListPatches(snapshot, [
      { fieldPath: ["tasks", "30", "priority"], newValue: "must" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed.tasks[1].priority).toBe("must");
    }
  });

  test("replaces Task.description (free-text) by id", () => {
    const snapshot = makeTaskList();
    const result = applyTaskListPatches(snapshot, [
      { fieldPath: ["tasks", "20", "description"], newValue: "Updated description." },
    ]);
    if (!result.ok) throw new Error(`expected ok; got kind=${result.kind}`);
    expect(result.parsed.tasks[0].description).toBe("Updated description.");
  });

  test("replaces Task.dependencies (array) atomically", () => {
    const snapshot = makeTaskList();
    const result = applyTaskListPatches(snapshot, [
      { fieldPath: ["tasks", "20", "dependencies"], newValue: ["30"] },
    ]);
    if (!result.ok) throw new Error(`expected ok; got kind=${result.kind}`);
    expect(result.parsed.tasks[0].dependencies).toEqual(["30"]);
  });

  test("replaces nullable Task.owner with non-null", () => {
    const snapshot = makeTaskList();
    const result = applyTaskListPatches(snapshot, [
      { fieldPath: ["tasks", "30", "owner"], newValue: "Liam" },
    ]);
    if (!result.ok) throw new Error(`expected ok; got kind=${result.kind}`);
    expect(result.parsed.tasks[1].owner).toBe("Liam");
  });
});

describe("applyTaskListPatches — Subtask-level field replacement", () => {
  test("replaces Subtask.status by integer subtaskId", () => {
    const snapshot = makeTaskList();
    const result = applyTaskListPatches(snapshot, [
      { fieldPath: ["tasks", "20", "subtasks", "2", "status"], newValue: "in_progress" },
    ]);
    if (!result.ok) throw new Error(`expected ok; got kind=${result.kind}`);
    const subtask = result.parsed.tasks[0].subtasks[1];
    expect(subtask.status).toBe("in_progress");
  });

  test("replaces Subtask.details preserving journal blocks verbatim", () => {
    const snapshot = makeTaskList();
    const detailsWithJournal =
      "Original details.\n\n<info added on 2026-05-21T16:42:11.123Z>\nJournal entry.\n</info added on 2026-05-21T16:42:11.123Z>";
    const result = applyTaskListPatches(snapshot, [
      { fieldPath: ["tasks", "20", "subtasks", "1", "details"], newValue: detailsWithJournal },
    ]);
    if (!result.ok) throw new Error(`expected ok; got kind=${result.kind}`);
    expect(result.parsed.tasks[0].subtasks[0].details).toBe(detailsWithJournal);
  });

  test("replaces Subtask.testStrategy from null to a string", () => {
    const snapshot = makeTaskList();
    const result = applyTaskListPatches(snapshot, [
      { fieldPath: ["tasks", "20", "subtasks", "2", "testStrategy"], newValue: "new test" },
    ]);
    if (!result.ok) throw new Error(`expected ok; got kind=${result.kind}`);
    expect(result.parsed.tasks[0].subtasks[1].testStrategy).toBe("new test");
  });
});

describe("applyTaskListPatches — multi-field (PRODUCT inv 38, TECH §5.5)", () => {
  test("applies multiple patches in one pass; final state reflects all changes", () => {
    const snapshot = makeTaskList();
    const result = applyTaskListPatches(snapshot, [
      { fieldPath: ["tasks", "20", "status"], newValue: "done" },
      { fieldPath: ["tasks", "20", "priority"], newValue: "should" },
      { fieldPath: ["tasks", "20", "subtasks", "1", "status"], newValue: "in_progress" },
    ]);
    if (!result.ok) throw new Error(`expected ok; got kind=${result.kind}`);
    expect(result.parsed.tasks[0].status).toBe("done");
    expect(result.parsed.tasks[0].priority).toBe("should");
    expect(result.parsed.tasks[0].subtasks[0].status).toBe("in_progress");
  });

  test("multi-patch all-or-nothing: if one walk fails, NO changes commit", () => {
    const snapshot = makeTaskList();
    const result = applyTaskListPatches(snapshot, [
      { fieldPath: ["tasks", "20", "status"], newValue: "done" },
      { fieldPath: ["tasks", "999", "priority"], newValue: "should" }, // bad task id
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "walk-error") {
      expect(result.detail).toContain('Task id "999" not found');
    }
    // The snapshot was mutated (we mutate-in-place by design) — but the
    // caller is responsible for the structuredClone wrapping. The
    // contract here is: result.ok === false → caller drops the snapshot
    // and does NOT atomicWrite it. This is verified at the server
    // composition layer (Slice 4).
  });

  test("multi-patch all-or-nothing: if final schema parse fails, error surfaces and no parsed payload", () => {
    const snapshot = makeTaskList();
    const result = applyTaskListPatches(snapshot, [
      // valid:
      { fieldPath: ["tasks", "20", "status"], newValue: "done" },
      // invalid: status must be one of the enum values
      { fieldPath: ["tasks", "30", "status"], newValue: "not_a_valid_status" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "schema-error") {
      // The ZodError surfaces with field path information that the client
      // can render inline near the textarea (PRODUCT inv 29).
      expect(result.zodError.issues.length).toBeGreaterThan(0);
    }
  });
});

describe("applyTaskListPatches — walk errors", () => {
  test("rejects empty patches array (no-op should not write)", () => {
    const snapshot = makeTaskList();
    const result = applyTaskListPatches(snapshot, []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("empty-patches");
  });

  test("rejects fieldPath that does not start with 'tasks'", () => {
    const snapshot = makeTaskList();
    const result = applyTaskListPatches(snapshot, [
      { fieldPath: ["sections", "1", "narrative"], newValue: "x" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "walk-error") {
      expect(result.detail).toContain("tasks");
    }
  });

  test("rejects unknown task id with detailed error", () => {
    const snapshot = makeTaskList();
    const result = applyTaskListPatches(snapshot, [
      { fieldPath: ["tasks", "999", "status"], newValue: "done" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "walk-error") {
      expect(result.detail).toContain('Task id "999"');
    }
  });

  test("rejects unknown field on Task", () => {
    const snapshot = makeTaskList();
    const result = applyTaskListPatches(snapshot, [
      { fieldPath: ["tasks", "20", "made_up_field"], newValue: "x" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "walk-error") {
      expect(result.detail).toContain("made_up_field");
    }
  });

  test("rejects unknown subtask id within a known Task", () => {
    const snapshot = makeTaskList();
    const result = applyTaskListPatches(snapshot, [
      { fieldPath: ["tasks", "20", "subtasks", "999", "status"], newValue: "done" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "walk-error") {
      expect(result.detail).toContain("Subtask id 999");
    }
  });

  test("rejects non-integer subtask id", () => {
    const snapshot = makeTaskList();
    const result = applyTaskListPatches(snapshot, [
      { fieldPath: ["tasks", "20", "subtasks", "abc", "status"], newValue: "done" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "walk-error") {
      expect(result.detail).toContain('"abc"');
    }
  });

  test("rejects unsupported nested path after taskId (not 'subtasks')", () => {
    const snapshot = makeTaskList();
    const result = applyTaskListPatches(snapshot, [
      { fieldPath: ["tasks", "20", "metadata", "x", "y"], newValue: "z" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "walk-error") {
      expect(result.detail).toContain("metadata");
    }
  });

  test("rejects fieldPath that addresses the Task object itself (no leaf field)", () => {
    const snapshot = makeTaskList();
    const result = applyTaskListPatches(snapshot, [
      { fieldPath: ["tasks", "20"], newValue: { id: "20" } },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "walk-error") {
      expect(result.detail).toContain("must address a field");
    }
  });
});

describe("applyTaskListPatches — schema validation", () => {
  test("rejects invalid enum value for status with schema-error result + ZodError", () => {
    const snapshot = makeTaskList();
    const result = applyTaskListPatches(snapshot, [
      { fieldPath: ["tasks", "20", "status"], newValue: "not_a_status" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("schema-error");
      if (result.kind === "schema-error") {
        expect(result.zodError.issues.length).toBeGreaterThan(0);
      }
    }
  });

  test("rejects subtask cross-Task dep via TaskSchema.superRefine (PRODUCT inv 14)", () => {
    const snapshot = makeTaskList();
    // Subtask 2's dependencies must reference sibling Subtasks only.
    // Inserting an id (e.g. 99) with no matching sibling triggers the
    // schema's superRefine.
    const result = applyTaskListPatches(snapshot, [
      { fieldPath: ["tasks", "20", "subtasks", "2", "dependencies"], newValue: [99] },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("schema-error");
    }
  });
});

// ── Roadmap patches ───────────────────────────────────────────────────────────

describe("applyRoadmapPatches — section + item field replacement", () => {
  test("replaces Section.narrative", () => {
    const snapshot = makeRoadmap();
    const result = applyRoadmapPatches(snapshot, [
      { fieldPath: ["sections", "1", "narrative"], newValue: "Updated narrative." },
    ]);
    if (!result.ok) throw new Error(`expected ok; got kind=${result.kind}`);
    expect(result.parsed.sections[0].narrative).toBe("Updated narrative.");
  });

  test("replaces RoadmapItem.status by item id under a section", () => {
    const snapshot = makeRoadmap();
    // Valid RoadmapStatus values: pending | blocked | spec_needed |
    // deferred | imp_deferred | needs_research (per WorkStatus.exclude).
    // 'done' is NOT a valid Roadmap status (forward_looking_only).
    const result = applyRoadmapPatches(snapshot, [
      { fieldPath: ["sections", "1", "items", "1.1", "status"], newValue: "blocked" },
    ]);
    if (!result.ok) throw new Error(`expected ok; got kind=${result.kind}`);
    expect(result.parsed.sections[0].items[0].status).toBe("blocked");
  });

  test("replaces RoadmapItem.priority to nullable null", () => {
    const snapshot = makeRoadmap();
    const result = applyRoadmapPatches(snapshot, [
      { fieldPath: ["sections", "1", "items", "1.1", "priority"], newValue: null },
    ]);
    if (!result.ok) throw new Error(`expected ok; got kind=${result.kind}`);
    expect(result.parsed.sections[0].items[0].priority).toBeNull();
  });

  test("rejects unknown section id", () => {
    const snapshot = makeRoadmap();
    const result = applyRoadmapPatches(snapshot, [
      { fieldPath: ["sections", "99", "narrative"], newValue: "x" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "walk-error") {
      expect(result.detail).toContain('Section id "99"');
    }
  });

  test("rejects unknown item id within a known section", () => {
    const snapshot = makeRoadmap();
    const result = applyRoadmapPatches(snapshot, [
      { fieldPath: ["sections", "1", "items", "9.9", "status"], newValue: "blocked" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "walk-error") {
      expect(result.detail).toContain('Item id "9.9"');
    }
  });
});

// ── Backlog patches ───────────────────────────────────────────────────────────

describe("applyBacklogPatches — item field replacement", () => {
  test("replaces BacklogItem.status", () => {
    const snapshot = makeBacklog();
    const result = applyBacklogPatches(snapshot, [
      { fieldPath: ["items", "30", "status"], newValue: "ready" },
    ]);
    if (!result.ok) throw new Error(`expected ok; got kind=${result.kind}`);
    expect(result.parsed.items[0].status).toBe("ready");
  });

  test("replaces BacklogItem.priority", () => {
    const snapshot = makeBacklog();
    const result = applyBacklogPatches(snapshot, [
      { fieldPath: ["items", "30", "priority"], newValue: "must" },
    ]);
    if (!result.ok) throw new Error(`expected ok; got kind=${result.kind}`);
    expect(result.parsed.items[0].priority).toBe("must");
  });

  test("rejects unknown item id", () => {
    const snapshot = makeBacklog();
    const result = applyBacklogPatches(snapshot, [
      { fieldPath: ["items", "999", "status"], newValue: "ready" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "walk-error") {
      expect(result.detail).toContain('Item id "999"');
    }
  });

  test("rejects invalid status enum value with schema-error", () => {
    const snapshot = makeBacklog();
    const result = applyBacklogPatches(snapshot, [
      { fieldPath: ["items", "30", "status"], newValue: "bogus" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("schema-error");
  });
});

// ── Dispatcher ────────────────────────────────────────────────────────────────

describe("applyPatches — dispatcher", () => {
  test("dispatches task-list kind to applyTaskListPatches", () => {
    const data = makeTaskList();
    const result = applyPatches(
      { kind: "task-list", data },
      [{ fieldPath: ["tasks", "20", "status"], newValue: "done" }],
    );
    expect(result.ok).toBe(true);
  });

  test("dispatches roadmap kind to applyRoadmapPatches", () => {
    const data = makeRoadmap();
    const result = applyPatches(
      { kind: "roadmap", data },
      [{ fieldPath: ["sections", "1", "narrative"], newValue: "x" }],
    );
    expect(result.ok).toBe(true);
  });

  test("dispatches backlog kind to applyBacklogPatches", () => {
    const data = makeBacklog();
    const result = applyPatches(
      { kind: "backlog", data },
      [{ fieldPath: ["items", "30", "status"], newValue: "ready" }],
    );
    expect(result.ok).toBe(true);
  });

  test("throws on unknown kind (caller should have rejected at load time)", () => {
    expect(() =>
      applyPatches(
        { kind: "unknown", documentName: "Bogus" },
        [{ fieldPath: ["x"], newValue: 1 } as FieldPatch],
      ),
    ).toThrow();
  });
});
