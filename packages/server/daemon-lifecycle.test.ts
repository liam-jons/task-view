/**
 * Tests for daemon-lifecycle — ID-90.11 U9 lifecycle affordances.
 *
 *   - Port-file payload + atomic write ({port, pid, version, ledgerDir}
 *     written once listening — the façade's ensureServer handle).
 *   - Idle-exit monitor with an INJECTABLE clock (deterministic unit
 *     tests; the daemon integration test exercises the real timer).
 *   - Deterministic launch-document pick for `--serve-dir` (bare-route
 *     back-compat needs ONE launch document; preference follows
 *     KNOWN_DOCUMENT_NAMES order).
 *
 * Synthetic fixtures only (AC-I).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildPortFilePayload,
  writePortFile,
  createIdleMonitor,
  pickLaunchDocument,
} from "./daemon-lifecycle";
import type { ScanResult } from "./path-resolution";
import rootPkg from "../../package.json";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "task-view-daemon-lifecycle-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ── Port-file handle ─────────────────────────────────────────────────────────

describe("port-file handle ({port, pid, version, ledgerDir})", () => {
  test("payload carries the daemon's port, pid, tool version and ledgerDir", () => {
    const payload = buildPortFilePayload({
      port: 41234,
      ledgerDir: "/tmp/ledgers",
    });
    expect(payload).toEqual({
      port: 41234,
      pid: process.pid,
      version: rootPkg.version,
      ledgerDir: "/tmp/ledgers",
    });
  });

  test("writePortFile lands the payload as parseable JSON at the given path", async () => {
    const portFile = join(testDir, ".cache", "handle.json");
    // Parent dir must exist (atomicWriteFile contract) — the daemon's
    // caller passes a path whose dir it owns; mirror that here.
    await Bun.write(join(testDir, ".cache", ".keep"), "");
    const payload = buildPortFilePayload({ port: 1024, ledgerDir: testDir });
    await writePortFile(portFile, payload);
    const parsed = JSON.parse(await readFile(portFile, "utf8"));
    expect(parsed).toEqual({
      port: 1024,
      pid: process.pid,
      version: rootPkg.version,
      ledgerDir: testDir,
    });
  });
});

// ── Idle-exit monitor (injectable clock) ─────────────────────────────────────

describe("createIdleMonitor — idle-exit timer", () => {
  test("fires onIdle only after idleAfterMs without a touch, and only once", () => {
    let nowMs = 1_000_000;
    let fired = 0;
    const monitor = createIdleMonitor({
      idleAfterMs: 60_000,
      onIdle: () => {
        fired += 1;
      },
      now: () => nowMs,
      // Disable the real interval — the test drives check() directly.
      checkIntervalMs: null,
    });

    monitor.check();
    expect(fired).toBe(0); // fresh — not idle yet

    nowMs += 59_999;
    monitor.check();
    expect(fired).toBe(0); // one ms short

    nowMs += 1;
    monitor.check();
    expect(fired).toBe(1); // idle threshold reached

    nowMs += 120_000;
    monitor.check();
    expect(fired).toBe(1); // at most once

    monitor.stop();
  });

  test("touch() resets the idle window", () => {
    let nowMs = 0;
    let fired = 0;
    const monitor = createIdleMonitor({
      idleAfterMs: 1_000,
      onIdle: () => {
        fired += 1;
      },
      now: () => nowMs,
      checkIntervalMs: null,
    });

    nowMs = 900;
    monitor.touch(); // activity at t=900
    nowMs = 1_500; // only 600ms since last activity
    monitor.check();
    expect(fired).toBe(0);

    nowMs = 1_900; // 1000ms since last activity
    monitor.check();
    expect(fired).toBe(1);
    monitor.stop();
  });

  test("stop() disarms the monitor", () => {
    let nowMs = 0;
    let fired = 0;
    const monitor = createIdleMonitor({
      idleAfterMs: 10,
      onIdle: () => {
        fired += 1;
      },
      now: () => nowMs,
      checkIntervalMs: null,
    });
    monitor.stop();
    nowMs = 1_000_000;
    monitor.check();
    expect(fired).toBe(0);
  });
});

// ── Launch-document pick for --serve-dir ─────────────────────────────────────

describe("pickLaunchDocument — deterministic preference for --serve-dir", () => {
  test("none → null", () => {
    const scan: ScanResult = { kind: "none", searchedDir: "/tmp/x" };
    expect(pickLaunchDocument(scan)).toBeNull();
  });

  test("one → that document", () => {
    const scan: ScanResult = {
      kind: "one",
      path: "/tmp/x/umbrellas.json",
      documentName: "umbrellas",
    };
    expect(pickLaunchDocument(scan)).toEqual({
      path: "/tmp/x/umbrellas.json",
      documentName: "umbrellas",
    });
  });

  test("multiple → KNOWN_DOCUMENT_NAMES preference order (task-list first)", () => {
    const scan: ScanResult = {
      kind: "multiple",
      paths: [
        "/tmp/x/umbrellas.json",
        "/tmp/x/product-backlog.json",
        "/tmp/x/task-list.json",
      ],
      perPathName: {
        "/tmp/x/umbrellas.json": "umbrellas",
        "/tmp/x/product-backlog.json": "Product Backlog",
        "/tmp/x/task-list.json": "Knowledge Hub Task List",
      },
    };
    expect(pickLaunchDocument(scan)).toEqual({
      path: "/tmp/x/task-list.json",
      documentName: "Knowledge Hub Task List",
    });
  });

  test("multiple without a task-list → next in preference (roadmap, then backlog)", () => {
    const scan: ScanResult = {
      kind: "multiple",
      paths: ["/tmp/x/umbrellas.json", "/tmp/x/product-backlog.json"],
      perPathName: {
        "/tmp/x/umbrellas.json": "umbrellas",
        "/tmp/x/product-backlog.json": "Product Backlog",
      },
    };
    expect(pickLaunchDocument(scan)).toEqual({
      path: "/tmp/x/product-backlog.json",
      documentName: "Product Backlog",
    });
  });
});
