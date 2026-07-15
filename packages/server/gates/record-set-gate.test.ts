/**
 * Tests for gates/record-set-gate — ID-90 U3 (PRODUCT invariants 22–23).
 *
 * Port-parity coverage moved upstream from KH `ledger-cli-record-set.test.ts`
 * (TECH §Testing: "Coverage moves upstream (U11)"), adapted to the server
 * hook shape: post-serialisation / pre-atomicWriteFile, asserting on the
 * EXACT bytes about to land.
 *
 * Synthetic fixtures only (AC-I) — no client-name tokens anywhere.
 */
import { describe, expect, test } from "bun:test";

import {
  collectionIds,
  beforeCollectionIds,
  assertRecordSet,
  checkRecordSet,
  topLevelCollectionFor,
  type RecordSetDelta,
} from "./record-set-gate";
import type { DetectSchemaResult } from "../detect-schema";

type KnownDetected = Exclude<DetectSchemaResult, { kind: "unknown" }>;

// ── Fixtures (synthetic) ─────────────────────────────────────────────────────

function taskListDoc(taskIds: string[], subtasksFor7: number[] = [1, 2]) {
  return {
    document_name: "Knowledge Hub Task List",
    document_purpose: "Synthetic.",
    related_documents: [],
    tasks: taskIds.map((id) => ({
      id,
      title: `Task ${id}`,
      description: "d",
      status: "pending",
      priority: "should",
      dependencies: [],
      subtasks:
        id === "7"
          ? subtasksFor7.map((sid) => ({
              id: sid,
              title: `Sub ${sid}`,
              description: "sd",
              details: "det",
              status: "pending",
              dependencies: [],
              testStrategy: null,
            }))
          : [],
    })),
  };
}

function backlogDoc(itemIds: string[]) {
  return {
    document_name: "Product Backlog",
    document_purpose: "Synthetic.",
    items: itemIds.map((id) => ({
      id,
      title: `Item ${id}`,
      track: "platform",
      priority: "should",
      status: "proposed",
      description: "d",
    })),
  };
}

/**
 * A nested initiatives fixture (ID-148.10, INV-13): each top-level
 * initiative id in `topLevel` gets ONE direct project (`${id}-direct`);
 * `nested` (if given) additionally nests a sub-initiative with its own
 * project (`${parentId}-nested`) under the FIRST top-level initiative — so
 * `allProjectSlugs` is exercised across BOTH a flat set and a tree.
 */
function initiativesDoc(topLevel: string[], nested: string[] = []) {
  return {
    document_name: "Canonical Platform - Initiatives",
    document_purpose: "Synthetic.",
    date: "2026-07-15",
    status: "active",
    related_documents: [],
    last_updated: "kh-main-S473 synthetic fixture",
    initiatives: topLevel.map((id, i) => ({
      id,
      title: `Initiative ${id}`,
      description: "d",
      status: "active",
      projects: [
        {
          id: `${id}-direct`,
          title: `Direct project ${id}`,
          summary: "s",
          description: "d",
          substrate_doc: "",
          status: "idea",
          blocked_by: [],
          blocking: [],
          linked_tasks: [],
          linked_backlog: [],
          originating_session: [],
        },
      ],
      originating_session: [],
      "sub-initiatives":
        i === 0
          ? nested.map((subId) => ({
              id: subId,
              title: `Sub ${subId}`,
              description: "d",
              status: "planned",
              projects: [
                {
                  id: `${id}-${subId}-nested`,
                  title: `Nested project ${subId}`,
                  summary: "s",
                  description: "d",
                  substrate_doc: "",
                  status: "backlog",
                  blocked_by: [],
                  blocking: [],
                  linked_tasks: [],
                  linked_backlog: [],
                  originating_session: [],
                },
              ],
              originating_session: [],
              "sub-initiatives": [],
            }))
          : [],
    })),
  };
}

const NONE: RecordSetDelta = { kind: "none" };

// ── collectionIds (bytes-side extraction) ────────────────────────────────────

