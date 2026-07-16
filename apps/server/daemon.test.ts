/**
 * Daemon integration tests — ID-90.11 U9 lifecycle flags on the REAL
 * subprocess (TECH §Proposed changes U9; OQ-2 ratified: singleton
 * multi-document loopback daemon per ledger directory).
 *
 * Each test spawns `bun apps/server/index.ts` with the new flags against
 * a temp ledger directory and observes the daemon from outside:
 *
 *   - `--serve-dir <dir>`: scans + registers ALL known documents (ID-148.10:
 *     `roadmap` repurposed to `initiatives`; `umbrellas` fully retired);
 *     bare routes serve the deterministic launch document.
 *   - `--port-file <path>`: atomic `{port, pid, version, ledgerDir}`
 *     handle once listening.
 *   - `--idle-exit <minutes>`: the daemon exits by itself after the idle
 *     window (real timer, generous tolerance — the deterministic clock
 *     unit suite lives in packages/server/daemon-lifecycle.test.ts).
 *   - `--require-denylist`: arms the inv-34 fail-loud posture
 *     daemon-wide.
 *
 * Real subprocesses + real fetch — nothing mocked. Network binds and
 * subprocess spawns need `dangerouslyDisableSandbox: true` under the
 * Claude harness. Synthetic fixtures only (AC-I).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import rootPkg from "../../package.json";

const INDEX_PATH = join(import.meta.dir, "index.ts");

let testDir: string;
let proc: Subprocess | null;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "task-view-daemon-"));
  proc = null;
});

afterEach(async () => {
  if (proc) {
    try {
      proc.kill();
      await proc.exited;
    } catch {
      // Already exited.
    }
    proc = null;
  }
  await rm(testDir, { recursive: true, force: true });
});

// ── Fixtures (synthetic, all three ID-148.10 kinds) ──────────────────────────

async function writeAllThree(dir: string): Promise<void> {
  await writeFile(
    join(dir, "task-list.json"),
    JSON.stringify(
      {
        document_name: "Knowledge Hub Task List",
        document_purpose: "Synthetic fixture.",
        related_documents: [],
        tasks: [
          {
            id: "20",
            title: "Synthetic task 20",
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
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    join(dir, "initiatives.json"),
    JSON.stringify(
      {
        document_name: "Canonical Platform - Initiatives",
        document_purpose: "Synthetic fixture.",
        date: "2026-07-15",
        status: "active",
        related_documents: [],
        last_updated: "synthetic fixture",
        initiatives: [],
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    join(dir, "product-backlog.json"),
    JSON.stringify(
      {
        document_name: "Product Backlog",
        document_purpose: "Synthetic fixture.",
        related_documents: [],
        items: [],
      },
      null,
      2,
    ),
    "utf8",
  );
}

function spawnDaemon(args: string[], env: Record<string, string | undefined> = {}): Subprocess {
  return Bun.spawn({
    cmd: ["bun", INDEX_PATH, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      TASK_VIEW_NO_BROWSER: "1",
      ...env,
    },
  });
}

async function waitForFile(path: string, timeoutMs = 10_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const text = await readFile(path, "utf8");
      if (text.trim() !== "") return text;
    } catch {
      // Not there yet.
    }
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  return await new Response(stream).text();
}

/** True while `pid` still exists (kill(pid, 0) — no signal delivered). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until `pidAlive(pid)` is false, or the deadline elapses. */
async function waitUntilDead(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!pidAlive(pid)) return true;
    await Bun.sleep(200);
  }
  return !pidAlive(pid);
}

/**
 * A "fake parent" script (ID-156.9): spawns the real daemon as ITS OWN
 * child — so the daemon's true OS ppid is this intermediary's pid, exactly
 * mirroring how canonical's ensureServer spawns a --port-file server
 * directly from the short-lived ledger-cli process (S477). Reads its own
 * spawn config from env vars (INDEX_PATH, SERVE_DIR, PORT_FILE,
 * EXTRA_ARGS — space-separated) so the outer test can vary the daemon args
 * (with/without --parent-pid) without templating strings by hand. Stays
 * alive (an unref'd interval) until the outer test kills it — the test
 * controls exactly when the "parent" dies.
 */
const FAKE_PARENT_SRC = `
const extraArgs = (process.env.EXTRA_ARGS ?? "")
  .split(" ")
  .filter(Boolean)
  .map((a) => (a === "__SELF_PID__" ? String(process.pid) : a));
const daemon = Bun.spawn({
  cmd: [
    "bun", process.env.INDEX_PATH,
    "--serve-dir", process.env.SERVE_DIR,
    "--port", "0",
    "--port-file", process.env.PORT_FILE,
    "--idle-exit", "10",
    "--no-browser",
    ...extraArgs,
  ],
  stdout: "ignore",
  stderr: "ignore",
  env: process.env,
});
daemon.unref();
setInterval(() => {}, 1000);
`;

