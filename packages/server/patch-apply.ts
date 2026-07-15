/**
 * patch-apply.ts — TECH §5.2 + §5.5 patch application algorithm.
 *
 * Pure-logic core of the patch server (TECH §5.1). The server endpoints
 * in `patch-server.ts` (ID-20.8d) compose this with:
 *   - mtime collision detection (§5.4)
 *   - atomic write (§5.3)
 *   - mirror regeneration (§5.5 — once per multi-field PATCH)
 *
 * This module's responsibility is narrowly scoped to:
 *   1. Walk a FieldPath through the canonical structure.
 *   2. Replace the value at the leaf (replacement, not merge).
 *   3. Parse the resulting object via the matching Zod schema.
 *   4. Return either the parsed-and-typed result or a structured error.
 *
 * Atomicity within a multi-field PATCH (§5.5): all patches MUST apply
 * to a single in-memory snapshot, then ONE Zod parse runs against the
 * mutated snapshot. If any patch's walk fails OR the final parse fails,
 * NO change is committed and the error is surfaced. This matches the
 * §5.5 "all-or-nothing" wording.
 *
 * FieldPath shape (TECH §5.1):
 *   - Task-list:
 *       ['tasks', taskId, 'status' | 'priority' | 'description' | ...]
 *       ['tasks', taskId, 'subtasks', subtaskId, 'status' | ...]
 *     taskId is a STRING id (e.g. '20'); subtaskId is a DIGIT-STRING id
 *     (e.g. '4'). FieldPath is uniformly string[] and the stored subtask
 *     id is now itself a digit-string, so we compare string-to-string on
 *     subtask lookup (no Number()-parse).
 *   - Initiatives (ID-148.10, TECH §3.1(b), INV-13 — repurposed roadmap arm):
 *       ['projects', projectSlug, field]
 *         addresses a Project by its GLOBALLY-UNIQUE slug — tree-walked
 *         through `initiatives[]` + recursive `sub-initiatives[]`
 *         regardless of which node currently owns it.
 *       ['initiatives', dottedPath, field]
 *         addresses an Initiative (bare path, e.g. `"4"`) or a
 *         sub-initiative (dotted path, e.g. `"4.2"`, `"4.2.1"`).
 *     A "move" (re-parenting a task/backlog id between two projects) is NOT
 *     a distinct op — it compiles to TWO ['projects', slug, 'linked_tasks'|
 *     'linked_backlog'] patches in ONE batch, which the existing §5.5
 *     all-or-nothing multi-patch machinery already applies atomically
 *     (one Zod parse, one gate cycle, record-set delta ∅ since no project
 *     is added or removed — only field CONTENTS change).
 *   - Backlog:
 *       ['items', itemId, 'description' | 'status' | ...]
 *
 * Why id-based not index-based: the canonical JSON ordering is the
 * Planner's decision; clients shouldn't have to track indices across
 * ledger edits. The id-based path is stable across reorderings.
 */

import { TaskListSchema, type TaskList } from "@task-view/schemas/task-list";
import { TaskSchema, SubtaskSchema } from "@task-view/schemas/task-list";
import {
  InitiativesSchema,
  ProjectSchema,
  InitiativeSchema,
  type InitiativesDocument,
} from "@task-view/schemas/initiatives";
import { BacklogSchema, BacklogItemSchema, type BacklogDocument } from "@task-view/schemas/backlog";
import {
  RetrosSchema,
  RetroRecordSchema,
  type RetrosDocument,
} from "@task-view/schemas/retro";
import { ZodError } from "zod";
import type { DetectSchemaResult } from "./detect-schema";
import {
  findProjectBySlug,
  resolveInitiativeNode,
  type TreeDoc,
} from "./initiatives-tree";

