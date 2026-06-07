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

// ── ID-90 U7: capability-theme third leg (PRODUCT invariant 40) ───────────────
//
// The optional roadmap leg: pre-stage validation rejects unknown themes
// (422 unknown-theme, NOTHING staged); idempotent linked_tasks[] push;
// three staged temps; commit order task-list (ADD) → roadmap (idempotent
// link) → backlog (REMOVE) — additive first, removal last, preserving the
// benign-transient-duplicate property. Synthetic fixtures only (AC-I).

function makeRoadmap(linkedTasks: string[] = []) {
  return {
    document_name: "Knowledge Hub Roadmap",
    document_purpose: "Forward-looking capability roadmap (synthetic fixture).",
    date: "2026-05-25",
    status: "Active",
    forward_looking_only: true,
    related_documents: [],
    last_updated: "kh-main-S1 synthetic fixture",
    themes: [
      {
        id: "7",
        title: "Synthetic capability theme",
        description: "Theme 7 description.",
        time_horizon: "now",
        status: "in_progress",
        linked_tasks: linkedTasks,
        linked_backlog: [],
        session_refs: [],
        commit_refs: [],
        cross_doc_links: [],
        notes: null,
      },
    ],
  };
}

async function setupThreeLeg(linkedTasks: string[] = []): Promise<{
  taskListPath: string;
  backlogPath: string;
  roadmapPath: string;
  taskListContent: string;
  backlogContent: string;
  roadmapContent: string;
  taskListMtime: string;
  backlogMtime: string;
  roadmapMtime: string;
}> {
  const s = await setup();
  const roadmapPath = join(testDir, "product-roadmap.json");
  const roadmapContent = JSON.stringify(makeRoadmap(linkedTasks), null, 2);
  await writeFile(roadmapPath, roadmapContent, "utf8");
  return {
    ...s,
    roadmapPath,
    roadmapContent,
    roadmapMtime: (await stat(roadmapPath)).mtime.toISOString(),
  };
}

async function listTempFiles(): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return (await readdir(testDir)).filter((f) => f.includes(".tmp."));
}

