/**
 * record-view/types.ts — shared rendering types for the per-record viewer
 * (ID-20.9 read mode).
 *
 * The read-mode renderer consumes typed records (Task / Project /
 * BacklogItem) from the parsed canonical ledger — NOT re-parsed Markdown
 * frontmatter. Per the End-to-end flow diagram in TECH §End-to-end, the
 * SPA fetches `/api/ledger/record/:id` and receives `{ record, mirror,
 * mtime }`; we render from `record` directly.
 *
 * The `LedgerContext` object lets each rendered page look up sibling
 * records for broken-target detection (PRODUCT inv 11, 12, 13, 22) and
 * cross-record linking. It is intentionally minimal — just the lookup
 * tables the renderer needs.
 *
 * ID-148.10 (repurposed roadmap arm): Initiatives replaced Roadmap. Unlike
 * the flat `RoadmapTheme[]` list, `initiatives[]` is a TREE
 * (`initiatives[]` -> `projects[]` + recursive `sub-initiatives[]`). The
 * reverse cross-ledger index below is keyed by PROJECT (the only node kind
 * that carries `linked_tasks`/`linked_backlog` in steady state — INV-6
 * "links are project-only") and is built by walking the whole tree, not a
 * single flat array.
 */
import type { Task } from "@task-view/schemas/task-list";
import type {
  InitiativesDocument,
  Initiative,
  SubInitiative,
  Project,
} from "@task-view/schemas/initiatives";
import type { BacklogItem } from "@task-view/schemas/backlog";

/**
 * Repo-relative paths whose existence has been verified at render time.
 * Used by the broken-target marker (PRODUCT inv 11) to decide whether a
 * cross-doc link renders normally or with the "(missing target)" suffix.
 *
 * `null` means "no existence check available" — the renderer must
 * conservatively render links as live (no marker), matching the
 * non-existence-checked baseline.
 */
export type ExistingPathsSet = ReadonlySet<string> | null;

/**
 * Ledger-wide context every per-record page can interrogate.
 *
 * - `taskIds` / `projectIds` / `backlogItemIds` are presence sets used by
 *   the broken-target marker to decide whether a Task / Project / Backlog
 *   dependency link is live or missing. `projectIds` is the
 *   GLOBALLY-UNIQUE slug set flattened tree-wide (INV-13 — a project may
 *   live at any depth under `initiatives[]`/`sub-initiatives[]`).
 * - `projectsBySlug` enables Project lookups (e.g. resolving a linked-task
 *   back-reference's parent project) by its globally-unique slug,
 *   regardless of nesting depth.
 * - `projectsByLinkedTask` / `projectsByLinkedBacklog` are the {20.30}
 *   REVERSE cross-ledger index — a record id → the SLUGS of the projects
 *   that reference it via `linked_tasks` / `linked_backlog`. Computed at
 *   render-load from every project's forward edges, tree-wide (INV-6:
 *   links are project-only — initiatives/sub-initiatives never carry
 *   these fields in steady state, so the walk only needs to visit
 *   projects). Empty when no initiatives document is threaded in.
 * - `existingPaths` enables cross-doc-link existence checks (inv 11). May
 *   be `null` for environments where filesystem existence cannot be
 *   verified (e.g. the SPA running offline against a remote mirror).
 */
export interface LedgerContext {
  taskIds: ReadonlySet<string>;
  projectIds: ReadonlySet<string>;
  backlogItemIds: ReadonlySet<string>;
  /** Project lookup table by globally-unique slug (tree-wide). */
  projectsBySlug: ReadonlyMap<string, Project>;
  /**
   * {20.30}: task id → slugs of projects whose `linked_tasks` include it
   * (the reverse of the forward Project → Task edge). Project slugs
   * preserve tree declaration order (depth-first) and are deduped per task.
   */
  projectsByLinkedTask: ReadonlyMap<string, readonly string[]>;
  /**
   * {20.30}: backlog id → slugs of projects whose `linked_backlog` include
   * it (the reverse of the forward Project → Backlog edge). This is the
   * ONLY backlog → initiatives nav path — backlog records carry no
   * initiatives pointer field.
   */
  projectsByLinkedBacklog: ReadonlyMap<string, readonly string[]>;
  /** Verified-existing repo-relative paths for cross-doc-link checks. */
  existingPaths: ExistingPathsSet;
}

