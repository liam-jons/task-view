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
import {
  UmbrellasSchema,
  type Umbrellas,
} from "@task-view/schemas/umbrellas";
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
  // ID-90 U8: umbrellas — kebab-case umbrella entry ids.
  if (detected.kind === "umbrellas") {
    return new Set(detected.data.umbrellas.map((u) => u.id));
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
  | { ok: true; data: TaskList | Roadmap | BacklogDocument | Umbrellas }
  | { ok: false; zodError: ZodError } {
  try {
    if (kind === "task-list")
      return { ok: true, data: TaskListSchema.parse(raw) };
    if (kind === "roadmap") return { ok: true, data: RoadmapSchema.parse(raw) };
    // ID-90 U8: fourth known kind.
    if (kind === "umbrellas")
      return { ok: true, data: UmbrellasSchema.parse(raw) };
    return { ok: true, data: BacklogSchema.parse(raw) };
  } catch (err) {
    if (err instanceof ZodError) return { ok: false, zodError: err };
    throw err;
  }
}

function rebuildDetected(
  kind: KnownDetected["kind"],
  data: TaskList | Roadmap | BacklogDocument | Umbrellas,
): KnownDetected {
  if (kind === "task-list")
    return { kind: "task-list", data: data as TaskList };
  if (kind === "roadmap") return { kind: "roadmap", data: data as Roadmap };
  // ID-90 U8: fourth known kind.
  if (kind === "umbrellas")
    return { kind: "umbrellas", data: data as Umbrellas };
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

// ── ID-90.9 U5: create defaults + auto-id + subtask CRUD ─────────────────────
//
// Ported from the KH ledger-CLI (scripts/ledger-cli.ts):
//   - `CREATE_DEFAULTS` / `withCreateDefaults` (ledger-cli.ts:2237) — merge
//     structural defaults UNDER the supplied record (supplied fields win).
//   - `nextId` (ledger-cli.ts:645-674) — per-record max+1 allocation with the
//     correct primitive TYPE per collection.
//   - the bulk `add-subtasks` fold-left create + `delete-subtask` removal
//     (PRODUCT invariants 37-38; invariant 38's mutex half lands in record 11).

/** The four documented record kinds, each with structural create defaults. */
export type CreateRecordKind = "subtask" | "task" | "theme" | "item";

/** Per-record-kind structural defaults — empty arrays, nulls, empty strings.
 * Ported VERBATIM from the KH ledger-CLI `CREATE_DEFAULTS` (ledger-cli.ts). */
const CREATE_DEFAULTS: Record<CreateRecordKind, Record<string, unknown>> = {
  subtask: {
    details: "",
    status: "pending",
    dependencies: [],
    testStrategy: null,
  },
  task: {
    status: "pending",
    dependencies: [],
    subtasks: [],
    effort_estimate: null,
    owner: null,
    priority_note: null,
    status_note: null,
    cross_doc_links: [],
    session_refs: [],
    commit_refs: [],
    updatedAt: "",
  },
  theme: {
    status: "pending",
    time_horizon: "later",
    linked_tasks: [],
    linked_backlog: [],
    session_refs: [],
    commit_refs: [],
    cross_doc_links: [],
    notes: null,
  },
  item: {
    // `type` / `track` are required scalars with no inherent empty value;
    // these structural defaults keep a bare minimal create valid and signal
    // an untriaged item (override via the body).
    type: "feature",
    track: "unsorted",
    status: "parked",
    dependencies: [],
    effort_estimate: null,
    session_refs: [],
    commit_refs: [],
    cross_doc_links: [],
    notes: null,
  },
};

/**
 * Merge structural defaults UNDER the supplied record (supplied fields win).
 * Defaults only apply for absent keys, so a body that already carries (e.g.)
 * `status` keeps its value. `task.updatedAt` defaults to the write timestamp
 * when absent. Ported from ledger-cli.ts:2237.
 */
export function withCreateDefaults(
  recordKind: CreateRecordKind,
  record: Record<string, unknown>,
): Record<string, unknown> {
  const defaults = { ...CREATE_DEFAULTS[recordKind] };
  if (recordKind === "task" && record.updatedAt === undefined) {
    defaults.updatedAt = new Date().toISOString();
  }
  return { ...defaults, ...record };
}

/**
 * Per-record auto-id (ledger-cli.ts:645-674 port). Computes
 * `max(existingIds) + 1` for a collection, returning the correct primitive
 * TYPE:
 *   - `tasks` / `themes` / `items` → bare-digit STRING (`"186"`)
 *   - `subtasks`                    → bare-digit STRING (`"13"`), scoped to `taskId`
 *
 * `max+1` is the monotonic semantics (never reuses a freed id; does NOT fill
 * gaps). For subtasks the now-string ids are mapped to numbers for the
 * `Math.max` before the result is String()-wrapped, preserving monotonic
 * numeric ordering (a raw string `Math.max` would mis-order mixed-width ids).
 */
export function nextId(
  detected: KnownDetected,
  collectionKey: "tasks" | "themes" | "items" | "subtasks",
  taskId?: string,
): string {
  if (collectionKey === "subtasks") {
    if (detected.kind !== "task-list") {
      throw new Error("nextId(subtasks) requires a task-list ledger");
    }
    if (taskId === undefined) {
      throw new Error("nextId(subtasks) requires a taskId");
    }
    const task = detected.data.tasks.find((t) => t.id === taskId);
    const nums = (task?.subtasks ?? [])
      .map((s) => Number(s.id))
      .filter((n) => !Number.isNaN(n));
    return String(nums.length === 0 ? 1 : Math.max(...nums) + 1);
  }
  let ids: string[] = [];
  if (collectionKey === "tasks" && detected.kind === "task-list") {
    ids = detected.data.tasks.map((t) => t.id);
  } else if (collectionKey === "themes" && detected.kind === "roadmap") {
    ids = detected.data.themes.map((t) => t.id);
  } else if (collectionKey === "items" && detected.kind === "backlog") {
    ids = detected.data.items.map((it) => it.id);
  } else {
    throw new Error(
      `nextId(${collectionKey}) does not match detected ledger kind ${detected.kind}`,
    );
  }
  const nums = ids.map((id) => Number(id)).filter((n) => !Number.isNaN(n));
  return String(nums.length === 0 ? 1 : Math.max(...nums) + 1);
}

/**
 * Result of a bulk subtask insert.
 *
 *   - { ok: true, detected, subtaskIds, records } — applied + re-parsed OK.
 *     `records` are the EXACT coerced record objects (defaults merged, ids
 *     injected) so the caller can splice the SAME objects into the
 *     parsed-original text (scoped write).
 *   - { ok: false, kind: 'task-not-found' }    — no Task carries `taskId`.
 *   - { ok: false, kind: 'duplicate-id' }      — an explicit subtask id
 *     collides with an existing sibling or with another batch member.
 *   - { ok: false, kind: 'invalid-body' }      — empty batch / non-object
 *     element.
 *   - { ok: false, kind: 'schema-error' }      — the whole-doc Zod re-parse
 *     failed (malformed record body).
 */
export type InsertSubtasksResult =
  | {
      ok: true;
      detected: KnownDetected;
      taskId: string;
      subtaskIds: string[];
      records: Record<string, unknown>[];
    }
  | { ok: false; kind: "task-not-found"; taskId: string }
  | { ok: false; kind: "duplicate-id"; subtaskId: string }
  | { ok: false; kind: "invalid-body"; detail: string }
  | { ok: false; kind: "schema-error"; zodError: ZodError };

/**
 * Bulk-insert subtasks into one Task (ID-90 U5 — PRODUCT invariant 37).
 *
 * Fold-left semantics: records are appended ONE AT A TIME to the working
 * subtasks[] and each record lacking an id receives `max(accumulated)+1` at
 * its turn — so a batch of N id-less records gets N sequential ids, and an
 * explicit id mid-batch advances the allocation point past itself (later
 * auto-ids never collide with it). Records carrying an explicit id keep it.
 *
 * Duplicate-id pre-check runs against the accumulated id-set (existing
 * siblings + earlier batch members) BEFORE the schema parse so the collision
 * gets a dedicated 409-mappable result rather than a generic schema error
 * (z.array(SubtaskSchema) has no within-array uniqueness constraint — the
 * pre-check is the only structured guard).
 *
 * Create defaults (`withCreateDefaults('subtask', …)`) are merged per record
 * before allocation. The whole document is Zod re-parsed once after the fold
 * (all-or-nothing — matches insertRecord / applyPatches).
 */
export function insertSubtasks(
  detected: KnownDetected,
  taskId: string,
  subtasks: readonly unknown[],
): InsertSubtasksResult {
  if (detected.kind !== "task-list") {
    return {
      ok: false,
      kind: "invalid-body",
      detail: "Subtask mutations require a task-list ledger.",
    };
  }
  if (!Array.isArray(subtasks) || subtasks.length === 0) {
    return {
      ok: false,
      kind: "invalid-body",
      detail: "Body must carry a non-empty `subtasks` array of record objects.",
    };
  }
  const task = detected.data.tasks.find((t) => t.id === taskId);
  if (!task) {
    return { ok: false, kind: "task-not-found", taskId };
  }

  // Fold-left over the batch: accumulate ids (existing + already-folded) and
  // allocate max+1 per id-less record at its turn. Ids are bare digit-strings;
  // the allocation counter `maxId` stays NUMERIC for the arithmetic (a string
  // `+ 1` would concatenate — `'5' + 1 === '51'`), and each stamped/tracked id
  // is String()-wrapped.
  const accumulatedIds = new Set<string>(task.subtasks.map((s) => s.id));
  let maxId = task.subtasks.reduce((m, s) => Math.max(m, Number(s.id)), 0);
  const records: Record<string, unknown>[] = [];
  const subtaskIds: string[] = [];
  for (const raw of subtasks) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {
        ok: false,
        kind: "invalid-body",
        detail: "Each `subtasks` element must be a subtask record object.",
      };
    }
    let record = withCreateDefaults(
      "subtask",
      raw as Record<string, unknown>,
    );
    if (record.id === undefined) {
      // Per-record nextId max+1 over the ACCUMULATED set (fold-left). Numeric
      // increment, digit-string stamp.
      record = { ...record, id: String(maxId + 1) };
    }
    const id = record.id;
    if (typeof id === "string" && /^\d+$/.test(id)) {
      if (accumulatedIds.has(id)) {
        return { ok: false, kind: "duplicate-id", subtaskId: id };
      }
      accumulatedIds.add(id);
      const idNum = Number(id);
      if (idNum > maxId) maxId = idNum;
      subtaskIds.push(id);
    } else {
      // A non-digit-string explicit id cannot be pre-checked here; the whole-doc
      // Zod re-parse below rejects it (SubtaskSchema.id is a digit-string). Push
      // a sentinel so subtaskIds stays index-aligned — unreachable on the ok
      // path because the parse fails first.
      subtaskIds.push("");
    }
    records.push(record);
  }

  // structuredClone the raw data so the caller's snapshot is untouched on any
  // failure path; append the coerced records, then ONE whole-doc re-parse.
  const rawClone = structuredClone(detected.data) as Record<string, unknown>;
  const tasksClone = rawClone.tasks;
  if (!Array.isArray(tasksClone)) {
    return {
      ok: false,
      kind: "invalid-body",
      detail: 'Ledger is missing its "tasks" collection.',
    };
  }
  const taskClone = tasksClone.find(
    (t) => (t as { id?: unknown }).id === taskId,
  ) as { subtasks?: unknown } | undefined;
  if (!taskClone || !Array.isArray(taskClone.subtasks)) {
    return { ok: false, kind: "task-not-found", taskId };
  }
  taskClone.subtasks.push(...records);

  const parsed = reparse(detected.kind, rawClone);
  if (!parsed.ok)
    return { ok: false, kind: "schema-error", zodError: parsed.zodError };
  return {
    ok: true,
    detected: rebuildDetected(detected.kind, parsed.data),
    taskId,
    subtaskIds,
    records,
  };
}

