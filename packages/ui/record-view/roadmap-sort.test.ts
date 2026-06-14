/**
 * roadmap-sort.test.ts — pure sort helper for the Roadmap theme index
 * (docs/notes/ledger-sorting.md; mirrors backlog-sort.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { sortThemesForIndex } from "./roadmap-sort";

type Th = Parameters<typeof sortThemesForIndex>[0][number];

const mk = (id: string, over: Partial<Th> = {}): Th =>
  ({
    id,
    title: `Theme ${id}`,
    time_horizon: "now",
    status: "pending",
    linked_tasks: [],
    ...over,
  }) as Th;

describe("sortThemesForIndex", () => {
  test("field=null returns input order in a NEW array", () => {
    const themes = [mk("2"), mk("1")];
    const out = sortThemesForIndex(themes, { field: null, dir: "asc" });
    expect(out.map((t) => t.id)).toEqual(["2", "1"]);
    expect(out).not.toBe(themes);
  });

  test("sorts by id numerically", () => {
    const themes = [mk("10"), mk("2"), mk("1")];
    expect(
      sortThemesForIndex(themes, { field: "id", dir: "asc" }).map((t) => t.id),
    ).toEqual(["1", "2", "10"]);
  });

  test("sorts by time_horizon ordinal (now < next < later)", () => {
    const themes = [
      mk("1", { time_horizon: "later" }),
      mk("2", { time_horizon: "now" }),
      mk("3", { time_horizon: "next" }),
    ];
    expect(
      sortThemesForIndex(themes, { field: "time_horizon", dir: "asc" }).map(
        (t) => t.id,
      ),
    ).toEqual(["2", "3", "1"]);
  });

  test("sorts by status ordinal (pending < in_progress < done)", () => {
    const themes = [
      mk("1", { status: "done" }),
      mk("2", { status: "pending" }),
      mk("3", { status: "in_progress" }),
    ];
    expect(
      sortThemesForIndex(themes, { field: "status", dir: "asc" }).map(
        (t) => t.id,
      ),
    ).toEqual(["2", "3", "1"]);
  });

  test("sorts by linked_tasks count, desc", () => {
    const themes = [
      mk("1", { linked_tasks: ["a"] }),
      mk("2", { linked_tasks: ["a", "b", "c"] }),
      mk("3", { linked_tasks: [] }),
    ];
    expect(
      sortThemesForIndex(themes, { field: "linked_tasks", dir: "desc" }).map(
        (t) => t.id,
      ),
    ).toEqual(["2", "1", "3"]);
  });

  test("is stable on ties", () => {
    const themes = [mk("3"), mk("1"), mk("2")];
    expect(
      sortThemesForIndex(themes, { field: "status", dir: "asc" }).map(
        (t) => t.id,
      ),
    ).toEqual(["3", "1", "2"]);
  });
});
