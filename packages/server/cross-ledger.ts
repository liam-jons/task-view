/**
 * cross-ledger.ts — slug ↔ document_name map + sibling-path resolver for
 * cross-ledger navigation ({20.29}, SPEC §1/§2/§5).
 *
 * The nav surface routes `/?ledger=<slug>&record=<id>` to a SIBLING ledger
 * file living in the SAME directory as the launched ledger. This module
 * owns the stable, server-controlled slug ↔ canonical `document_name` map
 * and the directory scan that resolves a sibling's on-disk path by name.
 *
 * The slug ↔ name pairs are fixed (SPEC §2):
 *   task-list ↔ "Knowledge Hub Task List"
 *   roadmap   ↔ "Knowledge Hub Roadmap"
 *   backlog   ↔ "Product Backlog"
 * (Canonical names sourced from detect-schema.ts KNOWN_DOCUMENT_NAMES.)
 *
 * `resolveLedgerPathByName` reuses the exact `scanForLedgers(dirname)` +
 * `byName` map shape `resolveTransactionSiblings` relies on
 * (patch-server.ts) — siblings are resolved by their canonical
 * `document_name`, NOT by a conventional filename, so a non-canonically
 * named sibling in the dir still resolves.
 */
import { dirname } from "node:path";
import type { KnownDocumentName } from "./detect-schema";
import { scanForLedgers } from "./path-resolution";

/** The three cross-ledger nav slugs (stable, server-controlled). */
export type LedgerSlug = "task-list" | "roadmap" | "backlog";

/** Enumerated nav slugs — the membership set the URL parser validates against. */
export const LEDGER_SLUGS: readonly LedgerSlug[] = [
  "task-list",
  "roadmap",
  "backlog",
] as const;

/**
 * Slug → canonical `document_name`. The single source of truth for the
 * bidirectional map; the reverse direction is derived from this object.
 */
const SLUG_TO_DOCUMENT_NAME: Record<LedgerSlug, KnownDocumentName> = {
  "task-list": "Knowledge Hub Task List",
  roadmap: "Knowledge Hub Roadmap",
  backlog: "Product Backlog",
};

const DOCUMENT_NAME_TO_SLUG: Record<string, LedgerSlug> = Object.fromEntries(
  (Object.entries(SLUG_TO_DOCUMENT_NAME) as [LedgerSlug, KnownDocumentName][]).map(
    ([slug, name]) => [name, slug],
  ),
);

/** Map a canonical `document_name` to its nav slug, or null if unknown. */
export function slugForDocumentName(documentName: string): LedgerSlug | null {
  return DOCUMENT_NAME_TO_SLUG[documentName] ?? null;
}

/** Map a nav slug to its canonical `document_name`, or null if unknown. */
export function documentNameForSlug(slug: string): KnownDocumentName | null {
  return SLUG_TO_DOCUMENT_NAME[slug as LedgerSlug] ?? null;
}

/**
 * Resolve the on-disk path of a sibling ledger by its canonical
 * `document_name`, scanning the launched ledger's directory.
 *
 * Reuses `scanForLedgers(dirname(ledgerPath))` + the `byName` map shape
 * `resolveTransactionSiblings` already uses. Returns the launched ledger's
 * own path when `documentName` matches the launched ledger (a "self" nav
 * target). Returns null when no ledger with that `document_name` is present
 * in the directory.
 */
export async function resolveLedgerPathByName(
  ledgerPath: string,
  documentName: KnownDocumentName,
): Promise<string | null> {
  const dir = dirname(ledgerPath);
  const scan = await scanForLedgers(dir);
  const byName: Record<string, string> = {};
  if (scan.kind === "one") {
    byName[scan.documentName] = scan.path;
  } else if (scan.kind === "multiple") {
    for (const p of scan.paths) byName[scan.perPathName[p]] = p;
  }
  return byName[documentName] ?? null;
}
