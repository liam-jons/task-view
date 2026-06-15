/**
 * record-view/task-list-view.tsx — Task page renderer for Task-list mode.
 *
 * PRODUCT inv 7 (frontmatter + description + Subtasks + nav strip),
 *              8 (Subtask block: frontmatter + description + testStrategy
 *                 + details + journal styling),
 *              9 (empty Subtasks → italic "No subtasks." per Markdown
 *                 shorthand `_No subtasks._` in spec),
 *              10 (CommonMark + GFM floor — delegated to MarkdownBody),
 *              11 (cross-doc-link broken-target marker),
 *              12 (Task dependency broken-target + page-top warning),
 *              13 (sibling-Subtask dep → in-page anchor).
 * TECH §4.1, §4.2 (Task-list column), §4.4, §4.5.
 *
 * Read-only display. ID-20.10 layers in pencil affordances on top of
 * this same surface.
 */
import React from "react";
import type { Task } from "@task-view/schemas/task-list";
import { TaskListStatus, SubtaskStatus } from "@task-view/schemas/task-list";
import {
  MaybeCrossDocLink,
  MaybeRecordLink,
  PageTopWarning,
} from "./broken-target";
import { FieldPencil } from "./field-pencil";
import { NavStrip } from "./nav-strip";
import {
  RecordFrontmatterCard,
  type FrontmatterRow,
} from "./record-frontmatter-card";
import {
  DetailsBodyWithJournal,
  MarkdownBody,
} from "./markdown-renderer";
import {
  activeRecordHref,
  crossLedgerRecordHref,
  subtaskAnchorId,
  subtaskDepLabel,
  subtaskHref,
  taskDepLabel,
  type LedgerSlug,
} from "./anchors";
import { PriorityBadge, StatusBadge } from "./status-badge";
import type { LedgerContext, NavStripData } from "./types";

/**
 * Chip label for the capability_theme cross-ledger row ({20.29} §6).
 * `theme <id>: <title>` when the sibling roadmap resolved a title;
 * bare `theme <id>` otherwise (sibling absent / id missing in the roadmap).
 */
function capabilityThemeChipLabel(
  themeId: string,
  title: string | null,
): string {
  return title !== null ? `theme ${themeId}: ${title}` : `theme ${themeId}`;
}

/**
 * Render the {20.30} reverse cross-ledger backlinks — the roadmap themes
 * whose `linked_tasks` / `linked_backlog` reference THIS record. Each chip is
 * a cross-ledger link to `?ledger=roadmap&record=<themeId>`, with the title
 * resolved from the sibling roadmap when available (bare id otherwise). The
 * caller renders the surrounding frontmatter row only when `themeIds` is
 * non-empty, so this never produces an empty list. Shared by the Task and
 * Backlog item pages (the two reverse-edge targets).
 */
export function renderAppearsInThemes(
  themeIds: readonly string[],
  ledger: Pick<LedgerContext, "roadmapThemesById" | "roadmapThemeIds">,
): React.ReactNode {
  return interleave(
    themeIds.map((themeId) => (
      <MaybeRecordLink
        key={themeId}
        href={crossLedgerRecordHref("roadmap", themeId)}
        label={capabilityThemeChipLabel(
          themeId,
          ledger.roadmapThemesById.get(themeId)?.title ?? null,
        )}
        // The id came FROM a theme in this roadmap, so it resolves; fall back
        // to the presence set defensively (a sibling-less render has neither).
        exists={ledger.roadmapThemeIds.has(themeId)}
        crossLedger="roadmap"
      />
    )),
    ", ",
  );
}

/**
 * URL helper for a commit ref. Form `<base>/commit/<sha>`; when the
 * repo URL is not known, the sha renders as plain text.
 */
function commitRefRow(refs: readonly string[], githubBaseUrl: string | null): React.ReactNode {
  if (refs.length === 0) return null;
  return (
    <>
      {refs.map((sha, i) => {
        const sep = i === 0 ? null : ", ";
        if (!githubBaseUrl) {
          return (
            <React.Fragment key={sha}>
              {sep}
              <code>{sha}</code>
            </React.Fragment>
          );
        }
        return (
          <React.Fragment key={sha}>
            {sep}
            <a
              href={`${githubBaseUrl}/commit/${sha}`}
              data-commit-ref={sha}
            >
              <code>{sha}</code>
            </a>
          </React.Fragment>
        );
      })}
    </>
  );
}

