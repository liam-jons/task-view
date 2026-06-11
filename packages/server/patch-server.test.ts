/**
 * Tests for patch-server — TECH §5.1, §5.4, §5.5, §5.8.
 *
 * Acceptance gates (per ID-20.8 PLAN):
 *   - "tests/integration/mtime-collision.test.ts modifies file out-of-band
 *      + asserts 409 Conflict + reload-button hint" (PRODUCT inv 37)
 *   - "tests/integration/multi-field-save.test.ts submits multiple
 *      FieldPatch in one request + asserts single regen" (PRODUCT inv 38)
 *
 * Endpoint coverage:
 *   GET /api/ledger
 *   GET /api/ledger/record/:recordId
 *   PATCH /api/ledger/record/:recordId
 *   POST /api/ledger/regen
 *
 * All tests spin a real Bun.serve server on a random loopback port and
 * exercise endpoints via fetch() — this is the integration layer where
 * mtime, atomic write, loopback bind, and multi-field regen compose.
 *
 * Network operations in tests require `dangerouslyDisableSandbox: true`
 * when run via the Claude harness — Bun.serve binds to a real socket
 * that the sandbox's listen-mode allowlist does not include. The same
 * gotcha applies to the loopback-bind smoke test.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPatchServer, type PatchServerHandle } from "./patch-server";
import { escapeSerialise } from "./scoped-serialise";

let testDir: string;
let handle: PatchServerHandle | null;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "task-view-patch-server-test-"));
  handle = null;
});

afterEach(async () => {
  if (handle) {
    await handle.stop(true);
    handle = null;
  }
  await rm(testDir, { recursive: true, force: true });
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeTaskListLedgerObject() {
  return {
    document_name: "Knowledge Hub Task List",
    document_purpose:
      "Active + recently-closed structured work — Taskmaster JSON shape.",
    related_documents: [],
    tasks: [
      {
        id: "20",
        title: "Per-Task mirror",
        description: "Outer task description.",
        status: "in_progress",
        priority: "must",
        dependencies: [],
        subtasks: [
          {
            id: "1",
            title: "Slice 1",
            description: "First slice.",
            details: "Details for slice 1.",
            status: "done",
            dependencies: [],
            testStrategy: "test strategy 1",
            updatedAt: "2026-05-21T15:30:00.000Z",
          },
          {
            id: "2",
            title: "Slice 2",
            description: "Second slice.",
            details: "Details for slice 2.",
            status: "pending",
            dependencies: ["1"],
            testStrategy: null,
          },
        ],
        updatedAt: "2026-05-21T15:30:00.000Z",
        effort_estimate: "~2-3h",
        owner: "Engineering",
        priority_note: null,
        status_note: null,
        cross_doc_links: [],
        session_refs: [],
        commit_refs: [],
      },
      {
        id: "30",
        title: "Other task",
        description: "Outer description for 30.",
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

async function writeFixtureTaskList(path: string): Promise<string> {
  const content = JSON.stringify(makeTaskListLedgerObject(), null, 2);
  await writeFile(path, content, "utf8");
  return content;
}

function makeBacklogLedgerObject() {
  return {
    document_name: "Product Backlog",
    document_purpose: "Forward-looking work items not yet promoted to Tasks.",
    related_documents: [],
    items: [
      {
        id: "101",
        description: "Add CSV export to the procurement table.",
        type: "feature",
        status: "ready",
        effort_estimate: "2-3h",
        priority: "high",
        track: "procurement",
        dependencies: [],
        session_refs: [],
        commit_refs: [],
        cross_doc_links: [],
        notes: null,
        details: "A pre-thought brief for the CSV export feature.",
        testStrategy: "Export matches the on-screen table rows exactly.",
      },
      {
        id: "102",
        description: "Investigate flaky e2e on CI.",
        type: "bug",
        status: "needs_research",
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

async function writeFixtureBacklog(path: string): Promise<string> {
  const content = JSON.stringify(makeBacklogLedgerObject(), null, 2);
  await writeFile(path, content, "utf8");
  return content;
}

function makeRoadmapLedgerObject() {
  return {
    document_name: "Knowledge Hub Roadmap",
    document_purpose: "Forward-looking capability roadmap.",
    date: "2026-05-25",
    status: "Active",
    forward_looking_only: true,
    related_documents: [],
    last_updated: "fixture",
    themes: [
      {
        id: "10",
        title: "Procurement intelligence",
        description: "Theme 10 description.",
        time_horizon: "now",
        status: "in_progress",
        // Links to a Task that exists in the task-list fixture (id 20) and
        // a backlog item that exists in the backlog fixture (id 101).
        linked_tasks: ["20"],
        linked_backlog: ["101"],
        session_refs: [],
        commit_refs: [],
        cross_doc_links: [],
        notes: null,
      },
    ],
  };
}

async function writeFixtureRoadmap(path: string): Promise<string> {
  const content = JSON.stringify(makeRoadmapLedgerObject(), null, 2);
  await writeFile(path, content, "utf8");
  return content;
}

/** A schema-valid new Task body for CREATE / Promote tests. */
function makeNewTaskRecord(id: string) {
  return {
    id,
    title: `New task ${id}`,
    description: "A freshly-created task.",
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

async function getLedgerMtime(path: string): Promise<string> {
  return (await stat(path)).mtime.toISOString();
}

// ── §5.8 + 20.8 launch contract: server factory + loopback bind ──────────────

describe("startPatchServer — loopback bind enforcement (PRODUCT inv 44)", () => {
  test("defaults to 127.0.0.1 when no hostname is supplied", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    expect(handle.hostname).toBe("127.0.0.1");
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.url).toContain("127.0.0.1");
  });

  test("canonicalises localhost to 127.0.0.1 when explicitly supplied", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger, hostname: "localhost" });
    expect(handle.hostname).toBe("127.0.0.1");
  });

  test("throws on non-loopback hostname (0.0.0.0) — security gate", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    expect(() =>
      startPatchServer({ ledgerPath: ledger, hostname: "0.0.0.0" }),
    ).toThrow(/loopback/i);
  });

  test("throws on public-IP hostname", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    expect(() =>
      startPatchServer({ ledgerPath: ledger, hostname: "8.8.8.8" }),
    ).toThrow();
  });
});

// ── §5.1 GET /api/ledger ──────────────────────────────────────────────────────

describe("GET /api/ledger", () => {
  test("returns { kind, data, mirrorDir, mtime } for a valid task-list ledger", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });

    const res = await fetch(`${handle.url}/api/ledger`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      kind: string;
      data: { tasks: { id: string }[] };
      mirrorDir: string;
      mirrorDirName: string;
      mtime: string;
    };
    expect(body.ok).toBe(true);
    expect(body.kind).toBe("task-list");
    expect(body.data.tasks).toHaveLength(2);
    expect(body.mirrorDirName).toBe("tasks");
    expect(body.mirrorDir).toContain("tasks");
    expect(body.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("returns 422 for an unknown document_name", async () => {
    const ledger = join(testDir, "weird.json");
    await writeFile(ledger, JSON.stringify({ document_name: "Foo" }), "utf8");
    handle = startPatchServer({ ledgerPath: ledger });
    const res = await fetch(`${handle.url}/api/ledger`);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; documentName: string };
    expect(body.error).toBe("unknown-document-name");
    expect(body.documentName).toBe("Foo");
  });

  test("returns 500 when ledger file is missing", async () => {
    handle = startPatchServer({ ledgerPath: join(testDir, "missing.json") });
    const res = await fetch(`${handle.url}/api/ledger`);
    expect(res.status).toBe(500);
  });
});

