/**
 * gates/budget-gate.ts — ID-90 U2 server-side write-time budget gate.
 *
 * Port of the KH ledger-CLI budget pre-check (`checkBudget` +
 * `graphemeLength`/`GRAPHEME_SEGMENTER`, scripts/ledger-cli.ts — ID-35.17/
 * 35.26/35.27/35.31) onto the patch-server's mutation handlers. The registry
 * is the U0-relocated plain-data `LEDGER_BUDGETS` (PRODUCT invariant 24 —
 * never a Zod `.max()`; the live over-budget ledger keeps parsing).
 *
 * Hook point: POST-MUTATION / PRE-SERIALISATION — after the Zod oracle
 * (applyPatches / insertRecord) has accepted the in-memory mutation, before
 * any byte is produced for the write path. Over-budget → reject
 * (`budget-exceeded`, nothing written); `force` downgrades the rejection to
 * a `(forced) budget-exceeded:` warning and proceeds (invariant 26 — strictly
 * per-invocation; the option is plumbed per-request, never stored).
 *
 * Mode semantics (invariant 25, matching the CLI's `mutatedField` exactly):
 *   - PATCH (field-update): each patched field is a mutated field and can
 *     HARD-REJECT; untouched over-budget budgeted fields surface as
 *     `budget (untouched):` soft warnings (the operator never edited them).
 *   - Create (POST record / future subtask add / promote task leg): every
 *     budgeted field is freshly authored → FIRST over-budget field is fatal.
 *
 * `subtask.details` is intentionally absent from the registry → exempt on
 * every path (invariant 27 — the append-only journal home).
 *
 * ID-148.10 (Option C — repurposed roadmap arm, INV-13): the `initiatives`
 * kind carries TWO addressable node shapes instead of the retired roadmap
 * arm's one (`theme`) — `project` (addressed by globally-unique slug,
 * `LEDGER_BUDGETS.project`) and `initiative` (addressed by dotted path,
 * `LEDGER_BUDGETS.initiative`). `resolvePatchTarget`'s initiatives branch
 * below tree-walks via `initiatives-tree.ts` to resolve either shape from a
 * FieldPath — the SAME tree-walk primitive the mutate/patch/serialise arms
 * use, so this gate can never drift on where a project/initiative lives.
 */

import {
  LEDGER_BUDGETS,
  type LedgerRecordKind,
} from "@task-view/schemas/ledger-budgets";
import type { TaskList } from "@task-view/schemas/task-list";
import type { InitiativesDocument } from "@task-view/schemas/initiatives";
import type { BacklogDocument } from "@task-view/schemas/backlog";
import type { RetrosDocument } from "@task-view/schemas/retro";
import type { FieldPatch } from "../patch-apply";
import type { CreateRecordKind } from "../record-mutate";
import {
  findProjectBySlug,
  resolveInitiativeNode,
  type TreeDoc,
} from "../initiatives-tree";

// ── Grapheme counting (invariant 24 / ID-35.31) ──────────────────────────────

/**
 * Count user-perceived characters (graphemes), not UTF-16 code units.
 *
 * `value.length` returns the UTF-16 code-unit count, which diverges from
 * what the operator sees for any non-BMP glyph: a single emoji like 🎯 is
 * 1 grapheme but 2 code units (surrogate pair). The operator's intuition is
 * "graphemes", so all budget sites standardise on `Intl.Segmenter`. The
 * segmenter is module-hoisted so each call reuses one instance.
 */
const GRAPHEME_SEGMENTER = new Intl.Segmenter("en", {
  granularity: "grapheme",
});

export function graphemeLength(value: string): number {
  return [...GRAPHEME_SEGMENTER.segment(value)].length;
}

// ── Gate core (faithful port of the CLI `checkBudget`) ───────────────────────

/**
 * Budget-gate inputs for the single CHANGED record of a write: which registry
 * record-kind to budget against, the record id (for the message), and the
 * post-mutation record object whose budgeted fields are measured.
 *
 * `mutatedField` (when set) names the single field this write touches —
 * the gate then REJECTS only on that field and surfaces any over-budget
 * UNTOUCHED budgeted fields as soft warnings. When `mutatedField` is
 * undefined (create / add / promote — every budgeted field is freshly
 * authored), the gate keeps the "reject on the first over-budget field"
 * semantics.
 *
 * NOTE vs the CLI original: the unused `ledger: LedgerName` member is
 * dropped — the server derives everything from `recordKind`.
 */
