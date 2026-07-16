/**
 * gates/status-enum-gate.ts — TECH §2 INV-3 server-side strict-write status
 * enum gate (initiatives kind only).
 *
 * `initiatives-schema.ts` types every `status` field as `z.string()` —
 * lenient read (INV-2), so `GET`/list can parse the current, imperfect
 * `initiatives.json` with no clean-data precondition. A mutation that SETS
 * `status` must re-validate against `PROJECT_STATUSES` / `INITIATIVE_STATUSES`
 * at the server strict-write gate — this module IS that gate. Same hook
 * point + idiom as `gates/budget-gate.ts` (post-mutation / pre-serialisation,
 * called from `patch-server.ts` alongside `checkBudgetForPatches` /
 * `checkBudgetForCreate`): resolve the touched record off the ALREADY-
 * MUTATED snapshot, check its value, reject with a clean 4xx envelope
 * before any byte is produced.
 *
 * `task-list` / `backlog` / `retro` status fields are unaffected — their
 * schemas already Zod-`.enum()` (or otherwise hard-validate) `status` in
 * the final `.parse()` inside `applyPatches`/`insertRecord`, so an
 * out-of-enum value there is already rejected as a `schema-error` before
 * this gate would ever run. This gate is therefore a no-op for every kind
 * except `initiatives`.
 */

import {
  INITIATIVE_STATUSES,
  PROJECT_STATUSES,
  type InitiativesDocument,
} from "@task-view/schemas/initiatives";
import type { FieldPatch } from "../patch-apply";
import type { CreateRecordKind } from "../record-mutate";
import {
  findProjectBySlug,
  resolveInitiativeNode,
  type TreeDoc,
} from "../initiatives-tree";

/** The two initiatives node shapes this gate distinguishes — each carries
 * its own status vocabulary (`initiatives-schema.ts`). */
type StatusNodeKind = "project" | "initiative";

function allowedStatuses(nodeKind: StatusNodeKind): readonly string[] {
  return nodeKind === "project" ? PROJECT_STATUSES : INITIATIVE_STATUSES;
}

export type StatusEnumGateOutcome =
  | { ok: true }
  | { ok: false; error: "invalid-status"; detail: string };

function invalidStatusOutcome(
  nodeKind: StatusNodeKind,
  value: unknown,
): StatusEnumGateOutcome {
  const allowed = allowedStatuses(nodeKind);
  return {
    ok: false,
    error: "invalid-status",
    detail: `status ${JSON.stringify(value)} is not a valid ${nodeKind} status; expected one of: ${allowed.join(", ")}.`,
  };
}

function isValidStatus(nodeKind: StatusNodeKind, value: unknown): boolean {
  return typeof value === "string" && allowedStatuses(nodeKind).includes(value);
}

/**
 * Resolve which node kind + CURRENT (post-mutation) status value a `status`
 * FieldPatch touches. Returns `null` for any patch this gate does not care
 * about (non-status field, or a path that fails to resolve — the walk-error
 * for that case was already surfaced earlier in the PATCH pipeline by
 * `applyPatches`, so an unresolvable path here simply means "not this
 * gate's concern").
 *
 * Reads the value off the ALREADY-MUTATED `data` snapshot rather than the
 * raw patch's `newValue` so BOTH patch ops (`newValue` replace and
 * `appendText` concatenate) are covered uniformly — an append onto `status`
 * is nonsensical and will almost always fail the enum check too, with no
 * special-casing needed here.
 */
function resolveStatusTarget(
  data: InitiativesDocument,
  patch: FieldPatch,
): { nodeKind: StatusNodeKind; status: unknown } | null {
  const p = patch.fieldPath;
  if (p.length !== 3 || p[2] !== "status") return null;
  if (p[0] !== "projects" && p[0] !== "initiatives") return null;
  const doc = data as unknown as TreeDoc;
  if (p[0] === "projects") {
    const located = findProjectBySlug(doc, p[1]);
    if (!located) return null;
    return {
      nodeKind: "project",
      status: (located.project as { status?: unknown }).status,
    };
  }
  const node = resolveInitiativeNode(doc, p[1]);
  if (!node) return null;
  return { nodeKind: "initiative", status: (node as { status?: unknown }).status };
}

/**
 * PATCH-hook entry point (post-mutation / pre-serialisation) — call
 * alongside `checkBudgetForPatches` with the SAME `applyResult.parsed`
 * snapshot and `patches` batch. Only the `initiatives` kind is ever
 * checked; every other kind returns `{ ok: true }` immediately.
 */
export function checkStatusEnumForPatches(
  kind: "task-list" | "initiatives" | "backlog" | "retro",
  data: InitiativesDocument,
  patches: readonly FieldPatch[],
): StatusEnumGateOutcome {
  if (kind !== "initiatives") return { ok: true };
  for (const patch of patches) {
    const target = resolveStatusTarget(data, patch);
    if (!target) continue;
    if (!isValidStatus(target.nodeKind, target.status)) {
      return invalidStatusOutcome(target.nodeKind, target.status);
    }
  }
  return { ok: true };
}

/**
 * CREATE-hook entry point (post-mutation / pre-serialisation) — call
 * alongside `checkBudgetForCreate` with the SAME create-defaulted `record`.
 * `createRecordKindFor("initiatives", …)` returns either `"project"` or
 * `"initiative"` (ID-156.8 — the two addressable initiatives node shapes,
 * INV-13); every other createKind is a no-op here (their schemas already
 * hard-`.enum()` status at the final `.parse()` inside `insertRecord`).
 */
export function checkStatusEnumForCreate(
  createKind: CreateRecordKind,
  record: Record<string, unknown>,
): StatusEnumGateOutcome {
  if (createKind !== "project" && createKind !== "initiative") {
    return { ok: true };
  }
  if (!isValidStatus(createKind, record.status)) {
    return invalidStatusOutcome(createKind, record.status);
  }
  return { ok: true };
}
