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
