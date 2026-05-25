/**
 * path-resolution.ts — TECH §2.2 + §2.3.
 *
 * Two responsibilities:
 *   1. `resolveLedgerForPath(path)` — when the user invokes task-view with
 *      a `.md` mirror path (per PRODUCT inv 6), ascend one directory level
 *      and find the sibling JSON file whose `document_name` matches one
 *      of the three known canonical values. Return the ledger path,
 *      detected kind, and the named record id (parsed from the mirror
 *      filename, with the Task-list 'ID-' prefix stripped where present).
 *      Roadmap themes + Backlog items carry their raw id (ID-20.19 themes[]
 *      world — there is no legacy 'section-' prefix to strip).
 *   2. `scanForLedgers(cwd)` — when no path is supplied (PRODUCT inv 43),
 *      scan the CWD for JSON files whose `document_name` matches one of
 *      the three known values. Return zero / one / multiple matches.
 *      Scan is non-recursive (TECH §2.3 explicit).
 *
 * Both functions are tolerant of parse failures during scanning — a JSON
 * file that does not parse or lacks a known document_name is silently
 * skipped, per TECH §2.3 wording "lenient — failure is just 'skip'".
 *
 * The third export — `buildLedgerLaunchUrl` — constructs the browser URL
 * that includes the `?record={id}` query fragment per the TECH §2.2 last
 * paragraph pre-selection requirement. The GET / SSR viewer (ID-20.17)
 * reads this fragment and renders the matching record's page directly.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import { KNOWN_DOCUMENT_NAMES, type KnownDocumentName } from "./detect-schema";

// ── Public types ──────────────────────────────────────────────────────────────

export type ResolvedLedger =
  | {
      kind: "ledger";
      ledgerPath: string;
      documentName: KnownDocumentName;
      recordId: string | null;
    }
  | { kind: "file-not-found" }
  | { kind: "unknown-format"; path: string; documentName: string | null }
  | { kind: "no-ledger"; searchedDir: string }
  | { kind: "multiple-ledgers"; searchedDir: string; paths: string[] };

export type ScanResult =
  | { kind: "none"; searchedDir: string }
  | { kind: "one"; path: string; documentName: KnownDocumentName }
  | { kind: "multiple"; paths: string[]; perPathName: Record<string, KnownDocumentName> };

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Read the first chunk of a JSON file and extract `document_name` if it's
 * one of the three known canonical values. Returns null on parse failure,
 * missing field, or non-canonical value.
 *
 * The chunk size (8 KiB) is generous enough to hold a typical ledger's
 * `document_name + document_purpose + last_updated` prefix; for safety we
 * fall back to reading the whole file if the partial parse fails.
 */
async function readDocumentNameIfKnown(
  filePath: string,
): Promise<KnownDocumentName | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const name = (parsed as { document_name?: unknown }).document_name;
  if (typeof name !== "string") return null;
  if ((KNOWN_DOCUMENT_NAMES as readonly string[]).includes(name)) {
    return name as KnownDocumentName;
  }
  return null;
}

/**
 * Parse a mirror filename stem into its record id.
 *
 * Inverse of `computeRecordFilename` from mirror-generator.ts:
 *   - Task-list mirrors carry the 'ID-' prefix → strip to recover the
 *     bare integer Task id.
 *   - Roadmap themes + Backlog items carry their raw id (no prefix). The
 *     legacy Roadmap 'section-' prefix was retired with the sections[]
 *     model in ID-20.19 (themes[] world) — there is nothing to strip.
 *
 * We do not attempt to reverse the §3.2 unsafe-char → '-' substitution
 * because the substitution is intentionally lossy; the viewer looks up
 * the record by walking the parsed ledger and comparing sanitised forms.
 * The raw stem is sufficient for record resolution.
 */
