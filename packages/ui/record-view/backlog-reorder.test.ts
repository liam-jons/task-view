/**
 * backlog-reorder.test.ts — verifies the pure rank-recompute core for the
 * interactive Backlog reorder layer (backlog-drag-reorder SPEC §4.1, §10.1;
 * DR-4, DR-5).
 *
 * Pure-function tests; no React, no DOM. The final assertion in each case
 * is the DR-5 cross-check: applying the computed `assignments` to real
 * BacklogItem-shaped objects and running `sortBacklogItemsForIndex` must
 * reproduce the input visual order — tying this module to the real sort
 * contract (`backlog-sort.ts`).
 */
import { describe, expect, test } from "bun:test";
import type { BacklogItem } from "@task-view/schemas/backlog";
import { recomputeTierRanks, type RankedRow } from "./backlog-reorder";
import { sortBacklogItemsForIndex } from "./backlog-sort";

/**
 * Minimal valid BacklogItem for the sort cross-check (mirrors the mkItem
 * patterns in backlog-item-view.test.tsx / backlog-sort.test.ts). All rows
 * in these tests live in one tier, so `priority` is constant per case.
 */
const mkItem = (overrides: Partial<BacklogItem> = {}): BacklogItem => ({
  id: "1",
  description: "Item.",
  type: "feature",
  status: "ready",
  effort_estimate: null,
  priority: "must",
  track: "Platform",
  dependencies: [],
  session_refs: [],
  commit_refs: [],
  cross_doc_links: [],
  notes: null,
  ...overrides,
});

/**
 * DR-5 cross-check helper: build BacklogItems for the tier in `newOrder`,
 * apply the computed dense `assignments`, run the REAL sort, and assert it
 * reproduces the input visual order (`newOrder`'s id sequence).
 */
function assertSortReproducesOrder(
  newOrder: readonly RankedRow[],
  priority: BacklogItem["priority"] = "must",
): void {
  const { assignments } = recomputeTierRanks(newOrder);
  const rankById = new Map(assignments.map((a) => [a.id, a.rank]));
  // Build items in a deliberately SHUFFLED input order so the sort, not the
  // construction order, is what reproduces the visual order.
  const items = [...newOrder]
    .map((row) => mkItem({ id: row.id, priority, rank: rankById.get(row.id)! }))
    .reverse();
  const sorted = sortBacklogItemsForIndex(items);
  expect(sorted.map((i) => i.id)).toEqual(newOrder.map((r) => r.id));
}

describe("recomputeTierRanks — dense renumber 1..K (SPEC §4.1)", () => {
  test("dense renumber for a simple reorder; changed = only moved items", () => {
    // Tier currently [A:1, B:2, C:3]; user swaps B above A → [B, A, C].
    const newOrder: RankedRow[] = [
      { id: "B", rank: 2 },
      { id: "A", rank: 1 },
      { id: "C", rank: 3 },
    ];
    const { assignments, changed } = recomputeTierRanks(newOrder);
    expect(assignments).toEqual([
      { id: "B", rank: 1 },
      { id: "A", rank: 2 },
      { id: "C", rank: 3 },
    ]);
    // C did not move (still rank 3) → not in changed; only A and B moved.
    expect(changed).toEqual([
      { id: "B", rank: 1 },
      { id: "A", rank: 2 },
    ]);
    assertSortReproducesOrder(newOrder);
  });

  test("§4.2 worked example: [A1,B2,C∅,D∅] → drag A to bottom → B:1,C:2,D:3,A:4 (all changed)", () => {
    // Visual order the user sees: A(1), B(2), then C/D (null, sorted last by id).
    // User drags A to the bottom → new visual order [B, C, D, A].
    const newOrder: RankedRow[] = [
      { id: "B", rank: 2 },
      { id: "C", rank: null },
      { id: "D", rank: null },
      { id: "A", rank: 1 },
    ];
    const { assignments, changed } = recomputeTierRanks(newOrder);
    expect(assignments).toEqual([
      { id: "B", rank: 1 },
      { id: "C", rank: 2 },
      { id: "D", rank: 3 },
      { id: "A", rank: 4 },
    ]);
    // Every row's rank changed: B 2→1, C null→2, D null→3, A 1→4.
    expect(changed).toEqual([
      { id: "B", rank: 1 },
      { id: "C", rank: 2 },
      { id: "D", rank: 3 },
      { id: "A", rank: 4 },
    ]);
    assertSortReproducesOrder(newOrder);
  });

  test("absent rank (key omitted, undefined) is treated as null", () => {
    // RankedRow.rank is `number | null`, but the `?? null` collapse must also
    // hold for a structurally-wider input whose rank is `undefined`.
    const newOrder = [
      { id: "X", rank: undefined },
      { id: "Y", rank: 5 },
    ] as unknown as RankedRow[];
    const { assignments, changed } = recomputeTierRanks(newOrder);
    expect(assignments).toEqual([
      { id: "X", rank: 1 },
      { id: "Y", rank: 2 },
    ]);
    // X undefined→1 (changed), Y 5→2 (changed).
    expect(changed).toEqual([
      { id: "X", rank: 1 },
      { id: "Y", rank: 2 },
    ]);
  });

  test("no-op: unchanged order → changed empty (already dense 1..K)", () => {
    const newOrder: RankedRow[] = [
      { id: "A", rank: 1 },
      { id: "B", rank: 2 },
      { id: "C", rank: 3 },
    ];
    const { assignments, changed } = recomputeTierRanks(newOrder);
    expect(assignments).toEqual([
      { id: "A", rank: 1 },
      { id: "B", rank: 2 },
      { id: "C", rank: 3 },
    ]);
    expect(changed).toEqual([]);
    assertSortReproducesOrder(newOrder);
  });

  test("idempotence: feeding the output order back yields changed empty", () => {
    const start: RankedRow[] = [
      { id: "B", rank: 2 },
      { id: "C", rank: null },
      { id: "D", rank: null },
      { id: "A", rank: 1 },
    ];
    const first = recomputeTierRanks(start);
    // Re-feed the SAME order but with the freshly-assigned dense ranks.
    const rankById = new Map(first.assignments.map((a) => [a.id, a.rank]));
    const second = recomputeTierRanks(
      start.map((row) => ({ id: row.id, rank: rankById.get(row.id)! })),
    );
    expect(second.changed).toEqual([]);
    expect(second.assignments).toEqual(first.assignments);
  });

  test("does not mutate the input array or its rows", () => {
    const newOrder: RankedRow[] = [
      { id: "A", rank: 9 },
      { id: "B", rank: null },
    ];
    const before = newOrder.map((r) => ({ id: r.id, rank: r.rank }));
    recomputeTierRanks(newOrder);
    expect(newOrder).toEqual(before);
  });

  test("single-item tier → rank 1; changed empty when already 1", () => {
    expect(recomputeTierRanks([{ id: "solo", rank: 1 }]).changed).toEqual([]);
    expect(recomputeTierRanks([{ id: "solo", rank: null }]).changed).toEqual([
      { id: "solo", rank: 1 },
    ]);
  });

  test("empty tier → empty assignments and changed", () => {
    expect(recomputeTierRanks([])).toEqual({ assignments: [], changed: [] });
  });
});
