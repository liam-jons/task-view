/**
 * record-view/backlog-index-view.tsx — Backlog index page renderer.
 *
 * PRODUCT inv 20 (index page lists every item with columns ID /
 *              Description / Type / Status / Priority / Rank / Track /
 *              Effort — Rank column added per roadmap-backlog-
 *              consolidation inv 10 / Subtask 30.8),
 *              23 (filter dropdowns Track / Status / Priority + URL
 *              query string state),
 *              47 (empty ledger → empty-state page).
 * roadmap-backlog-consolidation PRODUCT inv 10 (rank-edit affordance +
 *              drag handle + sort priority → rank (nulls last) → id),
 *              inv 11 (NO Promote button),
 *              inv 14 (semantic tokens — no raw Tailwind colour classes).
 * TECH §4.3 index page implementation.
 *
 * Pure render — the filter dropdowns are rendered as `<select>`
 * elements with `data-*` attributes the SPA can hook into for change
 * handling. The renderer DOES apply the supplied filter state to the
 * rendered table so a server-rendered + URL-driven first paint matches
 * what the SPA hydrate would produce. The rank affordance + drag handle
 * follow the same SSR-markup-with-hooks convention as
 * `edit-affordances.tsx` per PRODUCT inv 30 — the SPA hydration layer
 * wires up real behaviour against these stable `data-*` attributes.
 *
 * SUBTASK 30.8 SCOPE NOTE: this file emits the markup; the SPA
 * hydration layer (`apps/server/web/index.tsx`) is the consumer that
 * wires keydown / drag events to the patch-server. The Backlog index
 * page can be rendered server-side and the affordances are operable
 * via direct PATCH calls to the patch-server API. Interactive drag and
 * keyboard reorder land with the SPA mount, which is out of 30.8 scope.
 */
import React from "react";
import type { BacklogItem } from "@task-view/schemas/backlog";
import { BacklogStatus } from "@task-view/schemas/backlog";
import { Priority } from "@task-view/schemas/work-status";
import { recordRouteHref } from "./anchors";
import { useReadOnly } from "./read-only-context";
import {
  applyBacklogFilters,
  FILTER_ALL,
  type BacklogFilterState,
} from "./url-state";
import { sortBacklogItemsForIndex } from "./backlog-sort";
import { PriorityBadge, StatusBadge } from "./status-badge";

export interface BacklogIndexViewProps {
  items: readonly BacklogItem[];
  filters: BacklogFilterState;
  /**
   * Optional pre-computed Track value list. When omitted the renderer
   * derives it from the items in the ledger. Tracks are free-form
   * (`z.string().min(1)`), so the Zod schema cannot enumerate them.
   */
  trackOptions?: readonly string[];
}

export const BacklogIndexView: React.FC<BacklogIndexViewProps> = ({
  items,
  filters,
  trackOptions,
}) => {
  const tracks =
    trackOptions ?? Array.from(new Set(items.map((i) => i.track))).sort();
  // The Zod enum values are the canonical source per inv 31 (used here
  // for read-mode filter dropdowns even though edit-mode wiring lands
  // in 20.10).
  const statusValues = BacklogStatus.options;
  const priorityValues = Priority.options;

  const filtered = applyBacklogFilters(items, filters);
  // Per roadmap-backlog-consolidation inv 10 the sort on THIS surface
  // is priority → rank (nulls last) → id (overrides per-task-mirror
  // inv 20's track/status/id default for the Backlog index).
  const sorted = sortBacklogItemsForIndex(filtered);

  return (
    <article
      className="record-view-backlog-index"
      data-record-kind="backlog-index"
    >
      <header>
        <h1>Backlog</h1>
        <p
          className="record-view-backlog-index-count"
          data-item-count={filtered.length}
        >
          Showing {filtered.length} of {items.length} items
        </p>
      </header>

      <form
        className="record-view-backlog-filters"
        data-backlog-filters
        method="get"
        action=""
      >
        <FilterSelect
          name="track"
          label="Track"
          value={filters.track}
          options={tracks}
        />
        <FilterSelect
          name="status"
          label="Status"
          value={filters.status}
          options={[...statusValues]}
        />
        <FilterSelect
          name="priority"
          label="Priority"
          value={filters.priority}
          options={[...priorityValues]}
        />
        <noscript>
          <button type="submit">Apply</button>
        </noscript>
      </form>

      {items.length === 0 ? (
        <p
          className="record-view-empty-ledger"
          data-empty-ledger="backlog"
        >
          <em>The Backlog ledger is empty. Add items via the canonical
          creation path (workflow-curator skill or manual JSON edit).</em>
        </p>
      ) : sorted.length === 0 ? (
        <p
          className="record-view-empty-filtered"
          data-empty-filtered
        >
          <em>No items match the current filters.</em>
        </p>
      ) : (
        <table
          className="record-view-backlog-table"
          data-backlog-table
          data-supports-drag-reorder="true"
        >
          <thead>
            <tr>
              <th scope="col">
                {/*
                 * axe-core rule `empty-table-header` rejects an empty
                 * `<th>` even with aria-label, so we render the label
                 * inside a `.sr-only` (visually-hidden) span. The
                 * column visually appears as a slim drag-handle gutter
                 * but screen readers announce "Reorder".
                 */}
                <span className="sr-only">Reorder</span>
              </th>
              <th scope="col">ID</th>
              <th scope="col">Description</th>
              <th scope="col">Type</th>
              <th scope="col">Status</th>
              <th scope="col">Priority</th>
              <th scope="col">Rank</th>
              <th scope="col">Track</th>
              <th scope="col">Effort</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((item) => (
              <BacklogItemRow key={item.id} item={item} />
            ))}
          </tbody>
        </table>
      )}
    </article>
  );
};

