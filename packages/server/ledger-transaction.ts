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
 * ── ID-90 U7: optional capability-theme THIRD leg ──────────────────────────
 *
 * `capabilityTheme?: {roadmapPath, roadmapBaseMtime, themeId}` extends the
 * transaction with a roadmap link leg: `task.capability_theme` is bound on
 * the inserted record and the new task id is pushed onto the named theme's
 * `linked_tasks[]` (IDEMPOTENT — already-linked stages the unchanged
 * original text). Everything above generalises from two legs to three:
 * validate-first (an unknown theme rejects with 422 `unknown-theme` and
 * NOTHING staged — PRODUCT invariant 40), three staged temps, and the
 * commit order task-list (ADD) → roadmap (idempotent link) → backlog
 * (REMOVE) — additive first, removal LAST, preserving the
 * benign-transient-duplicate property (a kill between renames leaves the
 * Task present + the backlog item still present, possibly an un-linked
 * theme — all recoverable; never a lost record). The record-set gate +
 * client-name guard run per leg at stage time on each leg's exact bytes
 * (roadmap delta `none`). `faultBetweenCommits` (test-only, sync) fires
 * after the ADD rename to prove the ordering property; record 13 extends
 * the seam.
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
import {
  escapeSerialise,
  scopedSerialise,
  scopedSpliceSerialise,
} from "./scoped-serialise";
import { applyRoadmapPatches } from "./patch-apply";
import { insertRecord, removeRecord } from "./record-mutate";
import { disciplineWarnings } from "./discipline-warnings";
import { checkBudgetForCreate } from "./gates/budget-gate";
import { beforeCollectionIds } from "./gates/record-set-gate";
import { buildPreWriteGates, runPreWriteGates } from "./gates/gate-chain";
import { generateRecordMirror, generateMirrors } from "./mirror-generator";
import type { Roadmap } from "@task-view/schemas/roadmap";
import { ZodError } from "zod";

type KnownDetected = Exclude<DetectSchemaResult, { kind: "unknown" }>;

/**
 * Optional fault-injection seam. Fires AFTER both writes are staged
 * (durable temps) and BEFORE the first commit rename. A test passes a
 * function that throws to simulate a process kill at the pre-commit point.
 * Production callers never pass this.
 */
export type PreCommitFault = () => void | Promise<void>;

/**
 * ID-90 U7: the optional capability-theme third leg. When present, the
 * promoted Task is bound to a roadmap theme: `task.capability_theme` is set
 * on the record AND the new task id is pushed onto the named theme's
 * `linked_tasks[]` (idempotent — a re-run can never duplicate the entry).
 * Pre-stage validation rejects an unknown theme id with `422 unknown-theme`
 * BEFORE anything is staged (PRODUCT invariant 40).
 */
