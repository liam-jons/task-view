/**
 * record-view/edit-affordances.tsx — pencil affordance + form-element
 * primitives for ID-20.10 edit mode (PRODUCT inv 26-35).
 *
 * The viewer is SSR-rendered (no client mount in tests); these primitives
 * emit the markup the SPA layer hooks up to handlers via stable
 * `data-*` attributes. The pencil itself is a `<button>` with
 * `data-edit-action="open" data-edit-field="…"`; the textarea / select /
 * dropdown each carry hooks for keyboard-shortcut (Cmd/Ctrl+Enter +
 * Esc per inv 27) and for the field path the SPA reads when wiring
 * the save handler.
 *
 * No state lives in these components — they are pure markup. State
 * lives in the SPA at `apps/server/web/` (wired in slice 6).
 */
import React from "react";
import type {
  EditDescriptor,
  FieldPath,
} from "./edit-state";

// ──────────────────────────────────────────────────────────────────────────────
// Pencil affordance — opens edit mode for a field.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Render a small inline pencil button next to a value. Click → SPA
 * promotes the field into edit mode by attaching an `EditDescriptor`
 * for the same fieldPath at the parent view level.
 *
 * PRODUCT inv 26: "a small pencil affordance next to the rendered value".
 * Per inv 53: keyboard nav inherits Plannotator's tab order — the
 * button is focusable via Tab + activates with Enter.
 *
 * The visible glyph is a `✎` (U+270E LOWER RIGHT PENCIL) wrapped in
 * an aria-label for screen readers. No icon-font dependency.
 */
export const PencilButton: React.FC<{
  fieldPath: FieldPath;
  /** UK-English aria label, e.g. "Edit description". */
  ariaLabel: string;
}> = ({ fieldPath, ariaLabel }) => {
  return (
    <button
      type="button"
      className="record-view-pencil-button"
      data-edit-action="open"
      data-edit-field={fieldPath.join(">")}
      aria-label={ariaLabel}
    >
      <span aria-hidden="true">{"✎"}</span>
    </button>
  );
};

// ──────────────────────────────────────────────────────────────────────────────
// Save + Cancel controls — shared across all edit-mode form variants.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Save + Cancel buttons + their `data-*` hooks. Keyboard equivalents
 * per inv 27: Cmd/Ctrl+Enter inside the form fires save;
 * Esc fires cancel. The SPA's keydown handler reads
 * `data-edit-field` from the enclosing form to know which fieldPath
 * the save / cancel applies to.
 */
export const SaveCancelControls: React.FC<{
  fieldPath: FieldPath;
}> = ({ fieldPath }) => {
  return (
    <div className="record-view-save-cancel-controls">
      <button
        type="button"
        className="record-view-save-button"
        data-edit-action="save"
        data-edit-field={fieldPath.join(">")}
        data-keyboard-shortcut="cmd-enter"
      >
        Save
      </button>
      <button
        type="button"
        className="record-view-cancel-button"
        data-edit-action="cancel"
        data-edit-field={fieldPath.join(">")}
        data-keyboard-shortcut="esc"
      >
        Cancel
      </button>
    </div>
  );
};

// ──────────────────────────────────────────────────────────────────────────────
// Inline error message — shown below the form element when the server
// returns a Zod error (PRODUCT inv 29).
// ──────────────────────────────────────────────────────────────────────────────

export const InlineErrorMessage: React.FC<{
  fieldPath: FieldPath;
  message: string;
}> = ({ fieldPath, message }) => {
  return (
    <p
      className="record-view-inline-error"
      data-edit-error
      data-edit-field={fieldPath.join(">")}
      role="alert"
    >
      {message}
    </p>
  );
};

// ──────────────────────────────────────────────────────────────────────────────
// Text-input + textarea + enum-dropdown form elements.
// ──────────────────────────────────────────────────────────────────────────────

/** Single-line text input (e.g. effort_estimate, owner, phase_label). */
export const TextInputField: React.FC<{
  fieldPath: FieldPath;
  draft: string;
  errorMessage?: string;
}> = ({ fieldPath, draft, errorMessage }) => {
  const fieldKey = fieldPath.join(">");
  return (
    <form
      className="record-view-edit-form"
      data-edit-form
      data-edit-field={fieldKey}
      data-edit-kind="text"
    >
      <input
        type="text"
        className="record-view-text-input"
        data-edit-input
        data-edit-field={fieldKey}
        defaultValue={draft}
        // Keyboard shortcut hook: SPA attaches keydown handler.
        data-keyboard-shortcut="cmd-enter,esc"
      />
      <SaveCancelControls fieldPath={fieldPath} />
      {errorMessage !== undefined && (
        <InlineErrorMessage fieldPath={fieldPath} message={errorMessage} />
      )}
    </form>
  );
};

