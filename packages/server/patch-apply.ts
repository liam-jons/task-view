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
 *     taskId is a STRING id (e.g. '20'); subtaskId is an INTEGER id
 *     (e.g. 4 — represented as a string here because FieldPath is
 *     uniformly string[]; we Number()-parse on subtask lookup).
 *   - Roadmap (ID-20.19 themes[]):
 *       ['themes', themeId, 'status' | 'notes' | 'title' | ...]
 *   - Backlog:
 *       ['items', itemId, 'description' | 'status' | ...]
 *
 * Why id-based not index-based: the canonical JSON ordering is the
 * Planner's decision; clients shouldn't have to track indices across
 * ledger edits. The id-based path is stable across reorderings.
 */

import { TaskListSchema, type TaskList } from "@task-view/schemas/task-list";
import { RoadmapSchema, type Roadmap } from "@task-view/schemas/roadmap";
import { BacklogSchema, type BacklogDocument } from "@task-view/schemas/backlog";
import { ZodError } from "zod";
import type { DetectSchemaResult } from "./detect-schema";

// ── Public types ──────────────────────────────────────────────────────────────

/** A single patch: walk fieldPath into the canonical structure, replace leaf with newValue. */
export interface FieldPatch {
  fieldPath: string[];
  newValue: unknown;
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
    if (!Object.prototype.hasOwnProperty.call(task, field)) {
      return {
        fieldPath: patch.fieldPath,
        detail: `Field "${field}" is not present on Task ${taskId}. Available fields: ${Object.keys(task).join(", ")}.`,
      };
    }
    (task as Record<string, unknown>)[field] = patch.newValue;
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
  const subtaskIdNum = Number(subtaskIdRaw);
  if (!Number.isFinite(subtaskIdNum) || !Number.isInteger(subtaskIdNum)) {
    return {
      fieldPath: patch.fieldPath,
      detail: `Subtask id "${subtaskIdRaw}" is not an integer.`,
    };
  }
  const subtaskIdx = task.subtasks.findIndex((s) => s.id === subtaskIdNum);
  if (subtaskIdx === -1) {
    return {
      fieldPath: patch.fieldPath,
      detail: `Subtask id ${subtaskIdNum} not found within Task ${taskId}.`,
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
  if (!Object.prototype.hasOwnProperty.call(subtask, subField)) {
    return {
      fieldPath: patch.fieldPath,
      detail: `Field "${subField}" is not present on Subtask ${subtaskIdNum} of Task ${taskId}. Available fields: ${Object.keys(subtask).join(", ")}.`,
    };
  }
  (subtask as Record<string, unknown>)[subField] = patch.newValue;
  return null;
}

/**
 * Walk a fieldPath into a Roadmap snapshot and apply a single patch.
 *
 * Roadmap shape note (ID-20.19): the Phase-B themes[] roadmap replaced the
 * retired sections[]/items[] model. A roadmap record is a theme resolved
 * by id; patches address a single field directly on the theme
 * (`['themes', themeId, fieldName]`). There is no nested item layer.
 */
function applyRoadmapPatch(
  snapshot: Roadmap,
  patch: FieldPatch,
): null | { fieldPath: string[]; detail: string } {
  const [head, themeId, ...rest] = patch.fieldPath;
  if (head !== "themes") {
    return {
      fieldPath: patch.fieldPath,
      detail: `Roadmap patches must start with 'themes'; got "${head ?? "<empty>"}".`,
    };
  }
  if (themeId == null || themeId === "") {
    return {
      fieldPath: patch.fieldPath,
      detail: `Missing theme id at fieldPath[1].`,
    };
  }
  const themeIdx = snapshot.themes.findIndex((t) => t.id === themeId);
  if (themeIdx === -1) {
    return {
      fieldPath: patch.fieldPath,
      detail: `Theme id "${themeId}" not found in canonical themes[].`,
    };
  }
  const theme = snapshot.themes[themeIdx];

  if (rest.length === 0) {
    return {
      fieldPath: patch.fieldPath,
      detail: `FieldPath must address a field within the Theme, not the Theme object itself.`,
    };
  }

  // Direct theme-level field: ['themes', themeId, fieldName]
  if (rest.length !== 1) {
    return {
      fieldPath: patch.fieldPath,
      detail: `Theme fieldPath must address a single field after the themeId; got ${rest.length} additional segment(s).`,
    };
  }
  const field = rest[0];
  if (!Object.prototype.hasOwnProperty.call(theme, field)) {
    return {
      fieldPath: patch.fieldPath,
      detail: `Field "${field}" is not present on Theme ${themeId}. Available fields: ${Object.keys(theme).join(", ")}.`,
    };
  }
  (theme as Record<string, unknown>)[field] = patch.newValue;
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
  if (!Object.prototype.hasOwnProperty.call(item, field)) {
    return {
      fieldPath: patch.fieldPath,
      detail: `Field "${field}" is not present on Backlog item ${itemId}. Available fields: ${Object.keys(item).join(", ")}.`,
    };
  }
  (item as Record<string, unknown>)[field] = patch.newValue;
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

export function applyRoadmapPatches(
  snapshot: Roadmap,
  patches: readonly FieldPatch[],
): ApplyPatchesResult<Roadmap> {
  if (patches.length === 0) return { ok: false, kind: "empty-patches" };
  for (const patch of patches) {
    const err = applyRoadmapPatch(snapshot, patch);
    if (err) {
      return { ok: false, kind: "walk-error", fieldPath: err.fieldPath, detail: err.detail };
    }
  }
  try {
    const parsed = RoadmapSchema.parse(snapshot);
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
): ApplyPatchesResult<TaskList | Roadmap | BacklogDocument> {
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
  if (detected.kind === "roadmap") {
    return applyRoadmapPatches(detected.data, patches);
  }
  return applyBacklogPatches(detected.data, patches);
}
