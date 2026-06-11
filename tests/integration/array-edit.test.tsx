/**
 * tests/integration/array-edit.test.tsx — PRODUCT inv 34
 * (cross-ref arrays render as comma-separated text input;
 * malformed entries rejected by Zod superRefine).
 *
 * Acceptance:
 *   - Array field surfaces as ArrayCommaField with comma-separated
 *     pre-populated draft.
 *   - parseCommaSeparatedIds trims whitespace + drops empty entries.
 *   - Subtask cross-Task dependency (cross-record, not sibling) is
 *     rejected by the Zod superRefine on the schema — the server
 *     returns a ZodError that the viewer surfaces inline.
 *
 * The superRefine lives in `task-list-schema.ts` (Subtask.dependencies
 * is `z.array(z.number().int())` with a parent-Task-level superRefine
 * that asserts every dependency id appears as a SIBLING Subtask id
 * within the same Task). We exercise the rejection by parsing a
 * canonical Task snapshot with a stray cross-Task dep + assert the
 * resulting ZodError surfaces an inline message.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { z } from "zod";
import {
  TaskListSchema,
} from "@task-view/schemas/task-list";
import { ArrayCommaField } from "../../packages/ui/record-view/edit-affordances";
import {
  buildArrayPatch,
  formatZodErrorInline,
  parseCommaSeparatedIds,
  parseCommaSeparatedNumbers,
} from "../../packages/ui/record-view/edit-state";

describe("Cross-ref array rendering (PRODUCT inv 34)", () => {
  test("Task.dependencies renders as comma-separated text input pre-populated", () => {
    const html = renderToStaticMarkup(
      <ArrayCommaField
        fieldPath={["tasks", "20", "dependencies"]}
        draft="19, 18, 17"
      />,
    );
    expect(html).toContain('value="19, 18, 17"');
    expect(html).toContain('data-edit-kind="array-comma"');
    expect(html).toContain("placeholder=");
  });

  test("Subtask.dependencies same shape (numeric ids visually)", () => {
    const html = renderToStaticMarkup(
      <ArrayCommaField
        fieldPath={["tasks", "20", "subtasks", "10", "dependencies"]}
        draft="1, 2"
      />,
    );
    expect(html).toContain('value="1, 2"');
    expect(html).toContain(
      'data-edit-field="tasks&gt;20&gt;subtasks&gt;10&gt;dependencies"',
    );
  });
});

describe("Array parsing (PRODUCT inv 34 — trim + drop empty)", () => {
  test("trims whitespace per element", () => {
    expect(parseCommaSeparatedIds("  19 ,  18 , 17  ")).toEqual([
      "19",
      "18",
      "17",
    ]);
  });

  test("drops empty entries (double comma + trailing comma)", () => {
    expect(parseCommaSeparatedIds("19,,18,")).toEqual(["19", "18"]);
  });

  test("Task.dependencies patch from comma-separated input", () => {
    const patch = buildArrayPatch(
      ["tasks", "20", "dependencies"],
      "19, 18, 17",
    );
    expect(patch.newValue).toEqual(["19", "18", "17"]);
  });
});

describe("Subtask cross-Task dependency rejection (PRODUCT inv 34 — schema superRefine)", () => {
  test("schema rejects Subtask whose dependency id is not a sibling", () => {
    // Build a snapshot where Subtask 1 references id 99 (no sibling
    // 99 exists in the same Task's subtasks[]). The schema's
    // superRefine should fire a ZodError.
    //
    // Note: the superRefine only fires AFTER all strict fields pass —
    // so the fixture must include every required field on Task +
    // Subtask. updatedAt is required on Task; effort_estimate / owner
    // / priority_note / status_note are nullable but must be present
    // (per the schema comment: "Required with explicit null").
    const badSnapshot = {
      document_name: "Knowledge Hub Task List",
      document_purpose: "fixture",
      last_updated: "2026-05-22",
      related_documents: [],
      tasks: [
        {
          id: "20",
          title: "T",
          description: "x",
          status: "in_progress",
          priority: "must",
          dependencies: [],
          cross_doc_links: [],
          session_refs: [],
          commit_refs: [],
          updatedAt: "2026-05-22T00:00:00Z",
          effort_estimate: null,
          owner: null,
          priority_note: null,
          status_note: null,
          subtasks: [
            {
              id: "1",
              title: "S1",
              description: "x",
              details: "x",
              status: "pending",
              dependencies: ["99"], // stray cross-Task ref — no sibling "99"
              testStrategy: "x",
            },
          ],
        },
      ],
    };
    const result = TaskListSchema.safeParse(badSnapshot);
    expect(result.success).toBe(false);
    if (!result.success) {
      // The superRefine surfaces an error mentioning the cross-sibling
      // violation. Find the issue with the "subtasks" path or the
      // sibling-violation message text.
      const issue = result.error.issues.find(
        (i) =>
          i.message.toLowerCase().includes("sibling") ||
          i.message.includes("99") ||
          i.path.includes("subtasks"),
      );
      expect(issue).toBeDefined();
      expect(issue?.message.toLowerCase()).toMatch(/sibling|99/);
    }
  });

  test("server-side rejection round-trips through the inline error helper", () => {
    // Simulate the server returning a ZodError; the SPA's
    // classifySaveResult routes it as schema-error; the helper
    // formats it for inline display per PRODUCT inv 29.
    const stubError = z
      .object({ x: z.number().int() })
      .safeParse({ x: "not-a-number" });
    expect(stubError.success).toBe(false);
    if (!stubError.success) {
      const msg = formatZodErrorInline(stubError.error);
      expect(msg).toContain("x:");
    }
  });

  test("comma-separated parse of NUMERIC dep ids", () => {
    // Subtask.dependencies is z.array(z.number().int()); the SPA
    // calls parseCommaSeparatedNumbers before patch construction.
    // Malformed (non-numeric) entries become NaN which the server's
    // schema rejects.
    expect(parseCommaSeparatedNumbers("1, 2, 3")).toEqual([1, 2, 3]);
    expect(parseCommaSeparatedNumbers("1, abc, 3")).toEqual([1, NaN, 3]);
  });
});
