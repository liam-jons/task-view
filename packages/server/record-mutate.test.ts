/**
 * Tests for record-mutate.ts — ID-20.15 record-level CREATE / DELETE.
 *
 * Pure-logic coverage: insert / remove dispatch per kind, duplicate-id +
 * not-found rejection, document-level invariant re-parse (backlog unique-id
 * superRefine), and snapshot immutability (input is never mutated).
 */
import { describe, expect, setSystemTime, test } from "bun:test";
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
            id: "1",
            title: "s1",
            description: "d1",
            details: "",
            status: "done",
            dependencies: [],
            testStrategy: null,
          },
          {
            id: "2",
            title: "s2",
            description: "d2",
            details: "",
            status: "pending",
            dependencies: ["1"],
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

/**
 * Task "49" seeded with EXACTLY the given digit-string subtask ids — used by
 * the ID-102.7 P3b concat-prevention canaries (a high baseline like ['5'] is
 * where a string `counter += 1` would corrupt to '51'/'511').
 */
function detectTaskListWithSubtaskIds(ids: readonly string[]): KnownDetected {
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
        subtasks: ids.map((id) => ({
          id,
          title: `s${id}`,
          description: `d${id}`,
          details: "",
          status: "pending" as const,
          dependencies: [],
          testStrategy: null,
        })),
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
  test("subtasks: digit-STRING, scoped to the parent task, max+1", () => {
    expect(nextId(detectTaskListWithSubtasks(), "subtasks", "49")).toBe("3");
  });

  test("subtasks: empty collection allocates 1", () => {
    expect(nextId(detectTaskList(), "subtasks", "20")).toBe("1");
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

// ── ID-90 F5/Bug3: monotonic id high-water mark (no id reuse) ─────────────────
//
// The bl-287/288 collision class: `max(survivors)+1` reuses an id freed by
// delete/promote (which lowers the live max). The `_idHighWater` field records
// the highest id ever ALLOCATED so a freed id is never re-handed-out.

function newItem(id: string) {
  return {
    id,
    title: "i",
    description: "d",
    type: "feature" as const,
    status: "parked" as const,
    effort_estimate: null,
    priority: "could" as const,
    track: "unsorted",
    dependencies: [],
    session_refs: [],
    commit_refs: [],
    cross_doc_links: [],
    notes: null,
  };
}

function backlogWith(
  ids: readonly string[],
  highWater?: number,
): KnownDetected {
  const doc: Record<string, unknown> = {
    document_name: "Product Backlog",
    document_purpose: "x",
    related_documents: [],
    items: ids.map(newItem),
  };
  if (highWater !== undefined) doc._idHighWater = highWater;
  const d = detectSchema(doc);
  if (d.kind === "unknown") throw new Error("fixture invalid");
  return d;
}

describe("nextId — _idHighWater monotonic counter (Bug3)", () => {
  test("backward-compatible: a ledger WITHOUT _idHighWater behaves as max+1", () => {
    expect(nextId(backlogWith(["10", "11"]), "items")).toBe("12");
  });

  test("stored high-water above live max wins (a freed top id is not reused)", () => {
    // Live max 11, but the counter remembers 50 was once allocated.
    expect(nextId(backlogWith(["10", "11"], 50), "items")).toBe("51");
  });

  test("live max above a stale high-water wins (counter never lowers an answer)", () => {
    expect(nextId(backlogWith(["10", "11"], 5), "items")).toBe("12");
  });

  test("Repro A — create then delete then create does NOT reuse the freed id", () => {
    // Start: items 10,11 (no counter). Allocate 12, insert it, delete it,
    // then the NEXT allocation must be 13 — not a reuse of the freed 12.
    const start = backlogWith(["10", "11"]);
    const allocated = nextId(start, "items"); // "12"
    expect(allocated).toBe("12");

    const inserted = insertRecord(start, newItem(allocated));
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    expect(inserted.detected.data._idHighWater).toBe(12);

    const removed = removeRecord(inserted.detected, "12");
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    // The freed top id 12 is recorded in the persisted counter…
    expect(removed.detected.data._idHighWater).toBe(12);
    // …so the next allocation is 13, NOT a reuse of 12.
    expect(nextId(removed.detected, "items")).toBe("13");
  });

  test("Repro B — promote (removeRecord leg) then create does NOT reuse the freed id", () => {
    // The promote remove-leg uses removeRecord on the backlog. Modelling that
    // leg: insert the to-be-promoted item, then removeRecord it (promote out),
    // then the next backlog allocation must NOT reuse the freed id (which the
    // promoted Task now back-references).
    const start = backlogWith(["10", "11"]);
    const promotedId = nextId(start, "items"); // "12"
    const created = insertRecord(start, newItem(promotedId));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const promotedOut = removeRecord(created.detected, promotedId); // promote remove-leg
    expect(promotedOut.ok).toBe(true);
    if (!promotedOut.ok) return;
    expect(promotedOut.detected.data._idHighWater).toBe(12);

    const next = nextId(promotedOut.detected, "items");
    expect(next).toBe("13");
    expect(next).not.toBe(promotedId); // never reuse the promoted-out id
  });

  test("insert seeds the counter on a legacy (no-counter) ledger", () => {
    const start = backlogWith(["10", "11"]);
    expect(
      (start.data as { _idHighWater?: number })._idHighWater,
    ).toBeUndefined();
    const inserted = insertRecord(start, newItem("12"));
    expect(inserted.ok).toBe(true);
    if (inserted.ok) expect(inserted.detected.data._idHighWater).toBe(12);
  });

  test("delete seeds the counter from the pre-removal max on a legacy ledger", () => {
    const start = backlogWith(["10", "11", "12"]);
    const removed = removeRecord(start, "12");
    expect(removed.ok).toBe(true);
    // The pre-removal max (12) is recorded so 12 is never re-handed-out.
    if (removed.ok) expect(removed.detected.data._idHighWater).toBe(12);
  });

  test("tasks collection honours the high-water counter too", () => {
    const doc: Record<string, unknown> = {
      document_name: "Knowledge Hub Task List",
      document_purpose: "x",
      related_documents: [],
      _idHighWater: 200,
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
    };
    const d = detectSchema(doc);
    if (d.kind === "unknown") throw new Error("fixture invalid");
    // Live max 20, counter 200 → next is 201.
    expect(nextId(d, "tasks")).toBe("201");
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
      dependencies: ["2"],
    });
    expect(r.status).toBe("in_progress");
    expect(r.dependencies).toEqual(["2"]);
  });

  test("task: updatedAt auto-stamps to the write timestamp when absent", () => {
    // Pinned-time convention (S324 annotation via check-90-9): freeze the
    // clock and assert the EXACT ISO stamp — no back-tolerance window.
    const PINNED_ISO = "2026-06-07T12:00:00.000Z";
    setSystemTime(new Date(PINNED_ISO));
    try {
      const r = withCreateDefaults("task", { title: "x" });
      expect(r.updatedAt).toBe(PINNED_ISO);
      expect(r.status).toBe("pending");
      expect(r.subtasks).toEqual([]);
    } finally {
      setSystemTime(); // restore the real clock
    }
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
      expect(result.subtaskIds).toEqual(["3", "4", "5"]);
      if (result.detected.kind === "task-list") {
        const subs = result.detected.data.tasks[0].subtasks;
        expect(subs.map((s) => s.id)).toEqual(["1", "2", "3", "4", "5"]);
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
      { id: "7", title: "explicit", description: "d" },
      { title: "auto", description: "d" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Fold-left: after inserting id 7, the per-record max+1 is 8.
      expect(result.subtaskIds).toEqual(["7", "8"]);
    }
  });

  test("duplicate-id pre-check: explicit id colliding with an existing subtask rejects", () => {
    const result = insertSubtasks(detectTaskListWithSubtasks(), "49", [
      { id: "2", title: "dup", description: "d" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("duplicate-id");
      if (result.kind === "duplicate-id") expect(result.subtaskId).toBe("2");
    }
  });

  test("duplicate-id pre-check: two explicit ids colliding WITHIN the batch reject", () => {
    const result = insertSubtasks(detectTaskListWithSubtasks(), "49", [
      { id: "9", title: "a", description: "d" },
      { id: "9", title: "b", description: "d" },
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

  // ID-102.7 P3b concat-prevention canaries: the fold-left counter MUST stay
  // numeric for the `+ 1` arithmetic and only String()-wrap the stamped id. A
  // string counter would concatenate ('5' + 1 === '51'), corrupting every
  // bulk-allocated id past a single-digit baseline (inv 8 monotonic auto-id).
  test("high baseline ['5'] → batch-of-3 allocates '6','7','8' (NOT '51','511')", () => {
    const result = insertSubtasks(detectTaskListWithSubtaskIds(["5"]), "49", [
      { title: "a", description: "da" },
      { title: "b", description: "db" },
      { title: "c", description: "dc" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.subtaskIds).toEqual(["6", "7", "8"]);
      if (result.detected.kind === "task-list") {
        const subs = result.detected.data.tasks[0].subtasks;
        expect(subs.map((s) => s.id)).toEqual(["5", "6", "7", "8"]);
      }
    }
  });

  test("gap baseline ['2','10'] → batch-of-1 allocates '11' (max+1 numeric, not '3')", () => {
    const result = insertSubtasks(
      detectTaskListWithSubtaskIds(["2", "10"]),
      "49",
      [{ title: "a", description: "da" }],
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.subtaskIds).toEqual(["11"]);
      if (result.detected.kind === "task-list") {
        const subs = result.detected.data.tasks[0].subtasks;
        expect(subs.map((s) => s.id)).toEqual(["2", "10", "11"]);
      }
    }
  });
});

// ── ID-148.10 (INV-13): initiatives nested project insert/remove ─────────────

function detectInitiatives(): KnownDetected {
  const d = detectSchema({
    document_name: "Canonical Platform - Initiatives",
    document_purpose: "x",
    date: "2026-07-15",
    status: "active",
    related_documents: [],
    last_updated: "kh-main-S473",
    initiatives: [
      {
        id: "1",
        title: "Foundation",
        description: "d",
        status: "active",
        projects: [
          {
            id: "existing-project",
            title: "Existing",
            summary: "s",
            description: "d",
            substrate_doc: "",
            status: "idea",
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
      {
        id: "4",
        title: "SDLC",
        description: "d",
        status: "active",
        projects: [],
        originating_session: [],
        "sub-initiatives": [
          {
            id: "2",
            title: "Sub two",
            description: "d",
            status: "planned",
            projects: [],
            originating_session: [],
            "sub-initiatives": [],
          },
        ],
      },
    ],
  });
  if (d.kind === "unknown") throw new Error("fixture invalid");
  return d;
}

function newProject(id: string) {
  return {
    id,
    title: "New project",
    summary: "s",
    description: "d",
    substrate_doc: "",
    status: "idea",
    blocked_by: [],
    blocking: [],
    linked_tasks: [],
    linked_backlog: [],
    originating_session: [],
  };
}

describe("insertRecord — initiatives nested project insert (INV-13)", () => {
  test("inserts under a top-level initiative given its parentPath", () => {
    const detected = detectInitiatives();
    const result = insertRecord(detected, newProject("new-slug"), "1");
    expect(result.ok).toBe(true);
    if (result.ok && result.detected.kind === "initiatives") {
      expect(
        result.detected.data.initiatives[0].projects.map((p) => p.id),
      ).toEqual(["existing-project", "new-slug"]);
    }
    // Input snapshot untouched:
    if (detected.kind === "initiatives") {
      expect(detected.data.initiatives[0].projects).toHaveLength(1);
    }
  });

  test("inserts under a nested sub-initiative given a dotted parentPath", () => {
    const result = insertRecord(
      detectInitiatives(),
      newProject("nested-slug"),
      "4.2",
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.detected.kind === "initiatives") {
      const sub = result.detected.data.initiatives[1]["sub-initiatives"][0];
      expect(sub.projects.map((p) => p.id)).toEqual(["nested-slug"]);
    }
  });

  test("rejects with invalid-body when parentPath is absent", () => {
    const result = insertRecord(detectInitiatives(), newProject("x"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("invalid-body");
  });

  test("rejects with invalid-body when parentPath does not resolve", () => {
    const result = insertRecord(detectInitiatives(), newProject("x"), "999");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("invalid-body");
  });

  test("rejects a duplicate slug even across DIFFERENT initiatives (global uniqueness)", () => {
    const result = insertRecord(
      detectInitiatives(),
      newProject("existing-project"),
      "4",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("duplicate-id");
      if (result.kind === "duplicate-id") {
        expect(result.recordId).toBe("existing-project");
      }
    }
  });

  test("surfaces a schema-error for a malformed project body", () => {
    const result = insertRecord(
      detectInitiatives(),
      { ...newProject("bad"), blocked_by: "not-an-array" },
      "1",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("schema-error");
  });
});

describe("removeRecord — initiatives nested project removal by slug (INV-13)", () => {
  test("removes a project directly under a top-level initiative", () => {
    const detected = detectInitiatives();
    const result = removeRecord(detected, "existing-project");
    expect(result.ok).toBe(true);
    if (result.ok && result.detected.kind === "initiatives") {
      expect(result.detected.data.initiatives[0].projects).toEqual([]);
    }
    // Input snapshot untouched:
    if (detected.kind === "initiatives") {
      expect(detected.data.initiatives[0].projects).toHaveLength(1);
    }
  });

  test("removes a project nested under a sub-initiative wherever it lives", () => {
    const withNested = insertRecord(
      detectInitiatives(),
      newProject("to-remove"),
      "4.2",
    );
    expect(withNested.ok).toBe(true);
    if (!withNested.ok || withNested.detected.kind !== "initiatives") return;
    const removed = removeRecord(withNested.detected, "to-remove");
    expect(removed.ok).toBe(true);
    if (removed.ok && removed.detected.kind === "initiatives") {
      const sub = removed.detected.data.initiatives[1]["sub-initiatives"][0];
      expect(sub.projects).toEqual([]);
    }
  });

  test("returns record-not-found for an unknown slug", () => {
    const result = removeRecord(detectInitiatives(), "does-not-exist");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("record-not-found");
  });
});

describe("removeSubtask — subtask DELETE (ID-90.9 U5)", () => {
  test("removes an existing subtask and re-parses", () => {
    const detected = detectTaskListWithSubtasks();
    // Subtask 2 depends on 1, so 2 is the dependency-safe removal.
    const result = removeSubtask(detected, "49", "2");
    expect(result.ok).toBe(true);
    if (result.ok && result.detected.kind === "task-list") {
      expect(result.detected.data.tasks[0].subtasks.map((s) => s.id)).toEqual([
        "1",
      ]);
    }
    // Input snapshot untouched:
    if (detected.kind === "task-list") {
      expect(detected.data.tasks[0].subtasks).toHaveLength(2);
    }
  });

  test("removing the last subtask leaves a legal empty subtasks[]", () => {
    const d1 = removeSubtask(detectTaskListWithSubtasks(), "49", "2");
    expect(d1.ok).toBe(true);
    if (!d1.ok) return;
    const d2 = removeSubtask(d1.detected, "49", "1");
    expect(d2.ok).toBe(true);
    if (d2.ok && d2.detected.kind === "task-list") {
      expect(d2.detected.data.tasks[0].subtasks).toEqual([]);
    }
  });

  test("removing a subtask a SIBLING depends on surfaces the schema-error (sibling-dep superRefine)", () => {
    // Subtask 2 declares dependencies: [1] — dropping 1 strands the dep, and
    // the whole-doc re-parse (TaskSchema superRefine) rejects it.
    const result = removeSubtask(detectTaskListWithSubtasks(), "49", "1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("schema-error");
  });

  test("subtask-not-found for an absent subId", () => {
    const result = removeSubtask(detectTaskListWithSubtasks(), "49", "99");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("subtask-not-found");
  });

  test("task-not-found for an absent parent task", () => {
    const result = removeSubtask(detectTaskListWithSubtasks(), "999", "1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("task-not-found");
  });
});
