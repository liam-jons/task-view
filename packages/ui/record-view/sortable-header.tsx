/**
 * record-view/sortable-header.tsx — clickable column header for the read-only
 * index views (task-list / roadmap). Renders a `<th>` whose `<button
 * data-sort-trigger="<field>">` the SPA (`wireSortControl`) wires to cycle the
 * column sort (ascending → descending → off). `aria-sort` exposes the active
 * direction to assistive tech (WCAG 1.3.1). Without JS the header is inert
 * (the index renders in its natural order) — progressive enhancement.
 */
import React from "react";
import type { SortState } from "./url-state";

function ariaSortFor(
  sort: SortState,
  field: string,
): "ascending" | "descending" | "none" {
  if (sort.field !== field) return "none";
  return sort.dir === "desc" ? "descending" : "ascending";
}

export const SortableColumnHeader: React.FC<{
  field: string;
  label: string;
  sort: SortState;
}> = ({ field, label, sort }) => {
  const active = sort.field === field;
  const indicator = !active ? "" : sort.dir === "desc" ? " ▾" : " ▴";
  return (
    <th scope="col" aria-sort={ariaSortFor(sort, field)}>
      <button
        type="button"
        className="record-view-sort-trigger"
        data-sort-trigger={field}
      >
        {label}
        <span aria-hidden="true">{indicator}</span>
      </button>
    </th>
  );
};
