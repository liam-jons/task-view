/**
 * Tests for detectSchema — TECH §2.1.
 *
 * Four-way schema discrimination (ID-148.10, TECH §3.1(b) — repurposed
 * roadmap arm, umbrellas RETIRED):
 *   - "Knowledge Hub Task List"          → TaskListSchema parse    → { kind: 'task-list', data }
 *   - "Canonical Platform - Initiatives" → InitiativesSchema parse → { kind: 'initiatives', data }
 *   - "Product Backlog"                    → BacklogSchema parse    → { kind: 'backlog', data }
 *   - "Knowledge Hub Retros"               → RetrosSchema parse     → { kind: 'retro', data }
 *   - Anything else (including unparseable input) → { kind: 'unknown', documentName }
 *
 * PRODUCT inv 4 asymmetry: BacklogSchema.document_name is z.string().min(1)
 * (not a z.literal), so detectSchema matches on the canonical VALUE
 * "Product Backlog", not on schema field shape.
 */
import { describe, expect, test } from "bun:test";
import { detectSchema, KNOWN_DOCUMENT_NAMES } from "./detect-schema";

// ── Minimal fixtures matching the vendored schemas ────────────────────────────

const minimalTaskList = {
  document_name: "Knowledge Hub Task List",
  document_purpose: "Active + recently-closed structured work — Taskmaster JSON shape.",
  related_documents: [],
  tasks: [
    {
      id: "20",
      title: "Per-Task .md mirror generator + render surface",
      description: "Outer task description.",
      status: "in_progress",
      priority: "must",
      dependencies: [],
      subtasks: [],
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

const minimalInitiatives = {
  document_name: "Canonical Platform - Initiatives",
  document_purpose: "Structured record of active initiatives and their constituent projects.",
  date: "2026-07-15",
  status: "active",
  related_documents: [],
  last_updated: "kh-main-S473 representative fixture",
  initiatives: [
    {
      id: "1",
      title: "Foundation",
      description: "Foundation initiative description.",
      status: "active",
      projects: [
        {
          id: "foundation-project",
          title: "Foundation project",
          summary: "Summary.",
          description: "Description.",
          substrate_doc: "",
          status: "in-progress",
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
};

const minimalBacklog = {
  document_name: "Product Backlog",
  document_purpose: "Forward-looking backlog of unscheduled work items.",
  related_documents: [],
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

describe("detectSchema — known document_name values", () => {
  test("routes 'Knowledge Hub Task List' to task-list kind with parsed data", () => {
    const result = detectSchema(minimalTaskList);
    expect(result.kind).toBe("task-list");
    if (result.kind === "task-list") {
      expect(result.data.document_name).toBe("Knowledge Hub Task List");
      expect(result.data.tasks).toHaveLength(1);
      expect(result.data.tasks[0].id).toBe("20");
    }
  });

  test("routes 'Canonical Platform - Initiatives' to initiatives kind with parsed nested data", () => {
    const result = detectSchema(minimalInitiatives);
    expect(result.kind).toBe("initiatives");
    if (result.kind === "initiatives") {
      expect(result.data.document_name).toBe("Canonical Platform - Initiatives");
      expect(result.data.initiatives).toHaveLength(1);
      expect(result.data.initiatives[0].projects[0].id).toBe("foundation-project");
    }
  });

  test("routes 'Product Backlog' to backlog kind with parsed data (value match, not schema literal)", () => {
    const result = detectSchema(minimalBacklog);
    expect(result.kind).toBe("backlog");
    if (result.kind === "backlog") {
      expect(result.data.document_name).toBe("Product Backlog");
      expect(result.data.items).toHaveLength(1);
    }
  });

  test("KNOWN_DOCUMENT_NAMES no longer carries 'umbrellas' (ID-148.10 retirement) and carries 4 literals", () => {
    expect(KNOWN_DOCUMENT_NAMES).not.toContain("umbrellas");
    expect(KNOWN_DOCUMENT_NAMES).toContain("Canonical Platform - Initiatives");
    expect(KNOWN_DOCUMENT_NAMES).toContain("Knowledge Hub Retros");
    expect(KNOWN_DOCUMENT_NAMES).toHaveLength(4);
  });

  test("'umbrellas' document_name is now UNKNOWN (retired kind, ID-148.10 INV-12(b))", () => {
    const result = detectSchema({ document_name: "umbrellas" });
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") expect(result.documentName).toBe("umbrellas");
  });

  test("'Knowledge Hub Roadmap' document_name is now UNKNOWN (repurposed to initiatives, ID-148.10)", () => {
    const result = detectSchema({ document_name: "Knowledge Hub Roadmap" });
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") expect(result.documentName).toBe("Knowledge Hub Roadmap");
  });
});

describe("detectSchema — unknown / invalid input", () => {
  test("returns { kind: 'unknown' } with non-canonical document_name preserved", () => {
    const result = detectSchema({ document_name: "Some Other Document" });
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.documentName).toBe("Some Other Document");
    }
  });

  test("returns { kind: 'unknown', documentName: null } when document_name missing", () => {
    const result = detectSchema({ some_other_field: "value" });
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.documentName).toBeNull();
    }
  });

  test("returns { kind: 'unknown', documentName: null } when document_name is non-string", () => {
    const result = detectSchema({ document_name: 42 });
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.documentName).toBeNull();
    }
  });

  test("returns { kind: 'unknown', documentName: null } when input is null", () => {
    const result = detectSchema(null);
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.documentName).toBeNull();
    }
  });

  test("returns { kind: 'unknown', documentName: null } when input is not an object", () => {
    const result = detectSchema("a string");
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.documentName).toBeNull();
    }
  });

  test("throws ZodError when document_name matches Task List but body fails schema", () => {
    // Per TECH §2.1: detectSchema runs the full schema parse on a match.
    // Schema failures throw ZodError per inv 48 (formatted ZodError + non-zero exit).
    expect(() =>
      detectSchema({
        document_name: "Knowledge Hub Task List",
        // missing required fields
      }),
    ).toThrow();
  });

  test("throws ZodError when document_name matches Initiatives but body fails schema", () => {
    expect(() =>
      detectSchema({
        document_name: "Canonical Platform - Initiatives",
        // missing required fields
      }),
    ).toThrow();
  });

  test("throws ZodError when document_name matches Backlog value but body fails schema", () => {
    expect(() =>
      detectSchema({
        document_name: "Product Backlog",
        // missing required fields
      }),
    ).toThrow();
  });
});

