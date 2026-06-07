/**
 * umbrellas-schema.ts — Zod schema for the KH umbrella (Linear-Initiative analogue)
 * surface (TECH §3, PRODUCT inv 7–9 of canonical-pipeline-task-list-migration).
 *
 * VENDORED into task-view from Knowledge Hub `lib/validation/umbrellas-schema.ts`
 * — see CONTRIBUTING.md for re-vendoring procedure. Per TECH §1.5 of
 * per-task-mirror, the BARE_ID_REGEX import (from KH's separate
 * `lib/validation/schemas.ts`) is inlined below since the vendor bundle
 * does not include the full KH schemas.ts. Vendored from KH @ 8d27cd23
 * (ID-90 U0 — feeds the umbrellas document-kind registration).
 *
 * Mirrors the structure of `roadmap-schema.ts` and `task-list-schema.ts`
 * (Zod, strict, typed exports). Three exported schemas:
 *   - UmbrellaStatus      — 4-value enum (proposed | in_progress | done | archived)
 *   - UmbrellaEntrySchema — single umbrella object (PRODUCT inv 8)
 *   - UmbrellasSchema     — root document (PRODUCT inv 7)
 *
 * Many-to-many semantics: a Task id may appear in multiple `task_ids[]` arrays
 * across umbrellas — schema imposes no uniqueness across umbrellas (PRODUCT inv 8).
 *
 * Round-trip with `task-list.json` is enforced by the integration test
 * `__tests__/docs/umbrellas-task-list-roundtrip.test.ts` (Subtask 31.8), NOT by
 * the schema (PRODUCT inv 9 — broken reference fails the test; orphan Task fires
 * a console.warn but passes — P-OQ-2 default).
 *
 * FORWARD-COMPAT CONSTRAINT (LOAD-BEARING per Wave 2 merge):
 *   The 6 UmbrellaEntry field names — `id`, `title`, `substrate_doc`,
 *   `task_ids`, `status`, `phase` — are LOCKED. ID-9 docubot (Wave 7) consumes
 *   verbatim. No renames without surfacing as T-OQ.
 *
 * No barrel re-export.
 *
 * Spec references:
 *   - docs/specs/id-31-canonical-pipeline-task-list-migration/PRODUCT.md inv 7–9
 *   - docs/specs/id-31-canonical-pipeline-task-list-migration/TECH.md §3.2
 *   - docs/specs/id-31-canonical-pipeline-task-list-migration/PLAN.md §2 Subtask 31.5
 */

import { z } from 'zod';

// Inlined from upstream KH `lib/validation/schemas.ts`. The full
// schemas.ts module is out of scope for the task-view vendor bundle
// (task-list-schema, roadmap-schema, backlog-schema, work-status,
// ledger-budgets, umbrellas-schema). The regex stays in sync via the
// re-vendoring procedure in CONTRIBUTING.md — match KH's source verbatim
// when re-vendoring.
const BARE_ID_REGEX = /^\d+$/;

// ──────────────────────────────────────────────────────────────────────────────
// UmbrellaStatus enum (PRODUCT inv 8 — 4 values, no others accepted)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Umbrella-level status. Aggregate of constituent Tasks but NOT auto-derived —
 * curator sets explicitly to reflect overall initiative phase.
 *
 * Values:
 *   - `proposed`    — umbrella created, work not yet started
 *   - `in_progress` — at least one Task active
 *   - `done`        — all Tasks complete (terminal success)
 *   - `archived`    — abandoned / superseded (terminal not-shipped)
 *
 * NOTE: Umbrellas do NOT adopt the Task-level vocabulary (no blocked / deferred
 * at umbrella level — those belong on Tasks).
 */
export const UmbrellaStatus = z.enum([
  'proposed',
  'in_progress',
  'done',
  'archived',
]);
export type UmbrellaStatus = z.infer<typeof UmbrellaStatus>;

// ──────────────────────────────────────────────────────────────────────────────
// UmbrellaEntrySchema (PRODUCT inv 8)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Single umbrella entry — Linear-Initiative analogue grouping a curated set of
 * Tasks under one substrate doc + phase + status.
 *
 * Field-name LOCK (FORWARD-COMPAT CONSTRAINT per Wave 2 merge):
 *   `id`, `title`, `substrate_doc`, `task_ids`, `status`, `phase`. ID-9
 *   docubot consumes these names verbatim. No renames without T-OQ.
 *
 * Per TECH §3.2: kebab-case `id` regex rejects leading/trailing hyphens,
 * uppercase, and non-alphanumeric internals. `task_ids[]` must contain bare-
 * digit Task ids (matches `task-list.json#/tasks[].id` BARE_ID_REGEX).
 */
