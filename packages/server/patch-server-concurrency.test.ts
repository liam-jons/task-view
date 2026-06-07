/**
 * Concurrency tests for the U9 mutation mutex — ID-90.11 (PRODUCT
 * invariants 38 mutex half + 46).
 *
 * The per-canonical-path promise-queue wraps every mutating handler body,
 * closing the intra-daemon TOCTOU window between the §5.4 mtime check
 * (patch-server.ts) and the atomic-write rename. Without it, two handlers
 * can BOTH pass the mtime check against the same on-disk state and the
 * second rename silently clobbers the first writer's bytes while both
 * report 200 (the lost-update hazard). With it:
 *
 *   - same-baseMtime concurrent writers → EXACTLY ONE 200; every loser
 *     gets a clean 409 mtime-mismatch (never a silent clobber);
 *   - the optimistic-concurrency retry (inv 46 "possibly via transparent
 *     retry" — the façade-side K2 behaviour) then lands BOTH edits with a
 *     monotonic mtime chain;
 *   - a promote transaction and a PATCH overlapping on task-list serialise
 *     on the shared canonical path — coherent final state, never an
 *     interleaved write.
 *
 * Real Bun.serve servers on port 0; fetch never mocked. Network binds need
 * `dangerouslyDisableSandbox: true` under the Claude harness. Synthetic
 * fixtures only (AC-I).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startPatchServer, type PatchServerHandle } from "./patch-server";

let testDir: string;
let handle: PatchServerHandle | null;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "task-view-concurrency-"));
  handle = null;
});

afterEach(async () => {
  if (handle) {
    await handle.stop(true);
    handle = null;
  }
  await rm(testDir, { recursive: true, force: true });
});

// ── Synthetic fixtures ───────────────────────────────────────────────────────

function makeTask(id: string) {
  return {
    id,
    title: `Synthetic task ${id}`,
    description: "Body.",
    status: "pending",
    priority: "should",
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
  };
}

function makeTaskListLedger(taskIds: string[]) {
  return {
    document_name: "Knowledge Hub Task List",
    document_purpose: "Synthetic fixture.",
    related_documents: [],
    tasks: taskIds.map(makeTask),
  };
}

function makeBacklogLedger() {
  return {
    document_name: "Product Backlog",
    document_purpose: "Synthetic fixture.",
    related_documents: [],
    items: [
      {
        id: "101",
        description: "Synthetic backlog item.",
        type: "feature",
        status: "ready",
        effort_estimate: null,
        priority: "medium",
        track: "infra",
        dependencies: [],
        session_refs: [],
        commit_refs: [],
        cross_doc_links: [],
        notes: null,
      },
    ],
  };
}

async function mtimeOf(path: string): Promise<string> {
  return (await stat(path)).mtime.toISOString();
}

function patchStatusNote(
  url: string,
  taskId: string,
  baseMtime: string,
  value: string,
): Promise<Response> {
  return fetch(`${url}/api/ledger/record/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify({
      baseMtime,
      patches: [
        { fieldPath: ["tasks", taskId, "status_note"], newValue: value },
      ],
    }),
  });
}

// ── Inv 38 mutex half: same-baseMtime writers can never silently clobber ────

describe("mutation mutex — TOCTOU closure on one document (inv 38 mutex half)", () => {
  test("8 concurrent same-baseMtime PATCHes: EXACTLY one 200, the rest 409 — never a lost update", async () => {
    const taskIds = ["1", "2", "3", "4", "5", "6", "7", "8"];
    const ledger = join(testDir, "task-list.json");
    await writeFile(
      ledger,
      JSON.stringify(makeTaskListLedger(taskIds), null, 2),
      "utf8",
    );
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await mtimeOf(ledger);

    // All eight share the SAME baseMtime — the classic interleave: without
    // the mutex several can pass the mtime check together, each folding its
    // patch over the SAME original bytes, and the last rename wins while
    // every earlier 200's edit is silently erased.
    const responses = await Promise.all(
      taskIds.map((id) =>
        patchStatusNote(handle!.url, id, baseMtime, `edit-${id}`),
      ),
    );

    const statuses = responses.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(7);

    // The single winner's edit — and ONLY that edit — landed; the document
    // is intact (parses + still carries all eight records).
    const final = await readFile(ledger, "utf8");
    const parsed = JSON.parse(final) as {
      tasks: Array<{ id: string; status_note: string | null }>;
    };
    expect(parsed.tasks).toHaveLength(8);
    const edited = parsed.tasks.filter((t) => t.status_note !== null);
    expect(edited).toHaveLength(1);
    expect(edited[0].status_note).toBe(`edit-${edited[0].id}`);

    // Every 409 is a clean mtime-mismatch the retry layer can absorb.
    for (const res of responses) {
      if (res.status === 409) {
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe("mtime-mismatch");
      }
    }
  });

  test("two writers with 409-retry both land; mtime chain is monotonic (inv 46)", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFile(
      ledger,
      JSON.stringify(makeTaskListLedger(["1", "2"]), null, 2),
      "utf8",
    );
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await mtimeOf(ledger);
    const url = handle.url;

    // Both writers start from the SAME read (same baseMtime) and edit
    // DIFFERENT records. The loser retries with fresh state — the K2
    // optimistic-concurrency loop the façade ships (inv 46 "possibly via
    // transparent retry").
    const landedMtimes: string[] = [];
    async function writeWithRetry(taskId: string, value: string) {
      let base = baseMtime;
      for (let attempt = 0; attempt < 5; attempt++) {
        const res = await patchStatusNote(url, taskId, base, value);
        if (res.status === 200) {
          const body = (await res.json()) as { newMtime: string };
          landedMtimes.push(body.newMtime);
          return;
        }
        expect(res.status).toBe(409);
        const body = (await res.json()) as { currentMtime: string };
        base = body.currentMtime;
      }
      throw new Error(`writer ${taskId} exhausted retries`);
    }

    await Promise.all([
      writeWithRetry("1", "edit-one"),
      writeWithRetry("2", "edit-two"),
    ]);

    // BOTH edits are in the final bytes — neither write was lost.
    const parsed = JSON.parse(await readFile(ledger, "utf8")) as {
      tasks: Array<{ id: string; status_note: string | null }>;
    };
    expect(parsed.tasks.find((t) => t.id === "1")?.status_note).toBe(
      "edit-one",
    );
    expect(parsed.tasks.find((t) => t.id === "2")?.status_note).toBe(
      "edit-two",
    );

    // mtime chain is monotonic across the two landed writes.
    expect(landedMtimes).toHaveLength(2);
    expect(Date.parse(landedMtimes[1])).toBeGreaterThanOrEqual(
      Date.parse(landedMtimes[0]),
    );
  });
});

// ── Inv 46/56: PATCH vs transaction on overlapping canonical paths ──────────

describe("mutation mutex — transaction + PATCH overlapping on task-list", () => {
  test("concurrent promote + PATCH serialise: exactly one 200, coherent final state", async () => {
    const taskListPath = join(testDir, "task-list.json");
    const backlogPath = join(testDir, "product-backlog.json");
    await writeFile(
      taskListPath,
      JSON.stringify(makeTaskListLedger(["1"]), null, 2),
      "utf8",
    );
    await writeFile(
      backlogPath,
      JSON.stringify(makeBacklogLedger(), null, 2),
      "utf8",
    );
    handle = startPatchServer({ ledgerPath: taskListPath });
    const taskListBaseMtime = await mtimeOf(taskListPath);
    const backlogBaseMtime = await mtimeOf(backlogPath);

    const [txRes, patchRes] = await Promise.all([
      fetch(`${handle.url}/api/ledger/transaction`, {
        method: "POST",
        body: JSON.stringify({
          op: "promote",
          sourceBacklogId: "101",
          taskRecord: makeTask("9"),
          taskListBaseMtime,
          backlogBaseMtime,
        }),
      }),
      patchStatusNote(handle.url, "1", taskListBaseMtime, "patched"),
    ]);

    // The two writers overlap on the task-list canonical path, so they
    // serialise: EXACTLY one wins, the other gets a clean 409. Without the
    // lock both can return 200 with the loser's write silently erasing the
    // winner's (the promoted Task vanishing is the silent-loss hazard).
    const statuses = [txRes.status, patchRes.status].sort();
    expect(statuses).toEqual([200, 409]);

    const finalTaskList = JSON.parse(
      await readFile(taskListPath, "utf8"),
    ) as { tasks: Array<{ id: string; status_note: string | null }> };
    const finalBacklog = JSON.parse(await readFile(backlogPath, "utf8")) as {
      items: Array<{ id: string }>;
    };

    if (txRes.status === 200) {
      // Transaction won: Task 9 present, backlog item gone, PATCH rejected.
      expect(finalTaskList.tasks.map((t) => t.id)).toEqual(["1", "9"]);
      expect(finalTaskList.tasks[0].status_note).toBeNull();
      expect(finalBacklog.items).toHaveLength(0);
    } else {
      // PATCH won: edit present, transaction rejected — BOTH legs intact
      // (validate-first means the backlog leg never staged).
      expect(finalTaskList.tasks.map((t) => t.id)).toEqual(["1"]);
      expect(finalTaskList.tasks[0].status_note).toBe("patched");
      expect(finalBacklog.items.map((i) => i.id)).toEqual(["101"]);
    }
  });
});
