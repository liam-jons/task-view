/**
 * record-view/roadmap-index-view.tsx — Roadmap theme index page renderer.
 *
 * Phase-B themes[] roadmap (ID-20.19) — the index lists every theme as a
 * table with columns `ID`, `Title`, `Time horizon`, `Status`,
 * `Linked tasks` (count). Replaces the retired sections[] index.
 *
 * PRODUCT inv 47 (empty ledger empty-state) preserved.
 * TECH §4.3 index page implementation.
 */
import React from "react";
import type { Roadmap } from "@task-view/schemas/roadmap";
import { activeRecordHref, indexRowAnchorId, type LedgerSlug } from "./anchors";
import { StatusBadge } from "./status-badge";
import { IndexSearchBox } from "./index-search";
import { SortableColumnHeader } from "./sortable-header";
import { sortThemesForIndex } from "./roadmap-sort";
import {
  applyRoadmapFilters,
  type RoadmapFilterState,
  type SortState,
} from "./url-state";

export const RoadmapIndexView: React.FC<{
  roadmap: Roadmap;
  filters?: RoadmapFilterState;
  sort?: SortState;
  activeSlug?: LedgerSlug | null;
}> = ({ roadmap, filters, sort, activeSlug }) => {
  const f = filters ?? { q: null };
  const s = sort ?? { field: null, dir: "asc" };
  const visible = sortThemesForIndex(applyRoadmapFilters(roadmap.themes, f), s);
  return (
    <article
      className="record-view-roadmap-index"
      data-record-kind="roadmap-index"
    >
      <header>
        <h1>Roadmap</h1>
        <p
          className="record-view-roadmap-index-count"
          data-theme-count={visible.length}
          data-theme-total={roadmap.themes.length}
        >
          {visible.length} theme
          {visible.length === 1 ? "" : "s"}
        </p>
        {roadmap.themes.length === 0 ? null : (
          <IndexSearchBox q={f.q ?? null} />
        )}
      </header>

      {roadmap.themes.length === 0 ? (
        <p
          className="record-view-empty-ledger"
          data-empty-ledger="roadmap"
        >
          <em>The Roadmap ledger has no themes.</em>
        </p>
      ) : visible.length === 0 ? (
        <p className="record-view-empty-filtered" data-empty-filtered>
          <em>No themes match the search.</em>
        </p>
      ) : (
        <table
          className="record-view-roadmap-index-table"
          data-roadmap-index-table
        >
          <thead>
            <tr>
              <SortableColumnHeader field="id" label="ID" sort={s} />
              <SortableColumnHeader field="title" label="Title" sort={s} />
              <SortableColumnHeader
                field="time_horizon"
                label="Time horizon"
                sort={s}
              />
              <SortableColumnHeader field="status" label="Status" sort={s} />
              <SortableColumnHeader
                field="linked_tasks"
                label="Linked tasks"
                sort={s}
              />
            </tr>
          </thead>
          <tbody>
            {visible.map((theme) => (
              <tr
                key={theme.id}
                id={indexRowAnchorId(theme.id)}
                data-theme-row={theme.id}
              >
                <td>
                  <a
                    href={activeRecordHref(theme.id, activeSlug)}
                    data-theme-link={theme.id}
                  >
                    {theme.id}
                  </a>
                </td>
                <td>{theme.title}</td>
                <td>{theme.time_horizon}</td>
                <td>
                  <StatusBadge status={theme.status} />
                </td>
                <td>{theme.linked_tasks.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </article>
  );
};