/** Result of a subtask removal. */
export type RemoveSubtaskResult =
  | { ok: true; detected: KnownDetected; taskId: string; subtaskId: string }
  | { ok: false; kind: "task-not-found"; taskId: string }
  | { ok: false; kind: "subtask-not-found"; taskId: string; subtaskId: string }
  | { ok: false; kind: "schema-error"; zodError: ZodError };

/**
 * Remove one subtask by digit-string id from a Task (ID-90 U5).
 *
 * Removing the last subtask leaves `subtasks: []` — a legal atomic-Task state
 * (TaskSchema.subtasks has no `.min(1)`). The mutated document is re-parsed
 * defensively, matching removeRecord's typed-snapshot contract.
 */
export function removeSubtask(
  detected: KnownDetected,
  taskId: string,
  subtaskId: string,
): RemoveSubtaskResult {
  if (detected.kind !== "task-list") {
    return { ok: false, kind: "task-not-found", taskId };
  }
  const task = detected.data.tasks.find((t) => t.id === taskId);
  if (!task) {
    return { ok: false, kind: "task-not-found", taskId };
  }
  if (!task.subtasks.some((s) => s.id === subtaskId)) {
    return { ok: false, kind: "subtask-not-found", taskId, subtaskId };
  }

  const rawClone = structuredClone(detected.data) as Record<string, unknown>;
  const tasksClone = rawClone.tasks as Record<string, unknown>[];
  const taskClone = tasksClone.find((t) => t.id === taskId) as {
    subtasks: { id: string }[];
  };
  taskClone.subtasks = taskClone.subtasks.filter((s) => s.id !== subtaskId);

  const parsed = reparse(detected.kind, rawClone);
  if (!parsed.ok)
    return { ok: false, kind: "schema-error", zodError: parsed.zodError };
  return {
    ok: true,
    detected: rebuildDetected(detected.kind, parsed.data),
    taskId,
    subtaskId,
  };
}