export interface CapabilityThemeLeg {
  /** Path to the product-roadmap.json ledger (the LINK side). */
  roadmapPath: string;
  /** Client's last-seen roadmap mtime (ISO 8601). */
  roadmapBaseMtime: string;
  /** Roadmap theme id the promoted Task binds to. */
  themeId: string;
}

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
  /** ID-90 U7: optional capability-theme third leg (roadmap link). */
  capabilityTheme?: CapabilityThemeLeg;
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
   * ID-90.12 U10 (PRODUCT invariant 16): run the FULL three-leg validation
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
   * Test-only (ID-90 U7; record 13 extends): SYNC fault fired BETWEEN the
   * commit renames — after the ADD-side rename, before the link/REMOVE-side
   * renames. Lets the fault-injection suite prove the additive-first /
   * removal-last ordering: a kill there leaves AT WORST a benign transient
   * duplicate (Task present + backlog item still present), never a lost
   * record. Deliberately synchronous — the seam must not introduce an
   * awaited yield between the adjacent renames.
   */
  faultBetweenCommits?: () => void;
  /**
   * Test-only (ID-90.13 U11; check-90-10 K5 annotation — crash-point 2):
   * SYNC fault fired AFTER the roadmap link rename, before the backlog
   * REMOVE-side rename. Proves the second residual window of the three-leg
   * ordering: a kill there leaves the Task present AND the theme linked
   * with the backlog item still present — again a benign, self-healing
   * transient duplicate, never a lost record. Synchronous for the same
   * reason as `faultBetweenCommits`.
   */
  faultAfterLinkCommit?: () => void;
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
      /** ID-90 U7: post-commit roadmap mtime — present when the
       * capability-theme leg was bound. */
      roadmapMtime?: string;
      /** ID-90 U7: the bound theme id — present when the leg was bound, so
       * callers can confirm the roadmap-side link landed (or no-op'd —
       * idempotent). */
      boundCapabilityTheme?: string;
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
    // ledger-parse-failed shape above; redaction-safe summary only (issue
    // count + first issue path) — never the verbatim issues, which can embed
    // document content.
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
        error: "ledger-schema-invalid",
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
//   - roadmap link leg (U7 third leg — landed at record 10)
//                  → scopedSerialise over the roadmap's rawText (idempotent
//                    no-op stages the unchanged original text verbatim).

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

  // ── ID-90 U7: capability-theme third leg — validate-first (invariant 40).
  let taskRecord = input.taskRecord;
  if (input.capabilityTheme) {
    if (!Number.isFinite(Date.parse(input.capabilityTheme.roadmapBaseMtime))) {
      return {
        ok: false,
        status: 400,
        error: "invalid-baseMtime",
        detail: "roadmapBaseMtime",
      };
    }
    if (
      taskRecord === null ||
      typeof taskRecord !== "object" ||
      Array.isArray(taskRecord)
    ) {
      return {
        ok: false,
        status: 422,
        error: "invalid-task-json",
        detail: "taskRecord must be a JSON object for capability-theme binding",
      };
    }
    // Bind BEFORE the insertRecord oracle so the `capability_theme`
    // back-link field round-trips through Zod like any caller-supplied
    // field (KH ledger-cli promote parity). Shallow copy — the caller's
    // object is never mutated.
    taskRecord = {
      ...(taskRecord as Record<string, unknown>),
      capability_theme: input.capabilityTheme.themeId,
    };
  }

  const taskListLoad = await loadLedger(input.taskListPath, "task-list");
  if ("error" in taskListLoad) return taskListLoad.error;
  const backlogLoad = await loadLedger(input.backlogPath, "backlog");
  if ("error" in backlogLoad) return backlogLoad.error;
  // U7: the roadmap is only loaded + validated when the caller opts into
  // capability-theme binding (preserves the two-ledger residual-window
  // discipline when the leg is absent).
  let roadmapLoad: LoadedLedger | null = null;
  if (input.capabilityTheme) {
    const loaded = await loadLedger(input.capabilityTheme.roadmapPath, "roadmap");
    if ("error" in loaded) return loaded.error;
    roadmapLoad = loaded;
  }

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
  if (
    input.capabilityTheme &&
    roadmapLoad &&
    mtimeStale(input.capabilityTheme.roadmapBaseMtime, roadmapLoad.mtimeIso)
  ) {
    return {
      ok: false,
      status: 409,
      error: "mtime-mismatch",
      detail: `roadmap changed underneath you (current ${roadmapLoad.mtimeIso})`,
    };
  }

  // U7 pre-stage validation: an unknown theme id rejects the WHOLE
  // transaction with 422 `unknown-theme` — NOTHING staged, nothing written
  // (PRODUCT invariant 40).
  if (
    input.capabilityTheme &&
    roadmapLoad &&
    roadmapLoad.detected.kind === "roadmap"
  ) {
    const themeExists = roadmapLoad.detected.data.themes.some(
      (t) => t.id === input.capabilityTheme!.themeId,
    );
    if (!themeExists) {
      return {
        ok: false,
        status: 422,
        error: "unknown-theme",
        detail: `capability theme ${input.capabilityTheme.themeId}: no theme with that id in roadmap`,
      };
    }
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

  // U7 LINK leg: the change is a FieldPatch on ONE theme's linked_tasks[]
  // (NOT a record splice) — `scopedSerialise` over the roadmap's
  // parsed-ORIGINAL rawText. The push is IDEMPOTENT: an already-linked
  // theme stages the UNCHANGED original text (a no-op rewrite — KH
  // ledger-cli parity), so a re-run can never duplicate the entry.
  let roadmapContent: string | null = null;
  let roadmapLinkedData: Roadmap | null = null; // post-link snapshot (mirror regen)
  if (
    input.capabilityTheme &&
    roadmapLoad &&
    roadmapLoad.detected.kind === "roadmap"
  ) {
    const themeId = input.capabilityTheme.themeId;
    // Theme presence was validated in Phase 1.
    const theme = roadmapLoad.detected.data.themes.find(
      (t) => t.id === themeId,
    );
    const newTaskIdStr = String(insertResult.recordId);
    if (theme && theme.linked_tasks.includes(newTaskIdStr)) {
      roadmapContent = roadmapLoad.rawText;
    } else {
      const nextLinked = [...(theme ? theme.linked_tasks : []), newTaskIdStr];
      const linkPatch = {
        fieldPath: ["themes", themeId, "linked_tasks"],
        newValue: nextLinked,
      };
      // Validation oracle (parallel to insertRecord/removeRecord on the
      // sibling legs): apply the patch to a CLONE of the typed snapshot and
      // Zod re-parse the whole document. The bytes WRITTEN come from the
      // parsed-original scopedSerialise below, never from this snapshot.
      const oracle = applyRoadmapPatches(
        structuredClone(roadmapLoad.detected.data),
        [linkPatch],
      );
      if (!oracle.ok) {
        if (oracle.kind === "schema-error") {
          return {
            ok: false,
            status: 422,
            error: "schema-error",
            issues: oracle.zodError.issues,
          };
        }
        return {
          ok: false,
          status: 500,
          error: "serialise-failed",
          detail: `roadmap link oracle ${oracle.kind}${
            "detail" in oracle && oracle.detail ? `: ${oracle.detail}` : ""
          }`,
        };
      }
      roadmapLinkedData = oracle.parsed;
      const rmScoped = scopedSerialise(roadmapLoad.rawText, linkPatch);
      if (!rmScoped.ok) {
        return {
          ok: false,
          status: 500,
          error: "serialise-failed",
          detail: `roadmap scoped serialise ${rmScoped.kind}${
            "detail" in rmScoped && rmScoped.detail ? `: ${rmScoped.detail}` : ""
          }`,
        };
      }
      roadmapContent = rmScoped.text;
    }
  }

  // ID-90 U3 pre-write gate chain, PER LEG at stage time on the EXACT bytes
  // about to land (invariants 22–23): task-list `+1` (the promoted Task),
  // backlog `−1` (the source item), roadmap `∅` (U7 capability-theme link —
  // the theme id-set is unchanged). A violation on ANY leg rejects the
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
  // U7: the LINK leg runs the same gate chain at stage time on its exact
  // bytes — record-set delta `none` (the theme id-set is unchanged; only
  // one theme's linked_tasks[] grew) + the client-name guard with the
  // roadmap's prior bytes (invariants 22-23, 28).
  let roadmapVerdictWarnings: string[] = [];
  if (roadmapLoad && roadmapContent !== null) {
    const roadmapVerdict = runPreWriteGates(
      buildPreWriteGates({
        recordSet: {
          ledgerLabel: "roadmap",
          beforeIds: beforeCollectionIds(roadmapLoad.detected, {
            collection: "themes",
          }),
          descriptor: { collection: "themes" },
          expectedDelta: { kind: "none" },
        },
        // U4: prior on-disk bytes for THIS leg's document.
        clientName: {
          priorContent: roadmapLoad.rawText,
          requireDenylist: input.requireDenylist,
        },
      }),
      // U10: the guard-side override arrives per request (invariant 33).
      {
        content: roadmapContent,
        options: { allowClientName: input.allowClientName === true },
      },
    );
    if (!roadmapVerdict.ok) {
      return {
        ok: false,
        status: roadmapVerdict.status,
        error: roadmapVerdict.error,
        detail: roadmapVerdict.detail,
      };
    }
    roadmapVerdictWarnings = roadmapVerdict.warnings;
  }
  warnings.push(
    ...taskListVerdict.warnings,
    ...backlogVerdict.warnings,
    ...roadmapVerdictWarnings,
  );

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
      ...(input.capabilityTheme && roadmapLoad
        ? {
            roadmapMtime: roadmapLoad.mtimeIso,
            boundCapabilityTheme: input.capabilityTheme.themeId,
          }
        : {}),
    };
  }

  // ── Phase 2: stage all bound legs (durable temps; originals untouched) ───
  let stagedTaskList: StagedWrite | null = null;
  let stagedBacklog: StagedWrite | null = null;
  let stagedRoadmap: StagedWrite | null = null;
  try {
    stagedTaskList = await stageAtomicWrite(input.taskListPath, newTaskContent);
    stagedBacklog = await stageAtomicWrite(input.backlogPath, backlogContent);
    if (input.capabilityTheme && roadmapContent !== null) {
      stagedRoadmap = await stageAtomicWrite(
        input.capabilityTheme.roadmapPath,
        roadmapContent,
      );
    }
  } catch (err) {
    // Staging failed — discard any partial temp; all originals are pristine.
    if (stagedTaskList) await abortStagedWrite(stagedTaskList);
    if (stagedBacklog) await abortStagedWrite(stagedBacklog);
    if (stagedRoadmap) await abortStagedWrite(stagedRoadmap);
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
      if (stagedRoadmap) await abortStagedWrite(stagedRoadmap);
      throw err;
    }
  }

  // ── Phase 3: commit all bound legs. Renames are adjacent — NO await
  // between them so the residual window stays sub-microsecond. Order (U7 —
  // additive first, removal LAST): task-list ADD → roadmap idempotent link →
  // backlog REMOVE. A kill anywhere between renames yields AT WORST a
  // transient duplicate (Task present + backlog item still present — and
  // possibly an un-linked theme, recoverable by a re-run), never a lost
  // update. The link + removal renames are SYNC so no microtask/scheduler
  // yield can stretch the window after the first (async) rename resolves.
  // `faultBetweenCommits` (test-only, sync) fires after the ADD rename. ────
  try {
    await commitStagedWrite(stagedTaskList); // ADD side first
    if (input.faultBetweenCommits) input.faultBetweenCommits();
    if (stagedRoadmap) commitStagedWriteSync(stagedRoadmap); // link leg — sync
    if (input.faultAfterLinkCommit) input.faultAfterLinkCommit(); // crash-point 2
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
      ...(input.capabilityTheme
        ? {
            roadmapMtime: (
              await stat(input.capabilityTheme.roadmapPath)
            ).mtime.toISOString(),
            boundCapabilityTheme: input.capabilityTheme.themeId,
          }
        : {}),
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
    // U7: the linked theme's mirror changed too (its linked_tasks[] line) —
    // scoped single-record regen. Skipped on the idempotent no-op (the
    // theme's mirror is already current).
    if (input.capabilityTheme && roadmapLinkedData) {
      const themeMirror = await generateRecordMirror(
        { kind: "roadmap", data: roadmapLinkedData },
        input.capabilityTheme.roadmapPath,
        input.capabilityTheme.themeId,
      );
      mirrorsWritten.push(...themeMirror.written);
    }
  } catch {
    // Mirror regen is derived state; a failure here does not invalidate the
    // committed canonicals. The client can re-issue a regen request.
  }

  const taskListMtime = (await stat(input.taskListPath)).mtime.toISOString();
  const backlogMtime = (await stat(input.backlogPath)).mtime.toISOString();
  const roadmapMtime = input.capabilityTheme
    ? (await stat(input.capabilityTheme.roadmapPath)).mtime.toISOString()
    : undefined;

  return {
    ok: true,
    taskListMtime,
    backlogMtime,
    newTaskId: insertResult.recordId,
    removedBacklogId: removeResult.recordId,
    mirrorsWritten,
    mirrorsDeleted,
    warnings,
    ...(input.capabilityTheme
      ? {
          roadmapMtime,
          boundCapabilityTheme: input.capabilityTheme.themeId,
        }
      : {}),
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
