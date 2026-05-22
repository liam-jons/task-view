/**
 * task-view CLI server entrypoint — TECH §6.1.
 *
 * The `bin/task-view.js` shim launches Bun against this file. Here is
 * where:
 *
 *   - `parseArgs` from `node:util` parses the positional path argument
 *     and the three documented flags (`--no-browser`, `--port <N>`,
 *     `--check`).
 *   - When no positional path is supplied, we call into the §2.3
 *     `scanForLedgers` helper to infer a path from CWD (PRODUCT inv 43).
 *   - When `--check` is set, we run a one-shot mirror-regen sanity
 *     pass (`runRegenCheck`) and exit (PRODUCT inv 42).
 *   - Otherwise we start the full task-view server via
 *     `startTaskViewServer` (TECH §6.1 + §6.5 + §6.6), open the
 *     browser unless `--no-browser`, and block on `waitForExit()`
 *     until the server stops (browser-close detection or signal).
 *
 * SIGTERM / SIGINT route to a graceful stop() — the user's Ctrl-C
 * releases the port + resolves waitForExit cleanly.
 *
 * This file MUST be run under the Bun runtime (Bun.serve, Bun.file).
 */
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { detectSchema } from "@task-view/server/detect-schema";
import { generateMirrors } from "@task-view/server/mirror-generator";
import { scanForLedgers } from "@task-view/server/path-resolution";
import { openBrowser } from "@task-view/server/browser";
import { startTaskViewServer } from "@task-view/server/ledger";

// ── Runtime gate ─────────────────────────────────────────────────────────────

if (typeof Bun === "undefined") {
  console.error("task-view requires the Bun runtime to launch its CLI server.");
  process.exit(1);
}

// ── Args parsing ─────────────────────────────────────────────────────────────

type ParsedArgs = {
  positional: string | undefined;
  noBrowser: boolean;
  port: string | undefined;
  check: boolean;
  help: boolean;
  version: boolean;
};

function parseCliArgs(argv: string[]): ParsedArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "no-browser": { type: "boolean", default: false },
      port: { type: "string" },
      check: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
      version: { type: "boolean", default: false, short: "v" },
    },
    allowPositionals: true,
    // strict: unknown options will throw, which we surface via parseArgs's
    // own error (caught in main()).
    strict: true,
  });
  return {
    positional: positionals[0],
    noBrowser: Boolean(values["no-browser"]),
    port: typeof values.port === "string" ? values.port : undefined,
    check: Boolean(values.check),
    help: Boolean(values.help),
    version: Boolean(values.version),
  };
}

function printHelp(): void {
  console.log(
    [
      "Usage:",
      "  task-view [<path-to-ledger.json>] [--no-browser] [--port <N>] [--check]",
      "  task-view --help",
      "  task-view --version, -v",
      "",
      "Flags:",
      "  --no-browser   Do not auto-open the browser; print the URL only.",
      "  --port <N>     Bind the requested port (default: OS-assigned random).",
      "  --check        Run one-shot mirror-regen sanity pass; exit non-zero on drift.",
      "",
      "Without a path argument, task-view scans the current working directory",
      "for `document_name`-bearing JSON files (task-list.json, product-roadmap.json,",
      "product-backlog.json).",
    ].join("\n"),
  );
}

// ── Path inference (TECH §2.3 / PRODUCT inv 43) ──────────────────────────────

async function inferPathFromCwd(): Promise<string | null> {
  const cwd = process.cwd();
  const scan = await scanForLedgers(cwd);
  if (scan.kind === "none") {
    console.error(
      `No known ledger JSON files found in ${cwd}.\n` +
        `Expected one of: task-list.json, product-roadmap.json, product-backlog.json.\n` +
        `Pass an explicit path: task-view <path-to-ledger.json>`,
    );
    return null;
  }
  if (scan.kind === "one") {
    return scan.path;
  }
  // Multiple matches — print the numbered list and pick the first by
  // default (PRODUCT inv 43 "friendly miss" — user can re-invoke with
  // explicit path).
  console.error(
    `Found ${scan.paths.length} ledger JSON files in ${cwd}:\n` +
      scan.paths
        .map((p, i) => `  [${i + 1}] ${p}  (${scan.perPathName[p]})`)
        .join("\n") +
      `\n\nLaunching against [1]. Re-invoke with explicit path to choose another.`,
  );
  return scan.paths[0];
}

