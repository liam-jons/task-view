/**
 * Knowledge Hub Roadmap — Zod schema (kh-prod-readiness-S38 W5 Phase 1).
 *
 * VENDORED into task-view from Knowledge Hub `lib/validation/roadmap-schema.ts`
 * — see CONTRIBUTING.md for re-vendoring procedure. Per TECH §1.5 of
 * per-task-mirror, the BARE_ID_REGEX import (from KH's separate
 * `lib/validation/schemas.ts`) is inlined below since the vendor bundle
 * does not include the full KH schemas.ts. Re-vendored from KH @ 8d27cd23
 * (ID-90 U0 — brings the theme field-budget soft warnings).
 *
 * Single source of truth for the JSON shape of `docs/reference/product-roadmap.json`
 * (the JSON-authoritative artefact replacing the legacy MD-only `product-roadmap.md`
 * post-conversion). The MD file becomes a generated artefact rendered from
 * this schema's serialised form via `bun run roadmap:render` (S39+).
 *
 * Schema decisions ratified at
 * `.planning/.research/s37-housekeeping/roadmap-conversion-approach.md` §6.1
 * (kh-prod-readiness-S37 W6, 07/05/2026, Liam directive). Departures from
 * the §4 recommendations are explicitly called out in §6.1:
 *
 *   - **Item 9 (SHIPPED markers):** schema has NO `shipped_note` /
 *     `shipped_marker` fields. Forward-looking-only doctrine is strict.
 *     Conversion pipeline gains a "shipped-framing detector" pre-parse step
 *     that produces an actionable purge list (`scripts/detect-roadmap-shipped-framings.ts`).
 *   - **Item 10 (§5.4.4 special row):** schema does NOT synthesise placeholder
 *     items. Operator purges shipped narrative from MD pre-conversion.
 *
 * Backlog precedent:
 *   `docs/reference/product-backlog.json` is the prior Zod-validated JSON
 *   document in this repo. Status enum is intentionally extended here
 *   (Item 3 ratification — `pending`, `spec_needed`, `imp_deferred`,
 *   `deferred` join the backlog enum).
 */

import { z } from 'zod';
import { Priority } from './work-status';
import { LEDGER_BUDGETS, DISCIPLINE_DOC } from './ledger-budgets';

// Inlined from upstream KH `lib/validation/schemas.ts`. The full
// schemas.ts module is out of scope for the task-view vendor bundle
// (task-list-schema, roadmap-schema, backlog-schema, work-status,
// ledger-budgets, umbrellas-schema). The regex stays in sync via the
// re-vendoring procedure in CONTRIBUTING.md — match KH's source verbatim
// when re-vendoring.
const BARE_ID_REGEX = /^\d+$/;

// ──────────────────────────────────────────
// Enums
// ──────────────────────────────────────────

/**
 * Item priority — re-export of the shared Priority master enum from
 * work-status.ts (ID-15.7 §B.3 — eliminates standalone z.enum that was
 * identical to Priority but not linked, reducing source-of-truth drift risk).
 * Accepted values: must | should | could | future | high | medium | low | trigger.
 * Downstream consumers (renderers, filters) can group these into MoSCoW vs
 * ranked vs trigger families.
 */
export const RoadmapPriority = Priority;
export type RoadmapPriority = z.infer<typeof RoadmapPriority>;

/**
 * Item status — extends the backlog enum (Item 3 ratification). Residual
 * freetext lives in `status_note`.
 */
export const RoadmapStatus = z.enum([
  'pending',
  'blocked',
  'spec_needed',
  'in_progress',
  'deferred',
  'imp_deferred',
]);
export type RoadmapStatus = z.infer<typeof RoadmapStatus>;

/**
 * Section table column flavour — drives the MD-render strategy in the
 * reverse-renderer (S39+). Source MD has at least 6 distinct column
 * shapes per `roadmap-conversion-approach.md` §1.
 */
export const ColumnSet = z.enum([
  'item_desc_owner_effort_status',
  'item_desc_effort_priority',
  'phase_desc_effort_priority',
  'item_desc_effort_severity',
  'item_desc_priority_status',
  'item_desc_effort_priority_status',
]);
export type ColumnSet = z.infer<typeof ColumnSet>;

