/**
 * initiatives-schema.ts — Zod schema for `initiatives.json`
 * (ID-148.10, TECH §3.1(a), INV-2/INV-12(a)/INV-13).
 *
 * Repurposes the roadmap server arm (Option C) — this file REPLACES
 * `roadmap-schema.ts`. It is the UPSTREAM authoritative source; canonical
 * `lib/validation/initiatives-schema.ts` (the DONE `{148.5}` artifact) is
 * re-vendored FROM here at `{148.12}` (same symbols, same import-specifier
 * convention as the other three vendored schema modules).
 *
 * Shape (TECH §1.4 — verified against the live ledger): `initiatives[]` ->
 * `projects[]` + recursive `sub-initiatives[]` (which themselves carry
 * `projects[]` + further `sub-initiatives[]`, arbitrary depth). `projects[]`
 * entries are addressed by a GLOBALLY-UNIQUE slug `id` across the whole tree
 * (audit A9) — the server write arm's nested addressing (INV-13) depends on
 * that global uniqueness, not schema-enforced here (a duplicate-slug create
 * is rejected at the mutate layer, `record-mutate.ts`).
 *
 * Lenient read / strict write on `status` (INV-2/INV-3): every `status`
 * field below types as `z.string()` — never `z.enum()`, and never
 * `z.enum().catch()` (a `.catch()` would silently coerce a dirty legacy
 * value, losing information). This lets `GET`/list reads parse the current,
 * imperfect `initiatives.json` (dirty project statuses, initiative-4-style
 * off-project links, mixed/absent `substrate_doc`) with no clean-data
 * precondition. A mutation that SETS `status` re-validates against
 * `INITIATIVE_STATUSES` / `PROJECT_STATUSES` at the server strict-write gate
 * (`patch-apply.ts`) — enforcement does not live in this schema.
 *
 * No `.strict()` on any record object below (tolerates incidental fields
 * during the data-quality transition) — only the root `InitiativesSchema`
 * is `.strict()`.
 */

import { z } from 'zod';

// ──────────────────────────────────────────────────────────────────────────
// Status vocabularies (TECH §2 behaviour contract). Exported for the
// server strict-write gate + any discoverability surface.
// ──────────────────────────────────────────────────────────────────────────

/** Initiative / sub-initiative status vocabulary. */
export const INITIATIVE_STATUSES = [
  'proposed',
  'planned',
  'active',
  'completed',
  'cancelled',
] as const;
export type InitiativeStatus = (typeof INITIATIVE_STATUSES)[number];

/** Project status vocabulary (11 values). */
export const PROJECT_STATUSES = [
  'idea',
  'proposal',
  'backlog',
  'discovery',
  'accepted',
  'ready',
  'paused',
  'in-progress',
  'maintenance',
  'completed',
  'cancelled',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

// ──────────────────────────────────────────────────────────────────────────
// ProjectSchema — the 11 fields of TECH §1.4. NOT .strict().
// ──────────────────────────────────────────────────────────────────────────

export const ProjectSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string(),
  description: z.string(),
  /** May be `""` — present on every live project (TECH §1.4). */
  substrate_doc: z.string(),
  /** Lenient read (INV-2 / INV-3) — any string; enum enforced at write time only. */
  status: z.string(),
  blocked_by: z.array(z.string()),
  blocking: z.array(z.string()),
  linked_tasks: z.array(z.string()),
  linked_backlog: z.array(z.string()),
  originating_session: z.array(z.string()),
});
export type Project = z.infer<typeof ProjectSchema>;

// ──────────────────────────────────────────────────────────────────────────
// SubInitiativeSchema — recursive via z.lazy. `substrate_doc` OPTIONAL
// (absent on nodes without substrate documentation, e.g. the live
// "Knowledge base foundations" sub-initiative).
// ──────────────────────────────────────────────────────────────────────────

/** Plain-TS mirror of the recursive Zod shape, required for `z.lazy` typing. */
export interface SubInitiative {
  id: string;
  title: string;
  description: string;
  substrate_doc?: string;
  status: string;
  projects: Project[];
  originating_session: string[];
  'sub-initiatives': SubInitiative[];
}

