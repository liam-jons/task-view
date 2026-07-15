/**
 * record-view/initiatives-tree-view.tsx — Initiative page renderer
 * (ID-148.10, repurposed from roadmap-theme-view.tsx; TECH §3.1(c), OQ2).
 *
 * Renders ONE top-level Initiative's FULL nested tree in a single page
 * (INV-9 — one mirror/page per top-level initiative, not per project or
 * per sub-initiative): the initiative's own fields, its recursive
 * `sub-initiatives[]` (each rendered inline, arbitrary depth), and every
 * level's `projects[]`.
 *
 * Editing (OQ2 — "an initiatives view WITH editing"):
 *   - Initiative / sub-initiative fields (title, description, status) are
 *     editable via `FieldPencil` addressed by DOTTED PATH:
 *     `['initiatives', path, field]` (e.g. `path = "4"` for the top-level
 *     initiative, `"4.2"` for its second sub-initiative — INV-13).
 *   - Project fields (title, summary, description, status, substrate_doc,
 *     linked_tasks, linked_backlog) are editable via `FieldPencil`
 *     addressed by the project's GLOBALLY-UNIQUE SLUG:
 *     `['projects', slug, field]` — tree-walk-resolved server-side
 *     regardless of nesting depth.
 *   - `linked_tasks` / `linked_backlog` use the `array-comma` FieldPencil
 *     kind (the same comma-separated-ids editing convention
 *     `task.dependencies` already uses elsewhere) — editing the list IS
 *     the link/unlink operation.
 *   - Whole-record create / delete / move (INV-13's atomic re-parent) ARE
 *     wired here (ID-148.10 Checker Finding B — corrects an earlier stale
 *     comment that wrongly attributed this to `{148.7}`, the CANONICAL
 *     CLI's dependent Subtask in a DIFFERENT repo; nothing there covers
 *     THIS view's UI): `CreateProjectForm` posts a caller-supplied slug +
 *     title under an addressed initiative/sub-initiative path;
 *     `data-project-delete-action` DELETEs a project by slug (server-side
 *     INV-5 non-empty guard rejects it while linked_tasks/linked_backlog
 *     are non-empty); `MoveLinkedRecordForm` composes the atomic 2-patch
 *     re-parent batch (source array minus the id, target array plus it) in
 *     ONE PATCH request — not a dedicated wire-level opcode, exactly the
 *     shape `applyInitiativesPatches`'s "atomic move" test exercises. The
 *     server write arm these three affordances hit already existed and was
 *     already tested (`record-mutate.ts`/`patch-apply.ts`); this Subtask's
 *     surface is the client wiring.
 *
 * Sub-initiatives do NOT carry `linked_tasks`/`linked_backlog` (INV-6 —
 * links are project-only; only the top-level Initiative carries the
 * initiative-4 transitional tolerance) and are rendered read-only for that
 * pair — there is nothing to edit there.
 */
import React from "react";
import type {
  Initiative,
  SubInitiative,
  Project,
} from "@task-view/schemas/initiatives";
import {
  INITIATIVE_STATUSES,
  PROJECT_STATUSES,
} from "@task-view/schemas/initiatives";
import { MaybeRecordLink } from "./broken-target";
import { FieldPencil } from "./field-pencil";
import { NavStrip } from "./nav-strip";
import {
  RecordFrontmatterCard,
  type FrontmatterRow,
} from "./record-frontmatter-card";
import { MarkdownBody } from "./markdown-renderer";
import { crossLedgerRecordHref, type LedgerSlug } from "./anchors";
import { StatusBadge } from "./status-badge";
import type { LedgerContext, NavStripData } from "./types";

