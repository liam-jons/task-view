/**
 * record-view/types.ts — shared rendering types for the per-record viewer
 * (ID-20.9 read mode).
 *
 * The read-mode renderer consumes typed records (Task / RoadmapTheme /
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
 * Roadmap shape note (ID-20.19): the Phase-B themes[] roadmap replaced the
 * retired sections[]/items[] model. A Roadmap is now a flat list of
 * `RoadmapTheme` records; there is no separate item layer.
 */
import type { Task } from "@task-view/schemas/task-list";
import type {
  Roadmap,
  RoadmapTheme,
} from "@task-view/schemas/roadmap";
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
 * - `taskIds` / `roadmapThemeIds` / `backlogItemIds` are presence sets
 *   used by the broken-target marker to decide whether a Task / Roadmap /
 *   Backlog dependency link is live or missing.
 * - `roadmapThemesById` enables Roadmap theme lookups (e.g. resolving a
 *   linked-task back-reference's parent theme).
 * - `themesByLinkedTask` / `themesByLinkedBacklog` are the {20.30} REVERSE
 *   cross-ledger index — a record id → the ids of the roadmap themes that
 *   reference it via `linked_tasks` / `linked_backlog`. Computed at
 *   render-load from the roadmap's forward edges (OQ-P1 option (a): a
 *   fork-only, server-computed inverse index — NO ledger-contract change).
 *   Empty when no roadmap is threaded in.
 * - `existingPaths` enables cross-doc-link existence checks (inv 11). May
 *   be `null` for environments where filesystem existence cannot be
 *   verified (e.g. the SPA running offline against a remote mirror).
 */
export interface LedgerContext {
  taskIds: ReadonlySet<string>;
  roadmapThemeIds: ReadonlySet<string>;
  backlogItemIds: ReadonlySet<string>;
  /** Roadmap theme lookup table by theme id. */
  roadmapThemesById: ReadonlyMap<string, RoadmapTheme>;
  /**
   * {20.30}: task id → ids of roadmap themes whose `linked_tasks` include it
   * (the reverse of the forward Roadmap → Task edge). Theme ids preserve
   * roadmap declaration order and are deduped per task.
   */
  themesByLinkedTask: ReadonlyMap<string, readonly string[]>;
  /**
   * {20.30}: backlog id → ids of roadmap themes whose `linked_backlog`
   * include it (the reverse of the forward Roadmap → Backlog edge). This is
   * the ONLY backlog → roadmap nav path — backlog records carry no roadmap
   * pointer field.
   */
  themesByLinkedBacklog: ReadonlyMap<string, readonly string[]>;
  /** Verified-existing repo-relative paths for cross-doc-link checks. */
  existingPaths: ExistingPathsSet;
}

/**
 * Build a `LedgerContext` from the parsed ledgers known at render time.
 *
 * Either of `tasks`, `roadmap`, `backlogItems` may be omitted depending
 * on which ledger the viewer is rendering — only the active mode's set is
 * meaningful for in-mode dependency checks. Out-of-mode sets default to
 * empty (any cross-mode dep would be flagged as missing, but the schemas
 * disallow cross-mode deps so this is a defensive default).
 */
export function buildLedgerContext(input: {
  tasks?: readonly Task[];
  roadmap?: Roadmap;
  backlogItems?: readonly BacklogItem[];
  existingPaths?: ExistingPathsSet;
}): LedgerContext {
  const taskIds = new Set<string>(input.tasks?.map((t) => t.id) ?? []);
  const roadmapThemeIds = new Set<string>();
  const roadmapThemesById = new Map<string, RoadmapTheme>();
  // {20.30}: reverse cross-ledger index, built at render-load from the
  // roadmap's forward edges. A theme is appended to a record's list at most
  // once (dedupe guards a record id repeated inside one theme's array); the
  // outer theme loop preserves roadmap declaration order across themes.
  const themesByLinkedTask = new Map<string, string[]>();
  const themesByLinkedBacklog = new Map<string, string[]>();
  if (input.roadmap) {
    for (const theme of input.roadmap.themes) {
      roadmapThemeIds.add(theme.id);
      roadmapThemesById.set(theme.id, theme);
      addReverseEdges(themesByLinkedTask, theme.id, theme.linked_tasks);
      addReverseEdges(themesByLinkedBacklog, theme.id, theme.linked_backlog);
    }
  }
  const backlogItemIds = new Set<string>(
    input.backlogItems?.map((i) => i.id) ?? [],
  );
  return {
    taskIds,
    roadmapThemeIds,
    backlogItemIds,
    roadmapThemesById,
    themesByLinkedTask,
    themesByLinkedBacklog,
    existingPaths: input.existingPaths ?? null,
  };
}

/**
 * Append `themeId` to every referenced record's reverse-edge list ({20.30}),
 * skipping ids already present for this theme so a record repeated inside one
 * theme's link array yields a single backlink.
 */
function addReverseEdges(
  index: Map<string, string[]>,
  themeId: string,
  referencedIds: readonly string[],
): void {
  for (const recordId of referencedIds) {
    const themes = index.get(recordId);
    if (themes === undefined) {
      index.set(recordId, [themeId]);
    } else if (!themes.includes(themeId)) {
      themes.push(themeId);
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

export type { Task, RoadmapTheme, BacklogItem };