export const SubInitiativeSchema: z.ZodType<SubInitiative> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string(),
    substrate_doc: z.string().optional(),
    status: z.string(),
    projects: z.array(ProjectSchema),
    originating_session: z.array(z.string()),
    'sub-initiatives': z.array(SubInitiativeSchema),
  }),
);

// ──────────────────────────────────────────────────────────────────────────
// InitiativeSchema — like SubInitiativeSchema, plus OPTIONAL
// linked_tasks/linked_backlog (initiative-4 transitional tolerance — audit
// A3 / INV-2). Redistributing those off-project links is out of scope of
// the server arm; it's a data-quality-task concern.
// ──────────────────────────────────────────────────────────────────────────

export const InitiativeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  substrate_doc: z.string().optional(),
  status: z.string(),
  projects: z.array(ProjectSchema),
  /** Transitional tolerance — only initiative `id:"4"` carries these today. */
  linked_tasks: z.array(z.string()).optional(),
  linked_backlog: z.array(z.string()).optional(),
  originating_session: z.array(z.string()),
  'sub-initiatives': z.array(SubInitiativeSchema),
});
export type Initiative = z.infer<typeof InitiativeSchema>;

// ──────────────────────────────────────────────────────────────────────────
// InitiativesSchema — root document. `.strict()` permitted at root only.
// ──────────────────────────────────────────────────────────────────────────

export const InitiativesSchema = z
  .object({
    document_name: z.literal('Canonical Platform - Initiatives'),
    document_purpose: z.string(),
    date: z.string(),
    /**
     * Document-level status marker (currently `"active"`) — distinct from
     * the initiative/project status vocabularies above. Lenient `z.string()`
     * per the lenient-read design, not either enum (TECH §3.2).
     */
    status: z.string(),
    related_documents: z.array(z.string()),
    last_updated: z.string(),
    initiatives: z.array(InitiativeSchema),
  })
  .strict();
export type InitiativesDocument = z.infer<typeof InitiativesSchema>;

// ──────────────────────────────────────────────────────────────────────────
// INITIATIVES_BUDGETS — cap-free parse; caps enforced on write only.
//
// PLAIN DATA, never a Zod `.max()` constraint — a `z.string().max(N)` here
// would reject the live, legitimately over-budget ledger at parse time.
// Budgets are surfaced as SOFT warnings by `parseInitiativesWithWarnings`
// below; `ledger-budgets.ts`'s `project`/`initiative` entries are the
// SEPARATE write-time hard-gate registry the server's `budget-gate.ts`
// consumes (same two-registry split the `theme` budgets used before —
// `ledger-budgets.ts` for the write gate, a schema-module-local registry
// for the parse-time soft warning).
// ──────────────────────────────────────────────────────────────────────────

export const INITIATIVES_BUDGETS = {
  /** Markdown scope statement — same class as `LEDGER_BUDGETS.task.description`. */
  initiative: {
    description: 1500,
  },
  project: {
    /** One-sentence summary — same class as `LEDGER_BUDGETS.item.description`. */
    summary: 500,
    /** Fuller markdown body — same class as `LEDGER_BUDGETS.task.description`. */
    description: 1500,
  },
} as const;

// ──────────────────────────────────────────────────────────────────────────
// parseInitiativesWithWarnings — D2 git-ignored substrate_doc warning +
// INITIATIVES_BUDGETS field-length warnings.
// ──────────────────────────────────────────────────────────────────────────

/** Directories a consuming repo's `.gitignore` marks untracked. */
const GITIGNORED_SUBSTRATE_DIRS = ['.user-scratch', '.lavish'] as const;

/**
 * A warning raised by `parseInitiativesWithWarnings` — either a `substrate_doc`
 * pointing into a git-ignored directory (D2) or an over-budget
 * description/summary field (`INITIATIVES_BUDGETS`). `path` is a
 * `>`-separated walk from the top-level initiative id down to the offending
 * node (e.g. `"4>2>project:foo"`), scoping the warning for the caller.
 */