// ── Schema-keyset sets ────────────────────────────────────────────────────────
//
// ID-20.26: The `hasOwnProperty` guard used to double-duty as:
//   (a) permit writes to fields that ARE on the record instance, and
//   (b) reject writes to fields that are NOT on the record instance.
//
// The problem: optional fields (e.g. `rank`, `capability_theme`, `updatedAt`)
// are absent on live records — `hasOwnProperty` returned false for them, so
// SET operations were incorrectly rejected as walk-errors.
//
// Fix (preferred approach): guard against the SCHEMA's known-key set rather
// than the instance's own properties. A field is permitted iff it is declared
// in the record type's Zod schema shape, regardless of whether it is present
// on the instance. Genuinely unknown / typo'd fields are absent from the shape
// and are still rejected as walk-errors — exactly as before.
//
// For task-list (TaskSchema, SubtaskSchema) and initiatives (InitiativeSchema,
// ProjectSchema) the final Zod re-parse uses `.strict()`/not respectively (see
// below) and would also catch unknown keys as a schema-error where `.strict()`
// applies. For backlog (BacklogItemSchema) the schema does NOT use `.strict()`
// (it strips unknown keys silently), so the schema-keyset guard is ESSENTIAL —
// without it a typo'd field would silently no-op and return 200.
//
// Each Set is derived from the Zod `.shape` object of the corresponding schema.
// `.strict()` and `.superRefine()` both preserve the `.shape` accessor on
// ZodObject in Zod v4 (verified against node_modules/zod/v4/classic/schemas.d.ts).

const TASK_KNOWN_FIELDS = new Set(Object.keys(TaskSchema.shape));
const SUBTASK_KNOWN_FIELDS = new Set(Object.keys(SubtaskSchema.shape));
const BACKLOG_ITEM_KNOWN_FIELDS = new Set(Object.keys(BacklogItemSchema.shape));
// ID-148.10 (INV-13): the two initiatives node shapes. `ProjectSchema` and
// `InitiativeSchema` are plain `z.object(...)` — `.shape` is available.
// `SubInitiativeSchema` is a `z.lazy(...)` wrapper (required for the
// recursive typing) whose inner shape is not accessor-stable across zod
// versions, so its known-field set is declared literally here — it mirrors
// `InitiativeSchema`'s fields minus the initiative-4 transitional
// `linked_tasks`/`linked_backlog` tolerance (`initiatives-schema.ts`'s
// `SubInitiativeSchema` z.lazy() body is the source of truth; keep in sync).
const PROJECT_KNOWN_FIELDS = new Set(Object.keys(ProjectSchema.shape));
const INITIATIVE_KNOWN_FIELDS = new Set(Object.keys(InitiativeSchema.shape));
const SUB_INITIATIVE_KNOWN_FIELDS = new Set([
  "id",
  "title",
  "description",
  "substrate_doc",
  "status",
  "projects",
  "originating_session",
  "sub-initiatives",
]);
// WS-C C2: retro record field keyset — same schema-keyset guard discipline.
// RetroRecordSchema IS `.strict()`, but the keyset guard keeps the
// walk-error-vs-schema-error boundary identical to the other kinds.
const RETRO_KNOWN_FIELDS = new Set(Object.keys(RetroRecordSchema.shape));

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * A single patch: walk fieldPath into the canonical structure, then either
 *   - replace the leaf with `newValue` (the original ID-20.8 op), or
 *   - CONCATENATE `appendText` onto the leaf's prior string value at apply
 *     time (ID-90 U6 — first-class append, OQ-4 ratified).
 *
 * The append op resolves the prior value AT APPLY TIME (inside the handler's
 * read-mutate-write cycle), so the prior bytes are preserved verbatim with
 * the new text appended (PRODUCT invariant 39) and a concurrent writer's
 * interleaved append is never dropped (invariant 43 — the re-read base is
 * fresh). A `null`/absent prior leaf yields `appendText` alone (e.g. the
 * `--append` forms of update-backlog/update-roadmap on a null `notes`).
 * A non-string, non-null prior leaf is a walk-error.
 */
