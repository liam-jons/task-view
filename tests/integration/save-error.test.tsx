/**
 * tests/integration/save-error.test.tsx — PRODUCT inv 29
 * (invalid value → server returns ZodError → displayed inline near
 * textarea; textarea stays open with user's unsaved text preserved).
 *
 * Acceptance:
 *   - When the server returns `{ok: false, error: {kind: 'schema-error', ...}}`,
 *     `classifySaveResult` routes it as `schema-error` with the message
 *     body the viewer should display.
 *   - The textarea render (with `errorMessage` set in the descriptor)
 *     shows the inline error AND keeps the textarea open with the
 *     user's draft text preserved as defaultValue.
 *   - The `InlineErrorMessage` has `role="alert"` for screen-reader
 *     announcement.
 *   - mtime conflict (TECH §5.4) is a separate error kind — surfaces
 *     a "Reload from disk" hint via the SPA's mtime-conflict banner
 *     (not part of the inline error contract).
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TextareaField } from "../../packages/ui/record-view/edit-affordances";
import {
  classifySaveResult,
  formatZodErrorInline,
} from "../../packages/ui/record-view/edit-state";
import { z, ZodError } from "zod";

const SAMPLE_USER_DRAFT = `My unsaved description text.

Multi-paragraph content that I do NOT want to lose
just because the save failed validation.`;

describe("PRODUCT inv 29 — invalid value → inline error, textarea preserved", () => {
  test("server 422 {ok:false, error:'schema-error', issues} classified correctly", () => {
    // REAL server shape (handlePatchRecord 422): flat string `error` +
    // `issues: ZodIssue[]`. classifySaveResult formats the first issue
    // inline per PRODUCT inv 29.
    const outcome = classifySaveResult({
      ok: false,
      error: "schema-error",
      issues: [
        {
          path: ["tasks", 0, "status"],
          message: "Invalid enum value. Expected 'done'…",
        },
      ],
    });
    expect(outcome.kind).toBe("schema-error");
    expect(
      (outcome as { kind: "schema-error"; message: string }).message,
    ).toContain("tasks.0.status");
  });

  test("Zod errors format inline via formatZodErrorInline", () => {
    const schema = z.object({
      status: z.enum(["pending", "done"]),
    });
    let captured: ZodError | undefined;
    try {
      schema.parse({ status: "wrong" });
    } catch (e) {
      captured = e as ZodError;
    }
    expect(captured).toBeDefined();
    const inline = formatZodErrorInline(captured!);
    expect(inline).toContain("status:");
  });

  test("textarea stays open + draft preserved when errorMessage is set", () => {
    const html = renderToStaticMarkup(
      <TextareaField
        fieldPath={["tasks", "20", "description"]}
        draft={SAMPLE_USER_DRAFT}
        errorMessage="description: String must contain at least 1 character"
      />,
    );
    // Textarea still present (not torn down)
    expect(html).toContain("<textarea");
    // User's draft text preserved
    expect(html).toContain("My unsaved description text.");
    expect(html).toContain("Multi-paragraph content");
    // Inline error rendered below the textarea
    expect(html).toContain(
      "description: String must contain at least 1 character",
    );
    // role="alert" for screen-reader announcement
    expect(html).toContain('role="alert"');
    // data-edit-error attribute hook for SPA
    expect(html).toContain("data-edit-error");
  });

  test("absent errorMessage → no inline-error block rendered", () => {
    const html = renderToStaticMarkup(
      <TextareaField
        fieldPath={["tasks", "20", "description"]}
        draft={SAMPLE_USER_DRAFT}
      />,
    );
    expect(html).not.toContain("data-edit-error");
    expect(html).not.toContain('role="alert"');
  });

  test("Save button still present in error state — user can re-attempt", () => {
    const html = renderToStaticMarkup(
      <TextareaField
        fieldPath={["tasks", "20", "description"]}
        draft={SAMPLE_USER_DRAFT}
        errorMessage="Some validation failure."
      />,
    );
    expect(html).toContain('data-edit-action="save"');
    expect(html).toContain('data-edit-action="cancel"');
  });

  test("mtime conflict is a distinct error kind (NOT routed through inline)", () => {
    // Per TECH §5.4: mtime mismatch → server returns the REAL flat shape
    // {ok:false, error:'mtime-mismatch', currentMtime, hint} (409). The
    // SPA shows a top-level "Ledger changed underneath you — Reload from
    // disk" banner; the textarea also stays open + draft is preserved in
    // localStorage. The classification helper distinguishes the kinds.
    const outcome = classifySaveResult({
      ok: false,
      error: "mtime-mismatch",
      currentMtime: "2026-05-25T12:00:00.000Z",
      hint: "ledger changed underneath you — reload from disk and re-apply your edit",
    });
    expect(outcome.kind).toBe("mtime-conflict");
    expect(outcome.kind).not.toBe("schema-error");
  });

  test("walk-error (invalid fieldPath) is also distinct from schema-error", () => {
    // Per the REAL server (handlePatchRecord 400): {ok:false,
    // error:'walk-error', fieldPath, detail} fires when the fieldPath
    // references a non-existent record/subtask. Surfaces as a non-schema
    // error kind so the SPA can show a generic "Patch path invalid"
    // message rather than a Zod-style issue.
    const outcome = classifySaveResult({
      ok: false,
      error: "walk-error",
      fieldPath: ["tasks", "99", "status"],
      detail: "Task id 99 not found.",
    });
    expect(outcome.kind).toBe("walk-error");
  });
});
