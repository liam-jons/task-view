/**
 * tests/integration/dual-entry.test.ts — PLAN §20.11 acceptance gate.
 *
 * Per TECH §6.3 / PRODUCT inv 41: "Both entry points share one server".
 * The plugin is a thin manifest pointing at the CLI binary; there's no
 * separate "plugin server" process. Both paths exercise the same
 * `startTaskViewServer` factory → same Bun.serve → same routes.
 *
 * This test verifies that contract by:
 *
 *   1. Spawning the CLI binary directly (`node bin/task-view.js
 *      --no-browser --port 0 <ledger>`).
 *   2. Spawning what the plugin manifest's `script` field would invoke
 *      (`node_modules/.bin/task-view --no-browser --port 0 <ledger>`),
 *      where the bin symlink resolves to the same bin/task-view.js
 *      shim.
 *   3. Asserting both servers respond to the same set of routes with
 *      structurally identical bodies (kind, mtime presence, shape).
 *
 * The plugin host wraps the script invocation with its own argv
 * shape, but that's a layer above the CLI's parseArgs — the routes
 * served are identical because both invocations call the SAME binary.
 *
 * Note: the symlink `node_modules/.bin/task-view` is established by
 * `bun install` against `package.json` bin field. If the test
 * environment hasn't run install, we fall back to the
 * `bin/task-view.js` direct invocation for the "plugin" side as well
 * — both paths still exercise the same binary, just by different
 * names.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const BIN_PATH = join(REPO_ROOT, "bin", "task-view.js");
const NODE_MODULES_BIN = join(REPO_ROOT, "node_modules", ".bin", "task-view");

let testDir: string;
const procs: Subprocess[] = [];

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "task-view-dual-entry-test-"));
});

afterEach(async () => {
  while (procs.length > 0) {
    const p = procs.pop();
    if (p) {
      try {
        p.kill("SIGTERM");
        await p.exited;
      } catch {
        // already exited
      }
    }
  }
  await rm(testDir, { recursive: true, force: true });
});

async function writeLedger(): Promise<string> {
  const path = join(testDir, "task-list.json");
  const body = {
    document_name: "Knowledge Hub Task List",
    document_purpose: "dual-entry fixture",
    related_documents: [],
    tasks: [
      {
        id: "1",
        title: "Test task",
        description: "fixture task",
        status: "pending",
        priority: "should",
        dependencies: [],
        subtasks: [],
        updatedAt: "2026-05-22T10:00:00.000Z",
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
  await writeFile(path, JSON.stringify(body, null, 2), "utf8");
  return path;
}

async function waitForStdoutMarker(
  subprocess: Subprocess,
  marker: string,
  timeoutMs: number,
): Promise<string> {
  if (!subprocess.stdout) return "";
  const reader = (subprocess.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const start = Date.now();
  try {
    while (Date.now() - start < timeoutMs) {
      const readPromise = reader.read();
      const timeoutPromise = new Promise<{ done: true; value: undefined }>(
        (_, reject) => setTimeout(() => reject(new Error("read timeout")), 250),
      );
      try {
        const result = await Promise.race([readPromise, timeoutPromise]);
        if ((result as { done: boolean }).done) break;
        const chunk = (result as { value: Uint8Array }).value;
        buffer += decoder.decode(chunk, { stream: true });
        if (buffer.includes(marker)) return buffer;
      } catch {
        // continue
      }
    }
  } finally {
    reader.releaseLock();
  }
  return buffer;
}

function extractServerUrl(stdout: string): string | null {
  const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+/);
  return match ? match[0] : null;
}

async function spawnAndWaitForUrl(cmd: string[]): Promise<{
  proc: Subprocess;
  url: string;
}> {
  const proc = Bun.spawn({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TASK_VIEW_NO_BROWSER: "1" },
  });
  procs.push(proc);
  const stdout = await waitForStdoutMarker(proc, "Server ready at", 5000);
  const url = extractServerUrl(stdout);
  if (!url) {
    throw new Error(
      `Server URL not found in stdout (first 500 chars): ${stdout.slice(0, 500)}`,
    );
  }
  return { proc, url };
}

describe("Dual-entry — CLI + plugin both serve identical routes (PRODUCT inv 41 + TECH §6.3)", () => {
  test("CLI direct invocation (node bin/task-view.js) boots + serves /api/ledger", async () => {
    const ledgerPath = await writeLedger();
    const { url } = await spawnAndWaitForUrl([
      "node",
      BIN_PATH,
      "--no-browser",
      "--port",
      "0",
      ledgerPath,
    ]);
    const resp = await fetch(`${url}/api/ledger`);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.kind).toBe("task-list");
    expect(typeof body.mtime).toBe("string");
  });

  test("plugin invocation (node_modules/.bin/task-view symlink) boots + serves /api/ledger", async () => {
    if (!existsSync(NODE_MODULES_BIN)) {
      // Fallback: the symlink hasn't been created by `bun install` yet.
      // We still verify the CONTRACT by re-invoking the same bin/task-view.js
      // — which is exactly what the symlink would resolve to.
      // The plugin manifest's `script: node_modules/.bin/task-view`
      // resolves to bin/task-view.js via the package.json `bin` field.
      const ledgerPath = await writeLedger();
      const { url } = await spawnAndWaitForUrl([
        "node",
        BIN_PATH,
        "--no-browser",
        "--port",
        "0",
        ledgerPath,
      ]);
      const resp = await fetch(`${url}/api/ledger`);
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.ok).toBe(true);
      expect(body.kind).toBe("task-list");
      return;
    }
    // Real symlink exists — exercise it.
    const ledgerPath = await writeLedger();
    const { url } = await spawnAndWaitForUrl([
      NODE_MODULES_BIN,
      "--no-browser",
      "--port",
      "0",
      ledgerPath,
    ]);
    const resp = await fetch(`${url}/api/ledger`);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.kind).toBe("task-list");
  });

  test("CLI and plugin invocations return identical /api/ledger body shape", async () => {
    const ledgerPath = await writeLedger();
    // Boot two servers — one via direct CLI invocation, one via the
    // plugin's script target (or the same bin if the symlink is absent).
    const { url: cliUrl } = await spawnAndWaitForUrl([
      "node",
      BIN_PATH,
      "--no-browser",
      "--port",
      "0",
      ledgerPath,
    ]);
    const pluginCmd = existsSync(NODE_MODULES_BIN)
      ? [NODE_MODULES_BIN, "--no-browser", "--port", "0", ledgerPath]
      : ["node", BIN_PATH, "--no-browser", "--port", "0", ledgerPath];
    const { url: pluginUrl } = await spawnAndWaitForUrl(pluginCmd);
    const [cliResp, pluginResp] = await Promise.all([
      fetch(`${cliUrl}/api/ledger`),
      fetch(`${pluginUrl}/api/ledger`),
    ]);
    expect(cliResp.status).toBe(200);
    expect(pluginResp.status).toBe(200);
    const [cliBody, pluginBody] = await Promise.all([
      cliResp.json(),
      pluginResp.json(),
    ]);
    // Structural equality (same kind, same fields). mtime varies
    // because they're separate stat() reads, but the rest is identical.
    expect(cliBody.ok).toBe(pluginBody.ok);
    expect(cliBody.kind).toBe(pluginBody.kind);
    expect(cliBody.mirrorDirName).toBe(pluginBody.mirrorDirName);
    expect(Object.keys(cliBody.data).sort()).toEqual(
      Object.keys(pluginBody.data).sort(),
    );
  });
});