export type FieldPatch =
  | { fieldPath: string[]; newValue: unknown }
  | { fieldPath: string[]; appendText: string };

/**
 * Apply one {@link FieldPatch}'s value operation to a resolved leaf
 * (`container[key]`). Shared by the typed walkers below AND the
 * parsed-original application in scoped-serialise.ts, so the two paths can
 * never drift on append semantics (ID-90 U6).
 *
 * Returns null on success, or an error detail string when the op cannot
 * apply (appendText onto a non-string, non-null leaf).
 */
export function applyValueToLeaf(
  container: Record<string, unknown>,
  key: string,
  patch: FieldPatch,
): null | string {
  if ("appendText" in patch) {
    const prior = container[key];
    if (prior === undefined || prior === null) {
      container[key] = patch.appendText;
      return null;
    }
    if (typeof prior !== "string") {
      return `Field "${key}" holds a non-string value (${typeof prior}); appendText requires a string (or null/absent) leaf.`;
    }
    // Invariant 39: the prior value is preserved VERBATIM; the new text is
    // concatenated at apply time — never client-side read-concatenate.
    container[key] = prior + patch.appendText;
    return null;
  }
  container[key] = patch.newValue;
  return null;
}

/**
 * Result of applying a batch of patches.
 *
 *   - { ok: true, parsed }      — all patches walked + Zod re-parsed OK.
 *     Caller is responsible for serialise + atomicWrite + regen.
 *   - { ok: false, kind: 'walk-error', ... } — a fieldPath couldn't be
 *     followed (missing parent, wrong record id, unknown subtask).
 *   - { ok: false, kind: 'schema-error', zodError } — final Zod parse
 *     failed; client renders the formatted error inline (PRODUCT inv 29).
 *   - { ok: false, kind: 'empty-patches' } — the patches array was
 *     empty; the server should reject this rather than write a no-op.
 *   - { ok: false, kind: 'kind-mismatch' } — the detected ledger kind
 *     doesn't match what the patch fieldPath references. Defends against
 *     a stale-loaded client.
 */
export type ApplyPatchesResult<TData> =
  | { ok: true; parsed: TData }
  | {
      ok: false;
      kind: "walk-error";
      fieldPath: string[];
      detail: string;
    }
  | { ok: false; kind: "schema-error"; zodError: ZodError }
  | { ok: false; kind: "empty-patches" }
  | { ok: false; kind: "kind-mismatch"; expected: string; actual: string };

// ── Internal: id-aware walk helpers ──────────────────────────────────────────

/**
 * Walk a fieldPath into a Task-list snapshot and apply a single patch.
 * Mutates `snapshot` in place. Returns a walk-error result on failure;
 * void on success (the caller checks return; null = success).
 */
