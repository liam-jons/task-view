/**
 * detect-schema.ts — TECH §2.1 schema discriminator (four known kinds).
 *
 * Routes a parsed-JSON value to one of the four document kinds by matching
 * the canonical `document_name` value, then runs the matching Zod schema
 * `.parse(...)` to coerce + validate.
 *
 * | document_name literal           | Discriminator → kind         |
 * |----------------------------------|------------------------------|
 * | "Knowledge Hub Task List"       | TaskListSchema → 'task-list' |
 * | "Knowledge Hub Roadmap"         | RoadmapSchema  → 'roadmap'   |
 * | "Product Backlog"                | BacklogSchema  → 'backlog'   |
 * | "umbrellas"                      | UmbrellasSchema → 'umbrellas' (ID-90 U8, PRODUCT inv 49) |
 * | anything else                    | → 'unknown' + raw documentName (string or null) |
 *
 * ID-90 U8: `umbrellas` is the FOURTH known document kind. Its canonical
 * `document_name` IS the lowercase literal "umbrellas" (the vendored
 * UmbrellasSchema declares `z.literal('umbrellas')`). Umbrellas documents
 * carry NO mirror obligation (PRODUCT invariant 53 — mirror-generator
 * returns the empty plan) and membership edits are field PATCHes on
 * `['umbrellas', id, 'task_ids']` (invariant 50).
 *
 * PRODUCT inv 4 asymmetry: `TaskListSchema.document_name` and
 * `RoadmapSchema.document_name` are `z.literal(...)`. `BacklogSchema.document_name`
 * is `z.string().min(1)` (cannot self-discriminate). The discrimination here
 * anchors on the known canonical VALUE for Backlog, not on a Zod literal.
 *
 * On match, `schema.parse(parsed)` runs — this throws `ZodError` if the body
 * fails validation. PRODUCT inv 48 specifies: schema-validation failure on
 * load surfaces the formatted ZodError and exits non-zero. The CLI surface
 * (ID-20.11) catches the ZodError and renders the error page; this module
 * does not swallow.
 */

import { TaskListSchema, type TaskList } from "@task-view/schemas/task-list";
import { RoadmapSchema, type Roadmap } from "@task-view/schemas/roadmap";
import { BacklogSchema, type BacklogDocument } from "@task-view/schemas/backlog";
import { UmbrellasSchema, type Umbrellas } from "@task-view/schemas/umbrellas";

export type DetectSchemaResult =
  | { kind: "task-list"; data: TaskList }
  | { kind: "roadmap"; data: Roadmap }
  | { kind: "backlog"; data: BacklogDocument }
  | { kind: "umbrellas"; data: Umbrellas }
  | { kind: "unknown"; documentName: string | null };

/** Canonical literal values. Source of truth for both routing and CLI error messages. */
export const KNOWN_DOCUMENT_NAMES = [
  "Knowledge Hub Task List",
  "Knowledge Hub Roadmap",
  "Product Backlog",
  "umbrellas",
] as const;

export type KnownDocumentName = (typeof KNOWN_DOCUMENT_NAMES)[number];

/**
 * Discriminate a parsed-JSON value by its `document_name` field and run the
 * matching schema parse. Throws `ZodError` if a body fails validation.
 *
 * @param parsed - The result of `JSON.parse(...)` on a candidate ledger file.
 * @returns A discriminated union with the matched kind + typed data, or
 *          `{ kind: 'unknown', documentName }` if the document_name is not
 *          one of the three known values.
 */
export function detectSchema(parsed: unknown): DetectSchemaResult {
  if (!parsed || typeof parsed !== "object") {
    return { kind: "unknown", documentName: null };
  }

  const documentName = (parsed as { document_name?: unknown }).document_name;

  if (documentName === "Knowledge Hub Task List") {
    return { kind: "task-list", data: TaskListSchema.parse(parsed) };
  }
  if (documentName === "Knowledge Hub Roadmap") {
    return { kind: "roadmap", data: RoadmapSchema.parse(parsed) };
  }
  if (documentName === "Product Backlog") {
    return { kind: "backlog", data: BacklogSchema.parse(parsed) };
  }
  // ID-90 U8: fourth known kind — umbrellas (PRODUCT invariant 49).
  if (documentName === "umbrellas") {
    return { kind: "umbrellas", data: UmbrellasSchema.parse(parsed) };
  }

  return {
    kind: "unknown",
    documentName: typeof documentName === "string" ? documentName : null,
  };
}
