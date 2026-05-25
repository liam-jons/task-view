/**
 * ledger.test.ts — TECH §6.1, §6.5, §6.6 server lifecycle wrapper.
 *
 * `startTaskViewServer` is the high-level factory the CLI binary +
 * plugin manifest both call. It composes `startPatchServer` (the
 * ID-20.8 HTTP server) with:
 *
 *   - Port-retry policy: MAX_RETRIES = 5, fresh random port per attempt,
 *     exit with "could not bind" after exhaustion (TECH §6.6 / inv 49).
 *   - Browser-close detection: track `last_request_at`; if
 *     `now - last_request_at > BROWSER_CLOSE_IDLE_MS` (30s) AND
 *     `request_count >= 1`, signal exit (TECH §6.5 / inv 50).
 *   - `waitForExit()` — promise resolving when the server is asked to
 *     stop (by exit signal or browser-close detection).
 *
 * These tests cover the behaviour at the module level — the
 * integration tests under `tests/integration/*` cover the end-to-end
 * CLI + server flow.
 *
 * Network operations require `dangerouslyDisableSandbox: true` when
 * run via the Claude harness — same gotcha as patch-server.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROWSER_CLOSE_IDLE_MS,
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
  test("BROWSER_CLOSE_IDLE_MS = 30_000 (30s per TECH §6.5 / inv 50)", () => {
    expect(BROWSER_CLOSE_IDLE_MS).toBe(30_000);
  });

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

describe("startTaskViewServer — browser-close detection (TECH §6.5 / inv 50)", () => {
  test("does NOT exit before any request has been served (pre-first-request guard)", async () => {
    const ledgerPath = await writeLedger();
    // Use a short threshold for the test — the function under test
    // accepts a `_testIdleMs` override.
    handle = await startTaskViewServer({
      ledgerPath,
      _testIdleMs: 100,
      _testTickMs: 25,
    });
    // No request issued; wait 250ms (>> idle threshold). Should NOT
    // resolve waitForExit, because request_count is 0.
    const exitPromise = handle.waitForExit();
    let exited = false;
    exitPromise.then(() => {
      exited = true;
    });
    await new Promise((r) => setTimeout(r, 250));
    expect(exited).toBe(false);
  });

  test("exits when idle threshold passes AFTER at least one request", async () => {
    const ledgerPath = await writeLedger();
    handle = await startTaskViewServer({
      ledgerPath,
      _testIdleMs: 100,
      _testTickMs: 25,
    });
    const exitPromise = handle.waitForExit();
    // Issue one request to flip the gate.
    const resp = await fetch(`${handle.url}/api/ledger`);
    expect(resp.status).toBe(200);
    // Now wait longer than idle threshold — server should exit.
    await Promise.race([
      exitPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout: server did not exit")), 1000),
      ),
    ]);
    // Mark handle null so afterEach doesn't double-stop a closed server.
    handle = null;
  });

  test("does NOT exit while requests continue to refresh last_request_at", async () => {
    const ledgerPath = await writeLedger();
    handle = await startTaskViewServer({
      ledgerPath,
      _testIdleMs: 150,
      _testTickMs: 25,
    });
    const exitPromise = handle.waitForExit();
    let exited = false;
    exitPromise.then(() => {
      exited = true;
    });
    // Fire requests every 50ms (well below idle threshold) for 300ms
    for (let i = 0; i < 6; i++) {
      const resp = await fetch(`${handle.url}/api/ledger`);
      expect(resp.status).toBe(200);
      await new Promise((r) => setTimeout(r, 50));
    }
    // Server should still be alive — last_request_at keeps refreshing.
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
