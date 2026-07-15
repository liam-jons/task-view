/**
 * retro-schema.ts — Zod schema for the Retro ledger surface (ID-48 §5 RESEARCH).
 *
 * VENDORED into task-view from Knowledge Hub `lib/validation/retro-schema.ts`
 * (WS-C C2) — see CONTRIBUTING.md for the re-vendoring procedure. Body
 * byte-faithful with the KH source; only the `DocLinkSchema` import specifier is
 * rewired from `@/lib/validation/roadmap-schema` → the sibling
 * `./roadmap-schema` (the vendored roadmap copy already re-exports the identical
 * `DocLinkSchema`).
 *
 * 4th ledger-style surface alongside `task-list.json`, `product-roadmap.json`, and
 * `product-backlog.json`. Records session retros across the six categories ratified
 * at S264.
 *
 * Schema decisions:
 *   - Root document shape mirrors `RoadmapSchema` / `BacklogSchema` (document_name
 *     literal + document_purpose + related_documents + last_updated + array of records).
 *   - Per-record id is the session id (e.g. "S264"), NOT a bare digit — uses a
 *     `SESSION_ID_REGEX` (`/^S\d+$/`) rather than `BARE_ID_REGEX`. Caller-supplied:
 *     there is NO auto-allocation / nextId / high-water mark for retro ids.
 *   - 6 category arrays per the S264 retro template: `bugs_discovered`,
 *     `failed_assumptions`, `architecture_decisions`, `rejected_approaches`,
 *     `workflow_improvements`, `unresolved_questions`. Each item is `{ text,
 *     cross_doc_links? }` — text mandatory, cross_doc_links optional (defaults to []).
 *   - 4 soft-delete / adjudication fields per S271 §13.4: `deprecated`
 *     (default false), `deprecation_reason` (nullable), `superseding_record_id`
 *     (nullable), `last_conflict_check` (nullable ISO).
 *   - NO `version` / `$schema` root field — matches the three existing ledgers.
 *   - NO record-level `status` field — retros are records of past events.
 */

import { z } from 'zod';
import { DocLinkSchema } from './doc-link';

// ──────────────────────────────────────────────────────────────────────────────
// ID + date regex constants — session ids are `S<n>` (e.g. "S264"), not bare-digit.
// ──────────────────────────────────────────────────────────────────────────────

/** Session id form: `S` followed by one or more digits (e.g. `S264`, `S1`). */
const SESSION_ID_REGEX = /^S\d+$/;

/** ISO 8601 date — YYYY-MM-DD. */
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** ISO 8601 datetime — YYYY-MM-DDTHH:MM:SS(.sss)?Z (loose; nullable callers use it). */
const ISO_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

// ──────────────────────────────────────────────────────────────────────────────
// RetroFindingSchema — one observation inside one of the six category arrays.
//
// Shape: `{ text, cross_doc_links? }`. `text` is the finding prose. `cross_doc_links`
// is the same DocLinkSchema the other three ledgers use — defaults to [] when omitted.
// ──────────────────────────────────────────────────────────────────────────────

const RetroFindingSchema = z
  .object({
    /** Finding prose — one-liner or short paragraph. */
    text: z.string().min(1),
    /**
     * Optional cross-document links for structured provenance. Defaults to [] so
     * the JSON can omit the field when there are none.
     */
    cross_doc_links: z.array(DocLinkSchema).default([]),
  })
  .strict();

// ──────────────────────────────────────────────────────────────────────────────
// RetroRecordSchema — one session retro.
//
// Identifier + provenance fields mirror the Task/Backlog/Roadmap conventions
// (id, session_refs, commit_refs, cross_doc_links). The six category arrays
// carry the six retro categories. The four soft-delete fields ratified at S271
// §13.4 are baked in from the OUTSET.
// ──────────────────────────────────────────────────────────────────────────────

