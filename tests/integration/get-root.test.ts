/**
 * tests/integration/get-root.test.ts — Subtask 20.17 acceptance gate.
 *
 * GET / serves SSR-rendered record-view HTML for whichever ledger kind
 * the server was launched against:
 *
 *   /                            → ledger index
 *   /?record=<id>                → per-record page
 *   /?record=<unknown>           → 404 + not-found marker
 *   /?track=…&status=…           → backlog filter URL state (PRODUCT inv 23)
 *
 * Closes the SPA wiring gap surfaced by the S66 manual smoke-test plan —
 * task-view v0.1.0 previously served only JSON; GET / returned 404 from
 * the patch-server dispatcher.
 *
 * Network operations in this test require the Bun test sandbox to allow
 * loopback HTTP. The existing patch-server / browser-close suites use the
 * same `fetch(handle.url)` pattern.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startPatchServer,
  type PatchServerHandle,
} from "../../packages/server/patch-server";

let testDir: string;
let handle: PatchServerHandle | null;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "task-view-get-root-test-"));
  handle = null;
});

afterEach(async () => {
  if (handle) {
    await handle.stop(true).catch(() => {});
    handle = null;
  }
  await rm(testDir, { recursive: true, force: true });
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeTaskListLedger() {
  return {
    document_name: "Knowledge Hub Task List",
    document_purpose: "20.17 GET / fixture",
    related_documents: [],
    tasks: [
      {
        id: "20",
        title: "Per-Task mirror",
        description: "Outer task description.",
        status: "in_progress" as const,
        priority: "must" as const,
        dependencies: [],
        subtasks: [
          {
            id: "1",
            title: "Slice 1",
            description: "First slice.",
            details: "Details for slice 1.",
            status: "done" as const,
            dependencies: [],
            testStrategy: "test strategy 1",
            updatedAt: "2026-05-21T15:30:00.000Z",
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
        title: "Other task",
        description: "Outer description for 30.",
        status: "pending" as const,
        priority: "should" as const,
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
    document_purpose: "20.17 GET / fixture",
    related_documents: [],
    items: [
      {
        id: "1",
        description: "First-session onboarding overlay",
        type: "feature",
        status: "spec_needed",
        effort_estimate: "2-3h",
        priority: "high",
        track: "onboarding",
        dependencies: [],
        session_refs: [],
        commit_refs: [],
        cross_doc_links: [],
        notes: null,
      },
      {
        id: "2",
        description: "Background-queue retention",
        type: "feature",
        status: "ready",
        effort_estimate: "TBD",
        priority: "low",
        track: "background-queue",
        dependencies: [],
        session_refs: [],
        commit_refs: [],
        cross_doc_links: [],
        notes: null,
      },
    ],
  };
}

async function writeLedger(path: string, body: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(body, null, 2), "utf8");
}

// ──────────────────────────────────────────────────────────────────────────────

describe("GET / — SSR viewer (Subtask 20.17)", () => {
  test("task-list mode renders the index page with record-view markup", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeLedger(ledger, makeTaskListLedger());
    handle = startPatchServer({ ledgerPath: ledger });

    const resp = await fetch(handle.url);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/html; charset=utf-8");

    const body = await resp.text();
    expect(body).toStartWith("<!doctype html>");
    // Record-view markup probe — the TaskListIndexView component emits
    // `data-record-kind="task-list-index"` and `data-task-list-table`.
    expect(body).toContain('data-record-kind="task-list-index"');
    expect(body).toContain("data-task-list-table");
    // Both fixture tasks render as anchor rows.
    expect(body).toContain('data-task-row="20"');
    expect(body).toContain('data-task-row="30"');
  });

  test("task-list mode renders the per-record page when ?record=<id>", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeLedger(ledger, makeTaskListLedger());
    handle = startPatchServer({ ledgerPath: ledger });

    const resp = await fetch(`${handle.url}/?record=20`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/html; charset=utf-8");

    const body = await resp.text();
    // TaskListView emits `data-record-kind="task"` + `data-task-id`.
    expect(body).toContain("data-record-kind");
    expect(body).toContain("Per-Task mirror"); // task title
    expect(body).toContain("Subtasks"); // section heading per PRODUCT inv 7
  });

  test("returns 404 + not-found markup when ?record=<unknown>", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeLedger(ledger, makeTaskListLedger());
    handle = startPatchServer({ ledgerPath: ledger });

    const resp = await fetch(`${handle.url}/?record=999`);
    expect(resp.status).toBe(404);
    expect(resp.headers.get("content-type")).toBe("text/html; charset=utf-8");

    const body = await resp.text();
    expect(body).toContain('data-record-kind="not-found"');
    expect(body).toContain("999");
  });

  test("backlog mode honours ?track=&status=&priority= URL filter (PRODUCT inv 23)", async () => {
    const ledger = join(testDir, "product-backlog.json");
    await writeLedger(ledger, makeBacklogLedger());
    handle = startPatchServer({ ledgerPath: ledger });

    // No filter — both items visible.
    const all = await fetch(handle.url);
    const allBody = await all.text();
    expect(all.status).toBe(200);
    expect(allBody).toContain('data-record-kind="backlog-index"');
    expect(allBody).toContain('data-item-count="2"');

    // Filter to track=onboarding — only one item.
    const filtered = await fetch(`${handle.url}/?track=onboarding`);
    const filteredBody = await filtered.text();
    expect(filtered.status).toBe(200);
    expect(filteredBody).toContain('data-item-count="1"');
    // The selected option carries the `selected` attribute server-side
    // so the rendered form reflects the URL state (bookmarkable).
    expect(filteredBody).toContain('<option value="onboarding" selected="">');
  });

  test("non-record path still returns the JSON 404 from the existing dispatcher", async () => {
    const ledger = join(testDir, "task-list.json");
    await writeLedger(ledger, makeTaskListLedger());
    handle = startPatchServer({ ledgerPath: ledger });

    // /something-other-than-root falls through to the existing dispatcher's
    // catch-all and remains JSON-shaped — GET / is the only new HTML route.
    const resp = await fetch(`${handle.url}/api/does-not-exist`);
    expect(resp.status).toBe(404);
    expect(resp.headers.get("content-type")).toContain("application/json");
  });
});
