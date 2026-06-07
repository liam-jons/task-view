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
 *   - Roadmap theme-level fields (ID-20.19 themes[]).
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
    themes: [
      {
        id: "1",
        title: "Foundation",
        description: "Foundation theme description.",
        time_horizon: "now",
        status: "pending",
        linked_tasks: ["20"],
        linked_backlog: [],
        session_refs: [],
        commit_refs: [],
        cross_doc_links: [],
        notes: "Initial notes.",
      },
    ],
  });
}

function makeBacklog() {
  return BacklogSchema.parse({
    document_name: "Product Backlog",
    document_purpose: "Forward-looking backlog.",
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

  // ── ID-20.26: optional-field guard fix ──────────────────────────────────────

  test("ID-20.26: SET Task.capability_theme (optional, absent on fixture) succeeds", () => {
    // capability_theme is z.string().nullable().optional() — absent on the
    // makeTaskList() fixture. The fix must allow writing it even though
    // hasOwnProperty would have returned false on the instance.
    const snapshot = makeTaskList();
    expect("capability_theme" in snapshot.tasks[0]).toBe(false);
    const result = applyTaskListPatches(snapshot, [
      { fieldPath: ["tasks", "20", "capability_theme"], newValue: "foundation" },
    ]);
    if (!result.ok) throw new Error(`expected ok; got kind=${result.kind} detail=${result.kind === "walk-error" ? result.detail : ""}`);
    expect(result.parsed.tasks[0].capability_theme).toBe("foundation");
  });

  test("ID-20.26: SET Subtask.updatedAt (optional, absent on one fixture subtask) succeeds", () => {
    // Subtask 2 (id: 2) has no updatedAt in the fixture — updatedAt is optional.
    const snapshot = makeTaskList();
    const subtaskTwo = snapshot.tasks[0].subtasks[1];
    expect("updatedAt" in subtaskTwo).toBe(false);
    const result = applyTaskListPatches(snapshot, [
      { fieldPath: ["tasks", "20", "subtasks", "2", "updatedAt"], newValue: "2026-05-25T10:00:00.000Z" },
    ]);
    if (!result.ok) throw new Error(`expected ok; got kind=${result.kind} detail=${result.kind === "walk-error" ? result.detail : ""}`);
    expect(result.parsed.tasks[0].subtasks[1].updatedAt).toBe("2026-05-25T10:00:00.000Z");
  });

  test("ID-20.26: typo'd field on Task still errors — not a silent no-op (TaskSchema is strict)", () => {
    // TaskSchema uses .strict() so a typo'd field written to the snapshot
    // will produce a schema-error at re-parse even without the guard.
    // After the fix (schema-keyset guard), it surfaces as a walk-error
    // before Zod even runs — either way it must NOT return ok.
    const snapshot = makeTaskList();
    const result = applyTaskListPatches(snapshot, [
      { fieldPath: ["tasks", "20", "statsu_note"], newValue: "typo" }, // deliberate typo
    ]);
    expect(result.ok).toBe(false);
    expect(["walk-error", "schema-error"]).toContain(result.ok ? "ok" : result.kind);
    if (!result.ok && result.kind === "walk-error") {
      expect(result.detail).toContain("statsu_note");
    }
  });

  test("ID-20.26: typo'd field on Subtask still errors — not a silent no-op", () => {
    const snapshot = makeTaskList();
    const result = applyTaskListPatches(snapshot, [
      { fieldPath: ["tasks", "20", "subtasks", "1", "dtails"], newValue: "typo" }, // deliberate typo
    ]);
    expect(result.ok).toBe(false);
    expect(["walk-error", "schema-error"]).toContain(result.ok ? "ok" : result.kind);
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

describe("applyRoadmapPatches — theme field replacement (ID-20.19)", () => {
  test("replaces Theme.notes", () => {
    const snapshot = makeRoadmap();
    const result = applyRoadmapPatches(snapshot, [
      { fieldPath: ["themes", "1", "notes"], newValue: "Updated notes." },
    ]);
    if (!result.ok) throw new Error(`expected ok; got kind=${result.kind}`);
    expect(result.parsed.themes[0].notes).toBe("Updated notes.");
  });

  test("replaces Theme.status (pending | in_progress | done)", () => {
    const snapshot = makeRoadmap();
    const result = applyRoadmapPatches(snapshot, [
      { fieldPath: ["themes", "1", "status"], newValue: "in_progress" },
    ]);
    if (!result.ok) throw new Error(`expected ok; got kind=${result.kind}`);
    expect(result.parsed.themes[0].status).toBe("in_progress");
  });

  test("replaces Theme.time_horizon", () => {
    const snapshot = makeRoadmap();
    const result = applyRoadmapPatches(snapshot, [
      { fieldPath: ["themes", "1", "time_horizon"], newValue: "later" },
    ]);
    if (!result.ok) throw new Error(`expected ok; got kind=${result.kind}`);
    expect(result.parsed.themes[0].time_horizon).toBe("later");
  });

  test("replaces Theme.title + description in a single pass", () => {
    const snapshot = makeRoadmap();
    const result = applyRoadmapPatches(snapshot, [
      { fieldPath: ["themes", "1", "title"], newValue: "Renamed theme" },
      { fieldPath: ["themes", "1", "description"], newValue: "New description." },
    ]);
    if (!result.ok) throw new Error(`expected ok; got kind=${result.kind}`);
    expect(result.parsed.themes[0].title).toBe("Renamed theme");
    expect(result.parsed.themes[0].description).toBe("New description.");
  });

  test("rejects an invalid Theme.status as schema-error", () => {
    const snapshot = makeRoadmap();
    // 'blocked' is NOT a valid theme status (themes only accept
    // pending | in_progress | done).
    const result = applyRoadmapPatches(snapshot, [
      { fieldPath: ["themes", "1", "status"], newValue: "blocked" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("schema-error");
    }
  });

  test("rejects fieldPath that does not start with 'themes'", () => {
    const snapshot = makeRoadmap();
    const result = applyRoadmapPatches(snapshot, [
      { fieldPath: ["sections", "1", "narrative"], newValue: "x" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "walk-error") {
      expect(result.detail).toContain("themes");
    }
  });

  test("rejects unknown theme id", () => {
    const snapshot = makeRoadmap();
    const result = applyRoadmapPatches(snapshot, [
      { fieldPath: ["themes", "99", "notes"], newValue: "x" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "walk-error") {
      expect(result.detail).toContain('Theme id "99"');
    }
  });

  test("rejects a nested fieldPath (themes have no nested record layer)", () => {
    const snapshot = makeRoadmap();
    const result = applyRoadmapPatches(snapshot, [
      { fieldPath: ["themes", "1", "items", "9.9", "status"], newValue: "blocked" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "walk-error") {
      expect(result.detail).toContain("single field");
    }
  });

  // ── ID-20.26: optional-field guard fix ──────────────────────────────────────

  test("ID-20.26: typo'd field on Theme still errors — not a silent no-op", () => {
    // RoadmapThemeSchema uses .strict() so a typo'd field would produce a
    // schema-error at re-parse even without the guard. After the fix
    // (schema-keyset guard) it surfaces as a walk-error before Zod runs —
    // either way the result must NOT be ok. Exercises the guard path for the
    // roadmap surface (mirrors the Task/Subtask/Backlog typo cases).
    const snapshot = makeRoadmap();
    const result = applyRoadmapPatches(snapshot, [
      { fieldPath: ["themes", "1", "statsu_notes"], newValue: "typo" }, // deliberate typo
    ]);
    expect(result.ok).toBe(false);
    expect(["walk-error", "schema-error"]).toContain(result.ok ? "ok" : result.kind);
    if (!result.ok && result.kind === "walk-error") {
      expect(result.detail).toContain("statsu_notes");
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

  // ── ID-20.26: optional-field guard fix ──────────────────────────────────────

  test("ID-20.26: SET rank (optional, absent on live records) succeeds — not a walk-error", () => {
    // 'rank' is z.number().int().nullable().optional() — absent on every live
    // backlog item. Before this fix the hasOwnProperty guard rejected the write
    // with a walk-error (400). After the fix, the write succeeds and re-parse
    // validates the value via Zod.
    const snapshot = makeBacklog();
    // Confirm rank is absent on the fixture item (pre-condition)
    expect("rank" in snapshot.items[0]).toBe(false);
    const result = applyBacklogPatches(snapshot, [
      { fieldPath: ["items", "30", "rank"], newValue: 3 },
    ]);
    if (!result.ok) throw new Error(`expected ok; got kind=${result.kind} detail=${result.kind === "walk-error" ? result.detail : ""}`);
    expect(result.parsed.items[0].rank).toBe(3);
  });

  test("ID-20.26: SET details (optional, absent on live records) succeeds", () => {
    const snapshot = makeBacklog();
    expect("details" in snapshot.items[0]).toBe(false);
    const result = applyBacklogPatches(snapshot, [
      { fieldPath: ["items", "30", "details"], newValue: "Expanded brief for this item." },
    ]);
    if (!result.ok) throw new Error(`expected ok; got kind=${result.kind} detail=${result.kind === "walk-error" ? result.detail : ""}`);
    expect(result.parsed.items[0].details).toBe("Expanded brief for this item.");
  });

  test("ID-20.26: SET testStrategy (optional, absent on live records) succeeds", () => {
    // 'testStrategy' is z.string().nullable().optional() — absent on the
    // makeBacklog() fixture item. The schema-keyset guard must permit the
    // write even though hasOwnProperty would have returned false.
    const snapshot = makeBacklog();
    expect("testStrategy" in snapshot.items[0]).toBe(false);
    const result = applyBacklogPatches(snapshot, [
      { fieldPath: ["items", "30", "testStrategy"], newValue: "Acceptance: item ships when X." },
    ]);
    if (!result.ok) throw new Error(`expected ok; got kind=${result.kind} detail=${result.kind === "walk-error" ? result.detail : ""}`);
    expect(result.parsed.items[0].testStrategy).toBe("Acceptance: item ships when X.");
  });

  test("ID-20.26: typo'd field on BacklogItem still errors — not a silent no-op", () => {
    // BacklogItemSchema is NOT .strict() — a typo'd field would be silently
    // stripped by Zod. The schema-keyset guard MUST catch it as a walk-error
    // before Zod sees it, so the PATCH never returns 200/ok with nothing written.
    const snapshot = makeBacklog();
    const result = applyBacklogPatches(snapshot, [
      { fieldPath: ["items", "30", "statsu_note"], newValue: "typo" }, // deliberate typo
    ]);
    expect(result.ok).toBe(false);
    // Must be walk-error (from guard) OR schema-error — NOT silent ok
    expect(["walk-error", "schema-error"]).toContain(result.ok ? "ok" : result.kind);
    if (!result.ok && result.kind === "walk-error") {
      expect(result.detail).toContain("statsu_note");
    }
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
      [{ fieldPath: ["themes", "1", "notes"], newValue: "x" }],
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

// ── ID-90 U6: first-class append op (PRODUCT invariants 39 + 43, OQ-4) ────────

describe("applyTaskListPatches — appendText op (ID-90 U6)", () => {
  test("appends to subtask details, preserving the prior value verbatim", () => {
    const data = makeTaskList();
    const block = "\n\n<info added on 2026-06-07T00:00:00.000Z>\nShipped.\n</info added on 2026-06-07T00:00:00.000Z>";
    const result = applyTaskListPatches(data, [
      {
        fieldPath: ["tasks", "20", "subtasks", "1", "details"],
        appendText: block,
      },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const sub = result.parsed.tasks[0].subtasks[0];
      expect(sub.details).toBe(`Details for slice 1.${block}`);
      expect(sub.details.startsWith("Details for slice 1.")).toBe(true);
    }
  });

  test("appends to a task-level string field", () => {
    const data = makeTaskList();
    const result = applyTaskListPatches(data, [
      { fieldPath: ["tasks", "20", "description"], appendText: " More." },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed.tasks[0].description).toBe(
        "Outer task description. More.",
      );
    }
  });

  test("appendText onto a null leaf yields the appended text alone", () => {
    const data = makeTaskList();
    // status_note is null in the fixture.
    const result = applyTaskListPatches(data, [
      { fieldPath: ["tasks", "20", "status_note"], appendText: "First note." },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed.tasks[0].status_note).toBe("First note.");
    }
  });

  test("appendText onto a non-string leaf is a walk-error (nothing applied)", () => {
    const data = makeTaskList();
    const result = applyTaskListPatches(data, [
      { fieldPath: ["tasks", "20", "dependencies"], appendText: "nope" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("walk-error");
  });

  test("mixed batch: newValue + appendText apply in one single-parse pass", () => {
    const data = makeTaskList();
    const result = applyTaskListPatches(data, [
      { fieldPath: ["tasks", "20", "status"], newValue: "done" },
      {
        fieldPath: ["tasks", "20", "subtasks", "2", "details"],
        appendText: " Appended.",
      },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed.tasks[0].status).toBe("done");
      expect(result.parsed.tasks[0].subtasks[1].details).toBe(
        "Details for slice 2. Appended.",
      );
    }
  });
});

describe("applyRoadmapPatches / applyBacklogPatches — appendText op (--append forms)", () => {
  test("update-roadmap --append: concatenates onto theme notes", () => {
    const data = makeRoadmap();
    const result = applyRoadmapPatches(data, [
      { fieldPath: ["themes", "1", "notes"], appendText: " Appended note." },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed.themes[0].notes).toBe(
        "Initial notes. Appended note.",
      );
    }
  });

  test("update-backlog --append: null notes leaf becomes the appended text", () => {
    const data = makeBacklog();
    const itemId = data.items[0].id;
    const result = applyBacklogPatches(data, [
      { fieldPath: ["items", itemId, "notes"], appendText: "Fresh note." },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed.items[0].notes).toBe("Fresh note.");
    }
  });
});
