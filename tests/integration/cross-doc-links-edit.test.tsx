/**
 * tests/integration/cross-doc-links-edit.test.tsx — PRODUCT inv 35
 * (`cross_doc_links[]` per-entry form: add row / edit existing / delete
 * row; saves persist as DocLinkSchema[]).
 *
 * Acceptance:
 *   - Existing entries render one form-row per entry with `path`,
 *     `anchor`, `raw` text inputs + a Delete button.
 *   - "Add link" button present at the bottom.
 *   - Each row carries a stable `data-doclink-row-index` so the SPA
 *     can reconstruct the array on save.
 *   - FieldPatch round-trip of the DocLink array passes Zod
 *     DocLinkSchema[] validation; anchor:null preserved.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { z } from "zod";
import { DocLinkPerEntryForm } from "../../packages/ui/record-view/edit-affordances";
import { buildFieldPatch } from "../../packages/ui/record-view/edit-state";

// We import the schema by its canonical path within the vendored
// schemas package. DocLinkSchema lives in roadmap-schema.ts but is
// re-used across all three ledgers.
import { DocLinkSchema } from "@task-view/schemas/roadmap";

const SAMPLE_DOC_LINKS = [
  {
    path: "docs/specs/per-task-mirror/PRODUCT.md",
    anchor: "§3.2 invariant 4",
    raw: "PRODUCT.md §3.2 inv 4",
  },
  {
    path: "docs/runbooks/staging-refresh.md",
    anchor: null,
    raw: "staging-refresh runbook",
  },
];

describe("DocLink per-entry form rendering (PRODUCT inv 35)", () => {
  test("renders one form-row per entry with 3 inputs + delete button", () => {
    const html = renderToStaticMarkup(
      <DocLinkPerEntryForm
        fieldPath={["tasks", "20", "cross_doc_links"]}
        draft={SAMPLE_DOC_LINKS}
      />,
    );
    // Both rows present
    expect(html).toContain('data-doclink-row-index="0"');
    expect(html).toContain('data-doclink-row-index="1"');
    // Path inputs
    expect(html).toContain("docs/specs/per-task-mirror/PRODUCT.md");
    expect(html).toContain("docs/runbooks/staging-refresh.md");
    // Anchor inputs (first non-null, second null → empty)
    expect(html).toContain("§3.2 invariant 4");
    // Raw inputs
    expect(html).toContain("PRODUCT.md §3.2 inv 4");
    expect(html).toContain("staging-refresh runbook");
    // Delete buttons (one per row)
    const deleteCount = (html.match(/data-doclink-action="delete"/g) ?? [])
      .length;
    expect(deleteCount).toBe(2);
  });

  test('"Add link" button present at the bottom', () => {
    const html = renderToStaticMarkup(
      <DocLinkPerEntryForm
        fieldPath={["tasks", "20", "cross_doc_links"]}
        draft={SAMPLE_DOC_LINKS}
      />,
    );
    expect(html).toContain('data-doclink-action="add"');
    expect(html).toContain("Add link");
  });

  test("empty draft renders form with no rows + Add link still works", () => {
    const html = renderToStaticMarkup(
      <DocLinkPerEntryForm
        fieldPath={["tasks", "20", "cross_doc_links"]}
        draft={[]}
      />,
    );
    expect(html).not.toContain('data-doclink-row-index="0"');
    expect(html).toContain('data-doclink-action="add"');
  });

  test("anchor=null renders as empty <input> (SPA serialises empty → null on save)", () => {
    const html = renderToStaticMarkup(
      <DocLinkPerEntryForm
        fieldPath={["tasks", "20", "cross_doc_links"]}
        draft={[
          {
            path: "docs/foo.md",
            anchor: null,
            raw: "foo",
          },
        ]}
      />,
    );
    // Anchor input present but value is "" (not the literal "null")
    expect(html).toMatch(/data-doclink-field="anchor"[^>]*value=""/);
    expect(html).not.toContain('value="null"');
  });

  test("Save + Cancel controls present on the form", () => {
    const html = renderToStaticMarkup(
      <DocLinkPerEntryForm
        fieldPath={["tasks", "20", "cross_doc_links"]}
        draft={SAMPLE_DOC_LINKS}
      />,
    );
    expect(html).toContain('data-edit-action="save"');
    expect(html).toContain('data-edit-action="cancel"');
  });
});

describe("DocLink array round-trip (PRODUCT inv 35 — persists as DocLinkSchema[])", () => {
  test("Zod accepts the canonical array shape", () => {
    const result = z.array(DocLinkSchema).safeParse(SAMPLE_DOC_LINKS);
    expect(result.success).toBe(true);
  });

  test("FieldPatch round-trip preserves the array verbatim", () => {
    const patch = buildFieldPatch(
      ["tasks", "20", "cross_doc_links"],
      SAMPLE_DOC_LINKS,
    );
    expect(patch.newValue).toEqual(SAMPLE_DOC_LINKS);
  });

  test("simulated add-row: array grows by one entry, schema still valid", () => {
    const added = [
      ...SAMPLE_DOC_LINKS,
      {
        path: "docs/new-link.md",
        anchor: null,
        raw: "new link",
      },
    ];
    const result = z.array(DocLinkSchema).safeParse(added);
    expect(result.success).toBe(true);
    expect(added).toHaveLength(3);
  });

  test("simulated delete-row: array shrinks, schema still valid", () => {
    const deleted = SAMPLE_DOC_LINKS.slice(1); // drop first entry
    const result = z.array(DocLinkSchema).safeParse(deleted);
    expect(result.success).toBe(true);
    expect(deleted).toHaveLength(1);
    expect(deleted[0].path).toBe("docs/runbooks/staging-refresh.md");
  });

  test("simulated edit-existing: path mutated, schema still valid", () => {
    const edited = [
      { ...SAMPLE_DOC_LINKS[0], path: "docs/specs/updated-path.md" },
      SAMPLE_DOC_LINKS[1],
    ];
    const result = z.array(DocLinkSchema).safeParse(edited);
    expect(result.success).toBe(true);
    expect(edited[0].path).toBe("docs/specs/updated-path.md");
  });

  test("empty path rejected by DocLinkSchema (z.string().min(1))", () => {
    const bad = [
      {
        path: "", // invalid
        anchor: null,
        raw: "x",
      },
    ];
    const result = z.array(DocLinkSchema).safeParse(bad);
    expect(result.success).toBe(false);
  });
});