export const InitiativesTreeView: React.FC<{
  initiative: Initiative;
  ledger: LedgerContext;
  nav: NavStripData;
}> = ({ initiative, ledger, nav }) => {
  const path = initiative.id;
  const rows: FrontmatterRow[] = [
    { key: "id", label: "ID", value: initiative.id },
    {
      key: "status",
      label: "Status",
      value: <StatusBadge status={initiative.status} />,
      editAffordance: (
        <FieldPencil
          fieldPath={["initiatives", path, "status"]}
          kind="enum"
          options={INITIATIVE_STATUSES}
          ariaLabel={`Edit status for initiative ${initiative.id}`}
        />
      ),
    },
    {
      key: "originating_session",
      label: "Originating session",
      value:
        initiative.originating_session.length === 0
          ? null
          : initiative.originating_session.join(", "),
    },
    {
      key: "substrate_doc",
      label: "Substrate doc",
      value: initiative.substrate_doc ?? null,
    },
  ];

  return (
    <article
      className="record-view-initiative"
      data-record-kind="initiative"
      data-record-id={initiative.id}
    >
      <NavStrip data={nav} />
      <header data-edit-container>
        <h1>
          {`${initiative.id}: `}
          <span className="record-view-field-value">{initiative.title}</span>
        </h1>
        <FieldPencil
          fieldPath={["initiatives", path, "title"]}
          kind="text"
          ariaLabel={`Edit title for initiative ${initiative.id}`}
        />
      </header>

      <RecordFrontmatterCard
        rows={rows}
        ariaLabel={`Initiative ${initiative.id} metadata`}
      />

      <section
        className="record-view-initiative-description"
        data-section="description"
        data-edit-container
      >
        <span className="record-view-field-value">
          <MarkdownBody markdown={initiative.description} />
        </span>
        <FieldPencil
          fieldPath={["initiatives", path, "description"]}
          kind="textarea"
          rawValue={initiative.description}
          ariaLabel={`Edit description for initiative ${initiative.id}`}
        />
      </section>

      {/* Transitional initiative-4 tolerance (audit A3) — off-project links
          at the INITIATIVE level. Read-only: INV-6 restricts link/unlink
          editing to projects only; redistributing these is the
          data-quality task's job, not this view's. */}
      {((initiative.linked_tasks?.length ?? 0) > 0 ||
        (initiative.linked_backlog?.length ?? 0) > 0) && (
        <section
          className="record-view-initiative-transitional-links"
          data-section="transitional-links"
        >
          <h2>Linked tasks / backlog (initiative-level, transitional)</h2>
          <LinkedRecordList
            title="Linked tasks"
            sectionKey="linked_tasks"
            ids={initiative.linked_tasks ?? []}
            crossLedger="task-list"
            hrefFor={(id) => crossLedgerRecordHref("task-list", id)}
            labelFor={(id) => `ID-${id}`}
            existsFor={(id) => ledger.taskIds.has(id)}
          />
          <LinkedRecordList
            title="Linked backlog"
            sectionKey="linked_backlog"
            ids={initiative.linked_backlog ?? []}
            crossLedger="backlog"
            hrefFor={(id) => crossLedgerRecordHref("backlog", id)}
            labelFor={(id) => `#${id}`}
            existsFor={(id) => ledger.backlogItemIds.has(id)}
          />
        </section>
      )}

      <section
        className="record-view-initiative-projects"
        data-section="projects"
      >
        <h2>Projects</h2>
        {initiative.projects.length === 0 ? (
          <p className="record-view-empty-section" data-empty-projects>
            <em>No direct projects.</em>
          </p>
        ) : (
          initiative.projects.map((project) => (
            <ProjectBlock key={project.id} project={project} ledger={ledger} />
          ))
        )}
        <CreateProjectForm initiativePath={path} />
      </section>

      <section
        className="record-view-initiative-sub-initiatives"
        data-section="sub-initiatives"
      >
        <h2>Sub-initiatives</h2>
        {initiative["sub-initiatives"].length === 0 ? (
          <p className="record-view-empty-section" data-empty-sub-initiatives>
            <em>No sub-initiatives.</em>
          </p>
        ) : (
          initiative["sub-initiatives"].map((sub) => (
            <SubInitiativeBlock
              key={sub.id}
              node={sub}
              path={`${path}.${sub.id}`}
              ledger={ledger}
            />
          ))
        )}
      </section>
    </article>
  );
};

