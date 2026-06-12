/**
 * scoped-serialise.ts — minimal-diff ("scoped") write mode for the workflow
 * ledgers (ID-90 U1). PORTED from Knowledge Hub `lib/ledger/scoped-serialise.ts`
 * (KH-authored, ID-35.11) and extended with the umbrellas walk
 * (`['umbrellas', id, field]` — PRODUCT invariant 52).
 *
 * ── The problem ────────────────────────────────────────────────────────────────
 * A whole-file `JSON.stringify(detected.data, null, 2)` write (the retired
 * `serialiseLedger`) has TWO defects that make any single-field mutation touch
 * thousands of unrelated lines in a shared ledger file:
 *
 *   1. Key-order normalisation — `detectSchema`/Zod `.parse()` returns objects in
 *      schema-declared key order, so EVERY record's keys get reordered, not just
 *      the mutated one.
 *   2. Unicode-escaping divergence (the larger defect) — the on-disk ledger
 *      escapes ALL non-ASCII to `\uXXXX` (em-dashes, section signs, arrows, ...);
 *      plain `JSON.stringify` emits raw UTF-8. A whole-file write therefore
 *      reformats every record that contains those characters.
 *
 * Either defect alone turns a one-field edit into a ~1417-line diff (PRODUCT
 * invariant 19 — RESEARCH §1.3 defect class), which collides with sibling
 * sessions editing the same shared file.
 *
 * ── The fix ─────────────────────────────────────────────────────────────────────
 * Scoped write operates on the `JSON.parse` of the **ORIGINAL on-disk text**
 * (NOT the Zod-reparsed `detected.data`): it applies the field mutation to that
 * parsed-original in place (preserving every record's on-disk key order) and
 * serialises with non-ASCII escaping to match the on-disk convention. A no-op
 * `parse -> escape-serialise` round-trip on a conforming ledger is
 * byte-identical, so applying ONE field mutation touches only that record's
 * lines; every untouched record stays byte-for-byte identical.
 *
 * Zod still validates: callers run `detectSchema` / `applyPatches` on the mutated
 * document to hard-fail schema violations. But the bytes WRITTEN come from the
 * parsed-original-mutated doc, not the Zod-reparsed one.
 *
 * Post-OQ-LS-2 (KH S270) the on-disk ledgers are normalised so the scoped and
 * whole-file (`escapeSerialise(detected.data)`) paths are byte-compatible for
 * ongoing writes (PRODUCT invariant 20).
 *
 * ── Umbrellas (U1 extension) ────────────────────────────────────────────────────
 * `umbrellas.json` (document_name: "umbrellas") is discriminated by
 * `detectSchema` directly — U8 (ID-90 record 10) registered `'umbrellas'` as
 * the fourth `KNOWN_DOCUMENT_NAMES` literal in detect-schema.ts, retiring the
 * local `UmbrellasSchema` pre-check this module carried between records 6 and
 * 10. Umbrella membership edits are field patches on `['umbrellas', id,
 * field]` (invariant 50: splices do not apply — the umbrella id-set is
 * mutated via membership fields, not record insert/remove).
 */

import { detectSchema, type DetectSchemaResult } from "./detect-schema";
import { applyValueToLeaf, type FieldPatch } from "./patch-apply";

// ── document-kind discrimination ─────────────────────────────────────────────────

/**
 * The document kinds the scoped serialiser can walk — every known
 * detect-schema kind (U8 registered `'umbrellas'` as the fourth, so the
 * record-6 local extension union is retired in favour of the registry).
 */
export type ScopedDocumentKind = Exclude<DetectSchemaResult["kind"], "unknown">;

type ScopedDetectResult =
  | { kind: ScopedDocumentKind }
  | { kind: "unknown"; documentName: string | null };

/**
 * Discriminate + validate a parsed-JSON value for scoped serialisation.
 * Delegates to `detectSchema` for all four known kinds (the record-6 local
 * umbrellas pre-check is retired — the U8 registration supersedes it).
 * Throws `ZodError` when the document matches a kind but fails its schema —
 * identical contract to `detectSchema`.
 */
function detectScopedKind(parsed: unknown): ScopedDetectResult {
  const detected = detectSchema(parsed);
  if (detected.kind === "unknown") {
    return { kind: "unknown", documentName: detected.documentName };
  }
  return { kind: detected.kind };
}