/**
 * Render a Task page (per-`ID-{N}.md` mirror).
 *
 * Required props:
 *   - `task` — typed Task record
 *   - `ledger` — `LedgerContext` for broken-target resolution
 *   - `nav` — nav-strip data for prev/next/index
 * Optional:
 *   - `githubBaseUrl` — for commit-ref links (PRODUCT inv 7 commit refs
 *     "linked to the project's GitHub when applicable")
 */
export const TaskListView: React.FC<{
  task: Task;
  ledger: LedgerContext;
  nav: NavStripData;
  githubBaseUrl?: string | null;
  activeSlug?: LedgerSlug | null;
}> = ({ task, ledger, nav, githubBaseUrl = null, activeSlug }) => {
  // Broken-target detection at render time (page-top warning aggregation).
  const missingTaskDeps = task.dependencies.filter(
    (depId) => !ledger.taskIds.has(depId),
  );
  // Subtask dependencies are sibling-only (schema's superRefine enforces).
  // If any leak through (stray cross-Task ref) they render with the
  // "(missing)" marker per inv 13.
  const siblingSubtaskIds = new Set(task.subtasks.map((s) => s.id));

  const rows: FrontmatterRow[] = [
    {
      key: "status",
      label: "Status",
      value: <StatusBadge status={task.status} />,
      editAffordance: (
        <FieldPencil
          fieldPath={["tasks", task.id, "status"]}
          kind="enum"
          options={TaskListStatus.options}
          ariaLabel={`Edit status for Task ID-${task.id}`}
        />
      ),
    },
    {
      key: "priority",
      label: "Priority",
      value: <PriorityBadge priority={task.priority} />,
    },
    {
      key: "effort_estimate",
      label: "Effort estimate",
      value: task.effort_estimate,
      editAffordance: (
        <FieldPencil
          fieldPath={["tasks", task.id, "effort_estimate"]}
          kind="text"
          ariaLabel={`Edit effort estimate for Task ID-${task.id}`}
        />
      ),
    },
    {
      key: "owner",
      label: "Owner",
      value: task.owner,
      editAffordance: (
        <FieldPencil
          fieldPath={["tasks", task.id, "owner"]}
          kind="text"
          ariaLabel={`Edit owner for Task ID-${task.id}`}
        />
      ),
    },
    {
      key: "updated",
      label: "Updated",
      value: task.updatedAt,
    },
    // {20.29}: capability_theme is a forward cross-ledger edge to the
    // roadmap sibling. Rendered ONLY when set (SPEC §5 slice 5 / §6) as a
    // clickable chip → /?ledger=roadmap&record=<themeId>. The theme title
    // is resolved from the sibling roadmap when the server threads it into
    // the LedgerContext; otherwise the chip falls back to the bare id.
    ...(typeof task.capability_theme === "string" &&
    task.capability_theme !== ""
      ? [
          {
            key: "capability_theme",
            label: "Capability theme",
            value: (
              <MaybeRecordLink
                href={crossLedgerRecordHref("roadmap", task.capability_theme)}
                label={capabilityThemeChipLabel(
                  task.capability_theme,
                  ledger.roadmapThemesById.get(task.capability_theme)?.title ??
                    null,
                )}
                exists={true}
                crossLedger="roadmap"
              />
            ),
          } satisfies FrontmatterRow,
        ]
      : []),
    // {20.30}: reverse cross-ledger backlinks — the roadmap themes whose
    // `linked_tasks` reference this Task (computed at load from the sibling
    // roadmap's forward edges). Distinct from `capability_theme`: a Task can
    // be listed by a theme without that theme being its capability_theme, and
    // a Task with no capability_theme can still appear in a theme. Rendered
    // only when at least one theme references it.
    ...((): FrontmatterRow[] => {
      const themeIds = ledger.themesByLinkedTask.get(task.id) ?? [];
      if (themeIds.length === 0) return [];
      return [
        {
          key: "appears_in_themes",
          label: "Appears in themes",
          value: renderAppearsInThemes(themeIds, ledger),
        },
      ];
    })(),
    {
      key: "session_refs",
      label: "Session refs",
      value:
        task.session_refs.length === 0 ? null : task.session_refs.join(", "),
    },
    {
      key: "commit_refs",
      label: "Commit refs",
      value:
        task.commit_refs.length === 0
          ? null
          : commitRefRow(task.commit_refs, githubBaseUrl),
    },
    {
      key: "dependencies",
      label: "Dependencies",
      value:
        task.dependencies.length === 0
          ? null
          : interleave(
              task.dependencies.map((depId) => (
                <MaybeRecordLink
                  key={depId}
                  href={activeRecordHref(depId, activeSlug)}
                  label={taskDepLabel(depId)}
                  exists={ledger.taskIds.has(depId)}
                />
              )),
              ", ",
            ),
      editAffordance: (
        <FieldPencil
          fieldPath={["tasks", task.id, "dependencies"]}
          kind="array-comma"
          // Raw comma-joined CANONICAL ids (bare strings), not the
          // rendered "ID-N" link labels — so the array-comma editor
          // round-trips the correct values.
          rawValue={task.dependencies.join(",")}
          ariaLabel={`Edit dependencies for Task ID-${task.id}`}
        />
      ),
    },
    {
      key: "cross_doc_links",
      label: "Cross-doc links",
      value:
        task.cross_doc_links.length === 0
          ? null
          : interleave(
              task.cross_doc_links.map((link, i) => (
                <MaybeCrossDocLink
                  key={`${link.path}#${i}`}
                  path={link.path}
                  anchor={link.anchor}
                  label={link.raw}
                  existingPaths={ledger.existingPaths}
                />
              )),
              ", ",
            ),
      editAffordance: (
        <FieldPencil
          fieldPath={["tasks", task.id, "cross_doc_links"]}
          kind="doc-links"
          // JSON-serialised DocLink[] — the dispatcher parses this in openEditor
          // to pre-fill the multi-row editor (ID-20.27).
          rawValue={JSON.stringify(task.cross_doc_links)}
          ariaLabel={`Edit cross-doc links for Task ID-${task.id}`}
        />
      ),
    },
  ];

  return (
    <article
      className="record-view-task-page"
      data-record-kind="task"
      data-record-id={task.id}
    >
      <NavStrip data={nav} />

      <PageTopWarning subject="This Task" missingIds={missingTaskDeps} />

      <header data-edit-container>
        <h1>
          {`ID-${task.id}: `}
          <span className="record-view-field-value">{task.title}</span>
        </h1>
        <FieldPencil
          fieldPath={["tasks", task.id, "title"]}
          kind="text"
          ariaLabel={`Edit title for Task ID-${task.id}`}
        />
      </header>

      <RecordFrontmatterCard
        rows={rows}
        ariaLabel={`Task ID-${task.id} metadata`}
      />

      <section
        className="record-view-task-description"
        data-section="description"
        data-edit-container
      >
        <span className="record-view-field-value">
          <MarkdownBody markdown={task.description} />
        </span>
        <FieldPencil
          fieldPath={["tasks", task.id, "description"]}
          kind="textarea"
          rawValue={task.description}
          ariaLabel={`Edit description for Task ID-${task.id}`}
        />
      </section>

      {task.priority_note !== null && (
        <p className="record-view-priority-note" data-priority-note>
          <strong>Priority note:</strong> <em>{task.priority_note}</em>
        </p>
      )}
      {task.status_note !== null && (
        <p className="record-view-status-note" data-status-note>
          <strong>Status note:</strong> <em>{task.status_note}</em>
        </p>
      )}

      <section
        className="record-view-task-subtasks"
        data-section="subtasks"
      >
        <h2>Subtasks</h2>
        {task.subtasks.length === 0 ? (
          // PRODUCT inv 9 — `_No subtasks._` is Markdown-italic shorthand;
          // surface as <em>No subtasks.</em> with no literal underscores
          // in the rendered DOM. (S63 WP5c Checker Finding-1 Option A
          // ratification.)
          <p className="record-view-empty-subtasks" data-empty-subtasks>
            <em>No subtasks.</em>
          </p>
        ) : (
          task.subtasks.map((subtask) => (
            <SubtaskBlock
              key={subtask.id}
              parentTaskId={task.id}
              subtask={subtask}
              siblingSubtaskIds={siblingSubtaskIds}
            />
          ))
        )}
      </section>
    </article>
  );
};

