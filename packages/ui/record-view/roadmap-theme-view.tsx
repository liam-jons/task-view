/**
 * record-view/roadmap-theme-view.tsx — Roadmap theme page renderer.
 *
 * Phase-B themes[] roadmap (ID-20.19) — replaces the retired
 * roadmap-section-view.tsx + roadmap-item-view.tsx pair. A theme is a flat
 * record; there is no nested section/item layer.
 *
 * Renders (per the RoadmapTheme schema):
 *   - title (heading)
 *   - markdown description
 *   - frontmatter card: time_horizon, status
 *   - linked_tasks  (rendered as cross-record links to Task mirrors)
 *   - linked_backlog (rendered as cross-record links to Backlog mirrors)
 *   - session_refs / commit_refs (provenance)
 *   - cross_doc_links
 *   - notes (markdown)
 *
 * PRODUCT inv 19 (forward_looking_only honoured: no shipped-framing UI) is
 * preserved — the renderer surfaces no `shipped` / `mark as` affordance.
 */
import React from "react";
import type { RoadmapTheme } from "@task-view/schemas/roadmap";
import { RoadmapThemeSchema } from "@task-view/schemas/roadmap";
import { MaybeCrossDocLink, MaybeRecordLink } from "./broken-target";
import { FieldPencil } from "./field-pencil";
import { NavStrip } from "./nav-strip";
import {
  RecordFrontmatterCard,
  type FrontmatterRow,
} from "./record-frontmatter-card";
import { MarkdownBody } from "./markdown-renderer";
import { taskMirrorHref, backlogItemHref } from "./anchors";
import type { LedgerContext, NavStripData } from "./types";

// Theme status enum literals sourced from the canonical Zod enum at
// render time (PRODUCT inv 31). RoadmapTheme.status is a required
// (non-nullable) 3-value enum: pending | in_progress | done.
const THEME_STATUS_OPTIONS = RoadmapThemeSchema.shape.status.options;

export const RoadmapThemeView: React.FC<{
  theme: RoadmapTheme;
  ledger: LedgerContext;
  nav: NavStripData;
}> = ({ theme, ledger, nav }) => {
  const rows: FrontmatterRow[] = [
    { key: "id", label: "ID", value: theme.id },
    { key: "time_horizon", label: "Time horizon", value: theme.time_horizon },
    {
      key: "status",
      label: "Status",
      value: theme.status,
      editAffordance: (
        <FieldPencil
          fieldPath={["themes", theme.id, "status"]}
          kind="enum"
          options={THEME_STATUS_OPTIONS}
          ariaLabel={`Edit status for theme ${theme.id}`}
        />
      ),
    },
    {
      key: "session_refs",
      label: "Session refs",
      value:
        theme.session_refs.length === 0 ? null : theme.session_refs.join(", "),
    },
    {
      key: "commit_refs",
      label: "Commit refs",
      value:
        theme.commit_refs.length === 0 ? null : theme.commit_refs.join(", "),
    },
  ];

  return (
    <article
      className="record-view-roadmap-theme"
      data-record-kind="roadmap-theme"
      data-record-id={theme.id}
    >
      <NavStrip data={nav} />
      {/* Inv 19: no shipped-framing UI. The renderer surfaces no `shipped`
          affordance — `last_updated` narrative on the root document is
          plain text per the spec. */}
      <header data-edit-container>
        <h1>
          {`${theme.id}: `}
          <span className="record-view-field-value">{theme.title}</span>
        </h1>
        <FieldPencil
          fieldPath={["themes", theme.id, "title"]}
          kind="text"
          ariaLabel={`Edit title for theme ${theme.id}`}
        />
      </header>

      <RecordFrontmatterCard
        rows={rows}
        ariaLabel={`Roadmap theme ${theme.id} metadata`}
      />

      <section
        className="record-view-roadmap-theme-description"
        data-section="description"
        data-edit-container
      >
        <span className="record-view-field-value">
          <MarkdownBody markdown={theme.description} />
        </span>
        <FieldPencil
          fieldPath={["themes", theme.id, "description"]}
          kind="textarea"
          rawValue={theme.description}
          ariaLabel={`Edit description for theme ${theme.id}`}
        />
      </section>

      <LinkedRecordList
        title="Linked tasks"
        sectionKey="linked_tasks"
        ids={theme.linked_tasks}
        hrefFor={taskMirrorHref}
        labelFor={(id) => `ID-${id}`}
        existsFor={(id) => ledger.taskIds.has(id)}
      />

      <LinkedRecordList
        title="Linked backlog"
        sectionKey="linked_backlog"
        ids={theme.linked_backlog}
        hrefFor={backlogItemHref}
        labelFor={(id) => `#${id}`}
        existsFor={(id) => ledger.backlogItemIds.has(id)}
      />

      {theme.cross_doc_links.length > 0 && (
        <section
          className="record-view-roadmap-theme-cross-doc-links"
          data-section="cross-doc-links"
        >
          <h2>Cross-doc links</h2>
          <ul>
            {theme.cross_doc_links.map((link, i) => (
              <li key={`${link.path}#${i}`}>
                <MaybeCrossDocLink
                  path={link.path}
                  anchor={link.anchor}
                  label={link.raw}
                  existingPaths={ledger.existingPaths}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {theme.notes !== null && (
        <section
          className="record-view-roadmap-theme-notes"
          data-section="notes"
          data-edit-container
        >
          <h2>Notes</h2>
          <span className="record-view-field-value">
            <MarkdownBody markdown={theme.notes} />
          </span>
          <FieldPencil
            fieldPath={["themes", theme.id, "notes"]}
            kind="textarea"
            rawValue={theme.notes}
            ariaLabel={`Edit notes for theme ${theme.id}`}
          />
        </section>
      )}
    </article>
  );
};

/**
 * Render one of the theme's linked-record list sections (`linked_tasks`,
 * `linked_backlog`). When the array is empty the section is omitted
 * entirely. Each id renders as a cross-record link to its mirror; missing
 * targets render via `MaybeRecordLink`'s broken-target treatment.
 */
const LinkedRecordList: React.FC<{
  title: string;
  sectionKey: "linked_tasks" | "linked_backlog";
  ids: readonly string[];
  hrefFor: (id: string) => string;
  labelFor: (id: string) => string;
  existsFor: (id: string) => boolean;
}> = ({ title, sectionKey, ids, hrefFor, labelFor, existsFor }) => {
  if (ids.length === 0) return null;
  return (
    <section
      className={`record-view-roadmap-theme-${sectionKey.replace("_", "-")}`}
      data-section={sectionKey}
    >
      <h2>{title}</h2>
      <ul>
        {ids.map((id) => (
          <li key={id}>
            <MaybeRecordLink
              href={hrefFor(id)}
              label={labelFor(id)}
              exists={existsFor(id)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
};