function applyTaskListPatch(
  snapshot: TaskList,
  patch: FieldPatch,
): null | { fieldPath: string[]; detail: string } {
  const [head, ...rest] = patch.fieldPath;
  if (head !== "tasks") {
    return {
      fieldPath: patch.fieldPath,
      detail: `Task-list patches must start with 'tasks'; got "${head ?? "<empty>"}".`,
    };
  }
  const [taskId, ...afterTask] = rest;
  if (taskId == null || taskId === "") {
    return {
      fieldPath: patch.fieldPath,
      detail: `Missing task id at fieldPath[1].`,
    };
  }
  const taskIdx = snapshot.tasks.findIndex((t) => t.id === taskId);
  if (taskIdx === -1) {
    return {
      fieldPath: patch.fieldPath,
      detail: `Task id "${taskId}" not found in canonical tasks[].`,
    };
  }
  const task = snapshot.tasks[taskIdx];

  if (afterTask.length === 0) {
    // Replacing the whole task object is not supported via patch — that
    // shape goes through full-document writes. Reject explicitly so
    // misuse surfaces.
    return {
      fieldPath: patch.fieldPath,
      detail: `FieldPath must address a field within the Task, not the Task object itself.`,
    };
  }

  // Direct task-field patch: ['tasks', taskId, fieldName]
  if (afterTask.length === 1) {
    const field = afterTask[0];
    // ID-20.26: guard against schema known-key set (not instance hasOwnProperty)
    // so that optional fields absent on the record instance can still be SET.
    if (!TASK_KNOWN_FIELDS.has(field)) {
      return {
        fieldPath: patch.fieldPath,
        detail: `Field "${field}" is not a known field on Task records. Known fields: ${[...TASK_KNOWN_FIELDS].join(", ")}.`,
      };
    }
    const applyErr = applyValueToLeaf(
      task as unknown as Record<string, unknown>,
      field,
      patch,
    );
    if (applyErr) return { fieldPath: patch.fieldPath, detail: applyErr };
    return null;
  }

  // Subtask patch: ['tasks', taskId, 'subtasks', subtaskId, fieldName]
  if (afterTask[0] !== "subtasks") {
    return {
      fieldPath: patch.fieldPath,
      detail: `Unsupported nested path segment "${afterTask[0]}" after taskId; only 'subtasks' is supported.`,
    };
  }
  const subtaskIdRaw = afterTask[1];
  if (subtaskIdRaw == null) {
    return {
      fieldPath: patch.fieldPath,
      detail: `Missing subtask id at fieldPath[3].`,
    };
  }
  if (!/^\d+$/.test(subtaskIdRaw)) {
    return {
      fieldPath: patch.fieldPath,
      detail: `Subtask id "${subtaskIdRaw}" is not a digit-string id.`,
    };
  }
  const subtaskIdx = task.subtasks.findIndex((s) => s.id === subtaskIdRaw);
  if (subtaskIdx === -1) {
    return {
      fieldPath: patch.fieldPath,
      detail: `Subtask id ${subtaskIdRaw} not found within Task ${taskId}.`,
    };
  }
  const subtask = task.subtasks[subtaskIdx];

  const subtaskFieldPathRest = afterTask.slice(2);
  if (subtaskFieldPathRest.length !== 1) {
    return {
      fieldPath: patch.fieldPath,
      detail: `Subtask fieldPath must address a single field after the subtaskId; got ${subtaskFieldPathRest.length} additional segment(s).`,
    };
  }
  const subField = subtaskFieldPathRest[0];
  // ID-20.26: guard against schema known-key set (not instance hasOwnProperty)
  // so that optional fields absent on the record instance can still be SET.
  if (!SUBTASK_KNOWN_FIELDS.has(subField)) {
    return {
      fieldPath: patch.fieldPath,
      detail: `Field "${subField}" is not a known field on Subtask records. Known fields: ${[...SUBTASK_KNOWN_FIELDS].join(", ")}.`,
    };
  }
  const applyErr = applyValueToLeaf(
    subtask as unknown as Record<string, unknown>,
    subField,
    patch,
  );
  if (applyErr) return { fieldPath: patch.fieldPath, detail: applyErr };
  return null;
}

/**
 * Walk a fieldPath into an Initiatives snapshot and apply a single patch
 * (ID-148.10, TECH §3.1(b), INV-13 — repurposed roadmap arm).
 *
 * Two addressable shapes:
 *   - `['projects', slug, field]` — a Project, tree-walk-found by its
 *     globally-unique slug anywhere under `initiatives[]` +
 *     recursive `sub-initiatives[]`.
 *   - `['initiatives', dottedPath, field]` — an Initiative (bare path, e.g.
 *     `"4"`) or a sub-initiative (dotted path, e.g. `"4.2"`).
 */
