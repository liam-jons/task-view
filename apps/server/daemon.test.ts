/**
 * Daemon integration tests — ID-90.11 U9 lifecycle flags on the REAL
 * subprocess (TECH §Proposed changes U9; OQ-2 ratified: singleton
 * multi-document loopback daemon per ledger directory).
 *
 * Each test spawns `bun apps/server/index.ts` with the new flags against
 * a temp ledger directory and observes the daemon from outside:
 *
 *   - `--serve-dir <dir>`: scans + registers ALL known documents (incl.
 *     umbrellas); bare routes serve the deterministic launch document.
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

// ── Fixtures (synthetic, all four kinds) ─────────────────────────────────────

async function writeAllFour(dir: string): Promise<void> {
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
    join(dir, "product-roadmap.json"),
    JSON.stringify(
      {
        document_name: "Knowledge Hub Roadmap",
        document_purpose: "Synthetic fixture.",
        date: "2026-05-25",
        status: "Active",
        forward_looking_only: true,
        related_documents: [],
        last_updated: "synthetic fixture",
        themes: [],
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
  await writeFile(
    join(dir, "umbrellas.json"),
    JSON.stringify(
      {
        document_name: "umbrellas",
        document_purpose: "Synthetic fixture.",
        last_updated: "kh-main-S1 synthetic fixture",
        related_documents: [],
        umbrellas: [
          {
            id: "synthetic-umbrella",
            title: "Synthetic Umbrella",
            substrate_doc: "docs/synthetic-umbrella.md",
            task_ids: ["20"],
            status: "in_progress",
            phase: "Phase 1",
          },
        ],
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

// ── --serve-dir + --port-file + /api/health ─────────────────────────────────

describe("daemon: --serve-dir + --port-file + health", () => {
  test("registers all four documents, writes the handle once listening, serves slug routes loopback-only", async () => {
    await writeAllFour(testDir);
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
      "roadmap",
      "task-list",
      "umbrellas",
    ]);

    // Slug routes serve every document; bare routes serve the launch pick
    // (task-list — first in the deterministic preference order).
    for (const [slug, kind] of [
      ["task-list", "task-list"],
      ["roadmap", "roadmap"],
      ["backlog", "backlog"],
      ["umbrellas", "umbrellas"],
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
    await writeAllFour(testDir);
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
    await writeAllFour(testDir);
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
    await writeAllFour(testDir);
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
});

// ── --require-denylist ───────────────────────────────────────────────────────

describe("daemon: --require-denylist", () => {
  test("unset denylist env + armed daemon → loud 500 client-name-guard-config on mutation", async () => {
    await writeAllFour(testDir);
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
