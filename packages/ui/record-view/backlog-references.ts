/**
 * record-view/backlog-references.ts — pure dangling-reference scan for
 * backlog deletion (backlog-ui-delete).
 *
 * The ledger schemas (backlog-schema.ts / roadmap-schema.ts) carry NO
 * referential-integrity constraint: `BacklogItem.dependencies[]` and
 * `RoadmapTheme.linked_backlog[]` are plain `z.array(z.string())`. So
 * deleting a backlog item can leave other items + roadmap themes
 * pointing at a now-missing id. This scan finds those references so the
 * delete-confirmation UX can warn the user before the orphaning happens.
 *
 * No React. No DOM. No I/O. Referentially transparent.
 */
import type { BacklogItem } from "@task-view/schemas/backlog";
import type { Roadmap, RoadmapTheme } from "@task-view/schemas/roadmap";

export interface BacklogReferences {
  /** Other backlog items whose `dependencies[]` include the target id. */
  dependents: BacklogItem[];
  /** Roadmap themes whose `linked_backlog[]` include the target id. */
  themes: RoadmapTheme[];
  /** True when any dependent or theme references the id. */
  hasReferences: boolean;
}

export interface BacklogReferenceSources {
  items: readonly BacklogItem[];
  /** The sibling roadmap, when one is threaded in. Optional / nullable. */
  roadmap?: Roadmap | null;
}

/**
 * Scan for references to a backlog id that deletion would orphan.
 *
 * The target id is never reported as its own dependent (a self-edge in
 * `dependencies[]` is dropped — deleting the record removes that edge too).
 * Declaration order is preserved for both lists.
 */
export function findBacklogReferences(
  id: string,
  sources: BacklogReferenceSources,
): BacklogReferences {
  const dependents = sources.items.filter(
    (entry) => entry.id !== id && entry.dependencies.includes(id),
  );

  const themes = (sources.roadmap?.themes ?? []).filter((theme) =>
    theme.linked_backlog.includes(id),
  );

  return {
    dependents,
    themes,
    hasReferences: dependents.length > 0 || themes.length > 0,
  };
}