function applyInitiativesPatch(
  snapshot: InitiativesDocument,
  patch: FieldPatch,
): null | { fieldPath: string[]; detail: string } {
  const [head, id, ...rest] = patch.fieldPath;
  if (head !== "projects" && head !== "initiatives") {
    return {
      fieldPath: patch.fieldPath,
      detail: `Initiatives patches must start with 'projects' or 'initiatives'; got "${head ?? "<empty>"}".`,
    };
  }
  if (id == null || id === "") {
    return {
      fieldPath: patch.fieldPath,
      detail: `Missing record id at fieldPath[1].`,
    };
  }
  if (rest.length !== 1) {
    return {
      fieldPath: patch.fieldPath,
      detail: `Initiatives fieldPath must address a single field after the id; got ${rest.length} additional segment(s).`,
    };
  }
  const field = rest[0];
  const doc = snapshot as unknown as TreeDoc;

  if (head === "projects") {
    const located = findProjectBySlug(doc, id);
    if (!located) {
      return {
        fieldPath: patch.fieldPath,
        detail: `Project slug "${id}" not found in canonical initiatives tree.`,
      };
    }
    if (!PROJECT_KNOWN_FIELDS.has(field)) {
      return {
        fieldPath: patch.fieldPath,
        detail: `Field "${field}" is not a known field on Project records. Known fields: ${[...PROJECT_KNOWN_FIELDS].join(", ")}.`,
      };
    }
    const applyErr = applyValueToLeaf(located.project, field, patch);
    if (applyErr) return { fieldPath: patch.fieldPath, detail: applyErr };
    return null;
  }

  // head === "initiatives"
  const node = resolveInitiativeNode(doc, id);
  if (!node) {
    return {
      fieldPath: patch.fieldPath,
      detail: `Initiative path "${id}" not found in canonical initiatives[]/sub-initiatives[] tree.`,
    };
  }
  const isTopLevel = !id.includes(".");
  const knownFields = isTopLevel
    ? INITIATIVE_KNOWN_FIELDS
    : SUB_INITIATIVE_KNOWN_FIELDS;
  if (!knownFields.has(field)) {
    return {
      fieldPath: patch.fieldPath,
      detail: `Field "${field}" is not a known field on ${isTopLevel ? "Initiative" : "SubInitiative"} records. Known fields: ${[...knownFields].join(", ")}.`,
    };
  }
  const applyErr = applyValueToLeaf(
    node as unknown as Record<string, unknown>,
    field,
    patch,
  );
  if (applyErr) return { fieldPath: patch.fieldPath, detail: applyErr };
  return null;
}

/**
 * Walk a fieldPath into a Backlog snapshot and apply a single patch.
 */
function applyBacklogPatch(
  snapshot: BacklogDocument,
  patch: FieldPatch,
): null | { fieldPath: string[]; detail: string } {
  const [head, itemId, ...rest] = patch.fieldPath;
  if (head !== "items") {
    return {
      fieldPath: patch.fieldPath,
      detail: `Backlog patches must start with 'items'; got "${head ?? "<empty>"}".`,
    };
  }
  if (itemId == null || itemId === "") {
    return {
      fieldPath: patch.fieldPath,
      detail: `Missing item id at fieldPath[1].`,
    };
  }
  const itemIdx = snapshot.items.findIndex((it) => it.id === itemId);
  if (itemIdx === -1) {
    return {
      fieldPath: patch.fieldPath,
      detail: `Item id "${itemId}" not found in canonical items[].`,
    };
  }
  const item = snapshot.items[itemIdx];

  if (rest.length !== 1) {
    return {
      fieldPath: patch.fieldPath,
      detail: `Item fieldPath must address a single field after the itemId; got ${rest.length} additional segment(s).`,
    };
  }
  const field = rest[0];
  // ID-20.26: guard against schema known-key set (not instance hasOwnProperty)
  // so that optional fields absent on the record instance can still be SET.
  // CRITICAL for backlog: BacklogItemSchema does NOT use .strict(), so a
  // typo'd field written to the snapshot would be silently stripped by Zod
  // and the PATCH would return 200/ok having written nothing — a silent no-op.
  // The schema-keyset guard MUST catch unknown fields before Zod sees them.
  if (!BACKLOG_ITEM_KNOWN_FIELDS.has(field)) {
    return {
      fieldPath: patch.fieldPath,
      detail: `Field "${field}" is not a known field on BacklogItem records. Known fields: ${[...BACKLOG_ITEM_KNOWN_FIELDS].join(", ")}.`,
    };
  }
  const applyErr = applyValueToLeaf(
    item as unknown as Record<string, unknown>,
    field,
    patch,
  );
  if (applyErr) return { fieldPath: patch.fieldPath, detail: applyErr };
  return null;
}

