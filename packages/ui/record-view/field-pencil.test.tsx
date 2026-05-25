/**
 * field-pencil.test.tsx — ID-20.25 SSR affordance primitive.
 *
 * `FieldPencil` is the SSR-emitted pencil the per-record views attach to
 * each editable field. It carries the full hook set the 20.24+20.25
 * dispatcher keys on:
 *   - data-edit-action="open"
 *   - data-edit-field=<fieldPath joined by ">">
 *   - data-edit-kind=<DispatchKind>
 *   - data-edit-options="a,b,c"   (enum / enum-nullable only)
 *   - data-edit-raw-value="<raw>" (textarea raw-source fields only)
 *
 * The dispatcher builds the editor on click; the SSR only needs the
 * pencil + hooks beside the rendered value.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FieldPencil } from "./field-pencil";

describe("FieldPencil — base hooks (PRODUCT inv 26)", () => {
  test("emits open action, joined field path, kind, and an aria-label", () => {
    const html = renderToStaticMarkup(
      <FieldPencil
        fieldPath={["tasks", "20", "owner"]}
        kind="text"
        ariaLabel="Edit owner"
      />,
    );
    expect(html).toContain('data-edit-action="open"');
    expect(html).toContain('data-edit-field="tasks&gt;20&gt;owner"');
    expect(html).toContain('data-edit-kind="text"');
    expect(html).toContain('aria-label="Edit owner"');
    expect(html).toContain("✎");
    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
  });

  test("does NOT emit data-edit-options / data-edit-raw-value when not supplied", () => {
    const html = renderToStaticMarkup(
      <FieldPencil
        fieldPath={["tasks", "20", "owner"]}
        kind="text"
        ariaLabel="Edit owner"
      />,
    );
    expect(html).not.toContain("data-edit-options");
    expect(html).not.toContain("data-edit-raw-value");
  });
});

describe("FieldPencil — enum options (PRODUCT inv 31-32)", () => {
  test("enum kind emits data-edit-options from the supplied literals", () => {
    const html = renderToStaticMarkup(
      <FieldPencil
        fieldPath={["tasks", "20", "status"]}
        kind="enum"
        options={["done", "pending", "in_progress"]}
        ariaLabel="Edit status"
      />,
    );
    expect(html).toContain('data-edit-kind="enum"');
    expect(html).toContain('data-edit-options="done,pending,in_progress"');
  });

  test("enum-nullable kind carries the enum-nullable kind hook", () => {
    const html = renderToStaticMarkup(
      <FieldPencil
        fieldPath={["themes", "3", "status"]}
        kind="enum-nullable"
        options={["pending", "in_progress", "done"]}
        ariaLabel="Edit status"
      />,
    );
    expect(html).toContain('data-edit-kind="enum-nullable"');
    expect(html).toContain('data-edit-options="pending,in_progress,done"');
  });
});

describe("FieldPencil — raw-value passthrough (PRODUCT inv 27-28)", () => {
  test("textarea raw source is carried verbatim incl. journal blocks", () => {
    const raw = "Line one\n\n<info added on 2026-05-25>\njournal\n</info added on 2026-05-25>";
    const html = renderToStaticMarkup(
      <FieldPencil
        fieldPath={["tasks", "20", "subtasks", "4", "details"]}
        kind="textarea"
        rawValue={raw}
        ariaLabel="Edit details"
      />,
    );
    expect(html).toContain("data-edit-raw-value=");
    // The journal block is preserved (HTML-escaped by React).
    expect(html).toContain("info added on 2026-05-25");
    expect(html).toContain(
      'data-edit-field="tasks&gt;20&gt;subtasks&gt;4&gt;details"',
    );
  });
});
