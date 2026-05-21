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
import { mkdtemp, readFile, rm, stat, utimes, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPatchServer, type PatchServerHandle } from "./patch-server";

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
    document_purpose: "Active + recently-closed structured work — Taskmaster JSON shape.",
    last_updated: "kh-prod-readiness-S63 representative fixture",
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
            id: 1,
            title: "Slice 1",
            description: "First slice.",
            details: "Details for slice 1.",
            status: "done",
            dependencies: [],
            testStrategy: "test strategy 1",
            updatedAt: "2026-05-21T15:30:00.000Z",
          },
          {
            id: 2,
            title: "Slice 2",
            description: "Second slice.",
            details: "Details for slice 2.",
            status: "pending",
            dependencies: [1],
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
          { fieldPath: ["tasks", "20", "status"], newValue: "not_a_valid_status" },
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

  test("mirror regen runs ONCE per PATCH regardless of patch count (single mirrorsWritten payload)", async () => {
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
    };
    // Per PRODUCT inv 38: ONE mirror regen pass at the end. The regen
    // returns the full set of mirrors written (all Tasks, since the
    // generator is whole-ledger). We assert that the payload is the
    // single-regen flat list, NOT a multiplied list of one-per-patch
    // calls (which would be 4x in this fixture if the server regen'd
    // per field).
    //
    // Concretely: there are 2 Tasks in the fixture, so a single regen
    // writes 2 mirrors. We assert that count, NOT (2 * patches.length).
    expect(body.mirrorsWritten.length).toBe(2);
    expect(body.mirrorsWritten.sort()).toEqual(["ID-20.md", "ID-30.md"]);
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
          { fieldPath: ["tasks", "20", "priority"], newValue: "not_a_priority" },
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

// ── Method routing + 404 ─────────────────────────────────────────────────────

describe("HTTP routing — method-not-allowed + 404", () => {
  test("rejects unsupported HTTP method on the record endpoint with 405", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeFixtureTaskList(ledger);
    handle = startPatchServer({ ledgerPath: ledger });
    const res = await fetch(`${handle.url}/api/ledger/record/20`, { method: "DELETE" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("GET");
    expect(res.headers.get("allow")).toContain("PATCH");
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
          { fieldPath: ["tasks", "20", "description"], newValue: "Updated body." },
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
