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

describe("CLI — record-level path resolution (PRODUCT inv 6 / 20.16 S26)", () => {
  async function writeTaskListWithRecord(): Promise<string> {
    const ledgerPath = join(testDir, "task-list.json");
    await writeFile(
      ledgerPath,
      JSON.stringify(
        {
          document_name: "Knowledge Hub Task List",
          document_purpose: "20.21 record-resolution fixture.",
          related_documents: [],
          tasks: [
            {
              id: "20",
              title: "Per-Task mirror",
              description: "Outer task description.",
              status: "in_progress",
              priority: "must",
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
    return ledgerPath;
  }

  test("resolves a record by id from a .md mirror path + round-trips a record-level read", async () => {
    // S26 GAP: `task-view docs/reference/tasks/ID-20.md` must walk up to
    // the sibling task-list.json, preselect record 20, and serve the JSON
    // endpoints against the resolved ledger.
    await writeTaskListWithRecord();
    const mirrorDir = join(testDir, "tasks");
    await mkdir(mirrorDir, { recursive: true });
    const mirrorPath = join(mirrorDir, "ID-20.md");
    await writeFile(mirrorPath, "---\nid: \"20\"\n---\n\n# ID-20", "utf8");

    proc = spawnCli(["--no-browser", "--port", "0", mirrorPath]);
    const stdout = await waitForStdoutMarker(proc, "Server ready at", 5000);
    expect(stdout).toContain("Server ready at");
    // The readiness URL must carry the preselected record fragment so a
    // CLI watcher (and the browser) lands directly on record 20.
    expect(stdout).toContain("?record=20");

    // Extract the base URL and round-trip a record-level read against the
    // JSON endpoints resolved from the sibling ledger.
    const urlMatch = stdout.match(/Server ready at (http:\/\/[^\s?]+)/);
    expect(urlMatch).not.toBeNull();
    const baseUrl = urlMatch![1].replace(/\/$/, "");
    const res = await fetch(`${baseUrl}/api/ledger/record/20`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      kind: string;
      record: { id: string; title: string };
    };
    expect(body.ok).toBe(true);
    expect(body.kind).toBe("task");
    expect(body.record.id).toBe("20");
    expect(body.record.title).toBe("Per-Task mirror");
  });

  test("a .md mirror with no sibling ledger exits non-zero with a visible error", async () => {
    const mirrorDir = join(testDir, "tasks");
    await mkdir(mirrorDir, { recursive: true });
    const mirrorPath = join(mirrorDir, "ID-20.md");
    await writeFile(mirrorPath, "---\nid: \"20\"\n---\n\n# ID-20", "utf8");

    proc = spawnCli(["--no-browser", "--port", "0", mirrorPath]);
    const exitCode = await proc.exited;
    const stdout = await readStreamToString(
      proc.stdout as ReadableStream<Uint8Array>,
    );
    const stderr = await readStreamToString(
      proc.stderr as ReadableStream<Uint8Array>,
    );
    proc = null;
    expect(exitCode).not.toBe(0);
    expect(stdout).not.toContain("Server ready at");
    expect(stderr.toLowerCase()).toMatch(/no .*ledger|could not resolve|sibling/);
  });
});

describe("CLI — launch-path fail-on-load (PRODUCT inv 4 + 48 / 20.16 S5+S6)", () => {
  test("server-launch against malformed JSON exits non-zero with a visible error and NO readiness line (S6)", async () => {
    // S6: bare server launch against unparseable JSON must fail on load,
    // not boot with "Server ready at …" and defer the error to the first
    // HTTP GET.
    const ledgerPath = join(testDir, "task-list.json");
    await writeFile(ledgerPath, "{ not valid json", "utf8");
    proc = spawnCli(["--no-browser", "--port", "0", ledgerPath]);
    const exitCode = await proc.exited;
    const stdout = await readStreamToString(
      proc.stdout as ReadableStream<Uint8Array>,
    );
    const stderr = await readStreamToString(
      proc.stderr as ReadableStream<Uint8Array>,
    );
    proc = null;

    expect(exitCode).not.toBe(0);
    // No partial/blank render: the readiness line must NOT appear.
    expect(stdout).not.toContain("Server ready at");
    // A visible load error on stderr.
    expect(stderr.toLowerCase()).toMatch(/failed to read or parse|json|parse/);
  });

  test("server-launch against unknown document_name exits non-zero with a visible error and NO readiness line (S5)", async () => {
    // S5: bare server launch against a ledger whose document_name is not
    // one of the three known values must fail on load.
    const ledgerPath = join(testDir, "task-list.json");
    await writeFile(
      ledgerPath,
      JSON.stringify(
        {
          document_name: "Unknown Document Type",
          document_purpose: "Fixture for inv 4.",
          last_updated: "fixture",
          related_documents: [],
          tasks: [],
        },
        null,
        2,
      ),
      "utf8",
    );
    proc = spawnCli(["--no-browser", "--port", "0", ledgerPath]);
    const exitCode = await proc.exited;
    const stdout = await readStreamToString(
      proc.stdout as ReadableStream<Uint8Array>,
    );
    const stderr = await readStreamToString(
      proc.stderr as ReadableStream<Uint8Array>,
    );
    proc = null;

    expect(exitCode).not.toBe(0);
    expect(stdout).not.toContain("Server ready at");
    expect(stderr.toLowerCase()).toMatch(/unknown document_name|unknown document/);
  });

  test("server-launch against schema-invalid body exits non-zero with a visible error and NO readiness line (inv 48)", async () => {
    // A known document_name whose body fails Zod parse — the ZodError
    // must surface on load, not at first GET.
    const ledgerPath = join(testDir, "task-list.json");
    await writeFile(
      ledgerPath,
      JSON.stringify(
        {
          document_name: "Knowledge Hub Task List",
          // Missing every other required field — TaskListSchema rejects.
        },
        null,
        2,
      ),
      "utf8",
    );
    proc = spawnCli(["--no-browser", "--port", "0", ledgerPath]);
    const exitCode = await proc.exited;
    const stdout = await readStreamToString(
      proc.stdout as ReadableStream<Uint8Array>,
    );
    const stderr = await readStreamToString(
      proc.stderr as ReadableStream<Uint8Array>,
    );
    proc = null;

    expect(exitCode).not.toBe(0);
    expect(stdout).not.toContain("Server ready at");
    // The formatted error mentions schema / validation failure.
    expect(stderr.toLowerCase()).toMatch(/schema|invalid|parse|validation/);
  });

  test("server-launch against a valid ledger still boots (no regression)", async () => {
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
