/**
 * Tests for ledger-transaction.ts — ID-20.15 cross-ledger atomic Promote.
 *
 * The load-bearing test is `atomicity — fault-injection`: it triggers the
 * `faultBeforeCommit` seam (which fires AFTER both writes are staged +
 * fsync'd, BEFORE the first commit rename) and asserts BOTH ledger files
 * are BYTE-IDENTICAL to their pre-transaction state. This is the
 * testStrategy contract: "a process kill mid-transaction (pre-commit) must
 * leave BOTH ledger files in their pre-transaction state."
 *
 * These tests exercise the transaction module directly (no HTTP layer) so
 * the injected fault seam — which the HTTP endpoint never exposes — is
 * reachable.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { promoteTransaction } from "./ledger-transaction";
import { escapeSerialise } from "./scoped-serialise";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "task-view-txn-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeTaskList() {
  return {
    document_name: "Knowledge Hub Task List",
    document_purpose: "Active + recently-closed structured work.",
    related_documents: [],
    tasks: [
      {
        id: "20",
        title: "Existing task",
        description: "Body.",
        status: "in_progress",
        priority: "must",
        dependencies: [],
        subtasks: [],
        updatedAt: "2026-05-21T15:30:00.000Z",
        effort_estimate: null,
        owner: null,
        priority_note: null,
        status_note: null,
        cross_doc_links: [],
        session_refs: [],
        commit_refs: [],
      },
    ],
  };
}

function makeBacklog() {
  return {
    document_name: "Product Backlog",
    document_purpose: "Forward-looking items.",
    related_documents: [],
    items: [
      {
        id: "101",
        description: "An item ready to promote.",
        type: "feature",
        status: "ready",
        effort_estimate: "2-3h",
        priority: "high",
        track: "platform",
        dependencies: [],
        session_refs: [],
        commit_refs: [],
        cross_doc_links: [],
        notes: null,
      },
    ],
  };
}

function makeNewTask(id: string) {
  return {
    id,
    title: `Promoted task ${id}`,
    description: "Promoted from backlog.",
    status: "pending",
    priority: "should",
    dependencies: [],
    subtasks: [],
    updatedAt: "2026-05-25T12:00:00.000Z",
    effort_estimate: null,
    owner: null,
    priority_note: null,
    status_note: null,
    cross_doc_links: [],
    session_refs: [],
    commit_refs: [],
  };
}

async function setup(): Promise<{
  taskListPath: string;
  backlogPath: string;
  taskListContent: string;
  backlogContent: string;
  taskListMtime: string;
  backlogMtime: string;
}> {
  const taskListPath = join(testDir, "task-list.json");
  const backlogPath = join(testDir, "product-backlog.json");
  const taskListContent = JSON.stringify(makeTaskList(), null, 2);
  const backlogContent = JSON.stringify(makeBacklog(), null, 2);
  await writeFile(taskListPath, taskListContent, "utf8");
  await writeFile(backlogPath, backlogContent, "utf8");
  return {
    taskListPath,
    backlogPath,
    taskListContent,
    backlogContent,
    taskListMtime: (await stat(taskListPath)).mtime.toISOString(),
    backlogMtime: (await stat(backlogPath)).mtime.toISOString(),
  };
}

// ── Happy path ────────────────────────────────────────────────────────────────

describe("promoteTransaction — happy path", () => {
  test("commits both sides: Task added + backlog item removed", async () => {
    const s = await setup();
    const result = await promoteTransaction({
      taskListPath: s.taskListPath,
      backlogPath: s.backlogPath,
      taskListBaseMtime: s.taskListMtime,
      backlogBaseMtime: s.backlogMtime,
      sourceBacklogId: "101",
      taskRecord: makeNewTask("42"),
    });
    expect(result.ok).toBe(true);

    const taskList = JSON.parse(await readFile(s.taskListPath, "utf8")) as {
      tasks: { id: string }[];
    };
    expect(taskList.tasks.map((t) => t.id).sort()).toEqual(["20", "42"]);

    const backlog = JSON.parse(await readFile(s.backlogPath, "utf8")) as {
      items: { id: string }[];
    };
    expect(backlog.items).toEqual([]);
  });
});

// ── ATOMICITY: fault-injection (the load-bearing test) ───────────────────────

describe("promoteTransaction — atomicity (pre-commit fault injection)", () => {
  test("a fault BEFORE the commit point leaves BOTH ledger files byte-identical", async () => {
    const s = await setup();

    let faultFired = false;
    await expect(
      promoteTransaction({
        taskListPath: s.taskListPath,
        backlogPath: s.backlogPath,
        taskListBaseMtime: s.taskListMtime,
        backlogBaseMtime: s.backlogMtime,
        sourceBacklogId: "101",
        taskRecord: makeNewTask("42"),
        // Simulate a process kill at the pre-commit point: both writes are
        // already staged + fsync'd, but neither rename has happened.
        faultBeforeCommit: () => {
          faultFired = true;
          throw new Error("simulated process kill mid-transaction");
        },
      }),
    ).rejects.toThrow(/simulated process kill/);

    expect(faultFired).toBe(true);

    // CONTRACT: both canonicals are exactly as they were before the txn.
    expect(await readFile(s.taskListPath, "utf8")).toBe(s.taskListContent);
    expect(await readFile(s.backlogPath, "utf8")).toBe(s.backlogContent);
  });

  test("no temp files survive a pre-commit fault (staged temps are aborted)", async () => {
    const s = await setup();
    await expect(
      promoteTransaction({
        taskListPath: s.taskListPath,
        backlogPath: s.backlogPath,
        taskListBaseMtime: s.taskListMtime,
        backlogBaseMtime: s.backlogMtime,
        sourceBacklogId: "101",
        taskRecord: makeNewTask("42"),
        faultBeforeCommit: () => {
          throw new Error("kill");
        },
      }),
    ).rejects.toThrow();

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(testDir);
    const temps = entries.filter((e) => e.includes(".tmp."));
    expect(temps).toEqual([]);
  });

  test("an async fault (awaited) before commit also leaves both files pristine", async () => {
    const s = await setup();
    await expect(
      promoteTransaction({
        taskListPath: s.taskListPath,
        backlogPath: s.backlogPath,
        taskListBaseMtime: s.taskListMtime,
        backlogBaseMtime: s.backlogMtime,
        sourceBacklogId: "101",
        taskRecord: makeNewTask("42"),
        faultBeforeCommit: async () => {
          await new Promise((r) => setTimeout(r, 1));
          throw new Error("async kill");
        },
      }),
    ).rejects.toThrow(/async kill/);

    expect(await readFile(s.taskListPath, "utf8")).toBe(s.taskListContent);
    expect(await readFile(s.backlogPath, "utf8")).toBe(s.backlogContent);
  });

  test("a no-op fault hook (does not throw) still commits normally", async () => {
    const s = await setup();
    const result = await promoteTransaction({
      taskListPath: s.taskListPath,
      backlogPath: s.backlogPath,
      taskListBaseMtime: s.taskListMtime,
      backlogBaseMtime: s.backlogMtime,
      sourceBacklogId: "101",
      taskRecord: makeNewTask("42"),
      faultBeforeCommit: () => {
        /* observe-only seam: does not throw */
      },
    });
    expect(result.ok).toBe(true);
    const taskList = JSON.parse(await readFile(s.taskListPath, "utf8")) as {
      tasks: { id: string }[];
    };
    expect(taskList.tasks.map((t) => t.id)).toContain("42");
  });
});