// ── §5.1 GET /api/ledger/record/:recordId ────────────────────────────────────

describe("GET /api/ledger/record/:recordId", () => {
  test("returns the named Task record for a task-list ledger", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });

    const res = await fetch(`${handle.url}/api/ledger/record/20`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      kind: string;
      record: { id: string; title: string };
      mirrorFilename: string;
      mtime: string;
    };
    expect(body.ok).toBe(true);
    expect(body.kind).toBe("task");
    expect(body.record.id).toBe("20");
    expect(body.record.title).toBe("Per-Task mirror");
    expect(body.mirrorFilename).toBe("ID-20.md");
  });

  test("returns 404 for an unknown record id", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });

    const res = await fetch(`${handle.url}/api/ledger/record/999`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("record-not-found");
  });
});

// ── §5.4 PATCH /api/ledger/record/:recordId + mtime collision ───────────────

describe("PATCH /api/ledger/record/:recordId — happy path", () => {
  test("applies a single FieldPatch and returns 200 + newMtime", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });

    const baseMtime = await getLedgerMtime(ledger);
    // Wait 5ms so the mtime delta is observable after write.
    await new Promise((r) => setTimeout(r, 5));

    const res = await fetch(`${handle.url}/api/ledger/record/20`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseMtime,
        patches: [
          {
            fieldPath: ["tasks", "20", "status"],
            newValue: "done",
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      newMtime: string;
      mirrorsWritten: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.newMtime).not.toBe(baseMtime);
    // ID-20.md mirror was regenerated:
    expect(body.mirrorsWritten).toContain("ID-20.md");

    // Canonical reflects the change:
    const updated = JSON.parse(await readFile(ledger, "utf8")) as {
      tasks: { id: string; status: string }[];
    };
    expect(updated.tasks[0].status).toBe("done");
  });

  test("returns 400 when patches array is empty", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);

    const res = await fetch(`${handle.url}/api/ledger/record/20`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseMtime, patches: [] }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 when baseMtime is missing", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });

    const res = await fetch(`${handle.url}/api/ledger/record/20`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        patches: [{ fieldPath: ["tasks", "20", "status"], newValue: "done" }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing-baseMtime");
  });

  test("returns 422 with ZodError issues when schema validation fails (PRODUCT inv 29)", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);

    const res = await fetch(`${handle.url}/api/ledger/record/20`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseMtime,
        patches: [
          {
            fieldPath: ["tasks", "20", "status"],
            newValue: "not_a_valid_status",
          },
        ],
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: string;
      issues: { message: string }[];
    };
    expect(body.error).toBe("schema-error");
    expect(body.issues.length).toBeGreaterThan(0);

    // Canonical is UNCHANGED (atomic-write was never called):
    const stillOriginal = JSON.parse(await readFile(ledger, "utf8")) as {
      tasks: { id: string; status: string }[];
    };
    expect(stillOriginal.tasks[0].status).toBe("in_progress");
  });

  test("returns 400 with walk-error detail when fieldPath references unknown task id", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);

    const res = await fetch(`${handle.url}/api/ledger/record/999`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseMtime,
        patches: [{ fieldPath: ["tasks", "999", "status"], newValue: "done" }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("walk-error");
    expect(body.detail).toContain('Task id "999"');
  });
});

describe("PATCH /api/ledger/record/:recordId — mtime collision (PRODUCT inv 37, TECH §5.4)", () => {
  test("returns 409 Conflict with currentMtime + reload hint when file mtime advanced after baseMtime", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });

    const baseMtime = await getLedgerMtime(ledger);

    // Out-of-band write: another agent / process modifies the file
    // AFTER the viewer loaded it. We bump mtime explicitly via utimes
    // so the test is deterministic (file system mtime resolution
    // varies by OS / FS, so we shouldn't rely on a microsleep alone).
    const before = await stat(ledger);
    const advanced = new Date(before.mtime.getTime() + 5000); // +5s
    await utimes(ledger, before.atime, advanced);
    const newCurrent = await getLedgerMtime(ledger);
    expect(newCurrent).not.toBe(baseMtime);

    const res = await fetch(`${handle.url}/api/ledger/record/20`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseMtime,
        patches: [{ fieldPath: ["tasks", "20", "status"], newValue: "done" }],
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      ok: boolean;
      error: string;
      currentMtime: string;
      hint: string;
    };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("mtime-mismatch");
    expect(body.currentMtime).toBe(newCurrent);
    // The hint string is what the viewer surfaces near the "Reload from
    // disk" button per PRODUCT inv 37. Wording can evolve; the test
    // asserts the marker words 'reload' is present so the client knows
    // the intent.
    expect(body.hint.toLowerCase()).toContain("reload");

    // Canonical is UNCHANGED — patch never landed:
    const stillOriginal = JSON.parse(await readFile(ledger, "utf8")) as {
      tasks: { id: string; status: string }[];
    };
    expect(stillOriginal.tasks[0].status).toBe("in_progress");
  });

  test("returns 400 when baseMtime is unparseable ISO 8601", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });

    const res = await fetch(`${handle.url}/api/ledger/record/20`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseMtime: "not-a-date",
        patches: [{ fieldPath: ["tasks", "20", "status"], newValue: "done" }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid-baseMtime");
  });
});

// ── §5.5 multi-field save ────────────────────────────────────────────────────