/**
 * One sub-initiative's block — recursive (a sub-initiative may itself carry
 * further `sub-initiatives[]`, INV-13 arbitrary depth). `path` is the FULL
 * dotted path from the top-level initiative down to THIS node (e.g. `"4.2"`,
 * `"4.2.1"`) — the exact `['initiatives', path, field]` addressing form.
 */
const SubInitiativeBlock: React.FC<{
  node: SubInitiative;
  path: string;
  ledger: LedgerContext;
}> = ({ node, path, ledger }) => {
  return (
    <section
      className="record-view-sub-initiative"
      data-section="sub-initiative"
      data-sub-initiative-path={path}
    >
      <header data-edit-container>
        <h3>
          {`${path}: `}
          <span className="record-view-field-value">{node.title}</span>
        </h3>
        <FieldPencil
          fieldPath={["initiatives", path, "title"]}
          kind="text"
          ariaLabel={`Edit title for sub-initiative ${path}`}
        />
      </header>

      <p className="record-view-sub-initiative-status" data-edit-container>
        <StatusBadge status={node.status} />
        <FieldPencil
          fieldPath={["initiatives", path, "status"]}
          kind="enum"
          options={INITIATIVE_STATUSES}
          ariaLabel={`Edit status for sub-initiative ${path}`}
        />
      </p>

      {node.substrate_doc !== undefined && (
        <p className="record-view-sub-initiative-substrate-doc">
          Substrate doc: {node.substrate_doc}
        </p>
      )}

      <div
        className="record-view-sub-initiative-description"
        data-edit-container
      >
        <span className="record-view-field-value">
          <MarkdownBody markdown={node.description} />
        </span>
        <FieldPencil
          fieldPath={["initiatives", path, "description"]}
          kind="textarea"
          rawValue={node.description}
          ariaLabel={`Edit description for sub-initiative ${path}`}
        />
      </div>

      <div className="record-view-sub-initiative-projects">
        {node.projects.map((project) => (
          <ProjectBlock key={project.id} project={project} ledger={ledger} />
        ))}
        <CreateProjectForm initiativePath={path} />
      </div>

      {node["sub-initiatives"].map((child) => (
        <SubInitiativeBlock
          key={child.id}
          node={child}
          path={`${path}.${child.id}`}
          ledger={ledger}
        />
      ))}
    </section>
  );
};

/**
 * One project's block, editable in full — addressed by its
 * globally-unique slug (`['projects', slug, field]`, INV-13). Rendered
 * identically regardless of nesting depth (a project reads the same
 * whether it lives directly under a top-level initiative or several
 * sub-initiatives deep).
 */
