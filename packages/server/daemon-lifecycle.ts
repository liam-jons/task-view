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
 *     initiatives → backlog → retros — ID-148.10 repurposes the roadmap
 *     arm; umbrellas is fully retired), so repeated daemon spawns against
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

// ── Parent-death watchdog (foreground orphan guard) ──────────────────────────

export interface ParentDeathMonitorOptions {
  /** Fire ONCE when the launching parent is detected to have exited. */
  onOrphaned: () => void;
  /**
   * Injectable orphan probe (tests). Defaults to a real, runtime-agnostic
   * check: the parent pid changed away from the one we started under
   * (`process.ppid`), OR that original parent pid is no longer alive
   * (`process.kill(pid, 0)` → ESRCH). The dual check does NOT assume
   * `process.ppid` refreshes live after a reparent — some runtimes cache it,
   * so the liveness probe is the reliable signal and the ppid compare is a
   * fast-path.
   */
  isOrphaned?: () => boolean;
  /**
   * Polling interval for the internal timer. `null` disables the internal
   * timer entirely (tests drive {@link ParentDeathMonitor.check} directly).
   * Defaults to 1000ms.
   */
  checkIntervalMs?: number | null;
}

export interface ParentDeathMonitor {
  /** Evaluate the orphan condition now; fires onOrphaned (once) when crossed. */
  check: () => void;
  /** Disarm the monitor + clear the internal timer. Idempotent. */
  stop: () => void;
}

/**
 * Build the default orphan probe, capturing the launcher's pid at creation.
 * Signal `0` performs an existence/permission check WITHOUT delivering a
 * signal: a throw with `ESRCH` means the original parent is gone (`EPERM`
 * means it is alive but owned by another user — still alive, not orphaned).
 */
function defaultIsOrphaned(initialPpid: number): () => boolean {
  return () => {
    if (process.ppid !== initialPpid) return true;
    try {
      process.kill(initialPpid, 0);
      return false;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ESRCH";
    }
  };
}

/**
 * Create a parent-death watchdog. When the launching process exits, this
 * process is reparented (to PID 1 / launchd). A FOREGROUND task-view server
 * has no idle-exit and no browser-close shutdown (the latter was removed —
 * see ledger.ts), so without this guard an orphaned server lingers forever.
 * Firing `onOrphaned` lets the caller stop gracefully.
 *
 * The internal timer is `unref`ed so it never keeps an otherwise-idle process
 * alive. NOT used in daemon mode (`--port-file`): the façade spawns the daemon
 * detached on purpose and bounds its life via `--idle-exit` + kill/respawn.
 */
export function createParentDeathMonitor(
  opts: ParentDeathMonitorOptions,
): ParentDeathMonitor {
  const isOrphaned = opts.isOrphaned ?? defaultIsOrphaned(process.ppid);
  let stopped = false;
  let fired = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const check = () => {
    if (stopped || fired) return;
    if (isOrphaned()) {
      fired = true;
      opts.onOrphaned();
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
    const intervalMs = opts.checkIntervalMs ?? 1_000;
    timer = setInterval(check, intervalMs);
    // Never keep the process alive for the poll loop alone.
    timer.unref?.();
  }

  return { check, stop };
}

// ── Launch-document pick for --serve-dir ─────────────────────────────────────

/**
 * Pick the launch document for a `--serve-dir` daemon from a
 * `scanForLedgers` result. Deterministic: KNOWN_DOCUMENT_NAMES preference
 * order (task-list → initiatives → backlog → retros). Returns null when the
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
