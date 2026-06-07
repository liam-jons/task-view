/**
 * work-status.ts — Shared work-status module (TECH §1.0).
 *
 * VENDORED into task-view from Knowledge Hub `lib/validation/work-status.ts`
 * — see CONTRIBUTING.md for re-vendoring procedure. Per TECH §1.5 of
 * per-task-mirror, task-view consumes its own frozen copy of this file;
 * updates flow into the tool via explicit re-vendoring. Re-vendored from
 * KH @ 8d27cd23 (ID-90 U0).
 *
 * Single canonical `WorkStatus` master enum spanning all three KH task surfaces.
 * Per-surface subsets derived via `.exclude(...)` — no per-surface inline
 * `z.enum(...)` literals, no translation step on promotion.
 *
 * Surface consumers import directly from this module or from their
 * surface-specific schema (e.g. `@task-view/schemas/task-list`).
 *
 * Per PRODUCT.md inv 21–22 + TECH §1.0 (kh-prod-readiness-S50 Wave A.1).
 */

import { z } from 'zod';

// ──────────────────────────────────────────────────────────────────────────────
// Master enum — all status values used across all KH task surfaces.
// ──────────────────────────────────────────────────────────────────────────────

export const WorkStatus = z.enum([
  'done',
  'pending',
  'in_progress',
  'blocked',
  'deferred',
  'cancelled',
  'spec_needed',
  'imp_deferred',
  'needs_research',
  'parked',
  'ready',
]);
export type WorkStatus = z.infer<typeof WorkStatus>;

// ──────────────────────────────────────────────────────────────────────────────
// Per-surface subsets — each surface accepts the semantically valid slice.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Roadmap subset — forward-looking thematic capability planning.
 * Accepted: pending | blocked | spec_needed | deferred | imp_deferred | needs_research
 * Excluded: done | in_progress | cancelled | parked | ready
 */
export const RoadmapStatus = WorkStatus.exclude([
  'done',
  'in_progress',
  'cancelled',
  'parked',
  'ready',
]);
export type RoadmapStatus = z.infer<typeof RoadmapStatus>;

/**
 * Backlog subset — pre-work (parked / deferred / speculative).
 * Accepted: spec_needed | needs_research | parked | ready | blocked  (5 values)
 * Excluded: pending | done | in_progress | cancelled | deferred | imp_deferred
 *
 * Note: canonical form is `spec_needed` (not legacy `needs_spec`). The
 * legacy `needs_spec` form was retrofitted in S52 WP3 per FU-NEW.
 */
export const BacklogStatus = WorkStatus.exclude([
  'pending',
  'done',
  'in_progress',
  'cancelled',
  'deferred',
  'imp_deferred',
]);
export type BacklogStatus = z.infer<typeof BacklogStatus>;

/**
 * Task list subset — in-work (active Tasks and Subtasks).
 * Task level: done | pending | in_progress | blocked | deferred |
 *             cancelled | spec_needed | imp_deferred  (8 values)
 * Subtask level: further excludes 'cancelled', 'spec_needed', 'imp_deferred'
 *                — applied in task-list-schema.ts.
 * Excluded from Task level: needs_research | parked | ready
 */
export const TaskListStatus = WorkStatus.exclude([
  'needs_research',
  'parked',
  'ready',
]);
export type TaskListStatus = z.infer<typeof TaskListStatus>;

// ──────────────────────────────────────────────────────────────────────────────
// Priority master enum — covers all values used across KH surfaces.
// MoSCoW values, Ranked values, and the Trigger value.
// Per PRODUCT.md inv 25 + TECH §1.0.
// ──────────────────────────────────────────────────────────────────────────────

export const Priority = z.enum([
  'must', // MoSCoW
  'should', // MoSCoW
  'could', // MoSCoW
  'future', // MoSCoW
  'high', // Ranked
  'medium', // Ranked
  'low', // Ranked
  'trigger', // Trigger
]);
export type Priority = z.infer<typeof Priority>;
