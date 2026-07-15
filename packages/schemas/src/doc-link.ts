/**
 * doc-link.ts — the cross-document reference schema shared by every ledger
 * (task-list / backlog / retro / initiatives).
 *
 * RELOCATED from `roadmap-schema.ts` (ID-148.10, TECH §3.1(a)/INV-12(c)) —
 * `DocLinkSchema` predates the roadmap ledger and has no roadmap-specific
 * shape; it lived there only because the roadmap schema module was the first
 * to need it. Repurposing the roadmap surface into `initiatives-schema.ts`
 * is a natural point to give it a neutral home so no ledger schema module
 * depends on another's file for a cross-cutting primitive.
 *
 * Canonical `lib/validation/doc-link.ts` is the vendored twin (re-vendored
 * from this file per {148.12}).
 */

import { z } from 'zod';

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
