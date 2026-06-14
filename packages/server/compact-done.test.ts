/**
 * compact-done.test.ts — ledger compaction (docs/specs/ledger-compaction/SPEC.md).
 * Pure-core unit tests + a temp-ledger integration test for the orchestrator.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subtask, Task } from "@task-view/schemas/task-list";
import {
  DEFAULT_COMPACTION_THRESHOLD,
  buildTruncationPatches,
  planCompaction,
  renderArchive,
  renderStub,
  runCompaction,
} from "./compact-done";

const LONG = "x".repeat(500); // > 400 threshold
const SHORT = "y".repeat(50);

const mkSub = (id: string, over: Partial<Subtask> = {}): Subtask =>
  ({
    id,
    title: `Sub ${id}`,
    description: "d",
    details: SHORT,
    status: "done",
    dependencies: [],
    testStrategy: null,
    ...over,
  }) as Subtask;

const mkTask = (id: string, over: Partial<Task> = {}): Task =>
  ({
    id,
    title: `Task ${id}`,
    description: "d",
    status: "done",
    priority: "should",
    dependencies: [],
    subtasks: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
    effort_estimate: null,
    owner: null,
    priority_note: null,
    status_note: null,
    cross_doc_links: [],
    session_refs: [],
    commit_refs: [],
    ...over,
  }) as Task;

const mkDoc = (tasks: Task[]) => ({
  document_name: "Knowledge Hub Task List",
  document_purpose: "compaction test fixture",
  related_documents: [],
  tasks,
});

describe("planCompaction (pure)", () => {
  test("targets only done/cancelled tasks with over-threshold subtask details", () => {
    const tasks = [
      mkTask("1", {
        status: "done",
        subtasks: [
          mkSub("1", { details: LONG }),
          mkSub("2", { details: SHORT }),
        ],
      }),
      mkTask("2", {
        status: "in_progress",
        subtasks: [mkSub("1", { details: LONG })],
      }),
      mkTask("3", {
        status: "cancelled",
        subtasks: [mkSub("1", { details: LONG })],
      }),
      mkTask("4", { status: "done", subtasks: [mkSub("1", { details: SHORT })] }),
    ];
    const plan = planCompaction(tasks, { archiveDir: "/arch" });
    expect(plan.items.map((i) => i.task.id)).toEqual(["1", "3"]);
    expect(plan.subtaskCount).toBe(2);
    // only the over-threshold subtask of task 1
    expect(plan.items[0]!.subs.map((s) => s.id)).toEqual(["1"]);
    expect(plan.items[0]!.archivePath).toBe("/arch/ID-1-journals.md");
  });

  test("onlyTask restricts to a single task", () => {
    const tasks = [
      mkTask("1", { status: "done", subtasks: [mkSub("1", { details: LONG })] }),
      mkTask("3", { status: "done", subtasks: [mkSub("1", { details: LONG })] }),
    ];
    expect(
      planCompaction(tasks, { archiveDir: "/a", onlyTask: "3" }).items.map(
        (i) => i.task.id,
      ),
    ).toEqual(["3"]);
  });

  test("respects a custom threshold", () => {
    const tasks = [
      mkTask("1", {
        status: "done",
        subtasks: [mkSub("1", { details: "z".repeat(60) })],
      }),
    ];
    expect(
      planCompaction(tasks, { archiveDir: "/a", threshold: 50 }).subtaskCount,
    ).toBe(1);
    expect(
      planCompaction(tasks, { archiveDir: "/a", threshold: 100 }).subtaskCount,
    ).toBe(0);
  });

  test("empty plan when nothing qualifies; does not mutate input", () => {
    const tasks = [
      mkTask("1", {
        status: "pending",
        subtasks: [mkSub("1", { details: LONG })],
      }),
    ];
    const before = JSON.stringify(tasks);
    expect(planCompaction(tasks, { archiveDir: "/a" }).items).toHaveLength(0);
    expect(JSON.stringify(tasks)).toBe(before);
  });
});

describe("renderStub / renderArchive (pure)", () => {
  test("stub names the archive section + original length and stays below threshold", () => {
    const sub = mkSub("2", { title: "My sub", details: LONG });
    const stub = renderStub("9", sub, "2026-06-14");
    expect(stub).toContain("ledgers/archive/ID-9-journals.md section 9.2");
    expect(stub).toContain("original 500 chars");
    expect(stub.length).toBeLessThan(DEFAULT_COMPACTION_THRESHOLD);
  });

  test("archive has a task header + one section per subtask with full details", () => {
    const item = {
      task: mkTask("9", { title: "Big task", status: "done" }),
      archivePath: "/a/ID-9-journals.md",
      subs: [
        mkSub("1", { title: "First", details: "AAA" }),
        mkSub("2", { title: "Second", details: "BBB" }),
      ],
    };
    const md = renderArchive(item, "2026-06-14");
    expect(md).toContain("# ID-9 — archived subtask journals");
    expect(md).toContain("Task: Big task (status: done)");
    expect(md).toContain("## 9.1 — First\n\nAAA");
    expect(md).toContain("## 9.2 — Second\n\nBBB");
  });
});

describe("buildTruncationPatches (pure)", () => {
  test("emits one details patch per archived subtask with the right fieldPath", () => {
    const plan = planCompaction(
      [
        mkTask("9", {
          status: "done",
          subtasks: [
            mkSub("1", { details: LONG }),
            mkSub("2", { details: LONG }),
          ],
        }),
      ],
      { archiveDir: "/a" },
    );
    const patches = buildTruncationPatches(plan, "2026-06-14");
    expect(patches).toHaveLength(2);
    expect(patches[0]!.fieldPath).toEqual([
      "tasks",
      "9",
      "subtasks",
      "1",
      "details",
    ]);
    const p0 = patches[0]!;
    expect("newValue" in p0 ? String(p0.newValue) : "").toContain(
      "Journal archived",
    );
  });
});

describe("runCompaction (integration, temp ledger)", () => {
  let dir: string;
  let ledgerPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tv-compact-"));
    ledgerPath = join(dir, "task-list.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeLedger = (tasks: Task[]): void => {
    writeFileSync(ledgerPath, JSON.stringify(mkDoc(tasks), null, 2));
  };

  test("dry-run reports the plan and writes nothing", async () => {
    writeLedger([
      mkTask("1", { status: "done", subtasks: [mkSub("1", { details: LONG })] }),
    ]);
    const before = readFileSync(ledgerPath, "utf8");
    const res = await runCompaction(ledgerPath, {
      date: "2026-06-14",
      dryRun: true,
      regenMirrors: false,
    });
    expect(res.ok).toBe(true);
    expect(res.dryRun).toBe(true);
    expect(res.subtaskCount).toBe(1);
    expect(readFileSync(ledgerPath, "utf8")).toBe(before);
    expect(existsSync(join(dir, "archive"))).toBe(false);
  });

  test("archives then truncates: archive written, canonical shrinks, re-run idempotent", async () => {
    writeLedger([
      mkTask("1", {
        status: "done",
        subtasks: [mkSub("1", { title: "Sub one", details: LONG })],
      }),
    ]);
    const before = readFileSync(ledgerPath, "utf8").length;

    const res = await runCompaction(ledgerPath, {
      date: "2026-06-14",
      regenMirrors: false,
    });
    expect(res.ok).toBe(true);
    expect(res.subtaskCount).toBe(1);

    const archivePath = join(dir, "archive", "ID-1-journals.md");
    expect(existsSync(archivePath)).toBe(true);
    expect(readFileSync(archivePath, "utf8")).toContain(LONG); // full journal preserved

    const after = readFileSync(ledgerPath, "utf8");
    expect(after.length).toBeLessThan(before);
    expect(after).toContain("Journal archived 2026-06-14");
    expect(after).not.toContain(LONG);

    // a second run finds only sub-threshold stubs → no-op
    const res2 = await runCompaction(ledgerPath, {
      date: "2026-06-14",
      regenMirrors: false,
    });
    expect(res2.subtaskCount).toBe(0);
    expect(readFileSync(ledgerPath, "utf8")).toBe(after);
  });

  test("refuses to overwrite an existing archive (canonical untouched)", async () => {
    writeLedger([
      mkTask("1", { status: "done", subtasks: [mkSub("1", { details: LONG })] }),
    ]);
    mkdirSync(join(dir, "archive"), { recursive: true });
    writeFileSync(join(dir, "archive", "ID-1-journals.md"), "pre-existing");
    const before = readFileSync(ledgerPath, "utf8");

    const res = await runCompaction(ledgerPath, {
      date: "2026-06-14",
      regenMirrors: false,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("refusing to overwrite");
    expect(readFileSync(ledgerPath, "utf8")).toBe(before);
    expect(readFileSync(join(dir, "archive", "ID-1-journals.md"), "utf8")).toBe(
      "pre-existing",
    );
  });

  test("rejects a non-task-list ledger", async () => {
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        document_name: "Product Backlog",
        document_purpose: "x",
        related_documents: [],
        items: [],
      }),
    );
    const res = await runCompaction(ledgerPath, { date: "2026-06-14" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("task-list");
  });
});
