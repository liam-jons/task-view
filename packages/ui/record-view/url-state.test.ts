/**
 * url-state.test.ts — verifies Backlog filter URL round-trip
 * (PRODUCT inv 23).
 */
import { describe, expect, test } from "bun:test";
import {
  applyBacklogFilters,
  decodeBacklogFilters,
  decodeLedgerParam,
  encodeBacklogFilters,
} from "./url-state";

describe("decodeBacklogFilters (PRODUCT inv 23)", () => {
  test("returns all-null state for empty query string", () => {
    expect(decodeBacklogFilters("")).toEqual({
      track: null,
      status: null,
      priority: null,
    });
  });

  test("populates non-null fields from individual params", () => {
    expect(decodeBacklogFilters("track=Bid&status=ready&priority=high")).toEqual({
      track: "Bid",
      status: "ready",
      priority: "high",
    });
  });

  test("treats 'all' sentinel and empty value as null (no filter)", () => {
    expect(decodeBacklogFilters("track=all&status=&priority=high")).toEqual({
      track: null,
      status: null,
      priority: "high",
    });
  });

  test("accepts a URLSearchParams input as well as a string", () => {
    const params = new URLSearchParams();
    params.set("track", "Bid");
    expect(decodeBacklogFilters(params)).toEqual({
      track: "Bid",
      status: null,
      priority: null,
    });
  });
});

describe("encodeBacklogFilters (PRODUCT inv 23)", () => {
  test("omits null fields entirely (no `key=all` emission)", () => {
    expect(
      encodeBacklogFilters({ track: null, status: null, priority: null }),
    ).toBe("");
  });

  test("emits set fields in a deterministic key order: track, status, priority", () => {
    expect(
      encodeBacklogFilters({ track: "Bid", status: "ready", priority: "high" }),
    ).toBe("track=Bid&status=ready&priority=high");
  });

  test("emits a single key when only one filter is set", () => {
    expect(
      encodeBacklogFilters({ track: null, status: "ready", priority: null }),
    ).toBe("status=ready");
  });

  test("round-trips through decode → encode", () => {
    const original = "track=Procurement&status=blocked&priority=must";
    const decoded = decodeBacklogFilters(original);
    expect(encodeBacklogFilters(decoded)).toBe(original);
  });
});

describe("applyBacklogFilters (PRODUCT inv 23)", () => {
  const items = [
    { id: "1", track: "Bid", status: "ready", priority: "high" },
    { id: "2", track: "Bid", status: "blocked", priority: "high" },
    { id: "3", track: "Procurement", status: "ready", priority: "must" },
    { id: "4", track: "Procurement", status: "parked", priority: "low" },
  ];

  test("returns all items when every filter is null", () => {
    const result = applyBacklogFilters(items, {
      track: null,
      status: null,
      priority: null,
    });
    expect(result).toHaveLength(4);
  });

  test("filters by track only", () => {
    const result = applyBacklogFilters(items, {
      track: "Bid",
      status: null,
      priority: null,
    });
    expect(result.map((i) => i.id)).toEqual(["1", "2"]);
  });

  test("filters by multiple fields conjunctively", () => {
    const result = applyBacklogFilters(items, {
      track: "Bid",
      status: "ready",
      priority: "high",
    });
    expect(result.map((i) => i.id)).toEqual(["1"]);
  });

  test("returns empty list when no item matches", () => {
    const result = applyBacklogFilters(items, {
      track: "Bid",
      status: "parked",
      priority: null,
    });
    expect(result).toEqual([]);
  });
});

describe("decodeLedgerParam ({20.29} cross-ledger nav, SPEC §5 slice 2)", () => {
  test("returns the slug for a valid ?ledger=<slug>", () => {
    expect(decodeLedgerParam("ledger=task-list&record=6")).toBe("task-list");
    expect(decodeLedgerParam("ledger=roadmap&record=10")).toBe("roadmap");
    expect(decodeLedgerParam("ledger=backlog&record=45")).toBe("backlog");
  });

  test("returns null when the ledger param is absent (bare ?record=)", () => {
    // Back-compat: bare /?record=N has no ledger → launched ledger.
    expect(decodeLedgerParam("record=10")).toBeNull();
    expect(decodeLedgerParam("")).toBeNull();
  });

  test("returns null for an unrecognised slug", () => {
    expect(decodeLedgerParam("ledger=bogus&record=1")).toBeNull();
    expect(decodeLedgerParam("ledger=&record=1")).toBeNull();
  });

  test("accepts a URLSearchParams as well as a string", () => {
    const params = new URLSearchParams("ledger=roadmap&record=10");
    expect(decodeLedgerParam(params)).toBe("roadmap");
  });
});