function parseMirrorStem(
  stem: string,
  documentName: KnownDocumentName,
): { recordId: string } {
  if (documentName === "Knowledge Hub Task List" && stem.startsWith("ID-")) {
    return { recordId: stem.slice(3) };
  }
  // Roadmap themes + Backlog items: raw stem is the id.
  return { recordId: stem };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve a user-supplied path into a ledger reference. Handles both
 * the JSON-ledger path (passthrough) and the .md mirror path
 * (record-level resolution per TECH §2.2).
 */
export async function resolveLedgerForPath(
  filePath: string,
): Promise<ResolvedLedger> {
  // Existence check first — distinguishes "file not found" from "wrong shape".
  try {
    await stat(filePath);
  } catch {
    return { kind: "file-not-found" };
  }

  const ext = extname(filePath).toLowerCase();

  if (ext === ".json") {
    const name = await readDocumentNameIfKnown(filePath);
    if (name) {
      return {
        kind: "ledger",
        ledgerPath: filePath,
        documentName: name,
        recordId: null,
      };
    }
    // Read once more to surface the actual document_name (if any) in the error.
    let docName: string | null = null;
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      const dn = (parsed as { document_name?: unknown })?.document_name;
      docName = typeof dn === "string" ? dn : null;
    } catch {
      docName = null;
    }
    return { kind: "unknown-format", path: filePath, documentName: docName };
  }

  if (ext === ".md") {
    // Ascend one directory level + find sibling ledger JSON.
    const parentDir = dirname(dirname(filePath));
    const scan = await scanForLedgers(parentDir);

    if (scan.kind === "none") {
      return { kind: "no-ledger", searchedDir: parentDir };
    }
    if (scan.kind === "multiple") {
      return {
        kind: "multiple-ledgers",
        searchedDir: parentDir,
        paths: scan.paths,
      };
    }

    // Exactly one ledger found in the parent dir.
    const stem = basename(filePath, ".md");
    const parsed = parseMirrorStem(stem, scan.documentName);
    return {
      kind: "ledger",
      ledgerPath: scan.path,
      documentName: scan.documentName,
      recordId: parsed.recordId,
    };
  }

  // Other extensions: treat as unknown.
  return { kind: "unknown-format", path: filePath, documentName: null };
}

/**
 * Scan a directory (non-recursive) for JSON files whose `document_name`
 * is one of the three known canonical values. Per TECH §2.3.
 */
export async function scanForLedgers(cwd: string): Promise<ScanResult> {
  let entries: string[];
  try {
    entries = await readdir(cwd);
  } catch {
    return { kind: "none", searchedDir: cwd };
  }
  const matches: Array<{ path: string; name: KnownDocumentName }> = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const full = join(cwd, entry);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const name = await readDocumentNameIfKnown(full);
    if (name) matches.push({ path: full, name });
  }

  if (matches.length === 0) return { kind: "none", searchedDir: cwd };
  if (matches.length === 1) {
    return { kind: "one", path: matches[0].path, documentName: matches[0].name };
  }
  const perPathName: Record<string, KnownDocumentName> = {};
  for (const m of matches) perPathName[m.path] = m.name;
  return {
    kind: "multiple",
    paths: matches.map((m) => m.path),
    perPathName,
  };
}

/**
 * Build the browser launch URL with an optional `?record={id}` query
 * fragment per TECH §2.2.
 *
 * The GET / SSR viewer (ID-20.17) reads `?record=` and renders the
 * matching record's page directly. When the supplied recordId is null,
 * we emit a bare `/` so the viewer lands on the index page.
 *
 * Roadmap themes resolve by bare-digit id (ID-20.19 themes[] world); the
 * retired `&section=1` fragment is gone — the SSR viewer never read it.
 */
export function buildLedgerLaunchUrl(
  base: string,
  opts: { recordId?: string | null },
): string {
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  if (opts.recordId == null || opts.recordId === "") {
    return `${trimmed}/`;
  }
  const encoded = encodeURIComponent(opts.recordId).replace(/%2[Ee]/g, ".");
  return `${trimmed}/?record=${encoded}`;
}
