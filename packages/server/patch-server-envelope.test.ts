/**
 * Tests for the U10 request/response envelope extensions on the
 * single-document mutation handlers — ID-90.12 (PRODUCT invariants 16, 26,
 * 33, 41).
 *
 * Covers, over real HTTP against real Bun.serve servers (port 0):
 *   - `dryRun: true` — full gate chain runs, would-be payload returned,
 *     NO write / NO mirror regen / NO mtime change (invariant 16),
 *     byte-paranoid (exact bytes + mtimeMs compared).
 *   - `force` / `allowClientName` — strictly per-request (invariants 26,
 *     33): the forced/overridden request succeeds, the identical next
 *     request WITHOUT the field rejects.
 *   - `warnings?: string[]` — discipline ({35.30}-scoped) + budget
 *     soft-warns + forced downgrades + guard-override warnings compose on
 *     one envelope (invariant 41).
 *   - `regenMirrors: false` — write lands, regen skipped and REPORTED
 *     (`mirrorRegen: "suppressed"`).
 *   - present-but-non-boolean override field → 400 `invalid-json` (the
 *     established body-malformation code; the detail names the field).
 *
 * Network binds need `dangerouslyDisableSandbox: true` under the Claude
 * harness. Synthetic fixtures only (AC-I) — the established ZorbCo family.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startPatchServer, type PatchServerHandle } from "./patch-server";

const ENV_KEY = "KH_CLIENT_NAME_DENYLIST";

/** Valid SYNTHETIC denylist (never a real token — AC-I). */
const SYNTH_DENYLIST = JSON.stringify({
  tokens: [{ value: "ZorbCo", case_insensitive: true }],
});

const OVER_250 = "x".repeat(260);
const OVER_300 = "y".repeat(310);
const OVER_1500 = "z".repeat(1510);

let testDir: string;
let handle: PatchServerHandle | null;
let savedEnv: string | undefined;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "task-view-envelope-test-"));
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

function makeTask(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    title: `Synthetic task ${id}`,
    description: "Body.",
    status: "pending",
    priority: "should",
    dependencies: [],
    subtasks: [
      {
        id: "1",
        title: "Slice one",
        description: "First slice.",
        details: "Initial details.",
        status: "pending",
        dependencies: [],
        testStrategy: null,
      },
    ],
    updatedAt: "2026-06-01T12:00:00.000Z",
    effort_estimate: null,
    owner: null,
    priority_note: null,
    status_note: null,
    cross_doc_links: [],
    session_refs: [],
    commit_refs: [],
    ...overrides,
  };
}

function makeTaskListDoc(
  taskOverrides: Partial<Record<string, unknown>> = {},
) {
  return {
    document_name: "Knowledge Hub Task List",
    document_purpose: "Synthetic test ledger.",
    related_documents: [],
    tasks: [makeTask("20", taskOverrides)],
  };
}

async function writeLedger(
  doc: unknown,
  filename = "task-list.json",
): Promise<string> {
  const path = join(testDir, filename);
  await writeFile(path, JSON.stringify(doc, null, 2), "utf8");
  return path;
}

async function startServer(ledgerPath: string): Promise<string> {
  handle = startPatchServer({ ledgerPath, port: 0 });
  return handle.url;
}

async function snapshotFile(path: string): Promise<{
  bytes: Buffer;
  mtimeMs: number;
}> {
  const [bytes, st] = await Promise.all([readFile(path), stat(path)]);
  return { bytes, mtimeMs: st.mtimeMs };
}

async function mtimeOf(path: string): Promise<string> {
  return (await stat(path)).mtime.toISOString();
}

const mirrorDirOf = () => join(testDir, "tasks");

// ── dryRun (invariant 16) — byte-paranoid ────────────────────────────────────

