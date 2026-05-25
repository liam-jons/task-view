/**
 * ledger-transaction.ts — ID-20.15 cross-ledger atomic transaction.
 *
 * The canonical case is PROMOTE: remove an item from `product-backlog.json`
 * AND add a corresponding Task to `task-list.json` in a single
 * all-or-nothing operation.
 *
 * ── Atomicity model (the load-bearing part) ────────────────────────────────
 *
 * True 2-file POSIX atomicity is NOT achievable — there is no syscall that
 * renames two files in one indivisible step. We therefore bound the window
 * as tightly as the filesystem allows and document the residual honestly:
 *
 *   1. VALIDATE EVERYTHING FIRST. Both ledger mtimes must match the
 *      client-supplied base mtimes (else 409). Both new document contents
 *      must parse against their schemas (else 422). No bytes are renamed
 *      until every check passes.
 *   2. STAGE BOTH. Write each new content to a temp file next to its target
 *      and `fsync` it (durable bytes, original untouched).
 *   3. COMMIT LAST. Rename both temps over their targets back-to-back, with
 *      NO awaited work between the two renames.
 *
 * Fault-injection contract (testStrategy): "a process kill mid-transaction
 * (pre-commit) must leave BOTH ledger files in their pre-transaction
 * state." A kill during phases 1–2 leaves both originals pristine; the
 * orphaned temps are harmless (`.tmp.<pid>.…` — ignored by the mirror
 * generator + git). The injectable fault seam (`faultBeforeCommit`) fires
 * AFTER staging + BEFORE the first rename, which is exactly where a
 * realistic kill lands (staging is the slow, awaited part; the two renames
 * are adjacent metadata ops).
 *
 * ── Residual two-rename window (documented honestly) ───────────────────────
 *
 * Between rename #1 and rename #2 there is a sub-microsecond window where
 * the first ledger has committed and the second has not. A kill there would
 * leave the backlog item removed but the new Task absent (or vice-versa).
 * We bound this by:
 *   - performing the two renames adjacently with no `await` between them, so
 *     no I/O, GC, or scheduler yield can stretch the window;
 *   - committing the ADDITIVE side (task-list insert) FIRST, then the
 *     REMOVAL side (backlog delete) second. If a kill lands between them the
 *     residual state is "Task created + backlog item still present" — a
 *     visible, self-healing duplicate (the operator re-runs Promote, which
 *     409s on the now-stale backlog mtime or no-ops the already-present
 *     Task) rather than silent data loss (item gone + no Task). Lost-update
 *     is strictly worse than a transient duplicate, so we order to favour
 *     the duplicate.
 *
 * This is the best guarantee a userland 2-file commit can offer without a
 * write-ahead journal; the fault-injection test covers the pre-commit
 * window, which is where a kill realistically occurs.
 */

import { renameSync } from "node:fs";
import { stat } from "node:fs/promises";

import { detectSchema, type DetectSchemaResult } from "./detect-schema";
import {
  stageAtomicWrite,
  commitStagedWrite,
  abortStagedWrite,
  type StagedWrite,
} from "./atomic-write";
import { insertRecord, removeRecord } from "./record-mutate";
import { generateRecordMirror, generateMirrors } from "./mirror-generator";
import type { ZodError } from "zod";

type KnownDetected = Exclude<DetectSchemaResult, { kind: "unknown" }>;

/**
 * Optional fault-injection seam. Fires AFTER both writes are staged
 * (durable temps) and BEFORE the first commit rename. A test passes a
 * function that throws to simulate a process kill at the pre-commit point.
 * Production callers never pass this.
 */
export type PreCommitFault = () => void | Promise<void>;

export interface PromoteTransactionInput {
  /** Path to the task-list.json ledger (the ADD side). */
  taskListPath: string;
  /** Path to the product-backlog.json ledger (the REMOVE side). */
  backlogPath: string;
  /** Client's last-seen task-list mtime (ISO 8601). */
  taskListBaseMtime: string;
  /** Client's last-seen backlog mtime (ISO 8601). */
  backlogBaseMtime: string;
  /** Id of the backlog item being promoted (removed). */
  sourceBacklogId: string;
  /** Full Task record body to insert into task-list. */
  taskRecord: unknown;
  /** Test-only: injected fault fired at the pre-commit point. */
  faultBeforeCommit?: PreCommitFault;
}

