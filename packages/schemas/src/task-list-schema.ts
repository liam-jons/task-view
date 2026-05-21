/**
 * task-list-schema.ts — Zod schema for the KH Task list surface (TECH §1).
 *
 * VENDORED into task-view from Knowledge Hub `lib/validation/task-list-schema.ts`
 * — see CONTRIBUTING.md for re-vendoring procedure. Per TECH §1.5 of
 * per-task-mirror, the BARE_ID_REGEX import (from KH's separate
 * `lib/validation/schemas.ts`) is inlined below since the 4-file vendor
 * bundle does not include the full KH schemas.ts.
 *
 * Mirrors the structure of `roadmap-schema.ts` (Zod, strict, typed exports).
 * Three exported schemas:
 *   - SubtaskSchema — TM-shape Subtask object (PRODUCT inv 9–13)
 *   - TaskSchema    — TM-shape Task object (PRODUCT inv 5–8, 14–16)
 *   - TaskListSchema — root document (PRODUCT inv 4)
 *
 * Status wiring: `TaskListStatus` from the shared module; Subtask-level is
 * further restricted via `.exclude(...)`. No alias preprocessing — canonical
 * underscore-form inputs only (PRODUCT inv 22). No barrel re-export.
 *
 * Sibling-only dep enforcement: `TaskSchema` carries a `.superRefine()` that
 * walks each Subtask's `dependencies[]` and rejects cross-Task references
 * (PRODUCT inv 14–16).
 *
 * Task-level `details` and `testStrategy` are OMITTED per PRODUCT inv 7 —
 * they live on Subtasks only. `parentId` is also OMITTED per PRODUCT inv 8.
 *
 * (kh-prod-readiness-S50 Wave A.1 — WP1)
 */

import { z } from 'zod';
import { TaskListStatus, Priority } from './work-status';
import { DocLinkSchema } from './roadmap-schema';

// Inlined from upstream KH `lib/validation/schemas.ts`. The full
// schemas.ts module is out of scope for the task-view vendor bundle
// (TECH §1.5 specifies a 4-file bundle: task-list-schema, roadmap-schema,
// backlog-schema, work-status). The regex stays in sync via the
// re-vendoring procedure in CONTRIBUTING.md — match KH's source verbatim
// when re-vendoring.
const BARE_ID_REGEX = /^\d+$/;

// ──────────────────────────────────────────────────────────────────────────────
// Re-export surface-specific status and priority for consumers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Task-level status enum — 8 values from the shared TaskListStatus subset.
 * Re-exported here so consumers can import directly from the surface module.
 */
export { TaskListStatus } from './work-status';

/**
 * Subtask-level status — strict subset of TaskListStatus.
 * Drops: cancelled | spec_needed | imp_deferred (Task-level-only values).
 * Per PRODUCT inv 21.
 */
export const SubtaskStatus = TaskListStatus.exclude([
  'cancelled',
  'spec_needed',
  'imp_deferred',
]);
export type SubtaskStatus = z.infer<typeof SubtaskStatus>;

/**
 * Task priority — uses the master Priority enum directly.
 * Tasks accept the full priority vocabulary (MoSCoW + Ranked + Trigger).
 * Per PRODUCT inv 25 + TECH §1.
 */
export const TaskPriority = Priority;
export type TaskPriority = z.infer<typeof TaskPriority>;

// ──────────────────────────────────────────────────────────────────────────────
// SubtaskSchema (PRODUCT inv 9–13)
// ──────────────────────────────────────────────────────────────────────────────

export const SubtaskSchema = z
  .object({
    /** Bare integer, restarts at 1 per parent Task (TM convention — inv 9). */
    id: z.number().int().min(1),
    /** Short noun phrase (~40–80 chars). */
    title: z.string().min(1),
    /** One-sentence summary (~80–200 chars). */
    description: z.string().min(1),
    /**
     * Multi-line markdown brief — load-bearing dispatch brief for the Executor.
     * Append-extensible via <info added on ...> blocks (inv 13).
     */
    details: z.string(),
    /** Subtask-level subset: done | pending | in_progress | blocked | deferred. */
    status: SubtaskStatus,
    /**
     * Sibling integer ids. Validated at TaskSchema level via superRefine (inv 14).
     * Schema here allows any number[] — the cross-sibling constraint is enforced
     * by the parent TaskSchema's superRefine.
     */
    dependencies: z.array(z.number().int().min(1)),
    /** Nullable prose acceptance statement (inv 9). */
    testStrategy: z.string().nullable(),
    /** Optional ISO 8601 timestamp — absent when Subtask not touched since creation (inv 10). */
    updatedAt: z.string().optional(),
  })
  .strict(); // inv 11 (no nested subtasks), inv 12 (no priority on Subtask)

export type Subtask = z.infer<typeof SubtaskSchema>;

// ──────────────────────────────────────────────────────────────────────────────
// TaskSchema (PRODUCT inv 5–8, 14–16)
// ──────────────────────────────────────────────────────────────────────────────

