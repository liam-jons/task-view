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
 *
 * ── ID-148.10: capability-theme third leg RETIRED (TECH §3.1(d), INV-12(d)) ─
 *
 * The former ID-90 U7 optional third leg (`capabilityTheme?: {roadmapPath,
 * roadmapBaseMtime, themeId}` — binding `task.capability_theme` and pushing
 * the new task id onto a roadmap theme's `linked_tasks[]`) had no
 * initiatives analog and is REMOVED. Promote is now a two-leg (task-list +
 * backlog) transaction only: validate-first, two staged temps, commit order
 * task-list (ADD) FIRST → backlog (REMOVE) LAST, preserving the
 * benign-transient-duplicate property described above.
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
import { escapeSerialise, scopedSpliceSerialise } from "./scoped-serialise";
import { insertRecord, removeRecord } from "./record-mutate";
import { disciplineWarnings } from "./discipline-warnings";
import { checkBudgetForCreate } from "./gates/budget-gate";
import { beforeCollectionIds } from "./gates/record-set-gate";
import { buildPreWriteGates, runPreWriteGates } from "./gates/gate-chain";
import { generateRecordMirror, generateMirrors } from "./mirror-generator";
import { ZodError } from "zod";

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
  /**
   * ID-90 U2: downgrade a budget rejection on the promoted Task to a
   * `(forced) budget-exceeded:` warning and proceed (PRODUCT invariant 26 —
   * strictly per-invocation). Arrives via the U10 request envelope
   * (record 12); default false.
   */
  force?: boolean;
  /**
   * ID-90.12 U10 (PRODUCT invariant 33): downgrade a client-name-guard
   * rejection on ANY leg to a redacted warning and allow the write.
   * Strictly per-invocation — arrives via the request body; never stored.
   */
  allowClientName?: boolean;
  /**
   * ID-90.12 U10 (PRODUCT invariant 16): run the FULL two-leg validation
   * + gate chain and return the would-be result — stage NOTHING, rename
   * NOTHING (no temps), regen NOTHING, change NO mtime.
   */
  dryRun?: boolean;
  /**
   * ID-90.12 U10: default true. `false` skips the post-commit mirror regen
   * and REPORTS it (`mirrorRegen: "suppressed"` — the K2 mapping's
   * `mirrorStaleReason: 'suppressed'` source).
   */
  regenMirrors?: boolean;
  /**
   * ID-90 U9 (PRODUCT invariant 34): arm the client-name guard's fail-loud
   * posture on EVERY leg — an unset `KH_CLIENT_NAME_DENYLIST` env is the
   * same loud config error an invalid one already is. Threaded from the
   * daemon's `--require-denylist` flag via the patch-server context.
   */
  requireDenylist?: boolean;
  /** Test-only: injected fault fired at the pre-commit point. */
  faultBeforeCommit?: PreCommitFault;
  /**
   * Test-only: SYNC fault fired BETWEEN the commit renames — after the
   * ADD-side rename, before the REMOVE-side rename. Lets the
   * fault-injection suite prove the additive-first / removal-last
   * ordering: a kill there leaves AT WORST a benign transient duplicate
   * (Task present + backlog item still present), never a lost record.
   * Deliberately synchronous — the seam must not introduce an awaited
   * yield between the adjacent renames.
   */
  faultBetweenCommits?: () => void;
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
      /** Gate soft warnings (e.g. forced budget downgrade — ID-90 U2) +
       * U10 discipline / guard-override warnings (invariant 41). */
      warnings: string[];
      /** ID-90.12 U10: present (true) when this was a dry run — nothing
       * staged, nothing renamed, no mirrors touched (invariant 16). */
      dryRun?: true;
      /** ID-90.12 U10: present when `regenMirrors: false` skipped the
       * post-commit regen (K2 maps to `mirrorStaleReason: 'suppressed'`). */
      mirrorRegen?: "suppressed";
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
  /** The ORIGINAL on-disk text — the scoped-splice basis (ID-90 U1). */
  rawText: string;
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
  let detected: DetectSchemaResult;
  try {
    detected = detectSchema(parsed);
  } catch (err) {
    // check-90-12: a sibling with a KNOWN document_name but a schema-invalid
    // body makes detectSchema throw ZodError (detect-schema.ts deliberately
    // does not swallow — PRODUCT inv 48). Uncaught, that rejection escaped
    // handlePostTransaction as a connection reset. Mirror the
    // ledger-parse-failed shape above (SAME code — minimal-vocabulary
    // posture: the detail string carries the parse-vs-schema distinction);
    // redaction-safe summary only (issue count + first issue path) — never
    // the verbatim issues, which can embed document content.
    const summary =
      err instanceof ZodError
        ? `${err.issues.length} issue${err.issues.length === 1 ? "" : "s"}; first at ${
            err.issues[0]?.path.map(String).join(".") || "<root>"
          }`
        : (err as Error).message;
    return {
      error: {
        ok: false,
        status: 500,
        error: "ledger-parse-failed",
        detail: `${path}: schema validation failed (${summary})`,
      },
    };
  }
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
  return { detected, mtimeIso, rawText };
}

