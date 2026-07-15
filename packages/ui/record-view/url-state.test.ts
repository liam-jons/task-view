/**
 * url-state.test.ts — verifies Backlog filter URL round-trip
 * (PRODUCT inv 23).
 */
import { describe, expect, test } from "bun:test";
import {
  applyBacklogFilters,
  applyInitiativesFilters,
  applyTaskListFilters,
  decodeBacklogFilters,
  decodeLedgerParam,
  decodeInitiativesFilters,
  decodeTaskListFilters,
  encodeBacklogFilters,
  encodeInitiativesFilters,
  encodeTaskListFilters,
  decodeSort,
  encodeSort,
  matchesQuery,
  nextSearchForFlag,
  nextSearchForQuery,
  nextSortForField,
} from "./url-state";

describe("decodeBacklogFilters (PRODUCT inv 23)", () => {
  test("returns all-null state for empty query string", () => {
    expect(decodeBacklogFilters("")).toEqual({
      track: null,
      status: null,
      priority: null,
      q: null,
    });
  });

  test("populates non-null fields from individual params", () => {
    expect(decodeBacklogFilters("track=Bid&status=ready&priority=high")).toEqual({
      track: "Bid",
      status: "ready",
      priority: "high",
      q: null,
    });
  });

  test("treats 'all' sentinel and empty value as null (no filter)", () => {
    expect(decodeBacklogFilters("track=all&status=&priority=high")).toEqual({
      track: null,
      status: null,
      priority: "high",
      q: null,
    });
  });

  test("accepts a URLSearchParams input as well as a string", () => {
    const params = new URLSearchParams();
    params.set("track", "Bid");
    expect(decodeBacklogFilters(params)).toEqual({
      track: "Bid",
      status: null,
      priority: null,
      q: null,
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

describe("matchesQuery (keyword search helper)", () => {
  test("an empty/absent query matches everything", () => {
    expect(matchesQuery(null, ["anything"])).toBe(true);
    expect(matchesQuery("", ["anything"])).toBe(true);
    expect(matchesQuery(undefined, ["anything"])).toBe(true);
  });

  test("matches case-insensitively across any field", () => {
    expect(matchesQuery("FOO", ["a foo b", null])).toBe(true);
    expect(matchesQuery("auth", ["Billing", "Auth flow"])).toBe(true);
    expect(matchesQuery("zzz", ["a foo b", "bar"])).toBe(false);
  });

  test("ignores null/undefined fields", () => {
    expect(matchesQuery("x", [null, undefined])).toBe(false);
  });
});

describe("Backlog keyword search (q) — round-trip + apply", () => {
  test("decodes q, treating 'all' as a literal search (NOT the filter sentinel)", () => {
    expect(decodeBacklogFilters("q=all").q).toBe("all");
    expect(decodeBacklogFilters("q=spec").q).toBe("spec");
    expect(decodeBacklogFilters("q=").q ?? null).toBeNull();
    expect(decodeBacklogFilters("").q ?? null).toBeNull();
  });

  test("encodes q after the track/status/priority keys", () => {
    expect(
      encodeBacklogFilters({
        track: "Bid",
        status: null,
        priority: null,
        q: "spec",
      }),
    ).toBe("track=Bid&q=spec");
    expect(
      encodeBacklogFilters({
        track: null,
        status: null,
        priority: null,
        q: null,
      }),
    ).toBe("");
  });

  test("applyBacklogFilters matches q over id + description, conjunctive with filters", () => {
    const items = [
      { id: "1", description: "auth flow", track: "Bid", status: "ready", priority: "high" },
      { id: "2", description: "billing", track: "Bid", status: "ready", priority: "high" },
      { id: "3", description: "auth tokens", track: "Ops", status: "ready", priority: "high" },
    ];
    // q alone
    expect(
      applyBacklogFilters(items, {
        track: null,
        status: null,
        priority: null,
        q: "auth",
      }).map((i) => i.id),
    ).toEqual(["1", "3"]);
    // q AND track (conjunction)
    expect(
      applyBacklogFilters(items, {
        track: "Bid",
        status: null,
        priority: null,
        q: "auth",
      }).map((i) => i.id),
    ).toEqual(["1"]);
  });
});

describe("Task-list keyword search (decodeTaskListFilters / apply)", () => {
  const tasks = [
    { id: "20", title: "Auth flow" },
    { id: "21", title: "Billing" },
  ];

  test("decode/encode q round-trip", () => {
    expect(decodeTaskListFilters("q=auth")).toEqual({
      q: "auth",
      excludeDone: false,
    });
    expect(decodeTaskListFilters("")).toEqual({ q: null, excludeDone: false });
    expect(encodeTaskListFilters({ q: "auth" })).toBe("q=auth");
    expect(encodeTaskListFilters({ q: null })).toBe("");
  });

  test("excludeDone: decode reads the flag, encode emits it only when true", () => {
    expect(decodeTaskListFilters("excludeDone=1")).toEqual({
      q: null,
      excludeDone: true,
    });
    expect(encodeTaskListFilters({ q: null, excludeDone: true })).toBe(
      "excludeDone=1",
    );
    expect(encodeTaskListFilters({ q: "x", excludeDone: true })).toBe(
      "q=x&excludeDone=1",
    );
    expect(encodeTaskListFilters({ q: null, excludeDone: false })).toBe("");
  });

  test("applyTaskListFilters hides done + cancelled when excludeDone, composing with q", () => {
    const rows = [
      { id: "1", title: "auth", status: "done" },
      { id: "2", title: "auth", status: "in_progress" },
      { id: "3", title: "auth", status: "cancelled" },
      { id: "4", title: "other", status: "pending" },
    ];
    expect(
      applyTaskListFilters(rows, { q: null, excludeDone: true }).map(
        (t) => t.id,
      ),
    ).toEqual(["2", "4"]);
    // composes with q (only in_progress auth survives)
    expect(
      applyTaskListFilters(rows, { q: "auth", excludeDone: true }).map(
        (t) => t.id,
      ),
    ).toEqual(["2"]);
    // off → done/cancelled retained
    expect(
      applyTaskListFilters(rows, { q: null, excludeDone: false }).map(
        (t) => t.id,
      ),
    ).toEqual(["1", "2", "3", "4"]);
  });

  test("applyTaskListFilters matches title + id, case-insensitive", () => {
    expect(applyTaskListFilters(tasks, { q: "AUTH" }).map((t) => t.id)).toEqual([
      "20",
    ]);
    // id substring: both ids contain "2"
    expect(applyTaskListFilters(tasks, { q: "2" }).map((t) => t.id)).toEqual([
      "20",
      "21",
    ]);
    expect(applyTaskListFilters(tasks, { q: null })).toHaveLength(2);
  });
});

describe("Initiatives keyword search (decodeInitiativesFilters / apply, ID-148.10)", () => {
  const initiatives = [
    { id: "1", title: "Platform" },
    { id: "2", title: "Growth" },
  ];

  test("decode/encode q round-trip", () => {
    expect(decodeInitiativesFilters("q=plat")).toEqual({ q: "plat" });
    expect(encodeInitiativesFilters({ q: null })).toBe("");
  });

  test("applyInitiativesFilters matches title + id", () => {
    expect(
      applyInitiativesFilters(initiatives, { q: "growth" }).map((i) => i.id),
    ).toEqual(["2"]);
    expect(applyInitiativesFilters(initiatives, { q: null })).toHaveLength(2);
  });
});

describe("Sort state (decodeSort / encodeSort / nextSortForField)", () => {
  test("decodeSort defaults to no field, ascending", () => {
    expect(decodeSort("")).toEqual({ field: null, dir: "asc" });
  });

  test("decodeSort reads sortField + sortDir", () => {
    expect(decodeSort("sortField=title&sortDir=desc")).toEqual({
      field: "title",
      dir: "desc",
    });
    expect(decodeSort("sortField=id")).toEqual({ field: "id", dir: "asc" });
  });

  test("encodeSort omits everything when no field is set", () => {
    expect(encodeSort({ field: null, dir: "asc" })).toBe("");
  });

  test("encodeSort emits sortField + sortDir for a set field", () => {
    expect(encodeSort({ field: "title", dir: "desc" })).toBe(
      "sortField=title&sortDir=desc",
    );
  });

  test("nextSortForField is a 3-state toggle, preserving other params", () => {
    // new field → ascending
    expect(nextSortForField("q=x", "id")).toBe("q=x&sortField=id&sortDir=asc");
    // same field asc → desc
    expect(nextSortForField("sortField=id&sortDir=asc", "id")).toBe(
      "sortField=id&sortDir=desc",
    );
    // same field desc → cleared (back to natural order)
    expect(nextSortForField("sortField=id&sortDir=desc&q=x", "id")).toBe("q=x");
    // switching field resets to ascending
    expect(nextSortForField("sortField=id&sortDir=desc", "title")).toBe(
      "sortField=title&sortDir=asc",
    );
  });
});

describe("nextSearchForQuery (client search navigation — preserves other params)", () => {
  test("sets q on an empty query string", () => {
    expect(nextSearchForQuery("", "auth")).toBe("q=auth");
  });

  test("preserves existing filter params when adding q", () => {
    expect(nextSearchForQuery("track=Bid", "auth")).toBe("track=Bid&q=auth");
  });

  test("replaces an existing q in place, preserving the other params", () => {
    expect(nextSearchForQuery("q=old&track=Bid", "new")).toBe(
      "q=new&track=Bid",
    );
  });

  test("clears q (and trims) when the value is blank", () => {
    expect(nextSearchForQuery("q=old&track=Bid", "   ")).toBe("track=Bid");
    expect(nextSearchForQuery("q=old", "")).toBe("");
  });

  test("preserves a cross-ledger ?ledger= slug", () => {
    expect(nextSearchForQuery("ledger=initiatives", "x")).toBe(
      "ledger=initiatives&q=x",
    );
  });
});

describe("nextSearchForFlag (boolean toggle param — preserves other params)", () => {
  test("sets <key>=1 when on, deletes it when off", () => {
    expect(nextSearchForFlag("q=x", "excludeDone", true)).toBe(
      "q=x&excludeDone=1",
    );
    expect(nextSearchForFlag("q=x&excludeDone=1", "excludeDone", false)).toBe(
      "q=x",
    );
  });
});

describe("decodeLedgerParam ({20.29} cross-ledger nav, SPEC §5 slice 2)", () => {
  test("returns the slug for a valid ?ledger=<slug>", () => {
    expect(decodeLedgerParam("ledger=task-list&record=6")).toBe("task-list");
    expect(decodeLedgerParam("ledger=initiatives&record=10")).toBe("initiatives");
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
    const params = new URLSearchParams("ledger=initiatives&record=10");
    expect(decodeLedgerParam(params)).toBe("initiatives");
  });
});