export interface BudgetGate {
  recordKind: LedgerRecordKind;
  recordId: string | number;
  record: Record<string, unknown>;
  /** When set, only this field can REJECT; other over-budget fields warn. */
  mutatedField?: string;
  /**
   * Parent task id for subtask records — labels the budget-exceeded message
   * as `subtask <parentId>.<recordId>` (e.g. `subtask 49.6`) instead of the
   * misleading `task <recordId>` (ID-35.27). Ignored for non-subtask kinds.
   */
  parentId?: string | number;
}

/**
 * Format the subject suffix of the budget-exceeded detail line so the
 * operator sees the RIGHT record-kind label and identifier (ID-35.27).
 */
function budgetSubject(gate: Pick<BudgetGate, "recordKind" | "recordId" | "parentId">): string {
  switch (gate.recordKind) {
    case "subtask":
      return gate.parentId !== undefined
        ? `subtask ${gate.parentId}.${gate.recordId}`
        : `subtask ${gate.recordId}`;
    case "task":
      return `task ${gate.recordId}`;
    // ID-148.10: repurposed from the retired "theme" case — the two
    // initiatives node shapes.
    case "project":
      return `project ${gate.recordId}`;
    case "initiative":
      return `initiative ${gate.recordId}`;
    case "item":
      return `item ${gate.recordId}`;
    case "retro":
      return `retro ${gate.recordId}`;
    default: {
      // Exhaustiveness guard: a future addition to `LedgerRecordKind` becomes
      // a compile-time error here; the runtime fallback keeps the message
      // intelligible if the assertion is ever bypassed.
      const _exhaustive: never = gate.recordKind;
      return `${String(_exhaustive)} ${gate.recordId}`;
    }
  }
}

export type CheckBudgetResult =
  | { ok: true; warnings: string[] }
  | { ok: false; detail: string; warnings: string[] };

/**
 * Generalised core sweep: measure every budgeted field of `record` against
 * the registry. Fields named in `mutatedFields` can HARD-REJECT (first
 * violation in registry order is fatal); other over-budget fields soft-warn.
 * `mutatedFields === undefined` is create mode — EVERY field is treated as
 * freshly authored and the first over-budget field is fatal with no
 * warnings (matching the CLI's original ID-35.17 semantics).
 */
function sweepRecordBudgets(
  gate: Omit<BudgetGate, "mutatedField">,
  mutatedFields: ReadonlySet<string> | undefined,
): CheckBudgetResult {
  if (!gate.record || typeof gate.record !== "object")
    return { ok: true, warnings: [] };
  const budgets = LEDGER_BUDGETS[gate.recordKind] as Record<string, number>;
  const warnings: string[] = [];
  // ID-90.12 U10 (check-90-7 annotation): enumerate ALL over-budget mutated
  // fields rather than keeping only the first — subsequent mutated violations
  // were previously dropped from the detail string.
  const mutatedViolations: string[] = [];
  for (const [field, budget] of Object.entries(budgets)) {
    const value = gate.record[field];
    if (typeof value !== "string") continue;
    // Grapheme count (what the operator sees), not UTF-16 code units.
    const length = graphemeLength(value);
    if (length <= budget) continue;
    // Surface the `(over by N)` delta so the operator can trim with
    // precision instead of running the arithmetic themselves.
    const overBy = length - budget;
    // ID-90 F5/Bug1: append a remedy clause so the operator knows HOW to
    // resolve the rejection, not just that it happened. `subtask.details` is
    // the unbudgeted append-only journal home (invariant 27), so overflow
    // prose belongs there; `--force` is the per-invocation override (inv 26).
    const remedy =
      gate.recordKind === "subtask"
        ? ` — trim it to ${budget} chars, or move the overflow prose into the unbudgeted \`details\` field (or pass --force to override this gate)`
        : ` — trim it to ${budget} chars (or pass --force to override this gate)`;
    const line = `${field} is ${length} chars (budget ${budget}, over by ${overBy}) on ${budgetSubject(gate)}${remedy}`;
    if (mutatedFields === undefined) {
      // Create / add / promote — first over-budget field is fatal.
      return { ok: false, detail: line, warnings: [] };
    }
    if (mutatedFields.has(field)) {
      mutatedViolations.push(line);
    } else {
      // Untouched over-budget field — soft warning, never a rejection
      // (the ID-35.26 untouched-field discipline escape).
      warnings.push(`budget (untouched): ${line}`);
    }
  }
  if (mutatedViolations.length > 0)
    return { ok: false, detail: mutatedViolations.join("; "), warnings };
  return { ok: true, warnings };
}