// ──────────────────────────────────────────
// Sub-schemas
// ──────────────────────────────────────────

/**
 * DocLink — structured cross-document reference parsed from descriptions
 * and section narratives (`Spec:` / `Plan:` / `Source:` lines, inline
 * markdown links to docs/specs/, docs/audits/, .planning/*).
 */
export const DocLinkSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .describe('Repo-relative path (e.g. docs/specs/foo-spec.md)'),
    anchor: z
      .string()
      .nullable()
      .describe('Optional in-doc anchor (e.g. §2.3 or #section-id)'),
    raw: z
      .string()
      .min(1)
      .describe('Original text matched by the regex sweep, for round-trip'),
  })
  .strict();
export type DocLink = z.infer<typeof DocLinkSchema>;

// ──────────────────────────────────────────
// Theme (Subtask 30.6 / TECH §3.1)
//
// Phase-B Roadmap shape — Linear-style themes grouping related Tasks under
// time horizons (now / next / later). Authoritative back-link from Roadmap
// theme → Task via `linked_tasks[]`; Task carries a convenience
// `capability_theme` back-link that the curator skill maintains in sync.
//
// 10 fields, all required (arrays default to empty, notes nullable).
// Strict — no unknown fields permitted.
// ──────────────────────────────────────────

export const RoadmapThemeSchema = z
  .object({
    /** Bare-digit theme id (e.g. "1", "42"). Matches BARE_ID_REGEX. */
    id: z.string().regex(BARE_ID_REGEX, 'Theme id must be a bare-digit string'),
    /** Short noun phrase title for the theme. */
    title: z.string().min(1),
    /** Markdown description of the theme's scope and intent. */
    description: z.string().min(1),
    /**
     * Linear-style time horizon — `now` (in flight), `next` (queued for
     * next cycle), `later` (parked for future cycles).
     */
    time_horizon: z.enum(['now', 'next', 'later']),
    /**
     * Theme-level status. 3 values per P-OQ-1 default: pending | in_progress
     * | done. Themes do not adopt the wider Task-level status vocabulary
     * (no blocked / deferred at theme level — those belong on Tasks).
     */
    status: z.enum(['pending', 'in_progress', 'done']),
    /**
     * Authoritative back-link to Tasks under this theme. Mirrored by each
     * Task's optional `capability_theme` convenience field.
     */
    linked_tasks: z.array(z.string()),
    /** Optional back-link to Backlog items related to the theme. */
    linked_backlog: z.array(z.string()),
    /** Session references for structured provenance. */
    session_refs: z.array(z.string()),
    /** Commit SHA references for structured provenance. */
    commit_refs: z.array(z.string()),
    /** Cross-document links for structured provenance. */
    cross_doc_links: z.array(DocLinkSchema),
    /** Optional prose notes, nullable. */
    notes: z.string().nullable(),
  })
  .strict();
export type RoadmapTheme = z.infer<typeof RoadmapThemeSchema>;

// ──────────────────────────────────────────
// Roadmap (root) — themes-only shape (Subtask 30.12 / TECH §3.1 PR-C)
//
// Phase-B is the only supported shape. The transitional union root from
// Subtask 30.6 (sections[] XOR themes[] via .superRefine()) is removed in
// PR-C per TECH §3.1 + §7 risk row 1. `themes` is REQUIRED; legacy
// sections-shape documents are rejected at parse time.
// ──────────────────────────────────────────