describe("PATCH /api/ledger/record/:recordId — multi-field save (PRODUCT inv 38, TECH §5.5)", () => {
  test("applies multiple patches in one PATCH request and reflects all changes", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);

    const res = await fetch(`${handle.url}/api/ledger/record/20`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseMtime,
        patches: [
          { fieldPath: ["tasks", "20", "status"], newValue: "done" },
          { fieldPath: ["tasks", "20", "priority"], newValue: "should" },
          {
            fieldPath: ["tasks", "20", "subtasks", "1", "status"],
            newValue: "in_progress",
          },
        ],
      }),
    });
    expect(res.status).toBe(200);

    const updated = JSON.parse(await readFile(ledger, "utf8")) as {
      tasks: {
        id: string;
        status: string;
        priority: string;
        subtasks: { id: number; status: string }[];
      }[];
    };
    expect(updated.tasks[0].status).toBe("done");
    expect(updated.tasks[0].priority).toBe("should");
    expect(updated.tasks[0].subtasks[0].status).toBe("in_progress");
  });

  test("multi-field PATCH regenerates ONLY the touched record's mirror (PRODUCT inv 38 / Subtask 20.23)", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);

    const res = await fetch(`${handle.url}/api/ledger/record/20`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseMtime,
        patches: [
          { fieldPath: ["tasks", "20", "status"], newValue: "done" },
          { fieldPath: ["tasks", "20", "priority"], newValue: "should" },
          {
            fieldPath: ["tasks", "20", "subtasks", "2", "status"],
            newValue: "in_progress",
          },
          {
            fieldPath: ["tasks", "20", "subtasks", "2", "testStrategy"],
            newValue: "added strategy",
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mirrorsWritten: string[];
      mirrorsDeleted: string[];
    };
    // Subtask 20.23: a multi-field PATCH to record 20 regenerates ONLY
    // ID-20.md — NOT the whole ledger. The four patches still produce a
    // single scoped write (not one per field), and the untouched ID-30.md
    // is not in the written set.
    expect(body.mirrorsWritten).toEqual(["ID-20.md"]);
    expect(body.mirrorsWritten).not.toContain("ID-30.md");
    expect(body.mirrorsDeleted).toEqual([]);
  });

  test("unaffected mirror mtime is stable across a multi-field PATCH (Subtask 20.23)", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });

    // Materialise both mirrors first via a full regen (POST /regen), then
    // capture the untouched mirror's mtime.
    const regenRes = await fetch(`${handle.url}/api/ledger/regen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(regenRes.status).toBe(200);
    const otherMirror = join(testDir, "tasks", "ID-30.md");
    const touchedMirror = join(testDir, "tasks", "ID-20.md");
    const otherMtimeBefore = (await stat(otherMirror)).mtime.getTime();
    const touchedMtimeBefore = (await stat(touchedMirror)).mtime.getTime();

    // Sleep so any mtime change is observable on coarse-resolution FS.
    await new Promise((r) => setTimeout(r, 15));

    const baseMtime = await getLedgerMtime(ledger);
    const res = await fetch(`${handle.url}/api/ledger/record/20`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseMtime,
        patches: [
          { fieldPath: ["tasks", "20", "status"], newValue: "done" },
          { fieldPath: ["tasks", "20", "priority"], newValue: "should" },
        ],
      }),
    });
    expect(res.status).toBe(200);

    const otherMtimeAfter = (await stat(otherMirror)).mtime.getTime();
    const touchedMtimeAfter = (await stat(touchedMirror)).mtime.getTime();

    // The untouched mirror's mtime is unchanged …
    expect(otherMtimeAfter).toBe(otherMtimeBefore);
    // … while the touched mirror WAS rewritten (mtime advanced).
    expect(touchedMtimeAfter).toBeGreaterThan(touchedMtimeBefore);

    // The touched mirror reflects the new content; the untouched one is
    // byte-identical to its pre-PATCH form.
    const touchedContent = await readFile(touchedMirror, "utf8");
    expect(touchedContent).toContain("status: done");
  });

  test("multi-patch is atomic: one schema error rejects the whole batch + canonical unchanged", async () => {
    const ledger = join(testDir, "task-list.json");
    const originalContent = await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);

    const res = await fetch(`${handle.url}/api/ledger/record/20`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseMtime,
        patches: [
          // valid:
          { fieldPath: ["tasks", "20", "status"], newValue: "done" },
          // INVALID — schema rejects:
          {
            fieldPath: ["tasks", "20", "priority"],
            newValue: "not_a_priority",
          },
        ],
      }),
    });
    expect(res.status).toBe(422);

    // Canonical content is BYTE-IDENTICAL to the original — atomic-write
    // never ran:
    const stillContent = await readFile(ledger, "utf8");
    expect(stillContent).toBe(originalContent);
  });
});

// ── §5.1 POST /api/ledger/regen ──────────────────────────────────────────────

describe("POST /api/ledger/regen", () => {
  test("regenerates all mirrors and returns the list of files written", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });

    const res = await fetch(`${handle.url}/api/ledger/regen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      mirrorDir: string;
      mirrorsWritten: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.mirrorsWritten.sort()).toEqual(["ID-20.md", "ID-30.md"]);

    // Mirror dir actually contains the files:
    const written = await readdir(join(testDir, "tasks"));
    expect(written.sort()).toEqual(["ID-20.md", "ID-30.md"]);
  });

  test("rejects regen with 409 when supplied baseMtime is stale", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);

    // Advance mtime out-of-band:
    const before = await stat(ledger);
    await utimes(ledger, before.atime, new Date(before.mtime.getTime() + 5000));

    const res = await fetch(`${handle.url}/api/ledger/regen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseMtime }),
    });
    expect(res.status).toBe(409);
  });
});

// ── ID-20.15 POST /api/ledger/record — record CREATE ─────────────────────────

describe("POST /api/ledger/record — record CREATE (ID-20.15)", () => {
  test("creates a new Task, returns 201 + new mirror, and persists it", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);
    await new Promise((r) => setTimeout(r, 5));

    const res = await fetch(`${handle.url}/api/ledger/record`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseMtime, record: makeNewTaskRecord("42") }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      ok: boolean;
      recordId: string;
      newMtime: string;
      mirrorsWritten: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.recordId).toBe("42");
    expect(body.mirrorsWritten).toContain("ID-42.md");
    expect(body.newMtime).not.toBe(baseMtime);

    const updated = JSON.parse(await readFile(ledger, "utf8")) as {
      tasks: { id: string }[];
    };
    expect(updated.tasks.map((t) => t.id).sort()).toEqual(["20", "30", "42"]);
    // The new mirror exists on disk:
    const written = await readdir(join(testDir, "tasks"));
    expect(written).toContain("ID-42.md");
  });

  test("creates a new backlog item with bare-digit id", async () => {
    const ledger = join(testDir, "product-backlog.json");
    await writeFixtureBacklog(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);

    const newItem = {
      id: "103",
      description: "Brand new item.",
      type: "feature",
      status: "ready",
      effort_estimate: null,
      priority: "low",
      track: "platform",
      dependencies: [],
      session_refs: [],
      commit_refs: [],
      cross_doc_links: [],
      notes: null,
    };
    const res = await fetch(`${handle.url}/api/ledger/record`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseMtime, record: newItem }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      recordId: string;
      mirrorsWritten: string[];
    };
    expect(body.recordId).toBe("103");
    expect(body.mirrorsWritten).toContain("103.md");
  });

  test("rejects a duplicate id with 409", async () => {
    const ledger = join(testDir, "task-list.json");
    const original = await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);

    const res = await fetch(`${handle.url}/api/ledger/record`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseMtime, record: makeNewTaskRecord("20") }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; recordId: string };
    expect(body.error).toBe("duplicate-id");
    expect(body.recordId).toBe("20");
    // Canonical untouched:
    expect(await readFile(ledger, "utf8")).toBe(original);
  });

  test("rejects a malformed record with 422 schema-error + leaves canonical untouched", async () => {
    const ledger = join(testDir, "task-list.json");
    const original = await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);

    const bad = { ...makeNewTaskRecord("42"), status: "not_a_status" };
    const res = await fetch(`${handle.url}/api/ledger/record`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseMtime, record: bad }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; issues: unknown[] };
    expect(body.error).toBe("schema-error");
    expect(body.issues.length).toBeGreaterThan(0);
    expect(await readFile(ledger, "utf8")).toBe(original);
  });

  test("returns 409 mtime-mismatch when baseMtime is stale", async () => {
    const ledger = join(testDir, "task-list.json");
    const original = await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);

    const before = await stat(ledger);
    await utimes(ledger, before.atime, new Date(before.mtime.getTime() + 5000));

    const res = await fetch(`${handle.url}/api/ledger/record`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseMtime, record: makeNewTaskRecord("42") }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("mtime-mismatch");
    expect(await readFile(ledger, "utf8")).toBe(original);
  });

  test("returns 400 when record body is missing", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);
    const res = await fetch(`${handle.url}/api/ledger/record`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseMtime }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing-record");
  });
});

// ── ID-20.15 DELETE /api/ledger/record/:recordId — record DELETE ─────────────

describe("DELETE /api/ledger/record/:recordId — record DELETE (ID-20.15)", () => {
  test("deletes a Task, returns 200, removes the orphaned mirror", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });

    // Materialise both mirrors first.
    await fetch(`${handle.url}/api/ledger/regen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(await readdir(join(testDir, "tasks"))).toContain("ID-30.md");

    const baseMtime = await getLedgerMtime(ledger);
    await new Promise((r) => setTimeout(r, 5));

    const res = await fetch(`${handle.url}/api/ledger/record/30`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseMtime }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      recordId: string;
      mirrorsDeleted: string[];
      newMtime: string;
    };
    expect(body.ok).toBe(true);
    expect(body.recordId).toBe("30");
    expect(body.mirrorsDeleted).toContain("ID-30.md");

    const updated = JSON.parse(await readFile(ledger, "utf8")) as {
      tasks: { id: string }[];
    };
    expect(updated.tasks.map((t) => t.id)).toEqual(["20"]);
    // Orphaned mirror gone:
    expect(await readdir(join(testDir, "tasks"))).not.toContain("ID-30.md");
  });

  test("returns 404 when the record id is absent", async () => {
    const ledger = join(testDir, "task-list.json");
    const original = await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);

    const res = await fetch(`${handle.url}/api/ledger/record/999`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseMtime }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("record-not-found");
    expect(await readFile(ledger, "utf8")).toBe(original);
  });

  test("returns 409 mtime-mismatch when baseMtime is stale", async () => {
    const ledger = join(testDir, "task-list.json");
    const original = await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);

    const before = await stat(ledger);
    await utimes(ledger, before.atime, new Date(before.mtime.getTime() + 5000));

    const res = await fetch(`${handle.url}/api/ledger/record/20`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseMtime }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("mtime-mismatch");
    expect(await readFile(ledger, "utf8")).toBe(original);
  });

  test("returns 400 when baseMtime is missing", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const res = await fetch(`${handle.url}/api/ledger/record/20`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing-baseMtime");
  });
});

