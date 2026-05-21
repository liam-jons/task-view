/**
 * Knowledge Hub Roadmap — Zod schema (kh-prod-readiness-S38 W5 Phase 1).
 *
 * VENDORED into task-view from Knowledge Hub `lib/validation/roadmap-schema.ts`
 * — see CONTRIBUTING.md for re-vendoring procedure. Per TECH §1.5 of
 * per-task-mirror, task-view consumes its own frozen copy.
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
// Item
// ──────────────────────────────────────────

export const RoadmapItemSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .describe('Dotted-decimal positional ID (e.g. 1.3, 3.1.8, 9.18.1)'),
    section_id: z
      .string()
      .min(1)
      .describe('Pointer to Section.id; redundant for query convenience'),
    title: z.string().min(1),
    /**
     * Item 5 ratification — `Phase` column source (§3.7, §4.1, §4.2, §6)
     * gets surfaced separately so the title remains the canonical heading.
     */
    phase_label: z.string().nullable(),
    /**
     * Markdown-preserved (multi-paragraph allowed). Round-trip rendering
     * must reproduce this verbatim minus pipe-padding.
     */
    description: z.string().min(1),
    /**
     * Item 7 ratification — freetext per backlog precedent. Examples:
     * `~15 min`, `1-2 sessions`, `Multiple sessions`, `XS`, `TBD`.
     */
    effort_estimate: z.string().nullable(),
    priority: RoadmapPriority.nullable(),
    /**
     * Phase 2 addition (kh-prod-readiness-S39 W1) — preserves the original
     * priority cell text verbatim when it carries editorial annotation
     * beyond the canonical enum (e.g. "Should (demoted from Must)",
     * "Medium (deferred)", "Low (H2)"). Renderer prefers `priority_note`
     * over the canonical capitalised enum so round-trip is lossless.
     * Null when the source cell was the unannotated canonical form.
     */
    priority_note: z.string().nullable(),
    /**
     * Item 8 ratification — §3.2 only (gap-analysis grading C2/H5/M4).
     * Null on every other section.
     */
    severity: z.string().nullable(),
    status: RoadmapStatus.nullable(),
    /**
     * Item 3 ratification — residual freetext when status doesn't fit
     * the enum (e.g. "Blocked on bid-to-template linkage", "EP8 build
     * remains.").
     */
    status_note: z.string().nullable(),
    /**
     * Per-item owner override (§1, §12.0 only). Falls back to
     * Section.owner when null.
     */
    owner: z.string().nullable(),
    /**
     * Item 6 ratification — hybrid parsing. High-confidence patterns
     * (`§N.M`, `D-NN`, `OPS-NN`) parsed into structured arrays; the rest
     * stays in description / status_note.
     *
     * Per ID-15.6 OQ-3 ratification — intentional divergence from Backlog +
     * Task list flat dependencies[]. Captures strategic decomposition (forward
     * dep / reverse dep / lateral coordination).
     */
    depends_on: z.array(z.string()),
    blocks: z.array(z.string()),
    coordinates_with: z.array(z.string()),
    cross_doc_links: z.array(DocLinkSchema),
    session_refs: z
      .array(z.string())
      .describe('e.g. ["S203 WP-C1", "kh-prod-readiness-S35"]'),
    commit_refs: z
      .array(z.string())
      .describe('Short or full SHA strings extracted from descriptions'),
  })
  .strict();
export type RoadmapItem = z.infer<typeof RoadmapItemSchema>;

// ──────────────────────────────────────────
// Section
// ──────────────────────────────────────────

export const RoadmapSectionSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .describe('Dotted-decimal stable ID (e.g. "1", "3.1", "9.15")'),
    parent_id: z
      .string()
      .nullable()
      .describe('Null for top-level numbered sections; parent ID otherwise'),
    /**
     * Human-facing label — same as `id` today; surfaced separately so
     * future renderers can substitute (e.g. "I" / "II" / "III" Roman).
     */
    number: z.string().min(1),
    title: z.string().min(1),
    /**
     * Item 1 ratification — markdown-preserved free-text prose between
     * the heading and the table. May be null when the section is pure
     * tabular content.
     */
    narrative: z.string().nullable(),
    /**
     * Item 1 ratification — structured `Spec:` / `Plan:` / `Source:` /
     * inline-link extraction in addition to keeping the source text in
     * `narrative`. Round-trip retains both.
     */
    spec_links: z.array(DocLinkSchema),
    /**
     * Section-level owner declaration (`**Owner:**` line at the top of
     * §9.7, §12.0 narrative). Items inherit when their per-item owner
     * is null.
     */
    owner: z.string().nullable(),
    table_columns: ColumnSet,
    items: z
      .array(RoadmapItemSchema)
      .describe('Empty allowed (e.g. §2 root, §9.17 narrative-only).'),
  })
  .strict();
export type RoadmapSection = z.infer<typeof RoadmapSectionSchema>;

// ──────────────────────────────────────────
// Roadmap (root)
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
    sections: z.array(RoadmapSectionSchema),
  })
  .strict();
export type Roadmap = z.infer<typeof RoadmapSchema>;