/**
 * Check the changed record's budgeted fields against `LEDGER_BUDGETS`.
 * CLI-parity surface: single optional `mutatedField` (see {@link BudgetGate}).
 */
export function checkBudget(gate: BudgetGate): CheckBudgetResult {
  return sweepRecordBudgets(
    gate,
    gate.mutatedField === undefined ? undefined : new Set([gate.mutatedField]),
  );
}

// ── Server hook adapters ──────────────────────────────────────────────────────

/** Per-request gate options. `force` arrives as a request-body field in the
 * U10 envelope extension (record 12); until then handlers pass the default.
 * Force is strictly per-invocation (invariant 26) — never stored. */
export interface BudgetGateOptions {
  force?: boolean;
}

export type BudgetGateOutcome =
  | { ok: true; warnings: string[] }
  | { ok: false; error: "budget-exceeded"; detail: string; warnings: string[] };

function applyForce(
  result: CheckBudgetResult,
  options: BudgetGateOptions,
): BudgetGateOutcome {
  if (result.ok) return { ok: true, warnings: result.warnings };
  if (options.force === true) {
    return {
      ok: true,
      warnings: [
        `(forced) budget-exceeded: ${result.detail}`,
        ...result.warnings,
      ],
    };
  }
  return {
    ok: false,
    error: "budget-exceeded",
    detail: result.detail,
    warnings: result.warnings,
  };
}

/** ID-148.10: repurposed roadmap arm — `initiatives` replaces `roadmap`;
 * `umbrellas` is fully retired (no fifth kind). */
type KnownKind = "task-list" | "initiatives" | "backlog" | "retro";

/** A patch resolved to the record it mutates + the leaf field it touches. */
interface ResolvedPatchTarget {
  /** Stable grouping key: one gate sweep per touched record. */
  key: string;
  gate: Omit<BudgetGate, "mutatedField">;
  mutatedField: string;
}

/**
 * Resolve a FieldPatch to the record it mutates within the POST-MUTATION
 * parsed snapshot. Returns null when the path does not address a record
 * field this gate budgets (defensive — the patch walk has already validated
 * the path before the gate runs; an unresolvable path here is simply not
 * budgeted, never an error).
 */
function resolvePatchTarget(
  kind: KnownKind,
  data: TaskList | InitiativesDocument | BacklogDocument | RetrosDocument,
  patch: FieldPatch,
): ResolvedPatchTarget | null {
  const p = patch.fieldPath;
  // WS-C C2: the retro registry entry is empty (append-only narrative) — no
  // retro field is budgeted, so a retro patch resolves to no gate target.
  if (kind === "retro") return null;
  if (kind === "task-list") {
    const tasks = (data as TaskList).tasks;
    if (p[0] !== "tasks" || p.length < 3) return null;
    const task = tasks.find((t) => t.id === p[1]);
    if (!task) return null;
    if (p.length === 3) {
      return {
        key: `task:${task.id}`,
        gate: {
          recordKind: "task",
          recordId: task.id,
          record: task as unknown as Record<string, unknown>,
        },
        mutatedField: p[2],
      };
    }
    if (p.length === 5 && p[2] === "subtasks") {
      const subId = p[3];
      const subtask = task.subtasks.find((s) => s.id === subId);
      if (!subtask) return null;
      return {
        key: `subtask:${task.id}.${subtask.id}`,
        gate: {
          recordKind: "subtask",
          recordId: subtask.id,
          parentId: task.id,
          record: subtask as unknown as Record<string, unknown>,
        },
        mutatedField: p[4],
      };
    }
    return null;
  }
  // ID-148.10: repurposed roadmap arm — TWO addressable shapes, tree-walked
  // via initiatives-tree.ts (INV-13).
  if (kind === "initiatives") {
    if ((p[0] !== "projects" && p[0] !== "initiatives") || p.length !== 3) {
      return null;
    }
    const doc = data as unknown as TreeDoc;
    if (p[0] === "projects") {
      const located = findProjectBySlug(doc, p[1]);
      if (!located) return null;
      return {
        key: `project:${located.project.id}`,
        gate: {
          recordKind: "project",
          recordId: located.project.id as string,
          record: located.project,
        },
        mutatedField: p[2],
      };
    }
    const node = resolveInitiativeNode(doc, p[1]);
    if (!node) return null;
    return {
      key: `initiative:${p[1]}`,
      gate: {
        recordKind: "initiative",
        recordId: p[1],
        record: node as unknown as Record<string, unknown>,
      },
      mutatedField: p[2],
    };
  }
  // backlog
  if (p[0] !== "items" || p.length !== 3) return null;
  const item = (data as BacklogDocument).items.find((it) => it.id === p[1]);
  if (!item) return null;
  return {
    key: `item:${item.id}`,
    gate: {
      recordKind: "item",
      recordId: item.id,
      record: item as unknown as Record<string, unknown>,
    },
    mutatedField: p[2],
  };
}

