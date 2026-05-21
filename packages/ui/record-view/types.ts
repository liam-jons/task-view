/**
 * record-view/types.ts — shared rendering types for the per-record viewer
 * (ID-20.9 read mode).
 *
 * The read-mode renderer consumes typed records (Task / RoadmapSection /
 * RoadmapItem / BacklogItem) from the parsed canonical ledger — NOT
 * re-parsed Markdown frontmatter. Per the End-to-end flow diagram in
 * TECH §End-to-end, the SPA fetches `/api/ledger/record/:id` and receives
 * `{ record, mirror, mtime }`; we render from `record` directly.
 *
 * The `LedgerContext` object lets each rendered page look up sibling
 * records for broken-target detection (PRODUCT inv 11, 12, 13, 22) and
 * owner inheritance (PRODUCT inv 18). It is intentionally minimal — just
 * the lookup tables the renderer needs.
 */
import type { Task } from "@task-view/schemas/task-list";
import type {
  Roadmap,
  RoadmapItem,
  RoadmapSection,
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
 * - `taskIds` / `roadmapItemIds` / `roadmapSectionIds` / `backlogItemIds`
 *   are presence sets used by the broken-target marker to decide whether
 *   a Task / Roadmap / Backlog dependency link is live or missing.
 * - `roadmapSectionsById` enables Roadmap owner inheritance (inv 18).
 * - `existingPaths` enables cross-doc-link existence checks (inv 11). May
 *   be `null` for environments where filesystem existence cannot be
 *   verified (e.g. the SPA running offline against a remote mirror).
 */
export interface LedgerContext {
  taskIds: ReadonlySet<string>;
  roadmapItemIds: ReadonlySet<string>;
  roadmapSectionIds: ReadonlySet<string>;
  backlogItemIds: ReadonlySet<string>;
  /** Roadmap section lookup table for owner inheritance display. */
  roadmapSectionsById: ReadonlyMap<string, RoadmapSection>;
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
  const roadmapItemIds = new Set<string>();
  const roadmapSectionIds = new Set<string>();
  const roadmapSectionsById = new Map<string, RoadmapSection>();
  if (input.roadmap) {
    for (const section of input.roadmap.sections) {
      roadmapSectionIds.add(section.id);
      roadmapSectionsById.set(section.id, section);
      for (const item of section.items) {
        roadmapItemIds.add(item.id);
      }
    }
  }
  const backlogItemIds = new Set<string>(
    input.backlogItems?.map((i) => i.id) ?? [],
  );
  return {
    taskIds,
    roadmapItemIds,
    roadmapSectionIds,
    backlogItemIds,
    roadmapSectionsById,
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

export type { Task, RoadmapSection, RoadmapItem, BacklogItem };
