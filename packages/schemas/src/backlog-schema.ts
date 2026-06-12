/**
 * backlog-schema.ts — Zod schema for the Backlog surface (TECH §3).
 *
 * VENDORED into task-view from Knowledge Hub `lib/validation/backlog-schema.ts`
 * — see CONTRIBUTING.md for re-vendoring procedure. Per TECH §1.5 of
 * per-task-mirror, the BARE_ID_REGEX import (from KH's separate
 * `lib/validation/schemas.ts`) is inlined below since the vendor bundle
 * does not include the full KH schemas.ts. Re-vendored from KH @ 8d27cd23
 * (ID-90 U0 — brings the optional `title` field ({35.14}) and
 * `parseBacklogWithWarnings`).
 *
 * Formalises `docs/reference/product-backlog.json` shape with Zod so the
 * schema is the canonical source of truth for allowed status values and field
 * shapes. The existing `backlog-no-closed-rows.test.ts` guard now sources its
 * allowed status enum from here rather than a hard-coded local constant.
 *
 * `BacklogStatus` is the Backlog subset of the shared `WorkStatus` master enum
 * from `lib/validation/work-status.ts` (per TECH §1.0). Canonical values:
 * `spec_needed | needs_research | parked | ready | blocked`
 *
 * Note: backlog items canonically use `spec_needed`. The legacy `needs_spec`
 * form was retrofitted in S52 WP3 (FU-NEW); the schema only accepts the
 * canonical form.
 *
 * Per PRODUCT.md inv 36–40, 42 + TECH §3 (kh-prod-readiness-S50 Wave A.1).
 */

import { z } from 'zod';
import { BacklogStatus, Priority } from './work-status';
import { DocLinkSchema } from './roadmap-schema';
import { LEDGER_BUDGETS, DISCIPLINE_DOC } from './ledger-budgets';

// Inlined from upstream KH `lib/validation/schemas.ts`. The full
// schemas.ts module is out of scope for the task-view vendor bundle
// (task-list-schema, roadmap-schema, backlog-schema, work-status,
// ledger-budgets, umbrellas-schema). The regex stays in sync via the
// re-vendoring procedure in CONTRIBUTING.md — match KH's source verbatim
// when re-vendoring.
const BARE_ID_REGEX = /^\d+$/;

// ──────────────────────────────────────────────────────────────────────────────
// Re-export surface-level status enum (consumers import from here, not from
// work-status.ts directly, per the per-surface re-export convention in TECH §1.0).
// ──────────────────────────────────────────────────────────────────────────────

// Vendoring adaptation: a single re-export from './work-status' carries
// BOTH the value (Zod schema) and the type alias, since work-status.ts
// exports `BacklogStatus` as value + type. The upstream KH source uses
// `export { BacklogStatus };` (re-exporting the local import); under the
// vendor package's `isolatedModules` tsconfig the re-export-from-module
// form is the proven conflict-free equivalent.
export { BacklogStatus } from './work-status';

// ──────────────────────────────────────────────────────────────────────────────
// Backlog item type enum — values observed in the live data.
// ──────────────────────────────────────────────────────────────────────────────

export const BacklogItemType = z.enum([
  'feature',
  'bug',
  'research',
  'tech_debt',
  'infrastructure',
  'documentation',
  'testing',
  'ux',
]);
export type BacklogItemType = z.infer<typeof BacklogItemType>;

// ──────────────────────────────────────────────────────────────────────────────
// BacklogItemSchema — individual item shape.
//
// Required fields mirror the current product-backlog.json shape exactly.
// New optional fields (`details`, `testStrategy`) per PRODUCT inv 38 make items
// promotion-compatible with the Task list surface without a content reshape.
//
// Field notes:
// - `dependencies` (renamed from `depends_on` in S52 WP3 per FU-2).
// - `effort_estimate` is nullable — some items carry no estimate.
// - `notes` is nullable — most items have null notes.
// - `priority` uses the shared `Priority` master enum (all three Ranked values
//   `high | medium | low` appear in the live data; MoSCoW/Trigger values are
//   excluded in practice but the schema accepts the full master set for
//   forwards-compatibility with items promoted from the Task list).
// ──────────────────────────────────────────────────────────────────────────────

