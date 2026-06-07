/**
 * path-mutex.ts — ID-90 U9 per-canonical-path mutation mutex.
 *
 * PRODUCT invariant 38 (mutex half) + 46. Within ONE daemon process, every
 * mutating handler body runs under a per-canonical-path promise-queue. This
 * closes the TOCTOU window between the §5.4 mtime check and the
 * atomic-write rename (patch-server.ts) for writers sharing the daemon:
 * without it, two handlers can BOTH pass the mtime check against the same
 * on-disk state and the second rename silently clobbers the first writer's
 * bytes while both report 200. With it, the second writer's body runs only
 * after the first writer's rename, so its mtime check observes fresh state
 * and the optimistic-concurrency contract (409 mtime-mismatch, PRODUCT inv
 * 37) does its job — the façade-side retry (K2) absorbs the conflict.
 *
 * The residual CROSS-process hazard (a flag-OFF CLI writer racing the
 * daemon) is unchanged — that window is bounded by the phased cutover, not
 * by this module (TECH §Proposed changes U9 / risk table "mtime millisecond
 * granularity").
 *
 * ── Ordering invariant (deadlock freedom) ──────────────────────────────────
 *
 * Multi-path acquisition ({@link withPathLocks} — the promote transaction's
 * two/three legs) ALWAYS takes its locks in FIXED lexicographic order of
 * the RESOLVED canonical paths (UTF-16 code-unit `Array.prototype.sort`,
 * after `path.resolve` normalisation + de-duplication), regardless of the
 * order the caller supplied. All multi-lock holders therefore acquire along
 * one global total order — circular wait is impossible by construction, so
 * the composition of single-path handlers and multi-path transactions is
 * deadlock-free. Any future call site that needs more than one path MUST go
 * through {@link withPathLocks} rather than nesting {@link withPathLock}
 * manually, or the ordering invariant (and the deadlock-freedom proof) is
 * lost.
 *
 * Keys are normalised with `path.resolve` so different spellings of the
 * same canonical file (relative vs absolute) share one queue. Symlinked
 * aliases are out of scope — ledger directories are plain directories and
 * every server-side caller derives paths from the same scan
 * (`scanForLedgers`), so one canonical file has one spelling per process.
 */

import { resolve } from "node:path";

/** Queue tails, keyed by resolved canonical path. A missing key means the
 * lock is free. Tails NEVER reject (rejections are swallowed into the tail
 * so one failing handler cannot poison the queue for the next writer). */
const tails = new Map<string, Promise<void>>();

function withResolvedKeyLock<T>(
  key: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(() => fn());
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  void tail.then(() => {
    // Drop the entry once the queue drains, so the map does not grow
    // unboundedly across the daemon's lifetime.
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}

/**
 * Run `fn` while holding the mutation mutex for ONE canonical path.
 * Acquisitions on the same resolved path run strictly in FIFO order; a
 * rejection propagates to the caller and releases the lock for the next
 * waiter.
 */
export function withPathLock<T>(
  path: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  return withResolvedKeyLock(resolve(path), fn);
}

/**
 * Run `fn` while holding the mutation mutexes for SEVERAL canonical paths
 * (the cross-ledger transaction's two/three legs). Paths are resolved,
 * de-duplicated, and acquired in fixed lexicographic order — see the
 * ordering invariant in the module header.
 */
export function withPathLocks<T>(
  paths: readonly string[],
  fn: () => Promise<T> | T,
): Promise<T> {
  const keys = [...new Set(paths.map((p) => resolve(p)))].sort();
  const acquire = (i: number): Promise<T> =>
    i >= keys.length
      ? Promise.resolve().then(() => fn())
      : withResolvedKeyLock(keys[i], () => acquire(i + 1));
  return acquire(0);
}

/**
 * Number of paths with a live queue tail — observability / test hook only.
 * Production code must never branch on this.
 */
export function pendingPathLockCount(): number {
  return tails.size;
}
