/**
 * atomic-write.ts — TECH §5.3 atomic write-to-temp + POSIX rename.
 *
 * PRODUCT inv 36: all writes to the canonical JSON ledger are atomic —
 * a crashed write never produces a partial file.
 *
 * Implementation (TECH §5.3):
 *   1. Write content to a temp file in the SAME directory as the target.
 *   2. `fs.rename(tmp, target)` — POSIX `rename(2)` is atomic on the same
 *      filesystem (macOS APFS, Linux ext4/XFS/btrfs, Windows NTFS via Bun).
 *   3. On failure, the tmp file is best-effort cleaned up; the canonical
 *      file is left untouched.
 *
 * Same primitive as mirror-generator.ts already uses (ID-20.7) — extracted
 * here so the patch server (ID-20.8) and the mirror generator share a
 * single implementation rather than two parallel copies. Mirror generator
 * keeps its in-file `atomicWrite(...)` private wrapper for source-locality
 * convenience; both wrappers MAY converge in a future refactor but for
 * now staying with copy-locality keeps the 20.7 acceptance untouched.
 *
 * Cross-FS renames are explicitly out of scope (the tmp lives next to the
 * target by construction). If the target's directory does not exist the
 * underlying write fails — callers must ensure mkdir-ed targets.
 */

import { rename, rm, writeFile } from "node:fs/promises";

/**
 * Write `content` to `targetPath` atomically.
 *
 * On success, the file at `targetPath` reflects the full content. On
 * failure (write error, rename error, etc.), the temp file is best-effort
 * removed and the original error is re-thrown. The canonical file at
 * `targetPath` is never partially written: either the rename completed
 * (full content visible) or it didn't (original content untouched, or no
 * file at all if `targetPath` didn't pre-exist).
 *
 * @throws Re-throws the underlying write / rename error after best-effort
 *         cleanup of the temp file. Callers are expected to surface this
 *         as a 5xx in the patch server (TECH §5.3 last paragraph).
 */
export async function atomicWriteFile(
  targetPath: string,
  content: string,
): Promise<void> {
  // Suffix includes pid + Date.now() + a short random tag so two concurrent
  // writes to the same target (e.g. two viewer tabs racing) produce
  // disjoint temp names. The mtime check in §5.4 prevents both writes
  // landing, but the temp-name collision must not corrupt them mid-flight.
  const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}`;
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, targetPath);
  } catch (err) {
    // Best-effort cleanup of the temp file on failure. We deliberately
    // do not surface the cleanup error — the original write/rename error
    // is what the caller needs to react to.
    try {
      await rm(tmp, { force: true });
    } catch {
      // Suppress.
    }
    throw err;
  }
}