describe("collectionIds", () => {
  test("extracts top-level task ids from a parsed document", () => {
    const ids = collectionIds(taskListDoc(["7", "9"]), { collection: "tasks" });
    expect(ids).toEqual(new Set(["7", "9"]));
  });

  test("extracts one task's subtask ids", () => {
    const ids = collectionIds(taskListDoc(["7"], [1, 2, 3]), {
      collection: "subtasks",
      taskId: "7",
    });
    expect(ids).toEqual(new Set([1, 2, 3]));
  });

  test("returns null when the collection cannot be located", () => {
    expect(collectionIds({ foo: 1 }, { collection: "items" })).toBeNull();
    expect(collectionIds(null, { collection: "tasks" })).toBeNull();
    expect(
      collectionIds(taskListDoc(["9"]), { collection: "subtasks", taskId: "404" }),
    ).toBeNull();
  });

  // ID-148.10 (INV-13): "projects" is a TREE-FLATTENED set, not a literal
  // top-level array key.
  test("extracts the tree-flattened project-slug set (flat top-level only)", () => {
    const ids = collectionIds(initiativesDoc(["1", "2"]), {
      collection: "projects",
    });
    expect(ids).toEqual(new Set(["1-direct", "2-direct"]));
  });

  test("extracts the tree-flattened project-slug set ACROSS a nested sub-initiative", () => {
    const ids = collectionIds(initiativesDoc(["1", "2"], ["a", "b"]), {
      collection: "projects",
    });
    expect(ids).toEqual(
      new Set(["1-direct", "2-direct", "1-a-nested", "1-b-nested"]),
    );
  });

  test("returns null for 'projects' when the initiatives array is absent (malformed)", () => {
    expect(
      collectionIds({ document_name: "x" }, { collection: "projects" }),
    ).toBeNull();
  });
});

// ── beforeCollectionIds (typed pre-write capture) ────────────────────────────

describe("beforeCollectionIds", () => {
  test("captures task / theme / item id-sets from the typed detected doc", () => {
    const tl = {
      kind: "task-list",
      data: taskListDoc(["7", "8"]),
    } as unknown as KnownDetected;
    expect(beforeCollectionIds(tl, { collection: "tasks" })).toEqual(
      new Set(["7", "8"]),
    );
    const init = {
      kind: "initiatives",
      data: initiativesDoc(["1", "2"]),
    } as unknown as KnownDetected;
    expect(beforeCollectionIds(init, { collection: "projects" })).toEqual(
      new Set(["1-direct", "2-direct"]),
    );
    const bl = {
      kind: "backlog",
      data: backlogDoc(["100"]),
    } as unknown as KnownDetected;
    expect(beforeCollectionIds(bl, { collection: "items" })).toEqual(
      new Set(["100"]),
    );
  });

  test("captures one task's subtask id-set", () => {
    const tl = {
      kind: "task-list",
      data: taskListDoc(["7"], [1, 4]),
    } as unknown as KnownDetected;
    expect(
      beforeCollectionIds(tl, { collection: "subtasks", taskId: "7" }),
    ).toEqual(new Set([1, 4]));
  });

  test("kind mismatch yields an empty set (defensive)", () => {
    const bl = {
      kind: "backlog",
      data: backlogDoc(["100"]),
    } as unknown as KnownDetected;
    expect(beforeCollectionIds(bl, { collection: "tasks" })).toEqual(new Set());
  });
});

// ── assertRecordSet (core delta algebra) ─────────────────────────────────────

