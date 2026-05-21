/**
 * tests/integration/textarea-controls.test.tsx — PRODUCT inv 27
 * (Cmd/Ctrl+Enter Save + Esc Cancel keyboard shortcuts).
 *
 * Acceptance: Cmd/Ctrl+Enter saves; Esc cancels (restores rendered
 * view, no round-trip).
 *
 * Implementation note: actual keystroke handlers live in the SPA
 * hydration layer at `apps/server/web/` (slice 6 wiring). Here we
 * verify the markup hooks the SPA needs to attach the right handler
 * to the right element. The hook contract:
 *
 *   - `data-keyboard-shortcut="cmd-enter,esc"` on the focused element
 *     (textarea / input) — SPA's keydown handler reads this to know
 *     which shortcuts to honour.
 *   - `data-edit-action="save"` + `data-keyboard-shortcut="cmd-enter"`
 *     on the Save button — SPA mirrors the keystroke onto a click.
 *   - `data-edit-action="cancel"` + `data-keyboard-shortcut="esc"` on
 *     the Cancel button — same.
 *   - `data-edit-field="…"` on every hook — SPA reads to know which
 *     field's draft to commit / discard.
 *
 * No round-trip on Cancel: the cancel button's handler is a pure
 * client-side state reset (descriptor → undefined). No fetch is fired.
 * This is exercised in slice 6's end-to-end save round-trip; here we
 * verify the markup carries the cancel hook with no `data-needs-fetch`
 * (a sentinel that, were it present, would say "this action POSTs to
 * server").
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EditableField } from "../../packages/ui/record-view/edit-affordances";
import type { EditDescriptor } from "../../packages/ui/record-view/edit-state";

describe("Textarea keyboard shortcuts (PRODUCT inv 27)", () => {
  test("Cmd/Ctrl+Enter hook present on the focused textarea", () => {
    const descriptor: EditDescriptor = {
      fieldPath: ["tasks", "20", "description"],
      kind: "textarea",
      draft: "x",
    };
    const html = renderToStaticMarkup(<EditableField descriptor={descriptor} />);
    expect(html).toMatch(/<textarea[^>]*data-keyboard-shortcut="cmd-enter,esc"/);
  });

  test("Save button has cmd-enter shortcut hook (mirrored from textarea)", () => {
    const descriptor: EditDescriptor = {
      fieldPath: ["tasks", "20", "description"],
      kind: "textarea",
      draft: "x",
    };
    const html = renderToStaticMarkup(<EditableField descriptor={descriptor} />);
    expect(html).toMatch(
      /data-edit-action="save"[^>]*data-keyboard-shortcut="cmd-enter"/,
    );
  });

  test("Cancel button has esc shortcut hook", () => {
    const descriptor: EditDescriptor = {
      fieldPath: ["tasks", "20", "description"],
      kind: "textarea",
      draft: "x",
    };
    const html = renderToStaticMarkup(<EditableField descriptor={descriptor} />);
    expect(html).toMatch(
      /data-edit-action="cancel"[^>]*data-keyboard-shortcut="esc"/,
    );
  });

  test("Cancel is round-trip-free: no fetch sentinel on cancel button", () => {
    const descriptor: EditDescriptor = {
      fieldPath: ["tasks", "20", "description"],
      kind: "textarea",
      draft: "x",
    };
    const html = renderToStaticMarkup(<EditableField descriptor={descriptor} />);
    // Save button carries the patch-server contract; Cancel is purely
    // client-side state reset. The sentinel `data-needs-fetch` is
    // intentionally absent from the cancel button.
    expect(html).not.toMatch(/data-edit-action="cancel"[^>]*data-needs-fetch/);
  });

  test("hooks work for single-line text input too (inv 27 Cmd+Enter on text fields)", () => {
    const descriptor: EditDescriptor = {
      fieldPath: ["tasks", "20", "owner"],
      kind: "text",
      draft: "Liam",
    };
    const html = renderToStaticMarkup(<EditableField descriptor={descriptor} />);
    expect(html).toMatch(
      /<input[^>]*data-keyboard-shortcut="cmd-enter,esc"/,
    );
  });
});
