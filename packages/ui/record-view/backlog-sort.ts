/**
 * record-view/backlog-sort.ts — sort helper for Backlog index page
 * (roadmap-backlog-consolidation PRODUCT inv 4, 10; TECH §2 inv 10 row;
 * Subtask 30.8 — per-task-mirror 20.14 extension).
 *
 * Sort order on the Backlog index specifically: `priority → rank (nulls
 * last within tier) → id` per inv 10. Replaces the legacy `track →
 * status → id` ordering inherited from per-task-mirror inv 20 — the
 * roadmap-backlog-consolidation invariant SUPERSEDES the per-task-mirror
 * default on this surface.
 *
 * Priority ordinal order matches the canonical `Priority` enum from
 * `@task-view/schemas/work-status` so MoSCoW + ranked + trigger values
 * sort consistently. `rank: null` sorts after all ranked items within
 * its priority tier. `id` is the stable tiebreaker (numeric-friendly so
 * "10" sorts after "9", not after "1").
 *
 * Pure / deterministic / referentially-transparent. No React, no DOM,
 * no I/O. Tested in `backlog-sort.test.ts`.
 */
import type { BacklogItem } from "@task-view/schemas/backlog";
import { Priority } from "@task-view/schemas/work-status";

/**
 * Priority enum ordinal map. Mirrors the canonical order from
 * `lib/validation/work-status.ts` (and its task-view vendor) so the
 * Backlog index sort matches the shared Priority semantics.
 *
 * MoSCoW values (must, should, could, future) lead the sort, then the
 * ranked values (high, medium, low), then trigger. Within each tier the
 * `rank` field provides finer ordering per inv 10.
 */
export const PRIORITY_ORDINALS: Readonly<Record<Priority, number>> = {
  must: 0,
  should: 1,
  could: 2,
  future: 3,
  high: 4,
  medium: 5,
  low: 6,
  trigger: 7,
};

type PriorityValue = (typeof Priority.options)[number];

/**
 * Sort Backlog items by `priority → rank (nulls last) → id`. Stable —
 * ties on all three keys retain input order.
 *
 * Pure: input array is not mutated; a new array is returned.
 */
export function sortBacklogItemsForIndex(
  items: readonly BacklogItem[],
): BacklogItem[] {
  // Decorate-sort-undecorate to preserve stability across ties.
  const decorated = items.map((item, idx) => ({ item, idx }));
  decorated.sort((a, b) => {
    // 1. Priority ordinal.
    const pa = PRIORITY_ORDINALS[a.item.priority as PriorityValue];
    const pb = PRIORITY_ORDINALS[b.item.priority as PriorityValue];
    if (pa !== pb) return pa - pb;

    // 2. Rank within tier; nulls last.
    const ra = a.item.rank ?? null;
    const rb = b.item.rank ?? null;
    if (ra !== rb) {
      if (ra === null) return 1;
      if (rb === null) return -1;
      return ra - rb;
    }

    // 3. Id stable tiebreaker, numeric-friendly so "10" sorts after "9".
    if (a.item.id !== b.item.id) {
      const an = Number.parseInt(a.item.id, 10);
      const bn = Number.parseInt(b.item.id, 10);
      if (!Number.isNaN(an) && !Number.isNaN(bn)) {
        return an - bn;
      }
      return a.item.id < b.item.id ? -1 : 1;
    }

    // 4. Stability — preserve input order on full tie.
    return a.idx - b.idx;
  });
  return decorated.map((d) => d.item);
}
