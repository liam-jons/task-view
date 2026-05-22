/**
 * tests/integration/browser-close.test.ts — PLAN §20.11 acceptance gate.
 *
 * Per TECH §6.5 / PRODUCT inv 50, when the server has served at least
 * one request AND `now - last_request_at > BROWSER_CLOSE_IDLE_MS` (30s),
 * the process exits 0.
 *
 * These tests run at the module level (not via the spawned CLI),
 * because a 30-second wall-clock wait is impractical in CI. The
 * `_testIdleMs` and `_testTickMs` options let us assert behaviour
 * with sub-second thresholds. The 30-second production constant is
 * verified by a separate test on the module-level `BROWSER_CLOSE_IDLE_MS`
 * export (see packages/server/ledger.test.ts).
 *
 * Branches:
 *   - No request issued → does NOT exit even past idle threshold
 *     (at-least-one-request gate)
 *   - One request issued + idle threshold passes → DOES exit (resolves
 *     waitForExit)
 *   - Continuous requests refresh last_request_at → does NOT exit
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROWSER_CLOSE_IDLE_MS,
  startTaskViewServer,
  type TaskViewServerHandle,
} from "../../packages/server/ledger";

let testDir: string;
let handle: TaskViewServerHandle | null = null;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "task-view-browser-close-test-"));
  handle = null;
});

afterEach(async () => {
  if (handle) {
    await handle.stop(true).catch(() => {});
    handle = null;
  }
  await rm(testDir, { recursive: true, force: true });
});

async function writeLedger(): Promise<string> {
  const path = join(testDir, "task-list.json");
  const body = {
    document_name: "Knowledge Hub Task List",
    document_purpose: "fixture",
    last_updated: "test",
    related_documents: [],
    tasks: [],
  };
  await writeFile(path, JSON.stringify(body, null, 2), "utf8");
  return path;
}

describe("Browser-close detection — production constant (TECH §6.5)", () => {
  test("BROWSER_CLOSE_IDLE_MS is 30_000 ms (30 seconds)", () => {
    expect(BROWSER_CLOSE_IDLE_MS).toBe(30_000);
  });
});

describe("Browser-close detection — at-least-one-request gate (PRODUCT inv 50)", () => {
  test("does NOT exit before any request, even after idle threshold", async () => {
    const ledgerPath = await writeLedger();
    handle = await startTaskViewServer({
      ledgerPath,
      _testIdleMs: 80,
      _testTickMs: 20,
    });
    let exited = false;
    handle.waitForExit().then(() => {
      exited = true;
    });
    // No request issued. Wait 250ms (>> idle threshold). Should NOT exit.
    await new Promise((r) => setTimeout(r, 250));
    expect(exited).toBe(false);
  });
});

describe("Browser-close detection — exit after idle (PRODUCT inv 50)", () => {
  test("exits when idle threshold passes AFTER at least one request", async () => {
    const ledgerPath = await writeLedger();
    handle = await startTaskViewServer({
      ledgerPath,
      _testIdleMs: 80,
      _testTickMs: 20,
    });
    const exitPromise = handle.waitForExit();
    // Issue one request — flips the gate.
    const resp = await fetch(`${handle.url}/api/ledger`);
    expect(resp.status).toBe(200);

    // Now wait longer than idle threshold — server should exit.
    await Promise.race([
      exitPromise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("timeout: server did not exit within 1500ms")),
          1500,
        ),
      ),
    ]);
    // Server is stopped; null out so afterEach doesn't double-stop.
    handle = null;
  });
});

describe("Browser-close detection — continuous activity keeps server alive", () => {
  test("repeated requests refresh last_request_at — does NOT exit while activity continues", async () => {
    const ledgerPath = await writeLedger();
    handle = await startTaskViewServer({
      ledgerPath,
      _testIdleMs: 200,
      _testTickMs: 25,
    });
    let exited = false;
    handle.waitForExit().then(() => {
      exited = true;
    });
    // Fire requests every 60ms (well below 200ms idle threshold) for 360ms
    for (let i = 0; i < 6; i++) {
      const resp = await fetch(`${handle.url}/api/ledger`);
      expect(resp.status).toBe(200);
      await new Promise((r) => setTimeout(r, 60));
    }
    expect(exited).toBe(false);
  });
});