export const RoadmapSchema = z
  .object({
    document_name: z.literal('Knowledge Hub Roadmap'),
    document_purpose: z.string().min(1),
    /**
     * ISO 8601 (YYYY-MM-DD). Derived from MD line 3 at conversion time;
     * subsequent edits update this independently of MD regeneration.
     */
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be ISO 8601 YYYY-MM-DD'),
    status: z.literal('Active'),
    /**
     * Item 9 + Item 10 ratification — strict forward-looking-only
     * doctrine. The shipped-framing detector enforces this at conversion
     * time; the schema literal locks it in for downstream consumers.
     */
    forward_looking_only: z.literal(true),
    related_documents: z.array(z.string()).describe('Repo-relative paths'),
    /**
     * Mirrors the backlog `last_updated` field convention — freetext
     * one-liner of the form "kh-prod-readiness-SNN <wave> close-out".
     */
    last_updated: z.string().min(1),
    /**
     * Phase-B themes shape. REQUIRED — Linear-style theme grouping. The
     * Phase-A sections[] shape was retired in Subtask 30.12 (PR-C). The
     * strict() root rejects any document that retains the legacy
     * sections[] field.
     */
    themes: z.array(RoadmapThemeSchema),
    /**
     * ID-90 F5/Bug3: monotonic id high-water mark — the highest theme id ever
     * ALLOCATED (never decreases on delete), so the auto-id allocator never
     * reuses a freed id. OPTIONAL + backward-compatible (absent → fall back to
     * `max(survivors)+1`). Declared here because the root is `.strict()`.
     */
    _idHighWater: z.number().int().nonnegative().optional(),
  })
  .strict();
export type Roadmap = z.infer<typeof RoadmapSchema>;

// ──────────────────────────────────────────
// parseRoadmapWithWarnings — PRODUCT inv 8 (12-theme soft ceiling)
// ──────────────────────────────────────────

/**
 * A warning raised by `parseRoadmapWithWarnings` when a document exceeds the
 * 12-theme soft ceiling (PRODUCT inv 8) or a theme field exceeds its char
 * budget ({35.13} — sourced from `lib/validation/ledger-budgets.ts`).
 *
 * `themeCount` is set on the per-document ceiling warning; `themeId` is set on
 * a per-theme field-budget warning. Soft warnings only — never schema
 * rejections (no `.max()`; the registry is plain data — RESEARCH §2.3/§7).
 */
export interface RoadmapWarning {
  themeCount?: number;
  themeId?: string;
  message: string;
}

/**
 * Parse a Roadmap and surface warnings for any document that exceeds the
 * 12-theme soft ceiling (PRODUCT inv 8).
 *
 * The soft ceiling is NOT enforced as a schema rejection — `RoadmapSchema.parse()`
 * continues to accept documents with >12 themes because the invariant is a
 * planning signal, not a hard constraint. Consumers that want to surface the
 * warning (e.g. a Planner agent) call this helper; consumers that don't care
 * continue using `RoadmapSchema.parse()` directly.
 *
 * Throws `ZodError` on hard validation failure (same behaviour as
 * `RoadmapSchema.parse()`). On success, returns the parsed `Roadmap` plus a
 * `warnings` array — empty when the document is within the ceiling.
 *
 * One warning entry per offending document (not per excess theme). Mirrors the
 * `parseTaskListWithWarnings` shape from task-list-schema.ts.
 */
export function parseRoadmapWithWarnings(input: unknown): {
  value: Roadmap;
  warnings: RoadmapWarning[];
} {
  const value = RoadmapSchema.parse(input);
  const warnings: RoadmapWarning[] = [];
  if (value.themes.length > 12) {
    warnings.push({
      themeCount: value.themes.length,
      message:
        `Roadmap has ${value.themes.length} themes (>12). ` +
        `Per PRODUCT inv 8, consider merging.`,
    });
  }

  // ── Theme field-length budgets ({35.13}) — soft warnings, never rejections.
  // Sourced from the unified registry; `notes` is nullable so guard for null.
  for (const theme of value.themes) {
    if (theme.description.length > LEDGER_BUDGETS.theme.description) {
      warnings.push({
        themeId: theme.id,
        message:
          `Roadmap theme "${theme.id}" description is ${theme.description.length} chars ` +
          `(budget ${LEDGER_BUDGETS.theme.description}). Move detail to docs/ and reference ` +
          `it via cross_doc_links (see ${DISCIPLINE_DOC}).`,
      });
    }
    if (theme.notes && theme.notes.length > LEDGER_BUDGETS.theme.notes) {
      warnings.push({
        themeId: theme.id,
        message:
          `Roadmap theme "${theme.id}" notes is ${theme.notes.length} chars ` +
          `(budget ${LEDGER_BUDGETS.theme.notes}). Keep notes to acute context only ` +
          `(see ${DISCIPLINE_DOC}).`,
      });
    }
  }

  return { value, warnings };
}