describe("promoteTransaction — ID-90 U7 capability-theme third leg", () => {
  test("three-leg happy path: Task added (capability_theme bound), theme linked, backlog item removed", async () => {
    const s = await setupThreeLeg();
    const result = await promoteTransaction({
      taskListPath: s.taskListPath,
      backlogPath: s.backlogPath,
      taskListBaseMtime: s.taskListMtime,
      backlogBaseMtime: s.backlogMtime,
      sourceBacklogId: "101",
      taskRecord: makeNewTask("42"),
      capabilityTheme: {
        roadmapPath: s.roadmapPath,
        roadmapBaseMtime: s.roadmapMtime,
        themeId: "7",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.newTaskId).toBe("42");
    expect(result.boundCapabilityTheme).toBe("7");
    expect(typeof result.roadmapMtime).toBe("string");

    // ADD leg: Task present AND carries the capability_theme back-link.
    const taskList = JSON.parse(await readFile(s.taskListPath, "utf8")) as {
      tasks: { id: string; capability_theme?: string }[];
    };
    const task = taskList.tasks.find((t) => t.id === "42");
    expect(task).toBeDefined();
    expect(task?.capability_theme).toBe("7");

    // Link leg: idempotent linked_tasks[] push landed.
    const roadmap = JSON.parse(await readFile(s.roadmapPath, "utf8")) as {
      themes: { id: string; linked_tasks: string[] }[];
    };
    expect(roadmap.themes[0].linked_tasks).toEqual(["42"]);

    // REMOVE leg: backlog item gone.
    const backlog = JSON.parse(await readFile(s.backlogPath, "utf8")) as {
      items: { id: string }[];
    };
    expect(backlog.items.map((i) => i.id)).toEqual([]);
  });

  test("unknown theme → 422 unknown-theme, NOTHING staged, all three files byte-identical", async () => {
    const s = await setupThreeLeg();
    const result = await promoteTransaction({
      taskListPath: s.taskListPath,
      backlogPath: s.backlogPath,
      taskListBaseMtime: s.taskListMtime,
      backlogBaseMtime: s.backlogMtime,
      sourceBacklogId: "101",
      taskRecord: makeNewTask("42"),
      capabilityTheme: {
        roadmapPath: s.roadmapPath,
        roadmapBaseMtime: s.roadmapMtime,
        themeId: "99",
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
    expect(result.error).toBe("unknown-theme");

    expect(await readFile(s.taskListPath, "utf8")).toBe(s.taskListContent);
    expect(await readFile(s.backlogPath, "utf8")).toBe(s.backlogContent);
    expect(await readFile(s.roadmapPath, "utf8")).toBe(s.roadmapContent);
    expect(await listTempFiles()).toEqual([]);
  });

  test("stale roadmap baseMtime → 409 mtime-mismatch, nothing written", async () => {
    const s = await setupThreeLeg();
    const staleMtime = new Date(
      Date.parse(s.roadmapMtime) - 60_000,
    ).toISOString();
    const result = await promoteTransaction({
      taskListPath: s.taskListPath,
      backlogPath: s.backlogPath,
      taskListBaseMtime: s.taskListMtime,
      backlogBaseMtime: s.backlogMtime,
      sourceBacklogId: "101",
      taskRecord: makeNewTask("42"),
      capabilityTheme: {
        roadmapPath: s.roadmapPath,
        roadmapBaseMtime: staleMtime,
        themeId: "7",
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.error).toBe("mtime-mismatch");
    expect(await readFile(s.taskListPath, "utf8")).toBe(s.taskListContent);
    expect(await readFile(s.backlogPath, "utf8")).toBe(s.backlogContent);
    expect(await readFile(s.roadmapPath, "utf8")).toBe(s.roadmapContent);
  });

  test("unparseable roadmapBaseMtime → 400 invalid-baseMtime (roadmapBaseMtime)", async () => {
    const s = await setupThreeLeg();
    const result = await promoteTransaction({
      taskListPath: s.taskListPath,
      backlogPath: s.backlogPath,
      taskListBaseMtime: s.taskListMtime,
      backlogBaseMtime: s.backlogMtime,
      sourceBacklogId: "101",
      taskRecord: makeNewTask("42"),
      capabilityTheme: {
        roadmapPath: s.roadmapPath,
        roadmapBaseMtime: "not-a-date",
        themeId: "7",
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error).toBe("invalid-baseMtime");
    expect(result.detail).toBe("roadmapBaseMtime");
  });

  test("non-object taskRecord with a bound theme → 422 invalid-task-json, nothing written", async () => {
    const s = await setupThreeLeg();
    const result = await promoteTransaction({
      taskListPath: s.taskListPath,
      backlogPath: s.backlogPath,
      taskListBaseMtime: s.taskListMtime,
      backlogBaseMtime: s.backlogMtime,
      sourceBacklogId: "101",
      taskRecord: ["not", "an", "object"],
      capabilityTheme: {
        roadmapPath: s.roadmapPath,
        roadmapBaseMtime: s.roadmapMtime,
        themeId: "7",
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
    expect(result.error).toBe("invalid-task-json");
    expect(await readFile(s.roadmapPath, "utf8")).toBe(s.roadmapContent);
  });

  test("pre-commit fault: all THREE files byte-identical, staged temps aborted", async () => {
    const s = await setupThreeLeg();
    await expect(
      promoteTransaction({
        taskListPath: s.taskListPath,
        backlogPath: s.backlogPath,
        taskListBaseMtime: s.taskListMtime,
        backlogBaseMtime: s.backlogMtime,
        sourceBacklogId: "101",
        taskRecord: makeNewTask("42"),
        capabilityTheme: {
          roadmapPath: s.roadmapPath,
          roadmapBaseMtime: s.roadmapMtime,
          themeId: "7",
        },
        faultBeforeCommit: () => {
          throw new Error("simulated kill (pre-commit, three legs staged)");
        },
      }),
    ).rejects.toThrow("simulated kill");

    expect(await readFile(s.taskListPath, "utf8")).toBe(s.taskListContent);
    expect(await readFile(s.backlogPath, "utf8")).toBe(s.backlogContent);
    expect(await readFile(s.roadmapPath, "utf8")).toBe(s.roadmapContent);
    expect(await listTempFiles()).toEqual([]);
  });

  test("mid-commit crash leaves AT WORST a benign transient duplicate — never a lost record", async () => {
    const s = await setupThreeLeg();
    const result = await promoteTransaction({
      taskListPath: s.taskListPath,
      backlogPath: s.backlogPath,
      taskListBaseMtime: s.taskListMtime,
      backlogBaseMtime: s.backlogMtime,
      sourceBacklogId: "101",
      taskRecord: makeNewTask("42"),
      capabilityTheme: {
        roadmapPath: s.roadmapPath,
        roadmapBaseMtime: s.roadmapMtime,
        themeId: "7",
      },
      faultBetweenCommits: () => {
        throw new Error("simulated kill (between commit renames)");
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(500);
    expect(result.error).toBe("commit-failed");

    // ADD side committed FIRST: the Task is present...
    const taskList = JSON.parse(await readFile(s.taskListPath, "utf8")) as {
      tasks: { id: string }[];
    };
    expect(taskList.tasks.some((t) => t.id === "42")).toBe(true);
    // ...and the REMOVAL side has NOT run: the backlog item is still
    // present — a visible, self-healing duplicate, never a lost update.
    const backlog = JSON.parse(await readFile(s.backlogPath, "utf8")) as {
      items: { id: string }[];
    };
    expect(backlog.items.some((i) => i.id === "101")).toBe(true);
    // The roadmap link (between the two) has not landed either — recoverable
    // by a re-run; the primary records are never lost.
    expect(await readFile(s.roadmapPath, "utf8")).toBe(s.roadmapContent);
  });

  test("idempotent re-link: theme already lists the task id → exactly ONE entry, roadmap bytes unchanged", async () => {
    const s = await setupThreeLeg(["42"]);
    const result = await promoteTransaction({
      taskListPath: s.taskListPath,
      backlogPath: s.backlogPath,
      taskListBaseMtime: s.taskListMtime,
      backlogBaseMtime: s.backlogMtime,
      sourceBacklogId: "101",
      taskRecord: makeNewTask("42"),
      capabilityTheme: {
        roadmapPath: s.roadmapPath,
        roadmapBaseMtime: s.roadmapMtime,
        themeId: "7",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.boundCapabilityTheme).toBe("7");

    const roadmap = JSON.parse(await readFile(s.roadmapPath, "utf8")) as {
      themes: { linked_tasks: string[] }[];
    };
    // ONE entry — the push is idempotent, a re-run cannot duplicate it.
    expect(roadmap.themes[0].linked_tasks).toEqual(["42"]);
    // KH parity: the already-linked leg stages the UNCHANGED original text
    // (a no-op rewrite) — content byte-identical.
    expect(await readFile(s.roadmapPath, "utf8")).toBe(s.roadmapContent);
  });

  test("two-leg promote (no capabilityTheme) leaves a sibling roadmap untouched", async () => {
    const s = await setupThreeLeg();
    const result = await promoteTransaction({
      taskListPath: s.taskListPath,
      backlogPath: s.backlogPath,
      taskListBaseMtime: s.taskListMtime,
      backlogBaseMtime: s.backlogMtime,
      sourceBacklogId: "101",
      taskRecord: makeNewTask("42"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.boundCapabilityTheme).toBeUndefined();
    expect(result.roadmapMtime).toBeUndefined();
    expect(await readFile(s.roadmapPath, "utf8")).toBe(s.roadmapContent);
  });
});

describe("promoteTransaction — U7 gates run per leg at stage time (records 7/8)", () => {
  // Synthetic denylist only (AC-I) — "Zorblian Widgets Ltd" is invented.
  const SYNTH_DENYLIST = JSON.stringify({
    tokens: [
      { value: "Zorblian Widgets Ltd", case_insensitive: true, class: "client" },
    ],
  });
  let savedDenylist: string | undefined;

  beforeEach(() => {
    savedDenylist = process.env.KH_CLIENT_NAME_DENYLIST;
    process.env.KH_CLIENT_NAME_DENYLIST = SYNTH_DENYLIST;
  });

  afterEach(() => {
    if (savedDenylist === undefined) delete process.env.KH_CLIENT_NAME_DENYLIST;
    else process.env.KH_CLIENT_NAME_DENYLIST = savedDenylist;
  });

  test("guard rejection on the ADD leg rejects the WHOLE three-leg transaction — nothing staged anywhere", async () => {
    const s = await setupThreeLeg();
    const tainted = {
      ...makeNewTask("42"),
      description: "met Zorblian Widgets Ltd on Tuesday",
    };
    const result = await promoteTransaction({
      taskListPath: s.taskListPath,
      backlogPath: s.backlogPath,
      taskListBaseMtime: s.taskListMtime,
      backlogBaseMtime: s.backlogMtime,
      sourceBacklogId: "101",
      taskRecord: tainted,
      capabilityTheme: {
        roadmapPath: s.roadmapPath,
        roadmapBaseMtime: s.roadmapMtime,
        themeId: "7",
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
    expect(result.error).toBe("client-name-guard");
    // Invariant 32: redacted — the detail never echoes the matched token.
    expect(JSON.stringify(result).toLowerCase()).not.toContain("zorblian");

    expect(await readFile(s.taskListPath, "utf8")).toBe(s.taskListContent);
    expect(await readFile(s.backlogPath, "utf8")).toBe(s.backlogContent);
    expect(await readFile(s.roadmapPath, "utf8")).toBe(s.roadmapContent);
    expect(await listTempFiles()).toEqual([]);
  });
});
