/**
 * Tests for the U9 `--require-denylist` arming — ID-90.11 (PRODUCT
 * invariant 34).
 *
 * `startPatchServer({ requireDenylist: true })` arms record 8's client-name
 * guard fail-loud posture: an UNSET `KH_CLIENT_NAME_DENYLIST` env becomes
 * the same loud 500 `client-name-guard-config` error an invalid one already
 * is — on EVERY mutating path (PATCH / POST record / DELETE record / POST
 * subtasks / DELETE subtask / promote transaction legs). Nothing is ever
 * written. Default (flag absent) keeps the benign local no-op.
 *
 * Real Bun.serve servers on port 0 (repo convention); fetch never mocked.
 * Network binds need `dangerouslyDisableSandbox: true` under the Claude
 * harness. Synthetic fixtures only (AC-I) — no client-name tokens anywhere.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startPatchServer, type PatchServerHandle } from "./patch-server";

const ENV_KEY = "KH_CLIENT_NAME_DENYLIST";

/** Valid SYNTHETIC denylist (never a real token — AC-I). */
const SYNTH_DENYLIST = JSON.stringify({
  tokens: [{ value: "ZorbCo", case_insensitive: true }],
});

let testDir: string;
let handle: PatchServerHandle | null;
let savedEnv: string | undefined;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "task-view-require-denylist-"));
  handle = null;
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  if (handle) {
    await handle.stop(true);
    handle = null;
  }
  await rm(testDir, { recursive: true, force: true });
});

// ── Synthetic fixtures ───────────────────────────────────────────────────────

function makeTaskListLedger() {
  return {
    document_name: "Knowledge Hub Task List",
    document_purpose: "Synthetic fixture.",
    related_documents: [],
    tasks: [
      {
        id: "20",
        title: "Synthetic task 20",
        description: "Body.",
        status: "in_progress",
        priority: "must",
        dependencies: [],
        subtasks: [
          {
            id: "1",
            title: "Slice 1",
            description: "First slice.",
            details: "Details.",
            status: "done",
            dependencies: [],
            testStrategy: null,
          },
        ],
        updatedAt: "2026-05-21T15:30:00.000Z",
        effort_estimate: null,
        owner: null,
        priority_note: null,
        status_note: null,
        cross_doc_links: [],
        session_refs: [],
        commit_refs: [],
      },
      {
        id: "30",
        title: "Synthetic task 30",
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
      },
    ],
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

function makeNewTask(id: string) {
  return {
    id,
    title: `New synthetic task ${id}`,
    description: "Freshly created.",
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

async function writeLedgers(): Promise<{
  taskListPath: string;
  backlogPath: string;
}> {
  const taskListPath = join(testDir, "task-list.json");
  const backlogPath = join(testDir, "product-backlog.json");
  await writeFile(
    taskListPath,
    JSON.stringify(makeTaskListLedger(), null, 2),
    "utf8",
  );
  await writeFile(
    backlogPath,
    JSON.stringify(makeBacklogLedger(), null, 2),
    "utf8",
  );
  return { taskListPath, backlogPath };
}

async function mtimeOf(path: string): Promise<string> {
  return (await stat(path)).mtime.toISOString();
}

// ── Armed: every mutating path is a loud config error ───────────────────────

describe("--require-denylist + unset env — loud config error on EVERY mutation (inv 34)", () => {
  test("PATCH / POST / DELETE / subtask CRUD / transaction all 500 client-name-guard-config; nothing written", async () => {
    const { taskListPath, backlogPath } = await writeLedgers();
    const originalTaskList = await readFile(taskListPath, "utf8");
    const originalBacklog = await readFile(backlogPath, "utf8");
    handle = startPatchServer({
      ledgerPath: taskListPath,
      requireDenylist: true,
    });
    const baseMtime = await mtimeOf(taskListPath);
    const backlogBaseMtime = await mtimeOf(backlogPath);

    const attempts: Array<{ label: string; res: Response }> = [];

    attempts.push({
      label: "PATCH record",
      res: await fetch(`${handle.url}/api/ledger/record/20`, {
        method: "PATCH",
        body: JSON.stringify({
          baseMtime,
          patches: [
            { fieldPath: ["tasks", "20", "status_note"], newValue: "edited" },
          ],
        }),
      }),
    });
    attempts.push({
      label: "POST record",
      res: await fetch(`${handle.url}/api/ledger/record`, {
        method: "POST",
        body: JSON.stringify({ baseMtime, record: makeNewTask("40") }),
      }),
    });
    attempts.push({
      label: "DELETE record",
      res: await fetch(`${handle.url}/api/ledger/record/30`, {
        method: "DELETE",
        body: JSON.stringify({ baseMtime }),
      }),
    });
    attempts.push({
      label: "POST subtasks",
      res: await fetch(`${handle.url}/api/ledger/record/20/subtask`, {
        method: "POST",
        body: JSON.stringify({
          baseMtime,
          subtasks: [{ title: "New slice", description: "Body." }],
        }),
      }),
    });
    attempts.push({
      label: "DELETE subtask",
      res: await fetch(`${handle.url}/api/ledger/record/20/subtask/1`, {
        method: "DELETE",
        body: JSON.stringify({ baseMtime }),
      }),
    });
    attempts.push({
      label: "POST transaction (promote)",
      res: await fetch(`${handle.url}/api/ledger/transaction`, {
        method: "POST",
        body: JSON.stringify({
          op: "promote",
          sourceBacklogId: "101",
          taskRecord: makeNewTask("41"),
          taskListBaseMtime: baseMtime,
          backlogBaseMtime,
        }),
      }),
    });

    for (const { label, res } of attempts) {
      expect(`${label}:${res.status}`).toBe(`${label}:500`);
      const body = (await res.json()) as { error: string; detail: string };
      expect(body.error).toBe("client-name-guard-config");
      expect(body.detail).toContain("--require-denylist");
    }

    // Fail-LOUD means fail-CLOSED: no mutation landed on either ledger.
    expect(await readFile(taskListPath, "utf8")).toBe(originalTaskList);
    expect(await readFile(backlogPath, "utf8")).toBe(originalBacklog);
  });

  test("armed + VALID denylist env — clean mutations still land (arming is about absence, not presence)", async () => {
    const { taskListPath } = await writeLedgers();
    process.env[ENV_KEY] = SYNTH_DENYLIST;
    handle = startPatchServer({
      ledgerPath: taskListPath,
      requireDenylist: true,
    });
    const res = await fetch(`${handle.url}/api/ledger/record/20`, {
      method: "PATCH",
      body: JSON.stringify({
        baseMtime: await mtimeOf(taskListPath),
        patches: [
          { fieldPath: ["tasks", "20", "status_note"], newValue: "clean edit" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(await readFile(taskListPath, "utf8")).toContain("clean edit");
  });
});

// ── Default: unset env stays a benign no-op locally ──────────────────────────

describe("default (flag absent) — unset env keeps the benign local no-op", () => {
  test("PATCH succeeds with the env unset when requireDenylist is not armed", async () => {
    const { taskListPath } = await writeLedgers();
    handle = startPatchServer({ ledgerPath: taskListPath });
    const res = await fetch(`${handle.url}/api/ledger/record/20`, {
      method: "PATCH",
      body: JSON.stringify({
        baseMtime: await mtimeOf(taskListPath),
        patches: [
          { fieldPath: ["tasks", "20", "status_note"], newValue: "local edit" },
        ],
      }),
    });
    expect(res.status).toBe(200);
  });
});
