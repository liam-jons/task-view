/**
 * gates/record-set-gate.ts — ID-90 U3 server-side record-set-preservation
 * write gate.
 *
 * Port of the KH ledger-CLI gate (`collectionIds`/`assertRecordSet`/
 * `checkRecordSet`, scripts/ledger-cli.ts — ID-35.16/65.6) onto the
 * patch-server's mutation handlers.
 *
 * The single most severe wrong-shape write is a SILENTLY DROPPED (or
 * duplicated) record: Zod re-validates the survivors and passes, the mirror
 * regen renders the smaller set, and the only trace is a record that ceased
 * to exist. The budget gate cannot catch this — it inspects the changed
 * record's fields, not the collection's membership. This gate asserts the
 * post-write id-set equals the pre-write set under the intended delta, and
 * CRUCIALLY derives the post-write ids from the BYTES ABOUT TO BE WRITTEN
 * (parsing the serialiser output string), so a serialise-side defect
 * (key-reorder / escaping / splice bug) is caught one step before it lands.
 *
 * Hook point: POST-SERIALISATION / PRE-`atomicWriteFile` in every mutating
 * handler — on the exact bytes about to land (PRODUCT invariant 22). Deltas
 * per operation: PATCH / umbrella-PATCH `none`; POST record/subtask `add`
 * (`add-many` bulk); DELETE `remove`; promote per-leg at stage time:
 * task-list `+1`, backlog `−1`, roadmap `∅` (invariant 23). A violation
 * rejects with `record-set-violation` and NOTHING is written.
 */

import type { DetectSchemaResult } from "../detect-schema";

type KnownDetected = Exclude<DetectSchemaResult, { kind: "unknown" }>;

export type IdValue = string | number;

/** Intended change to a collection's id-set across a single write.
 *
 * `add-many` covers bulk subtask adds (the U5 seam) — N ids added in ONE
 * scoped multi-splice. The gate adds EVERY id in `ids` to the expected
 * post-write set, so a serialise-side drop/duplicate anywhere in the batch
 * is caught before the single write lands. */
export type RecordSetDelta =
  | { kind: "none" }
  | { kind: "add"; id: IdValue }
  | { kind: "add-many"; ids: IdValue[] }
  | { kind: "remove"; id: IdValue };

/**
 * A collection descriptor: which id-set inside a parsed ledger document the
 * gate guards. Top-level collections (`tasks` / `themes` / `items` /
 * `umbrellas`) guard the record-level id-set; `subtasks` guards one task's
 * subtask id-set.
 *
 * ID-90.11: `umbrellas` added — the U8 registration left the gate
 * descriptor without a fourth-kind arm, so every umbrellas membership
 * PATCH (the ONLY mutation the kind supports, PRODUCT invariants 49–50)
 * rejected with `record-set-violation: could not locate the items
 * collection`. The header above always intended "umbrella-PATCH `none`";
 * this closes that gap.
 */
export type CollectionDescriptor =
  | { collection: "tasks" | "themes" | "items" | "umbrellas" | "retros" }
  | { collection: "subtasks"; taskId: string };

/**
 * Extract the id-set of the descriptor's collection from an arbitrary parsed
 * ledger document (plain JSON — the parse of the bytes about to be written,
 * NOT the Zod-reparsed snapshot). Returns null when the collection cannot be
 * located (itself a violation the gate surfaces).
 */
export function collectionIds(
  parsed: unknown,
  descriptor: CollectionDescriptor,
): Set<IdValue> | null {
  if (!parsed || typeof parsed !== "object") return null;
  const doc = parsed as Record<string, unknown>;
  if (descriptor.collection === "subtasks") {
    const tasks = doc.tasks;
    if (!Array.isArray(tasks)) return null;
    const task = tasks.find(
      (t) => (t as { id?: unknown }).id === descriptor.taskId,
    ) as { subtasks?: unknown } | undefined;
    if (!task || !Array.isArray(task.subtasks)) return null;
    return new Set(task.subtasks.map((s) => (s as { id: IdValue }).id));
  }
  const arr = doc[descriptor.collection];
  if (!Array.isArray(arr)) return null;
  return new Set(arr.map((r) => (r as { id: IdValue }).id));
}

/**
 * Capture the pre-write id-set from the typed `detected` document at load
 * time. Must be called BEFORE the in-memory mutation for collections whose
 * membership changes; for field-edits the id-set is unchanged either way,
 * but capturing before is the safe discipline.
 */
