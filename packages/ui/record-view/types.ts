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
  if (input.roadmap) {
    for (const theme of input.roadmap.themes) {
      roadmapThemeIds.add(theme.id);
      roadmapThemesById.set(theme.id, theme);
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
    existingPaths: input.existingPaths ?? null,
  };
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