const ProjectBlock: React.FC<{
  project: Project;
  ledger: LedgerContext;
}> = ({ project, ledger }) => {
  const slug = project.id;
  return (
    <section
      className="record-view-project"
      data-section="project"
      data-project-slug={slug}
    >
      <header data-edit-container>
        <h3>
          {`${slug}: `}
          <span className="record-view-field-value">{project.title}</span>
        </h3>
        <FieldPencil
          fieldPath={["projects", slug, "title"]}
          kind="text"
          ariaLabel={`Edit title for project ${slug}`}
        />
      </header>

      <p className="record-view-project-summary" data-edit-container>
        <span className="record-view-field-value">{project.summary}</span>
        <FieldPencil
          fieldPath={["projects", slug, "summary"]}
          kind="text"
          ariaLabel={`Edit summary for project ${slug}`}
        />
      </p>

      <p className="record-view-project-status" data-edit-container>
        <StatusBadge status={project.status} />
        <FieldPencil
          fieldPath={["projects", slug, "status"]}
          kind="enum"
          options={PROJECT_STATUSES}
          ariaLabel={`Edit status for project ${slug}`}
        />
      </p>

      <div className="record-view-project-description" data-edit-container>
        <span className="record-view-field-value">
          <MarkdownBody markdown={project.description} />
        </span>
        <FieldPencil
          fieldPath={["projects", slug, "description"]}
          kind="textarea"
          rawValue={project.description}
          ariaLabel={`Edit description for project ${slug}`}
        />
      </div>

      <p className="record-view-project-substrate-doc" data-edit-container>
        <span className="record-view-field-value">
          {project.substrate_doc}
        </span>
        <FieldPencil
          fieldPath={["projects", slug, "substrate_doc"]}
          kind="text"
          ariaLabel={`Edit substrate doc for project ${slug}`}
        />
      </p>

      {/* link/unlink (OQ2): editing this comma-separated id list IS the
          link/unlink operation — the same array-comma convention
          task.dependencies already uses elsewhere in this codebase. */}
      <div
        className="record-view-project-linked-tasks"
        data-section="linked_tasks"
        data-edit-container
      >
        <h4>Linked tasks</h4>
        <LinkedRecordList
          title=""
          sectionKey="linked_tasks"
          ids={project.linked_tasks}
          crossLedger="task-list"
          hrefFor={(id) => crossLedgerRecordHref("task-list", id)}
          labelFor={(id) => `ID-${id}`}
          existsFor={(id) => ledger.taskIds.has(id)}
          suppressHeading
        />
        <FieldPencil
          fieldPath={["projects", slug, "linked_tasks"]}
          kind="array-comma"
          rawValue={project.linked_tasks.join(",")}
          ariaLabel={`Edit linked tasks for project ${slug}`}
        />
        <MoveLinkedRecordForm section="linked_tasks" sourceSlug={slug} />
      </div>

      <div
        className="record-view-project-linked-backlog"
        data-section="linked_backlog"
        data-edit-container
      >
        <h4>Linked backlog</h4>
        <LinkedRecordList
          title=""
          sectionKey="linked_backlog"
          ids={project.linked_backlog}
          crossLedger="backlog"
          hrefFor={(id) => crossLedgerRecordHref("backlog", id)}
          labelFor={(id) => `#${id}`}
          existsFor={(id) => ledger.backlogItemIds.has(id)}
          suppressHeading
        />
        <FieldPencil
          fieldPath={["projects", slug, "linked_backlog"]}
          kind="array-comma"
          rawValue={project.linked_backlog.join(",")}
          ariaLabel={`Edit linked backlog for project ${slug}`}
        />
        <MoveLinkedRecordForm section="linked_backlog" sourceSlug={slug} />
      </div>

      {(project.blocked_by.length > 0 || project.blocking.length > 0) && (
        <p className="record-view-project-blocking">
          {project.blocked_by.length > 0 && (
            <span data-section="blocked_by">
              Blocked by: {project.blocked_by.join(", ")}
            </span>
          )}
          {project.blocking.length > 0 && (
            <span data-section="blocking">
              Blocking: {project.blocking.join(", ")}
            </span>
          )}
        </p>
      )}

      {/* Whole-record delete (INV-5's non-empty guard rejects this
          server-side while linked_tasks/linked_backlog are non-empty —
          unlink first via the FieldPencils above). Mirrors the
          data-delete-action convention backlog-item-view.tsx established,
          scoped to this project's own hook name so the two dispatchers
          never collide. */}
      <div className="record-view-record-actions">
        <button
          type="button"
          className="record-view-delete-button"
          data-project-delete-action
          aria-label={`Delete project ${slug}`}
        >
          Delete this project
        </button>
      </div>
    </section>
  );
};

/**
 * A minimal atomic-move affordance (INV-13): re-parent ONE linked task/
 * backlog id from THIS project to another project's SAME section, as a
 * single 2-field-patch PATCH request (source array minus the id, target
 * array plus the id) — not a dedicated wire-level opcode, exactly the
 * shape `applyInitiativesPatches`'s "atomic move (two-project batch)" test
 * exercises. The target project may be addressed by slug ANYWHERE in the
 * SAME initiatives.json (any top-level initiative, not just this page) —
 * the client dispatcher fetches the live document fresh and tree-walks it
 * to find both projects' current arrays before composing the patch, so a
 * target off this page still resolves correctly.
 */
