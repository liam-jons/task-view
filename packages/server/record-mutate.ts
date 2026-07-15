/**
 * record-mutate.ts — ID-20.15 record-level CREATE / DELETE primitives.
 *
 * Sibling to `patch-apply.ts` (which handles FIELD-level edits on existing
 * records). This module handles WHOLE-record mutations:
 *   - `insertRecord` — append a new record (Task / initiatives Project /
 *     backlog item) to the matching collection, then re-parse the whole
 *     ledger via the vendored Zod schema. Duplicate id is rejected.
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
 *   - backlog   → `items[]`,  id is a bare-digit STRING
 *   - retro     → `retros[]`, id is a session id (`S<n>`)
 *
 * ID-148.10 (Option C, INV-13): `initiatives` is NOT a flat top-level
 * collection — it is `initiatives[]` -> `projects[]` + recursive
 * `sub-initiatives[]` -> `projects[]`, arbitrary depth. `insertRecord`
 * requires a `parentPath` for initiatives (the dotted initiative/
 * sub-initiative path to insert the new project under); `removeRecord`
 * tree-walk-finds the project by its globally-unique slug wherever it
 * lives. Both delegate the tree-walk itself to `initiatives-tree.ts` so the
 * mutate/patch/serialise arms can never drift on tree-walk semantics.
 */

import { TaskListSchema, type TaskList } from "@task-view/schemas/task-list";
import {
  InitiativesSchema,
  type InitiativesDocument,
} from "@task-view/schemas/initiatives";
import {
  BacklogSchema,
  type BacklogDocument,
} from "@task-view/schemas/backlog";
import {
  RetrosSchema,
  type RetrosDocument,
} from "@task-view/schemas/retro";
import { ZodError } from "zod";

import type { DetectSchemaResult } from "./detect-schema";
import {
  allProjectSlugs,
  insertProjectAt,
  removeProjectBySlug,
  type TreeDoc,
} from "./initiatives-tree";

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
 *     not a usable object (CREATE only), or (initiatives only) the
 *     `parentPath` was absent/unresolvable.
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

/**
 * The top-level record-collection key for a FLAT detected ledger kind
 * (task-list / backlog / retro). `initiatives` is NOT flat — its
 * insert/remove/existingIds handling branches separately via
 * `initiatives-tree.ts` (INV-13).
 */
function collectionKeyFor(
  kind: Exclude<KnownDetected["kind"], "initiatives">,
): string {
  if (kind === "task-list") return "tasks";
  if (kind === "retro") return "retros";
  return "items";
}

