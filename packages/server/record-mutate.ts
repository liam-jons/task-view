/**
 * record-mutate.ts — ID-20.15 record-level CREATE / DELETE primitives.
 *
 * Sibling to `patch-apply.ts` (which handles FIELD-level edits on existing
 * records). This module handles WHOLE-record mutations:
 *   - `insertRecord` — append a new record (Task / roadmap theme / backlog
 *     item) to the matching collection, then re-parse the whole ledger via
 *     the vendored Zod schema. Duplicate id is rejected.
 *   - `removeRecord` — drop a record by id, then re-parse. Absent id is a
 *     not-found result.
 *
 * Both functions follow the same all-or-nothing discipline as
 * `applyPatches` (TECH §5.5): mutate a single in-memory snapshot, run ONE
 * Zod parse, and surface a structured discriminated-union result. The
 * caller (patch-server) owns serialise + atomic-write + mirror regen.
 *
 * Why id-based not index-based: the canonical ordering is the Planner's
 * decision; clients address records by stable id (matches patch-apply.ts).
 *
 * The per-kind collection key:
 *   - task-list → `tasks[]`,  id is a bare-digit STRING (e.g. "42")
 *   - roadmap   → `themes[]`, id is a bare-digit STRING
 *   - backlog   → `items[]`,  id is a bare-digit STRING
 */

import { TaskListSchema, type TaskList } from "@task-view/schemas/task-list";
import { RoadmapSchema, type Roadmap } from "@task-view/schemas/roadmap";
import {
  BacklogSchema,
  type BacklogDocument,
} from "@task-view/schemas/backlog";
import { ZodError } from "zod";

import type { DetectSchemaResult } from "./detect-schema";

type KnownDetected = Exclude<DetectSchemaResult, { kind: "unknown" }>;

/**
 * Result of a record-level mutation.
 *
 *   - { ok: true, detected }    — mutation applied + re-parsed OK. The
 *     `detected` carries the freshly-parsed, typed snapshot the caller
 *     serialises + writes.
 *   - { ok: false, kind: 'duplicate-id' }  — CREATE only: a record with
 *     that id already exists.
 *   - { ok: false, kind: 'record-not-found' } — DELETE only: no record
 *     with that id.
 *   - { ok: false, kind: 'schema-error', zodError } — the post-mutation
 *     Zod parse failed (e.g. the supplied record body is malformed).
 *   - { ok: false, kind: 'invalid-body', detail } — the supplied body was
 *     not a usable object (CREATE only).
 */
export type RecordMutateResult =
  | { ok: true; detected: KnownDetected; recordId: string }
  | { ok: false; kind: "duplicate-id"; recordId: string }
  | { ok: false; kind: "record-not-found"; recordId: string }
  | { ok: false; kind: "schema-error"; zodError: ZodError }
  | { ok: false; kind: "invalid-body"; detail: string };

// ── id extraction ─────────────────────────────────────────────────────────────

/**
 * Pull the `id` field off an arbitrary record body. Used to detect
 * duplicates BEFORE the schema parse (so the duplicate gets a dedicated
 * 409 rather than a generic schema error). Returns null when the body is
 * not an object or has no string/number id.
 */
function extractId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const id = (body as { id?: unknown }).id;
  if (typeof id === "string") return id;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return null;
}

function existingIds(detected: KnownDetected): Set<string> {
  if (detected.kind === "task-list") {
    return new Set(detected.data.tasks.map((t) => t.id));
  }
  if (detected.kind === "roadmap") {
    return new Set(detected.data.themes.map((t) => t.id));
  }
  return new Set(detected.data.items.map((it) => it.id));
}

// ── re-parse helper ─────────────────────────────────────────────────────────

/**
 * Re-parse a mutated raw document via the matching vendored schema and
 * wrap the result. Keeps the ZodError-vs-throw boundary identical to
 * patch-apply.ts: a ZodError becomes a structured `schema-error`, any
 * other throw propagates.
 */
