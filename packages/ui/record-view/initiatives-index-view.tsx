/**
 * record-view/initiatives-index-view.tsx — Initiatives index page renderer
 * (ID-148.10, repurposed from roadmap-index-view.tsx).
 *
 * One row per TOP-LEVEL initiative (INV-9/INV-13 — the nested
 * sub-initiative -> project tree is NOT flattened into the index; each row
 * links to that initiative's own page, which renders the full tree). The
 * index table columns are `ID`, `Title`, `Status`, `Projects` (recursive
 * count across the whole sub-tree — see `initiatives-sort.ts`'s
 * `totalProjectCount`).
 *
 * PRODUCT inv 47 (empty ledger empty-state) preserved.
 * TECH §4.3 index page implementation.
 */
import React from "react";
import type { InitiativesDocument } from "@task-view/schemas/initiatives";
import { activeRecordHref, indexRowAnchorId, type LedgerSlug } from "./anchors";
import { StatusBadge } from "./status-badge";
import { IndexSearchBox } from "./index-search";
import { SortableColumnHeader } from "./sortable-header";
import { sortInitiativesForIndex, totalProjectCount } from "./initiatives-sort";
import {
  applyInitiativesFilters,
  type InitiativesFilterState,
  type SortState,
} from "./url-state";

export const InitiativesIndexView: React.FC<{
  initiatives: InitiativesDocument;
  filters?: InitiativesFilterState;
  sort?: SortState;
  activeSlug?: LedgerSlug | null;
}> = ({ initiatives, filters, sort, activeSlug }) => {
  const f = filters ?? { q: null };
  const s = sort ?? { field: null, dir: "asc" };
  const visible = sortInitiativesForIndex(
    applyInitiativesFilters(initiatives.initiatives, f),
    s,
  );
  return (
    <article
      className="record-view-initiatives-index"
      data-record-kind="initiatives-index"
    >
      <header>
        <h1>Initiatives</h1>
        <p
          className="record-view-initiatives-index-count"
          data-initiative-count={visible.length}
          data-initiative-total={initiatives.initiatives.length}
        >
          {visible.length} initiative
          {visible.length === 1 ? "" : "s"}
        </p>
        {initiatives.initiatives.length === 0 ? null : (
          <IndexSearchBox q={f.q ?? null} />
        )}
      </header>

      {initiatives.initiatives.length === 0 ? (
        <p
          className="record-view-empty-ledger"
          data-empty-ledger="initiatives"
        >
          <em>The Initiatives ledger has no initiatives.</em>
        </p>
      ) : visible.length === 0 ? (
        <p className="record-view-empty-filtered" data-empty-filtered>
          <em>No initiatives match the search.</em>
        </p>
      ) : (
        <table
          className="record-view-initiatives-index-table"
          data-initiatives-index-table
        >
          <thead>
            <tr>
              <SortableColumnHeader field="id" label="ID" sort={s} />
              <SortableColumnHeader field="title" label="Title" sort={s} />
              <SortableColumnHeader field="status" label="Status" sort={s} />
              <SortableColumnHeader
                field="project_count"
                label="Projects"
                sort={s}
              />
            </tr>
          </thead>
          <tbody>
            {visible.map((initiative) => (
              <tr
                key={initiative.id}
                id={indexRowAnchorId(initiative.id)}
                data-initiative-row={initiative.id}
              >
                <td>
                  <a
                    href={activeRecordHref(initiative.id, activeSlug)}
                    data-initiative-link={initiative.id}
                  >
                    {initiative.id}
                  </a>
                </td>
                <td>{initiative.title}</td>
                <td>
                  <StatusBadge status={initiative.status} />
                </td>
                <td>{totalProjectCount(initiative)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </article>
  );
};