async function spawnFakeParent(
  dir: string,
  env: Record<string, string | undefined>,
): Promise<import("bun").Subprocess> {
  const helperPath = join(dir, "fake-parent.js");
  await writeFile(helperPath, FAKE_PARENT_SRC, "utf8");
  return Bun.spawn({
    cmd: ["bun", helperPath],
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, TASK_VIEW_NO_BROWSER: "1", ...env },
  });
}

// ── --serve-dir + --port-file + /api/health ─────────────────────────────────

describe("daemon: --serve-dir + --port-file + health", () => {
  test("registers all three documents, writes the handle once listening, serves slug routes loopback-only", async () => {
    await writeAllThree(testDir);
    const portFile = join(testDir, "handle.json");
    proc = spawnDaemon([
      "--serve-dir",
      testDir,
      "--port",
      "0",
      "--port-file",
      portFile,
      "--no-browser",
    ]);

    const handleRaw = await waitForFile(portFile);
    const handle = JSON.parse(handleRaw) as {
      port: number;
      pid: number;
      version: string;
      ledgerDir: string;
    };
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.pid).toBe(proc.pid);
    expect(handle.version).toBe(rootPkg.version);
    expect(handle.ledgerDir).toBe(resolve(testDir));

    // Loopback-only (inv 55): the handle's port answers on 127.0.0.1.
    const base = `http://127.0.0.1:${handle.port}`;
    const health = await fetch(`${base}/api/health`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as {
      ok: boolean;
      version: string;
      ledgerDir: string;
      documents: Array<{ slug: string; document_name: string; path: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.version).toBe(rootPkg.version);
    expect(body.ledgerDir).toBe(resolve(testDir));
    expect(body.documents.map((d) => d.slug).sort()).toEqual([
      "backlog",
      "initiatives",
      "task-list",
    ]);

    // Slug routes serve every document; bare routes serve the launch pick
    // (task-list — first in the deterministic preference order).
    for (const [slug, kind] of [
      ["task-list", "task-list"],
      ["initiatives", "initiatives"],
      ["backlog", "backlog"],
    ] as const) {
      const res = await fetch(`${base}/api/ledger/${slug}`);
      expect(`${slug}:${res.status}`).toBe(`${slug}:200`);
      expect(((await res.json()) as { kind: string }).kind).toBe(kind);
    }
    const bare = await fetch(`${base}/api/ledger`);
    expect(((await bare.json()) as { kind: string }).kind).toBe("task-list");
  });

  test("--serve-dir on a directory with no known documents fails loudly (non-zero, diagnostic)", async () => {
    proc = spawnDaemon(["--serve-dir", testDir, "--no-browser"]);
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    const stderr = await readStream(proc.stderr as ReadableStream<Uint8Array>);
    expect(stderr).toContain(testDir);
    proc = null;
  });

  test("--serve-dir + a positional path is a usage error", async () => {
    await writeAllThree(testDir);
    proc = spawnDaemon([
      join(testDir, "task-list.json"),
      "--serve-dir",
      testDir,
      "--no-browser",
    ]);
    const exitCode = await proc.exited;
    expect(exitCode).toBe(64); // EX_USAGE
    proc = null;
  });
});

// ── --idle-exit ──────────────────────────────────────────────────────────────

describe("daemon: --idle-exit", () => {
  test("exits by itself after the idle window (real timer, generous tolerance)", async () => {
    await writeAllThree(testDir);
    const portFile = join(testDir, "handle.json");
    // 0.02 minutes = 1.2s idle window; poll interval clamps to 300ms.
    proc = spawnDaemon([
      "--serve-dir",
      testDir,
      "--port",
      "0",
      "--port-file",
      portFile,
      "--idle-exit",
      "0.02",
      "--no-browser",
    ]);
    await waitForFile(portFile);

    const exited = await Promise.race([
      proc.exited,
      Bun.sleep(20_000).then(() => "timeout" as const),
    ]);
    expect(exited).toBe(0);
    proc = null;
  }, 30_000);

  test("--idle-exit with a non-positive value is a usage error", async () => {
    await writeAllThree(testDir);
    proc = spawnDaemon([
      "--serve-dir",
      testDir,
      "--idle-exit",
      "0",
      "--no-browser",
    ]);
    expect(await proc.exited).toBe(64);
    proc = null;
  });

  // ID-156.9: sub-minute granularity via a unit suffix — bare-number
  // minutes semantics (above) are unchanged; this is additive.
  test("an 's' suffix exits after N SECONDS, not minutes (real timer)", async () => {
    await writeAllThree(testDir);
    const portFile = join(testDir, "handle.json");
    proc = spawnDaemon([
      "--serve-dir",
      testDir,
      "--port",
      "0",
      "--port-file",
      portFile,
      "--idle-exit",
      "1s",
      "--no-browser",
    ]);
    await waitForFile(portFile);

    const exited = await Promise.race([
      proc.exited,
      Bun.sleep(10_000).then(() => "timeout" as const),
    ]);
    expect(exited).toBe(0);
    proc = null;
  }, 15_000);

  test("an unrecognised unit suffix is a usage error", async () => {
    await writeAllThree(testDir);
    proc = spawnDaemon([
      "--serve-dir",
      testDir,
      "--idle-exit",
      "5x",
      "--no-browser",
    ]);
    expect(await proc.exited).toBe(64);
    proc = null;
  });
});

// ── --parent-pid (ID-156.9 / S477 ephemeral-spawn parent-death reaping) ──────

describe("daemon: --parent-pid", () => {
  test("with --parent-pid, self-stops when the named parent dies EVEN UNDER --port-file", async () => {
    await writeAllThree(testDir);
    const portFile = join(testDir, "handle.json");

    // Fake parent spawns the daemon as its OWN child (true OS ppid = fake
    // parent's pid — mirrors ensureServer's direct spawn), naming ITSELF
    // via --parent-pid (`__SELF_PID__` resolves to the fake parent's own
    // process.pid inside FAKE_PARENT_SRC).
    const fakeParent = await spawnFakeParent(testDir, {
      INDEX_PATH,
      SERVE_DIR: testDir,
      PORT_FILE: portFile,
      EXTRA_ARGS: "--parent-pid __SELF_PID__",
    });

    let daemonPid: number | null = null;
    try {
      const handle = JSON.parse(await waitForFile(portFile)) as { pid: number };
      daemonPid = handle.pid;
      expect(pidAlive(handle.pid)).toBe(true);

      fakeParent.kill(); // the "launcher" dies — daemon reparents to PID 1
      await fakeParent.exited;

      const dead = await waitUntilDead(handle.pid, 8_000);
      expect(dead).toBe(true);
    } finally {
      fakeParent.kill();
      // Defensive: if the assertion above ever regresses (self-stop didn't
      // fire), don't leave a real orphan behind — this is the exact class
      // of leak this subtask exists to close.
      if (daemonPid !== null && pidAlive(daemonPid)) {
        try {
          process.kill(daemonPid, "SIGTERM");
        } catch {
          // Already gone.
        }
      }
    }
  }, 15_000);

  test("without --parent-pid, a --port-file daemon remains EXEMPT (persistent-daemon back-compat)", async () => {
    await writeAllThree(testDir);
    const portFile = join(testDir, "handle.json");

    const fakeParent = await spawnFakeParent(testDir, {
      INDEX_PATH,
      SERVE_DIR: testDir,
      PORT_FILE: portFile,
      EXTRA_ARGS: "",
    });

    let daemonPid: number | null = null;
    try {
      const handle = JSON.parse(await waitForFile(portFile)) as { pid: number };
      daemonPid = handle.pid;

      fakeParent.kill();
      await fakeParent.exited;

      // Give the 1s-default poll interval several ticks to (not) fire.
      await Bun.sleep(3_000);
      expect(pidAlive(handle.pid)).toBe(true);
    } finally {
      fakeParent.kill();
      if (daemonPid !== null && pidAlive(daemonPid)) {
        try {
          process.kill(daemonPid, "SIGTERM");
        } catch {
          // Already gone.
        }
      }
    }
  }, 15_000);

  test("--parent-pid with a non-positive-integer value is a usage error", async () => {
    await writeAllThree(testDir);
    proc = spawnDaemon([
      "--serve-dir",
      testDir,
      "--port-file",
      join(testDir, "handle.json"),
      "--parent-pid",
      "not-a-pid",
      "--no-browser",
    ]);
    expect(await proc.exited).toBe(64);
    proc = null;
  });
});

// ── --require-denylist ───────────────────────────────────────────────────────

describe("daemon: --require-denylist", () => {
  test("unset denylist env + armed daemon → loud 500 client-name-guard-config on mutation", async () => {
    await writeAllThree(testDir);
    const portFile = join(testDir, "handle.json");
    proc = spawnDaemon(
      [
        "--serve-dir",
        testDir,
        "--port",
        "0",
        "--port-file",
        portFile,
        "--require-denylist",
        "--no-browser",
      ],
      // Force the env UNSET inside the daemon regardless of the runner's
      // environment.
      { KH_CLIENT_NAME_DENYLIST: undefined },
    );
    const handle = JSON.parse(await waitForFile(portFile)) as { port: number };
    const base = `http://127.0.0.1:${handle.port}`;

    const ledgerRes = await fetch(`${base}/api/ledger/task-list`);
    const { mtime } = (await ledgerRes.json()) as { mtime: string };
    const res = await fetch(`${base}/api/ledger/task-list/record/20`, {
      method: "PATCH",
      body: JSON.stringify({
        baseMtime: mtime,
        patches: [
          { fieldPath: ["tasks", "20", "status_note"], newValue: "edited" },
        ],
      }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("client-name-guard-config");
  });
});
