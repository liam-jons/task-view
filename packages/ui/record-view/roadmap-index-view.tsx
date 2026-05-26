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
import { recordRouteHref } from "./anchors";

export const RoadmapIndexView: React.FC<{
  roadmap: Roadmap;
}> = ({ roadmap }) => {
  return (
    <article
      className="record-view-roadmap-index"
      data-record-kind="roadmap-index"
    >
      <header>
        <h1>Roadmap</h1>
        <p
          className="record-view-roadmap-index-count"
          data-theme-count={roadmap.themes.length}
        >
          {roadmap.themes.length} theme
          {roadmap.themes.length === 1 ? "" : "s"}
        </p>
      </header>

      {roadmap.themes.length === 0 ? (
        <p
          className="record-view-empty-ledger"
          data-empty-ledger="roadmap"
        >
          <em>The Roadmap ledger has no themes.</em>
        </p>
      ) : (
        <table
          className="record-view-roadmap-index-table"
          data-roadmap-index-table
        >
          <thead>
            <tr>
              <th scope="col">ID</th>
              <th scope="col">Title</th>
              <th scope="col">Time horizon</th>
              <th scope="col">Status</th>
              <th scope="col">Linked tasks</th>
            </tr>
          </thead>
          <tbody>
            {roadmap.themes.map((theme) => (
              <tr
                key={theme.id}
                data-theme-row={theme.id}
              >
                <td>
                  <a
                    href={recordRouteHref(theme.id)}
                    data-theme-link={theme.id}
                  >
                    {theme.id}
                  </a>
                </td>
                <td>{theme.title}</td>
                <td>{theme.time_horizon}</td>
                <td>{theme.status}</td>
                <td>{theme.linked_tasks.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </article>
  );
};
