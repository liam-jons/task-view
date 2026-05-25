/**
 * record-view/field-pencil.tsx — ID-20.25 SSR edit affordance.
 *
 * The per-record views (task-list-view, roadmap-theme-view,
 * backlog-item-view, via record-frontmatter-card) emit a `FieldPencil`
 * beside each editable field's rendered value. The 20.24+20.25
 * progressive-enhancement dispatcher (`apps/server/web/index.tsx`)
 * attaches at document level and keys ALL behaviour on the stable hooks
 * this component emits — there is no record data serialised into the
 * page, so the affordance carries everything the dispatcher needs to
 * build the editor on click:
 *
 *   - `data-edit-action="open"`   — opens edit mode (delegated click).
 *   - `data-edit-field`           — the FieldPath joined by ">".
 *   - `data-edit-kind`            — the DispatchKind (text / textarea /
 *                                   enum / enum-nullable / array-comma /
 *                                   integer-nullable …).
 *   - `data-edit-options`         — enum literals (comma-separated) for
 *                                   enum / enum-nullable kinds (inv 31).
 *   - `data-edit-raw-value`       — the RAW Markdown source for textarea
 *                                   fields so the editor pre-populates
 *                                   with the unrendered source incl.
 *                                   `<info added on …>` journal blocks
 *                                   (inv 27-28), not the rendered text.
 *
 * This is a thin extension of the dead-but-tested `PencilButton` from
 * edit-affordances.tsx (which carried only action + field + aria-label):
 * `FieldPencil` adds the kind / options / raw-value hooks the 20.25
 * dispatcher consumes. No state lives here — pure markup.
 */
import React from "react";
import type { FieldPath } from "./edit-state";

/**
 * The set of `data-edit-kind` values the views emit. A subset of the
 * dispatcher's full DispatchKind union (the views never emit the numeric
 * `integer` kind — only Backlog `rank` uses `integer-nullable`, and that
 * is emitted directly by backlog-index-view, not via FieldPencil).
 */
export type FieldPencilKind =
  | "text"
  | "textarea"
  | "enum"
  | "enum-nullable"
  | "array-comma";

export const FieldPencil: React.FC<{
  fieldPath: FieldPath;
  kind: FieldPencilKind;
  /** UK-English aria label, e.g. "Edit status". */
  ariaLabel: string;
  /**
   * Enum literals for `enum` / `enum-nullable` kinds — sourced from the
   * canonical Zod enum's `.options` at render time (PRODUCT inv 31).
   * Emitted as a comma-separated `data-edit-options` hook (enum values
   * are simple tokens with no commas, so comma is a safe delimiter).
   */
  options?: readonly string[];
  /**
   * Raw Markdown source for `textarea` kinds (PRODUCT inv 27-28). When
   * present the dispatcher pre-populates the textarea with this verbatim
   * (incl. `<info added on …>` journal blocks) rather than the rendered
   * textContent. Omit for non-textarea kinds.
   */
  rawValue?: string;
}> = ({ fieldPath, kind, ariaLabel, options, rawValue }) => {
  const dataOptions =
    (kind === "enum" || kind === "enum-nullable") && options !== undefined
      ? options.join(",")
      : undefined;
  return (
    <button
      type="button"
      className="record-view-pencil-button"
      data-edit-action="open"
      data-edit-field={fieldPath.join(">")}
      data-edit-kind={kind}
      data-edit-options={dataOptions}
      data-edit-raw-value={kind === "textarea" ? rawValue : undefined}
      aria-label={ariaLabel}
    >
      <span aria-hidden="true">{"✎"}</span>
    </button>
  );
};
