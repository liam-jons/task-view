/**
 * backlog-sort.test.ts — verifies sort order on the Backlog index per
 * roadmap-backlog-consolidation PRODUCT inv 4, 10 (Subtask 30.8).
 *
 * Sort order: priority → rank (nulls last) → id.
 *
 * Pure-function tests; no React, no DOM.
 */
import { describe, expect, test } from "bun:test";
import type { BacklogItem } from "@task-view/schemas/backlog";
import { sortBacklogItemsForIndex, PRIORITY_ORDINALS } from "./backlog-sort";

const mkItem = (overrides: Partial<BacklogItem> = {}): BacklogItem => ({
  id: "1",
  description: "Item.",
  type: "feature",
  status: "ready",
  effort_estimate: null,
  priority: "should",
  track: "Platform",
  dependencies: [],
  session_refs: [],
  commit_refs: [],
  cross_doc_links: [],
  notes: null,
  ...overrides,
});

describe("sortBacklogItemsForIndex — priority → rank (nulls last) → id", () => {
  test("sorts by priority ordinal first", () => {
    const items = [
      mkItem({ id: "1", priority: "could" }),
      mkItem({ id: "2", priority: "must" }),
      mkItem({ id: "3", priority: "should" }),
    ];
    const sorted = sortBacklogItemsForIndex(items);
    expect(sorted.map((i) => i.priority)).toEqual([
      "must",
      "should",
      "could",
    ]);
  });

  test("sorts MoSCoW + ranked + trigger in canonical ordinal order", () => {
    const items = [
      mkItem({ id: "1", priority: "trigger" }),
      mkItem({ id: "2", priority: "low" }),
      mkItem({ id: "3", priority: "future" }),
      mkItem({ id: "4", priority: "must" }),
      mkItem({ id: "5", priority: "high" }),
      mkItem({ id: "6", priority: "should" }),
      mkItem({ id: "7", priority: "could" }),
      mkItem({ id: "8", priority: "medium" }),
    ];
    const sorted = sortBacklogItemsForIndex(items);
    expect(sorted.map((i) => i.priority)).toEqual([
      "must",
      "should",
      "could",
      "future",
      "high",
      "medium",
      "low",
      "trigger",
    ]);
  });

  test("within a priority tier, lower rank sorts first", () => {
    const items = [
      mkItem({ id: "1", priority: "high", rank: 10 }),
      mkItem({ id: "2", priority: "high", rank: 5 }),
      mkItem({ id: "3", priority: "high", rank: 1 }),
    ];
    const sorted = sortBacklogItemsForIndex(items);
    expect(sorted.map((i) => i.id)).toEqual(["3", "2", "1"]);
  });

  test("null rank sorts AFTER any ranked item within the same tier", () => {
    const items = [
      mkItem({ id: "1", priority: "high", rank: null }),
      mkItem({ id: "2", priority: "high", rank: 5 }),
      mkItem({ id: "3", priority: "high" }), // rank omitted = undefined → null
      mkItem({ id: "4", priority: "high", rank: 1 }),
    ];
    const sorted = sortBacklogItemsForIndex(items);
    // Ranked items first by rank (1, 5), then unranked items by id (1, 3)
    expect(sorted.map((i) => i.id)).toEqual(["4", "2", "1", "3"]);
  });

  test("when two items share priority and rank, id is the tiebreaker (numeric-friendly)", () => {
    const items = [
      mkItem({ id: "10", priority: "must", rank: 1 }),
      mkItem({ id: "2", priority: "must", rank: 1 }),
      mkItem({ id: "9", priority: "must", rank: 1 }),
    ];
    const sorted = sortBacklogItemsForIndex(items);
    // Numeric compare: 2 < 9 < 10
    expect(sorted.map((i) => i.id)).toEqual(["2", "9", "10"]);
  });

  test("when all keys tie, input order is preserved (stable sort)", () => {
    const items = [
      mkItem({ id: "1", priority: "must", rank: 1 }),
      mkItem({ id: "1", priority: "must", rank: 1 }),
    ];
    const sorted = sortBacklogItemsForIndex(items);
    // Same id and rank — sort retains input order
    expect(sorted).toHaveLength(2);
  });

  test("does not mutate the input array", () => {
    const items = [
      mkItem({ id: "1", priority: "could" }),
      mkItem({ id: "2", priority: "must" }),
    ];
    const before = items.map((i) => i.id);
    sortBacklogItemsForIndex(items);
    expect(items.map((i) => i.id)).toEqual(before);
  });

  test("priority ordinal map exposes the canonical eight values", () => {
    expect(Object.keys(PRIORITY_ORDINALS).sort()).toEqual([
      "could",
      "future",
      "high",
      "low",
      "medium",
      "must",
      "should",
      "trigger",
    ]);
    // Must is 0; trigger is 7
    expect(PRIORITY_ORDINALS.must).toBe(0);
    expect(PRIORITY_ORDINALS.trigger).toBe(7);
  });
});