// ── non-ASCII escaping ──────────────────────────────────────────────────────────
//
// Build the regex from an ASCII-ONLY string source, never a regex literal
// containing high characters: a heredoc/editor would mangle a literal high
// range. Per-UTF-16-code-unit `charCodeAt` matches Python `ensure_ascii=True`
// (astral chars are already surrogate pairs in the JS string, so each unit is
// escaped to its own `\uXXXX`).
//
// ID-90 F5/Bug2: the lower bound is `` (DEL), NOT ``. Python's
// `json.dumps(..., ensure_ascii=True)` escapes DEL (U+007F) to ``, but
// `JSON.stringify` leaves it as a raw byte. A ledger value containing DEL
// therefore diverged the JS write from the on-disk (Python) convention,
// breaking byte-faithfulness on the scoped vs whole-file vs Python-regen
// paths. Escaping from  closes that gap. (Other C0 control chars below
// 0x7f are already escaped by `JSON.stringify` itself — \b\t\n\f\r as the
// short forms, the rest as \u00xx — so they need no widening here.)
const NON_ASCII = new RegExp("[\\u007f-\\uffff]", "g");

/**
 * Escape every non-ASCII code unit in `s` to its `\uXXXX` form, matching the
 * on-disk ledger convention (`JSON.stringify` with `ensure_ascii` semantics).
 * ASCII bytes are left untouched.
 */