/**
 * PATCH-hook entry point (post-mutation / pre-serialisation).
 *
 * Each patched field is a mutated field on its record (invariant 25): it can
 * hard-reject. Untouched over-budget budgeted fields on the touched records
 * soft-warn. Patches are grouped per record so a field mutated by a SIBLING
 * patch in the same batch is hard-checked exactly once — never additionally
 * reported as `budget (untouched)`.
 *
 * The snapshot passed in MUST be the post-mutation parsed document (the
 * applyPatches oracle output) so measured values are the values about to be
 * serialised. ID-148.10: this is also how the initiatives "atomic move"
 * 2-patch batch is budgeted — it groups by record key, so the source and
 * target project of a move are swept independently within the same call.
 */
export function checkBudgetForPatches(
  kind: KnownKind,
  data: TaskList | InitiativesDocument | BacklogDocument | RetrosDocument,
  patches: readonly FieldPatch[],
  options: BudgetGateOptions = {},
): BudgetGateOutcome {
  // Group the batch per touched record: one sweep per record, with the
  // record's full mutated-field set.
  const groups = new Map<
    string,
    { gate: Omit<BudgetGate, "mutatedField">; mutatedFields: Set<string> }
  >();
  for (const patch of patches) {
    const target = resolvePatchTarget(kind, data, patch);
    if (!target) continue;
    const existing = groups.get(target.key);
    if (existing) existing.mutatedFields.add(target.mutatedField);
    else
      groups.set(target.key, {
        gate: target.gate,
        mutatedFields: new Set([target.mutatedField]),
      });
  }

  const warnings: string[] = [];
  // ID-90.12 U10 (check-90-7 annotation): enumerate violations across ALL
  // touched records in the batch, not just the first failing record.
  const violationDetails: string[] = [];
  for (const { gate, mutatedFields } of groups.values()) {
    const result = sweepRecordBudgets(gate, mutatedFields);
    if (!result.ok) violationDetails.push(result.detail);
    warnings.push(...result.warnings);
  }

  const merged: CheckBudgetResult =
    violationDetails.length > 0
      ? { ok: false, detail: violationDetails.join("; "), warnings }
      : { ok: true, warnings };
  return applyForce(merged, options);
}

/**
 * Create-hook entry point (POST record / promote task leg / future bulk
 * subtask add — invariant 25 create mode): every budgeted field is freshly
 * authored, first over-budget field is fatal. `parentId` labels subtask
 * records (`subtask <parent>.<id>`).
 */
export function checkBudgetForCreate(
  recordKind: LedgerRecordKind,
  record: unknown,
  options: BudgetGateOptions = {},
  parentId?: string | number,
): BudgetGateOutcome {
  if (record == null || typeof record !== "object") {
    return { ok: true, warnings: [] };
  }
  const rec = record as Record<string, unknown>;
  const id = rec.id;
  const recordId =
    typeof id === "string" || typeof id === "number" ? id : "<unknown>";
  const result = sweepRecordBudgets(
    { recordKind, recordId, parentId, record: rec },
    undefined,
  );
  return applyForce(result, options);
}

/** Map a detected document kind to the registry record-kind a whole-record
 * CREATE on that ledger budgets against. ID-148.10: `initiatives` always
 * creates a `project` (INV-13 — only projects are whole-record-created via
 * this generic path; initiatives/sub-initiatives are not). Return type is
 * `CreateRecordKind` (the strict subset of `LedgerRecordKind` this function
 * ever actually returns) — it feeds `withCreateDefaults` directly at the
 * sole call site (`patch-server.ts`), which requires that narrower type. */
export function createRecordKindFor(kind: KnownKind): CreateRecordKind {
  if (kind === "task-list") return "task";
  if (kind === "initiatives") return "project";
  // WS-C C2: retro creates budget against the empty `retro` registry entry
  // (no field is measured — the sweep always passes).
  if (kind === "retro") return "retro";
  return "item";
}