const MoveLinkedRecordForm: React.FC<{
  section: "linked_tasks" | "linked_backlog";
  sourceSlug: string;
}> = ({ section, sourceSlug }) => {
  const label = section === "linked_tasks" ? "task" : "backlog item";
  return (
    <form
      className="record-view-move-form record-view-edit-form"
      data-move-form
      data-move-section={section}
      data-source-slug={sourceSlug}
    >
      <label>
        {`Move ${label} ID`}
        <input
          type="text"
          className="record-view-text-input"
          data-move-id
          aria-label={`Move ${label} id`}
        />
      </label>
      <label>
        To project (slug)
        <input
          type="text"
          className="record-view-text-input"
          data-move-target
          aria-label={`Move ${label} to project slug`}
        />
      </label>
      <button
        type="button"
        className="record-view-save-button"
        data-move-action
      >
        Move
      </button>
    </form>
  );
};

/**
 * Whole-record project CREATE (INV-13): a minimal id (globally-unique
 * kebab slug) + title form. `record-create`'s structural defaults
 * (`withCreateDefaults`) fill in every other Project field server-side —
 * `id`/`title` are the only two the schema requires with no inherent
 * empty value. `initiativePath` addresses the parent node this project
 * inserts under (a top-level initiative id or a dotted sub-initiative
 * path) — the enclosing `<section>`/`<div>` always supplies its OWN path.
 */
const CreateProjectForm: React.FC<{ initiativePath: string }> = ({
  initiativePath,
}) => (
  <form
    className="record-view-project-create-form record-view-edit-form"
    data-project-create-form
    data-initiative-path={initiativePath}
  >
    <label>
      New project slug
      <input
        type="text"
        className="record-view-text-input"
        data-project-create-slug
        aria-label="New project slug"
        required
      />
    </label>
    <label>
      Title
      <input
        type="text"
        className="record-view-text-input"
        data-project-create-title
        aria-label="New project title"
        required
      />
    </label>
    <button
      type="button"
      className="record-view-save-button"
      data-project-create-action
    >
      Add project
    </button>
  </form>
);

/**
 * Render one of a project's (or the transitional initiative-level)
 * linked-record list sections. When the array is empty the section
 * renders an inline "none" placeholder rather than being omitted, so the
 * `array-comma` FieldPencil (rendered by the caller, outside this
 * component for projects) always has a visible anchor point.
 */
const LinkedRecordList: React.FC<{
  title: string;
  sectionKey: "linked_tasks" | "linked_backlog";
  ids: readonly string[];
  /** Sibling ledger the ids point at ({20.29}); drives data-cross-ledger. */
  crossLedger: LedgerSlug;
  hrefFor: (id: string) => string;
  labelFor: (id: string) => string;
  existsFor: (id: string) => boolean;
  /** Suppress the internal heading (caller renders its own, e.g. Project's
   * `<h4>`). Defaults to false (roadmap-theme-view parity — own `<h2>`). */
  suppressHeading?: boolean;
}> = ({
  title,
  sectionKey,
  ids,
  crossLedger,
  hrefFor,
  labelFor,
  existsFor,
  suppressHeading,
}) => {
  return (
    <div
      className={`record-view-linked-record-list record-view-${sectionKey.replace("_", "-")}`}
    >
      {!suppressHeading && <h2>{title}</h2>}
      {ids.length === 0 ? (
        <p className="record-view-empty-linked" data-empty-linked>
          <em>None.</em>
        </p>
      ) : (
        <ul>
          {ids.map((id) => (
            <li key={id}>
              <MaybeRecordLink
                href={hrefFor(id)}
                label={labelFor(id)}
                exists={existsFor(id)}
                crossLedger={crossLedger}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