export type PromoteTransactionResult =
  | {
      ok: true;
      taskListMtime: string;
      backlogMtime: string;
      newTaskId: string;
      removedBacklogId: string;
      mirrorsWritten: string[];
      mirrorsDeleted: string[];
    }
  | {
      ok: false;
      status: number;
      error: string;
      detail?: string;
      issues?: ZodError["issues"];
    };

interface LoadedLedger {
  detected: KnownDetected;
  mtimeIso: string;
}

async function loadLedger(
  path: string,
  expectedKind: KnownDetected["kind"],
): Promise<LoadedLedger | { error: PromoteTransactionResult & { ok: false } }> {
  let rawText: string;
  try {
    rawText = await Bun.file(path).text();
  } catch (err) {
    return {
      error: {
        ok: false,
        status: 500,
        error: "ledger-read-failed",
        detail: `${path}: ${(err as Error).message}`,
      },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    return {
      error: {
        ok: false,
        status: 500,
        error: "ledger-parse-failed",
        detail: `${path}: ${(err as Error).message}`,
      },
    };
  }
  const detected = detectSchema(parsed);
  if (detected.kind === "unknown") {
    return {
      error: {
        ok: false,
        status: 422,
        error: "unknown-document-name",
        detail: `${path}: document_name ${detected.documentName ?? "null"}`,
      },
    };
  }
  if (detected.kind !== expectedKind) {
    return {
      error: {
        ok: false,
        status: 422,
        error: "wrong-ledger-kind",
        detail: `${path}: expected ${expectedKind}, got ${detected.kind}`,
      },
    };
  }
  const mtimeIso = (await stat(path)).mtime.toISOString();
  return { detected, mtimeIso };
}

function mtimeStale(baseMtime: string, currentMtime: string): boolean {
  const baseMs = Date.parse(baseMtime);
  const currentMs = Date.parse(currentMtime);
  if (!Number.isFinite(baseMs)) return false; // signalled separately
  return currentMs > baseMs;
}

function serialise(detected: KnownDetected): string {
  return JSON.stringify(detected.data, null, 2);
}

/**
 * Execute a Promote transaction: insert `taskRecord` into the task-list
 * ledger AND remove `sourceBacklogId` from the backlog ledger, atomically.
 *
 * Validation-first, stage-both, commit-last (see file header). Returns a
 * discriminated-union result; the caller maps `status` to the HTTP code.
 */
export async function promoteTransaction(
  input: PromoteTransactionInput,
): Promise<PromoteTransactionResult> {
  // ── Phase 1: validate everything (no bytes touched) ──────────────────────

  // Reject unparseable base mtimes up front (mirrors the PATCH path).
  if (!Number.isFinite(Date.parse(input.taskListBaseMtime))) {
    return {
      ok: false,
      status: 400,
      error: "invalid-baseMtime",
      detail: "taskListBaseMtime",
    };
  }
  if (!Number.isFinite(Date.parse(input.backlogBaseMtime))) {
    return {
      ok: false,
      status: 400,
      error: "invalid-baseMtime",
      detail: "backlogBaseMtime",
    };
  }

  const taskListLoad = await loadLedger(input.taskListPath, "task-list");
  if ("error" in taskListLoad) return taskListLoad.error;
  const backlogLoad = await loadLedger(input.backlogPath, "backlog");
  if ("error" in backlogLoad) return backlogLoad.error;

  // mtime collision on EITHER side → 409 (PRODUCT inv 37 semantics).
  if (mtimeStale(input.taskListBaseMtime, taskListLoad.mtimeIso)) {
    return {
      ok: false,
      status: 409,
      error: "mtime-mismatch",
      detail: `task-list changed underneath you (current ${taskListLoad.mtimeIso})`,
    };
  }
  if (mtimeStale(input.backlogBaseMtime, backlogLoad.mtimeIso)) {
    return {
      ok: false,
      status: 409,
      error: "mtime-mismatch",
      detail: `backlog changed underneath you (current ${backlogLoad.mtimeIso})`,
    };
  }

  // Apply both mutations in-memory + re-parse against schemas.
  const insertResult = insertRecord(taskListLoad.detected, input.taskRecord);
  if (!insertResult.ok) {
    if (insertResult.kind === "duplicate-id") {
      return {
        ok: false,
        status: 409,
        error: "duplicate-id",
        detail: `Task id ${insertResult.recordId} already exists in task-list`,
      };
    }
    if (insertResult.kind === "schema-error") {
      return {
        ok: false,
        status: 422,
        error: "schema-error",
        issues: insertResult.zodError.issues,
      };
    }
    return {
      ok: false,
      status: 422,
      error: insertResult.kind,
      detail: "detail" in insertResult ? insertResult.detail : undefined,
    };
  }

  const removeResult = removeRecord(
    backlogLoad.detected,
    input.sourceBacklogId,
  );
  if (!removeResult.ok) {
    if (removeResult.kind === "record-not-found") {
      return {
        ok: false,
        status: 404,
        error: "backlog-item-not-found",
        detail: `backlog item ${input.sourceBacklogId} not found`,
      };
    }
    if (removeResult.kind === "schema-error") {
      return {
        ok: false,
        status: 422,
        error: "schema-error",
        issues: removeResult.zodError.issues,
      };
    }
    return { ok: false, status: 422, error: removeResult.kind };
  }

  const newTaskContent = serialise(insertResult.detected);
  const backlogContent = serialise(removeResult.detected);

  // ── Phase 2: stage both (durable temps; originals untouched) ─────────────
  let stagedTaskList: StagedWrite | null = null;
  let stagedBacklog: StagedWrite | null = null;
  try {
    stagedTaskList = await stageAtomicWrite(input.taskListPath, newTaskContent);
    stagedBacklog = await stageAtomicWrite(input.backlogPath, backlogContent);
  } catch (err) {
    // Staging failed — discard any partial temp; both originals are pristine.
    if (stagedTaskList) await abortStagedWrite(stagedTaskList);
    if (stagedBacklog) await abortStagedWrite(stagedBacklog);
    return {
      ok: false,
      status: 500,
      error: "stage-failed",
      detail: (err as Error).message,
    };
  }

  // ── Fault-injection seam (pre-commit). Tests throw here to assert both
  // originals survive. A throw leaves the staged temps orphaned (harmless)
  // and the canonical files untouched. ────────────────────────────────────
  if (input.faultBeforeCommit) {
    try {
      await input.faultBeforeCommit();
    } catch (err) {
      // Mimic a process kill: abort the staged temps + propagate so the
      // caller (and the test) observes the abort with both originals intact.
      await abortStagedWrite(stagedTaskList);
      await abortStagedWrite(stagedBacklog);
      throw err;
    }
  }

  // ── Phase 3: commit both. Renames are adjacent — NO await between them so
  // the two-rename residual window stays sub-microsecond. ADD side commits
  // FIRST so a kill between renames yields a transient duplicate (Task
  // present + backlog item still present), never a lost update. ────────────
  try {
    await commitStagedWrite(stagedTaskList); // ADD side first
    commitStagedWriteSync(stagedBacklog); // REMOVE side — sync to avoid a yield
  } catch (err) {
    // A rename failure here is the unrecoverable residual window. Surface a
    // 500 with enough detail for the operator to reconcile. We do NOT
    // attempt an automatic rollback: the first rename may already have
    // committed and reverting it could itself crash mid-way, compounding
    // the inconsistency. The deterministic ADD-first ordering keeps the
    // worst case a benign duplicate.
    return {
      ok: false,
      status: 500,
      error: "commit-failed",
      detail: (err as Error).message,
    };
  }

  // ── Post-commit: regen mirrors (best-effort; canonical already durable).
  const mirrorsWritten: string[] = [];
  const mirrorsDeleted: string[] = [];
  try {
    const addMirror = await generateRecordMirror(
      insertResult.detected,
      input.taskListPath,
      insertResult.recordId,
    );
    mirrorsWritten.push(...addMirror.written);
    // Backlog removal needs a full regen so the orphaned mirror is deleted.
    const backlogRegen = await generateMirrors(
      removeResult.detected,
      input.backlogPath,
    );
    mirrorsWritten.push(...backlogRegen.written);
    mirrorsDeleted.push(...backlogRegen.deleted);
  } catch {
    // Mirror regen is derived state; a failure here does not invalidate the
    // committed canonicals. The client can re-issue a regen request.
  }

  const taskListMtime = (await stat(input.taskListPath)).mtime.toISOString();
  const backlogMtime = (await stat(input.backlogPath)).mtime.toISOString();

  return {
    ok: true,
    taskListMtime,
    backlogMtime,
    newTaskId: insertResult.recordId,
    removedBacklogId: removeResult.recordId,
    mirrorsWritten,
    mirrorsDeleted,
  };
}

/**
 * Synchronous rename for the SECOND commit. Using the sync syscall for the
 * back-to-back second rename guarantees no microtask/scheduler yield can
 * stretch the two-rename window after the first (async) rename resolves.
 */
function commitStagedWriteSync(staged: StagedWrite): void {
  renameSync(staged.tmpPath, staged.targetPath);
}
