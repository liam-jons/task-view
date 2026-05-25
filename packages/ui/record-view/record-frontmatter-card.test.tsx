/**
 * record-frontmatter-card.test.tsx — verifies the shared mode-agnostic
 * frontmatter table (TECH §4.1).
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RecordFrontmatterCard } from "./record-frontmatter-card";

describe("RecordFrontmatterCard", () => {
  test("renders each row as a <tr> with label + value", () => {
    const html = renderToStaticMarkup(
      <RecordFrontmatterCard
        rows={[
          { key: "status", label: "Status", value: "pending" },
          { key: "priority", label: "Priority", value: "must" },
        ]}
        ariaLabel="Task ID-20 metadata"
      />,
    );
    expect(html).toContain('aria-label="Task ID-20 metadata"');
    expect(html).toContain('data-frontmatter-row="status"');
    expect(html).toContain('data-frontmatter-row="priority"');
    expect(html).toContain(">Status<");
    expect(html).toContain(">pending<");
    expect(html).toContain(">Priority<");
    expect(html).toContain(">must<");
  });

  test("renders em-dash for null / empty values (PRODUCT inv 18)", () => {
    const html = renderToStaticMarkup(
      <RecordFrontmatterCard
        rows={[
          { key: "owner", label: "Owner", value: null },
          { key: "status_note", label: "Status note", value: "" },
        ]}
      />,
    );
    // 2 em-dashes expected
    const dashCount = (html.match(/—/g) ?? []).length;
    expect(dashCount).toBe(2);
    expect(html).toContain("data-unset");
  });

  test("renders an edit affordance inside the value cell when supplied (ID-20.25)", () => {
    const html = renderToStaticMarkup(
      <RecordFrontmatterCard
        rows={[
          {
            key: "status",
            label: "Status",
            value: "pending",
            editAffordance: (
              <button data-edit-action="open" data-edit-field="tasks>20>status">
                edit
              </button>
            ),
          },
        ]}
      />,
    );
    // The value is wrapped so the dispatcher can read it without the
    // pencil glyph contaminating the enum current value.
    expect(html).toContain("record-view-field-value");
    expect(html).toContain(">pending<");
    expect(html).toContain('data-edit-action="open"');
    expect(html).toContain('data-edit-field="tasks&gt;20&gt;status"');
  });

  test("does NOT wrap the value when no affordance is supplied (read-only rows unchanged)", () => {
    const html = renderToStaticMarkup(
      <RecordFrontmatterCard
        rows={[{ key: "owner", label: "Owner", value: "Liam" }]}
      />,
    );
    expect(html).not.toContain("record-view-field-value");
    expect(html).not.toContain("data-edit-action");
  });

  test("renders ReactNode values verbatim (e.g. linked dep list)", () => {
    const html = renderToStaticMarkup(
      <RecordFrontmatterCard
        rows={[
          {
            key: "dependencies",
            label: "Dependencies",
            value: (
              <>
                <a href="ID-1.md">ID-1</a>, <a href="ID-2.md">ID-2</a>
              </>
            ),
          },
        ]}
      />,
    );
    expect(html).toContain('href="ID-1.md"');
    expect(html).toContain('href="ID-2.md"');
    expect(html).toContain(">ID-1<");
  });
});
