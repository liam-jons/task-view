/**
 * initiatives-sort.test.ts — pure sort helper for the Initiatives index
 * (ID-148.10, repurposed from roadmap-sort.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { sortInitiativesForIndex, totalProjectCount } from "./initiatives-sort";

type Init = Parameters<typeof sortInitiativesForIndex>[0][number];

const mk = (id: string, over: Partial<Init> = {}): Init =>
  ({
    id,
    title: `Initiative ${id}`,
    status: "proposed",
    projects: [],
    "sub-initiatives": [],
    ...over,
  }) as Init;

describe("sortInitiativesForIndex", () => {
  test("field=null returns input order in a NEW array", () => {
    const initiatives = [mk("2"), mk("1")];
    const out = sortInitiativesForIndex(initiatives, { field: null, dir: "asc" });
    expect(out.map((i) => i.id)).toEqual(["2", "1"]);
    expect(out).not.toBe(initiatives);
  });

  test("sorts by id numerically", () => {
    const initiatives = [mk("10"), mk("2"), mk("1")];
    expect(
      sortInitiativesForIndex(initiatives, { field: "id", dir: "asc" }).map(
        (i) => i.id,
      ),
    ).toEqual(["1", "2", "10"]);
  });

  test("sorts by title alphabetically", () => {
    const initiatives = [
      mk("1", { title: "Zebra" }),
      mk("2", { title: "Alpha" }),
    ];
    expect(
      sortInitiativesForIndex(initiatives, { field: "title", dir: "asc" }).map(
        (i) => i.id,
      ),
    ).toEqual(["2", "1"]);
  });

  test("sorts by status ordinal (proposed < planned < active < completed < cancelled)", () => {
    const initiatives = [
      mk("1", { status: "cancelled" }),
      mk("2", { status: "proposed" }),
      mk("3", { status: "active" }),
    ];
    expect(
      sortInitiativesForIndex(initiatives, { field: "status", dir: "asc" }).map(
        (i) => i.id,
      ),
    ).toEqual(["2", "3", "1"]);
  });

  test("sorts by project_count, desc, RECURSIVE across sub-initiatives (INV-13)", () => {
    const initiatives = [
      mk("1", { projects: ["a"] }),
      mk("2", {
        projects: [],
        "sub-initiatives": [
          { projects: ["a", "b"], "sub-initiatives": [] },
          { projects: ["c"], "sub-initiatives": [] },
        ],
      }),
      mk("3", { projects: [] }),
    ];
    expect(
      sortInitiativesForIndex(initiatives, {
        field: "project_count",
        dir: "desc",
      }).map((i) => i.id),
    ).toEqual(["2", "1", "3"]);
  });

  test("is stable on ties", () => {
    const initiatives = [mk("3"), mk("1"), mk("2")];
    expect(
      sortInitiativesForIndex(initiatives, { field: "status", dir: "asc" }).map(
        (i) => i.id,
      ),
    ).toEqual(["3", "1", "2"]);
  });
});

describe("totalProjectCount", () => {
  test("counts direct projects only when no sub-initiatives", () => {
    expect(totalProjectCount({ projects: ["a", "b"], "sub-initiatives": [] })).toBe(2);
  });

  test("recursively sums nested sub-initiatives' projects", () => {
    const node = {
      projects: ["a"],
      "sub-initiatives": [
        {
          projects: ["b"],
          "sub-initiatives": [{ projects: ["c", "d"], "sub-initiatives": [] }],
        },
      ],
    };
    expect(totalProjectCount(node)).toBe(4);
  });
});
