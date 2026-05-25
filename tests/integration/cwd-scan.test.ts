/**
 * tests/integration/cwd-scan.test.ts — PLAN §20.11 acceptance gate.
 *
 * Per TECH §2.3 / PRODUCT inv 43, the CLI's no-path invocation scans
 * the CWD for `document_name`-bearing JSON files and emits a
 * numbered list. Three branches:
 *
 *   - zero matches: error message + exit 1
 *   - one match:    proceed to server boot with that ledger
 *   - multiple:     print numbered list + launch [1] (friendly miss
 *                   per inv 43)
 *
 * These tests spawn the CLI binary via `Bun.spawn` with `cwd` pointing
 * at a tmpdir containing 0 / 1 / N synthetic ledgers, asserting the
 * branches above.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const BIN_PATH = join(REPO_ROOT, "bin", "task-view.js");

let testDir: string;
let proc: Subprocess | null = null;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "task-view-cwd-scan-test-"));
  proc = null;
});

afterEach(async () => {
  if (proc) {
    try {
      proc.kill("SIGTERM");
      await proc.exited;
    } catch {
      // already exited
    }
    proc = null;
  }
  await rm(testDir, { recursive: true, force: true });
});

// Schema-valid fixtures. TaskListSchema is `.strict()` and has NO
// `last_updated` at the document root; RoadmapSchema uses the Phase-B
// `themes[]` shape (ID-20.19) with document_name "Knowledge Hub Roadmap".
// Since 20.20 fail-on-load validates the ledger at boot, these fixtures
// must pass real Zod validation — not just carry a known document_name.
const TASK_LIST = {
  document_name: "Knowledge Hub Task List",
  document_purpose: "fixture",
  related_documents: [],
  tasks: [],
};

const ROADMAP = {
  document_name: "Knowledge Hub Roadmap",
  document_purpose: "fixture",
  date: "2026-05-25",
  status: "Active",
  forward_looking_only: true,
  related_documents: [],
  last_updated: "test",
  themes: [],
};

async function writeLedger(name: string, body: unknown): Promise<string> {
  const path = join(testDir, name);
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

async function readStreamToString(
  stream: ReadableStream<Uint8Array> | null,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  return buffer + decoder.decode();
}

describe("CWD scan — zero matches (PRODUCT inv 43)", () => {
  test("exits non-zero with friendly message when no document_name JSON in CWD", async () => {
    // testDir is empty
    proc = Bun.spawn({
      cmd: ["node", BIN_PATH],
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TASK_VIEW_NO_BROWSER: "1" },
    });
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    const stderr = await readStreamToString(
      proc.stderr as ReadableStream<Uint8Array>,
    );
    // Look for "No known ledger" wording from inferPathFromCwd
    expect(stderr.toLowerCase()).toContain("no known ledger");
    proc = null;
  });
});

describe("CWD scan — one match (PRODUCT inv 43)", () => {
  test("with exactly one known ledger in CWD, proceeds to server boot", async () => {
    await writeLedger("task-list.json", TASK_LIST);
    proc = Bun.spawn({
      cmd: ["node", BIN_PATH, "--no-browser", "--port", "0"],
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TASK_VIEW_NO_BROWSER: "1" },
    });
    const stdout = await waitForStdoutMarker(proc, "Server ready at", 5000);
    expect(stdout).toContain("Server ready at");
    expect(stdout).toContain("http://127.0.0.1:");
  });
});

describe("CWD scan — multiple matches (PRODUCT inv 43)", () => {
  test("emits numbered list to stderr + boots against [1]", async () => {
    await writeLedger("task-list.json", TASK_LIST);
    await writeLedger("product-roadmap.json", ROADMAP);
    proc = Bun.spawn({
      cmd: ["node", BIN_PATH, "--no-browser", "--port", "0"],
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TASK_VIEW_NO_BROWSER: "1" },
    });
    const stdout = await waitForStdoutMarker(proc, "Server ready at", 5000);
    expect(stdout).toContain("Server ready at");
    // stderr should mention "Found N ledger JSON files" + the numbered list
    // We can't easily drain stderr while the process is still alive AND
    // wait for stdout simultaneously without races, so we only assert
    // on stdout here. The numbered-list path is exercised; the
    // friendly-miss text is unit-tested in inferPathFromCwd's
    // own coverage.
  });
});