/**
 * Render a single Subtask block within a Task page (PRODUCT inv 8).
 *
 * Sibling-Subtask dependencies render as in-page anchor links per inv 13.
 * If a stray cross-Task dep slipped through schema validation (which
 * would mean the canonical JSON failed validation), it renders with the
 * "(missing)" marker per inv 12-13 contract.
 */
const SubtaskBlock: React.FC<{
  parentTaskId: string;
  subtask: import("@task-view/schemas/task-list").Subtask;
  siblingSubtaskIds: ReadonlySet<string>;
}> = ({ parentTaskId, subtask, siblingSubtaskIds }) => {
  const depRows: React.ReactNode =
    subtask.dependencies.length === 0
      ? null
      : interleave(
          subtask.dependencies.map((depId) => {
            const exists = siblingSubtaskIds.has(depId);
            const label = subtaskDepLabel(parentTaskId, depId);
            return (
              <MaybeRecordLink
                key={depId}
                href={subtaskHref(depId)}
                label={label}
                exists={exists}
              />
            );
          }),
          ", ",
        );

  // Subtask field paths are addressed relative to the parent Task:
  // ['tasks', taskId, 'subtasks', subtaskId, field]. The recordId the
  // dispatcher resolves walks up to the Task's data-record-id (the PATCH
  // route is per-Task); the fieldPath carries the subtask addressing.
  const subPath = (field: string): string[] => [
    "tasks",
    parentTaskId,
    "subtasks",
    subtask.id,
    field,
  ];

  const rows: FrontmatterRow[] = [
    {
      key: "status",
      label: "Status",
      value: <StatusBadge status={subtask.status} />,
      editAffordance: (
        <FieldPencil
          fieldPath={subPath("status")}
          kind="enum"
          options={SubtaskStatus.options}
          ariaLabel={`Edit status for Subtask ID-${parentTaskId}.${subtask.id}`}
        />
      ),
    },
    {
      key: "dependencies",
      label: "Dependencies",
      value: depRows,
      editAffordance: (
        <FieldPencil
          fieldPath={subPath("dependencies")}
          kind="array-comma"
          rawValue={subtask.dependencies.join(",")}
          ariaLabel={`Edit dependencies for Subtask ID-${parentTaskId}.${subtask.id}`}
        />
      ),
    },
    {
      key: "updated",
      label: "Updated",
      value: subtask.updatedAt ?? null,
    },
  ];

  return (
    <section
      className="record-view-subtask-block"
      data-subtask-id={subtask.id}
      id={subtaskAnchorId(subtask.id)}
    >
      <h3 data-edit-container>
        {`ID-${parentTaskId}.${subtask.id}: `}
        <span className="record-view-field-value">{subtask.title}</span>
        <FieldPencil
          fieldPath={subPath("title")}
          kind="text"
          ariaLabel={`Edit title for Subtask ID-${parentTaskId}.${subtask.id}`}
        />
      </h3>

      <RecordFrontmatterCard
        rows={rows}
        ariaLabel={`Subtask ID-${parentTaskId}.${subtask.id} metadata`}
      />

      <p
        className="record-view-subtask-description"
        data-subtask-description
        data-edit-container
      >
        <span className="record-view-field-value">{subtask.description}</span>
        <FieldPencil
          fieldPath={subPath("description")}
          kind="textarea"
          rawValue={subtask.description}
          ariaLabel={`Edit description for Subtask ID-${parentTaskId}.${subtask.id}`}
        />
      </p>

      {subtask.testStrategy !== null && (
        <p
          className="record-view-test-strategy"
          data-test-strategy
          data-edit-container
        >
          <strong>Test strategy:</strong>{" "}
          <span className="record-view-field-value">
            {subtask.testStrategy}
          </span>
          <FieldPencil
            fieldPath={subPath("testStrategy")}
            kind="textarea"
            rawValue={subtask.testStrategy}
            ariaLabel={`Edit test strategy for Subtask ID-${parentTaskId}.${subtask.id}`}
          />
        </p>
      )}

      <div
        className="record-view-subtask-details-label"
        data-details-label
      >
        <strong>Details:</strong>
      </div>
      <div className="record-view-subtask-details" data-edit-container>
        <span className="record-view-field-value">
          <DetailsBodyWithJournal details={subtask.details} />
        </span>
        <FieldPencil
          fieldPath={subPath("details")}
          kind="textarea"
          // Full raw details string incl. <info added on …> journal
          // blocks (PRODUCT inv 28) — no gating, no auto-injection.
          rawValue={subtask.details}
          ariaLabel={`Edit details for Subtask ID-${parentTaskId}.${subtask.id}`}
        />
      </div>
    </section>
  );
};

/**
 * Interleave a list of nodes with a string separator.
 * E.g. `interleave([a, b, c], ", ")` → `[a, ", ", b, ", ", c]`.
 */
function interleave(
  nodes: readonly React.ReactNode[],
  sep: string,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  nodes.forEach((node, i) => {
    if (i > 0) {
      out.push(
        <React.Fragment key={`sep-${i}`}>{sep}</React.Fragment>,
      );
    }
    out.push(node);
  });
  return out;
}
