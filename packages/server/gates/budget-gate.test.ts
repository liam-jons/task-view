/**
 * Tests for gates/budget-gate — ID-90 U2 (PRODUCT invariants 24–27).
 *
 * Port-parity coverage moved upstream from KH `ledger-cli-budget.test.ts`
 * (TECH §Testing: "Coverage moves upstream (U11)"), adapted to the server
 * hook shape: post-mutation / pre-serialisation, with `force` arriving as
 * an options param (the request-body field lands in record 12 / U10).
 *
 * Synthetic fixtures only (AC-I) — no client-name tokens anywhere.
 */
import { describe, expect, test } from "bun:test";

import {
  graphemeLength,
  checkBudget,
  checkBudgetForPatches,
  checkBudgetForCreate,
  type BudgetGate,
} from "./budget-gate";
import type { TaskList, Task } from "@task-view/schemas/task-list";
import type { Roadmap } from "@task-view/schemas/roadmap";
import type { BacklogDocument } from "@task-view/schemas/backlog";

// ── Fixtures (synthetic) ─────────────────────────────────────────────────────

/** Budgets under test (from the U0 registry): task.description 1500,
 * task.status_note 300, subtask.description 250, subtask.testStrategy 300,
 * theme.description 1500, theme.notes 300, item.title 80, item.description 500. */

function makeTask(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "7",
    title: "Synthetic task seven",
    description: "Short description.",
    status: "pending",
    priority: "should",
    dependencies: [],
    subtasks: [
      {
        id: "1",
        title: "Synthetic subtask one",
        description: "Short subtask description.",
        details: "Initial details.",
        status: "pending",
        dependencies: [],
        testStrategy: "Short strategy.",
      },
    ],
    updatedAt: "2026-06-01T00:00:00.000Z",
    effort_estimate: null,
    owner: null,
    priority_note: null,
    status_note: null,
    cross_doc_links: [],
    session_refs: [],
    commit_refs: [],
    ...overrides,
  };
}

function makeTaskList(taskOverrides: Partial<Record<string, unknown>> = {}): TaskList {
  return {
    document_name: "Knowledge Hub Task List",
    document_purpose: "Synthetic test ledger.",
    related_documents: [],
    tasks: [makeTask(taskOverrides) as unknown as Task],
  } as unknown as TaskList;
}

function makeRoadmap(themeOverrides: Partial<Record<string, unknown>> = {}): Roadmap {
  return {
    document_name: "Knowledge Hub Roadmap",
    document_purpose: "Synthetic test roadmap.",
    themes: [
      {
        id: "3",
        title: "Synthetic theme",
        status: "now",
        description: "Short theme description.",
        notes: null,
        linked_tasks: [],
        linked_backlog: [],
        ...themeOverrides,
      },
    ],
  } as unknown as Roadmap;
}

function makeBacklog(itemOverrides: Partial<Record<string, unknown>> = {}): BacklogDocument {
  return {
    document_name: "Product Backlog",
    document_purpose: "Synthetic test backlog.",
    items: [
      {
        id: "100",
        title: "Synthetic backlog item",
        track: "platform",
        priority: "should",
        status: "proposed",
        description: "Short item description.",
        ...itemOverrides,
      },
    ],
  } as unknown as BacklogDocument;
}

const OVER_250 = "x".repeat(260);
const OVER_300 = "y".repeat(310);
const OVER_1500 = "z".repeat(1510);

// ── graphemeLength (invariant 24: Intl.Segmenter semantics) ─────────────────

describe("graphemeLength", () => {
  test("matches Intl.Segmenter for plain ASCII", () => {
    expect(graphemeLength("abc def")).toBe(7);
  });

  test("counts a surrogate-pair emoji as ONE grapheme (not 2 code units)", () => {
    const dart = "\u{1F3AF}"; // 🎯 — 2 UTF-16 code units, 1 grapheme
    expect(dart.length).toBe(2);
    expect(graphemeLength(dart)).toBe(1);
  });

  test("counts a ZWJ family emoji as ONE grapheme", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}";
    expect(family.length).toBeGreaterThan(1);
    expect(graphemeLength(family)).toBe(1);
  });

  test("agrees with a reference Intl.Segmenter instance on mixed text", () => {
    const sample = "plan \u{1F3AF} → §ship";
    const reference = [
      ...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(sample),
    ].length;
    expect(graphemeLength(sample)).toBe(reference);
  });
});

// ── checkBudget (faithful port of the CLI gate core) ─────────────────────────