// ── Validation-first guarantees ──────────────────────────────────────────────

describe("promoteTransaction — validation-first (no bytes touched on rejection)", () => {
  test("stale task-list mtime → 409, both files unchanged", async () => {
    const s = await setup();
    const result = await promoteTransaction({
      taskListPath: s.taskListPath,
      backlogPath: s.backlogPath,
      taskListBaseMtime: "2000-01-01T00:00:00.000Z", // far in the past → stale
      backlogBaseMtime: s.backlogMtime,
      sourceBacklogId: "101",
      taskRecord: makeNewTask("42"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);
    expect(await readFile(s.taskListPath, "utf8")).toBe(s.taskListContent);
    expect(await readFile(s.backlogPath, "utf8")).toBe(s.backlogContent);
  });

  test("absent backlog id → 404, both files unchanged", async () => {
    const s = await setup();
    const result = await promoteTransaction({
      taskListPath: s.taskListPath,
      backlogPath: s.backlogPath,
      taskListBaseMtime: s.taskListMtime,
      backlogBaseMtime: s.backlogMtime,
      sourceBacklogId: "does-not-exist",
      taskRecord: makeNewTask("42"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
    expect(await readFile(s.taskListPath, "utf8")).toBe(s.taskListContent);
    expect(await readFile(s.backlogPath, "utf8")).toBe(s.backlogContent);
  });

  test("malformed Task record → 422 schema-error, both files unchanged", async () => {
    const s = await setup();
    const bad = { ...makeNewTask("42"), priority: "bogus" };
    const result = await promoteTransaction({
      taskListPath: s.taskListPath,
      backlogPath: s.backlogPath,
      taskListBaseMtime: s.taskListMtime,
      backlogBaseMtime: s.backlogMtime,
      sourceBacklogId: "101",
      taskRecord: bad,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.error).toBe("schema-error");
    }
    expect(await readFile(s.taskListPath, "utf8")).toBe(s.taskListContent);
    expect(await readFile(s.backlogPath, "utf8")).toBe(s.backlogContent);
  });
});

// ── ID-90 U1: conforming staged contents (invariants 18-20) ───────────────────
//
// The ADD leg splices the new Task into the parsed-ORIGINAL task-list text
// (untouched records keep their exact bytes); the REMOVE leg re-emits the
// backlog whole-file conformingly via escapeSerialise. Both staged contents
// carry \uXXXX escapes and a single trailing newline.

describe("promoteTransaction — ID-90 U1 conforming staged contents", () => {
  const EM_DASH = "—";
  const RAW_NON_ASCII = new RegExp("[\\u0080-\\uffff]");

  async function setupConforming(): Promise<{
    taskListPath: string;
    backlogPath: string;
    taskListContent: string;
    backlogContent: string;
    taskListMtime: string;
    backlogMtime: string;
  }> {
    const taskListPath = join(testDir, "task-list.json");
    const backlogPath = join(testDir, "product-backlog.json");
    const taskListObj = makeTaskList();
    taskListObj.tasks[0].description = `Body ${EM_DASH} with an em-dash.`;
    const backlogObj = makeBacklog();
    backlogObj.items.push({
      ...backlogObj.items[0],
      id: "102",
      description: `A second item ${EM_DASH} stays behind.`,
    });
    const taskListContent = escapeSerialise(taskListObj);
    const backlogContent = escapeSerialise(backlogObj);
    await writeFile(taskListPath, taskListContent, "utf8");
    await writeFile(backlogPath, backlogContent, "utf8");
    return {
      taskListPath,
      backlogPath,
      taskListContent,
      backlogContent,
      taskListMtime: (await stat(taskListPath)).mtime.toISOString(),
      backlogMtime: (await stat(backlogPath)).mtime.toISOString(),
    };
  }

  test("ADD leg splices: existing Task bytes preserved, escapes + trailing newline", async () => {
    const s = await setupConforming();
    const result = await promoteTransaction({
      taskListPath: s.taskListPath,
      backlogPath: s.backlogPath,
      taskListBaseMtime: s.taskListMtime,
      backlogBaseMtime: s.backlogMtime,
      sourceBacklogId: "101",
      taskRecord: makeNewTask("42"),
    });
    expect(result.ok).toBe(true);

    const written = await readFile(s.taskListPath, "utf8");
    // Existing Task 20's block keeps its exact bytes (id line up to its
    // closing brace — the brace itself gains a comma from the splice).
    const start20 = s.taskListContent.indexOf('"id": "20"');
    const end20 = s.taskListContent.indexOf('"commit_refs": []', start20);
    expect(written).toContain(s.taskListContent.slice(start20, end20));
    // Conforming bytes throughout (invariant 18).
    expect(RAW_NON_ASCII.test(written)).toBe(false);
    expect(written).toContain("\\u2014");
    expect(written.endsWith("}\n")).toBe(true);
    expect(written.endsWith("}\n\n")).toBe(false);
    expect(written).toContain('"id": "42"');
  });

  test("REMOVE leg re-emits the backlog whole-file conformingly", async () => {
    const s = await setupConforming();
    const result = await promoteTransaction({
      taskListPath: s.taskListPath,
      backlogPath: s.backlogPath,
      taskListBaseMtime: s.taskListMtime,
      backlogBaseMtime: s.backlogMtime,
      sourceBacklogId: "101",
      taskRecord: makeNewTask("42"),
    });
    expect(result.ok).toBe(true);

    const written = await readFile(s.backlogPath, "utf8");
    expect(RAW_NON_ASCII.test(written)).toBe(false);
    expect(written).toContain("\\u2014"); // surviving item keeps its escape
    expect(written.endsWith("}\n")).toBe(true);
    expect(written.endsWith("}\n\n")).toBe(false);
    const parsed = JSON.parse(written) as { items: { id: string }[] };
    expect(parsed.items.map((it) => it.id)).toEqual(["102"]);
  });

  test("fault injection on conforming fixtures still leaves both files byte-identical", async () => {
    const s = await setupConforming();
    const boom = new Error("injected pre-commit fault");
    await expect(
      promoteTransaction({
        taskListPath: s.taskListPath,
        backlogPath: s.backlogPath,
        taskListBaseMtime: s.taskListMtime,
        backlogBaseMtime: s.backlogMtime,
        sourceBacklogId: "101",
        taskRecord: makeNewTask("42"),
        faultBeforeCommit: () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);

    expect(await readFile(s.taskListPath, "utf8")).toBe(s.taskListContent);
    expect(await readFile(s.backlogPath, "utf8")).toBe(s.backlogContent);
  });
});