/**
 * Multi-line textarea (PRODUCT inv 27: "autosized `<textarea>`
 * pre-populated with the current raw Markdown source"). Used for
 * description, narrative, notes, details, priority_note, status_note,
 * testStrategy. Autosize is a CSS hint via `rows`; the SPA layer
 * grows it on input.
 *
 * Details fields (Task-list + Backlog) pass the full raw string
 * including `<info added on ...>` journal blocks per PRODUCT inv 28.
 * No edit gating, no auto-injection.
 */
export const TextareaField: React.FC<{
  fieldPath: FieldPath;
  draft: string;
  /**
   * Visual hint for the SPA autosize layer; ignored if absent.
   * Defaults to 4 (enough for short prose like a status_note).
   */
  rows?: number;
  errorMessage?: string;
}> = ({ fieldPath, draft, rows = 4, errorMessage }) => {
  const fieldKey = fieldPath.join(">");
  return (
    <form
      className="record-view-edit-form"
      data-edit-form
      data-edit-field={fieldKey}
      data-edit-kind="textarea"
    >
      <textarea
        className="record-view-textarea"
        data-edit-input
        data-edit-field={fieldKey}
        rows={rows}
        defaultValue={draft}
        data-keyboard-shortcut="cmd-enter,esc"
      />
      <SaveCancelControls fieldPath={fieldPath} />
      {errorMessage !== undefined && (
        <InlineErrorMessage fieldPath={fieldPath} message={errorMessage} />
      )}
    </form>
  );
};

/**
 * Enum dropdown (PRODUCT inv 30-32). `options` sourced from the
 * canonical Zod enum's `.options` at render time per inv 31; the
 * dropdown does NOT enforce state-machine transitions per inv 32
 * (every valid value is selectable regardless of current state).
 *
 * Nullable variant: if `nullable: true`, a "(unset)" sentinel option
 * is prepended with value `""`; the SPA serialises that back to
 * `null` before patch.
 */
export const EnumDropdownField: React.FC<{
  fieldPath: FieldPath;
  draft: string | null;
  options: readonly string[];
  nullable?: boolean;
  errorMessage?: string;
}> = ({ fieldPath, draft, options, nullable, errorMessage }) => {
  const fieldKey = fieldPath.join(">");
  return (
    <form
      className="record-view-edit-form"
      data-edit-form
      data-edit-field={fieldKey}
      data-edit-kind={nullable ? "enum-nullable" : "enum"}
    >
      <select
        className="record-view-enum-dropdown"
        data-edit-input
        data-edit-field={fieldKey}
        defaultValue={draft ?? ""}
      >
        {nullable && (
          <option value="" data-nullable-sentinel>
            (unset)
          </option>
        )}
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
      <SaveCancelControls fieldPath={fieldPath} />
      {errorMessage !== undefined && (
        <InlineErrorMessage fieldPath={fieldPath} message={errorMessage} />
      )}
    </form>
  );
};

/**
 * Comma-separated array input (PRODUCT inv 34). Single text input;
 * parse happens client-side in the SPA via `parseCommaSeparatedIds`
 * before patch construction. Schema-side validation rejects malformed
 * entries (e.g. Subtask cross-Task dep — sibling-only per
 * superRefine).
 */
export const ArrayCommaField: React.FC<{
  fieldPath: FieldPath;
  draft: string;
  errorMessage?: string;
}> = ({ fieldPath, draft, errorMessage }) => {
  const fieldKey = fieldPath.join(">");
  return (
    <form
      className="record-view-edit-form"
      data-edit-form
      data-edit-field={fieldKey}
      data-edit-kind="array-comma"
    >
      <input
        type="text"
        className="record-view-array-comma-input"
        data-edit-input
        data-edit-field={fieldKey}
        defaultValue={draft}
        data-keyboard-shortcut="cmd-enter,esc"
        placeholder="comma-separated ids"
      />
      <SaveCancelControls fieldPath={fieldPath} />
      {errorMessage !== undefined && (
        <InlineErrorMessage fieldPath={fieldPath} message={errorMessage} />
      )}
    </form>
  );
};

// ──────────────────────────────────────────────────────────────────────────────
// DocLink per-entry form (PRODUCT inv 35).
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Per-entry form for `cross_doc_links[]` (PRODUCT inv 35). Each row
 * has `path`, `anchor`, `raw` text inputs + a delete-row button.
 * "Add link" button at the bottom appends a fresh blank row.
 *
 * SPA reads `data-doclink-row-index` and `data-doclink-field` from the
 * inputs to assemble the array on save; the patch goes as a full
 * array replacement per TECH §5.1 + inv 34 (array-replace, not
 * element-merge).
 */
