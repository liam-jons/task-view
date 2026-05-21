/**
 * tests/integration/no-transition-enforcement.test.tsx — PRODUCT inv 32
 * (Task.status pending → done direct flip succeeds; no client-side
 * state-machine enforcement).
 *
 * Acceptance: every valid enum value is presented as a selectable
 * option regardless of the current value. The example from inv 32: a
 * Task with `status: pending` may be flipped directly to `status: done`
 * via the dropdown even though workflow-orchestration discourages such
 * a jump.
 *
 * Proof: the dropdown options are sourced from `TaskListStatus.options`
 * verbatim (no filtering by current value). When `draft: pending`,
 * the rendered HTML still includes `<option value="done">`.
 *
 * The Zod-enum FieldPatch path also accepts pending → done without
 * intermediate validation — the server-side schema only checks the
 * enum membership, not the transition graph. Transition discipline
 * lives in workflow-orchestration, not the editor.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskListStatus } from "@task-view/schemas/task-list";
import { EnumDropdownField } from "../../packages/ui/record-view/edit-affordances";
import {
  buildFieldPatch,
  classifySaveResult,
} from "../../packages/ui/record-view/edit-state";

describe("PRODUCT inv 32 — no state-machine enforcement", () => {
  test("Task with status:pending shows 'done' as a selectable option", () => {
    const html = renderToStaticMarkup(
      <EnumDropdownField
        fieldPath={["tasks", "20", "status"]}
        draft="pending"
        options={TaskListStatus.options}
      />,
    );
    // 'done' is one of the 8 enum values
    expect(TaskListStatus.options).toContain("done");
    // The dropdown presents it even though current draft is 'pending'
    expect(html).toContain('value="done"');
  });

  test("Task with status:pending shows EVERY value (including 'cancelled', 'imp_deferred')", () => {
    const html = renderToStaticMarkup(
      <EnumDropdownField
        fieldPath={["tasks", "20", "status"]}
        draft="pending"
        options={TaskListStatus.options}
      />,
    );
    // No filtering — all 8 values present
    TaskListStatus.options.forEach((v) => {
      expect(html).toContain(`value="${v}"`);
    });
    expect((html.match(/<option /g) ?? []).length).toBe(8);
  });

  test("Task with status:done shows 'pending' as a selectable option (reverse direction)", () => {
    const html = renderToStaticMarkup(
      <EnumDropdownField
        fieldPath={["tasks", "20", "status"]}
        draft="done"
        options={TaskListStatus.options}
      />,
    );
    expect(html).toContain('value="pending"');
    // The reverse "regression" pending direction is equally permitted —
    // editor does not enforce direction.
  });

  test("FieldPatch shape for pending→done direct flip is valid wire format", () => {
    // Per inv 33: save discipline matches free-text — structured patch,
    // server validates against schema, atomic write.
    const patch = buildFieldPatch(["tasks", "20", "status"], "done");
    expect(patch).toEqual({
      fieldPath: ["tasks", "20", "status"],
      newValue: "done",
    });
    // No client-side rejection — the patch is constructed unconditionally.
  });

  test("server response for valid enum transition is classified as 'ok'", () => {
    // Simulate the server's response for a valid pending→done flip.
    // The server's only check is `schema.parse(canonical)` per TECH §5.2;
    // since 'done' is in TaskListStatus.options, the schema accepts.
    const ok = classifySaveResult({
      ok: true,
      newMtime: "2026-05-22T00:00:00Z",
    });
    expect(ok).toEqual({ kind: "ok" });
  });
});