/**
 * Build a `LedgerContext` from the parsed ledgers known at render time.
 *
 * Either of `tasks`, `initiatives`, `backlogItems` may be omitted depending
 * on which ledger the viewer is rendering — only the active mode's set is
 * meaningful for in-mode dependency checks. Out-of-mode sets default to
 * empty (any cross-mode dep would be flagged as missing, but the schemas
 * disallow cross-mode deps so this is a defensive default).
 */
export function buildLedgerContext(input: {
  tasks?: readonly Task[];
  initiatives?: InitiativesDocument;
  backlogItems?: readonly BacklogItem[];
  existingPaths?: ExistingPathsSet;
}): LedgerContext {
  const taskIds = new Set<string>(input.tasks?.map((t) => t.id) ?? []);
  const projectIds = new Set<string>();
  const projectsBySlug = new Map<string, Project>();
  // {20.30}: reverse cross-ledger index, built at render-load from every
  // project's forward edges (tree-wide walk — INV-13). A project is
  // appended to a record's list at most once (dedupe guards a record id
  // repeated inside one project's array); the depth-first walk preserves
  // tree declaration order across projects.
  const projectsByLinkedTask = new Map<string, string[]>();
  const projectsByLinkedBacklog = new Map<string, string[]>();
  if (input.initiatives) {
    for (const initiative of input.initiatives.initiatives) {
      walkNodeForContext(
        initiative,
        projectIds,
        projectsBySlug,
        projectsByLinkedTask,
        projectsByLinkedBacklog,
      );
    }
  }
  const backlogItemIds = new Set<string>(
    input.backlogItems?.map((i) => i.id) ?? [],
  );
  return {
    taskIds,
    projectIds,
    backlogItemIds,
    projectsBySlug,
    projectsByLinkedTask,
    projectsByLinkedBacklog,
    existingPaths: input.existingPaths ?? null,
  };
}

/**
 * Depth-first walk of one initiative/sub-initiative node's `projects[]` +
 * recursive `sub-initiatives[]`, populating the flattened lookup tables
 * `buildLedgerContext` returns (INV-13 — projects live at any depth).
 */
function walkNodeForContext(
  node: Initiative | SubInitiative,
  projectIds: Set<string>,
  projectsBySlug: Map<string, Project>,
  projectsByLinkedTask: Map<string, string[]>,
  projectsByLinkedBacklog: Map<string, string[]>,
): void {
  for (const project of node.projects) {
    projectIds.add(project.id);
    projectsBySlug.set(project.id, project);
    addReverseEdges(projectsByLinkedTask, project.id, project.linked_tasks);
    addReverseEdges(
      projectsByLinkedBacklog,
      project.id,
      project.linked_backlog,
    );
  }
  for (const sub of node["sub-initiatives"]) {
    walkNodeForContext(
      sub,
      projectIds,
      projectsBySlug,
      projectsByLinkedTask,
      projectsByLinkedBacklog,
    );
  }
}

/**
 * Append `projectSlug` to every referenced record's reverse-edge list
 * ({20.30}), skipping slugs already present for this project so a record
 * repeated inside one project's link array yields a single backlink.
 */
function addReverseEdges(
  index: Map<string, string[]>,
  projectSlug: string,
  referencedIds: readonly string[],
): void {
  for (const recordId of referencedIds) {
    const projects = index.get(recordId);
    if (projects === undefined) {
      index.set(recordId, [projectSlug]);
    } else if (!projects.includes(projectSlug)) {
      projects.push(projectSlug);
    }
  }
}

/**
 * Per-page navigation strip data — populated by the caller (SPA) so the
 * renderer stays mode-agnostic. `prev` / `next` are nullable for first /
 * last record edges.
 */
export interface NavStripData {
  prevHref: string | null;
  prevLabel: string | null;
  nextHref: string | null;
  nextLabel: string | null;
  indexHref: string;
  indexLabel: string;
}

export type { Task, Initiative, SubInitiative, Project, BacklogItem };
