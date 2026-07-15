/**
 * ledger-budgets registry acceptance (ID-90 U0).
 *
 * The relocated registry twin must stay PLAIN DATA — never a Zod `.max()`
 * constraint (ID-90 PRODUCT invariants 24 + 59). These tests gate:
 *   1. the registry numbers match the KH canonical seed values;
 *   2. FIELD_BUDGETS is derived from LEDGER_BUDGETS (can never drift);
 *   3. the module source contains no Zod usage at all — no import, no
 *      `.max(` constraint — so the live over-budget ledgers keep parsing.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LEDGER_BUDGETS,
  FIELD_BUDGETS,
  DISCIPLINE_DOC,
} from "./ledger-budgets";

describe("ledger-budgets registry (ID-90 U0, invariants 24/59)", () => {
  test("LEDGER_BUDGETS carries the canonical per-record-kind numbers", () => {
    expect(LEDGER_BUDGETS.task).toEqual({ description: 1500, status_note: 300 });
    expect(LEDGER_BUDGETS.subtask).toEqual({ description: 250, testStrategy: 300 });
    expect(LEDGER_BUDGETS.project).toEqual({ summary: 500, description: 1500 });
    expect(LEDGER_BUDGETS.initiative).toEqual({ description: 1500 });
    expect(LEDGER_BUDGETS.item).toEqual({ title: 80, description: 500 });
  });

  test("subtask.details is intentionally NOT budgeted (append-only journal home)", () => {
    expect("details" in LEDGER_BUDGETS.subtask).toBe(false);
  });

  test("FIELD_BUDGETS is derived from LEDGER_BUDGETS (back-compat task-list constant)", () => {
    expect(FIELD_BUDGETS).toEqual({
      taskDescription: LEDGER_BUDGETS.task.description,
      taskStatusNote: LEDGER_BUDGETS.task.status_note,
      subtaskDescription: LEDGER_BUDGETS.subtask.description,
      subtaskTestStrategy: LEDGER_BUDGETS.subtask.testStrategy,
    });
  });

  test("DISCIPLINE_DOC points at the field-discipline doc", () => {
    expect(DISCIPLINE_DOC).toBe("docs/reference/task-list-discipline.md");
  });

  test("module is plain data: no Zod import, no .max() constraint in source", () => {
    const source = readFileSync(
      join(import.meta.dir, "ledger-budgets.ts"),
      "utf8",
    );
    // Strip comments before scanning — the header documents the `.max()`
    // mandate in prose, which must not trip the code-level assertion.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(code).not.toContain("zod");
    expect(code).not.toContain(".max(");
    expect(code).not.toContain("z.");
  });
});