function reparse(
  kind: KnownDetected["kind"],
  raw: unknown,
):
  | { ok: true; data: TaskList | Roadmap | BacklogDocument }
  | { ok: false; zodError: ZodError } {
  try {
    if (kind === "task-list")
      return { ok: true, data: TaskListSchema.parse(raw) };
    if (kind === "roadmap") return { ok: true, data: RoadmapSchema.parse(raw) };
    return { ok: true, data: BacklogSchema.parse(raw) };
  } catch (err) {
    if (err instanceof ZodError) return { ok: false, zodError: err };
    throw err;
  }
}

function rebuildDetected(
  kind: KnownDetected["kind"],
  data: TaskList | Roadmap | BacklogDocument,
): KnownDetected {
  if (kind === "task-list")
    return { kind: "task-list", data: data as TaskList };
  if (kind === "roadmap") return { kind: "roadmap", data: data as Roadmap };
  return { kind: "backlog", data: data as BacklogDocument };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Insert a new record into the detected ledger.
 *
 * The `record` body is the full record object (a Task / RoadmapTheme /
 * BacklogItem shape). The caller passes the PARSED-and-validated `detected`
 * snapshot; this function clones the raw `.data` so the input is never
 * mutated, appends the record, then re-parses the WHOLE document so the
 * schema's document-level invariants (e.g. backlog unique-id superRefine,
 * task sibling-dep superRefine) run.
 *
 * Duplicate id is rejected with a `duplicate-id` result BEFORE the parse,
 * matching the existing 409/422 conventions (the caller maps it to 409).
 */
export function insertRecord(
  detected: KnownDetected,
  record: unknown,
): RecordMutateResult {
  const newId = extractId(record);
  if (newId === null) {
    return {
      ok: false,
      kind: "invalid-body",
      detail:
        "Record body must be an object carrying a string or numeric `id` field.",
    };
  }
  if (existingIds(detected).has(newId)) {
    return { ok: false, kind: "duplicate-id", recordId: newId };
  }

  // structuredClone the raw data so the caller's snapshot is untouched on
  // any failure path. We append to the cloned collection, then re-parse.
  const rawClone = structuredClone(detected.data) as Record<string, unknown>;
  const collectionKey =
    detected.kind === "task-list"
      ? "tasks"
      : detected.kind === "roadmap"
        ? "themes"
        : "items";
  const collection = rawClone[collectionKey];
  if (!Array.isArray(collection)) {
    // Defensive: a validated `detected` always carries the array, but guard
    // against a future shape drift rather than throwing.
    return {
      ok: false,
      kind: "invalid-body",
      detail: `Ledger is missing its "${collectionKey}" collection.`,
    };
  }
  collection.push(record);

  const parsed = reparse(detected.kind, rawClone);
  if (!parsed.ok)
    return { ok: false, kind: "schema-error", zodError: parsed.zodError };
  return {
    ok: true,
    detected: rebuildDetected(detected.kind, parsed.data),
    recordId: newId,
  };
}

/**
 * Remove a record by id from the detected ledger.
 *
 * Returns `record-not-found` when no record carries the id. On success the
 * mutated document is re-parsed (defensive — removal never breaks an
 * invariant, but the re-parse keeps the typed-snapshot contract identical
 * to insertRecord + applyPatches).
 */
export function removeRecord(
  detected: KnownDetected,
  recordId: string,
): RecordMutateResult {
  if (!existingIds(detected).has(recordId)) {
    return { ok: false, kind: "record-not-found", recordId };
  }
  const rawClone = structuredClone(detected.data) as Record<string, unknown>;
  const collectionKey =
    detected.kind === "task-list"
      ? "tasks"
      : detected.kind === "roadmap"
        ? "themes"
        : "items";
  const collection = rawClone[collectionKey];
  if (!Array.isArray(collection)) {
    return { ok: false, kind: "record-not-found", recordId };
  }
  rawClone[collectionKey] = collection.filter(
    (rec) => extractId(rec) !== recordId,
  );

  const parsed = reparse(detected.kind, rawClone);
  if (!parsed.ok)
    return { ok: false, kind: "schema-error", zodError: parsed.zodError };
  return {
    ok: true,
    detected: rebuildDetected(detected.kind, parsed.data),
    recordId,
  };
}