export const DocLinkPerEntryForm: React.FC<{
  fieldPath: FieldPath;
  /**
   * Current draft entries. Each row gets one form-row with its
   * 3 inputs + delete button. `anchor` may be null (rendered as
   * empty input which the SPA serialises back to null on save).
   */
  draft: readonly {
    path: string;
    anchor: string | null;
    raw: string;
  }[];
  errorMessage?: string;
}> = ({ fieldPath, draft, errorMessage }) => {
  const fieldKey = fieldPath.join(">");
  return (
    <form
      className="record-view-doclink-form"
      data-edit-form
      data-edit-field={fieldKey}
      data-edit-kind="doc-links"
    >
      <table className="record-view-doclink-table">
        <thead>
          <tr>
            <th scope="col">Path</th>
            <th scope="col">Anchor</th>
            <th scope="col">Raw</th>
            <th scope="col" aria-label="Actions" />
          </tr>
        </thead>
        <tbody data-doclink-rows>
          {draft.map((entry, i) => (
            <tr
              key={`row-${i}`}
              className="record-view-doclink-row"
              data-doclink-row-index={i}
            >
              <td>
                <input
                  type="text"
                  className="record-view-doclink-path"
                  data-doclink-field="path"
                  data-doclink-row-index={i}
                  defaultValue={entry.path}
                />
              </td>
              <td>
                <input
                  type="text"
                  className="record-view-doclink-anchor"
                  data-doclink-field="anchor"
                  data-doclink-row-index={i}
                  defaultValue={entry.anchor ?? ""}
                />
              </td>
              <td>
                <input
                  type="text"
                  className="record-view-doclink-raw"
                  data-doclink-field="raw"
                  data-doclink-row-index={i}
                  defaultValue={entry.raw}
                />
              </td>
              <td>
                <button
                  type="button"
                  className="record-view-doclink-delete"
                  data-doclink-action="delete"
                  data-doclink-row-index={i}
                  aria-label={`Delete cross-doc link ${i + 1}`}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        type="button"
        className="record-view-doclink-add"
        data-doclink-action="add"
      >
        Add link
      </button>
      <SaveCancelControls fieldPath={fieldPath} />
      {errorMessage !== undefined && (
        <InlineErrorMessage fieldPath={fieldPath} message={errorMessage} />
      )}
    </form>
  );
};

// ──────────────────────────────────────────────────────────────────────────────
// Unified editable-field renderer — picks the right form variant from
// an EditDescriptor.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Pick the appropriate form variant from an `EditDescriptor`. Used by
 * view components in their edit-mode branch — they pass the descriptor
 * they got from props.
 *
 * Throws (rather than silently no-ops) on unknown `kind` — keeps the
 * editor-state contract honest.
 */
export const EditableField: React.FC<{ descriptor: EditDescriptor }> = ({
  descriptor,
}) => {
  const { fieldPath, kind, draft, errorMessage } = descriptor;
  switch (kind) {
    case "text":
      return (
        <TextInputField
          fieldPath={fieldPath}
          draft={String(draft ?? "")}
          errorMessage={errorMessage}
        />
      );
    case "textarea":
      return (
        <TextareaField
          fieldPath={fieldPath}
          draft={String(draft ?? "")}
          errorMessage={errorMessage}
        />
      );
    case "enum":
      return (
        <EnumDropdownField
          fieldPath={fieldPath}
          draft={draft === null || draft === undefined ? null : String(draft)}
          options={descriptor.enumOptions ?? []}
          errorMessage={errorMessage}
        />
      );
    case "enum-nullable":
      return (
        <EnumDropdownField
          fieldPath={fieldPath}
          draft={draft === null || draft === undefined ? null : String(draft)}
          options={descriptor.enumOptions ?? []}
          nullable
          errorMessage={errorMessage}
        />
      );
    case "array-comma":
      return (
        <ArrayCommaField
          fieldPath={fieldPath}
          draft={String(draft ?? "")}
          errorMessage={errorMessage}
        />
      );
    case "doc-links":
      return (
        <DocLinkPerEntryForm
          fieldPath={fieldPath}
          draft={
            (draft as readonly { path: string; anchor: string | null; raw: string }[]) ??
            []
          }
          errorMessage={errorMessage}
        />
      );
    default: {
      // Exhaustiveness guard
      const _exhaustive: never = kind;
      throw new Error(`Unknown EditDescriptor kind: ${String(_exhaustive)}`);
    }
  }
};