// ── ID-20.15 POST /api/ledger/transaction — cross-ledger Promote ─────────────

describe("POST /api/ledger/transaction — cross-ledger Promote (ID-20.15)", () => {
  /** Set up a dir with BOTH a task-list + a backlog ledger. */
  async function setupCrossLedger(): Promise<{
    taskListPath: string;
    backlogPath: string;
  }> {
    const taskListPath = join(testDir, "task-list.json");
    const backlogPath = join(testDir, "product-backlog.json");
    await writeFixtureTaskList(taskListPath);
    await writeFixtureBacklog(backlogPath);
    return { taskListPath, backlogPath };
  }

  test("promote removes the backlog item AND adds the Task in one op", async () => {
    const { taskListPath, backlogPath } = await setupCrossLedger();
    // Launch the server against the backlog ledger — the sibling resolver
    // finds the task-list ledger in the same dir.
    handle = startPatchServer({ ledgerPath: backlogPath });

    const taskListBaseMtime = await getLedgerMtime(taskListPath);
    const backlogBaseMtime = await getLedgerMtime(backlogPath);

    const res = await fetch(`${handle.url}/api/ledger/transaction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        op: "promote",
        sourceBacklogId: "101",
        taskRecord: makeNewTaskRecord("42"),
        taskListBaseMtime,
        backlogBaseMtime,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      newTaskId: string;
      removedBacklogId: string;
    };
    expect(body.ok).toBe(true);
    expect(body.newTaskId).toBe("42");
    expect(body.removedBacklogId).toBe("101");

    // Backlog item removed:
    const backlog = JSON.parse(await readFile(backlogPath, "utf8")) as {
      items: { id: string }[];
    };
    expect(backlog.items.map((i) => i.id)).toEqual(["102"]);
    // Task added:
    const taskList = JSON.parse(await readFile(taskListPath, "utf8")) as {
      tasks: { id: string }[];
    };
    expect(taskList.tasks.map((t) => t.id).sort()).toEqual(["20", "30", "42"]);
  });

  test("returns 409 when the task-list baseMtime is stale (neither file mutated)", async () => {
    const { taskListPath, backlogPath } = await setupCrossLedger();
    handle = startPatchServer({ ledgerPath: backlogPath });
    const taskListBaseMtime = await getLedgerMtime(taskListPath);
    const backlogBaseMtime = await getLedgerMtime(backlogPath);

    const taskOriginal = await readFile(taskListPath, "utf8");
    const backlogOriginal = await readFile(backlogPath, "utf8");

    // Advance task-list mtime out-of-band.
    const before = await stat(taskListPath);
    await utimes(
      taskListPath,
      before.atime,
      new Date(before.mtime.getTime() + 5000),
    );

    const res = await fetch(`${handle.url}/api/ledger/transaction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        op: "promote",
        sourceBacklogId: "101",
        taskRecord: makeNewTaskRecord("42"),
        taskListBaseMtime,
        backlogBaseMtime,
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("mtime-mismatch");

    // BOTH files unchanged (content-wise — we only bumped task-list mtime).
    expect(await readFile(taskListPath, "utf8")).toBe(taskOriginal);
    expect(await readFile(backlogPath, "utf8")).toBe(backlogOriginal);
  });

  test("returns 409 when the backlog baseMtime is stale", async () => {
    const { taskListPath, backlogPath } = await setupCrossLedger();
    handle = startPatchServer({ ledgerPath: backlogPath });
    const taskListBaseMtime = await getLedgerMtime(taskListPath);
    const backlogBaseMtime = await getLedgerMtime(backlogPath);
    const taskOriginal = await readFile(taskListPath, "utf8");
    const backlogOriginal = await readFile(backlogPath, "utf8");

    const before = await stat(backlogPath);
    await utimes(
      backlogPath,
      before.atime,
      new Date(before.mtime.getTime() + 5000),
    );

    const res = await fetch(`${handle.url}/api/ledger/transaction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        op: "promote",
        sourceBacklogId: "101",
        taskRecord: makeNewTaskRecord("42"),
        taskListBaseMtime,
        backlogBaseMtime,
      }),
    });
    expect(res.status).toBe(409);
    expect(await readFile(taskListPath, "utf8")).toBe(taskOriginal);
    expect(await readFile(backlogPath, "utf8")).toBe(backlogOriginal);
  });

  test("returns 404 when the source backlog id is absent", async () => {
    const { taskListPath, backlogPath } = await setupCrossLedger();
    handle = startPatchServer({ ledgerPath: backlogPath });
    const taskListBaseMtime = await getLedgerMtime(taskListPath);
    const backlogBaseMtime = await getLedgerMtime(backlogPath);
    const taskOriginal = await readFile(taskListPath, "utf8");
    const backlogOriginal = await readFile(backlogPath, "utf8");

    const res = await fetch(`${handle.url}/api/ledger/transaction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        op: "promote",
        sourceBacklogId: "999",
        taskRecord: makeNewTaskRecord("42"),
        taskListBaseMtime,
        backlogBaseMtime,
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("backlog-item-not-found");
    // Neither file touched (validation-first):
    expect(await readFile(taskListPath, "utf8")).toBe(taskOriginal);
    expect(await readFile(backlogPath, "utf8")).toBe(backlogOriginal);
  });

  test("returns 409 duplicate-id when the new Task id already exists", async () => {
    const { taskListPath, backlogPath } = await setupCrossLedger();
    handle = startPatchServer({ ledgerPath: backlogPath });
    const taskListBaseMtime = await getLedgerMtime(taskListPath);
    const backlogBaseMtime = await getLedgerMtime(backlogPath);
    const taskOriginal = await readFile(taskListPath, "utf8");
    const backlogOriginal = await readFile(backlogPath, "utf8");

    const res = await fetch(`${handle.url}/api/ledger/transaction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        op: "promote",
        sourceBacklogId: "101",
        taskRecord: makeNewTaskRecord("20"), // 20 already exists
        taskListBaseMtime,
        backlogBaseMtime,
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("duplicate-id");
    expect(await readFile(taskListPath, "utf8")).toBe(taskOriginal);
    expect(await readFile(backlogPath, "utf8")).toBe(backlogOriginal);
  });

  test("returns 500 no-sibling-ledger when only one ledger is present", async () => {
    const backlogPath = join(testDir, "product-backlog.json");
    await writeFixtureBacklog(backlogPath);
    handle = startPatchServer({ ledgerPath: backlogPath });
    const backlogBaseMtime = await getLedgerMtime(backlogPath);

    const res = await fetch(`${handle.url}/api/ledger/transaction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        op: "promote",
        sourceBacklogId: "101",
        taskRecord: makeNewTaskRecord("42"),
        taskListBaseMtime: new Date().toISOString(),
        backlogBaseMtime,
      }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("no-sibling-ledger");
  });

  test("rejects an unsupported op with 400", async () => {
    const { backlogPath } = await setupCrossLedger();
    handle = startPatchServer({ ledgerPath: backlogPath });
    const res = await fetch(`${handle.url}/api/ledger/transaction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "demote" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unsupported-op");
  });
});

// ── Method routing + 404 ─────────────────────────────────────────────────────

describe("HTTP routing — method-not-allowed + 404", () => {
  test("rejects unsupported HTTP method on the record endpoint with 405", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    // PUT is genuinely unsupported (GET/PATCH/DELETE are routed; ID-20.15
    // added DELETE so it can no longer stand in for "unsupported").
    const res = await fetch(`${handle.url}/api/ledger/record/20`, {
      method: "PUT",
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("GET");
    expect(res.headers.get("allow")).toContain("PATCH");
    expect(res.headers.get("allow")).toContain("DELETE");
  });

  test("returns 404 for unknown paths", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const res = await fetch(`${handle.url}/api/nonexistent`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; path: string };
    expect(body.error).toBe("not-found");
  });
});

// ── Cross-cutting: atomic write integrity end-to-end ─────────────────────────

describe("PATCH end-to-end — atomic write integrity (PRODUCT inv 36)", () => {
  test("after PATCH the canonical file is fully valid JSON parseable by the schema (no partial write)", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);

    const res = await fetch(`${handle.url}/api/ledger/record/20`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseMtime,
        patches: [
          {
            fieldPath: ["tasks", "20", "description"],
            newValue: "Updated body.",
          },
        ],
      }),
    });
    expect(res.status).toBe(200);

    const rawAfter = await readFile(ledger, "utf8");
    // Full JSON parseable:
    const parsed = JSON.parse(rawAfter) as { tasks: { description: string }[] };
    expect(parsed.tasks[0].description).toBe("Updated body.");
    // No temp-file leftovers from atomicWriteFile:
    const dirEntries = await readdir(testDir);
    const leftovers = dirEntries.filter((e) => e.includes(".tmp."));
    expect(leftovers).toEqual([]);
  });
});

// ── {20.29} GET / cross-ledger nav (SPEC §5 slice 6) ─────────────────────────

describe("GET / — cross-ledger nav ({20.29} SPEC §5 slice 6)", () => {
  test("launched on roadmap, /?ledger=task-list&record=20 → 200 read-only task", async () => {
    // All three siblings co-located in the launch dir (the real KH layout).
    await writeFixtureRoadmap(join(testDir, "product-roadmap.json"));
    await writeFixtureTaskList(join(testDir, "task-list.json"));
    await writeFixtureBacklog(join(testDir, "product-backlog.json"));
    handle = startPatchServer({
      ledgerPath: join(testDir, "product-roadmap.json"),
    });

    const res = await fetch(`${handle.url}/?ledger=task-list&record=20`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('data-record-kind="task"');
    expect(html).toContain('data-record-id="20"');
    expect(html).toContain("Per-Task mirror"); // real Task 20 title
    // Read-only: no edit affordances on the sibling. (The bare class name
    // appears in the inlined stylesheet, so assert on the actual button
    // markup / the dispatcher hooks instead.)
    expect(html).not.toContain("data-edit-action");
    expect(html).not.toContain("data-edit-field");
    expect(html).not.toContain('class="record-view-pencil-button"');
    // Read-only banner naming the launched (roadmap) + sibling (task list).
    expect(html).toContain("data-ledger-banner");
    expect(html).toContain("Back to launched ledger");
    expect(html).toContain("Roadmap"); // launched ledger named
  });

  test("launched on task-list, /?ledger=roadmap&record=10 → 200 theme content", async () => {
    await writeFixtureTaskList(join(testDir, "task-list.json"));
    await writeFixtureRoadmap(join(testDir, "product-roadmap.json"));
    await writeFixtureBacklog(join(testDir, "product-backlog.json"));
    handle = startPatchServer({ ledgerPath: join(testDir, "task-list.json") });

    const res = await fetch(`${handle.url}/?ledger=roadmap&record=10`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-record-kind="roadmap-theme"');
    expect(html).toContain('data-record-id="10"');
    expect(html).toContain("Procurement intelligence");
    // Theme 10 links to Task 20 (exists in sibling task-list) + backlog 101
    // → live cross-ledger links, NOT (missing).
    expect(html).toContain('href="/?ledger=task-list&amp;record=20"');
    expect(html).toContain('data-cross-ledger="task-list"');
    expect(html).toContain('href="/?ledger=backlog&amp;record=101"');
    expect(html).not.toContain("(missing)");
  });

  test("absent sibling ledger in dir → 404 HTML, not 500", async () => {
    // Only the roadmap is present; no task-list sibling to resolve.
    await writeFixtureRoadmap(join(testDir, "product-roadmap.json"));
    handle = startPatchServer({
      ledgerPath: join(testDir, "product-roadmap.json"),
    });

    const res = await fetch(`${handle.url}/?ledger=task-list&record=20`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html.toLowerCase()).toContain("not available");
    expect(html).toContain('href="/"'); // back to launched ledger
  });

  test("sibling present but record id absent → 404 not-found", async () => {
    await writeFixtureRoadmap(join(testDir, "product-roadmap.json"));
    await writeFixtureTaskList(join(testDir, "task-list.json"));
    handle = startPatchServer({
      ledgerPath: join(testDir, "product-roadmap.json"),
    });

    const res = await fetch(`${handle.url}/?ledger=task-list&record=999`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('data-record-kind="not-found"');
  });

  test("bare /?record=N (no ledger param) is unchanged — launched ledger, editable", async () => {
    await writeFixtureRoadmap(join(testDir, "product-roadmap.json"));
    await writeFixtureTaskList(join(testDir, "task-list.json"));
    handle = startPatchServer({
      ledgerPath: join(testDir, "product-roadmap.json"),
    });

    const res = await fetch(`${handle.url}/?record=10`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-record-kind="roadmap-theme"');
    expect(html).toContain('data-record-id="10"');
    // Launched ledger is editable → pencils present.
    expect(html).toContain("data-edit-action");
  });

  test("?ledger=roadmap on a roadmap launch is identical to bare ?record (self)", async () => {
    await writeFixtureRoadmap(join(testDir, "product-roadmap.json"));
    await writeFixtureTaskList(join(testDir, "task-list.json"));
    handle = startPatchServer({
      ledgerPath: join(testDir, "product-roadmap.json"),
    });

    const res = await fetch(`${handle.url}/?ledger=roadmap&record=10`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-record-kind="roadmap-theme"');
    // Self-target → launched ledger → editable.
    expect(html).toContain("data-edit-action");
  });

  test("?ledger=roadmap&record=999 → 404 (missing record in launched-self)", async () => {
    await writeFixtureRoadmap(join(testDir, "product-roadmap.json"));
    handle = startPatchServer({
      ledgerPath: join(testDir, "product-roadmap.json"),
    });
    const res = await fetch(`${handle.url}/?ledger=roadmap&record=999`);
    expect(res.status).toBe(404);
  });
});

// ── {20.30} GET / reverse cross-ledger backlinks (server-computed index) ─────

describe("GET / — reverse appears-in-themes backlinks ({20.30})", () => {
  test("launched on backlog, /?record=101 renders an appears-in-themes backlink to its theme", async () => {
    // Roadmap theme 10 lists backlog 101 in linked_backlog (forward). The
    // launched backlog page has no roadmap pointer field — the server reads
    // the roadmap sibling and computes the reverse index to produce the link.
    await writeFixtureBacklog(join(testDir, "product-backlog.json"));
    await writeFixtureRoadmap(join(testDir, "product-roadmap.json"));
    handle = startPatchServer({
      ledgerPath: join(testDir, "product-backlog.json"),
    });

    const res = await fetch(`${handle.url}/?record=101`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-record-kind="backlog-item"');
    expect(html).toContain('data-frontmatter-row="appears_in_themes"');
    expect(html).toContain('href="/?ledger=roadmap&amp;record=10"');
    expect(html).toContain('data-cross-ledger="roadmap"');
    expect(html).toContain("theme 10: Procurement intelligence");
  });

  test("following that backlink (/?ledger=roadmap&record=10) lands on the theme, read-only", async () => {
    await writeFixtureBacklog(join(testDir, "product-backlog.json"));
    await writeFixtureRoadmap(join(testDir, "product-roadmap.json"));
    handle = startPatchServer({
      ledgerPath: join(testDir, "product-backlog.json"),
    });

    const res = await fetch(`${handle.url}/?ledger=roadmap&record=10`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-record-kind="roadmap-theme"');
    expect(html).toContain('data-record-id="10"');
    expect(html).toContain("Procurement intelligence");
    // Sibling roadmap is read-only; launched ledger is the backlog.
    expect(html).toContain("data-ledger-banner");
    expect(html).not.toContain("data-edit-action");
  });

  test("launched on backlog WITHOUT a roadmap sibling → no backlink row", async () => {
    await writeFixtureBacklog(join(testDir, "product-backlog.json"));
    handle = startPatchServer({
      ledgerPath: join(testDir, "product-backlog.json"),
    });

    const res = await fetch(`${handle.url}/?record=101`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-record-kind="backlog-item"');
    expect(html).not.toContain('data-frontmatter-row="appears_in_themes"');
  });

  test("launched on task-list, /?record=20 renders the task's appears-in-themes backlink", async () => {
    // Theme 10's linked_tasks include task 20 → reverse backlink on task 20.
    await writeFixtureTaskList(join(testDir, "task-list.json"));
    await writeFixtureRoadmap(join(testDir, "product-roadmap.json"));
    handle = startPatchServer({ ledgerPath: join(testDir, "task-list.json") });

    const res = await fetch(`${handle.url}/?record=20`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-frontmatter-row="appears_in_themes"');
    expect(html).toContain('href="/?ledger=roadmap&amp;record=10"');
  });
});

// ── ID-90 U1: conforming serialisation on every write path (inv 18-20) ────────
//
// The server's written bytes must follow the on-disk ledger convention:
// non-ASCII as \uXXXX escapes, on-disk key order (never Zod-reparse reorder),
// a single trailing newline — and a single-field PATCH must produce a minimal
// scoped diff (the whole-file re-emit class is structurally impossible).

describe("ID-90 U1 — conforming write-path bytes (invariants 18-20)", () => {
  // Pure-ASCII source discipline: glyphs assembled from escapes.
  const EM_DASH = "—";
  const ARROW = "→";
  const RAW_NON_ASCII = new RegExp("[\\u0080-\\uffff]");

  /** An em-dash-bearing task-list, written CONFORMINGLY (escaped + newline). */
  function makeEscapedTaskListObject() {
    const obj = makeTaskListLedgerObject();
    obj.document_purpose = `Ledger fixture ${EM_DASH} byte discipline.`;
    obj.tasks[0].description = `Outer task description ${EM_DASH} alpha.`;
    obj.tasks[1].description = `Outer description for 30 ${ARROW} beta.`;
    return obj;
  }

  async function writeConformingTaskList(path: string): Promise<string> {
    const content = escapeSerialise(makeEscapedTaskListObject());
    await writeFile(path, content, "utf8");
    return content;
  }

  function changedLines(original: string, next: string): number[] {
    const a = original.split("\n");
    const b = next.split("\n");
    expect(b.length).toBe(a.length);
    return a
      .map((line, i) => (line === b[i] ? null : i))
      .filter((i): i is number => i !== null);
  }

  test("single-field PATCH writes a minimal scoped diff with escapes + trailing newline", async () => {
    const ledger = join(testDir, "task-list.json");
    const original = await writeConformingTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);

    const res = await fetch(`${handle.url}/api/ledger/record/20`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseMtime,
        patches: [
          { fieldPath: ["tasks", "20", "status"], newValue: "done" },
        ],
      }),
    });
    expect(res.status).toBe(200);

    const written = await readFile(ledger, "utf8");
    // Exactly ONE line changed in the whole file (invariant 19).
    const changed = changedLines(original, written);
    expect(changed).toHaveLength(1);
    expect(written.split("\n")[changed[0]]).toContain('"status": "done"');
    // Conforming bytes (invariant 18): escapes survive, no raw non-ASCII,
    // single trailing newline, untouched Task 30 block byte-identical.
    expect(RAW_NON_ASCII.test(written)).toBe(false);
    expect(written).toContain("\\u2014");
    expect(written).toContain("\\u2192");
    expect(written.endsWith("}\n")).toBe(true);
    expect(written.endsWith("}\n\n")).toBe(false);
    const block30 = original.slice(original.indexOf('"id": "30"'));
    expect(written).toContain(block30);
  });

  test("multi-field PATCH folds scoped serialisation — N changed lines for N patches", async () => {
    const ledger = join(testDir, "task-list.json");
    const original = await writeConformingTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);

    const res = await fetch(`${handle.url}/api/ledger/record/20`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseMtime,
        patches: [
          { fieldPath: ["tasks", "20", "status"], newValue: "done" },
          {
            fieldPath: ["tasks", "20", "subtasks", "2", "status"],
            newValue: "in_progress",
          },
        ],
      }),
    });
    expect(res.status).toBe(200);

    const written = await readFile(ledger, "utf8");
    expect(changedLines(original, written)).toHaveLength(2);
    expect(written.endsWith("}\n")).toBe(true);
  });

  test("POST record create splices — untouched records keep their exact bytes", async () => {
    const ledger = join(testDir, "task-list.json");
    const original = await writeConformingTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);

    const newRecord = {
      ...makeNewTaskRecord("40"),
      description: `A freshly-created task ${EM_DASH} spliced.`,
    };
    const res = await fetch(`${handle.url}/api/ledger/record`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseMtime, record: newRecord }),
    });
    expect(res.status).toBe(201);

    const written = await readFile(ledger, "utf8");
    // Task 20's block is byte-identical (from its id line to Task 30's).
    const start20 = original.indexOf('"id": "20"');
    const start30 = original.indexOf('"id": "30"');
    expect(written).toContain(original.slice(start20, start30));
    // New record present, conforming bytes throughout.
    expect(written).toContain('"id": "40"');
    expect(RAW_NON_ASCII.test(written)).toBe(false);
    expect(written).toContain("\\u2014");
    expect(written.endsWith("}\n")).toBe(true);
  });

  test("DELETE record re-emits the whole file conformingly (escapes + newline)", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeConformingTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);

    const res = await fetch(`${handle.url}/api/ledger/record/30`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseMtime }),
    });
    expect(res.status).toBe(200);

    const written = await readFile(ledger, "utf8");
    expect(RAW_NON_ASCII.test(written)).toBe(false);
    expect(written).toContain("\\u2014"); // remaining records keep escapes
    expect(written.endsWith("}\n")).toBe(true);
    expect(written.endsWith("}\n\n")).toBe(false);
    const parsed = JSON.parse(written) as { tasks: { id: string }[] };
    expect(parsed.tasks.map((t) => t.id)).toEqual(["20"]);
  });
});

// ── ID-90.9 U5/U6: subtask endpoints + create auto-id/defaults + append ───────

describe("POST /api/ledger/record — auto-id + create defaults (ID-90.9 U5)", () => {
  test("allocates nextId and applies create defaults when the body is minimal", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);

    // Minimal body: no id, no status, no subtasks — defaults fill them and
    // nextId allocates max(20, 30)+1 = "31".
    const res = await fetch(`${handle.url}/api/ledger/record`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseMtime,
        record: { title: "Minimal", description: "d", priority: "should" },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; recordId: string };
    expect(body.ok).toBe(true);
    expect(body.recordId).toBe("31");

    // Create defaults observable in the WRITTEN bytes:
    const updated = JSON.parse(await readFile(ledger, "utf8")) as {
      tasks: Record<string, unknown>[];
    };
    const created = updated.tasks.find((t) => t.id === "31")!;
    expect(created.status).toBe("pending");
    expect(created.dependencies).toEqual([]);
    expect(created.subtasks).toEqual([]);
    expect(created.owner).toBeNull();
    expect(typeof created.updatedAt).toBe("string");
    expect(Number.isFinite(Date.parse(created.updatedAt as string))).toBe(true);
  });
});

describe("POST /api/ledger/record/:taskId/subtask — bulk subtask CREATE (ID-90.9 U5, inv 37)", () => {
  test("201: fold-left sequential ids, create defaults in the written bytes, untouched records byte-identical", async () => {
    const ledger = join(testDir, "task-list.json");
    const original = await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);
    await new Promise((r) => setTimeout(r, 5));

    const res = await fetch(`${handle.url}/api/ledger/record/20/subtask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseMtime,
        subtasks: [
          { title: "New slice 3", description: "Third slice." },
          { title: "New slice 4", description: "Fourth slice." },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      ok: boolean;
      subtaskIds: string[];
      taskId: string;
      newMtime: string;
    };
    expect(body.ok).toBe(true);
    expect(body.taskId).toBe("20");
    // Existing subtask max id is 2 → fold-left allocates 3 then 4.
    expect(body.subtaskIds).toEqual(["3", "4"]);

    const text = await readFile(ledger, "utf8");
    const updated = JSON.parse(text) as {
      tasks: { id: string; subtasks: Record<string, unknown>[] }[];
    };
    const subs = updated.tasks[0].subtasks;
    expect(subs.map((s) => s.id)).toEqual(["1", "2", "3", "4"]);
    // Create defaults observable in the written bytes:
    const added = subs[2];
    expect(added.status).toBe("pending");
    expect(added.dependencies).toEqual([]);
    expect(added.details).toBe("");
    expect(added.testStrategy).toBeNull();
    // Untouched Task 30 block stays byte-identical:
    const block30 = original.slice(original.indexOf('"id": "30"'));
    expect(text).toContain(block30);
  });

  test("an explicit id mid-batch is kept; later auto-ids never collide", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);

    const res = await fetch(`${handle.url}/api/ledger/record/20/subtask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseMtime,
        subtasks: [
          { id: "7", title: "Explicit", description: "d" },
          { title: "Auto", description: "d" },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { subtaskIds: string[] };
    expect(body.subtaskIds).toEqual(["7", "8"]);
  });

  test("409 duplicate-id for an explicit id colliding with an existing sibling; nothing written", async () => {
    const ledger = join(testDir, "task-list.json");
    const original = await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);

    const res = await fetch(`${handle.url}/api/ledger/record/20/subtask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseMtime,
        subtasks: [{ id: "2", title: "Dup", description: "d" }],
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; subtaskId: string };
    expect(body.error).toBe("duplicate-id");
    expect(body.subtaskId).toBe("2");
    expect(await readFile(ledger, "utf8")).toBe(original);
  });

  test("422 budget-exceeded per record (create mode) with the subtask <parent>.<id> label; nothing written", async () => {
    const ledger = join(testDir, "task-list.json");
    const original = await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);

    const res = await fetch(`${handle.url}/api/ledger/record/20/subtask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseMtime,
        subtasks: [
          { title: "ok", description: "fine" },
          // subtask.description budget is 250 — 260 chars exceeds it.
          { title: "over", description: "x".repeat(260) },
        ],
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("budget-exceeded");
    // ID-35.27 label: `subtask 20.4` (second record allocated id 4).
    expect(body.detail).toContain("subtask 20.4");
    expect(await readFile(ledger, "utf8")).toBe(original);
  });

  test("404 record-not-found for an absent parent task", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);

    const res = await fetch(`${handle.url}/api/ledger/record/999/subtask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseMtime,
        subtasks: [{ title: "x", description: "d" }],
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("record-not-found");
  });

  test("409 mtime-mismatch when baseMtime is stale; nothing written", async () => {
    const ledger = join(testDir, "task-list.json");
    const original = await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);
    const before = await stat(ledger);
    await utimes(ledger, before.atime, new Date(before.mtime.getTime() + 5000));

    const res = await fetch(`${handle.url}/api/ledger/record/20/subtask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseMtime,
        subtasks: [{ title: "x", description: "d" }],
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("mtime-mismatch");
    expect(await readFile(ledger, "utf8")).toBe(original);
  });

  test("400 missing-baseMtime / missing-subtasks / empty batch", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);

    const noMtime = await fetch(`${handle.url}/api/ledger/record/20/subtask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subtasks: [{ title: "x", description: "d" }] }),
    });
    expect(noMtime.status).toBe(400);
    expect(((await noMtime.json()) as { error: string }).error).toBe(
      "missing-baseMtime",
    );

    const noSubtasks = await fetch(
      `${handle.url}/api/ledger/record/20/subtask`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseMtime }),
      },
    );
    expect(noSubtasks.status).toBe(400);
    expect(((await noSubtasks.json()) as { error: string }).error).toBe(
      "missing-subtasks",
    );

    const empty = await fetch(`${handle.url}/api/ledger/record/20/subtask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseMtime, subtasks: [] }),
    });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toBe(
      "invalid-body",
    );
  });
});

describe("DELETE /api/ledger/record/:taskId/subtask/:subId — subtask DELETE (ID-90.9 U5)", () => {
  test("200: removes the subtask; untouched records stay byte-identical", async () => {
    const ledger = join(testDir, "task-list.json");
    const original = await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);
    await new Promise((r) => setTimeout(r, 5));

    // Subtask 2 depends on 1, so 2 is the dependency-safe removal.
    const res = await fetch(`${handle.url}/api/ledger/record/20/subtask/2`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseMtime }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      taskId: string;
      subtaskId: string;
    };
    expect(body.ok).toBe(true);
    expect(body.taskId).toBe("20");
    expect(body.subtaskId).toBe("2");

    const text = await readFile(ledger, "utf8");
    const updated = JSON.parse(text) as {
      tasks: { subtasks: { id: string }[] }[];
    };
    expect(updated.tasks[0].subtasks.map((s) => s.id)).toEqual(["1"]);
    // Untouched Task 30 block stays byte-identical:
    const block30 = original.slice(original.indexOf('"id": "30"'));
    expect(text).toContain(block30);
  });

  test("404 record-not-found for an absent subId; nothing written", async () => {
    const ledger = join(testDir, "task-list.json");
    const original = await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);

    const res = await fetch(`${handle.url}/api/ledger/record/20/subtask/99`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseMtime }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(
      "record-not-found",
    );
    expect(await readFile(ledger, "utf8")).toBe(original);
  });

  test("400 invalid-id for a non-integer subId", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);

    const res = await fetch(`${handle.url}/api/ledger/record/20/subtask/abc`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseMtime }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid-id");
  });

  test("409 mtime-mismatch when baseMtime is stale; nothing written", async () => {
    const ledger = join(testDir, "task-list.json");
    const original = await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);
    const before = await stat(ledger);
    await utimes(ledger, before.atime, new Date(before.mtime.getTime() + 5000));

    const res = await fetch(`${handle.url}/api/ledger/record/20/subtask/2`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseMtime }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "mtime-mismatch",
    );
    expect(await readFile(ledger, "utf8")).toBe(original);
  });
});

describe("PATCH /api/ledger/record/:recordId — appendText op (ID-90.9 U6, inv 39)", () => {
  test("append-journal: prior details bytes preserved verbatim, block appended", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const baseMtime = await getLedgerMtime(ledger);
    await new Promise((r) => setTimeout(r, 5));

    const block =
      "\n\n<info added on 2026-06-07T00:00:00.000Z>\nShipped the slice.\n</info added on 2026-06-07T00:00:00.000Z>";
    const res = await fetch(`${handle.url}/api/ledger/record/20`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseMtime,
        patches: [
          {
            fieldPath: ["tasks", "20", "subtasks", "1", "details"],
            appendText: block,
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const updated = JSON.parse(await readFile(ledger, "utf8")) as {
      tasks: { subtasks: { details: string }[] }[];
    };
    // Prior value preserved VERBATIM as the prefix; block appended after.
    expect(updated.tasks[0].subtasks[0].details).toBe(
      `Details for slice 1.${block}`,
    );
  });
});

// ── ID-90 U7: POST /api/ledger/transaction — capability-theme third leg ──────

describe("POST /api/ledger/transaction — capability-theme third leg (ID-90 U7)", () => {
  async function setupThreeLedgers(): Promise<{
    taskListPath: string;
    backlogPath: string;
    roadmapPath: string;
    roadmapOriginal: string;
  }> {
    const taskListPath = join(testDir, "task-list.json");
    const backlogPath = join(testDir, "product-backlog.json");
    const roadmapPath = join(testDir, "product-roadmap.json");
    await writeFixtureTaskList(taskListPath);
    await writeFixtureBacklog(backlogPath);
    const roadmapOriginal = await writeFixtureRoadmap(roadmapPath);
    return { taskListPath, backlogPath, roadmapPath, roadmapOriginal };
  }

  test("promote with capabilityThemeId binds the Task AND pushes linked_tasks[]", async () => {
    const { taskListPath, backlogPath, roadmapPath } = await setupThreeLedgers();
    handle = startPatchServer({ ledgerPath: backlogPath });

    const res = await fetch(`${handle.url}/api/ledger/transaction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        op: "promote",
        sourceBacklogId: "101",
        taskRecord: makeNewTaskRecord("42"),
        taskListBaseMtime: await getLedgerMtime(taskListPath),
        backlogBaseMtime: await getLedgerMtime(backlogPath),
        capabilityThemeId: "10",
        roadmapBaseMtime: await getLedgerMtime(roadmapPath),
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      newTaskId: string;
      boundCapabilityTheme?: string;
      roadmapMtime?: string;
    };
    expect(body.ok).toBe(true);
    expect(body.newTaskId).toBe("42");
    expect(body.boundCapabilityTheme).toBe("10");
    expect(typeof body.roadmapMtime).toBe("string");

    const roadmap = JSON.parse(await readFile(roadmapPath, "utf8")) as {
      themes: { linked_tasks: string[] }[];
    };
    expect(roadmap.themes[0].linked_tasks).toEqual(["20", "42"]);
    const taskList = JSON.parse(await readFile(taskListPath, "utf8")) as {
      tasks: { id: string; capability_theme?: string }[];
    };
    expect(
      taskList.tasks.find((t) => t.id === "42")?.capability_theme,
    ).toBe("10");
  });

  test("unknown theme id → 422 unknown-theme, none of the three files mutated", async () => {
    const { taskListPath, backlogPath, roadmapPath, roadmapOriginal } =
      await setupThreeLedgers();
    handle = startPatchServer({ ledgerPath: backlogPath });
    const taskOriginal = await readFile(taskListPath, "utf8");
    const backlogOriginal = await readFile(backlogPath, "utf8");

    const res = await fetch(`${handle.url}/api/ledger/transaction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        op: "promote",
        sourceBacklogId: "101",
        taskRecord: makeNewTaskRecord("42"),
        taskListBaseMtime: await getLedgerMtime(taskListPath),
        backlogBaseMtime: await getLedgerMtime(backlogPath),
        capabilityThemeId: "99",
        roadmapBaseMtime: await getLedgerMtime(roadmapPath),
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unknown-theme");
    expect(await readFile(taskListPath, "utf8")).toBe(taskOriginal);
    expect(await readFile(backlogPath, "utf8")).toBe(backlogOriginal);
    expect(await readFile(roadmapPath, "utf8")).toBe(roadmapOriginal);
  });

  test("capabilityThemeId without roadmapBaseMtime → 400 missing-roadmapBaseMtime", async () => {
    const { taskListPath, backlogPath } = await setupThreeLedgers();
    handle = startPatchServer({ ledgerPath: backlogPath });

    const res = await fetch(`${handle.url}/api/ledger/transaction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        op: "promote",
        sourceBacklogId: "101",
        taskRecord: makeNewTaskRecord("42"),
        taskListBaseMtime: await getLedgerMtime(taskListPath),
        backlogBaseMtime: await getLedgerMtime(backlogPath),
        capabilityThemeId: "10",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing-roadmapBaseMtime");
  });

  test("capabilityThemeId with NO roadmap sibling in the dir → 500 no-sibling-ledger", async () => {
    const taskListPath = join(testDir, "task-list.json");
    const backlogPath = join(testDir, "product-backlog.json");
    await writeFixtureTaskList(taskListPath);
    await writeFixtureBacklog(backlogPath);
    handle = startPatchServer({ ledgerPath: backlogPath });

    const res = await fetch(`${handle.url}/api/ledger/transaction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        op: "promote",
        sourceBacklogId: "101",
        taskRecord: makeNewTaskRecord("42"),
        taskListBaseMtime: await getLedgerMtime(taskListPath),
        backlogBaseMtime: await getLedgerMtime(backlogPath),
        capabilityThemeId: "10",
        roadmapBaseMtime: new Date().toISOString(),
      }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("no-sibling-ledger");
  });

  test("promote WITHOUT capabilityThemeId still works two-leg (roadmap sibling untouched)", async () => {
    const { taskListPath, backlogPath, roadmapPath, roadmapOriginal } =
      await setupThreeLedgers();
    handle = startPatchServer({ ledgerPath: backlogPath });

    const res = await fetch(`${handle.url}/api/ledger/transaction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        op: "promote",
        sourceBacklogId: "101",
        taskRecord: makeNewTaskRecord("42"),
        taskListBaseMtime: await getLedgerMtime(taskListPath),
        backlogBaseMtime: await getLedgerMtime(backlogPath),
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      boundCapabilityTheme?: string;
    };
    expect(body.ok).toBe(true);
    expect(body.boundCapabilityTheme).toBeUndefined();
    expect(await readFile(roadmapPath, "utf8")).toBe(roadmapOriginal);
  });
});
