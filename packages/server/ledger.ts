/**
 * ledger.ts — TECH §6.1, §6.5, §6.6 server lifecycle wrapper.
 *
 * `startTaskViewServer` is the single entry point used by both the
 * CLI binary (§6.1 `bin/task-view.js`) and the plugin manifest
 * (§6.2 — plugin invokes the CLI binary, which calls this).
 *
 * Composes the ID-20.8 `startPatchServer` HTTP factory with two
 * lifecycle policies the bare patch-server does NOT carry:
 *
 *   1. **Port retry (§6.6 / PRODUCT inv 49):** on `EADDRINUSE`, retry
 *      up to `MAX_PORT_RETRIES = 5` times. The first attempt uses the
 *      caller's requested port; subsequent attempts request port `0`
 *      (OS-assigned random free port). After exhaustion, throw
 *      "could not bind".
 *
 *   2. **`waitForExit()` promise:** lets the CLI binary block on
 *      `await handle.waitForExit()` rather than juggling signal
 *      handlers. The promise resolves on explicit `handle.stop()` —
 *      the CLI routes Ctrl-C / SIGTERM through it.
 *
 * The 30-second browser-close idle-shutdown (formerly §6.5 / PRODUCT
 * inv 50) was REMOVED for task-view. Static SSR pages issue no keepalive
 * request, so an idle timer tore the server down ~30s after *any* load,
 * not just on tab-close, making the viewer unusable. The server now runs
 * until explicitly stopped — a permanent-fork divergence (PRODUCT inv 1).
 */
import { startPatchServer, type PatchServerHandle } from "./patch-server";
import { detectSchema } from "./detect-schema";
import { generateMirrors } from "./mirror-generator";

// ── Public constants ─────────────────────────────────────────────────────────

/**
 * Maximum port-bind retry attempts (TECH §6.6 / PRODUCT inv 49).
 * Inherited from upstream Plannotator `annotate.ts:87 MAX_RETRIES`.
 * After 5 failures, throw "could not bind" — no infinite loop.
 */
export const MAX_PORT_RETRIES = 5 as const;

// ── Public types ─────────────────────────────────────────────────────────────

export interface TaskViewServerOptions {
  /** Absolute or process-relative path to the canonical ledger JSON. */
  ledgerPath: string;
  /**
   * Port to bind. Number or numeric string. `undefined` (or 0) means
   * "OS-assigned random port". When the requested port is in use,
   * retries with random ports up to MAX_PORT_RETRIES (TECH §6.6).
   */
  port?: number | string;
  /** Optional loopback hostname override (validated by patch-server). */
  hostname?: string;
  /** ID-90 U9 `--require-denylist` (PRODUCT invariant 34): arm the
   * client-name guard's fail-loud posture on every mutating path. */
  requireDenylist?: boolean;
  /** ID-90 U9 `--idle-exit` seam: per-request activity callback. */
  onRequest?: () => void;
}

export interface TaskViewServerHandle {
  url: string;
  port: number;
  hostname: string;
  /** Stop the server, cancel timers, resolve waitForExit. Idempotent. */
  stop: (force?: boolean) => Promise<void>;
  /**
   * Promise that resolves when the server is asked to stop — by
   * explicit stop(), or by browser-close idle detection (§6.5).
   * Use `await handle.waitForExit()` in the CLI binary.
   */
  waitForExit: () => Promise<void>;
}

// ── Internal: port parser ────────────────────────────────────────────────────

function parsePortOption(port: unknown): number | undefined {
  if (port === undefined || port === null || port === "") return undefined;
  const num = typeof port === "string" ? Number(port) : (port as number);
  if (!Number.isFinite(num) || num < 0 || num > 65535) {
    throw new Error(
      `Invalid port "${String(port)}" — must be a number between 0 and 65535.`,
    );
  }
  return num | 0; // integer coerce
}

// ── Internal: bind with retry (§6.6) ─────────────────────────────────────────

/**
 * Attempt to start the patch-server, with retry on EADDRINUSE.
 *
 * On attempt 1 we honour the caller's port preference (which may be
 * `undefined`/0 = OS-assigned random). On retries we ALWAYS request
 * port 0 — once the user's preferred port has been determined to be
 * occupied, the kindest fallback is "any free port" rather than
 * `port + 1` (which still races other processes).
 */
