/**
 * Tests for record-mutate.ts — ID-20.15 record-level CREATE / DELETE.
 *
 * Pure-logic coverage: insert / remove dispatch per kind, duplicate-id +
 * not-found rejection, document-level invariant re-parse (backlog unique-id
 * superRefine), and snapshot immutability (input is never mutated).
 */
import { describe, expect, test } from "bun:test";
import { detectSchema, type DetectSchemaResult } from "./detect-schema";
import { insertRecord, removeRecord } from "./record-mutate";

type KnownDetected = Exclude<DetectSchemaResult, { kind: "unknown" }>;

function detectTaskList(): KnownDetected {
  const d = detectSchema({
    document_name: "Knowledge Hub Task List",
    document_purpose: "x",
    related_documents: [],
    tasks: [
      {
        id: "20",
        title: "t",
        description: "d",
        status: "pending",
        priority: "must",
        dependencies: [],
        subtasks: [],
        updatedAt: "2026-05-25T00:00:00.000Z",
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
  if (d.kind === "unknown") throw new Error("fixture invalid");
  return d;
}

function detectBacklog(): KnownDetected {
  const d = detectSchema({
    document_name: "Product Backlog",
    document_purpose: "x",
    related_documents: [],
    items: [
      {
        id: "101",
        description: "d",
        type: "feature",
        status: "ready",
        effort_estimate: null,
        priority: "high",
        track: "t",
        dependencies: [],
        session_refs: [],
        commit_refs: [],
        cross_doc_links: [],
        notes: null,
      },
    ],
  });
  if (d.kind === "unknown") throw new Error("fixture invalid");
  return d;
}

function newTask(id: string) {
  return {
    id,
    title: "new",
    description: "d",
    status: "pending",
    priority: "should",
    dependencies: [],
    subtasks: [],
    updatedAt: "2026-05-25T00:00:00.000Z",
    effort_estimate: null,
    owner: null,
    priority_note: null,
    status_note: null,
    cross_doc_links: [],
    session_refs: [],
    commit_refs: [],
  };
}

describe("insertRecord", () => {
  test("appends a valid Task and re-parses", () => {
    const detected = detectTaskList();
    const result = insertRecord(detected, newTask("42"));
    expect(result.ok).toBe(true);
    if (result.ok && result.detected.kind === "task-list") {
      expect(result.detected.data.tasks.map((t) => t.id).sort()).toEqual([
        "20",
        "42",
      ]);
    }
    // Input snapshot is NOT mutated:
    if (detected.kind === "task-list") {
      expect(detected.data.tasks).toHaveLength(1);
    }
  });

  test("rejects a duplicate id", () => {
    const result = insertRecord(detectTaskList(), newTask("20"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("duplicate-id");
      if (result.kind === "duplicate-id") expect(result.recordId).toBe("20");
    }
  });

  test("rejects a body with no id", () => {
    const result = insertRecord(detectTaskList(), { title: "no id" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("invalid-body");
  });

  test("surfaces a schema-error for a malformed record", () => {
    const result = insertRecord(detectTaskList(), {
      ...newTask("42"),
      status: "nope",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("schema-error");
  });

  test("appends a backlog item and re-runs the unique-id invariant", () => {
    const result = insertRecord(detectBacklog(), {
      id: "102",
      description: "d2",
      type: "bug",
      status: "ready",
      effort_estimate: null,
      priority: "low",
      track: "t",
      dependencies: [],
      session_refs: [],
      commit_refs: [],
      cross_doc_links: [],
      notes: null,
    });
    expect(result.ok).toBe(true);
  });
});

describe("removeRecord", () => {
  test("removes an existing record and re-parses", () => {
    const detected = detectTaskList();
    const result = removeRecord(detected, "20");
    expect(result.ok).toBe(true);
    if (result.ok && result.detected.kind === "task-list") {
      expect(result.detected.data.tasks).toEqual([]);
    }
    // Input snapshot is NOT mutated:
    if (detected.kind === "task-list")
      expect(detected.data.tasks).toHaveLength(1);
  });

  test("returns record-not-found for an absent id", () => {
    const result = removeRecord(detectTaskList(), "999");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("record-not-found");
  });

  test("removes a backlog item by id", () => {
    const result = removeRecord(detectBacklog(), "101");
    expect(result.ok).toBe(true);
    if (result.ok && result.detected.kind === "backlog") {
      expect(result.detected.data.items).toEqual([]);
    }
  });
});

// ── ID-90.9 U5: subtask CRUD + auto-id + create defaults ──────────────────────

import {
  insertSubtasks,
  removeSubtask,
  withCreateDefaults,
  nextId,
} from "./record-mutate";

function detectTaskListWithSubtasks(): KnownDetected {
  const d = detectSchema({
    document_name: "Knowledge Hub Task List",
    document_purpose: "x",
    related_documents: [],
    tasks: [
      {
        id: "49",
        title: "t",
        description: "d",
        status: "pending",
        priority: "must",
        dependencies: [],
        subtasks: [
          {
            id: 1,
            title: "s1",
            description: "d1",
            details: "",
            status: "done",
            dependencies: [],
            testStrategy: null,
          },
          {
            id: 2,
            title: "s2",
            description: "d2",
            details: "",
            status: "pending",
            dependencies: [1],
            testStrategy: null,
          },
        ],
        updatedAt: "2026-05-25T00:00:00.000Z",
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
  if (d.kind === "unknown") throw new Error("fixture invalid");
  return d;
}

describe("nextId — per-record max+1 allocation (ledger-cli.ts:645-674 port)", () => {
  test("subtasks: NUMBER, scoped to the parent task, max+1", () => {
    expect(nextId(detectTaskListWithSubtasks(), "subtasks", "49")).toBe(3);
  });

  test("subtasks: empty collection allocates 1", () => {
    expect(nextId(detectTaskList(), "subtasks", "20")).toBe(1);
  });

  test("tasks: bare-digit STRING max+1", () => {
    expect(nextId(detectTaskListWithSubtasks(), "tasks")).toBe("50");
  });

  test("items: bare-digit STRING max+1 on a backlog", () => {
    expect(nextId(detectBacklog(), "items")).toBe("102");
  });

  test("monotonic: does NOT fill gaps (max+1, never reuse)", () => {
    // Fixture task ids: "20" only → next is "21" even if lower ids are free.
    expect(nextId(detectTaskList(), "tasks")).toBe("21");
  });

  test("throws when the collection does not match the ledger kind", () => {
    expect(() => nextId(detectBacklog(), "tasks")).toThrow();
  });

  test("throws when subtasks is requested without a taskId", () => {
    expect(() => nextId(detectTaskListWithSubtasks(), "subtasks")).toThrow();
  });
});

describe("withCreateDefaults — structural defaults under the record (ledger-cli.ts:2237 port)", () => {
  test("subtask: status pending, dependencies [], details '', testStrategy null", () => {
    const r = withCreateDefaults("subtask", { title: "x", description: "y" });
    expect(r.status).toBe("pending");
    expect(r.dependencies).toEqual([]);
    expect(r.details).toBe("");
    expect(r.testStrategy).toBeNull();
    expect(r.title).toBe("x");
  });

  test("supplied fields WIN over defaults", () => {
    const r = withCreateDefaults("subtask", {
      title: "x",
      status: "in_progress",
      dependencies: [2],
    });
    expect(r.status).toBe("in_progress");
    expect(r.dependencies).toEqual([2]);
  });

  test("task: updatedAt auto-stamps to the write timestamp when absent", () => {
    const before = Date.now();
    const r = withCreateDefaults("task", { title: "x" });
    const stamped = Date.parse(r.updatedAt as string);
    expect(Number.isFinite(stamped)).toBe(true);
    expect(stamped).toBeGreaterThanOrEqual(before - 1000);
    expect(r.status).toBe("pending");
    expect(r.subtasks).toEqual([]);
  });

  test("task: a supplied updatedAt is kept", () => {
    const r = withCreateDefaults("task", {
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(r.updatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("item: type feature / track unsorted / status parked when absent", () => {
    const r = withCreateDefaults("item", { description: "d" });
    expect(r.type).toBe("feature");
    expect(r.track).toBe("unsorted");
    expect(r.status).toBe("parked");
  });
});

describe("insertSubtasks — bulk fold-left create (ID-90.9 U5)", () => {
  test("allocates sequential ids across the batch (fold-left max+1)", () => {
    const result = insertSubtasks(detectTaskListWithSubtasks(), "49", [
      { title: "a", description: "da" },
      { title: "b", description: "db" },
      { title: "c", description: "dc" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.subtaskIds).toEqual([3, 4, 5]);
      if (result.detected.kind === "task-list") {
        const subs = result.detected.data.tasks[0].subtasks;
        expect(subs.map((s) => s.id)).toEqual([1, 2, 3, 4, 5]);
      }
    }
  });

  test("applies create defaults to each record", () => {
    const result = insertSubtasks(detectTaskListWithSubtasks(), "49", [
      { title: "a", description: "da" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok && result.detected.kind === "task-list") {
      const added = result.detected.data.tasks[0].subtasks[2];
      expect(added.status).toBe("pending");
      expect(added.dependencies).toEqual([]);
      expect(added.details).toBe("");
      expect(added.testStrategy).toBeNull();
    }
  });

  test("an explicit id is kept and later auto-ids never collide with it", () => {
    const result = insertSubtasks(detectTaskListWithSubtasks(), "49", [
      { id: 7, title: "explicit", description: "d" },
      { title: "auto", description: "d" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Fold-left: after inserting id 7, the per-record max+1 is 8.
      expect(result.subtaskIds).toEqual([7, 8]);
    }
  });

  test("duplicate-id pre-check: explicit id colliding with an existing subtask rejects", () => {
    const result = insertSubtasks(detectTaskListWithSubtasks(), "49", [
      { id: 2, title: "dup", description: "d" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("duplicate-id");
      if (result.kind === "duplicate-id") expect(result.subtaskId).toBe(2);
    }
  });

  test("duplicate-id pre-check: two explicit ids colliding WITHIN the batch reject", () => {
    const result = insertSubtasks(detectTaskListWithSubtasks(), "49", [
      { id: 9, title: "a", description: "d" },
      { id: 9, title: "b", description: "d" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("duplicate-id");
  });

  test("whole-doc Zod re-parse rejects a malformed record (nothing applied)", () => {
    const detected = detectTaskListWithSubtasks();
    const result = insertSubtasks(detected, "49", [
      { title: "a", description: "d", status: "not_a_status" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("schema-error");
    // Input snapshot untouched:
    if (detected.kind === "task-list") {
      expect(detected.data.tasks[0].subtasks).toHaveLength(2);
    }
  });

  test("task-not-found for an absent parent task", () => {
    const result = insertSubtasks(detectTaskListWithSubtasks(), "999", [
      { title: "a", description: "d" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("task-not-found");
  });

  test("rejects an empty batch as invalid-body", () => {
    const result = insertSubtasks(detectTaskListWithSubtasks(), "49", []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("invalid-body");
  });

  test("rejects a non-object element as invalid-body", () => {
    const result = insertSubtasks(detectTaskListWithSubtasks(), "49", [
      "nope" as unknown as Record<string, unknown>,
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("invalid-body");
  });

  test("input snapshot is never mutated on success", () => {
    const detected = detectTaskListWithSubtasks();
    const result = insertSubtasks(detected, "49", [
      { title: "a", description: "d" },
    ]);
    expect(result.ok).toBe(true);
    if (detected.kind === "task-list") {
      expect(detected.data.tasks[0].subtasks).toHaveLength(2);
    }
  });
});

describe("removeSubtask — subtask DELETE (ID-90.9 U5)", () => {
  test("removes an existing subtask and re-parses", () => {
    const detected = detectTaskListWithSubtasks();
    // Subtask 2 depends on 1, so 2 is the dependency-safe removal.
    const result = removeSubtask(detected, "49", 2);
    expect(result.ok).toBe(true);
    if (result.ok && result.detected.kind === "task-list") {
      expect(result.detected.data.tasks[0].subtasks.map((s) => s.id)).toEqual([
        1,
      ]);
    }
    // Input snapshot untouched:
    if (detected.kind === "task-list") {
      expect(detected.data.tasks[0].subtasks).toHaveLength(2);
    }
  });

  test("removing the last subtask leaves a legal empty subtasks[]", () => {
    const d1 = removeSubtask(detectTaskListWithSubtasks(), "49", 2);
    expect(d1.ok).toBe(true);
    if (!d1.ok) return;
    const d2 = removeSubtask(d1.detected, "49", 1);
    expect(d2.ok).toBe(true);
    if (d2.ok && d2.detected.kind === "task-list") {
      expect(d2.detected.data.tasks[0].subtasks).toEqual([]);
    }
  });

  test("removing a subtask a SIBLING depends on surfaces the schema-error (sibling-dep superRefine)", () => {
    // Subtask 2 declares dependencies: [1] — dropping 1 strands the dep, and
    // the whole-doc re-parse (TaskSchema superRefine) rejects it.
    const result = removeSubtask(detectTaskListWithSubtasks(), "49", 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("schema-error");
  });

  test("subtask-not-found for an absent subId", () => {
    const result = removeSubtask(detectTaskListWithSubtasks(), "49", 99);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("subtask-not-found");
  });

  test("task-not-found for an absent parent task", () => {
    const result = removeSubtask(detectTaskListWithSubtasks(), "999", 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("task-not-found");
  });
});
