/**
 * tests/integration/edit-affordances.test.tsx — PRODUCT inv 26-27
 * (pencil affordance + Save/Cancel controls).
 *
 * Acceptance: pencil click swaps rendered block for textarea
 * pre-populated with raw Markdown source.
 *
 * Implementation note: the SSR test convention asserts on the rendered
 * markup with two render modes — pencil mode (no descriptor for the
 * field → renders the value + PencilButton) and edit mode (descriptor
 * passed → renders the TextareaField). The "click" action is
 * implemented by the SPA hydration layer which swaps the descriptor in
 * at the parent view; here we verify the markup hooks the SPA needs
 * are present.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EditableField,
  PencilButton,
} from "../../packages/ui/record-view/edit-affordances";
import type { EditDescriptor } from "../../packages/ui/record-view/edit-state";

describe("PencilButton — opens edit mode for a field (PRODUCT inv 26)", () => {
  test("renders a button with data-edit-action='open' + data-edit-field hook", () => {
    const html = renderToStaticMarkup(
      <PencilButton
        fieldPath={["tasks", "20", "description"]}
        ariaLabel="Edit description"
      />,
    );
    expect(html).toContain('data-edit-action="open"');
    expect(html).toContain('data-edit-field="tasks&gt;20&gt;description"');
    expect(html).toContain('aria-label="Edit description"');
    expect(html).toContain("✎"); // pencil glyph
    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
  });

  test("renders separate buttons for separate fieldPaths", () => {
    const desc = renderToStaticMarkup(
      <PencilButton
        fieldPath={["tasks", "20", "description"]}
        ariaLabel="Edit description"
      />,
    );
    const status = renderToStaticMarkup(
      <PencilButton
        fieldPath={["tasks", "20", "status_note"]}
        ariaLabel="Edit status note"
      />,
    );
    expect(desc).not.toBe(status);
    expect(desc).toContain("Edit description");
    expect(status).toContain("Edit status note");
  });
});

describe("EditableField textarea — pre-populates with raw Markdown source (PRODUCT inv 27)", () => {
  test("pencil click → textarea pre-populated with raw Markdown source", () => {
    // Simulate the SPA layer after pencil-click: the parent view re-renders
    // with a descriptor for this field.
    const descriptor: EditDescriptor = {
      fieldPath: ["tasks", "20", "description"],
      kind: "textarea",
      draft: "## Heading\n\nRaw **Markdown** source.\n",
    };
    const html = renderToStaticMarkup(<EditableField descriptor={descriptor} />);
    // Textarea element with the raw markdown as defaultValue
    expect(html).toContain("<textarea");
    expect(html).toContain("## Heading");
    expect(html).toContain("Raw **Markdown** source.");
    // Form has the kind hook for SPA dispatch
    expect(html).toContain('data-edit-kind="textarea"');
    expect(html).toContain('data-edit-field="tasks&gt;20&gt;description"');
  });

  test("Save + Cancel buttons present with keyboard-shortcut hooks", () => {
    const descriptor: EditDescriptor = {
      fieldPath: ["tasks", "20", "description"],
      kind: "textarea",
      draft: "x",
    };
    const html = renderToStaticMarkup(<EditableField descriptor={descriptor} />);
    expect(html).toContain('data-edit-action="save"');
    expect(html).toContain('data-edit-action="cancel"');
    expect(html).toContain('data-keyboard-shortcut="cmd-enter"');
    // The Esc shortcut hook is wired on the cancel button:
    expect(html).toMatch(/data-edit-action="cancel"[^>]*data-keyboard-shortcut="esc"/);
  });

  test("plain text edit pre-populates input + has same control surface", () => {
    const descriptor: EditDescriptor = {
      fieldPath: ["tasks", "20", "effort_estimate"],
      kind: "text",
      draft: "~2h",
    };
    const html = renderToStaticMarkup(<EditableField descriptor={descriptor} />);
    expect(html).toContain('value="~2h"');
    expect(html).toContain('data-edit-kind="text"');
    expect(html).toContain('data-edit-action="save"');
    expect(html).toContain('data-edit-action="cancel"');
  });
});