describe("detectSchema — discriminated union narrowing", () => {
  test("task-list branch exposes typed TaskList data", () => {
    const result = detectSchema(minimalTaskList);
    if (result.kind === "task-list") {
      // Type narrowing: result.data is typed as TaskList.
      const firstTask = result.data.tasks[0];
      expect(firstTask.priority).toBe("must");
      expect(firstTask.owner).toBe("Engineering");
    } else {
      throw new Error("Expected task-list kind");
    }
  });

  test("initiatives branch exposes typed InitiativesDocument data (nested tree)", () => {
    const result = detectSchema(minimalInitiatives);
    if (result.kind === "initiatives") {
      const firstInitiative = result.data.initiatives[0];
      expect(firstInitiative.status).toBe("active");
      expect(firstInitiative["sub-initiatives"]).toEqual([]);
      expect(firstInitiative.projects[0].status).toBe("in-progress");
    } else {
      throw new Error("Expected initiatives kind");
    }
  });

  test("backlog branch exposes typed BacklogDocument data", () => {
    const result = detectSchema(minimalBacklog);
    if (result.kind === "backlog") {
      const firstItem = result.data.items[0];
      expect(firstItem.type).toBe("feature");
      expect(firstItem.priority).toBe("should");
    } else {
      throw new Error("Expected backlog kind");
    }
  });
});