function existingIds(detected: KnownDetected): Set<string> {
  if (detected.kind === "task-list") {
    return new Set(detected.data.tasks.map((t) => t.id));
  }
  // ID-148.10: initiatives — the globally-unique project SLUG set,
  // flattened tree-wide (INV-13).
  if (detected.kind === "initiatives") {
    return new Set(allProjectSlugs(detected.data as unknown as TreeDoc));
  }
  if (detected.kind === "retro") {
    return new Set(detected.data.retros.map((r) => r.id));
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
  | {
      ok: true;
      data: TaskList | InitiativesDocument | BacklogDocument | RetrosDocument;
    }
  | { ok: false; zodError: ZodError } {
  try {
    if (kind === "task-list")
      return { ok: true, data: TaskListSchema.parse(raw) };
    // ID-148.10: repurposed roadmap arm.
    if (kind === "initiatives")
      return { ok: true, data: InitiativesSchema.parse(raw) };
    if (kind === "retro") return { ok: true, data: RetrosSchema.parse(raw) };
    return { ok: true, data: BacklogSchema.parse(raw) };
  } catch (err) {
    if (err instanceof ZodError) return { ok: false, zodError: err };
    throw err;
  }
}

function rebuildDetected(
  kind: KnownDetected["kind"],
  data: TaskList | InitiativesDocument | BacklogDocument | RetrosDocument,
): KnownDetected {
  if (kind === "task-list")
    return { kind: "task-list", data: data as TaskList };
  if (kind === "initiatives")
    return { kind: "initiatives", data: data as InitiativesDocument };
  if (kind === "retro")
    return { kind: "retro", data: data as RetrosDocument };
  return { kind: "backlog", data: data as BacklogDocument };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Insert a new record into the detected ledger.
 *
 * The `record` body is the full record object (a Task / initiatives Project
 * / BacklogItem shape). The caller passes the PARSED-and-validated
 * `detected` snapshot; this function clones the raw `.data` so the input is
 * never mutated, appends the record, then re-parses the WHOLE document so
 * the schema's document-level invariants run.
 *
 * Duplicate id is rejected with a `duplicate-id` result BEFORE the parse,
 * matching the existing 409/422 conventions (the caller maps it to 409).
 *
 * ID-148.10 (INV-13): for `detected.kind === "initiatives"`, `parentPath`
 * is REQUIRED — the dotted initiative/sub-initiative path the new project
 * inserts under. An absent or unresolvable path is `invalid-body`.
 */
export function insertRecord(
  detected: KnownDetected,
  record: unknown,
  parentPath?: string,
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

  if (detected.kind === "initiatives") {
    if (parentPath === undefined || parentPath === "") {
      return {
        ok: false,
        kind: "invalid-body",
        detail:
          "initiatives project creates require a `parentPath` (the dotted initiative/sub-initiative path to insert under).",
      };
    }
    const inserted = insertProjectAt(
      rawClone as TreeDoc,
      parentPath,
      record,
    );
    if (!inserted.ok) {
      return { ok: false, kind: "invalid-body", detail: inserted.detail };
    }
  } else {
    const collectionKey = collectionKeyFor(detected.kind);
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

    // ID-90 F5/Bug3: advance the monotonic high-water mark by the inserted id
    // (digit-string ids only). Applies to task-list/backlog only — retro
    // ids are caller-supplied session ids, and initiatives project ids are
    // caller-supplied kebab slugs (handled in the branch above); neither
    // carries the high-water field.
    if (detected.kind === "task-list" || detected.kind === "backlog") {
      const newIdNum = Number(newId);
      if (!Number.isNaN(newIdNum)) {
        stampHighWater(rawClone, effectiveHighWater(detected), newIdNum);
      }
    }
  }

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
 *
 * ID-148.10 (INV-13): for `detected.kind === "initiatives"`, `recordId` is
 * the project's globally-unique slug — tree-walk-found wherever it
 * currently lives (no parent addressing needed for a delete).
 */
export function removeRecord(
  detected: KnownDetected,
  recordId: string,
): RecordMutateResult {
  if (detected.kind === "initiatives") {
    const rawClone = structuredClone(detected.data) as Record<
      string,
      unknown
    >;
    const removed = removeProjectBySlug(rawClone as TreeDoc, recordId);
    if (!removed.ok) {
      return { ok: false, kind: "record-not-found", recordId };
    }
    const parsed = reparse(detected.kind, rawClone);
    if (!parsed.ok)
      return { ok: false, kind: "schema-error", zodError: parsed.zodError };
    return {
      ok: true,
      detected: rebuildDetected(detected.kind, parsed.data),
      recordId,
    };
  }

  if (!existingIds(detected).has(recordId)) {
    return { ok: false, kind: "record-not-found", recordId };
  }
  const rawClone = structuredClone(detected.data) as Record<string, unknown>;
  const collectionKey = collectionKeyFor(detected.kind);
  const collection = rawClone[collectionKey];
  if (!Array.isArray(collection)) {
    return { ok: false, kind: "record-not-found", recordId };
  }
  rawClone[collectionKey] = collection.filter(
    (rec) => extractId(rec) !== recordId,
  );

  // ID-90 F5/Bug3: persist the PRE-removal high-water mark BEFORE the freed id
  // disappears from the live set (task-list/backlog only — see insertRecord
  // comment above for why retro/initiatives are excluded).
  if (detected.kind === "task-list" || detected.kind === "backlog") {
    const prior = effectiveHighWater(detected);
    stampHighWater(rawClone, prior, prior);
  }

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

/** The documented record kinds, each with structural create defaults.
 * ID-148.10: `project` replaces the retired `theme` (initiatives projects
 * are created via a dedicated tree-insert, not a flat-collection push, but
 * still need the SAME structural-defaults treatment). */
export type CreateRecordKind =
  | "subtask"
  | "task"
  | "project"
  | "item"
  | "retro";

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
  // ID-148.10: initiatives project structural defaults. `status: "idea"` is
  // the lowest/untriaged PROJECT_STATUSES value (initiatives-schema.ts).
  project: {
    summary: "",
    description: "",
    substrate_doc: "",
    status: "idea",
    blocked_by: [],
    blocking: [],
    linked_tasks: [],
    linked_backlog: [],
    originating_session: [],
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
  // WS-C C2: retro record structural defaults — the six empty category arrays,
  // empty provenance arrays, and the four soft-delete fields. `id`, `session_id`,
  // `date`, and `track` are required scalars with no inherent empty value and
  // must be supplied in the body. RetroFindingSchema.cross_doc_links and the
  // four soft-delete fields also default in-schema, but seeding them here keeps
  // the written bytes explicit and parity with the other kinds' defaults.
  retro: {
    session_refs: [],
    commit_refs: [],
    cross_doc_links: [],
    bugs_discovered: [],
    failed_assumptions: [],
    architecture_decisions: [],
    rejected_approaches: [],
    workflow_improvements: [],
    unresolved_questions: [],
    deprecated: false,
    deprecation_reason: null,
    superseding_record_id: null,
    last_conflict_check: null,
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
 *   - `tasks` / `items` → bare-digit STRING (`"186"`)
 *   - `subtasks`         → bare-digit STRING (`"13"`), scoped to `taskId`
 *
 * `max+1` is the monotonic semantics (never reuses a freed id; does NOT fill
 * gaps). For subtasks the now-string ids are mapped to numbers for the
 * `Math.max` before the result is String()-wrapped, preserving monotonic
 * numeric ordering (a raw string `Math.max` would mis-order mixed-width ids).
 *
 * ID-148.10: `themes` is RETIRED (no initiatives analog — initiatives
 * project ids are caller-supplied kebab slugs, never auto-minted, mirroring
 * how retro session ids are caller-supplied — see `insertRecord`).
 */
export function nextId(
  detected: KnownDetected,
  collectionKey: "tasks" | "items" | "subtasks",
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
    // Subtasks are nested per-Task with no document-level high-water field;
    // their max+1 over the live siblings is unchanged (the bl-287/288 class
    // is a TOP-LEVEL-collection problem — promote/delete free a document-level
    // id; nested subtasks are not promoted out of their parent).
    return String(nums.length === 0 ? 1 : Math.max(...nums) + 1);
  }
  if (
    !(
      (collectionKey === "tasks" && detected.kind === "task-list") ||
      (collectionKey === "items" && detected.kind === "backlog")
    )
  ) {
    throw new Error(
      `nextId(${collectionKey}) does not match detected ledger kind ${detected.kind}`,
    );
  }
  // ID-90 F5/Bug3: allocate above BOTH the live max AND the persisted
  // monotonic high-water mark, so an id freed by delete/promote (which lowers
  // the live max) is NEVER reused. `nextHighWaterAlloc` returns the digit-string.
  return String(nextHighWaterAlloc(detected));
}

// ── ID-90 F5/Bug3: monotonic id high-water mark ──────────────────────────────
//
// The auto-id allocator previously returned `max(survivingIds)+1`. That is NOT
// monotonic across deletes/promotes: freeing the highest id lowers the live max,
// so the next allocation re-hands-out the just-freed id (the bl-287/288
// collision class — a reused backlog id collides with a promoted Task's
// provenance back-reference). The fix is a document-level `_idHighWater` field
// recording the highest id ever ALLOCATED; it only ever increases. The allocator
// reads `max(liveMax, highWater)+1`, and every create/delete/promote persists a
// non-decreasing `_idHighWater` so the mark survives the freeing write.
//
// Backward-compatibility: a legacy ledger has no `_idHighWater`. We derive the
// effective mark from `max(liveMax, storedHighWater ?? 0)`, so the first write
// on a legacy ledger behaves identically to the old `max+1` AND seeds the field.
//
// ID-148.10: applies to task-list/backlog only — see `liveCollectionIds` below.

/** The numeric ids currently present in a document's top-level id-collection. */
function liveCollectionIds(detected: KnownDetected): number[] {
  let ids: string[] = [];
  if (detected.kind === "task-list") ids = detected.data.tasks.map((t) => t.id);
  else if (detected.kind === "backlog")
    ids = detected.data.items.map((it) => it.id);
  return ids.map((id) => Number(id)).filter((n) => !Number.isNaN(n));
}

/** Read the persisted `_idHighWater` off a parsed document (0 when absent). */
function storedHighWater(detected: KnownDetected): number {
  const hw = (detected.data as { _idHighWater?: unknown })._idHighWater;
  return typeof hw === "number" && Number.isFinite(hw) && hw >= 0 ? hw : 0;
}

/**
 * The effective high-water mark = max(live numeric max, stored high-water).
 * Tasks/items are 1-based; an empty + un-seeded document has effective
 * mark 0 so the first allocation is 1 (unchanged from the legacy contract).
 */
export function effectiveHighWater(detected: KnownDetected): number {
  const live = liveCollectionIds(detected);
  const liveMax = live.length === 0 ? 0 : Math.max(...live);
  return Math.max(liveMax, storedHighWater(detected));
}

/** The next id to allocate = effectiveHighWater + 1 (numeric). */
function nextHighWaterAlloc(detected: KnownDetected): number {
  return effectiveHighWater(detected) + 1;
}

/**
 * Stamp a non-decreasing `_idHighWater` onto a RAW (plain-object) document
 * clone in place. `candidate` is the id that may advance the mark (e.g. the id
 * just inserted, or — on delete/promote — the pre-mutation live max, so the
 * freed top id is recorded before it disappears). The field is only ever raised,
 * never lowered, and is always seeded (legacy ledgers gain it on first write).
 */
function stampHighWater(
  rawClone: Record<string, unknown>,
  priorEffective: number,
  candidate: number,
): void {
  const next = Math.max(
    priorEffective,
    Number.isFinite(candidate) ? candidate : 0,
  );
  rawClone._idHighWater = next;
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
