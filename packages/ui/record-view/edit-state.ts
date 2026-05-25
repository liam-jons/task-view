/**
 * record-view/edit-state.ts — pure helpers for ID-20.10 edit affordances
 * (PRODUCT inv 26-35 + 51, TECH §4.1 + §5.1).
 *
 * The viewer is rendered as static SSR markup (no DOM mount in tests);
 * edit-mode behaviour is exposed via:
 *
 *   1. Per-row `EditDescriptor` shape that view components emit when
 *      the corresponding field is in edit mode. The descriptor carries
 *      `data-*` attribute hooks the SPA layer reads to wire keyboard
 *      shortcuts, save/cancel handlers, and localStorage drafts.
 *   2. Pure helper functions in this module: build `FieldPatch[]` per
 *      TECH §5.1 wire format, parse comma-separated id arrays per
 *      PRODUCT inv 34, format inline `ZodError` messages per inv 29,
 *      derive localStorage draft keys per inv 51.
 *
 * No React. No DOM. No I/O. All helpers are referentially transparent
 * — fully unit-testable from the SSR test harness.
 */
import type { ZodError } from "zod";

// ──────────────────────────────────────────────────────────────────────────────
// Public types — shared across view components + SPA hydration layer.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Identifies a single editable leaf within the canonical JSON ledger.
 * Matches the `fieldPath` shape from TECH §5.1 — used both as a draft
 * lookup key (localStorage per inv 51) and as the `fieldPath` payload
 * of the structured patch sent to the server.
 *
 * Examples:
 *   - `['tasks', '20', 'description']`
 *   - `['tasks', '20', 'subtasks', '10', 'details']`
 *   - `['tasks', '20', 'dependencies']`  (array — replaced wholesale)
 *   - `['sections', '3.1', 'items', 'ID-30', 'priority']`
 *
 * The first segment is always the top-level array property
 * (`tasks` / `sections` / `items`) per TECH §5.1; deeper segments are
 * id strings (Task id is a string; Subtask id is an integer-as-string;
 * Roadmap section id is `§N.M`; Backlog item id is the canonical id).
 */
export type FieldPath = readonly string[];

/**
 * The patch body sent to `PATCH /api/ledger/record/:recordId` per TECH
 * §5.1. Matches the server-side `FieldPatch` type exactly so we can
 * round-trip the wire format with no transformation.
 */
export interface FieldPatch {
  fieldPath: string[];
  newValue: unknown;
}

/**
 * Kinds of editable surface. Drives which form element the view emits
 * + which validator the helper applies before round-tripping.
 */
export type EditKind =
  | "text" /** Single-line free text (e.g. effort_estimate, owner, phase_label). */
  | "textarea" /** Multi-line free Markdown (e.g. description, narrative, notes, details). */
  | "enum" /** Zod-enum dropdown (e.g. status, priority, type). */
  | "enum-nullable" /** Zod-enum dropdown + "(unset)" sentinel for null. */
  | "array-comma" /** Comma-separated id array (e.g. dependencies, session_refs). */
  | "doc-links" /** Per-entry form for `cross_doc_links[]` of DocLinkSchema. */;

/**
 * Describes a single field's edit-mode markup. View components consume
 * this to decide between "render value" vs "render edit form". The SPA
 * hydration layer reads the `data-*` attribute hooks to wire handlers.
 */