function mtimeStale(baseMtime: string, currentMtime: string): boolean {
  const baseMs = Date.parse(baseMtime);
  const currentMs = Date.parse(currentMtime);
  if (!Number.isFinite(baseMs)) return false; // signalled separately
  return currentMs > baseMs;
}

// ID-90 U1: the former local `serialise()` (`JSON.stringify(detected.data,
// null, 2)`) is DELETED — it re-emitted the Zod-reparsed document (key
// reorder + raw UTF-8). Staged contents are now conforming (invariants
// 18-20):
//   - ADD leg    → scopedSpliceSerialise over the task-list's parsed-ORIGINAL
//                  rawText (untouched records keep their exact bytes)
//   - REMOVE leg → escapeSerialise(removeResult.detected.data) (whole-file
//                  conforming, byte-compatible post-OQ-LS-2 — matches the
//                  CLI's whole-file deletes)

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

  const taskRecord = input.taskRecord;

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
  const insertResult = insertRecord(taskListLoad.detected, taskRecord);
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

  // ID-90 U2 budget gate — promote task leg, create mode (every budgeted
  // field of the promoted Task is freshly authored; first over-budget field
  // is fatal — invariant 25). `force` downgrades to a
  // `(forced) budget-exceeded:` warning (invariant 26).
  const budget = checkBudgetForCreate("task", taskRecord, {
    force: input.force === true,
  });
  if (!budget.ok) {
    return {
      ok: false,
      status: 422,
      error: budget.error,
      detail: budget.detail,
    };
  }
  // ID-90.12 U10 (invariant 41): ported disciplineWarnings, {35.30}-scoped
  // to the promoted Task (KH promote parity — the new task id), lead the
  // warnings envelope; budget soft-warns / forced downgrades follow.
  const warnings = [
    ...disciplineWarnings(insertResult.detected, {
      taskId: String(insertResult.recordId),
    }),
    ...budget.warnings,
  ];

  // ADD leg: splice the new Task into the parsed-ORIGINAL task-list text.
  // `insertRecord` above stays the validation oracle (duplicate-id +
  // document-level schema invariants); a splice failure after the oracle
  // passed is an internal inconsistency.
  const splicedTaskList = scopedSpliceSerialise(taskListLoad.rawText, {
    kind: "insert",
    collection: "tasks",
    record: taskRecord,
  });
  if (!splicedTaskList.ok) {
    return {
      ok: false,
      status: 500,
      error: "serialise-failed",
      detail: `scoped splice ${splicedTaskList.kind}${
        "detail" in splicedTaskList && splicedTaskList.detail
          ? `: ${splicedTaskList.detail}`
          : ""
      }`,
    };
  }
  const newTaskContent = splicedTaskList.text;
  // REMOVE leg: whole-file conforming re-emit of the post-removal backlog.
  const backlogContent = escapeSerialise(removeResult.detected.data);

  // ID-90 U3 pre-write gate chain, PER LEG at stage time on the EXACT bytes
  // about to land (invariants 22–23): task-list `+1` (the promoted Task),
  // backlog `−1` (the source item). A violation on ANY leg rejects the
  // whole transaction — nothing staged, nothing written.
  const taskListVerdict = runPreWriteGates(
    buildPreWriteGates({
      recordSet: {
        ledgerLabel: "task-list",
        beforeIds: beforeCollectionIds(taskListLoad.detected, {
          collection: "tasks",
        }),
        descriptor: { collection: "tasks" },
        expectedDelta: { kind: "add", id: insertResult.recordId },
      },
      // U4: prior on-disk bytes for THIS leg's document.
      clientName: {
        priorContent: taskListLoad.rawText,
        requireDenylist: input.requireDenylist,
      },
    }),
    // U10: the guard-side override arrives per request (invariant 33).
    {
      content: newTaskContent,
      options: { allowClientName: input.allowClientName === true },
    },
  );
  if (!taskListVerdict.ok) {
    return {
      ok: false,
      status: taskListVerdict.status,
      error: taskListVerdict.error,
      detail: taskListVerdict.detail,
    };
  }
  const backlogVerdict = runPreWriteGates(
    buildPreWriteGates({
      recordSet: {
        ledgerLabel: "backlog",
        beforeIds: beforeCollectionIds(backlogLoad.detected, {
          collection: "items",
        }),
        descriptor: { collection: "items" },
        expectedDelta: { kind: "remove", id: removeResult.recordId },
      },
      // U4: prior on-disk bytes for THIS leg's document.
      clientName: {
        priorContent: backlogLoad.rawText,
        requireDenylist: input.requireDenylist,
      },
    }),
    // U10: the guard-side override arrives per request (invariant 33).
    {
      content: backlogContent,
      options: { allowClientName: input.allowClientName === true },
    },
  );
  if (!backlogVerdict.ok) {
    return {
      ok: false,
      status: backlogVerdict.status,
      error: backlogVerdict.error,
      detail: backlogVerdict.detail,
    };
  }
  warnings.push(...taskListVerdict.warnings, ...backlogVerdict.warnings);

  // ── ID-90.12 U10 dryRun (invariant 16): the FULL validation + per-leg
  // gate chain ran above on each leg's exact would-be bytes. Return the
  // would-be result and STAGE NOTHING, RENAME NOTHING — no temps are ever
  // created, no mirror regen runs, no mtime changes. The reported mtimes
  // are the CURRENT (unchanged) on-disk values. ─────────────────────────────
  if (input.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      taskListMtime: taskListLoad.mtimeIso,
      backlogMtime: backlogLoad.mtimeIso,
      newTaskId: insertResult.recordId,
      removedBacklogId: removeResult.recordId,
      mirrorsWritten: [],
      mirrorsDeleted: [],
      warnings,
    };
  }

  // ── Phase 2: stage both legs (durable temps; originals untouched) ────────
  let stagedTaskList: StagedWrite | null = null;
  let stagedBacklog: StagedWrite | null = null;
  try {
    stagedTaskList = await stageAtomicWrite(input.taskListPath, newTaskContent);
    stagedBacklog = await stageAtomicWrite(input.backlogPath, backlogContent);
  } catch (err) {
    // Staging failed — discard any partial temp; all originals are pristine.
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
      // caller (and the test) observes the abort with all originals intact.
      await abortStagedWrite(stagedTaskList);
      await abortStagedWrite(stagedBacklog);
      throw err;
    }
  }

  // ── Phase 3: commit both legs. Renames are adjacent — NO await between
  // them so the residual window stays sub-microsecond. Order: task-list ADD
  // FIRST → backlog REMOVE LAST. A kill between renames yields AT WORST a
  // transient duplicate (Task present + backlog item still present), never
  // a lost update. The second rename is SYNC so no microtask/scheduler
  // yield can stretch the window after the first (async) rename resolves.
  // `faultBetweenCommits` (test-only, sync) fires after the ADD rename. ────
  try {
    await commitStagedWrite(stagedTaskList); // ADD side first
    if (input.faultBetweenCommits) input.faultBetweenCommits();
    commitStagedWriteSync(stagedBacklog); // REMOVE side LAST — sync
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
  // ID-90.12 U10 regenMirrors:false — skip the regen entirely and REPORT it
  // on the result (`mirrorRegen: "suppressed"`).
  const regenSuppressed = input.regenMirrors === false;
  const mirrorsWritten: string[] = [];
  const mirrorsDeleted: string[] = [];
  if (regenSuppressed) {
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
      warnings,
      mirrorRegen: "suppressed",
    };
  }
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
    warnings,
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
