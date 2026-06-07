/**
 * daemon-lifecycle.ts — ID-90.11 U9 daemon lifecycle affordances.
 *
 * Helpers behind the `apps/server/index.ts` daemon flags (TECH §Proposed
 * changes U9; OQ-2 ratified: singleton multi-document loopback daemon per
 * ledger directory):
 *
 *   - `--port-file <path>`: {@link buildPortFilePayload} +
 *     {@link writePortFile} — the `{port, pid, version, ledgerDir}` handle
 *     the façade's `ensureServer` reads + validates against `GET
 *     /api/health` (invariant 54 groundwork). Written ATOMICALLY (write-to-
 *     temp + rename via atomicWriteFile) once the daemon is listening, so a
 *     reader can never observe a torn handle.
 *
 *   - `--idle-exit <minutes>`: {@link createIdleMonitor} — exits the daemon
 *     after N minutes without a request. The clock is injectable so the
 *     unit suite is deterministic; the daemon integration test exercises
 *     the real timer with a short window.
 *
 *   - `--serve-dir <dir>`: {@link pickLaunchDocument} — the daemon serves
 *     ALL known documents via slug routes, but bare `/api/ledger/*`
 *     back-compat routing needs ONE launch document. The pick is
 *     deterministic: KNOWN_DOCUMENT_NAMES preference order (task-list →
 *     roadmap → backlog → umbrellas), so repeated daemon spawns against
 *     the same directory always agree.
 *
 * These live in packages/server (not apps/server) so they sit INSIDE the
 * `bun run typecheck` gate — apps/server's tsconfig is outside it
 * (task-view backlog-178).
 */

import { KNOWN_DOCUMENT_NAMES, type KnownDocumentName } from "./detect-schema";
import type { ScanResult } from "./path-resolution";
import { atomicWriteFile } from "./atomic-write";

// The canonical tool version — the ROOT package.json `version` field (same
// source cli.ts and /api/health use; Bun's native JSON import).
import rootPkg from "../../package.json";

// ── Port-file handle ─────────────────────────────────────────────────────────

/** The `--port-file` handle shape the façade's ensureServer consumes. */
export interface PortFilePayload {
  port: number;
  pid: number;
  version: string;
  ledgerDir: string;
}

/** Assemble the handle payload for THIS process. */
export function buildPortFilePayload(opts: {
  port: number;
  ledgerDir: string;
}): PortFilePayload {
  return {
    port: opts.port,
    pid: process.pid,
    version: rootPkg.version,
    ledgerDir: opts.ledgerDir,
  };
}

/**
 * Write the handle ATOMICALLY (temp + rename). The parent directory must
 * exist — the spawning façade owns the `.cache/ledger-server/` dir.
 */
export async function writePortFile(
  path: string,
  payload: PortFilePayload,
): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(payload, null, 2)}\n`);
}

// ── Idle-exit monitor ────────────────────────────────────────────────────────

export interface IdleMonitorOptions {
  /** Fire onIdle after this long without a touch. */
  idleAfterMs: number;
  /** Called ONCE when the idle threshold is crossed. */
  onIdle: () => void;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
  /**
   * Polling interval for the internal timer. `null` disables the internal
   * timer entirely (tests drive {@link IdleMonitor.check} directly).
   * Defaults to a quarter of idleAfterMs, clamped to [250ms, 30s].
   */
  checkIntervalMs?: number | null;
}

export interface IdleMonitor {
  /** Record activity — resets the idle window. */
  touch: () => void;
  /** Evaluate the idle condition now; fires onIdle (once) when crossed. */
  check: () => void;
  /** Disarm the monitor + clear the internal timer. Idempotent. */
  stop: () => void;
}

/**
 * Create an idle monitor. The internal timer is `unref`ed so a stopping
 * daemon never lingers on the poll loop.
 */
export function createIdleMonitor(opts: IdleMonitorOptions): IdleMonitor {
  const now = opts.now ?? Date.now;
  let lastActivity = now();
  let stopped = false;
  let fired = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const check = () => {
    if (stopped || fired) return;
    if (now() - lastActivity >= opts.idleAfterMs) {
      fired = true;
      opts.onIdle();
    }
  };

  const stop = () => {
    stopped = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  if (opts.checkIntervalMs !== null) {
    const intervalMs =
      opts.checkIntervalMs ??
      Math.min(30_000, Math.max(250, Math.floor(opts.idleAfterMs / 4)));
    timer = setInterval(check, intervalMs);
    // Never keep the process alive for the poll loop alone.
    timer.unref?.();
  }

  return {
    touch: () => {
      lastActivity = now();
    },
    check,
    stop,
  };
}

// ── Launch-document pick for --serve-dir ─────────────────────────────────────

/**
 * Pick the launch document for a `--serve-dir` daemon from a
 * `scanForLedgers` result. Deterministic: KNOWN_DOCUMENT_NAMES preference
 * order (task-list → roadmap → backlog → umbrellas). Returns null when the
 * directory holds no known document (the daemon fails loudly — invariant
 * 54's never-hang posture starts at spawn).
 */
export function pickLaunchDocument(
  scan: ScanResult,
): { path: string; documentName: KnownDocumentName } | null {
  if (scan.kind === "none") return null;
  if (scan.kind === "one") {
    return { path: scan.path, documentName: scan.documentName };
  }
  for (const name of KNOWN_DOCUMENT_NAMES) {
    const match = scan.paths.find((p) => scan.perPathName[p] === name);
    if (match !== undefined) {
      return { path: match, documentName: name };
    }
  }
  return null;
}
