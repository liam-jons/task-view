/**
 * Tests for gates/status-enum-gate — TECH §2 INV-3 (ID-148.13).
 *
 * Pure-function coverage of the two hook-entry points, mirroring
 * budget-gate.test.ts's port-parity style: post-mutation / pre-serialisation
 * PATCH-hook (`checkStatusEnumForPatches`) and CREATE-hook
 * (`checkStatusEnumForCreate`). HTTP-level end-to-end coverage (direct PATCH
 * bypassing any CLI) lives in patch-server.test.ts.
 *
 * Synthetic fixtures only (AC-I) — no client-name tokens anywhere.
 */
import { describe, expect, test } from "bun:test";

import {
  checkStatusEnumForPatches,
  checkStatusEnumForCreate,
} from "./status-enum-gate";
import type { InitiativesDocument } from "@task-view/schemas/initiatives";
import type { FieldPatch } from "../patch-apply";

// ── Fixtures (synthetic) ─────────────────────────────────────────────────────

function makeInitiatives(
  projectOverrides: Partial<Record<string, unknown>> = {},
  initiativeOverrides: Partial<Record<string, unknown>> = {},
): InitiativesDocument {
  return {
    document_name: "Canonical Platform - Initiatives",
    document_purpose: "Synthetic test initiatives ledger.",
    date: "2026-07-15",
    status: "active",
    related_documents: [],
    last_updated: "id-148.13 synthetic fixture",
    initiatives: [
      {
        id: "3",
        title: "Synthetic initiative",
        description: "Body.",
        status: "active",
        projects: [
          {
            id: "3-project",
            title: "Synthetic project",
            summary: "Summary.",
            description: "Description.",
            substrate_doc: "",
            status: "in-progress",
            blocked_by: [],
            blocking: [],
            linked_tasks: [],
            linked_backlog: [],
            originating_session: [],
            ...projectOverrides,
          },
        ],
        originating_session: [],
        "sub-initiatives": [],
        ...initiativeOverrides,
      },
    ],
  } as unknown as InitiativesDocument;
}

// ── checkStatusEnumForPatches ────────────────────────────────────────────────