/**
 * Walk a fieldPath into a Retros snapshot and apply a single patch (WS-C C2).
 * Records are addressed by their session id under `retros[]` — the same
 * `['retros', id, field]` shape the other record-collection appliers use.
 */
function applyRetroPatch(
  snapshot: RetrosDocument,
  patch: FieldPatch,
): null | { fieldPath: string[]; detail: string } {
  const [head, retroId, ...rest] = patch.fieldPath;
  if (head !== "retros") {
    return {
      fieldPath: patch.fieldPath,
      detail: `Retro patches must start with 'retros'; got "${head ?? "<empty>"}".`,
    };
  }
  if (retroId == null || retroId === "") {
    return {
      fieldPath: patch.fieldPath,
      detail: `Missing retro id at fieldPath[1].`,
    };
  }
  const retroIdx = snapshot.retros.findIndex((r) => r.id === retroId);
  if (retroIdx === -1) {
    return {
      fieldPath: patch.fieldPath,
      detail: `Retro id "${retroId}" not found in canonical retros[].`,
    };
  }
  const retro = snapshot.retros[retroIdx];

  if (rest.length !== 1) {
    return {
      fieldPath: patch.fieldPath,
      detail: `Retro fieldPath must address a single field after the retroId; got ${rest.length} additional segment(s).`,
    };
  }
  const field = rest[0];
  if (!RETRO_KNOWN_FIELDS.has(field)) {
    return {
      fieldPath: patch.fieldPath,
      detail: `Field "${field}" is not a known field on Retro records. Known fields: ${[...RETRO_KNOWN_FIELDS].join(", ")}.`,
    };
  }
  const applyErr = applyValueToLeaf(
    retro as unknown as Record<string, unknown>,
    field,
    patch,
  );
  if (applyErr) return { fieldPath: patch.fieldPath, detail: applyErr };
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Apply a batch of FieldPatch entries to a TaskList canonical snapshot
 * and re-parse via TaskListSchema. Single-validation-pass per §5.5.
 *
 * Caller MUST pass a fresh structuredClone of the canonical data — this
 * function mutates the input snapshot (acceptable because clone-on-entry
 * is the caller's responsibility; this keeps the function allocation-cheap
 * for the common multi-patch hot path).
 */
export function applyTaskListPatches(
  snapshot: TaskList,
  patches: readonly FieldPatch[],
): ApplyPatchesResult<TaskList> {
  if (patches.length === 0) return { ok: false, kind: "empty-patches" };
  for (const patch of patches) {
    const err = applyTaskListPatch(snapshot, patch);
    if (err) {
      return { ok: false, kind: "walk-error", fieldPath: err.fieldPath, detail: err.detail };
    }
  }
  try {
    const parsed = TaskListSchema.parse(snapshot);
    return { ok: true, parsed };
  } catch (err) {
    if (err instanceof ZodError) {
      return { ok: false, kind: "schema-error", zodError: err };
    }
    throw err;
  }
}

/**
 * Apply a batch of FieldPatch entries to an Initiatives canonical snapshot
 * and re-parse via InitiativesSchema (ID-148.10). Same single-validation-pass
 * + clone-on-entry contract as the other appliers. A batch MAY address
 * multiple DIFFERENT projects/initiatives in one call (each patch resolves
 * its own fieldPath independently) — this is what makes the "atomic move"
 * op (INV-13) just a 2-patch batch through this same function, with no
 * dedicated server operation required.
 */
export function applyInitiativesPatches(
  snapshot: InitiativesDocument,
  patches: readonly FieldPatch[],
): ApplyPatchesResult<InitiativesDocument> {
  if (patches.length === 0) return { ok: false, kind: "empty-patches" };
  for (const patch of patches) {
    const err = applyInitiativesPatch(snapshot, patch);
    if (err) {
      return { ok: false, kind: "walk-error", fieldPath: err.fieldPath, detail: err.detail };
    }
  }
  try {
    const parsed = InitiativesSchema.parse(snapshot);
    return { ok: true, parsed };
  } catch (err) {
    if (err instanceof ZodError) {
      return { ok: false, kind: "schema-error", zodError: err };
    }
    throw err;
  }
}

export function applyBacklogPatches(
  snapshot: BacklogDocument,
  patches: readonly FieldPatch[],
): ApplyPatchesResult<BacklogDocument> {
  if (patches.length === 0) return { ok: false, kind: "empty-patches" };
  for (const patch of patches) {
    const err = applyBacklogPatch(snapshot, patch);
    if (err) {
      return { ok: false, kind: "walk-error", fieldPath: err.fieldPath, detail: err.detail };
    }
  }
  try {
    const parsed = BacklogSchema.parse(snapshot);
    return { ok: true, parsed };
  } catch (err) {
    if (err instanceof ZodError) {
      return { ok: false, kind: "schema-error", zodError: err };
    }
    throw err;
  }
}

/**
 * Apply a batch of FieldPatch entries to a Retros canonical snapshot and
 * re-parse via RetrosSchema (WS-C C2). Same single-validation-pass +
 * clone-on-entry contract as the other appliers.
 */
export function applyRetroPatches(
  snapshot: RetrosDocument,
  patches: readonly FieldPatch[],
): ApplyPatchesResult<RetrosDocument> {
  if (patches.length === 0) return { ok: false, kind: "empty-patches" };
  for (const patch of patches) {
    const err = applyRetroPatch(snapshot, patch);
    if (err) {
      return { ok: false, kind: "walk-error", fieldPath: err.fieldPath, detail: err.detail };
    }
  }
  try {
    const parsed = RetrosSchema.parse(snapshot);
    return { ok: true, parsed };
  } catch (err) {
    if (err instanceof ZodError) {
      return { ok: false, kind: "schema-error", zodError: err };
    }
    throw err;
  }
}

/**
 * Dispatch a patch batch to the per-kind applier. Returns the
 * discriminated-union result with a matching `kind` payload.
 *
 * Throws an Error (not a result) if the detected kind is 'unknown' —
 * callers should have already rejected unknown ledgers at load time
 * per inv 48.
 */
export function applyPatches(
  detected: DetectSchemaResult,
  patches: readonly FieldPatch[],
): ApplyPatchesResult<TaskList | InitiativesDocument | BacklogDocument | RetrosDocument> {
  if (detected.kind === "unknown") {
    throw new Error(
      `Cannot apply patches to unknown ledger kind (document_name: ${detected.documentName ?? "null"}).`,
    );
  }
  if (detected.kind === "task-list") {
    // Caller clones; we mutate here. structuredClone is the caller's
    // responsibility — see function jsdoc above.
    return applyTaskListPatches(detected.data, patches);
  }
  // ID-148.10: repurposed roadmap arm — nested initiatives walk.
  if (detected.kind === "initiatives") {
    return applyInitiativesPatches(detected.data, patches);
  }
  // WS-C C2: fourth dispatcher arm — the retros walk.
  if (detected.kind === "retro") {
    return applyRetroPatches(detected.data, patches);
  }
  return applyBacklogPatches(detected.data, patches);
}