export interface InitiativesWarning {
  path: string;
  message: string;
}

/**
 * `substrate_doc` targets a git-ignored dir when a path segment exactly
 * matches one of `GITIGNORED_SUBSTRATE_DIRS` — a segment-wise check (not a
 * substring match) so a name like `docs/my.lavish-report/notes.md` does NOT
 * false-positive against `.lavish`.
 */
function gitignoredSubstrateDocWarning(
  substrateDoc: string | undefined,
  path: string,
): InitiativesWarning | null {
  if (!substrateDoc) return null;
  const segments = substrateDoc.split('/').filter(Boolean);
  const hitDir = GITIGNORED_SUBSTRATE_DIRS.find((dir) =>
    segments.includes(dir),
  );
  if (!hitDir) return null;
  return {
    path,
    message:
      `substrate_doc "${substrateDoc}" at "${path}" targets the git-ignored ` +
      `"${hitDir}/" directory — un-tracked, un-shareable storage. Warn-now; ` +
      `promotion to a hard rejection is gated on ratifying the staging-not-storage ` +
      `policy (TECH §3.2 Decision 2).`,
  };
}

function projectBudgetWarnings(
  project: Project,
  path: string,
): InitiativesWarning[] {
  const warnings: InitiativesWarning[] = [];
  if (project.summary.length > INITIATIVES_BUDGETS.project.summary) {
    warnings.push({
      path,
      message:
        `Project "${project.id}" summary is ${project.summary.length} chars ` +
        `(budget ${INITIATIVES_BUDGETS.project.summary}). Keep it a one-sentence ` +
        `summary; move detail to description or substrate_doc.`,
    });
  }
  if (project.description.length > INITIATIVES_BUDGETS.project.description) {
    warnings.push({
      path,
      message:
        `Project "${project.id}" description is ${project.description.length} chars ` +
        `(budget ${INITIATIVES_BUDGETS.project.description}). Move detail to ` +
        `substrate_doc and reference it there.`,
    });
  }
  return warnings;
}

function walkNode(
  node: Initiative | SubInitiative,
  path: string,
  warnings: InitiativesWarning[],
): void {
  const substrateWarning = gitignoredSubstrateDocWarning(
    node.substrate_doc,
    path,
  );
  if (substrateWarning) warnings.push(substrateWarning);

  if (node.description.length > INITIATIVES_BUDGETS.initiative.description) {
    warnings.push({
      path,
      message:
        `Initiative "${node.id}" description is ${node.description.length} chars ` +
        `(budget ${INITIATIVES_BUDGETS.initiative.description}). Move detail to ` +
        `substrate_doc and reference it there.`,
    });
  }

  for (const project of node.projects) {
    const projectPath = `${path}>project:${project.id}`;
    const projectSubstrateWarning = gitignoredSubstrateDocWarning(
      project.substrate_doc,
      projectPath,
    );
    if (projectSubstrateWarning) warnings.push(projectSubstrateWarning);
    warnings.push(...projectBudgetWarnings(project, projectPath));
  }

  for (const sub of node['sub-initiatives']) {
    walkNode(sub, `${path}>${sub.id}`, warnings);
  }
}

/**
 * Parse an Initiatives document and surface non-fatal warnings for (a) any
 * `substrate_doc` pointing into a git-ignored directory (D2 — warn-now /
 * reject-later) and (b) any `initiative.description` / `project.summary` /
 * `project.description` exceeding its `INITIATIVES_BUDGETS` soft cap.
 *
 * Throws `ZodError` on hard validation failure (same behaviour as
 * `InitiativesSchema.parse()`). On success, returns the parsed document plus
 * a `warnings` array — empty when nothing is flagged (`ok:true` either way).
 */
export function parseInitiativesWithWarnings(input: unknown): {
  value: InitiativesDocument;
  warnings: InitiativesWarning[];
} {
  const value = InitiativesSchema.parse(input);
  const warnings: InitiativesWarning[] = [];

  for (const initiative of value.initiatives) {
    walkNode(initiative, initiative.id, warnings);
  }

  return { value, warnings };
}
