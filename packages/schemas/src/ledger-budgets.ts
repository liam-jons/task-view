/**
 * ledger-budgets.ts — unified char-budget registry for the workflow ledgers
 * (task-list, initiatives, backlog). Ledger-CLI v2 {35.13}.
 *
 * RELOCATED into task-view from Knowledge Hub `lib/validation/ledger-budgets.ts`
 * (ID-90 U0) — a relocation twin, not a move: the KH source copy STAYS in KH
 * through Phase 3 (it feeds KH's parse-time soft warnings until {68.30}) and
 * joins the vendor-drift schema-arm watch list at R3. This upstream twin is the
 * server gate's registry (ID-90 invariants 24 + 59). See CONTRIBUTING.md for
 * the re-vendoring procedure.
 *
 * Single source of truth mapping `(recordKind → field → char budget)`, where
 * `recordKind` is one of `task | subtask | project | initiative | item`.
 * Consumed by:
 *   - the `parse*WithWarnings` helpers (task-list / backlog), which emit a
 *     SOFT warning for an over-budget field. (The `initiatives-schema.ts`
 *     module carries its own LOCAL `INITIATIVES_BUDGETS` registry for its
 *     `parseInitiativesWithWarnings` soft-warning path — see that file's
 *     header for why it is not folded in here.)
 *   - the ledger-CLI v2 write-time budget pre-check (RESEARCH §2.3), which
 *     REJECTS an over-budget write at source unless `--force`;
 *   - the `schema` / `--help` discoverability surface.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * CRITICAL — this is PLAIN DATA, never a Zod `.max()` constraint.
 * ──────────────────────────────────────────────────────────────────────────
 * Per RESEARCH §2.3 + §7 and `docs/reference/task-list-discipline.md` §3 there
 * are NO hard length caps on any text field. A `z.string().max(N)` would
 *   (a) reject the live, legitimately over-budget ledger at parse time, and
 *   (b) diverge the vendored `lib/validation/*-schema.ts` from task-view's
 *       source (watched by `task-view-vendor-drift.yml`).
 * So the schema stays cap-free and parseable; budgets are enforced ONLY at the
 * CLI write gate (prevent-at-source) and surfaced as soft parse warnings.
 *
 * `subtask.details` is intentionally NOT budgeted — it is the append-only
 * dispatch-brief + journal home; length there is legitimate (RESEARCH §2.3).
 */

/**
 * Per-record-kind char budgets.
 *
 * Numbers:
 *   - `task` / `subtask` — seeded VERBATIM from the original task-list
 *     `FIELD_BUDGETS` (taskDescription 1500, taskStatusNote 300,
 *     subtaskDescription 250, subtaskTestStrategy 300) so the existing
 *     task-list discipline is unchanged.
 *   - `project` / `initiative` — ID-148.10 (repurposed from the retired
 *     `theme` entry). Numbers match `initiatives-schema.ts`'s
 *     `INITIATIVES_BUDGETS`: `project.summary` 500 (one-sentence summary,
 *     same class as `item.description`), `project.description` 1500 and
 *     `initiative.description` 1500 (markdown scope statement, same class as
 *     `task.description`). This registry is the server WRITE-GATE budget
 *     (`gates/budget-gate.ts`); the schema-module-local `INITIATIVES_BUDGETS`
 *     is the parse-time soft-warning budget — same split the retired `theme`
 *     entry had (`roadmap-schema.ts`'s own registry usage vs this one).
 *   - `item.description` — the one-sentence summary under the `title`
 *     heading. Live data: median 125 / mean 182 / max 971; 500 is a soft
 *     budget generous enough never to flag the median/mean but to surface the
 *     genuinely-long outliers.
 *   - `item.title` — short noun-phrase heading (max 80), same class as
 *     `Subtask.title` (~40-80) and `Task.title` (~30-60). Added by {35.14}
 *     alongside the `BacklogItemSchema.title` field (RESEARCH §6.1).
 */
export const LEDGER_BUDGETS = {
  /** task-list.json — Task record. */
  task: {
    description: 1500,
    status_note: 300,
  },
  /** task-list.json — Subtask record. `details` is intentionally absent. */
  subtask: {
    description: 250,
    testStrategy: 300,
  },
  /** initiatives.json — Project record (ID-148.10, repurposed from `theme`). */
  project: {
    summary: 500,
    description: 1500,
  },
  /** initiatives.json — Initiative / sub-initiative record. */
  initiative: {
    description: 1500,
  },
  /** product-backlog.json — Item record. */
  item: {
    title: 80,
    description: 500,
  },
  /**
   * product-retros.json — Retro record. Intentionally EMPTY: retros are
   * append-only narrative and the six-category structure already enforces
   * discipline (RetrosSchema header). No per-field char budget is registered,
   * so the create/patch budget sweep measures nothing and always passes. The
   * key exists so `retro` is a valid `LedgerRecordKind` (the create gate's
   * `createRecordKindFor` resolves to it).
   */
  retro: {},
} as const;

export type LedgerRecordKind = keyof typeof LEDGER_BUDGETS;

/**
 * Back-compatible task-list budget constant. Pre-dates the unified registry;
 * the original named import (`{ FIELD_BUDGETS }`) is preserved here so the two
 * existing consumers — `parseTaskListWithWarnings` and
 * `scripts/ledger-sweep-s269.ts` — keep compiling unchanged. Derived from the
 * registry so the two can never drift.
 */
export const FIELD_BUDGETS = {
  taskDescription: LEDGER_BUDGETS.task.description,
  taskStatusNote: LEDGER_BUDGETS.task.status_note,
  subtaskDescription: LEDGER_BUDGETS.subtask.description,
  subtaskTestStrategy: LEDGER_BUDGETS.subtask.testStrategy,
} as const;

/** Repo-relative field-discipline doc, referenced in warning messages. */
export const DISCIPLINE_DOC = 'docs/reference/task-list-discipline.md';
