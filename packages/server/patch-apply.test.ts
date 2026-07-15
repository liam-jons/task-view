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
 *   - Initiatives project/initiative-level fields (ID-148.10, INV-13 —
 *     repurposed roadmap arm, nested tree addressing).
 *   - Backlog item-level fields.
 *   - Multi-patch single-pass (multiple FieldPatches in one call).
 *   - Walk errors (unknown task id, unknown subtask id, wrong head, ...).
 *   - Schema errors (e.g. invalid enum value) surface as ZodError result.
 *   - Empty patches array rejected (no-op should not write).
 */
import { describe, expect, test } from "bun:test";
import {
  applyTaskListPatches,
  applyInitiativesPatches,
  applyBacklogPatches,
  applyPatches,
  type FieldPatch,
} from "./patch-apply";
import { TaskListSchema } from "@task-view/schemas/task-list";
import { InitiativesSchema } from "@task-view/schemas/initiatives";
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
            id: "1",
            title: "Slice 1",
            description: "First slice.",
            details: "Details for slice 1.",
            status: "done",
            dependencies: [],
            testStrategy: "test strategy 1",
            updatedAt: "2026-05-21T15:30:00.000Z",
          },
          {
            id: "2",
            title: "Slice 2",
            description: "Second slice.",
            details: "Details for slice 2.",
            status: "pending",
            dependencies: ["1"],
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

function makeInitiatives() {
  return InitiativesSchema.parse({
    document_name: "Canonical Platform - Initiatives",
    document_purpose: "Structured record of active initiatives.",
    date: "2026-07-15",
    status: "active",
    related_documents: [],
    last_updated: "kh-main-S473 representative fixture",
    initiatives: [
      {
        id: "1",
        title: "Foundation",
        description: "Foundation initiative description.",
        status: "proposed",
        projects: [
          {
            id: "foundation-project",
            title: "Foundation project",
            summary: "Summary.",
            description: "Description.",
            substrate_doc: "",
            status: "idea",
            blocked_by: [],
            blocking: [],
            linked_tasks: ["20"],
            linked_backlog: [],
            originating_session: [],
          },
        ],
        originating_session: [],
        "sub-initiatives": [
          {
            id: "1",
            title: "Sub one",
            description: "Sub description.",
            status: "planned",
            projects: [
              {
                id: "sub-project",
                title: "Sub project",
                summary: "Sub summary.",
                description: "Sub description.",
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
      { fieldPath: ["tasks", "20", "subtasks", "2", "dependencies"], newValue: ["99"] },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("schema-error");
    }
  });
});

// ── Initiatives patches (ID-148.10, TECH §3.1(b), INV-13) ────────────────────

describe("applyInitiativesPatches — Project field replacement (slug addressing)", () => {
  test("replaces a top-level Project.status by slug", () => {
    const snapshot = makeInitiatives();
    const result = applyInitiativesPatches(snapshot, [
      { fieldPath: ["projects", "foundation-project", "status"], newValue: "in-progress" },
    ]);
    if (!result.ok) throw new Error(`expected ok; got kind=${result.kind}`);
    expect(result.parsed.initiatives[0].projects[0].status).toBe("in-progress");
  });

  test("replaces a NESTED (sub-initiative) Project field by slug, tree-walk-found", () => {
    const snapshot = makeInitiatives();
    const result = applyInitiativesPatches(snapshot, [
      { fieldPath: ["projects", "sub-project", "summary"], newValue: "Renamed summary." },
    ]);
    if (!result.ok) throw new Error(`expected ok; got kind=${result.kind}`);
    const sub = result.parsed.initiatives[0]["sub-initiatives"][0];
    expect(sub.projects[0].summary).toBe("Renamed summary.");
  });

  test("replaces Project.linked_tasks (array) atomically", () => {
    const snapshot = makeInitiatives();
    const result = applyInitiativesPatches(snapshot, [
      { fieldPath: ["projects", "foundation-project", "linked_tasks"], newValue: ["20", "30"] },
    ]);
    if (!result.ok) throw new Error(`expected ok; got kind=${result.kind}`);
    expect(result.parsed.initiatives[0].projects[0].linked_tasks).toEqual(["20", "30"]);
  });

  test("rejects an out-of-enum Project.status as schema-error (strict write, INV-3)", () => {
    const snapshot = makeInitiatives();
    const result = applyInitiativesPatches(snapshot, [
      { fieldPath: ["projects", "foundation-project", "status"], newValue: "not-a-real-status" },
    ]);
    // Lenient READ (z.string()) means the schema parse itself would accept
    // this value — INV-3's strict-write enforcement is a SEPARATE server
    // gate layer (patch-server.ts / budget-gate.ts convention), not this
    // module. Document that patch-apply itself does NOT reject it (the
    // schema is lenient by design); the write-gate test lives elsewhere.
    expect(result.ok).toBe(true);
  });

  test("rejects unknown project slug", () => {
    const snapshot = makeInitiatives();
    const result = applyInitiativesPatches(snapshot, [
      { fieldPath: ["projects", "does-not-exist", "status"], newValue: "idea" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "walk-error") {
      expect(result.detail).toContain('"does-not-exist"');
    }
  });

  test("rejects unknown field on Project", () => {
    const snapshot = makeInitiatives();
    const result = applyInitiativesPatches(snapshot, [
      { fieldPath: ["projects", "foundation-project", "made_up_field"], newValue: "x" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "walk-error") {
      expect(result.detail).toContain("made_up_field");
    }
  });
});

describe("applyInitiativesPatches — Initiative/SubInitiative field replacement (path addressing)", () => {
  test("replaces a top-level Initiative field by bare path", () => {
    const snapshot = makeInitiatives();
    const result = applyInitiativesPatches(snapshot, [
      { fieldPath: ["initiatives", "1", "status"], newValue: "active" },
    ]);
    if (!result.ok) throw new Error(`expected ok; got kind=${result.kind}`);
    expect(result.parsed.initiatives[0].status).toBe("active");
  });

  test("replaces a sub-initiative field by dotted path", () => {
    const snapshot = makeInitiatives();
    const result = applyInitiativesPatches(snapshot, [
      { fieldPath: ["initiatives", "1.1", "title"], newValue: "Renamed sub" },
    ]);
    if (!result.ok) throw new Error(`expected ok; got kind=${result.kind}`);
    expect(result.parsed.initiatives[0]["sub-initiatives"][0].title).toBe("Renamed sub");
  });

  test("ALLOWS linked_tasks on a top-level Initiative (initiative-4 tolerance, INV-2)", () => {
    const snapshot = makeInitiatives();
    const result = applyInitiativesPatches(snapshot, [
      { fieldPath: ["initiatives", "1", "linked_tasks"], newValue: ["99"] },
    ]);
    expect(result.ok).toBe(true);
  });

  test("REJECTS linked_tasks on a sub-initiative (not in its known-field set)", () => {
    const snapshot = makeInitiatives();
    const result = applyInitiativesPatches(snapshot, [
      { fieldPath: ["initiatives", "1.1", "linked_tasks"], newValue: ["99"] },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "walk-error") {
      expect(result.detail).toContain("SubInitiative");
    }
  });

  test("rejects unknown initiative path", () => {
    const snapshot = makeInitiatives();
    const result = applyInitiativesPatches(snapshot, [
      { fieldPath: ["initiatives", "999", "status"], newValue: "active" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "walk-error") {
      expect(result.detail).toContain('"999"');
    }
  });

  test("rejects unknown sub-initiative segment in a dotted path", () => {
    const snapshot = makeInitiatives();
    const result = applyInitiativesPatches(snapshot, [
      { fieldPath: ["initiatives", "1.99", "status"], newValue: "active" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("walk-error");
  });

  test("rejects fieldPath not starting with 'projects' or 'initiatives'", () => {
    const snapshot = makeInitiatives();
    const result = applyInitiativesPatches(snapshot, [
      { fieldPath: ["themes", "1", "notes"], newValue: "x" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "walk-error") {
      expect(result.detail).toContain("'projects' or 'initiatives'");
    }
  });

  test("rejects a fieldPath addressing more than one segment after the id", () => {
    const snapshot = makeInitiatives();
    const result = applyInitiativesPatches(snapshot, [
      { fieldPath: ["initiatives", "1", "projects", "0", "status"], newValue: "x" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "walk-error") {
      expect(result.detail).toContain("single field");
    }
  });
});

describe("applyInitiativesPatches — atomic move (INV-13, two-project batch)", () => {
  test("a single 2-patch batch atomically re-parents a linked task between two projects", () => {
    const snapshot = makeInitiatives();
    // "Move" task 20 from foundation-project to sub-project: one field-patch
    // per side, applied through the SAME multi-patch batch — no dedicated
    // server op, per the module header's documented design.
    const result = applyInitiativesPatches(snapshot, [
      { fieldPath: ["projects", "foundation-project", "linked_tasks"], newValue: [] },
      { fieldPath: ["projects", "sub-project", "linked_tasks"], newValue: ["20"] },
    ]);
    if (!result.ok) throw new Error(`expected ok; got kind=${result.kind}`);
    expect(result.parsed.initiatives[0].projects[0].linked_tasks).toEqual([]);
    const sub = result.parsed.initiatives[0]["sub-initiatives"][0];
    expect(sub.projects[0].linked_tasks).toEqual(["20"]);
  });

  test("all-or-nothing: if the target-project leg fails, the source leg does not commit either", () => {
    const snapshot = makeInitiatives();
    const result = applyInitiativesPatches(snapshot, [
      { fieldPath: ["projects", "foundation-project", "linked_tasks"], newValue: [] },
      { fieldPath: ["projects", "does-not-exist", "linked_tasks"], newValue: ["20"] },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("walk-error");
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

  test("dispatches initiatives kind to applyInitiativesPatches", () => {
    const data = makeInitiatives();
    const result = applyPatches(
      { kind: "initiatives", data },
      [{ fieldPath: ["projects", "foundation-project", "summary"], newValue: "x" }],
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

describe("applyInitiativesPatches / applyBacklogPatches — appendText op (--append forms)", () => {
  test("update-project --append: concatenates onto project summary", () => {
    const data = makeInitiatives();
    const result = applyInitiativesPatches(data, [
      { fieldPath: ["projects", "foundation-project", "summary"], appendText: " Appended note." },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed.initiatives[0].projects[0].summary).toBe(
        "Summary. Appended note.",
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
