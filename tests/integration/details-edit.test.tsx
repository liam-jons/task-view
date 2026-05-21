/**
 * tests/integration/details-edit.test.tsx — PRODUCT inv 28
 * (Subtask.details + BacklogItem.details edit preserves journal blocks
 * verbatim; no auto-injection on save).
 *
 * Acceptance:
 *   - Subtask.details textarea shows the FULL raw string including
 *     `<info added on ...>` journal blocks (no edit gating, no
 *     hidden re-formatting).
 *   - Save does NOT auto-inject a new journal block (the editor is
 *     a plain text edit surface; workflow agents add journal blocks
 *     via their own write paths).
 *   - The FieldPatch round-trip preserves the journal content
 *     byte-identical.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TextareaField } from "../../packages/ui/record-view/edit-affordances";
import {
  buildFieldPatch,
} from "../../packages/ui/record-view/edit-state";

const SAMPLE_DETAILS_WITH_JOURNAL = `Initial prose summarising the Subtask.

Implementation steps:
1. First step.
2. Second step.

<info added on 2026-05-21T10:00:00.000Z>
Shipped: first slice landed.
Commit: abc1234
</info added on 2026-05-21T10:00:00.000Z>

<info added on 2026-05-22T14:00:00.000Z>
Shipped: second slice + tests.
Commit: def5678
</info added on 2026-05-22T14:00:00.000Z>`;

describe("Subtask.details edit (PRODUCT inv 28)", () => {
  test("textarea preserves journal blocks verbatim in the rendered defaultValue", () => {
    const html = renderToStaticMarkup(
      <TextareaField
        fieldPath={["tasks", "20", "subtasks", "10", "details"]}
        draft={SAMPLE_DETAILS_WITH_JOURNAL}
      />,
    );
    // React SSR escapes `<` to &lt; in attribute / text — we verify the
    // ESCAPED form is present (i.e. the raw text really did make it
    // into the rendered DOM without being stripped or re-interpreted).
    expect(html).toContain("&lt;info added on 2026-05-21T10:00:00.000Z&gt;");
    expect(html).toContain("&lt;/info added on 2026-05-21T10:00:00.000Z&gt;");
    expect(html).toContain("&lt;info added on 2026-05-22T14:00:00.000Z&gt;");
    expect(html).toContain("Shipped: first slice landed.");
    expect(html).toContain("Commit: abc1234");
    expect(html).toContain("Shipped: second slice + tests.");
    expect(html).toContain("Commit: def5678");
    expect(html).toContain("Initial prose summarising the Subtask.");
  });

  test("no edit gating: textarea has no readonly or disabled attribute", () => {
    const html = renderToStaticMarkup(
      <TextareaField
        fieldPath={["tasks", "20", "subtasks", "10", "details"]}
        draft={SAMPLE_DETAILS_WITH_JOURNAL}
      />,
    );
    expect(html).not.toContain("readonly");
    expect(html).not.toContain("disabled");
  });

  test("FieldPatch round-trip preserves journal blocks byte-identical (no auto-injection)", () => {
    // The user edits the textarea; Save fires; SPA reads the textarea
    // value verbatim and constructs the patch. NO journal-block
    // injection happens in this path — that's exclusively workflow-
    // agent territory.
    const patch = buildFieldPatch(
      ["tasks", "20", "subtasks", "10", "details"],
      SAMPLE_DETAILS_WITH_JOURNAL,
    );
    expect(patch.newValue).toBe(SAMPLE_DETAILS_WITH_JOURNAL);
    // Byte-identical: no trailing-newline normalisation, no journal
    // block appended.
    expect((patch.newValue as string).length).toBe(
      SAMPLE_DETAILS_WITH_JOURNAL.length,
    );
  });

  test("user-edited content (moved / deleted journal block) round-trips unchanged", () => {
    // Per inv 28: "Liam may freely move or delete journal blocks."
    // Simulate the user deleting the first journal block.
    const userEdit = `Initial prose summarising the Subtask.

Implementation steps:
1. First step.
2. Second step.

<info added on 2026-05-22T14:00:00.000Z>
Shipped: second slice + tests.
Commit: def5678
</info added on 2026-05-22T14:00:00.000Z>`;
    const patch = buildFieldPatch(
      ["tasks", "20", "subtasks", "10", "details"],
      userEdit,
    );
    expect(patch.newValue).toBe(userEdit);
    // Crucially: the FIRST journal block (2026-05-21) is GONE from
    // the patch — the editor did not "restore" it.
    expect((patch.newValue as string)).not.toContain(
      "2026-05-21T10:00:00.000Z",
    );
  });

  test("editor never silently appends a new journal block on save", () => {
    // The FieldPatch.newValue equals the textarea content verbatim.
    // If the editor were auto-injecting `<info added on NOW>`, the
    // patch payload would be longer than the input.
    const patch = buildFieldPatch(
      ["tasks", "20", "subtasks", "10", "details"],
      "Just plain prose, no journal blocks.",
    );
    expect(patch.newValue).toBe("Just plain prose, no journal blocks.");
    // Sentinel: the literal `<info added on` substring must NOT have
    // been injected by the editor.
    expect((patch.newValue as string)).not.toContain("<info added on");
  });
});

describe("BacklogItem.details edit (PRODUCT inv 28)", () => {
  test("same discipline as Subtask.details: preserves journal blocks verbatim", () => {
    const html = renderToStaticMarkup(
      <TextareaField
        fieldPath={["items", "ID-30", "details"]}
        draft={SAMPLE_DETAILS_WITH_JOURNAL}
      />,
    );
    expect(html).toContain("&lt;info added on 2026-05-21T10:00:00.000Z&gt;");
    expect(html).toContain("Commit: abc1234");
  });
});
