/**
 * record-view/backlog-reorder.ts — pure rank-recompute core for the
 * interactive Backlog drag/keyboard reorder layer
 * (backlog-drag-reorder SPEC §4.1; DR-4, DR-5).
 *
 * Owns the rank-recompute logic so it is unit-testable without a DOM,
 * mirroring the existing `backlog-sort.ts` / `edit-dispatch.ts` pure-module
 * convention. The DOM-side wiring (`apps/server/web/index.tsx`) derives the
 * tier's new top-to-bottom order from the live rows and hands it here as a
 * minimal `{ id, rank }[]`; this module decides the dense `1..K` rank
 * assignments that reproduce that order under `sortBacklogItemsForIndex`
 * (the sort contract, §0.2), and the minimal changed subset to PATCH.
 *
 * Why a minimal shape (not `BacklogItem`): the SPA dispatcher is data-free
 * by design (index.tsx:6-12) — it reconstructs `{ id, rank }` from the DOM
 * (`data-backlog-row` + `data-rank-value`), so this module has zero schema
 * coupling. The full `BacklogItem` is a structural supertype of `RankedRow`,
 * so existing-item arrays still satisfy it (used by the §10 sort cross-check).
 *
 * Pure / deterministic / referentially-transparent. No React, no DOM,
 * no I/O. Inputs are never mutated. Tested in `backlog-reorder.test.ts`.
 */

/**
 * The minimal per-row shape this module operates on: an item id plus its
 * current rank (`null` for an unset/absent rank — `sortBacklogItemsForIndex`
 * treats `null` and absent identically via `item.rank ?? null`). The full
 * `BacklogItem` is a structural supertype.
 */
export interface RankedRow {
  id: string;
  rank: number | null;
}

/** A single rank assignment to PATCH: `items>{id}>rank = rank`. */
export interface RankAssignment {
  id: string;
  rank: number;
}

/**
 * Given the FULL set of rows in ONE priority tier, in their NEW desired
 * top-to-bottom visual order, return the dense rank assignments (`1..K`) that
 * reproduce that order under `sortBacklogItemsForIndex`, AND the subset whose
 * rank actually CHANGED relative to the row's current rank.
 *
 * Algorithm (SPEC §4.1 — dense renumber `1..K`, top-to-bottom):
 *
 *   for i, row in enumerate(tierItemsInNewOrder):   // i = 0..K-1
 *     newRank = i + 1                                // 1-based dense
 *     assignments.push({ id: row.id, rank: newRank })
 *     if ((row.rank ?? null) !== newRank):
 *       changed.push({ id: row.id, rank: newRank })
 *
 * - `tierItemsInNewOrder`: rows of a single tier, already reordered to the
 *   target visual order (caller derives this from the DOM row order).
 *
 * Returns:
 *   - `assignments`: every row's new dense rank (`1..K`), in order.
 *   - `changed`: only the rows whose new rank !== current (`row.rank ?? null`);
 *     this is the PATCH payload (DR-4 "only changed items"). Previously-`null`
 *     rows that gain a concrete position are included (SPEC §4.2 — a `null`
 *     row now visually above a ranked row CANNOT stay `null` without breaking
 *     DR-5, so the dense renumber pulls it into the explicit order).
 *
 * Notes:
 * - **1-based, dense, contiguous** within the tier. The schema allows any
 *   integers (§0.3) and does not enforce uniqueness/contiguity, but dense
 *   `1..K` is the simplest order-reproducing scheme and keeps the numbers
 *   small/legible in the rank column.
 * - Pure: inputs are not mutated; deterministic.
 */
export function recomputeTierRanks(
  tierItemsInNewOrder: readonly RankedRow[],
): { assignments: RankAssignment[]; changed: RankAssignment[] } {
  const assignments: RankAssignment[] = [];
  const changed: RankAssignment[] = [];

  for (let i = 0; i < tierItemsInNewOrder.length; i += 1) {
    const row = tierItemsInNewOrder[i]!;
    const newRank = i + 1; // 1-based dense, top-to-bottom.
    assignments.push({ id: row.id, rank: newRank });
    // `??` collapses absent (undefined) and explicit null to null so the
    // comparison matches the sort's `item.rank ?? null` semantics.
    const current = row.rank ?? null;
    if (current !== newRank) {
      changed.push({ id: row.id, rank: newRank });
    }
  }

  return { assignments, changed };
}