export const TaskSchema = z
  .object({
    /** Stringified integer (TM convention — inv 5). */
    id: z.string().regex(BARE_ID_REGEX, 'Task id must be a string of digits'),
    /** Short noun phrase (~30–60 chars). */
    title: z.string().min(1),
    /** Markdown body — may preview Subtask plan in prose (TM §3.4 convention). */
    description: z.string().min(1),
    /** Task-level status — 8 values from TaskListStatus subset. */
    status: TaskListStatus,
    /** Task priority — full Priority master enum (MoSCoW + Ranked + Trigger). */
    priority: TaskPriority,
    /** String array of Task ids this Task depends on. */
    dependencies: z.array(z.string()),
    /** Subtasks — empty array allowed for atomic Tasks (inv 5). */
    subtasks: z.array(SubtaskSchema),
    /** ISO 8601 timestamp of last write to this Task or any Subtask. */
    updatedAt: z.string(),

    // ── KH-extension nullable fields (inv 6) ─────────────────────────────────
    // Required with explicit null — matches dogfood data convention where all
    // four fields are always present (explicit null when unpopulated). Using
    // .nullable() without .optional() means the field MUST be present; absent
    // fields are rejected. Explicit null is still accepted.
    effort_estimate: z.string().nullable(),
    owner: z.string().nullable(),
    priority_note: z.string().nullable(),
    status_note: z.string().nullable(),

    // ── KH-extension array fields — always present, possibly empty (inv 6) ──
    cross_doc_links: z.array(DocLinkSchema),
    session_refs: z.array(z.string()),
    commit_refs: z.array(z.string()),
  })
  .strict() // inv 7 (no details/testStrategy), inv 8 (no parentId)
  .superRefine((task, ctx) => {
    // inv 14–16: Sibling-only Subtask dependency enforcement.
    // Walk each Subtask's dependencies[] and assert every referenced integer
    // matches some sibling's id within this Task.
    const siblingIds = new Set(task.subtasks.map((s) => s.id));

    for (const subtask of task.subtasks) {
      for (const depId of subtask.dependencies) {
        if (!siblingIds.has(depId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['subtasks'],
            message:
              `Subtask ${subtask.id} has dependency on id ${depId} which is not a sibling Subtask in Task "${task.id}". ` +
              `Subtask dependencies must reference only siblings within the same parent Task (PRODUCT inv 14).`,
          });
        }
      }
    }
  });

export type Task = z.infer<typeof TaskSchema>;

// ──────────────────────────────────────────────────────────────────────────────
// TaskListSchema — root document (PRODUCT inv 4)
// ──────────────────────────────────────────────────────────────────────────────

export const TaskListSchema = z
  .object({
    /** Literal document identifier (inv 4). */
    document_name: z.literal('Knowledge Hub Task List'),
    /** One-paragraph human-readable purpose (inv 4). */
    document_purpose: z.string().min(1),
    /**
     * Freetext one-liner of the form "kh-prod-readiness-SNN <wave> close-out".
     * Matches Roadmap and Backlog convention (PRODUCT inv 52).
     */
    last_updated: z.string().min(1),
    /** Array of repo-relative paths to related documents (inv 4). */
    related_documents: z.array(z.string()),
    /** Array of Task objects — empty allowed (inv 4, 19). */
    tasks: z.array(TaskSchema),
  })
  .strict();

export type TaskList = z.infer<typeof TaskListSchema>;

// ──────────────────────────────────────────────────────────────────────────────
// parseTaskListWithWarnings — PRODUCT inv 20 (25-Subtask soft ceiling)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * A warning raised by `parseTaskListWithWarnings` when a Task exceeds the
 * 25-Subtask soft ceiling defined in PRODUCT inv 20.
 */
export interface TaskListWarning {
  taskId: string;
  message: string;
}

/**
 * Parse a TaskList and surface warnings for any Task that exceeds the
 * 25-Subtask soft ceiling (PRODUCT inv 20).
 *
 * The soft ceiling is NOT enforced as a schema rejection — `TaskListSchema.parse()`
 * continues to accept Tasks with >25 Subtasks because the invariant is a
 * planning signal, not a hard constraint. Consumers that want to surface the
 * warning (e.g. a Planner agent) call this helper; consumers that don't care
 * continue using `TaskListSchema.parse()` directly.
 *
 * Throws `ZodError` on hard validation failure (same behaviour as
 * `TaskListSchema.parse()`). On success, returns the parsed `TaskList` plus a
 * `warnings` array — empty when all Tasks are within the ceiling.
 *
 * One warning entry per offending Task (not per excess Subtask).
 */
export function parseTaskListWithWarnings(input: unknown): {
  value: TaskList;
  warnings: TaskListWarning[];
} {
  // Hard-fail on schema violations — throws ZodError
  const value = TaskListSchema.parse(input);

  const warnings: TaskListWarning[] = [];
  for (const task of value.tasks) {
    if (task.subtasks.length > 25) {
      warnings.push({
        taskId: task.id,
        message:
          `Task "${task.id}" has ${task.subtasks.length} subtasks (>25). ` +
          `Per PRODUCT inv 20, consider splitting into multiple Tasks linked by Task.dependencies[].`,
      });
    }
  }
  return { value, warnings };
}
