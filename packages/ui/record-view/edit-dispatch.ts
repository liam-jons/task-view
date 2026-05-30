/**
 * record-view/edit-dispatch.ts — pure, kind-keyed dispatch core for the
 * progressive-enhancement hydration layer (ID-20.24).
 *
 * The SPA client (`apps/server/web/index.tsx`) is a GENERIC delegated
 * event dispatcher: it attaches ONE set of document-level listeners and
 * keys ALL behaviour on stable `data-*` hooks the SSR markup emits:
 *
 *   - `data-edit-action`  — "open" | "save" | "cancel"
 *   - `data-edit-kind`    — the editor variant (see {@link DispatchKind})
 *   - `data-edit-field`   — the FieldPath joined by ">"
 *   - `data-record-id`    — the top-level record id (closest ancestor)
 *   - `data-record-kind`  — "task" | "roadmap-theme" | "backlog-item" |
 *                            "*-index"
 *
 * This module is the pure, DOM-free, fully-unit-testable core: it turns
 * a `(kind, rawValue, fieldPath)` triple into a {@link FieldPatch} and a
 * PATCH request body, and parses the `data-edit-field` hook back into a
 * `FieldPath`. The DOM wiring (listeners, form construction, in-place
 * re-render) lives in the client shell on top of these helpers.
 *
 * EXTENSIBILITY CONTRACT (ID-20.25): 20.24 wires exactly one consumer
 * today — the Backlog-index rank pencil (`integer-nullable`). But the
 * dispatcher handles ALL kinds up-front. When 20.25 mounts the dead
 * `edit-affordances.tsx` form primitives (text / textarea / enum /
 * enum-nullable / array-comma / doc-links) into the per-record views,
 * those affordances carry the SAME `data-edit-kind` + `data-edit-field`
 * hooks — and `buildPatchForKind` already produces the correct
 * `FieldPatch` for each. 20.25 is therefore PURELY ADDITIVE on the
 * render side: zero client-dispatcher changes required.
 *
 * No React. No DOM. No I/O. All helpers are referentially transparent.
 */
import {
  buildArrayPatch,
  buildFieldPatch,
  parseCommaSeparatedNumbers,
  type FieldPatch,
  type FieldPath,
} from "./edit-state";

// ──────────────────────────────────────────────────────────────────────────────
// Dispatch kinds — superset of EditKind (edit-state.ts) plus the numeric
// variants the SSR affordances need that the form-primitive EditKind union
// does not yet model (rank is `z.number().int().nullable()`).
// ──────────────────────────────────────────────────────────────────────────────

/**
 * The full set of `data-edit-kind` values the dispatcher understands.
 *
 * The first six mirror `EditKind` from edit-state.ts (the form
 * primitives 20.25 mounts). The numeric variants are needed by SSR
 * affordances over integer fields:
 *   - `integer`          — a required integer field.
 *   - `integer-nullable` — an integer field that clears to `null` via an
 *                          empty input (e.g. Backlog `rank`, the ONLY
 *                          consumer wired in 20.24).
 *   - `array-comma-number` — a comma-separated list coerced to numbers
 *                          (e.g. Subtask `dependencies`, `z.number().int()`).
 */
export type DispatchKind =
  | "text"
  | "textarea"
  | "enum"
  | "enum-nullable"
  | "array-comma"
  | "array-comma-number"
  | "doc-links"
  | "integer"
  | "integer-nullable";

const DISPATCH_KINDS: ReadonlySet<string> = new Set<DispatchKind>([
  "text",
  "textarea",
  "enum",
  "enum-nullable",
  "array-comma",
  "array-comma-number",
  "doc-links",
  "integer",
  "integer-nullable",
]);

/** Narrow an arbitrary `data-edit-kind` string to a known DispatchKind. */
export function isDispatchKind(kind: string | null | undefined): kind is DispatchKind {
  return typeof kind === "string" && DISPATCH_KINDS.has(kind);
}

// ──────────────────────────────────────────────────────────────────────────────
// FieldPath <-> data-edit-field hook.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Parse the `data-edit-field` attribute back into a `FieldPath`.
 * The SSR markup emits `fieldPath.join(">")` (see edit-affordances.tsx
 * + backlog-index-view.tsx `items>{id}>rank`); this is the exact
 * inverse. Returns null for an absent/empty hook.
 */
export function parseFieldPathAttr(attr: string | null | undefined): FieldPath | null {
  if (typeof attr !== "string" || attr === "") return null;
  return attr.split(">");
}

// ──────────────────────────────────────────────────────────────────────────────
// Raw-input → FieldPatch, dispatched on kind.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * The parsed shape of a doc-links editor's collected rows (PRODUCT inv
 * 35). The client assembles this array from the per-row inputs before
 * calling `buildPatchForKind`; an empty `anchor` string serialises back
 * to `null` per the affordance contract.
 */
export interface DocLinkRowInput {
  path: string;
  anchor: string | null;
  raw: string;
}