export function beforeCollectionIds(
  detected: KnownDetected,
  descriptor: CollectionDescriptor,
): Set<IdValue> {
  if (descriptor.collection === "subtasks") {
    if (detected.kind !== "task-list") return new Set();
    const task = detected.data.tasks.find((t) => t.id === descriptor.taskId);
    return new Set((task?.subtasks ?? []).map((s) => s.id));
  }
  if (descriptor.collection === "tasks" && detected.kind === "task-list") {
    return new Set(detected.data.tasks.map((t) => t.id));
  }
  if (descriptor.collection === "themes" && detected.kind === "roadmap") {
    return new Set(detected.data.themes.map((t) => t.id));
  }
  if (descriptor.collection === "items" && detected.kind === "backlog") {
    return new Set(detected.data.items.map((it) => it.id));
  }
  if (descriptor.collection === "umbrellas" && detected.kind === "umbrellas") {
    return new Set(detected.data.umbrellas.map((u) => u.id));
  }
  // WS-C C2: retros — session-id record set.
  if (descriptor.collection === "retros" && detected.kind === "retro") {
    return new Set(detected.data.retros.map((r) => r.id));
  }
  return new Set();
}

export type RecordSetCheck = { ok: true } | { ok: false; detail: string };

/**
 * The core gate: assert `afterIds` equals `beforeIds` transformed by
 * `expectedDelta`. Reports the unexpectedly-missing and unexpectedly-present
 * ids on violation, so the operator sees exactly which record was dropped or
 * inserted.
 */
export function assertRecordSet(
  beforeIds: Set<IdValue>,
  afterIds: Set<IdValue>,
  expectedDelta: RecordSetDelta,
): RecordSetCheck {
  // The expected post-write id-set, derived from beforeIds + the intended delta.
  const expected = new Set<IdValue>(beforeIds);
  if (expectedDelta.kind === "add") expected.add(expectedDelta.id);
  else if (expectedDelta.kind === "add-many")
    for (const id of expectedDelta.ids) expected.add(id);
  else if (expectedDelta.kind === "remove") expected.delete(expectedDelta.id);

  const missing = [...expected].filter((id) => !afterIds.has(id));
  const unexpected = [...afterIds].filter((id) => !expected.has(id));

  if (missing.length === 0 && unexpected.length === 0) return { ok: true };

  const parts: string[] = [];
  if (missing.length) parts.push(`missing [${missing.join(", ")}]`);
  if (unexpected.length) parts.push(`unexpected [${unexpected.join(", ")}]`);
  return { ok: false, detail: parts.join(" / ") };
}

export type RecordSetGateResult =
  | { ok: true }
  | { ok: false; error: "record-set-violation"; detail: string };

/**
 * Run the record-set gate for one ledger write at the write gate: parse the
 * `content` about to be written, extract the descriptor's id-set, and assert
 * it against `beforeIds` under `expectedDelta`. Returns a
 * `record-set-violation` result on mismatch (the caller writes NOTHING) or
 * `{ ok: true }` to proceed.
 *
 * `ledgerLabel` names the ledger in the violation detail (e.g. `task-list`)
 * so cross-ledger transactions report which leg failed.
 */
export function checkRecordSet(
  ledgerLabel: string,
  content: string,
  beforeIds: Set<IdValue>,
  descriptor: CollectionDescriptor,
  expectedDelta: RecordSetDelta,
): RecordSetGateResult {
  let afterParsed: unknown;
  try {
    afterParsed = JSON.parse(content);
  } catch (err) {
    return {
      ok: false,
      error: "record-set-violation",
      detail: `${ledgerLabel}: serialised output is not valid JSON (${(err as Error).message})`,
    };
  }
  const afterIds = collectionIds(afterParsed, descriptor);
  if (afterIds === null) {
    return {
      ok: false,
      error: "record-set-violation",
      detail: `${ledgerLabel}: could not locate the ${descriptor.collection} collection in the serialised output`,
    };
  }
  const check = assertRecordSet(beforeIds, afterIds, expectedDelta);
  if (!check.ok) {
    return {
      ok: false,
      error: "record-set-violation",
      detail: `${ledgerLabel}: ${check.detail}`,
    };
  }
  return { ok: true };
}

/** Map a detected document kind to its top-level record collection. */
export function topLevelCollectionFor(
  kind: KnownDetected["kind"],
): CollectionDescriptor {
  if (kind === "task-list") return { collection: "tasks" };
  if (kind === "roadmap") return { collection: "themes" };
  // ID-90.11: the fourth kind's id-set lives under the `umbrellas` key —
  // the pre-U9 fallthrough to `items` made every umbrellas PATCH a
  // record-set-violation (see CollectionDescriptor note).
  if (kind === "umbrellas") return { collection: "umbrellas" };
  // WS-C C2: the retro kind's id-set lives under the `retros` key.
  if (kind === "retro") return { collection: "retros" };
  return { collection: "items" };
}
