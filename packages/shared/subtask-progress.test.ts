import { describe, test, expect } from "bun:test";
import {
  COMPLETE_SUBTASK_STATUSES,
  doneSubtaskCount,
} from "./subtask-progress";

const subs = (...statuses: string[]) => statuses.map((status) => ({ status }));

describe("doneSubtaskCount", () => {
  test("counts done and cancelled as complete; ignores other statuses", () => {
    expect(
      doneSubtaskCount(
        subs("done", "cancelled", "pending", "in_progress", "blocked", "deferred"),
      ),
    ).toBe(2);
  });

  test("is 0 for an empty subtask list", () => {
    expect(doneSubtaskCount([])).toBe(0);
  });

  test("is 0 when nothing is done or cancelled", () => {
    expect(doneSubtaskCount(subs("pending", "in_progress", "deferred"))).toBe(0);
  });

  test("counts every subtask when all are complete", () => {
    expect(doneSubtaskCount(subs("done", "cancelled", "done"))).toBe(3);
  });
});

describe("COMPLETE_SUBTASK_STATUSES", () => {
  test("is exactly {done, cancelled}", () => {
    expect([...COMPLETE_SUBTASK_STATUSES].sort()).toEqual(["cancelled", "done"]);
  });
});