/**
 * The raw value the client collects from the edit form, by kind:
 *   - text / textarea / enum / array-comma / array-comma-number /
 *     integer / integer-nullable → the input's string value.
 *   - enum-nullable → the string value, where "" means the nullable
 *     sentinel was selected (→ null).
 *   - doc-links → the assembled `DocLinkRowInput[]`.
 */
export type RawEditValue = string | readonly DocLinkRowInput[];

/**
 * Build a `FieldPatch` for the given editor kind + raw collected value.
 *
 * Reuses the canonical edit-state builders VERBATIM where they apply
 * (`buildFieldPatch` / `buildArrayPatch`) so the wire shape is identical
 * to the 20.10 helper contract (`{ fieldPath, newValue }`, with the
 * value key `newValue` — the server reads `patch.newValue`).
 *
 * Numeric coercion failures (a non-integer typed into an integer field)
 * emit `NaN`; we do NOT pre-reject — the server's Zod parse returns a
 * 422 the client renders inline (PRODUCT inv 29). This keeps validation
 * single-sourced on the schema.
 */
export function buildPatchForKind(
  kind: DispatchKind,
  fieldPath: FieldPath,
  rawValue: RawEditValue,
): FieldPatch {
  switch (kind) {
    case "text":
    case "textarea":
    case "enum":
      return buildFieldPatch(fieldPath, asString(rawValue));

    case "enum-nullable": {
      // "" sentinel → null (the affordance's `data-nullable-sentinel`).
      const v = asString(rawValue);
      return buildFieldPatch(fieldPath, v === "" ? null : v);
    }

    case "array-comma":
      return buildArrayPatch(fieldPath, asString(rawValue));

    case "array-comma-number":
      return buildFieldPatch(
        fieldPath,
        parseCommaSeparatedNumbers(asString(rawValue)),
      );

    case "integer": {
      const v = asString(rawValue).trim();
      return buildFieldPatch(fieldPath, Number(v));
    }

    case "integer-nullable": {
      const v = asString(rawValue).trim();
      // Empty input clears the field to null (e.g. Backlog rank "(unset)").
      return buildFieldPatch(fieldPath, v === "" ? null : Number(v));
    }

    case "doc-links": {
      const rows = Array.isArray(rawValue) ? rawValue : [];
      const normalised = rows.map((row) => ({
        path: row.path,
        // Empty anchor input serialises back to null per inv 35.
        anchor: row.anchor === "" || row.anchor === null ? null : row.anchor,
        raw: row.raw,
      }));
      return buildFieldPatch(fieldPath, normalised);
    }

    default: {
      const _exhaustive: never = kind;
      throw new Error(`Unknown DispatchKind: ${String(_exhaustive)}`);
    }
  }
}

function asString(v: RawEditValue): string {
  return typeof v === "string" ? v : "";
}

// ──────────────────────────────────────────────────────────────────────────────
// PATCH request body — matches handlePatchRecord's contract.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * The JSON body for `PATCH /api/ledger/record/:recordId`. The server
 * (handlePatchRecord) requires `{ patches: FieldPatch[], baseMtime }`.
 * Supports the multi-field save shape (PRODUCT inv 38) — a single PATCH
 * may carry N patches — even though the rank consumer sends exactly one.
 */
export interface PatchRequestBody {
  patches: FieldPatch[];
  baseMtime: string;
}

/** Assemble a single-patch PATCH request body. */
export function buildPatchRequest(
  patch: FieldPatch,
  baseMtime: string,
): PatchRequestBody {
  return { patches: [patch], baseMtime };
}

/** Assemble a multi-patch PATCH request body (PRODUCT inv 38). */
export function buildMultiPatchRequest(
  patches: readonly FieldPatch[],
  baseMtime: string,
): PatchRequestBody {
  return { patches: [...patches], baseMtime };
}

/**
 * Derive the PATCH URL for a record. The route is
 * `/api/ledger/record/:recordId` with the id URL-encoded (the server
 * `decodeURIComponent`s it back). Record id comes from the closest
 * `data-record-id` ancestor.
 */
export function recordPatchPath(recordId: string): string {
  return `/api/ledger/record/${encodeURIComponent(recordId)}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// DELETE request — matches handleDeleteRecord's contract.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * The JSON body for `DELETE /api/ledger/record/:recordId`. The server
 * (handleDeleteRecord) reads exactly one field — `baseMtime`, the ISO
 * mtime STRING it `Date.parse`s for the optimistic-concurrency guard
 * (a 409 `mtime-mismatch` when the on-disk ledger is newer). No body
 * other than `baseMtime` is consumed.
 */
export interface DeleteRequestBody {
  baseMtime: string;
}

/** Assemble the DELETE request body from the current base mtime. */
export function buildDeleteRequest(baseMtime: string): DeleteRequestBody {
  return { baseMtime };
}

/**
 * Derive the DELETE URL for a record. The server routes GET / PATCH /
 * DELETE on the SAME `/api/ledger/record/:recordId` path, so this is
 * identical to {@link recordPatchPath}; kept as a named export so call
 * sites read intent-first.
 */
export function recordDeletePath(recordId: string): string {
  return `/api/ledger/record/${encodeURIComponent(recordId)}`;
}