/**
 * Single row of the Backlog index. Owns the rank affordance + drag
 * handle markup contracts (PRODUCT inv 10).
 *
 * Markup contracts (consumed by the SPA hydration layer):
 *   - `data-backlog-row="<id>"` on the `<tr>` so the SPA can locate it.
 *   - `data-priority-tier="<priority>"` on the `<tr>` so drag-within-
 *     tier logic can refuse drops across tiers per inv 10.
 *   - `data-drag-handle="<id>"` + `role="button"` + `tabindex="0"` +
 *     `data-keyboard-shortcut="arrow-up,arrow-down,enter"` on the
 *     drag handle for keyboard operability per inv 14 WCAG 2.1 AA.
 *   - `data-rank-value="<rank or empty>"` on the rank cell so the SPA
 *     knows the current value without re-parsing the rendered text.
 *   - `data-edit-field="items>{id}>rank"` + `data-edit-action="open"`
 *     on the pencil button (per `edit-affordances.tsx` convention) so
 *     the SPA promotes the cell to an integer input on click. The
 *     "(unset)" option (clear-to-null) is emitted by the SPA's edit-
 *     mode form per per-task-mirror inv 30 visual treatment; this row
 *     just exposes the affordance.
 */
const BacklogItemRow: React.FC<{ item: BacklogItem }> = ({ item }) => {
  const rankValue = item.rank ?? null;
  const fieldKey = `items>${item.id}>rank`;
  // {20.29}: suppress the inline rank editor on a read-only sibling page.
  const readOnly = useReadOnly();
  return (
    <tr
      data-backlog-row={item.id}
      data-priority-tier={item.priority}
    >
      <td className="record-view-drag-cell">
        {/* backlog-drag-reorder SPEC §6 (DR-6): omit the drag handle on a
            read-only sibling page — drag + keyboard reorder mutate the
            `rank` field, which has no sibling-write path (inv 43). With no
            `[data-drag-handle]` in the served HTML the reorder listeners
            have nothing to attach to (same posture as the suppressed rank
            pencil below). The client also banner-guards, but SSR-omit is the
            primary defence so a no-JS / read-only surface never shows a
            misleading drag affordance (QC finding A). The gutter column +
            its `.sr-only` header are kept for column-count stability. */}
        {readOnly ? null : (
          <span
            data-drag-handle={item.id}
            role="button"
            tabIndex={0}
            aria-label={`Reorder backlog item ${item.id}`}
            data-keyboard-shortcut="arrow-up,arrow-down,enter"
            // The visible glyph is U+2630 TRIGRAM FOR HEAVEN (≡-like
            // drag affordance). Hidden from AT — the aria-label supplies
            // accessible naming.
          >
            <span aria-hidden="true">{"☰"}</span>
          </span>
        )}
      </td>
      <td>
        <a
          href={recordRouteHref(item.id)}
          data-item-link={item.id}
        >
          {item.id}
        </a>
      </td>
      <td>{item.description}</td>
      <td>{item.type}</td>
      <td>
        <StatusBadge status={item.status} />
      </td>
      <td>
        <PriorityBadge priority={item.priority} />
      </td>
      <td
        className="record-view-rank-cell"
        data-rank-value={rankValue === null ? "" : String(rankValue)}
      >
        <span className="record-view-rank-value">
          {rankValue === null ? "—" : rankValue}
        </span>
        {readOnly ? null : (
          <button
            type="button"
            className="record-view-pencil-button"
            data-edit-action="open"
            data-edit-field={fieldKey}
            // ID-20.24: rank is `z.number().int().nullable()` — the PE
            // dispatcher reads this kind to build an integer input that
            // clears to null on empty input (the "(unset)" path).
            data-edit-kind="integer-nullable"
            aria-label={`Edit rank for backlog item ${item.id}`}
          >
            <span aria-hidden="true">{"✎"}</span>
          </button>
        )}
      </td>
      <td>{item.track}</td>
      <td>{item.effort_estimate ?? "—"}</td>
    </tr>
  );
};

/**
 * Render a labelled `<select>` with an "All" option at the top.
 *
 * For SSR the `defaultValue` reflects the supplied filter value (or
 * `FILTER_ALL` when `null`). The SPA can hydrate with React-controlled
 * state on top.
 */
const FilterSelect: React.FC<{
  name: string;
  label: string;
  value: string | null;
  options: readonly string[];
}> = ({ name, label, value, options }) => {
  const current = value ?? FILTER_ALL;
  return (
    <label
      className="record-view-filter-select"
      data-filter-name={name}
    >
      <span className="record-view-filter-label">{label}</span>
      <select
        name={name}
        defaultValue={current}
        data-filter-control={name}
      >
        <option value={FILTER_ALL}>All</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </label>
  );
};
