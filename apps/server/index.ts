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
 *     `startTaskViewServer` (TECH §6.1 + §6.6), open the browser
 *     unless `--no-browser`, and block on `waitForExit()` until the
 *     user stops the server (Ctrl-C / SIGTERM).
 *
 * SIGTERM / SIGINT route to a graceful stop() — the user's Ctrl-C
 * releases the port + resolves waitForExit cleanly.
 *
 * This file MUST be run under the Bun runtime (Bun.serve, Bun.file).
 */
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { extname } from "node:path";
import { ZodError } from "zod";
import { detectSchema, KNOWN_DOCUMENT_NAMES } from "@task-view/server/detect-schema";
import { generateMirrors } from "@task-view/server/mirror-generator";
import {
  scanForLedgers,
  resolveLedgerForPath,
  buildLedgerLaunchUrl,
} from "@task-view/server/path-resolution";
import { openBrowser } from "@task-view/server/browser";
import { startTaskViewServer } from "@task-view/server/ledger";
import { formatVersion } from "./cli";

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

// ── Record-level path resolution (Subtask 20.21 / PRODUCT inv 6) ─────────────

interface LaunchTarget {
  /** The canonical ledger JSON path the server will bind to. */
  ledgerPath: string;
  /**
   * The record id to preselect in the viewer (parsed from a `.md` mirror
   * filename), or `null` when the user supplied a ledger JSON directly.
   */
  recordId: string | null;
}

/**
 * Resolve the user's positional argument into a launch target.
 *
 * 20.16 smoke-test S26 surfaced the GAP: `task-view docs/reference/tasks/
 * ID-20.md` treated the `.md` mirror itself as a ledger and tried to
 * JSON.parse it (`Invalid number`). PRODUCT inv 6 requires walking up to
 * the sibling JSON + preselecting the named record.
 *
 * - A `.md` mirror path → delegate to `resolveLedgerForPath`, which
 *   ascends one dir, finds the sibling ledger, and extracts the record id
 *   from the filename. The resolved record id flows into the browser
 *   launch URL via `?record=`.
 * - Any other path (`.json` ledger) → passthrough with `recordId: null`.
 *
 * Returns `null` (after printing a visible diagnostic to stderr) when a
 * `.md` mirror cannot be resolved to a sibling ledger.
 */