describe("checkBudget — create mode (mutatedField undefined)", () => {
  test("first over-budget field is fatal with the (over by N) detail", () => {
    const gate: BudgetGate = {
      recordKind: "subtask",
      recordId: 6,
      parentId: "49",
      record: { description: OVER_250, testStrategy: "ok" },
    };
    const result = checkBudget(gate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The measured prefix (length + budget + over-by + subject) is unchanged.
      expect(result.detail).toContain(
        "description is 260 chars (budget 250, over by 10) on subtask 49.6",
      );
      expect(result.warnings).toEqual([]);
    }
  });

  // ── ID-90 F5/Bug1: budget-exceeded message carries a remedy clause ──────────
  test("subtask rejection suggests moving overflow into `details` + --force", () => {
    const result = checkBudget({
      recordKind: "subtask",
      recordId: 6,
      parentId: "49",
      record: { description: OVER_250, testStrategy: "ok" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toContain("trim it to 250 chars");
      expect(result.detail).toContain("`details` field");
      expect(result.detail).toContain("--force");
    }
  });

  test("non-subtask rejection suggests trim + --force (no `details` advice)", () => {
    // `task`/`theme`/`item` have no unbudgeted `details` journal home, so the
    // remedy advises trimming + --force only — never the subtask-only clause.
    const result = checkBudget({
      recordKind: "task",
      recordId: "7",
      record: { description: "x".repeat(1501) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toContain("trim it to 1500 chars");
      expect(result.detail).toContain("--force");
      expect(result.detail).not.toContain("`details` field");
    }
  });

  test("under-budget record passes with no warnings", () => {
    const result = checkBudget({
      recordKind: "task",
      recordId: "7",
      record: { description: "fine", status_note: "also fine" },
    });
    expect(result).toEqual({ ok: true, warnings: [] });
  });

  test("subtask.details is exempt — absent from the registry (invariant 27)", () => {
    const result = checkBudget({
      recordKind: "subtask",
      recordId: 1,
      parentId: "7",
      record: { description: "ok", details: "d".repeat(50_000) },
    });
    expect(result).toEqual({ ok: true, warnings: [] });
  });

  test("non-string field values are skipped", () => {
    const result = checkBudget({
      recordKind: "task",
      recordId: "7",
      record: { description: 12345, status_note: null },
    });
    expect(result).toEqual({ ok: true, warnings: [] });
  });

  test("budget is measured in graphemes, not UTF-16 code units", () => {
    // 250 dart emojis = 500 code units but exactly 250 graphemes → under budget.
    const darts = "\u{1F3AF}".repeat(250);
    const result = checkBudget({
      recordKind: "subtask",
      recordId: 2,
      parentId: "7",
      record: { description: darts },
    });
    expect(result).toEqual({ ok: true, warnings: [] });
  });
});

describe("checkBudget — field-update mode (mutatedField set)", () => {
  test("over-budget MUTATED field rejects", () => {
    const result = checkBudget({
      recordKind: "task",
      recordId: "7",
      record: { description: OVER_1500, status_note: "ok" },
      mutatedField: "description",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toContain("description is 1510 chars (budget 1500, over by 10)");
      expect(result.detail).toContain("on task 7");
    }
  });

  test("over-budget UNTOUCHED field soft-warns, write proceeds", () => {
    const result = checkBudget({
      recordKind: "task",
      recordId: "7",
      record: { description: OVER_1500, status_note: "short" },
      mutatedField: "status_note",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toStartWith("budget (untouched): description is 1510 chars");
    }
  });

  // KH port (ID-90.13 U11): ledger-cli-budget.test.ts ID-35.27 #6 — the
  // UNTOUCHED-field warning is ALSO subject-discriminated (the dotted
  // `subtask <taskId>.<subId>` label, never `task <subId>`).
  test("untouched-field warning on a SUBTASK is subject-discriminated (ID-35.27 port)", () => {
    const result = checkBudget({
      recordKind: "subtask",
      recordId: 6,
      parentId: "49",
      record: { description: OVER_250, testStrategy: "short" },
      mutatedField: "testStrategy",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("on subtask 49.6");
      expect(result.warnings[0]).not.toContain("task 6");
    }
  });

  test("rejection carries the untouched warnings alongside", () => {
    const result = checkBudget({
      recordKind: "task",
      recordId: "7",
      record: { description: OVER_1500, status_note: OVER_300 },
      mutatedField: "status_note",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toContain("status_note is 310 chars");
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("description is 1510 chars");
    }
  });
});

// ── checkBudgetForPatches (server PATCH hook: post-mutation snapshot) ────────

describe("checkBudgetForPatches", () => {
  test("over-budget patched task field → budget-exceeded rejection", () => {
    const snapshot = makeTaskList({ description: OVER_1500 });
    const outcome = checkBudgetForPatches(
      "task-list",
      snapshot,
      [{ fieldPath: ["tasks", "7", "description"], newValue: OVER_1500 }],
      { force: false },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe("budget-exceeded");
      expect(outcome.detail).toContain("description is 1510 chars (budget 1500, over by 10) on task 7");
    }
  });

  test("force downgrades the rejection to a '(forced) budget-exceeded:' warning", () => {
    const snapshot = makeTaskList({ description: OVER_1500 });
    const outcome = checkBudgetForPatches(
      "task-list",
      snapshot,
      [{ fieldPath: ["tasks", "7", "description"], newValue: OVER_1500 }],
      { force: true },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.warnings).toHaveLength(1);
      expect(outcome.warnings[0]).toStartWith("(forced) budget-exceeded: description is 1510 chars");
    }
  });

  test("subtask.details patch of any length is exempt (invariant 27)", () => {
    const snapshot = makeTaskList();
    (snapshot.tasks[0].subtasks[0] as Record<string, unknown>).details = "j".repeat(80_000);
    const outcome = checkBudgetForPatches(
      "task-list",
      snapshot,
      [
        {
          fieldPath: ["tasks", "7", "subtasks", "1", "details"],
          newValue: "j".repeat(80_000),
        },
      ],
      { force: false },
    );
    expect(outcome).toEqual({ ok: true, warnings: [] });
  });

  test("over-budget patched SUBTASK field rejects with the subtask label", () => {
    const snapshot = makeTaskList();
    (snapshot.tasks[0].subtasks[0] as Record<string, unknown>).description = OVER_250;
    const outcome = checkBudgetForPatches(
      "task-list",
      snapshot,
      [{ fieldPath: ["tasks", "7", "subtasks", "1", "description"], newValue: OVER_250 }],
      { force: false },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.detail).toContain("on subtask 7.1");
    }
  });

  test("untouched over-budget field on the patched record soft-warns", () => {
    const snapshot = makeTaskList({ description: OVER_1500, status_note: "fresh note" });
    const outcome = checkBudgetForPatches(
      "task-list",
      snapshot,
      [{ fieldPath: ["tasks", "7", "status_note"], newValue: "fresh note" }],
      { force: false },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.warnings).toHaveLength(1);
      expect(outcome.warnings[0]).toStartWith("budget (untouched): description is 1510 chars");
    }
  });

  test("multi-patch: a field mutated by a SIBLING patch is not double-reported as untouched", () => {
    const snapshot = makeTaskList({ description: OVER_1500, status_note: OVER_300 });
    const outcome = checkBudgetForPatches(
      "task-list",
      snapshot,
      [
        { fieldPath: ["tasks", "7", "description"], newValue: OVER_1500 },
        { fieldPath: ["tasks", "7", "status_note"], newValue: OVER_300 },
      ],
      { force: false },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe("budget-exceeded");
      // Both fields were mutated → both are hard violations; NEITHER appears
      // as a 'budget (untouched)' warning.
      expect(outcome.warnings.filter((w) => w.includes("untouched"))).toEqual([]);
    }
  });

  test("roadmap theme notes over budget rejects with the theme label", () => {
    const snapshot = makeRoadmap({ notes: OVER_300 });
    const outcome = checkBudgetForPatches(
      "roadmap",
      snapshot,
      [{ fieldPath: ["themes", "3", "notes"], newValue: OVER_300 }],
      { force: false },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.detail).toContain("on theme 3");
  });

  test("backlog item title over budget rejects with the item label", () => {
    const longTitle = "t".repeat(90);
    const snapshot = makeBacklog({ title: longTitle });
    const outcome = checkBudgetForPatches(
      "backlog",
      snapshot,
      [{ fieldPath: ["items", "100", "title"], newValue: longTitle }],
      { force: false },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.detail).toContain("title is 90 chars (budget 80, over by 10) on item 100");
    }
  });

  test("patch addressing an unbudgeted field passes clean", () => {
    const snapshot = makeTaskList({ status: "in_progress" });
    const outcome = checkBudgetForPatches(
      "task-list",
      snapshot,
      [{ fieldPath: ["tasks", "7", "status"], newValue: "in_progress" }],
      { force: false },
    );
    expect(outcome).toEqual({ ok: true, warnings: [] });
  });
});

// ── checkBudgetForCreate (server POST / promote-task-leg hook) ───────────────

describe("checkBudgetForCreate", () => {
  test("over-budget create rejects on the first over-budget field (create mode)", () => {
    const outcome = checkBudgetForCreate(
      "task",
      { id: "42", description: OVER_1500, status_note: OVER_300 },
      { force: false },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe("budget-exceeded");
      expect(outcome.detail).toContain("description is 1510 chars");
      expect(outcome.detail).toContain("on task 42");
    }
  });

  test("force downgrades a create rejection to a '(forced) budget-exceeded:' warning", () => {
    const outcome = checkBudgetForCreate(
      "item",
      { id: "101", title: "t".repeat(90), description: "ok" },
      { force: true },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.warnings).toHaveLength(1);
      expect(outcome.warnings[0]).toStartWith("(forced) budget-exceeded: title is 90 chars");
    }
  });

  test("under-budget create passes clean", () => {
    const outcome = checkBudgetForCreate(
      "theme",
      { id: "9", description: "fine", notes: "fine" },
      { force: false },
    );
    expect(outcome).toEqual({ ok: true, warnings: [] });
  });

  // KH ports (ID-90.13 U11): ledger-cli-budget.test.ts ID-35.27 — the
  // budget-exceeded SUBJECT is recordKind-discriminated on every create
  // surface (`theme <id>` / `item <id>`, matching the task/subtask labels
  // asserted above).
  test("over-budget theme create detail reads `theme <id>` (ID-35.27 port)", () => {
    const outcome = checkBudgetForCreate(
      "theme",
      { id: "9", description: "fine", notes: "n".repeat(310) },
      { force: false },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe("budget-exceeded");
      expect(outcome.detail).toContain("notes is 310 chars");
      expect(outcome.detail).toContain("on theme 9");
    }
  });

  test("over-budget item create detail reads `item <id>` (ID-35.27 port)", () => {
    const outcome = checkBudgetForCreate(
      "item",
      { id: "101", title: "t".repeat(90), description: "ok" },
      { force: false },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.detail).toContain("title is 90 chars");
      expect(outcome.detail).toContain("on item 101");
    }
  });
});

// ── Multi-violation enumeration (ID-90.12 U10 — check-90-7 annotation) ───────
//
// Multi-patch rejections previously reported only the FIRST over-budget
// mutated field; subsequent mutated violations were silently dropped from the
// detail string. U10 enumerates ALL of them so the operator can fix every
// field in one pass.

describe("multi-violation enumeration (ID-90.12 U10)", () => {
  test("two over-budget mutated fields on ONE record both appear in the detail", () => {
    const snapshot = makeTaskList({
      description: OVER_1500,
      status_note: OVER_300,
    });
    const outcome = checkBudgetForPatches("task-list", snapshot, [
      { fieldPath: ["tasks", "7", "description"], newValue: OVER_1500 },
      { fieldPath: ["tasks", "7", "status_note"], newValue: OVER_300 },
    ]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe("budget-exceeded");
      expect(outcome.detail).toContain(
        "description is 1510 chars (budget 1500, over by 10) on task 7",
      );
      expect(outcome.detail).toContain(
        "status_note is 310 chars (budget 300, over by 10) on task 7",
      );
    }
  });

  test("over-budget mutated fields on DIFFERENT records in one batch are all enumerated", () => {
    const snapshot = makeTaskList({ description: OVER_1500 });
    (
      (snapshot.tasks[0] as unknown as Record<string, unknown>)
        .subtasks as Array<Record<string, unknown>>
    )[0].description = OVER_250;
    const outcome = checkBudgetForPatches("task-list", snapshot, [
      { fieldPath: ["tasks", "7", "description"], newValue: OVER_1500 },
      {
        fieldPath: ["tasks", "7", "subtasks", "1", "description"],
        newValue: OVER_250,
      },
    ]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.detail).toContain("on task 7");
      expect(outcome.detail).toContain("on subtask 7.1");
    }
  });

  test("single-violation detail keeps the exact pre-U10 single-line shape", () => {
    const snapshot = makeTaskList({ description: OVER_1500 });
    const outcome = checkBudgetForPatches("task-list", snapshot, [
      { fieldPath: ["tasks", "7", "description"], newValue: OVER_1500 },
    ]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // Single measured violation — exactly ONE line (no `; ` join). The
      // measured prefix is unchanged; the Bug1 remedy clause is appended after.
      expect(outcome.detail).toContain(
        "description is 1510 chars (budget 1500, over by 10) on task 7",
      );
      expect(outcome.detail).not.toContain("; ");
    }
  });
});