function bindWithRetry(
  options: {
    ledgerPath: string;
    requestedPort: number | undefined;
    hostname: string | undefined;
    requireDenylist: boolean | undefined;
    onRequest: (() => void) | undefined;
  },
): PatchServerHandle {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_PORT_RETRIES; attempt++) {
    const portForAttempt = attempt === 1 ? options.requestedPort : 0;
    try {
      return startPatchServer({
        ledgerPath: options.ledgerPath,
        port: portForAttempt,
        hostname: options.hostname,
        requireDenylist: options.requireDenylist,
        onRequest: options.onRequest,
      });
    } catch (err) {
      lastError = err;
      const msg = (err as Error)?.message ?? "";
      const code = (err as { code?: string })?.code;
      const isBindError =
        code === "EADDRINUSE" ||
        msg.includes("EADDRINUSE") ||
        msg.includes("Failed to start server") ||
        msg.includes("Is port") ||
        msg.includes("address already in use");
      // Non-bind errors (e.g. non-loopback hostname rejection from §5.8)
      // must surface immediately — they are not transient.
      if (!isBindError) throw err;
      if (attempt === MAX_PORT_RETRIES) break;
    }
  }
  throw new Error(
    `could not bind after ${MAX_PORT_RETRIES} attempts (last error: ${
      (lastError as Error)?.message ?? String(lastError)
    })`,
  );
}

// ── Internal: boot-time mirror regen (Subtask 20.22 / inv 5 + 40) ────────────

/**
 * Regenerate the on-disk mirrors from the current canonical ledger BEFORE
 * the server starts serving.
 *
 * 20.16 smoke-test S1 + Side-observation 3 surfaced the gap: a bare server
 * launch printed "Server ready at …" without writing any mirror, so a
 * ledger that changed since its mirrors were last written would render a
 * stale mirror on first view. PRODUCT inv 5 ("generates on launch") + inv
 * 40 ("robust to mirror absence — generates them on the fly") require the
 * rendered mirror to match current ledger content from the first render.
 *
 * Resilience: this runs at boot for BOTH the CLI binary and the plugin
 * entrypoint. The CLI already fails-on-load (Subtask 20.20) for malformed
 * / unknown ledgers before reaching here, but the plugin path may call
 * `startTaskViewServer` directly, so a read/parse/unknown failure here is
 * swallowed — the JSON endpoints surface the diagnostic to the client. We
 * never let a regen failure block the port bind.
 */
async function regenerateMirrorsOnBoot(ledgerPath: string): Promise<void> {
  let detected;
  try {
    const file = Bun.file(ledgerPath);
    const text = await file.text();
    detected = detectSchema(JSON.parse(text));
  } catch {
    // Read / parse / schema-validation failure — defer to the GET handlers
    // (and to the CLI's fail-on-load gate). Do not block boot.
    return;
  }
  if (detected.kind === "unknown") return;
  try {
    await generateMirrors(detected, ledgerPath);
  } catch {
    // Mirror write failure must not prevent the server starting; the
    // client can re-issue POST /api/ledger/regen.
  }
}

// ── Public: factory ──────────────────────────────────────────────────────────

/**
 * Start a task-view server with full lifecycle:
 *   - Boot-time mirror regen (§3 / Subtask 20.22 / inv 5 + 40)
 *   - Port retry (§6.6)
 *   - Request tracking + browser-close idle detection (§6.5)
 *   - waitForExit() promise
 */
export async function startTaskViewServer(
  opts: TaskViewServerOptions,
): Promise<TaskViewServerHandle> {
  const port = parsePortOption(opts.port);

  // ── Boot-time mirror regen (Subtask 20.22) ────────────────────────────────
  // Bring the on-disk mirror in line with the current ledger BEFORE binding
  // the port + serving the first render.
  await regenerateMirrorsOnBoot(opts.ledgerPath);

  // ── Exit-promise plumbing ────────────────────────────────────────────────
  // Resolves only on explicit stop() — the CLI wires SIGINT/SIGTERM to it.
  // There is no idle / browser-close auto-shutdown (removed; see file header).
  let resolveExit: () => void = () => {};
  let exitResolved = false;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = () => {
      if (exitResolved) return;
      exitResolved = true;
      resolve();
    };
  });

  // ── Bind (with retry) ────────────────────────────────────────────────────
  const patchHandle = bindWithRetry({
    ledgerPath: opts.ledgerPath,
    requestedPort: port,
    hostname: opts.hostname,
    requireDenylist: opts.requireDenylist,
    onRequest: opts.onRequest,
  });

  // ── Public handle ────────────────────────────────────────────────────────
  return {
    url: patchHandle.url,
    port: patchHandle.port,
    hostname: patchHandle.hostname,
    stop: async (force = true) => {
      if (exitResolved) return;
      try {
        await patchHandle.stop(force);
      } finally {
        resolveExit();
      }
    },
    waitForExit: () => exitPromise,
  };
}
