/**
 * record-view/roadmap-index-view.tsx — Roadmap section index page renderer.
 *
 * PRODUCT inv 14 ("Roadmap index page lists every Section as a table
 * with columns `ID`, `Title`, `Owner`, `Item count`"), 47 (empty
 * ledger empty-state).
 * TECH §4.3 index page implementation.
 */
import React from "react";
import type { Roadmap } from "@task-view/schemas/roadmap";
import { roadmapSectionHref } from "./anchors";

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
          data-section-count={roadmap.sections.length}
        >
          {roadmap.sections.length} section
          {roadmap.sections.length === 1 ? "" : "s"}
        </p>
      </header>

      {roadmap.sections.length === 0 ? (
        <p
          className="record-view-empty-ledger"
          data-empty-ledger="roadmap"
        >
          <em>The Roadmap ledger has no sections.</em>
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
              <th scope="col">Owner</th>
              <th scope="col">Item count</th>
            </tr>
          </thead>
          <tbody>
            {roadmap.sections.map((section) => (
              <tr
                key={section.id}
                data-section-row={section.id}
              >
                <td>
                  <a
                    href={roadmapSectionHref(section.id)}
                    data-section-link={section.id}
                  >
                    §{section.id}
                  </a>
                </td>
                <td>{section.title}</td>
                <td>{section.owner ?? "—"}</td>
                <td>{section.items.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </article>
  );
};
