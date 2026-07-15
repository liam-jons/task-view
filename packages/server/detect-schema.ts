/**
 * detect-schema.ts — TECH §2.1 schema discriminator (five known kinds).
 *
 * Routes a parsed-JSON value to one of the five document kinds by matching
 * the canonical `document_name` value, then runs the matching Zod schema
 * `.parse(...)` to coerce + validate.
 *
 * | document_name literal                     | Discriminator → kind          |
 * |--------------------------------------------|-------------------------------|
 * | "Knowledge Hub Task List"                  | TaskListSchema → 'task-list'  |
 * | "Canonical Platform - Initiatives"         | InitiativesSchema → 'initiatives' (ID-148.10, TECH §3.1(b), INV-12(a)) |
 * | "Product Backlog"                           | BacklogSchema  → 'backlog'    |
 * | "Knowledge Hub Retros"                      | RetrosSchema → 'retro'        |
 * | anything else                               | → 'unknown' + raw documentName (string or null) |
 *
 * ID-148.10 (Option C): repurposes the roadmap arm — `"Knowledge Hub
 * Roadmap"` is replaced by `"Canonical Platform - Initiatives"` routing to
 * `InitiativesSchema`; the `umbrellas` kind is RETIRED entirely (INV-12(b) —
 * the umbrella surface has no initiatives analog and is fully removed, both
 * repos, tests included; `umbrellas.json` file deletion itself stays
 * DEFERRED to the data-quality task, out of scope here).
 *
 * PRODUCT inv 4 asymmetry: `TaskListSchema.document_name` and
 * `InitiativesSchema.document_name` are `z.literal(...)`. `BacklogSchema.document_name`
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
import {
  InitiativesSchema,
  type InitiativesDocument,
} from "@task-view/schemas/initiatives";
import { BacklogSchema, type BacklogDocument } from "@task-view/schemas/backlog";
import { RetrosSchema, type RetrosDocument } from "@task-view/schemas/retro";

export type DetectSchemaResult =
  | { kind: "task-list"; data: TaskList }
  | { kind: "initiatives"; data: InitiativesDocument }
  | { kind: "backlog"; data: BacklogDocument }
  | { kind: "retro"; data: RetrosDocument }
  | { kind: "unknown"; documentName: string | null };

/** Canonical literal values. Source of truth for both routing and CLI error messages. */
export const KNOWN_DOCUMENT_NAMES = [
  "Knowledge Hub Task List",
  "Canonical Platform - Initiatives",
  "Product Backlog",
  "Knowledge Hub Retros",
] as const;

export type KnownDocumentName = (typeof KNOWN_DOCUMENT_NAMES)[number];

/**
 * Discriminate a parsed-JSON value by its `document_name` field and run the
 * matching schema parse. Throws `ZodError` if a body fails validation.
 *
 * @param parsed - The result of `JSON.parse(...)` on a candidate ledger file.
 * @returns A discriminated union with the matched kind + typed data, or
 *          `{ kind: 'unknown', documentName }` if the document_name is not
 *          one of the known values.
 */
export function detectSchema(parsed: unknown): DetectSchemaResult {
  if (!parsed || typeof parsed !== "object") {
    return { kind: "unknown", documentName: null };
  }

  const documentName = (parsed as { document_name?: unknown }).document_name;

  if (documentName === "Knowledge Hub Task List") {
    return { kind: "task-list", data: TaskListSchema.parse(parsed) };
  }
  // ID-148.10: repurposed roadmap arm — routes to the nested initiatives shape.
  if (documentName === "Canonical Platform - Initiatives") {
    return { kind: "initiatives", data: InitiativesSchema.parse(parsed) };
  }
  if (documentName === "Product Backlog") {
    return { kind: "backlog", data: BacklogSchema.parse(parsed) };
  }
  if (documentName === "Knowledge Hub Retros") {
    return { kind: "retro", data: RetrosSchema.parse(parsed) };
  }

  return {
    kind: "unknown",
    documentName: typeof documentName === "string" ? documentName : null,
  };
}
