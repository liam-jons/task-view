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
 *   - `--idle-exit <minutes|Ns|Nm>`: {@link parseIdleExitMs} +
 *     {@link createIdleMonitor} — exits the daemon after the idle window
 *     without a request. Bare-number minutes is unchanged; an `s`/`m` unit
 *     suffix (ID-156.9) adds sub-minute granularity for short-TTL ephemeral
 *     spawns. The clock is injectable so the unit suite is deterministic;
 *     the daemon integration test exercises the real timer with a short
 *     window.
 *
 *   - `--serve-dir <dir>`: {@link pickLaunchDocument} — the daemon serves
 *     ALL known documents via slug routes, but bare `/api/ledger/*`
 *     back-compat routing needs ONE launch document. The pick is
 *     deterministic: KNOWN_DOCUMENT_NAMES preference order (task-list →
 *     initiatives → backlog → retros — ID-148.10 repurposes the roadmap
 *     arm; umbrellas is fully retired), so repeated daemon spawns against
 *     the same directory always agree.
 *
 *   - `--parent-pid <pid>` (ID-156.9): {@link createParentDeathMonitor}'s
 *     `parentPid` option — an opt-in that arms parent-death reaping for a
 *     `--port-file` spawn. The façade's PERSISTENT daemon (default ledger
 *     dir, reused/killed-and-respawned by `ensureServer`) and its EPHEMERAL
 *     per-invocation spawns (non-default dir, never reused, never killed on
 *     the success path — S477) share the same immediate OS parent, so
 *     `--port-file` alone can't tell them apart. Only a caller that names
 *     `--parent-pid` opts a specific spawn into self-stopping when that pid
 *     dies; every other `--port-file` caller (including the persistent
 *     daemon) keeps the pre-existing exemption.
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

// ── --idle-exit value parsing ────────────────────────────────────────────────

/**
 * Parse the `--idle-exit` CLI value into milliseconds.
 *
 * Back-compat (unchanged): a bare number is MINUTES — whatever `Number()`
 * would parse (including `"1e2"`, leading `"+"`, etc.) means exactly what it
 * meant before this helper existed. That branch is tried FIRST and returned
 * as-is so no previously-valid value's interpretation shifts.
 *
 * New: when the bare-number parse fails (`Number(raw)` is not finite —
 * previously always a usage error), a trailing unit suffix is accepted —
 * `"s"` for seconds (sub-minute TTLs for ephemeral spawns that would
 * otherwise round up to a whole minute) or `"m"` as an explicit, equivalent
 * spelling of the bare-number minutes form. Case-insensitive; fractions
 * allowed on either unit.
 *
 * Returns `null` when the value is not a finite positive number in either
 * form — the caller emits the usage error (EX_USAGE).
 */
export function parseIdleExitMs(raw: string): number | null {
  const bare = Number(raw);
  if (Number.isFinite(bare)) {
    return bare > 0 ? bare * 60_000 : null;
  }
  const match = /^\s*([0-9]*\.?[0-9]+)\s*(s|m)\s*$/i.exec(raw);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return match[2].toLowerCase() === "s" ? value * 1_000 : value * 60_000;
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
   * The pid to watch for exit/reparent (feeds the default probe). Defaults
   * to `process.ppid` (this process's real OS parent at creation time).
   *
   * S477: ephemeral `--port-file` spawns and the persistent daemon share
   * the SAME immediate OS parent (the short-lived spawning process), so
   * `process.ppid` alone can't tell them apart. A caller that names an
   * explicit `parentPid` (index.ts's `--parent-pid` flag) is opting a
   * specific spawn INTO parent-death reaping without changing the default
   * for every other `--port-file` caller. Ignored when `isOrphaned` is
   * also given.
   */
  parentPid?: number;
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
 * alive. By default NOT armed in daemon mode (`--port-file`, index.ts): the
 * façade's PERSISTENT daemon is spawned detached on purpose and bounds its
 * life via `--idle-exit` + kill/respawn-on-reuse. index.ts's `--parent-pid`
 * flag (ID-156.9) is the opt-in for `--port-file` spawns that do NOT get
 * that kill/respawn treatment (ephemeral per-invocation servers, S477) —
 * pass `parentPid` here to arm reaping keyed to a named pid instead of
 * `process.ppid`.
 */
export function createParentDeathMonitor(
  opts: ParentDeathMonitorOptions,
): ParentDeathMonitor {
  const isOrphaned =
    opts.isOrphaned ?? defaultIsOrphaned(opts.parentPid ?? process.ppid);
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