export const BacklogItemSchema = z.object({
  /** Item identifier — bare-digit canonical form after ID-15.4 migration (inv 37). */
  id: z
    .string()
    .regex(BARE_ID_REGEX, 'Backlog item id must be a bare digit string'),

  /**
   * Short noun-phrase heading ({35.14} / RESEARCH §6.1). OPTIONAL — all 149
   * live items lack it, so the schema must keep parsing the live ledger before
   * the {35.23} backfill completes. Positioned first after `id` per the
   * Task/Subtask heading convention (`title` precedes `description`).
   *
   * `BacklogItemSchema` is NOT `.strict()`, so adding this is non-breaking, and
   * `patch-apply`'s `BACKLOG_ITEM_KNOWN_FIELDS` (= `Object.keys(Schema.shape)`)
   * auto-picks it up → `update-backlog <id> title <value>` works with no walker
   * change.
   *
   * Budget: max 80 chars — registered in `lib/validation/ledger-budgets.ts`
   * (`item.title`), enforced as a CLI write-time soft gate, NOT a Zod `.max()`
   * (no hard cap — RESEARCH §2.3/§7).
   *
   * NOTE: adding this field to the vendored `backlog-schema.ts` trips the
   * NON-BLOCKING `task-view-vendor-drift.yml` `::warning::` re-vendor reminder.
   * This is EXPECTED and acceptable (RESEARCH §7) — do NOT edit the task-view
   * fork to silence it.
   */
  title: z.string().min(1).optional(),

  /** One-sentence summary of the work item. */
  description: z.string().min(1),

  /** Classification of the work item. */
  type: BacklogItemType,

  /**
   * Forward-looking status from the Backlog subset of WorkStatus.
   * Canonical values: spec_needed | needs_research | parked | ready | blocked.
   * The legacy `needs_spec` form is NOT accepted (retrofitted in S52 WP3
   * per FU-NEW).
   */
  status: BacklogStatus,

  /** Rough size estimate, nullable (e.g. `"2-3h"`, `"1-2 sessions"`). */
  effort_estimate: z.string().nullable(),

  /** Priority using the shared Priority master enum. */
  priority: Priority,

  /** Engineering track / theme for this item. */
  track: z.string().min(1),

  /**
   * Array of other backlog item ids this item depends on.
   * Renamed from `depends_on` to `dependencies` in S52 WP3 per FU-2
   * (aligns with the Taskmaster canonical field name).
   */
  dependencies: z.array(z.string()),

  /**
   * Session references for structured provenance (OQ-4 ratification).
   * Written by workflow-curator at item creation; direct-copy on promotion
   * to Task. Empty array when no session reference is known.
   */
  session_refs: z.array(z.string()),

  /**
   * Commit SHA references for structured provenance (OQ-4 ratification).
   * Empty array when no commit reference is known.
   */
  commit_refs: z.array(z.string()),

  /**
   * Cross-document links for structured provenance (OQ-4 ratification).
   * Mirrors the Roadmap + Task list shape using DocLinkSchema from
   * roadmap-schema.ts. Empty array when no cross-doc links are known.
   */
  cross_doc_links: z.array(DocLinkSchema),

  /** Optional prose notes, nullable. */
  notes: z.string().nullable(),

  /**
   * Within-priority deterministic ordering. Lower integer = higher rank.
   * Default null; pre-existing items omit. Schema does NOT enforce uniqueness
   * or contiguity within tier (PRODUCT inv 3). Curator skill maintains
   * discipline (Subtask 30.5 + P-OQ-3 auto-shift default). Per TECH §3.1
   * (Subtask 30.6).
   */
  rank: z.number().int().nullable().optional(),

  // ── New optional fields per PRODUCT inv 38 ──────────────────────────────

  /**
   * Markdown brief, populated when the item has been pre-thought beyond the
   * one-sentence description. Nullable — omit or set null when absent.
   * Makes items promotion-compatible with the Task list `Subtask.details`
   * convention (per inv 39).
   */
  details: z.string().nullable().optional(),

  /**
   * Prose acceptance statement. Nullable — omit or set null when absent.
   * Maps to `Subtask.testStrategy` on promotion (per inv 39).
   */
  testStrategy: z.string().nullable().optional(),
});

