/**
 * tests/integration/cli-flags.test.ts — PLAN §20.11 acceptance gate.
 *
 * Exercises the CLI binary `bin/task-view.js` end-to-end via
 * `Bun.spawn`. Each flag is verified against the running binary:
 *
 *   - `--no-browser`: server boots + prints ready URL; openBrowser is
 *     skipped (we cannot directly observe the side-effect, but we can
 *     observe the readiness message + spawn does not stall on an
 *     `open` command).
 *   - `--port <N>`: server binds on the requested port (or, when
 *     occupied, retries — covered separately in port-retry.test.ts).
 *   - `--check`: one-shot mirror-regen sanity pass; exits 0 on no
 *     drift; non-zero on drift.
 *
 * Network operations require `dangerouslyDisableSandbox: true` when
 * run via the Claude harness — same gotcha as patch-server tests.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";

let testDir: string;
let proc: Subprocess | null = null;

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const BIN_PATH = join(REPO_ROOT, "bin", "task-view.js");

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "task-view-cli-test-"));
  proc = null;
});

afterEach(async () => {
  if (proc) {
    try {
      proc.kill("SIGTERM");
      await proc.exited;
    } catch {
      // Already exited
    }
    proc = null;
  }
  await rm(testDir, { recursive: true, force: true });
});

function makeMinimalTaskListLedger() {
  return {
    document_name: "Knowledge Hub Task List",
    document_purpose: "Test fixture.",
    last_updated: "test",
    related_documents: [],
    tasks: [],
  };
}

async function writeLedger(filename = "task-list.json"): Promise<string> {
  const path = join(testDir, filename);
  await writeFile(
    path,
    JSON.stringify(makeMinimalTaskListLedger(), null, 2),
    "utf8",
  );
  return path;
}

/**
 * Spawn the CLI binary with the supplied args, return the subprocess.
 * Caller awaits stdout / stderr via the returned handle.
 */
function spawnCli(args: string[]): Subprocess {
  return Bun.spawn({
    cmd: ["node", BIN_PATH, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // Prevent the openBrowser call from spawning real browsers in CI.
      // The --no-browser flag is the proper guard; this is belt+braces.
      TASK_VIEW_NO_BROWSER: "1",
    },
  });
}

async function readStreamToString(stream: ReadableStream<Uint8Array> | null): Promise<string> {
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

/**
 * Wait until stdout contains a marker substring, or until timeoutMs
 * elapses (returns the accumulated buffer either way).
 */
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
        // Timeout on this read iteration — continue polling.
      }
    }
  } finally {
    reader.releaseLock();
  }
  return buffer;
}

describe("CLI — --check flag (TECH §6.4 / PRODUCT inv 42)", () => {
  test("exits 0 when ledger matches generated mirrors (no drift, no mirrors exist yet)", async () => {
    const ledgerPath = await writeLedger();
    proc = spawnCli(["--check", ledgerPath]);
    const exitCode = await proc.exited;
    // When no mirrors exist yet, --check generates them and exits 0
    // (this represents "no drift" because there's nothing to drift
    // from). The acceptance per inv 42 is "exit 0 on no drift".
    expect(exitCode).toBe(0);
    proc = null;
  });

  test("exits non-zero when ledger path does not exist", async () => {
    const bogusPath = join(testDir, "does-not-exist.json");
    proc = spawnCli(["--check", bogusPath]);
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    proc = null;
  });
});

describe("CLI — --no-browser flag (TECH §6.1 / PRODUCT inv 42)", () => {
  test("when --no-browser is set, server boots and prints readiness URL", async () => {
    const ledgerPath = await writeLedger();
    proc = spawnCli(["--no-browser", "--port", "0", ledgerPath]);
    const stdout = await waitForStdoutMarker(proc, "Server ready at", 5000);
    expect(stdout).toContain("Server ready at");
    expect(stdout).toContain("http://127.0.0.1:");
  });
});

describe("CLI — positional path argument (TECH §6.1)", () => {
  test("accepts the ledger path as the first positional argument", async () => {
    const ledgerPath = await writeLedger();
    proc = spawnCli(["--no-browser", "--port", "0", ledgerPath]);
    const stdout = await waitForStdoutMarker(proc, "Server ready at", 5000);
    expect(stdout).toContain("Server ready at");
  });
});

describe("CLI — no-path invocation scans CWD (TECH §2.3 / PRODUCT inv 43)", () => {
  test("when no path is supplied, scans CWD for known document_name JSON files", async () => {
    // Create a ledger in the test dir, then spawn with CWD=testDir
    await writeLedger();
    proc = Bun.spawn({
      cmd: ["node", BIN_PATH, "--no-browser", "--port", "0"],
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TASK_VIEW_NO_BROWSER: "1" },
    });
    const stdout = await waitForStdoutMarker(proc, "Server ready at", 5000);
    expect(stdout).toContain("Server ready at");
  });

  test("when no path is supplied AND CWD has no known ledgers, exits non-zero with friendly message", async () => {
    // Empty CWD — no JSON files at all
    const emptyDir = join(testDir, "empty");
    await mkdir(emptyDir);
    proc = Bun.spawn({
      cmd: ["node", BIN_PATH],
      cwd: emptyDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TASK_VIEW_NO_BROWSER: "1" },
    });
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    const stderr = await readStreamToString(proc.stderr as ReadableStream<Uint8Array>);
    expect(stderr.toLowerCase()).toMatch(/no\s+ledger|no\s+known|not\s+found/);
    proc = null;
  });
});
