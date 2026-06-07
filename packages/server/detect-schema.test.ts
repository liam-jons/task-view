/**
 * Tests for detectSchema — TECH §2.1.
 *
 * Acceptance gate (per ID-20.7 PLAN):
 *   "detectSchema unit tests cover all 3 known values + unknown rejection."
 *
 * Three-way schema discrimination:
 *   - "Knowledge Hub Task List" → TaskListSchema parse → { kind: 'task-list', data }
 *   - "Knowledge Hub Roadmap"   → RoadmapSchema parse  → { kind: 'roadmap', data }
 *   - "Product Backlog"          → BacklogSchema parse  → { kind: 'backlog', data }
 *   - Anything else (including unparseable input)        → { kind: 'unknown', documentName }
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

const minimalRoadmap = {
  document_name: "Knowledge Hub Roadmap",
  document_purpose: "Forward-looking roadmap of Knowledge Hub phases and themes.",
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
      status: "in_progress",
      linked_tasks: [],
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

const minimalUmbrellas = {
  document_name: "umbrellas",
  document_purpose: "Umbrella groupings of Tasks (Linear-Initiative analogue).",
  last_updated: "kh-main-S1 synthetic fixture",
  related_documents: [],
  umbrellas: [
    {
      id: "test-umbrella",
      title: "Test Umbrella",
      substrate_doc: "docs/reference/test-umbrella.md",
      task_ids: ["1", "2"],
      status: "in_progress",
      phase: "Phase 1",
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

  test("routes 'Knowledge Hub Roadmap' to roadmap kind with parsed data", () => {
    const result = detectSchema(minimalRoadmap);
    expect(result.kind).toBe("roadmap");
    if (result.kind === "roadmap") {
      expect(result.data.document_name).toBe("Knowledge Hub Roadmap");
      expect(result.data.themes).toHaveLength(1);
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

  // ID-90 U8 — umbrellas registered as the FOURTH known document kind
  // (PRODUCT invariant 49).
  test("routes 'umbrellas' to umbrellas kind with parsed data (ID-90 U8, inv 49)", () => {
    const result = detectSchema(minimalUmbrellas);
    expect(result.kind).toBe("umbrellas");
    if (result.kind === "umbrellas") {
      expect(result.data.document_name).toBe("umbrellas");
      expect(result.data.umbrellas).toHaveLength(1);
      expect(result.data.umbrellas[0].id).toBe("test-umbrella");
      expect(result.data.umbrellas[0].task_ids).toEqual(["1", "2"]);
    }
  });

  test("KNOWN_DOCUMENT_NAMES carries the fourth literal 'umbrellas' (ID-90 U8)", () => {
    expect(KNOWN_DOCUMENT_NAMES).toContain("umbrellas");
    expect(KNOWN_DOCUMENT_NAMES).toHaveLength(4);
  });

  test("throws ZodError when document_name matches umbrellas but body fails schema", () => {
    expect(() =>
      detectSchema({
        document_name: "umbrellas",
        // missing required fields
      }),
    ).toThrow();
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

  test("throws ZodError when document_name matches Roadmap but body fails schema", () => {
    expect(() =>
      detectSchema({
        document_name: "Knowledge Hub Roadmap",
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

  test("roadmap branch exposes typed Roadmap data", () => {
    const result = detectSchema(minimalRoadmap);
    if (result.kind === "roadmap") {
      const firstTheme = result.data.themes[0];
      expect(firstTheme.time_horizon).toBe("now");
      expect(firstTheme.status).toBe("in_progress");
    } else {
      throw new Error("Expected roadmap kind");
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