// ── --check (TECH §6.4 / PRODUCT inv 42) ─────────────────────────────────────

/**
 * Run a one-shot mirror-regen sanity pass:
 *   1. Read canonical JSON.
 *   2. detectSchema.
 *   3. Generate mirrors (idempotent + orphan delete per §3.4).
 *   4. Exit 0 if everything succeeded — drift detection is captured
 *      by the orphan-delete + idempotent-write behaviour of the
 *      generator itself.
 *
 * Exits non-zero on any failure (read, parse, schema, write).
 *
 * Note: in CI usage (KH-side, ID-20.12), this runs after a developer
 * has committed both the canonical JSON + the existing mirrors. Drift
 * surfaces as `git status` showing modified mirror files post-regen,
 * which CI catches via a follow-up `git diff --exit-code`. The exit
 * code here covers tool-level failure (missing file, ZodError, write
 * error) — drift detection is the layer above.
 */
async function runRegenCheck(ledgerPath: string): Promise<number> {
  if (!existsSync(ledgerPath)) {
    console.error(`task-view --check: ledger path not found: ${ledgerPath}`);
    return 2;
  }
  let raw: unknown;
  try {
    const file = Bun.file(ledgerPath);
    const text = await file.text();
    raw = JSON.parse(text);
  } catch (err) {
    console.error(
      `task-view --check: failed to read or parse ${ledgerPath}: ${
        (err as Error).message
      }`,
    );
    return 3;
  }
  const detected = detectSchema(raw);
  if (detected.kind === "unknown") {
    console.error(
      `task-view --check: unknown document_name "${detected.documentName ?? "(null)"}" in ${ledgerPath}.`,
    );
    return 4;
  }
  try {
    const result = await generateMirrors(detected, ledgerPath);
    console.log(
      `task-view --check: ${detected.kind} OK (${result.written.length} mirrors written, ${result.deleted.length} orphans deleted).`,
    );
    return 0;
  } catch (err) {
    console.error(
      `task-view --check: mirror generation failed: ${(err as Error).message}`,
    );
    return 5;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`task-view: ${(err as Error).message}\n`);
    printHelp();
    return 64; // EX_USAGE
  }

  if (parsed.help) {
    printHelp();
    return 0;
  }
  if (parsed.version) {
    // No package.json import to keep this tree-shakeable; the
    // bin/task-view.js shim can echo a separately-baked version
    // string via env later if needed.
    console.log("task-view 0.1.0");
    return 0;
  }

  // Resolve the ledger path
  const ledgerPath = parsed.positional ?? (await inferPathFromCwd());
  if (!ledgerPath) {
    return 1;
  }

  // --check is a one-shot — does not start a server.
  if (parsed.check) {
    return await runRegenCheck(ledgerPath);
  }

  if (!existsSync(ledgerPath)) {
    console.error(`task-view: ledger path not found: ${ledgerPath}`);
    return 1;
  }

  // Start the server (with port retry + browser-close detection).
  let handle;
  try {
    handle = await startTaskViewServer({
      ledgerPath,
      port: parsed.port,
    });
  } catch (err) {
    console.error(`task-view: ${(err as Error).message}`);
    return 1;
  }

  // Print readiness BEFORE opening browser, so the browser's network
  // request can race ahead of stdout (CLI watchers see the URL first).
  console.log(`Server ready at ${handle.url} — close the tab to exit`);

  // Open browser unless --no-browser.
  if (!parsed.noBrowser && process.env.TASK_VIEW_NO_BROWSER !== "1") {
    // Fire-and-forget: openBrowser returns a boolean (silently fails on
    // headless environments). We deliberately do NOT await its rejection
    // path because the user can always copy the URL from the readiness
    // line above.
    await openBrowser(handle.url);
  }

  // Signal handlers — graceful stop on Ctrl-C / SIGTERM.
  const onSignal = (signal: NodeJS.Signals) => {
    console.error(`\ntask-view: received ${signal}, stopping…`);
    void handle.stop(true);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  // Block on the exit promise (browser-close idle detection OR signal
  // handler stop).
  await handle.waitForExit();
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`task-view: unhandled error: ${(err as Error).message}`);
    process.exit(1);
  });
