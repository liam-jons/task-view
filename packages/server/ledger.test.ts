/**
 * ledger.test.ts — TECH §6.1, §6.5, §6.6 server lifecycle wrapper.
 *
 * `startTaskViewServer` is the high-level factory the CLI binary +
 * plugin manifest both call. It composes `startPatchServer` (the
 * ID-20.8 HTTP server) with:
 *
 *   - Port-retry policy: MAX_RETRIES = 5, fresh random port per attempt,
 *     exit with "could not bind" after exhaustion (TECH §6.6 / inv 49).
 *   - `waitForExit()` — promise resolving when the server is asked to
 *     stop (explicit stop(); the CLI wires Ctrl-C / SIGTERM to it).
 *
 * Note: the 30s browser-close idle-shutdown (formerly TECH §6.5 / inv
 * 50) was removed — the server runs until explicitly stopped.
 *
 * These tests cover the behaviour at the module level — the
 * integration tests under `tests/integration/*` cover the end-to-end
 * CLI + server flow.
 *
 * Network operations require `dangerouslyDisableSandbox: true` when
 * run via the Claude harness — same gotcha as patch-server.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_PORT_RETRIES,
  startTaskViewServer,
  type TaskViewServerHandle,
} from "./ledger";

let testDir: string;
let handle: TaskViewServerHandle | null;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "task-view-ledger-test-"));
  handle = null;
});

afterEach(async () => {
  if (handle) {
    await handle.stop(true);
    handle = null;
  }
  await rm(testDir, { recursive: true, force: true });
});

function makeMinimalLedger() {
  return {
    document_name: "Knowledge Hub Task List",
    document_purpose: "Test fixture.",
    related_documents: [],
    tasks: [],
  };
}

async function writeLedger(): Promise<string> {
  const path = join(testDir, "task-list.json");
  await writeFile(path, JSON.stringify(makeMinimalLedger(), null, 2), "utf8");
  return path;
}

describe("startTaskViewServer — constants", () => {
  test("MAX_PORT_RETRIES = 5 (per TECH §6.6 / inv 49)", () => {
    expect(MAX_PORT_RETRIES).toBe(5);
  });
});

describe("startTaskViewServer — basic boot", () => {
  test("starts on a random loopback port + returns url + waitForExit", async () => {
    const ledgerPath = await writeLedger();
    handle = await startTaskViewServer({ ledgerPath });
    expect(handle.url).toStartWith("http://127.0.0.1:");
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.hostname).toBe("127.0.0.1");
    expect(typeof handle.waitForExit).toBe("function");
  });

  test("waitForExit() resolves when stop() is called", async () => {
    const ledgerPath = await writeLedger();
    handle = await startTaskViewServer({ ledgerPath });
    const exitPromise = handle.waitForExit();
    // stop() should cause waitForExit to resolve
    await handle.stop(true);
    await exitPromise; // does not hang
    handle = null;
  });

  test("server serves GET /api/ledger (delegates to patch-server)", async () => {
    const ledgerPath = await writeLedger();
    handle = await startTaskViewServer({ ledgerPath });
    const resp = await fetch(`${handle.url}/api/ledger`);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.kind).toBe("task-list");
  });
});

describe("startTaskViewServer — auto-regen mirrors on boot (Subtask 20.22 / inv 5 + 40)", () => {
  function makeLedgerWithTask(title: string) {
    return {
      document_name: "Knowledge Hub Task List",
      document_purpose: "Boot-regen fixture.",
      related_documents: [],
      tasks: [
        {
          id: "20",
          title,
          description: "Outer task description.",
          status: "in_progress" as const,
          priority: "must" as const,
          dependencies: [],
          subtasks: [],
          updatedAt: "2026-05-25T10:00:00.000Z",
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

  test("regenerates the on-disk mirror to match current ledger BEFORE first render", async () => {
    const ledgerPath = join(testDir, "task-list.json");
    // Ledger reflects the CURRENT title.
    await writeFile(
      ledgerPath,
      JSON.stringify(makeLedgerWithTask("Current title"), null, 2),
      "utf8",
    );
    // A STALE mirror on disk carries an out-of-date title — as if the
    // ledger changed since the mirror was last written.
    const mirrorDir = join(testDir, "tasks");
    await mkdir(mirrorDir, { recursive: true });
    const mirrorPath = join(mirrorDir, "ID-20.md");
    await writeFile(
      mirrorPath,
      "---\ntype: task\nid: \"20\"\ntitle: STALE TITLE\n---\n\n# ID-20: STALE TITLE\n",
      "utf8",
    );

    // Boot the server. No HTTP request is issued — the mirror must already
    // be refreshed by the boot-time regen.
    handle = await startTaskViewServer({ ledgerPath });

    const mirrorAfterBoot = await readFile(mirrorPath, "utf8");
    expect(mirrorAfterBoot).toContain("Current title");
    expect(mirrorAfterBoot).not.toContain("STALE TITLE");
  });

  test("generates the mirror on first boot when none exists yet (inv 40 tolerance)", async () => {
    const ledgerPath = join(testDir, "task-list.json");
    await writeFile(
      ledgerPath,
      JSON.stringify(makeLedgerWithTask("Fresh task"), null, 2),
      "utf8",
    );
    // No mirror dir / file exists yet.
    handle = await startTaskViewServer({ ledgerPath });

    const mirrorPath = join(testDir, "tasks", "ID-20.md");
    const mirror = await readFile(mirrorPath, "utf8");
    expect(mirror).toContain("Fresh task");
  });
});

describe("startTaskViewServer — port retry (TECH §6.6 / inv 49)", () => {
  test("when given an explicit port that is already bound, retries up to MAX_PORT_RETRIES with random ports", async () => {
    const ledgerPath = await writeLedger();
    // Boot one server on a random port to claim it.
    const blocker = await startTaskViewServer({ ledgerPath });
    const blockedPort = blocker.port;
    try {
      // Now request the blocked port explicitly. The retry policy
      // should kick in and bind on a different (random) port.
      handle = await startTaskViewServer({ ledgerPath, port: blockedPort });
      // We should have ended up on a different port — retry chose
      // a random free one.
      expect(handle.port).not.toBe(blockedPort);
      expect(handle.port).toBeGreaterThan(0);
    } finally {
      await blocker.stop(true);
    }
  });
});

describe("startTaskViewServer — no idle auto-shutdown (fork divergence from inv 50)", () => {
  test("does NOT exit on its own after serving a request then going idle", async () => {
    const ledgerPath = await writeLedger();
    handle = await startTaskViewServer({ ledgerPath });
    let exited = false;
    handle.waitForExit().then(() => {
      exited = true;
    });
    // Serve a request, then sit idle. The pre-fork build tore the server
    // down ~30s after the last request; task-view removed that timer, so
    // only an explicit stop() resolves waitForExit.
    const resp = await fetch(`${handle.url}/api/ledger`);
    expect(resp.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(exited).toBe(false);
  });
});

describe("startTaskViewServer — explicit stop semantics", () => {
  test("stop() is idempotent — calling twice does not throw", async () => {
    const ledgerPath = await writeLedger();
    handle = await startTaskViewServer({ ledgerPath });
    await handle.stop(true);
    await handle.stop(true); // should not throw
    handle = null;
  });
});
