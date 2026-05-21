/**
 * record-view/record-frontmatter-card.tsx — shared frontmatter card
 * (TECH §4.1, PRODUCT inv 7 frontmatter table, inv 15, inv 16, inv 21).
 *
 * The READ side of the mode-aware `RecordFrontmatterCard`. ID-20.9 ships
 * read-only display per mode; ID-20.10 layers in pencil-affordance edit
 * mode on top of this same component.
 *
 * Per TECH §4.1 the card differs per mode:
 *   - Task-list: Status, Priority, Effort, Owner, Updated, Session refs,
 *     Commit refs, Dependencies (linked), Cross-doc links (linked),
 *     Priority note, Status note.
 *   - Roadmap item: ID, Section ID (linked back), Phase label, Owner,
 *     Effort, Priority + Priority note, Severity, Status + Status note,
 *     Session refs, Commit refs.
 *   - Backlog item: every Zod-schema field; Promotion-ready badge if
 *     details or testStrategy present (PRODUCT inv 24); Blocked banner
 *     (PRODUCT inv 25).
 *
 * The card itself is mode-agnostic at the structural level — it accepts
 * an ordered array of `FrontmatterRow` descriptors. Per-mode renderers
 * (task-list-view.tsx, roadmap-item-view.tsx, backlog-item-view.tsx)
 * build the row list with their mode-specific shape.
 */
import React from "react";

/** A single row in the frontmatter table. */
export interface FrontmatterRow {
  /** Visible label (UK English; e.g. "Effort estimate", "Cross-doc links"). */
  label: string;
  /**
   * Rendered cell content — string, ReactNode, or null for "unset" display.
   * Renderers may pass JSX nodes for linked values (e.g. dep lists,
   * inheritance qualifier, status flag) — the card never re-renders the
   * inner value.
   */
  value: React.ReactNode;
  /**
   * Marker used by the Checker to find specific rows in the rendered HTML.
   * Lower-kebab-case derived from the label.
   */
  key: string;
}

export const RecordFrontmatterCard: React.FC<{
  rows: readonly FrontmatterRow[];
  /** UTF-8 prefix label used by aria-label (e.g. "Task ID-20 metadata"). */
  ariaLabel?: string;
}> = ({ rows, ariaLabel }) => {
  return (
    <table
      className="record-view-frontmatter-card"
      aria-label={ariaLabel}
      data-frontmatter-card
    >
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.key}
            data-frontmatter-row={row.key}
            className="record-view-frontmatter-row"
          >
            <th
              scope="row"
              className="record-view-frontmatter-label"
              data-frontmatter-label
            >
              {row.label}
            </th>
            <td
              className="record-view-frontmatter-value"
              data-frontmatter-value
            >
              {renderValue(row.value)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

/**
 * Convert a row value into displayable JSX:
 *   - `null` / `undefined` → an em-dash placeholder (PRODUCT inv 18 trailing
 *     case "When both are null, the field is shown as `—`.").
 *   - Empty string → also em-dash (uniform "unset" treatment).
 *   - Everything else (string / ReactNode) is rendered verbatim.
 */
function renderValue(value: React.ReactNode): React.ReactNode {
  if (value === null || value === undefined) {
    return <span data-unset>—</span>;
  }
  if (typeof value === "string" && value === "") {
    return <span data-unset>—</span>;
  }
  return value;
}