export const UmbrellaEntrySchema = z
  .object({
    /** Kebab-case stable identifier (URL slug). Lowercase + hyphen + digits only. */
    id: z
      .string()
      .regex(
        /^[a-z][a-z0-9-]*[a-z0-9]$/,
        'Umbrella id must be kebab-case (lowercase, hyphens, digits; min 2 chars, no leading/trailing hyphen).',
      ),
    /** Human-readable display name (Title Case, UK English). */
    title: z.string().min(1),
    /** Relative path from repo root to canonical substrate doc. */
    substrate_doc: z.string().min(1),
    /**
     * Array of Task id strings (matches `task-list.json#/tasks[].id` regex —
     * bare-digit). Order matters for rendering (insertion order = display
     * order). Many-to-many: a Task id may also appear in another umbrella
     * entry's `task_ids[]`. The cross-doc validation test (Subtask 31.8)
     * verifies the referenced ids exist in `task-list.json`.
     */
    task_ids: z.array(
      z
        .string()
        .regex(BARE_ID_REGEX, 'task_ids[] entries must be bare-digit Task ids'),
    ),
    /** 4-value status enum (mapped to aggregate umbrella phase, not auto-derived). */
    status: UmbrellaStatus,
    /** Short string identifier for project phase (e.g. "Phase 1", "Phase 2"). */
    phase: z.string().min(1),
  })
  .strict();

export type UmbrellaEntry = z.infer<typeof UmbrellaEntrySchema>;

// ──────────────────────────────────────────────────────────────────────────────
// UmbrellasSchema — root document (PRODUCT inv 7)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Root document for `docs/reference/umbrellas.json`. Sibling to `task-list.json`,
 * `product-backlog.json`, `product-roadmap.json`.
 *
 * `last_updated` mirrors the freshness-marker discipline from
 * `task-list-schema.ts`: 200-char cap, single-line, single session-id,
 * `kh-{prod-readiness|main}-S{N}` prefix. Narrative belongs in per-Subtask
 * journal blocks, commit messages, continuation prompts, or mempalace diary —
 * NOT the freshness marker (S64 W0a anti-bloat ratification).
 *
 * Strict mode rejects unknown root-level fields.
 */
export const UmbrellasSchema = z
  .object({
    /** Literal document identifier (PRODUCT inv 7). */
    document_name: z.literal('umbrellas'),
    /** One-paragraph human-readable purpose. */
    document_purpose: z.string().min(1),
    /**
     * Freshness marker — same shape as `task-list.json` / `product-backlog.json`
     * / `product-roadmap.json`. 200-char cap, single line, single session-id,
     * `kh-{prod-readiness|main}-S{N}` prefix (per S64 W0a anti-bloat
     * enforcement).
     */
    last_updated: z
      .string()
      .min(1)
      .max(
        200,
        'last_updated must be ≤200 chars — narrative belongs in per-Subtask details journal blocks, commit messages, continuation prompts, or mempalace diary, not the freshness marker.',
      )
      .regex(
        /^kh-(prod-readiness|main)-S\d+/,
        'last_updated must start with "kh-{prod-readiness|main}-S{N}" session-id prefix.',
      )
      .refine((s) => !s.includes('\n'), {
        message: 'last_updated must be a single line (no newlines).',
      })
      .refine(
        (s) => (s.match(/\bkh-(prod-readiness|main)-S\d+/g) ?? []).length === 1,
        {
          message:
            'last_updated must contain exactly one session-id (diary-style append detected — narrative belongs in per-Subtask details / continuation prompts / mempalace diary).',
        },
      ),
    /** Array of repo-relative paths to related documents. */
    related_documents: z.array(z.string()),
    /** Array of umbrella entries — empty allowed (PRODUCT inv 7). */
    umbrellas: z.array(UmbrellaEntrySchema),
  })
  .strict();

export type Umbrellas = z.infer<typeof UmbrellasSchema>;