export type BacklogItem = z.infer<typeof BacklogItemSchema>;

// ──────────────────────────────────────────────────────────────────────────────
// BacklogSchema — root document shape.
// ──────────────────────────────────────────────────────────────────────────────

export const BacklogSchema = z
  .object({
    /** Document identifier literal. */
    document_name: z.string().min(1),

    /** One-paragraph human-readable purpose. */
    document_purpose: z.string().min(1),

    /** Repo-relative paths to related documents. */
    related_documents: z.array(z.string()),

    /** Flat array of backlog items. */
    items: z.array(BacklogItemSchema),

    /**
     * ID-90 F5/Bug3: monotonic id high-water mark — the highest item id ever
     * ALLOCATED on this document (never decreases on delete/promote), so the
     * auto-id allocator never reuses a freed id (the bl-287/288 collision
     * class). OPTIONAL + backward-compatible: a ledger without the field falls
     * back to `max(survivors)+1` and the allocator seeds it on first write.
     * `BacklogSchema` is not `.strict()`, but declaring the field here makes
     * Zod PRESERVE it (rather than strip it) through the whole-document
     * re-serialise paths (delete / promote-remove leg).
     */
    _idHighWater: z.number().int().nonnegative().optional(),
  })
  .superRefine((doc, ctx) => {
    const ids = doc.items.map((item) => item.id);
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) duplicates.add(id);
      else seen.add(id);
    }
    if (duplicates.size > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['items'],
        message: `Backlog items must have unique ids — duplicate id(s) found: ${[...duplicates].join(', ')}`,
      });
    }
  });

export type BacklogDocument = z.infer<typeof BacklogSchema>;

// ──────────────────────────────────────────────────────────────────────────────
// parseBacklogWithWarnings — field-length budget warnings ({35.13})
//
// Mirrors `parseTaskListWithWarnings` / `parseRoadmapWithWarnings`. Surfaces a
// SOFT warning for any item field that exceeds its char budget in the unified
// registry (`lib/validation/ledger-budgets.ts`). NOT a schema rejection — no
// `.max()` is added, so the live ledger keeps parsing and the vendored schema
// shape is unchanged (RESEARCH §2.3/§7). The CLI write-time pre-check ({35.17})
// is the prevent-at-source gate; this helper is the read-side advisory.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * A warning raised by `parseBacklogWithWarnings` when an item field exceeds its
 * char budget. `itemId` scopes the warning to the offending item.
 */
export interface BacklogWarning {
  itemId: string;
  message: string;
}

/**
 * Parse a Backlog document and surface soft field-length warnings sourced from
 * the unified budget registry. Throws `ZodError` on hard validation failure
 * (same behaviour as `BacklogSchema.parse()`). On success, returns the parsed
 * document plus a `warnings` array — empty when every item is within budget.
 */
export function parseBacklogWithWarnings(input: unknown): {
  value: BacklogDocument;
  warnings: BacklogWarning[];
} {
  const value = BacklogSchema.parse(input);
  const warnings: BacklogWarning[] = [];

  for (const item of value.items) {
    if (item.title && item.title.length > LEDGER_BUDGETS.item.title) {
      warnings.push({
        itemId: item.id,
        message:
          `Backlog item "${item.id}" title is ${item.title.length} chars ` +
          `(budget ${LEDGER_BUDGETS.item.title}). Keep it a short noun-phrase ` +
          `heading (see ${DISCIPLINE_DOC}).`,
      });
    }
    if (item.description.length > LEDGER_BUDGETS.item.description) {
      warnings.push({
        itemId: item.id,
        message:
          `Backlog item "${item.id}" description is ${item.description.length} chars ` +
          `(budget ${LEDGER_BUDGETS.item.description}). Keep it a one-sentence summary; ` +
          `move detail to a spec/research doc and reference via cross_doc_links ` +
          `(see ${DISCIPLINE_DOC}).`,
      });
    }
  }

  return { value, warnings };
}