async function resolveLaunchTarget(positional: string): Promise<LaunchTarget | null> {
  if (extname(positional).toLowerCase() !== ".md") {
    // Ledger JSON path (or any non-mirror path) — passthrough. Fail-on-load
    // + existsSync gating happen downstream in main().
    return { ledgerPath: positional, recordId: null };
  }

  const resolved = await resolveLedgerForPath(positional);
  switch (resolved.kind) {
    case "ledger":
      return { ledgerPath: resolved.ledgerPath, recordId: resolved.recordId };
    case "file-not-found":
      console.error(`task-view: mirror path not found: ${positional}`);
      return null;
    case "no-ledger":
      console.error(
        `task-view: could not resolve a sibling ledger for mirror ${positional}.\n` +
          `No known ledger JSON found in ${resolved.searchedDir}.\n` +
          `Expected one of: task-list.json, product-roadmap.json, product-backlog.json.`,
      );
      return null;
    case "multiple-ledgers":
      console.error(
        `task-view: multiple sibling ledgers found for mirror ${positional} in ${resolved.searchedDir}:\n` +
          resolved.paths.map((p) => `  - ${p}`).join("\n") +
          `\n\nPass an explicit ledger path to disambiguate.`,
      );
      return null;
    case "unknown-format":
      console.error(
        `task-view: mirror ${positional} resolved to an unrecognised document (document_name: ${
          resolved.documentName ?? "(null)"
        }).`,
      );
      return null;
    default: {
      // Exhaustiveness guard.
      const _never: never = resolved;
      console.error(`task-view: could not resolve mirror ${positional}.`);
      return _never;
    }
  }
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

// ── Launch-path fail-on-load (Subtask 20.20 / PRODUCT inv 4 + 48) ─────────────

/**
 * Validate that a ledger can be read + parsed + schema-detected BEFORE we
 * bind a port and print "Server ready at …".
 *
 * 20.16 smoke-test S5 + S6 surfaced a UX defect: the bare server-launch
 * path booted with a readiness line even against a malformed JSON
 * (S6: unparseable) or an unknown `document_name` (S5: inv 4) ledger,
 * deferring the failure until the first `/api/ledger` GET. PRODUCT inv 4
 * + inv 48 require a non-zero exit ON LOAD with a visible diagnostic — no
 * silent/partial/blank render.
 *
 * This mirrors the `--check` path's read/parse/detect cascade (same exit
 * codes) but does NOT generate mirrors — auto-regen on boot is Subtask
 * 20.22's concern, and the data-safety write-gate (`readCanonical` on
 * every write path) is unchanged.
 *
 * Returns `null` when the ledger is loadable (caller proceeds to boot the
 * server), or a non-zero exit code when validation failed (caller returns
 * it; the process exits before any port bind).
 */
async function validateLedgerForLaunch(ledgerPath: string): Promise<number | null> {
  let raw: unknown;
  try {
    const file = Bun.file(ledgerPath);
    const text = await file.text();
    raw = JSON.parse(text);
  } catch (err) {
    console.error(
      `task-view: failed to read or parse ${ledgerPath}: ${
        (err as Error).message
      }`,
    );
    return 3;
  }
  let detected;
  try {
    detected = detectSchema(raw);
  } catch (err) {
    // detectSchema throws ZodError when a KNOWN document_name routes to a
    // schema whose body fails validation (PRODUCT inv 48). Surface the
    // formatted issues so the developer sees what's wrong on load.
    const message =
      err instanceof ZodError
        ? `schema validation failed for ${ledgerPath}:\n${formatZodError(err)}`
        : `schema validation failed for ${ledgerPath}: ${(err as Error).message}`;
    console.error(`task-view: ${message}`);
    return 4;
  }
  if (detected.kind === "unknown") {
    console.error(
      `task-view: unknown document_name "${detected.documentName ?? "(null)"}" in ${ledgerPath}.\n` +
        `Expected one of: ${KNOWN_DOCUMENT_NAMES.map((n) => `"${n}"`).join(", ")}.`,
    );
    return 4;
  }
  return null;
}

/** Format a ZodError's issues as a readable multi-line stderr block. */
function formatZodError(err: ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  - ${path}: ${issue.message}`;
    })
    .join("\n");
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
    // Print the real tool version, sourced from the ROOT package.json
    // via `formatVersion()` (cli.ts). The bin/task-view.js shim runs
    // this file directly under Bun with no bundler `define`, so the
    // version comes from Bun's native JSON import — not a hardcoded
    // literal (the old `0.1.0` rotted behind the root bump to 0.2.0).
    console.log(formatVersion());
    return 0;
  }

  // Resolve the launch target. A positional `.md` mirror path resolves to
  // its sibling ledger + a preselected record id (Subtask 20.21 / PRODUCT
  // inv 6); a ledger JSON path (or CWD-inferred path) carries no record.
  let ledgerPath: string;
  let recordId: string | null = null;
  if (parsed.positional !== undefined) {
    const target = await resolveLaunchTarget(parsed.positional);
    if (!target) {
      return 1;
    }
    ledgerPath = target.ledgerPath;
    recordId = target.recordId;
  } else {
    const inferred = await inferPathFromCwd();
    if (!inferred) {
      return 1;
    }
    ledgerPath = inferred;
  }

  // --check is a one-shot — does not start a server.
  if (parsed.check) {
    return await runRegenCheck(ledgerPath);
  }

  if (!existsSync(ledgerPath)) {
    console.error(`task-view: ledger path not found: ${ledgerPath}`);
    return 1;
  }

  // Fail-on-load (Subtask 20.20 / PRODUCT inv 4 + 48): read + parse +
  // schema-detect the ledger BEFORE binding a port. A malformed JSON,
  // unknown document_name, or schema-invalid body must exit non-zero with
  // a visible diagnostic — never boot with a readiness line and defer the
  // error to the first HTTP GET (the 20.16 S5 + S6 defect).
  const launchValidationCode = await validateLedgerForLaunch(ledgerPath);
  if (launchValidationCode !== null) {
    return launchValidationCode;
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

  // Build the launch URL — when a `.md` mirror resolved to a record id,
  // append `?record=<id>` so the SSR viewer lands directly on that record
  // (Subtask 20.21 / PRODUCT inv 6). A bare ledger launch lands on the
  // index page.
  const launchUrl = buildLedgerLaunchUrl(handle.url, { recordId });

  // Print readiness BEFORE opening browser, so the browser's network
  // request can race ahead of stdout (CLI watchers see the URL first).
  console.log(`Server ready at ${launchUrl} — press Ctrl-C to exit`);

  // Open browser unless --no-browser.
  if (!parsed.noBrowser && process.env.TASK_VIEW_NO_BROWSER !== "1") {
    // Fire-and-forget: openBrowser returns a boolean (silently fails on
    // headless environments). We deliberately do NOT await its rejection
    // path because the user can always copy the URL from the readiness
    // line above.
    await openBrowser(launchUrl);
  }

  // Signal handlers — graceful stop on Ctrl-C / SIGTERM.
  const onSignal = (signal: NodeJS.Signals) => {
    console.error(`\ntask-view: received ${signal}, stopping…`);
    void handle.stop(true);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  // Block on the exit promise (resolved by the SIGINT / SIGTERM handler
  // calling handle.stop()).
  await handle.waitForExit();
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`task-view: unhandled error: ${(err as Error).message}`);
    process.exit(1);
  });