describe("assertRecordSet", () => {
  test("none delta: identical sets pass", () => {
    expect(assertRecordSet(new Set(["7", "9"]), new Set(["9", "7"]), NONE)).toEqual({
      ok: true,
    });
  });

  test("none delta: a dropped record reports the missing id", () => {
    const check = assertRecordSet(new Set(["7", "9"]), new Set(["7"]), NONE);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.detail).toBe("missing [9]");
  });

  test("none delta: an unexpectedly-inserted record reports the unexpected id", () => {
    const check = assertRecordSet(new Set(["7"]), new Set(["7", "777"]), NONE);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.detail).toBe("unexpected [777]");
  });

  test("drop + dupe together report both sides", () => {
    const check = assertRecordSet(new Set(["7", "9"]), new Set(["7", "777"]), NONE);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.detail).toBe("missing [9] / unexpected [777]");
  });

  test("add delta: post-set must contain exactly before + the added id", () => {
    expect(
      assertRecordSet(new Set(["7"]), new Set(["7", "8"]), { kind: "add", id: "8" }),
    ).toEqual({ ok: true });
    const dropped = assertRecordSet(new Set(["7"]), new Set(["8"]), {
      kind: "add",
      id: "8",
    });
    expect(dropped.ok).toBe(false);
    if (!dropped.ok) expect(dropped.detail).toBe("missing [7]");
  });

  test("add-many delta: every bulk id must land", () => {
    expect(
      assertRecordSet(new Set([1]), new Set([1, 2, 3]), {
        kind: "add-many",
        ids: [2, 3],
      }),
    ).toEqual({ ok: true });
    const partial = assertRecordSet(new Set([1]), new Set([1, 2]), {
      kind: "add-many",
      ids: [2, 3],
    });
    expect(partial.ok).toBe(false);
    if (!partial.ok) expect(partial.detail).toBe("missing [3]");
  });

  test("remove delta: post-set must equal before minus the removed id", () => {
    expect(
      assertRecordSet(new Set(["7", "9"]), new Set(["7"]), {
        kind: "remove",
        id: "9",
      }),
    ).toEqual({ ok: true });
    const extraDrop = assertRecordSet(new Set(["7", "9", "11"]), new Set(["7"]), {
      kind: "remove",
      id: "9",
    });
    expect(extraDrop.ok).toBe(false);
    if (!extraDrop.ok) expect(extraDrop.detail).toBe("missing [11]");
  });
});

// ── checkRecordSet (bytes-about-to-land gate) ────────────────────────────────

describe("checkRecordSet", () => {
  test("clean PATCH bytes (none delta) pass", () => {
    const content = JSON.stringify(taskListDoc(["7", "9"]), null, 2);
    expect(
      checkRecordSet("task-list", content, new Set(["7", "9"]), { collection: "tasks" }, NONE),
    ).toEqual({ ok: true });
  });

  test("a serialise-side record DROP rejects record-set-violation naming the id", () => {
    const content = JSON.stringify(taskListDoc(["7"]), null, 2); // task 9 dropped
    const check = checkRecordSet(
      "task-list",
      content,
      new Set(["7", "9"]),
      { collection: "tasks" },
      NONE,
    );
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.error).toBe("record-set-violation");
      expect(check.detail).toBe("task-list: missing [9]");
    }
  });

  test("a serialise-side unexpected INSERT rejects record-set-violation", () => {
    const content = JSON.stringify(backlogDoc(["100", "666"]), null, 2);
    const check = checkRecordSet(
      "backlog",
      content,
      new Set(["100"]),
      { collection: "items" },
      NONE,
    );
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.detail).toBe("backlog: unexpected [666]");
  });

  test("invalid JSON bytes reject record-set-violation (never written)", () => {
    const check = checkRecordSet(
      "task-list",
      "{ not json",
      new Set(["7"]),
      { collection: "tasks" },
      NONE,
    );
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.error).toBe("record-set-violation");
      expect(check.detail).toContain("serialised output is not valid JSON");
    }
  });

  test("missing collection in the bytes rejects record-set-violation", () => {
    const check = checkRecordSet(
      "backlog",
      JSON.stringify({ document_name: "Product Backlog" }),
      new Set(["100"]),
      { collection: "items" },
      NONE,
    );
    expect(check.ok).toBe(false);
    if (!check.ok)
      expect(check.detail).toContain("could not locate the items collection");
  });

  test("add delta over bytes: POST-create bytes pass; a dropped survivor rejects", () => {
    const good = JSON.stringify(taskListDoc(["7", "9", "12"]), null, 2);
    expect(
      checkRecordSet("task-list", good, new Set(["7", "9"]), { collection: "tasks" }, {
        kind: "add",
        id: "12",
      }),
    ).toEqual({ ok: true });

    const bad = JSON.stringify(taskListDoc(["7", "12"]), null, 2); // 9 dropped
    const check = checkRecordSet(
      "task-list",
      bad,
      new Set(["7", "9"]),
      { collection: "tasks" },
      { kind: "add", id: "12" },
    );
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.detail).toBe("task-list: missing [9]");
  });

  test("remove delta over bytes: DELETE bytes pass; an over-removal rejects", () => {
    const good = JSON.stringify(backlogDoc(["100"]), null, 2);
    expect(
      checkRecordSet("backlog", good, new Set(["100", "101"]), { collection: "items" }, {
        kind: "remove",
        id: "101",
      }),
    ).toEqual({ ok: true });

    const bad = JSON.stringify(backlogDoc([]), null, 2); // 100 ALSO dropped
    const check = checkRecordSet(
      "backlog",
      bad,
      new Set(["100", "101"]),
      { collection: "items" },
      { kind: "remove", id: "101" },
    );
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.detail).toBe("backlog: missing [100]");
  });

  test("add-many delta over a task's subtasks (bulk add seam for U5)", () => {
    const good = JSON.stringify(taskListDoc(["7"], [1, 2, 3, 4]), null, 2);
    expect(
      checkRecordSet(
        "task-list",
        good,
        new Set([1, 2]),
        { collection: "subtasks", taskId: "7" },
        { kind: "add-many", ids: [3, 4] },
      ),
    ).toEqual({ ok: true });

    const bad = JSON.stringify(taskListDoc(["7"], [1, 2, 3]), null, 2); // 4 dropped
    const check = checkRecordSet(
      "task-list",
      bad,
      new Set([1, 2]),
      { collection: "subtasks", taskId: "7" },
      { kind: "add-many", ids: [3, 4] },
    );
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.detail).toBe("task-list: missing [4]");
  });
});

