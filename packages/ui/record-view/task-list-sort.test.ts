/**
 * task-list-sort.test.ts — pure sort helper for the Task-list index
 * (docs/notes/ledger-sorting.md; mirrors backlog-sort.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { sortTasksForIndex } from "./task-list-sort";

type T = Parameters<typeof sortTasksForIndex>[0][number];

const mk = (id: string, over: Partial<T> = {}): T =>
  ({
    id,
    title: `T${id}`,
    status: "pending",
    priority: "could",
    subtasks: [],
    ...over,
  }) as T;

/** Build a subtasks[] of the given statuses (only `status` matters here). */
const subs = (...statuses: string[]): T["subtasks"] =>
  statuses.map((status) => ({ status })) as T["subtasks"];

describe("sortTasksForIndex", () => {
  test("field=null returns input order in a NEW array (no mutation)", () => {
    const tasks = [mk("2"), mk("1")];
    const out = sortTasksForIndex(tasks, { field: null, dir: "asc" });
    expect(out.map((t) => t.id)).toEqual(["2", "1"]);
    expect(out).not.toBe(tasks);
  });

  test("sorts by id numerically (10 after 2), asc and desc", () => {
    const tasks = [mk("10"), mk("2"), mk("1")];
    expect(
      sortTasksForIndex(tasks, { field: "id", dir: "asc" }).map((t) => t.id),
    ).toEqual(["1", "2", "10"]);
    expect(
      sortTasksForIndex(tasks, { field: "id", dir: "desc" }).map((t) => t.id),
    ).toEqual(["10", "2", "1"]);
  });

  test("sorts by priority ordinal (must < could < low)", () => {
    const tasks = [
      mk("1", { priority: "low" }),
      mk("2", { priority: "must" }),
      mk("3", { priority: "could" }),
    ];
    expect(
      sortTasksForIndex(tasks, { field: "priority", dir: "asc" }).map(
        (t) => t.id,
      ),
    ).toEqual(["2", "3", "1"]);
  });

  test("sorts by OPEN subtask count (total − done), status-less subtasks all open", () => {
    const tasks = [
      mk("1", { subtasks: subs("pending", "pending") }), // 2 open
      mk("2", { subtasks: [] as unknown as T["subtasks"] }), // 0 open
      mk("3", { subtasks: subs("in_progress") }), // 1 open
    ];
    expect(
      sortTasksForIndex(tasks, { field: "subtasks", dir: "asc" }).map(
        (t) => t.id,
      ),
    ).toEqual(["2", "3", "1"]);
  });

  test("sorts by OPEN count, not total — an all-done Task sorts below one with open work", () => {
    // Old behaviour (raw total) would put the 1-subtask Task first ascending;
    // open-count puts the all-done 5-subtask Task first (0 open < 1 open).
    const allDone = mk("1", { subtasks: subs("done", "done", "done", "done", "done") });
    const oneOpen = mk("2", { subtasks: subs("pending") });
    expect(
      sortTasksForIndex([oneOpen, allDone], {
        field: "subtasks",
        dir: "asc",
      }).map((t) => t.id),
    ).toEqual(["1", "2"]);
  });

  test("cancelled subtasks count as done for the open-count sort", () => {
    const allCancelled = mk("1", { subtasks: subs("cancelled", "cancelled") }); // 0 open
    const oneOpen = mk("2", { subtasks: subs("cancelled", "pending") }); // 1 open
    expect(
      sortTasksForIndex([oneOpen, allCancelled], {
        field: "subtasks",
        dir: "asc",
      }).map((t) => t.id),
    ).toEqual(["1", "2"]);
  });

  test("sorts by title alphabetically (case-insensitive)", () => {
    const tasks = [mk("1", { title: "Banana" }), mk("2", { title: "apple" })];
    expect(
      sortTasksForIndex(tasks, { field: "title", dir: "asc" }).map((t) => t.id),
    ).toEqual(["2", "1"]);
  });

  test("is stable — equal keys keep input order", () => {
    const tasks = [
      mk("3", { priority: "must" }),
      mk("1", { priority: "must" }),
      mk("2", { priority: "must" }),
    ];
    expect(
      sortTasksForIndex(tasks, { field: "priority", dir: "asc" }).map(
        (t) => t.id,
      ),
    ).toEqual(["3", "1", "2"]);
  });

  test("an unknown field is a no-op (input order preserved)", () => {
    const tasks = [mk("2"), mk("1")];
    expect(
      sortTasksForIndex(tasks, { field: "bogus", dir: "asc" }).map((t) => t.id),
    ).toEqual(["2", "1"]);
  });
});