export const RetroRecordSchema = z
  .object({
    /**
     * Record id — the session id (e.g. "S264"). Uses SESSION_ID_REGEX rather
     * than the bare-digit BARE_ID_REGEX used by Task/Backlog/Roadmap items
     * because retros are session-scoped and caller-supplied.
     */
    id: z
      .string()
      .regex(
        SESSION_ID_REGEX,
        'Retro record id must be a session id of the form S<digits> (e.g. "S264")',
      ),

    /**
     * Session identifier in long form — often matches `id` (e.g. "S264") but
     * may carry a track qualifier (e.g. "kh-main-S264", "kh-subo-workflow-S265").
     */
    session_id: z.string().min(1),

    /** ISO 8601 date the session ran (YYYY-MM-DD). */
    date: z.string().regex(ISO_DATE_REGEX, 'Must be ISO 8601 YYYY-MM-DD'),

    /** Engineering track this session belonged to (e.g. "main", "prod-readiness"). */
    track: z.string().min(1),

    /** Session references for structured provenance (same shape as other ledgers). */
    session_refs: z.array(z.string()),

    /** Commit SHA references for structured provenance. */
    commit_refs: z.array(z.string()),

    /** Cross-document links for structured provenance. */
    cross_doc_links: z.array(DocLinkSchema),

    // ── Six category arrays (S264 retro template) ────────────────────────────

    /** Bugs discovered during the session. */
    bugs_discovered: z.array(RetroFindingSchema),

    /** Failed assumptions surfaced during the session. */
    failed_assumptions: z.array(RetroFindingSchema),

    /** Architecture / design decisions ratified during the session. */
    architecture_decisions: z.array(RetroFindingSchema),

    /** Approaches considered and rejected during the session. */
    rejected_approaches: z.array(RetroFindingSchema),

    /** Workflow improvements surfaced or ratified during the session. */
    workflow_improvements: z.array(RetroFindingSchema),

    /** Unresolved questions carried out of the session. */
    unresolved_questions: z.array(RetroFindingSchema),

    // ── Soft-delete / adjudication fields (S271 §13.4) ───────────────────────

    /**
     * Soft-delete flag. False (default) = active record; true = superseded /
     * deprecated by adjudication.
     */
    deprecated: z.boolean().default(false),

    /**
     * Human-readable reason this record was deprecated. Null when not
     * deprecated; defaults to null when omitted from input.
     */
    deprecation_reason: z.string().nullable().default(null),

    /**
     * Pointer to the retro record that supersedes this one. Null when not
     * superseded; defaults to null when omitted. References another retro `id`.
     */
    superseding_record_id: z.string().nullable().default(null),

    /**
     * ISO 8601 timestamp of the last `{48.14}` evaluate-findings sweep that
     * adjudicated this record. Null = never adjudicated. Defaults to null.
     */
    last_conflict_check: z
      .string()
      .regex(ISO_DATETIME_REGEX, 'Must be ISO 8601 timestamp ending in Z')
      .nullable()
      .default(null),
  })
  .strict();
export type RetroRecord = z.infer<typeof RetroRecordSchema>;

// ──────────────────────────────────────────────────────────────────────────────
// RetrosSchema — root document shape.
//
// Mirrors RoadmapSchema / BacklogSchema root conventions (document_name literal,
// document_purpose, related_documents, last_updated). The retros[] array carries
// the records.
// ──────────────────────────────────────────────────────────────────────────────

export const RetrosSchema = z
  .object({
    /** Document name literal — matches the Roadmap/Backlog literal-name convention. */
    document_name: z.literal('Knowledge Hub Retros'),

    /** One-paragraph human-readable purpose. */
    document_purpose: z.string().min(1),

    /** Repo-relative paths to related documents. */
    related_documents: z.array(z.string()),

    /**
     * Mirrors the backlog/roadmap `last_updated` field convention — freetext
     * one-liner of the form "kh-<track>-SNN <wave> close-out".
     */
    last_updated: z.string().min(1),

    /** Flat array of retro records. */
    retros: z.array(RetroRecordSchema),
  })
  .superRefine((doc, ctx) => {
    const ids = doc.retros.map((r) => r.id);
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) duplicates.add(id);
      else seen.add(id);
    }
    if (duplicates.size > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['retros'],
        message: `Retro records must have unique ids — duplicate id(s) found: ${[...duplicates].join(', ')}`,
      });
    }
  });
export type RetrosDocument = z.infer<typeof RetrosSchema>;

// ──────────────────────────────────────────────────────────────────────────────
// parseRetrosWithWarnings — mirror of parseRoadmapWithWarnings / parseBacklogWithWarnings.
//
// No per-record char budgets are registered for the retro surface (retros are
// append-only narrative). The helper exists for API parity; the returned
// warnings array is always empty until budgets are added in a future subtask.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * A warning raised by `parseRetrosWithWarnings`. `recordId` scopes the warning
 * to the offending retro record. Reserved for future field-length budgets;
 * currently never emitted.
 */
export interface RetrosWarning {
  recordId?: string;
  message: string;
}

/**
 * Parse a Retros document and surface soft warnings (none currently registered).
 * Throws `ZodError` on hard validation failure (same behaviour as
 * `RetrosSchema.parse()`). On success, returns the parsed document plus a
 * `warnings` array — empty for now.
 */
export function parseRetrosWithWarnings(input: unknown): {
  value: RetrosDocument;
  warnings: RetrosWarning[];
} {
  const value = RetrosSchema.parse(input);
  const warnings: RetrosWarning[] = [];
  return { value, warnings };
}