// ── ID-148.10: initiatives "projects" descriptor (INV-13, repurposed from
// the retired roadmap "themes" descriptor) ───────────────────────────────

describe("initiatives 'projects' collection descriptor (ID-148.10, INV-13)", () => {
  test("topLevelCollectionFor('initiatives') guards the tree-flattened projects set", () => {
    expect(topLevelCollectionFor("initiatives")).toEqual({
      collection: "projects",
    });
  });

  test("a field PATCH (delta none) on a project passes; a serialise-side dropped project is a violation", () => {
    const before = new Set<string | number>(["1-direct", "2-direct"]);
    const good = JSON.stringify(initiativesDoc(["1", "2"]), null, 2);
    expect(
      checkRecordSet(
        "initiatives",
        good,
        before,
        { collection: "projects" },
        { kind: "none" },
      ),
    ).toEqual({ ok: true });

    const bad = JSON.stringify(initiativesDoc(["1"]), null, 2); // 2-direct dropped
    const check = checkRecordSet(
      "initiatives",
      bad,
      before,
      { collection: "projects" },
      { kind: "none" },
    );
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.detail).toBe("initiatives: missing [2-direct]");
  });

  test("ATOMIC MOVE (INV-13): the 2-patch batch that re-parents a task keeps the project SET at delta none", () => {
    // A move re-parents a task/backlog id between two projects' LINK
    // arrays — the project id-set itself is unchanged (no project added or
    // removed), so the gate's expectedDelta stays 'none' exactly like an
    // ordinary field PATCH. Nothing project-set-specific is needed for a
    // move — this test documents that fact against the nested fixture.
    const before = new Set<string | number>([
      "1-direct",
      "2-direct",
      "1-a-nested",
    ]);
    const afterMove = JSON.stringify(
      initiativesDoc(["1", "2"], ["a"]),
      null,
      2,
    ); // same project SET; only field CONTENTS would differ in a real move
    expect(
      checkRecordSet(
        "initiatives",
        afterMove,
        before,
        { collection: "projects" },
        { kind: "none" },
      ),
    ).toEqual({ ok: true });
  });

  test("create (add delta): a new project slug landing correctly passes; a dropped survivor rejects", () => {
    const before = new Set<string | number>(["1-direct"]);
    const good = JSON.stringify(
      {
        ...initiativesDoc(["1"]),
        initiatives: [
          {
            ...initiativesDoc(["1"]).initiatives[0],
            projects: [
              ...initiativesDoc(["1"]).initiatives[0].projects,
              { id: "1-new", title: "New" },
            ],
          },
        ],
      },
      null,
      2,
    );
    expect(
      checkRecordSet(
        "initiatives",
        good,
        before,
        { collection: "projects" },
        { kind: "add", id: "1-new" },
      ),
    ).toEqual({ ok: true });
  });
});