describe("checkStatusEnumForPatches", () => {
  test("no-op for task-list — status enum is enforced in-schema, never this gate", () => {
    const outcome = checkStatusEnumForPatches(
      "task-list",
      {} as InitiativesDocument,
      [{ fieldPath: ["tasks", "7", "status"], newValue: "not-a-real-status" }],
    );
    expect(outcome.ok).toBe(true);
  });

  test("no-op for backlog", () => {
    const outcome = checkStatusEnumForPatches(
      "backlog",
      {} as InitiativesDocument,
      [{ fieldPath: ["items", "7", "status"], newValue: "not-a-real-status" }],
    );
    expect(outcome.ok).toBe(true);
  });

  test("accepts a valid project status patch", () => {
    const doc = makeInitiatives({ status: "paused" });
    const outcome = checkStatusEnumForPatches("initiatives", doc, [
      { fieldPath: ["projects", "3-project", "status"], newValue: "paused" },
    ]);
    expect(outcome.ok).toBe(true);
  });

  test("rejects an out-of-enum project status patch", () => {
    const doc = makeInitiatives({ status: "bogus-status" });
    const outcome = checkStatusEnumForPatches("initiatives", doc, [
      { fieldPath: ["projects", "3-project", "status"], newValue: "bogus-status" },
    ]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe("invalid-status");
      expect(outcome.detail).toContain("bogus-status");
      expect(outcome.detail).toContain("project");
    }
  });

  test("accepts a valid top-level initiative status patch", () => {
    const doc = makeInitiatives({}, { status: "completed" });
    const outcome = checkStatusEnumForPatches("initiatives", doc, [
      { fieldPath: ["initiatives", "3", "status"], newValue: "completed" },
    ]);
    expect(outcome.ok).toBe(true);
  });

  test("rejects an out-of-enum initiative status patch, project vocabulary does not leak in", () => {
    // "in-progress" is a valid PROJECT status but NOT a valid INITIATIVE
    // status — proves the two vocabularies stay separate (INITIATIVE_STATUSES
    // vs PROJECT_STATUSES).
    const doc = makeInitiatives({}, { status: "in-progress" });
    const outcome = checkStatusEnumForPatches("initiatives", doc, [
      { fieldPath: ["initiatives", "3", "status"], newValue: "in-progress" },
    ]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe("invalid-status");
      expect(outcome.detail).toContain("initiative");
    }
  });

  test("rejects an out-of-enum sub-initiative status patch (dotted path)", () => {
    const doc = makeInitiatives();
    (doc.initiatives[0] as unknown as { "sub-initiatives": unknown[] })[
      "sub-initiatives"
    ] = [
      {
        id: "1",
        title: "Sub",
        description: "Body.",
        status: "not-a-real-status",
        projects: [],
        originating_session: [],
        "sub-initiatives": [],
      },
    ];
    const outcome = checkStatusEnumForPatches("initiatives", doc, [
      { fieldPath: ["initiatives", "3.1", "status"], newValue: "not-a-real-status" },
    ]);
    expect(outcome.ok).toBe(false);
  });

  test("ignores patches to non-status fields", () => {
    const doc = makeInitiatives();
    const outcome = checkStatusEnumForPatches("initiatives", doc, [
      { fieldPath: ["projects", "3-project", "summary"], newValue: "New summary." },
    ]);
    expect(outcome.ok).toBe(true);
  });

  test("ignores a status patch on an unresolvable slug (not this gate's concern)", () => {
    const doc = makeInitiatives();
    const outcome = checkStatusEnumForPatches("initiatives", doc, [
      { fieldPath: ["projects", "does-not-exist", "status"], newValue: "bogus" },
    ]);
    expect(outcome.ok).toBe(true);
  });

  test("checks the POST-mutation value for an appendText op, not the raw patch", () => {
    // The gate reads status off the ALREADY-MUTATED snapshot — an appendText
    // op onto "in-progress" (valid) that produced "in-progressXYZ" (invalid)
    // is caught via the mutated value, no appendText special-casing needed.
    const doc = makeInitiatives({ status: "in-progressXYZ" });
    const patch: FieldPatch = {
      fieldPath: ["projects", "3-project", "status"],
      appendText: "XYZ",
    };
    const outcome = checkStatusEnumForPatches("initiatives", doc, [patch]);
    expect(outcome.ok).toBe(false);
  });

  test("multiple patches in one batch — first invalid one short-circuits", () => {
    const doc = makeInitiatives({ status: "idea" }, { status: "bogus-initiative-status" });
    const outcome = checkStatusEnumForPatches("initiatives", doc, [
      { fieldPath: ["projects", "3-project", "status"], newValue: "idea" },
      { fieldPath: ["initiatives", "3", "status"], newValue: "bogus-initiative-status" },
    ]);
    expect(outcome.ok).toBe(false);
  });
});

// ── checkStatusEnumForCreate ─────────────────────────────────────────────────

describe("checkStatusEnumForCreate", () => {
  test("no-op for non-project createKinds", () => {
    for (const kind of ["subtask", "task", "item", "retro"] as const) {
      const outcome = checkStatusEnumForCreate(kind, { status: "not-a-real-status" });
      expect(outcome.ok).toBe(true);
    }
  });

  test("accepts a valid project create status", () => {
    const outcome = checkStatusEnumForCreate("project", {
      id: "new-project",
      status: "idea",
    });
    expect(outcome.ok).toBe(true);
  });

  test("rejects an out-of-enum project create status", () => {
    const outcome = checkStatusEnumForCreate("project", {
      id: "new-project",
      status: "bogus-status",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe("invalid-status");
      expect(outcome.detail).toContain("bogus-status");
    }
  });
});