export function escapeNonAscii(s: string): string {
  return s.replace(
    NON_ASCII,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

/**
 * Serialise a parsed-JSON value the way the on-disk ledgers are formatted:
 * 2-space indent, all non-ASCII escaped to `\uXXXX`, single trailing newline.
 * A no-op `parsedValue = JSON.parse(originalText)` round-trip through this
 * function is byte-identical to the original file (PRODUCT invariant 20).
 */
export function escapeSerialise(parsedValue: unknown): string {
  return escapeNonAscii(JSON.stringify(parsedValue, null, 2)) + "\n";
}

// ── id-aware leaf walk on the PARSED-ORIGINAL (plain objects) ────────────────────
//
// Mirrors patch-apply.ts's FieldPath semantics, but operates on the plain
// `JSON.parse(originalText)` object (preserving on-disk key order) rather than
// the Zod-reparsed `detected.data`. Only resolves to the leaf container + key;
// schema validation is delegated to the post-mutation re-parse.

interface LeafTarget {
  container: Record<string, unknown>;
  key: string;
}

type WalkResult =
  | { ok: true; target: LeafTarget }
  | { ok: false; detail: string };

function asArray(value: unknown): Record<string, unknown>[] | null {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : null;
}

/**
 * Find a Task in the parsed-original `tasks[]` by its string id. Shared by the
 * field-patch walk ({@link walkTaskList}) and the subtask splice path
 * ({@link scopedSpliceSerialise}) so both resolve a Task identically. Returns
 * `null` when `tasks` is not an array or no Task carries the id.
 */
function findTaskById(
  doc: Record<string, unknown>,
  taskId: string,
): Record<string, unknown> | null {
  const tasks = asArray(doc.tasks);
  return tasks?.find((t) => t.id === taskId) ?? null;
}

function walkTaskList(
  doc: Record<string, unknown>,
  path: string[],
): WalkResult {
  const [head, taskId, ...afterTask] = path;
  if (head !== "tasks") {
    return { ok: false, detail: `Task-list patches must start with 'tasks'.` };
  }
  if (taskId == null || taskId === "") {
    return { ok: false, detail: "Missing task id at fieldPath[1]." };
  }
  const task = findTaskById(doc, taskId);
  if (!task) {
    return { ok: false, detail: `Task id "${taskId}" not found.` };
  }
  if (afterTask.length === 1) {
    return { ok: true, target: { container: task, key: afterTask[0] } };
  }
  if (afterTask.length >= 2 && afterTask[0] === "subtasks") {
    const subIdRaw = afterTask[1];
    if (!/^\d+$/.test(subIdRaw)) {
      return {
        ok: false,
        detail: `Subtask id "${subIdRaw}" is not a digit-string id.`,
      };
    }
    const subtasks = asArray(task.subtasks);
    const sub = subtasks?.find((s) => s.id === subIdRaw);
    if (!sub) {
      return {
        ok: false,
        detail: `Subtask id ${subIdRaw} not found in Task ${taskId}.`,
      };
    }
    const rest = afterTask.slice(2);
    if (rest.length !== 1) {
      return { ok: false, detail: `Subtask fieldPath must address one field.` };
    }
    return { ok: true, target: { container: sub, key: rest[0] } };
  }
  return { ok: false, detail: `Unsupported task-list fieldPath shape.` };
}

function walkRecordCollection(
  doc: Record<string, unknown>,
  collectionKey: "themes" | "items" | "umbrellas" | "retros",
  path: string[],
): WalkResult {
  const [head, recordId, ...rest] = path;
  if (head !== collectionKey) {
    return { ok: false, detail: `Patches must start with '${collectionKey}'.` };
  }
  if (recordId == null || recordId === "") {
    return { ok: false, detail: "Missing record id at fieldPath[1]." };
  }
  const records = asArray(doc[collectionKey]);
  const record = records?.find((r) => r.id === recordId);
  if (!record) {
    return { ok: false, detail: `Record id "${recordId}" not found.` };
  }
  if (rest.length !== 1) {
    return {
      ok: false,
      detail: `fieldPath must address one field after the id.`,
    };
  }
  return { ok: true, target: { container: record, key: rest[0] } };
}

function resolveLeaf(
  kind: ScopedDocumentKind,
  doc: Record<string, unknown>,
  path: string[],
): WalkResult {
  if (kind === "task-list") return walkTaskList(doc, path);
  if (kind === "roadmap") return walkRecordCollection(doc, "themes", path);
  if (kind === "umbrellas") {
    return walkRecordCollection(doc, "umbrellas", path);
  }
  // WS-C C2: retros — `['retros', id, field]` record walk.
  if (kind === "retro") {
    return walkRecordCollection(doc, "retros", path);
  }
  return walkRecordCollection(doc, "items", path);
}

// ── public scoped-serialise API ──────────────────────────────────────────────────

export type ScopedSerialiseResult =
  | {
      ok: true;
      text: string;
      kind: ScopedDocumentKind;
    }
  | { ok: false; kind: "unknown-document"; detail?: string }
  | { ok: false; kind: "walk-error"; detail: string }
  | { ok: false; kind: "schema-error"; error: unknown };

/**
 * Given the ORIGINAL on-disk ledger text and a single {@link FieldPatch}, return
 * the scoped-write output text:
 *
 *   - byte-identical for every record NOT addressed by the patch (preserving each
 *     record's on-disk key order),
 *   - non-ASCII escaped to `\uXXXX` (on-disk convention preserved),
 *   - exactly one trailing newline.
 *
 * Validation: the mutated parsed-original is run through the matching Zod
 * schema BEFORE the text is returned, so a schema-violating mutation fails with
 * `{ ok: false, kind: 'schema-error' }` and no caller ever writes invalid
 * bytes. The original text is parsed fresh inside this function — never
 * re-read from disk after a mutation.
 */
export function scopedSerialise(
  originalText: string,
  patch: FieldPatch,
): ScopedSerialiseResult {
  const parsed = JSON.parse(originalText) as Record<string, unknown>;

  // Discriminate against the parsed-original (does NOT mutate it).
  const detected = detectScopedKind(parsed);
  if (detected.kind === "unknown") {
    return {
      ok: false,
      kind: "unknown-document",
      detail: detected.documentName ?? undefined,
    };
  }

  const walked = resolveLeaf(detected.kind, parsed, patch.fieldPath);
  if (!walked.ok) {
    return { ok: false, kind: "walk-error", detail: walked.detail };
  }

  // Apply the leaf mutation to the parsed-ORIGINAL in place (on-disk key order
  // preserved); untouched records keep their exact bytes. The shared
  // applyValueToLeaf helper (patch-apply.ts) handles BOTH ops — newValue
  // replacement and ID-90 U6 appendText concatenation at apply time — so the
  // typed-oracle and parsed-original paths can never drift (invariant 39).
  const applyErr = applyValueToLeaf(
    walked.target.container,
    walked.target.key,
    patch,
  );
  if (applyErr) {
    return { ok: false, kind: "walk-error", detail: applyErr };
  }

  // Hard-fail schema violations before emitting any bytes. detectScopedKind
  // runs the matching Zod `.parse()` and throws ZodError on violation.
  try {
    detectScopedKind(parsed);
  } catch (error) {
    return { ok: false, kind: "schema-error", error };
  }

  return { ok: true, text: escapeSerialise(parsed), kind: detected.kind };
}

// ── record-level splice (insert / remove) ────────────────────────────────────────
//
// Parallel to scopedSerialise's FIELD-patch mode: instead of mutating one leaf,
// this splices a WHOLE record into/out of a collection on the parsed-ORIGINAL
// (never `detected.data`), so every untouched record keeps its on-disk key order
// + bytes. This is the foundation primitive for scoped creates/promotes — the
// whole-file oracle (record-mutate.ts) stays the schema-validation oracle.

/** Top-level record collections, keyed per ledger kind. WS-C C2 adds
 * `retros` (the session-retro top-level collection). */
type SpliceCollection = "tasks" | "themes" | "items" | "retros" | "subtasks";

/**
 * A record-level splice operation against a parsed-original ledger.
 *
 *   - `insert` pushes `record` onto the resolved collection array. For
 *     `collection: 'subtasks'`, `taskId` addresses the parent Task whose
 *     `subtasks[]` receives the record.
 *   - `remove` drops the record whose id matches `recordId` from the resolved
 *     collection. All record ids are bare-digit STRINGS — top-level
 *     (`tasks`/`themes`/`items`) and subtasks alike. The `string | number`
 *     union is retained for back-compat with any pre-flip caller, but
 *     KH's subtask-delete intent now carries `recordId` as a digit-string.
 */
export type SpliceOp =
  | {
      kind: "insert";
      collection: SpliceCollection;
      taskId?: string;
      record: unknown;
    }
  | {
      kind: "remove";
      collection: SpliceCollection;
      taskId?: string;
      recordId: string | number;
    };

export type ScopedSpliceResult =
  | {
      ok: true;
      text: string;
      kind: ScopedDocumentKind;
    }
  | { ok: false; kind: "unknown-document"; detail?: string }
  | { ok: false; kind: "walk-error"; detail: string }
  | { ok: false; kind: "schema-error"; error: unknown };

/**
 * Resolve the mutable record-array a splice op addresses on the parsed-original.
 * For `subtasks`, walks into the addressed Task's `subtasks[]`; for the three
 * top-level collections, returns the document-level array. Returns a
 * `walk-error` detail when the addressed Task is missing or the collection is
 * absent / not an array.
 */
function resolveSpliceCollection(
  doc: Record<string, unknown>,
  op: SpliceOp,
):
  | { ok: true; collection: Record<string, unknown>[] }
  | { ok: false; detail: string } {
  if (op.collection === "subtasks") {
    if (op.taskId == null || op.taskId === "") {
      return {
        ok: false,
        detail: `Missing taskId for a 'subtasks' splice.`,
      };
    }
    const task = findTaskById(doc, op.taskId);
    if (!task) {
      return { ok: false, detail: `Task id "${op.taskId}" not found.` };
    }
    const subtasks = asArray(task.subtasks);
    if (!subtasks) {
      return {
        ok: false,
        detail: `Task "${op.taskId}" is missing its "subtasks" array.`,
      };
    }
    return { ok: true, collection: subtasks };
  }

  const collection = asArray(doc[op.collection]);
  if (!collection) {
    return {
      ok: false,
      detail: `Ledger is missing its "${op.collection}" array.`,
    };
  }
  return { ok: true, collection };
}

/**
 * Given the ORIGINAL on-disk ledger text and a record-level {@link SpliceOp},
 * return the scoped-write output text with one record inserted or removed:
 *
 *   - byte-identical for every record NOT touched by the splice (preserving each
 *     record's on-disk key order),
 *   - non-ASCII escaped to `\uXXXX` (on-disk convention preserved),
 *   - exactly one trailing newline.
 *
 * Validation mirrors {@link scopedSerialise}: the mutated parsed-original runs
 * through the matching Zod `.parse()` BEFORE the text is returned, so a
 * schema-violating splice fails with `{ ok: false, kind: 'schema-error' }` and
 * no caller ever writes invalid bytes. The original text is parsed fresh inside
 * this function — never re-read from disk after a mutation.
 *
 * This is a PARALLEL plain-parse splice to record-mutate.ts's
 * `insertRecord`/`removeRecord` (which structuredClone + Zod-reparse the WHOLE
 * doc). It does NOT replicate that path's duplicate-id / record-not-found
 * discriminants — uniqueness/presence enforcement stays with the whole-file
 * oracle. For `remove`, a non-matching id is a silent no-op (filter removes
 * nothing) which still re-validates and round-trips.
 */
export function scopedSpliceSerialise(
  originalText: string,
  op: SpliceOp,
): ScopedSpliceResult {
  const parsed = JSON.parse(originalText) as Record<string, unknown>;

  // Discriminate against the parsed-original (does NOT mutate it).
  const detected = detectScopedKind(parsed);
  if (detected.kind === "unknown") {
    return {
      ok: false,
      kind: "unknown-document",
      detail: detected.documentName ?? undefined,
    };
  }

  const resolved = resolveSpliceCollection(parsed, op);
  if (!resolved.ok) {
    return { ok: false, kind: "walk-error", detail: resolved.detail };
  }
  const { collection } = resolved;

  if (op.kind === "insert") {
    // Mutate the parsed-ORIGINAL array in place; untouched records keep bytes.
    collection.push(op.record as Record<string, unknown>);
  } else {
    // Filter in place. All record ids — subtask and top-level — are now
    // digit-strings, so the strict `===` below is a string-vs-string compare
    // (subtask-delete carries `recordId` as the digit-string subId from KH).
    const kept = collection.filter((rec) => rec.id !== op.recordId);
    collection.length = 0;
    for (const rec of kept) collection.push(rec);
  }

  // Hard-fail schema violations before emitting any bytes. detectScopedKind
  // runs the matching Zod `.parse()` and throws ZodError on violation.
  try {
    detectScopedKind(parsed);
  } catch (error) {
    return { ok: false, kind: "schema-error", error };
  }

  return { ok: true, text: escapeSerialise(parsed), kind: detected.kind };
}