describe("dryRun: true — full gates, would-be payload, NOTHING touched (inv 16)", () => {
  test("PATCH dryRun returns the would-be result with bytes + mtime byte-identical and no mirror artefacts", async () => {
    const ledgerPath = await writeLedger(makeTaskListDoc());
    const url = await startServer(ledgerPath);
    const before = await snapshotFile(ledgerPath);

    const res = await fetch(`${url}/api/ledger/record/20`, {
      method: "PATCH",
      body: JSON.stringify({
        baseMtime: await mtimeOf(ledgerPath),
        dryRun: true,
        patches: [
          { fieldPath: ["tasks", "20", "status"], newValue: "in_progress" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(body.recordId).toBe("20");
    // No write happened — there is no newMtime to report.
    expect(body.newMtime).toBeUndefined();

    const after = await snapshotFile(ledgerPath);
    expect(after.bytes.equals(before.bytes)).toBe(true);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    // No mirror regen artefacts.
    expect(existsSync(mirrorDirOf())).toBe(false);
  });

  test("a dryRun that violates a gate STILL rejects — dryRun never bypasses gates", async () => {
    const ledgerPath = await writeLedger(makeTaskListDoc());
    const url = await startServer(ledgerPath);
    const before = await snapshotFile(ledgerPath);

    // Budget gate: over-budget mutated field rejects even under dryRun.
    const budgetRes = await fetch(`${url}/api/ledger/record/20`, {
      method: "PATCH",
      body: JSON.stringify({
        baseMtime: await mtimeOf(ledgerPath),
        dryRun: true,
        patches: [
          { fieldPath: ["tasks", "20", "description"], newValue: OVER_1500 },
        ],
      }),
    });
    expect(budgetRes.status).toBe(422);
    const budgetBody = (await budgetRes.json()) as Record<string, unknown>;
    expect(budgetBody.error).toBe("budget-exceeded");

    // Client-name guard: net-new synthetic token rejects even under dryRun.
    process.env[ENV_KEY] = SYNTH_DENYLIST;
    const guardRes = await fetch(`${url}/api/ledger/record/20`, {
      method: "PATCH",
      body: JSON.stringify({
        baseMtime: await mtimeOf(ledgerPath),
        dryRun: true,
        patches: [
          {
            fieldPath: ["tasks", "20", "status_note"],
            newValue: "Mentions ZorbCo explicitly.",
          },
        ],
      }),
    });
    expect(guardRes.status).toBe(422);
    const guardBody = (await guardRes.json()) as Record<string, unknown>;
    expect(guardBody.error).toBe("client-name-guard");

    const after = await snapshotFile(ledgerPath);
    expect(after.bytes.equals(before.bytes)).toBe(true);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  test("POST record dryRun allocates the would-be id, writes nothing", async () => {
    const ledgerPath = await writeLedger(makeTaskListDoc());
    const url = await startServer(ledgerPath);
    const before = await snapshotFile(ledgerPath);

    const res = await fetch(`${url}/api/ledger/record`, {
      method: "POST",
      body: JSON.stringify({
        baseMtime: await mtimeOf(ledgerPath),
        dryRun: true,
        record: {
          title: "Would-be task",
          description: "Dry-run create.",
          priority: "should",
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(body.recordId).toBe("21"); // nextId max+1 over task 20

    const after = await snapshotFile(ledgerPath);
    expect(after.bytes.equals(before.bytes)).toBe(true);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(existsSync(mirrorDirOf())).toBe(false);
  });

  test("POST subtasks dryRun reports the would-be subtaskIds, writes nothing", async () => {
    const ledgerPath = await writeLedger(makeTaskListDoc());
    const url = await startServer(ledgerPath);
    const before = await snapshotFile(ledgerPath);

    const res = await fetch(`${url}/api/ledger/record/20/subtask`, {
      method: "POST",
      body: JSON.stringify({
        baseMtime: await mtimeOf(ledgerPath),
        dryRun: true,
        subtasks: [
          { title: "Would-be slice", description: "Dry-run subtask." },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(body.subtaskIds).toEqual(["2"]);

    const after = await snapshotFile(ledgerPath);
    expect(after.bytes.equals(before.bytes)).toBe(true);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  test("DELETE record + DELETE subtask dryRun write nothing", async () => {
    const ledgerPath = await writeLedger(makeTaskListDoc());
    const url = await startServer(ledgerPath);
    const before = await snapshotFile(ledgerPath);

    const delSub = await fetch(`${url}/api/ledger/record/20/subtask/1`, {
      method: "DELETE",
      body: JSON.stringify({
        baseMtime: await mtimeOf(ledgerPath),
        dryRun: true,
      }),
    });
    expect(delSub.status).toBe(200);
    const delSubBody = (await delSub.json()) as Record<string, unknown>;
    expect(delSubBody.ok).toBe(true);
    expect(delSubBody.dryRun).toBe(true);
    expect(delSubBody.subtaskId).toBe("1");

    const delRec = await fetch(`${url}/api/ledger/record/20`, {
      method: "DELETE",
      body: JSON.stringify({
        baseMtime: await mtimeOf(ledgerPath),
        dryRun: true,
      }),
    });
    expect(delRec.status).toBe(200);
    const delRecBody = (await delRec.json()) as Record<string, unknown>;
    expect(delRecBody.ok).toBe(true);
    expect(delRecBody.dryRun).toBe(true);
    expect(delRecBody.recordId).toBe("20");

    const after = await snapshotFile(ledgerPath);
    expect(after.bytes.equals(before.bytes)).toBe(true);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(existsSync(mirrorDirOf())).toBe(false);
  });
});

// ── force (invariant 26) — strictly per-request ──────────────────────────────

describe("force — per-request budget downgrade (inv 26)", () => {
  test("forced over-budget PATCH lands with the (forced) warning; the IDENTICAL next unforced request rejects", async () => {
    const ledgerPath = await writeLedger(makeTaskListDoc());
    const url = await startServer(ledgerPath);

    const forced = await fetch(`${url}/api/ledger/record/20`, {
      method: "PATCH",
      body: JSON.stringify({
        baseMtime: await mtimeOf(ledgerPath),
        force: true,
        patches: [
          { fieldPath: ["tasks", "20", "status_note"], newValue: OVER_300 },
        ],
      }),
    });
    expect(forced.status).toBe(200);
    const forcedBody = (await forced.json()) as {
      ok: boolean;
      warnings?: string[];
    };
    expect(forcedBody.ok).toBe(true);
    expect(
      forcedBody.warnings?.some((w) =>
        w.startsWith("(forced) budget-exceeded: status_note is 310 chars"),
      ),
    ).toBe(true);

    // The server holds NO override state: the same mutation without
    // `force` (fresh baseMtime — the file just changed) rejects.
    const unforced = await fetch(`${url}/api/ledger/record/20`, {
      method: "PATCH",
      body: JSON.stringify({
        baseMtime: await mtimeOf(ledgerPath),
        patches: [
          { fieldPath: ["tasks", "20", "status_note"], newValue: OVER_300 },
        ],
      }),
    });
    expect(unforced.status).toBe(422);
    const unforcedBody = (await unforced.json()) as Record<string, unknown>;
    expect(unforcedBody.error).toBe("budget-exceeded");
  });

  test("forced over-budget subtask CREATE lands; the identical next unforced batch rejects", async () => {
    const ledgerPath = await writeLedger(makeTaskListDoc());
    const url = await startServer(ledgerPath);

    const forced = await fetch(`${url}/api/ledger/record/20/subtask`, {
      method: "POST",
      body: JSON.stringify({
        baseMtime: await mtimeOf(ledgerPath),
        force: true,
        subtasks: [{ title: "Big slice", description: OVER_250 }],
      }),
    });
    expect(forced.status).toBe(201);
    const forcedBody = (await forced.json()) as {
      ok: boolean;
      warnings?: string[];
    };
    expect(forcedBody.ok).toBe(true);
    expect(
      forcedBody.warnings?.some((w) =>
        w.startsWith("(forced) budget-exceeded:"),
      ),
    ).toBe(true);

    const unforced = await fetch(`${url}/api/ledger/record/20/subtask`, {
      method: "POST",
      body: JSON.stringify({
        baseMtime: await mtimeOf(ledgerPath),
        subtasks: [{ title: "Big slice 2", description: OVER_250 }],
      }),
    });
    expect(unforced.status).toBe(422);
    const unforcedBody = (await unforced.json()) as Record<string, unknown>;
    expect(unforcedBody.error).toBe("budget-exceeded");
  });
});

// ── allowClientName (invariant 33) — strictly per-request ────────────────────

describe("allowClientName — per-request guard override (inv 33)", () => {
  test("override allows the net-new hit with a redacted warning; the next request WITHOUT it rejects", async () => {
    process.env[ENV_KEY] = SYNTH_DENYLIST;
    const ledgerPath = await writeLedger(makeTaskListDoc());
    const url = await startServer(ledgerPath);

    const allowed = await fetch(`${url}/api/ledger/record/20`, {
      method: "PATCH",
      body: JSON.stringify({
        baseMtime: await mtimeOf(ledgerPath),
        allowClientName: true,
        patches: [
          {
            fieldPath: ["tasks", "20", "status_note"],
            newValue: "Removed the ZorbCo reference from the corpus.",
          },
        ],
      }),
    });
    expect(allowed.status).toBe(200);
    const allowedBody = (await allowed.json()) as {
      ok: boolean;
      warnings?: string[];
    };
    expect(allowedBody.ok).toBe(true);
    const override = allowedBody.warnings?.find((w) =>
      w.startsWith("client-name-guard:"),
    );
    expect(override).toBeDefined();
    // Redaction: the warning never echoes the token.
    expect(override).not.toContain("ZorbCo");

    // Per-request only: a SECOND net-new hit without the override rejects.
    const rejected = await fetch(`${url}/api/ledger/record/20`, {
      method: "PATCH",
      body: JSON.stringify({
        baseMtime: await mtimeOf(ledgerPath),
        patches: [
          {
            fieldPath: ["tasks", "20", "priority_note"],
            newValue: "Another zorbco mention sneaks in.",
          },
        ],
      }),
    });
    expect(rejected.status).toBe(422);
    const rejectedBody = (await rejected.json()) as Record<string, unknown>;
    expect(rejectedBody.error).toBe("client-name-guard");
  });

  test("override threads through subtask POST and DELETE too", async () => {
    process.env[ENV_KEY] = SYNTH_DENYLIST;
    const ledgerPath = await writeLedger(makeTaskListDoc());
    const url = await startServer(ledgerPath);

    // POST subtask carrying a net-new synthetic token: rejected plain…
    const rejected = await fetch(`${url}/api/ledger/record/20/subtask`, {
      method: "POST",
      body: JSON.stringify({
        baseMtime: await mtimeOf(ledgerPath),
        subtasks: [{ title: "Slice", description: "Touches ZorbCo data." }],
      }),
    });
    expect(rejected.status).toBe(422);
    expect(
      ((await rejected.json()) as Record<string, unknown>).error,
    ).toBe("client-name-guard");

    // …allowed with the per-request override.
    const allowed = await fetch(`${url}/api/ledger/record/20/subtask`, {
      method: "POST",
      body: JSON.stringify({
        baseMtime: await mtimeOf(ledgerPath),
        allowClientName: true,
        subtasks: [{ title: "Slice", description: "Touches ZorbCo data." }],
      }),
    });
    expect(allowed.status).toBe(201);
    const allowedBody = (await allowed.json()) as {
      ok: boolean;
      warnings?: string[];
    };
    expect(
      allowedBody.warnings?.some((w) => w.startsWith("client-name-guard:")),
    ).toBe(true);
  });
});

// ── warnings[] composition (invariant 41) ────────────────────────────────────

describe("warnings[] — discipline + budget + forced + override compose (inv 41)", () => {
  test("one envelope carries all four warning families", async () => {
    process.env[ENV_KEY] = SYNTH_DENYLIST;
    // description is over-budget but UNTOUCHED → budget (untouched) soft-warn
    // + a {35.30}-scoped discipline line for the same task.
    const ledgerPath = await writeLedger(
      makeTaskListDoc({ description: OVER_1500 }),
    );
    const url = await startServer(ledgerPath);

    const res = await fetch(`${url}/api/ledger/record/20`, {
      method: "PATCH",
      body: JSON.stringify({
        baseMtime: await mtimeOf(ledgerPath),
        force: true,
        allowClientName: true,
        patches: [
          {
            // Mutated over-budget field carrying a net-new synthetic token:
            // budget hard-reject (downgraded by force) + guard hit
            // (downgraded by allowClientName).
            fieldPath: ["tasks", "20", "status_note"],
            newValue: `${OVER_300} — and a ZorbCo mention.`,
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; warnings?: string[] };
    expect(body.ok).toBe(true);
    const warnings = body.warnings ?? [];
    // Discipline ({35.30}-scoped to task 20).
    expect(
      warnings.some((w) => w.startsWith('Task "20" description is')),
    ).toBe(true);
    // Budget untouched soft-warn.
    expect(
      warnings.some((w) =>
        w.startsWith("budget (untouched): description is 1510 chars"),
      ),
    ).toBe(true);
    // Forced budget downgrade.
    expect(
      warnings.some((w) => w.startsWith("(forced) budget-exceeded:")),
    ).toBe(true);
    // Guard override (redacted).
    expect(
      warnings.some(
        (w) => w.startsWith("client-name-guard:") && !w.includes("ZorbCo"),
      ),
    ).toBe(true);
  });

  test("discipline warnings are {35.30}-bounded to the touched record", async () => {
    // Two over-budget tasks; patching task 20 must NOT surface task 30 noise.
    const doc = makeTaskListDoc({ description: OVER_1500 });
    doc.tasks.push(
      makeTask("30", { description: OVER_1500, subtasks: [] }),
    );
    const ledgerPath = await writeLedger(doc);
    const url = await startServer(ledgerPath);

    const res = await fetch(`${url}/api/ledger/record/20`, {
      method: "PATCH",
      body: JSON.stringify({
        baseMtime: await mtimeOf(ledgerPath),
        patches: [
          { fieldPath: ["tasks", "20", "status"], newValue: "in_progress" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { warnings?: string[] };
    const discipline = (body.warnings ?? []).filter((w) =>
      w.startsWith("Task "),
    );
    expect(discipline.some((w) => w.includes('"20"'))).toBe(true);
    expect(discipline.some((w) => w.includes('"30"'))).toBe(false);
  });
});

// ── regenMirrors: false — skip + report (K2 'suppressed' mapping) ────────────

describe("regenMirrors: false — write lands, regen skipped and reported", () => {
  test("PATCH with regenMirrors:false writes the canonical, creates no mirrors, reports suppressed", async () => {
    const ledgerPath = await writeLedger(makeTaskListDoc());
    const url = await startServer(ledgerPath);
    const beforeMtime = await mtimeOf(ledgerPath);

    const res = await fetch(`${url}/api/ledger/record/20`, {
      method: "PATCH",
      body: JSON.stringify({
        baseMtime: beforeMtime,
        regenMirrors: false,
        patches: [
          { fieldPath: ["tasks", "20", "status"], newValue: "in_progress" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.mirrorRegen).toBe("suppressed");
    expect(typeof body.newMtime).toBe("string");

    // Canonical wrote…
    const after = await readFile(ledgerPath, "utf8");
    expect(after).toContain('"in_progress"');
    // …but no mirror artefacts were produced.
    expect(existsSync(mirrorDirOf())).toBe(false);
  });
});

// ── invalid option values ────────────────────────────────────────────────────

describe("present-but-non-boolean override fields", () => {
  test("PATCH with dryRun: 'yes' → 400 invalid-json, nothing written", async () => {
    const ledgerPath = await writeLedger(makeTaskListDoc());
    const url = await startServer(ledgerPath);
    const before = await snapshotFile(ledgerPath);

    const res = await fetch(`${url}/api/ledger/record/20`, {
      method: "PATCH",
      body: JSON.stringify({
        baseMtime: await mtimeOf(ledgerPath),
        dryRun: "yes",
        patches: [
          { fieldPath: ["tasks", "20", "status"], newValue: "in_progress" },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid-json");
    expect(String(body.detail)).toContain("dryRun");

    const after = await snapshotFile(ledgerPath);
    expect(after.bytes.equals(before.bytes)).toBe(true);
  });
});

// ── Transaction endpoint (three-leg promote) — U10 envelope ──────────────────

import { readdir } from "node:fs/promises";

function makeBacklogDoc() {
  return {
    document_name: "Product Backlog",
    document_purpose: "Synthetic test backlog.",
    related_documents: [],
    items: [
      {
        id: "101",
        description: "A synthetic item ready to promote.",
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
      {
        id: "102",
        description: "A second synthetic item.",
        type: "feature",
        status: "ready",
        effort_estimate: "1h",
        priority: "medium",
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

function makeRoadmapDoc() {
  return {
    document_name: "Knowledge Hub Roadmap",
    document_purpose: "Synthetic test roadmap.",
    date: "2026-06-01",
    status: "Active",
    forward_looking_only: true,
    related_documents: [],
    last_updated: "synthetic-session-s0 fixture seed",
    themes: [
      {
        id: "3",
        title: "Synthetic theme",
        status: "in_progress",
        time_horizon: "now",
        description: "Theme body.",
        notes: null,
        linked_tasks: [],
        linked_backlog: [],
        session_refs: [],
        commit_refs: [],
        cross_doc_links: [],
      },
    ],
  };
}

function makeNewTask(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return makeTask(id, { subtasks: [], ...overrides });
}

async function writeTransactionLedgers(): Promise<{
  taskListPath: string;
  backlogPath: string;
  roadmapPath: string;
}> {
  return {
    taskListPath: await writeLedger(makeTaskListDoc(), "task-list.json"),
    backlogPath: await writeLedger(makeBacklogDoc(), "product-backlog.json"),
    roadmapPath: await writeLedger(makeRoadmapDoc(), "product-roadmap.json"),
  };
}

async function tempsIn(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.includes(".tmp."));
}

describe("transaction (promote) — U10 envelope", () => {
  test("dryRun: full three-leg gates, would-be payload, NOTHING staged or renamed (temps absent)", async () => {
    const paths = await writeTransactionLedgers();
    const url = await startServer(paths.taskListPath);
    const before = {
      taskList: await snapshotFile(paths.taskListPath),
      backlog: await snapshotFile(paths.backlogPath),
      roadmap: await snapshotFile(paths.roadmapPath),
    };

    const res = await fetch(`${url}/api/ledger/transaction`, {
      method: "POST",
      body: JSON.stringify({
        op: "promote",
        sourceBacklogId: "101",
        taskRecord: makeNewTask("99"),
        taskListBaseMtime: await mtimeOf(paths.taskListPath),
        backlogBaseMtime: await mtimeOf(paths.backlogPath),
        capabilityThemeId: "3",
        roadmapBaseMtime: await mtimeOf(paths.roadmapPath),
        dryRun: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(body.newTaskId).toBe("99");
    expect(body.removedBacklogId).toBe("101");
    expect(body.boundCapabilityTheme).toBe("3");

    // Byte-paranoia across ALL THREE legs.
    for (const [name, snap] of Object.entries(before)) {
      const path =
        name === "taskList"
          ? paths.taskListPath
          : name === "backlog"
            ? paths.backlogPath
            : paths.roadmapPath;
      const after = await snapshotFile(path);
      expect(after.bytes.equals(snap.bytes)).toBe(true);
      expect(after.mtimeMs).toBe(snap.mtimeMs);
    }
    // Stage NOTHING, rename NOTHING: no orphaned temps in the dir.
    expect(await tempsIn(testDir)).toEqual([]);
    // No mirror artefacts on any leg.
    expect(existsSync(join(testDir, "tasks"))).toBe(false);
    expect(existsSync(join(testDir, "backlog"))).toBe(false);
    expect(existsSync(join(testDir, "roadmap"))).toBe(false);
  });

  test("a dryRun promote that violates a gate STILL rejects (gates never bypassed)", async () => {
    const paths = await writeTransactionLedgers();
    const url = await startServer(paths.taskListPath);

    const res = await fetch(`${url}/api/ledger/transaction`, {
      method: "POST",
      body: JSON.stringify({
        op: "promote",
        sourceBacklogId: "101",
        taskRecord: makeNewTask("99", { description: OVER_1500 }),
        taskListBaseMtime: await mtimeOf(paths.taskListPath),
        backlogBaseMtime: await mtimeOf(paths.backlogPath),
        dryRun: true,
      }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as Record<string, unknown>).error).toBe(
      "budget-exceeded",
    );
    expect(await tempsIn(testDir)).toEqual([]);
  });

  test("force acts per-request: forced over-budget promote lands with discipline + forced warnings; the next unforced rejects", async () => {
    const paths = await writeTransactionLedgers();
    const url = await startServer(paths.taskListPath);

    const forced = await fetch(`${url}/api/ledger/transaction`, {
      method: "POST",
      body: JSON.stringify({
        op: "promote",
        sourceBacklogId: "101",
        taskRecord: makeNewTask("99", { description: OVER_1500 }),
        taskListBaseMtime: await mtimeOf(paths.taskListPath),
        backlogBaseMtime: await mtimeOf(paths.backlogPath),
        force: true,
      }),
    });
    expect(forced.status).toBe(200);
    const forcedBody = (await forced.json()) as {
      ok: boolean;
      warnings?: string[];
    };
    expect(forcedBody.ok).toBe(true);
    expect(
      forcedBody.warnings?.some((w) =>
        w.startsWith("(forced) budget-exceeded:"),
      ),
    ).toBe(true);
    // U10 invariant 41: discipline warnings {35.30}-scoped to the NEW task.
    expect(
      forcedBody.warnings?.some((w) => w.startsWith('Task "99" description is')),
    ).toBe(true);

    // Per-request only: the next unforced over-budget promote rejects.
    const unforced = await fetch(`${url}/api/ledger/transaction`, {
      method: "POST",
      body: JSON.stringify({
        op: "promote",
        sourceBacklogId: "102",
        taskRecord: makeNewTask("100", { description: OVER_1500 }),
        taskListBaseMtime: await mtimeOf(paths.taskListPath),
        backlogBaseMtime: await mtimeOf(paths.backlogPath),
      }),
    });
    expect(unforced.status).toBe(422);
    expect(((await unforced.json()) as Record<string, unknown>).error).toBe(
      "budget-exceeded",
    );
  });

  test("allowClientName acts per-request on the transaction legs", async () => {
    process.env[ENV_KEY] = SYNTH_DENYLIST;
    const paths = await writeTransactionLedgers();
    const url = await startServer(paths.taskListPath);

    const rejected = await fetch(`${url}/api/ledger/transaction`, {
      method: "POST",
      body: JSON.stringify({
        op: "promote",
        sourceBacklogId: "101",
        taskRecord: makeNewTask("99", {
          description: "Carries a ZorbCo reference.",
        }),
        taskListBaseMtime: await mtimeOf(paths.taskListPath),
        backlogBaseMtime: await mtimeOf(paths.backlogPath),
      }),
    });
    expect(rejected.status).toBe(422);
    expect(((await rejected.json()) as Record<string, unknown>).error).toBe(
      "client-name-guard",
    );

    const allowed = await fetch(`${url}/api/ledger/transaction`, {
      method: "POST",
      body: JSON.stringify({
        op: "promote",
        sourceBacklogId: "101",
        taskRecord: makeNewTask("99", {
          description: "Carries a ZorbCo reference.",
        }),
        taskListBaseMtime: await mtimeOf(paths.taskListPath),
        backlogBaseMtime: await mtimeOf(paths.backlogPath),
        allowClientName: true,
      }),
    });
    expect(allowed.status).toBe(200);
    const allowedBody = (await allowed.json()) as {
      ok: boolean;
      warnings?: string[];
    };
    expect(allowedBody.ok).toBe(true);
    const override = allowedBody.warnings?.find((w) =>
      w.startsWith("client-name-guard:"),
    );
    expect(override).toBeDefined();
    expect(override).not.toContain("ZorbCo");
  });

  test("regenMirrors:false — commit lands, regen skipped and reported suppressed", async () => {
    const paths = await writeTransactionLedgers();
    const url = await startServer(paths.taskListPath);

    const res = await fetch(`${url}/api/ledger/transaction`, {
      method: "POST",
      body: JSON.stringify({
        op: "promote",
        sourceBacklogId: "101",
        taskRecord: makeNewTask("99"),
        taskListBaseMtime: await mtimeOf(paths.taskListPath),
        backlogBaseMtime: await mtimeOf(paths.backlogPath),
        regenMirrors: false,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.mirrorRegen).toBe("suppressed");
    expect(body.mirrorsWritten).toEqual([]);
    expect(body.mirrorsDeleted).toEqual([]);
    // Canonicals committed…
    const taskList = await readFile(paths.taskListPath, "utf8");
    expect(taskList).toContain('"99"');
    const backlog = await readFile(paths.backlogPath, "utf8");
    expect(backlog).not.toContain('"101"');
    // …but no mirror artefacts.
    expect(existsSync(join(testDir, "tasks"))).toBe(false);
    expect(existsSync(join(testDir, "backlog"))).toBe(false);
  });

  test("present-but-non-boolean override field on the transaction body → 400 invalid-json", async () => {
    const paths = await writeTransactionLedgers();
    const url = await startServer(paths.taskListPath);

    const res = await fetch(`${url}/api/ledger/transaction`, {
      method: "POST",
      body: JSON.stringify({
        op: "promote",
        sourceBacklogId: "101",
        taskRecord: makeNewTask("99"),
        taskListBaseMtime: await mtimeOf(paths.taskListPath),
        backlogBaseMtime: await mtimeOf(paths.backlogPath),
        force: "yes",
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe(
      "invalid-json",
    );
  });
});