export interface EditDescriptor {
  /** Field identifier — also serves as the `data-edit-field` attribute. */
  fieldPath: FieldPath;
  /** Determines which form element + validator to use. */
  kind: EditKind;
  /**
   * Current draft value. For text/textarea: the raw string. For enum:
   * the selected enum literal (or null for nullable + unset). For
   * array-comma: the rendered comma-joined string. For doc-links: the
   * array of DocLink-shaped objects.
   */
  draft: unknown;
  /**
   * For `enum` + `enum-nullable` only — the allowed values to render
   * as `<option>` children. PRODUCT inv 31 mandates sourcing from
   * `._def.values` of the canonical Zod enum at render time, not from
   * a hard-coded list. Caller passes the enum's `.options` directly.
   */
  enumOptions?: readonly string[];
  /**
   * Optional inline server error message (e.g. Zod parse failure).
   * When present, the view renders the message below the form
   * element + leaves the form OPEN per PRODUCT inv 29.
   */
  errorMessage?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// FieldPatch construction — matches TECH §5.1 wire format exactly.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Build a FieldPatch for a free-text or enum edit. The shape is
 * passthrough — `newValue` goes onto the wire verbatim (server-side
 * Zod validates per the schema).
 */
export function buildFieldPatch(
  fieldPath: FieldPath,
  newValue: unknown,
): FieldPatch {
  return { fieldPath: [...fieldPath], newValue };
}

/**
 * Build a FieldPatch for a comma-separated array edit (PRODUCT inv 34).
 * Splits on `,`, trims whitespace from each element, drops empty
 * entries. Does NOT validate ids; that's the server-side Zod schema's
 * job. Sibling-only checks (Subtask.dependencies) live in the
 * schema's superRefine — the server will reject malformed entries
 * with a `ZodError` which the viewer displays inline per inv 29.
 *
 * Examples:
 *   "20, 19, 18"     → ["20", "19", "18"]
 *   "20,,19"         → ["20", "19"]
 *   "  20  ,  19  "  → ["20", "19"]
 *   ""               → []
 *   ",,,"            → []
 */
export function buildArrayPatch(
  fieldPath: FieldPath,
  rawCommaSeparated: string,
): FieldPatch {
  const items = parseCommaSeparatedIds(rawCommaSeparated);
  return { fieldPath: [...fieldPath], newValue: items };
}

/**
 * Pure parser for the comma-separated id input convention. Trims +
 * filters empty per the contract above.
 */
export function parseCommaSeparatedIds(raw: string): string[] {
  if (raw === "") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Same shape as parseCommaSeparatedIds but returns numbers — used for
 * Subtask.dependencies which is `z.array(z.number().int())` per the
 * schema. Numeric coercion failures emit `NaN` which Zod rejects
 * downstream; we don't pre-filter (let the server's `ZodError` carry
 * the precise message).
 */
export function parseCommaSeparatedNumbers(raw: string): number[] {
  return parseCommaSeparatedIds(raw).map((s) => Number(s));
}

// ──────────────────────────────────────────────────────────────────────────────
// Zod error formatting — produces a one-line inline message per inv 29.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Convert a `ZodError` to a single inline message suitable for display
 * near the form element that failed validation. Picks the first issue
 * (the user will see all of them on subsequent saves as they fix each
 * one). UK-English neutral — the message body comes from Zod itself
 * which is locale-neutral.
 *
 * Examples:
 *   - "subtasks[0].status: Invalid enum value. Expected 'done' | …"
 *   - "dependencies: ID-99 does not match a sibling Subtask"
 *   - "cross_doc_links[2].path: String must contain at least 1 character"
 */
export function formatZodErrorInline(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Validation failed (no issue detail available).";
  const path = issue.path.length === 0 ? "(root)" : issue.path.join(".");
  return `${path}: ${issue.message}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// localStorage draft keys — preserve unsaved edits per PRODUCT inv 51.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Derive the localStorage key for a draft per PRODUCT inv 51:
 * "browser localStorage keyed by `{ledgerPath, recordId, fieldPath}`".
 *
 * Format: `task-view-draft:<ledgerPath>:<recordId>:<fieldPath>`
 *   - `ledgerPath` is the absolute path to the canonical JSON
 *     (already URL-decoded by the viewer; we don't re-encode).
 *   - `recordId` is the top-level record id (e.g. Task "20").
 *   - `fieldPath` is the full `FieldPath` joined by `>`. We use `>`
 *     (not `.`) so dotted field names like `cross_doc_links` stay
 *     distinguishable from path-separator. Per the test contract this
 *     key is opaque — only `getDraftKey` ever constructs or compares
 *     them.
 *
 * Examples (UK-English ledger path):
 *   getDraftKey('/repo/docs/reference/task-list.json', '20',
 *               ['tasks', '20', 'description'])
 *   → "task-view-draft:/repo/docs/reference/task-list.json:20:tasks>20>description"
 */
export function getDraftKey(
  ledgerPath: string,
  recordId: string,
  fieldPath: FieldPath,
): string {
  return `task-view-draft:${ledgerPath}:${recordId}:${fieldPath.join(">")}`;
}

/**
 * In-memory + localStorage shim for draft storage. The SPA layer
 * wraps `window.localStorage` at runtime; tests substitute a
 * `Map<string, string>` for full control.
 */
export interface DraftStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/**
 * In-memory `DraftStore` for tests. Mirrors `window.localStorage`
 * surface exactly.
 */
export function createMemoryDraftStore(): DraftStore {
  const data = new Map<string, string>();
  return {
    get(key) {
      return data.has(key) ? (data.get(key) as string) : null;
    },
    set(key, value) {
      data.set(key, value);
    },
    remove(key) {
      data.delete(key);
    },
  };
}

/**
 * Save a draft for a failed save (PRODUCT inv 51). Idempotent — caller
 * re-invokes on each keystroke (or on save-failure) without de-duping.
 */
export function saveDraft(
  store: DraftStore,
  ledgerPath: string,
  recordId: string,
  fieldPath: FieldPath,
  draftValue: string,
): void {
  store.set(getDraftKey(ledgerPath, recordId, fieldPath), draftValue);
}

/**
 * Load a draft for re-population on record reload (PRODUCT inv 51).
 * Returns `null` when no draft exists for the triple.
 */
export function loadDraft(
  store: DraftStore,
  ledgerPath: string,
  recordId: string,
  fieldPath: FieldPath,
): string | null {
  return store.get(getDraftKey(ledgerPath, recordId, fieldPath));
}

/**
 * Clear a draft on successful save of the same `{ledgerPath, recordId,
 * fieldPath}` triple per PRODUCT inv 51 last sentence.
 */
export function clearDraft(
  store: DraftStore,
  ledgerPath: string,
  recordId: string,
  fieldPath: FieldPath,
): void {
  store.remove(getDraftKey(ledgerPath, recordId, fieldPath));
}

// ──────────────────────────────────────────────────────────────────────────────
// Server-error classification — used to drive draft preservation
// (PRODUCT inv 51 only triggers on FAILED saves; successful saves clear
// drafts).
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Save-attempt outcomes the viewer must distinguish. The SPA layer
 * passes its server response through `classifySaveResult` to decide
 * which post-save behaviour to fire (draft clear vs draft save vs
 * inline-error display).
 *
 * `ok` carries the server's `newMtime` so the hydration layer can adopt
 * it as the next `baseMtime` (optimistic concurrency, TECH §5.4).
 *
 * `mtime-conflict` carries the server's `currentMtime` so the SPA can
 * re-base a "Reload from disk" against the latest mtime (PRODUCT inv 37).
 *
 * `mirror-regen-failed` is a SOFT outcome: the canonical DID persist
 * (`canonicalWritten: true`) and the server returned `newMtime`; only
 * the on-disk mirror regen failed. The SPA treats the field edit as
 * saved (adopt `newMtime`, clear the draft) and may re-issue
 * `POST /api/ledger/regen` in the background — it must NOT surface a
 * hard "save failed" error.
 */
export type SaveOutcome =
  | { kind: "ok"; newMtime?: string }
  | { kind: "schema-error"; message: string }
  | { kind: "mtime-conflict"; message: string; currentMtime?: string }
  | { kind: "walk-error"; message: string }
  | { kind: "mirror-regen-failed"; message: string; newMtime?: string }
  | { kind: "network-error"; message: string };

/**
 * Format a raw `ZodIssue[]` (the server's 422 `issues` array) into a
 * single inline message — same first-issue-wins convention as
 * {@link formatZodErrorInline}, but operating on the wire-shape array
 * (the server sends `error: "schema-error"` + an `issues` array, NOT a
 * re-hydrated `ZodError`).
 */
function formatZodIssuesInline(issues: unknown): string {
  if (!Array.isArray(issues) || issues.length === 0) {
    return "Validation failed (no issue detail available).";
  }
  const issue = issues[0] as { path?: unknown; message?: unknown };
  const pathArr = Array.isArray(issue.path) ? issue.path : [];
  const path = pathArr.length === 0 ? "(root)" : pathArr.join(".");
  const message =
    typeof issue.message === "string" ? issue.message : "Validation failed.";
  return `${path}: ${message}`;
}

/**
 * Classify the REAL patch-server response shape (packages/server/
 * patch-server.ts). The server is canonical — it flattens errors to a
 * top-level STRING `error` discriminant + sibling fields, NOT the
 * nested `{ error: { kind } }` object the 20.10-era helper assumed (the
 * helper drifted; 20.24 is its first runtime caller and corrects it).
 *
 * On the wire (per the handlers in patch-server.ts):
 *   200 → { ok: true, newMtime, recordId, mirrorDir, ... }
 *   409 → { ok: false, error: "mtime-mismatch", currentMtime, hint }
 *   422 → { ok: false, error: "schema-error", issues: ZodIssue[] }
 *   400 → { ok: false, error: "walk-error", fieldPath, detail }
 *   400 → { ok: false, error: "invalid-json" | "missing-baseMtime"
 *                                | "missing-patches" | "invalid-baseMtime", ... }
 *   500 → { ok: false, error: "mirror-regen-failed", canonicalWritten: true,
 *                              newMtime, detail }   ← SOFT (canonical saved)
 *   500 → { ok: false, error: "write-failed" | "ledger-read-failed", detail }
 *   422 → { ok: false, error: "unknown-document-name", documentName }
 */
export function classifySaveResult(response: unknown): SaveOutcome {
  if (typeof response !== "object" || response === null) {
    return { kind: "network-error", message: "Empty server response." };
  }
  const r = response as {
    ok?: boolean;
    error?: unknown;
    newMtime?: unknown;
    currentMtime?: unknown;
    hint?: unknown;
    issues?: unknown;
    fieldPath?: unknown;
    detail?: unknown;
    documentName?: unknown;
    canonicalWritten?: unknown;
  };

  if (r.ok === true) {
    return {
      kind: "ok",
      newMtime: typeof r.newMtime === "string" ? r.newMtime : undefined,
    };
  }

  if (r.ok === false && typeof r.error === "string") {
    switch (r.error) {
      case "schema-error":
        return {
          kind: "schema-error",
          message: formatZodIssuesInline(r.issues),
        };
      case "mtime-mismatch":
        return {
          kind: "mtime-conflict",
          message:
            typeof r.hint === "string"
              ? r.hint
              : "Ledger changed underneath you — reload from disk and re-apply your edit.",
          currentMtime:
            typeof r.currentMtime === "string" ? r.currentMtime : undefined,
        };
      case "walk-error":
        return {
          kind: "walk-error",
          message:
            typeof r.detail === "string"
              ? r.detail
              : Array.isArray(r.fieldPath)
                ? `Patch path invalid: ${r.fieldPath.join(">")}`
                : "Patch path invalid.",
        };
      case "mirror-regen-failed":
        // SOFT: the canonical persisted; only the mirror regen failed.
        return {
          kind: "mirror-regen-failed",
          message:
            typeof r.detail === "string"
              ? r.detail
              : "Saved, but mirror regeneration failed; mirrors may be stale until the next regen.",
          newMtime: typeof r.newMtime === "string" ? r.newMtime : undefined,
        };
      case "unknown-document-name":
        return {
          kind: "schema-error",
          message: `Unrecognised ledger document_name: ${
            typeof r.documentName === "string" ? r.documentName : "(null)"
          }.`,
        };
      default:
        // invalid-json / missing-baseMtime / missing-patches /
        // invalid-baseMtime / empty-patches / kind-mismatch /
        // write-failed / ledger-read-failed / anything else — client-
        // construction or IO faults. Surface the server's error token +
        // any detail rather than a silent → "Unrecognised" catch-all.
        return {
          kind: "network-error",
          message:
            typeof r.detail === "string" ? `${r.error}: ${r.detail}` : r.error,
        };
    }
  }

  return { kind: "network-error", message: "Unrecognised server response." };
}
