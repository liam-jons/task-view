/**
 * record-view/backlog-index-view.tsx — Backlog index page renderer.
 *
 * PRODUCT inv 20 (index page lists every item with columns ID /
 *              Description / Type / Status / Priority / Track / Effort;
 *              sorted by track, then status, then id),
 *              23 (filter dropdowns Track / Status / Priority + URL
 *              query string state),
 *              47 (empty ledger → empty-state page).
 * TECH §4.3 index page implementation.
 *
 * Pure render — the filter dropdowns are rendered as `<select>`
 * elements with `data-*` attributes the SPA can hook into for change
 * handling. The renderer DOES apply the supplied filter state to the
 * rendered table so a server-rendered + URL-driven first paint matches
 * what the SPA hydrate would produce.
 */
import React from "react";
import type { BacklogItem } from "@task-view/schemas/backlog";
import { BacklogStatus } from "@task-view/schemas/backlog";
import { Priority } from "@task-view/schemas/work-status";
import { backlogItemHref } from "./anchors";
import {
  applyBacklogFilters,
  FILTER_ALL,
  type BacklogFilterState,
} from "./url-state";

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
  const sorted = sortBacklogItems(filtered);

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
        >
          <thead>
            <tr>
              <th scope="col">ID</th>
              <th scope="col">Description</th>
              <th scope="col">Type</th>
              <th scope="col">Status</th>
              <th scope="col">Priority</th>
              <th scope="col">Track</th>
              <th scope="col">Effort</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((item) => (
              <tr
                key={item.id}
                data-backlog-row={item.id}
              >
                <td>
                  <a
                    href={backlogItemHref(item.id)}
                    data-item-link={item.id}
                  >
                    {item.id}
                  </a>
                </td>
                <td>{item.description}</td>
                <td>{item.type}</td>
                <td>{item.status}</td>
                <td>{item.priority}</td>
                <td>{item.track}</td>
                <td>{item.effort_estimate ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </article>
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

/**
 * Sort backlog items by `track`, then `status`, then `id` per inv 20.
 * Stable order — ties on all three keys retain input order.
 */
function sortBacklogItems(items: readonly BacklogItem[]): BacklogItem[] {
  // Decorate-sort-undecorate to maintain stability.
  const decorated = items.map((item, idx) => ({ item, idx }));
  decorated.sort((a, b) => {
    if (a.item.track !== b.item.track) {
      return a.item.track < b.item.track ? -1 : 1;
    }
    if (a.item.status !== b.item.status) {
      return a.item.status < b.item.status ? -1 : 1;
    }
    if (a.item.id !== b.item.id) {
      // Numeric-friendly compare so 10 sorts after 2 (backlog ids are bare digits).
      const an = Number.parseInt(a.item.id, 10);
      const bn = Number.parseInt(b.item.id, 10);
      if (!Number.isNaN(an) && !Number.isNaN(bn)) {
        return an - bn;
      }
      return a.item.id < b.item.id ? -1 : 1;
    }
    return a.idx - b.idx;
  });
  return decorated.map((d) => d.item);
}
