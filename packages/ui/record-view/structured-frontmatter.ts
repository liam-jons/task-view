/**
 * record-view/structured-frontmatter.ts — viewer-side YAML extension
 * that parses nested DocLink arrays out of mirror frontmatter.
 *
 * The upstream `parser.ts` `extractFrontmatter` returns
 * `{ [k: string]: string | string[] }` — it CANNOT read the nested
 * object shape that the mirror generator emits for `cross_doc_links`
 * and `spec_links`:
 *
 *   cross_doc_links:
 *     - path: docs/foo.md
 *       anchor: null
 *       raw: "foo"
 *
 * The 20.7 Executor's journal flagged this limitation for 20.9.
 * `parseStructuredFrontmatter()` extends the YAML grammar JUST enough
 * to read the DocLink shape (the only nested-object array shape the
 * mirror generator produces). All other fields fall through to the
 * existing flat shape.
 *
 * Pure function; no I/O. The mirror-side renderer in 20.9 prefers to
 * accept the typed `Task` / `Project` / etc. records directly
 * (via `GET /api/ledger/record/:id`); this helper exists for the SPA
 * fallback path that loads the .md mirror standalone.
 */

import type { DocLink } from "@task-view/schemas/doc-link";

/**
 * Discriminated value: a structured frontmatter field is either:
 *   - a scalar string,
 *   - an array of strings (flow-list `[a, b]` or block-list of bare items),
 *   - an array of DocLink objects (block-list with `path:` `anchor:` `raw:`),
 *   - the literal `null` (from `key: null`).
 */
export type StructuredFrontmatterValue =
  | string
  | string[]
  | DocLink[]
  | null;

export type StructuredFrontmatter = Record<string, StructuredFrontmatterValue>;

/**
 * Parse a mirror's frontmatter into structured values, with nested
 * DocLink array support. Pass the raw frontmatter body (the lines
 * between the `---` delimiters); the upstream `extractFrontmatter` can
 * give you that prefix via `extractFrontmatterRaw` below.
 */
export function parseStructuredFrontmatter(
  body: string,
): StructuredFrontmatter {
  const fm: StructuredFrontmatter = {};
  const lines = body.split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "") {
      i++;
      continue;
    }

    // Top-level `key:` (no leading whitespace)
    const keyMatch = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!keyMatch) {
      i++;
      continue;
    }
    const key = keyMatch[1];
    const rest = keyMatch[2];

    if (rest === "") {
      // Block list / object — look at the next non-blank line to decide.
      // (a) `- path: ...` → nested DocLink array
      // (b) `- value` → flat string array
      // (c) no following block → null
      const peekIdx = findNextNonBlank(lines, i + 1);
      if (peekIdx === -1) {
        fm[key] = null;
        i++;
        continue;
      }
      const peekTrim = lines[peekIdx].trim();
      if (peekTrim.startsWith("- path:")) {
        // Consume DocLink block list
        const consumed = consumeDocLinkBlock(lines, peekIdx);
        fm[key] = consumed.links;
        i = consumed.nextIndex;
      } else if (peekTrim.startsWith("- ")) {
        // Consume flat string block list
        const consumed = consumeBareStringBlock(lines, peekIdx);
        fm[key] = consumed.values;
        i = consumed.nextIndex;
      } else {
        fm[key] = null;
        i++;
      }
      continue;
    }

    // Scalar or flow-array on the same line
    fm[key] = parseScalarOrFlowArray(rest);
    i++;
  }

  return fm;
}

function findNextNonBlank(lines: readonly string[], from: number): number {
  for (let i = from; i < lines.length; i++) {
    if (lines[i].trim() !== "") return i;
  }
  return -1;
}

/**
 * Consume a sequence of `- path: X\n  anchor: Y\n  raw: Z` blocks
 * starting at `start`. Returns the parsed DocLink array and the index of
 * the next unconsumed line.
 */
function consumeDocLinkBlock(
  lines: readonly string[],
  start: number,
): { links: DocLink[]; nextIndex: number } {
  const links: DocLink[] = [];
  let i = start;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed === "") {
      i++;
      continue;
    }
    // A new top-level key terminates the block
    if (lines[i].match(/^[A-Za-z0-9_]+:/) && !lines[i].startsWith(" ")) {
      break;
    }
    // Expect `- path: ...`
    const pathMatch = trimmed.match(/^-\s+path:\s*(.+)$/);
    if (!pathMatch) break;
    const pathValue = unquoteScalar(pathMatch[1]);

    // Look for anchor and raw on subsequent indented lines
    let anchor: string | null = null;
    let raw: string = "";
    let j = i + 1;
    while (j < lines.length) {
      const subTrim = lines[j].trim();
      if (subTrim === "") {
        j++;
        continue;
      }
      // Another `- path:` starts a new entry
      if (subTrim.startsWith("- path:")) break;
      // New top-level key ends the block
      if (lines[j].match(/^[A-Za-z0-9_]+:/) && !lines[j].startsWith(" ")) break;
      const anchorMatch = subTrim.match(/^anchor:\s*(.+)$/);
      const rawMatch = subTrim.match(/^raw:\s*(.+)$/);
      if (anchorMatch) {
        const v = unquoteScalar(anchorMatch[1]);
        anchor = v === "null" ? null : v;
      } else if (rawMatch) {
        raw = unquoteScalar(rawMatch[1]);
      }
      j++;
    }

    links.push({ path: pathValue, anchor, raw });
    i = j;
  }
  return { links, nextIndex: i };
}

function consumeBareStringBlock(
  lines: readonly string[],
  start: number,
): { values: string[]; nextIndex: number } {
  const values: string[] = [];
  let i = start;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed === "") {
      i++;
      continue;
    }
    if (!trimmed.startsWith("- ")) break;
    values.push(unquoteScalar(trimmed.slice(2).trim()));
    i++;
  }
  return { values, nextIndex: i };
}

function parseScalarOrFlowArray(rest: string): string | string[] | null {
  const trimmed = rest.trim();
  if (trimmed === "null") return null;
  // Flow-list `[a, b]` form
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === "") return [];
    // Split on commas not enclosed in quotes — simple form, good enough
    // for the mirror generator's emission (no nested objects in flow lists).
    return splitFlowList(inner).map(unquoteScalar);
  }
  return unquoteScalar(trimmed);
}

function splitFlowList(inner: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let inQuote = false;
  let escape = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (escape) {
      buf += ch;
      escape = false;
      continue;
    }
    if (ch === "\\" && inQuote) {
      escape = true;
      buf += ch;
      continue;
    }
    if (ch === '"') {
      inQuote = !inQuote;
      buf += ch;
      continue;
    }
    if (ch === "," && !inQuote) {
      parts.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim() !== "") parts.push(buf.trim());
  return parts;
}

function unquoteScalar(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  return t;
}

/**
 * Helper: extract the raw frontmatter body from a markdown document.
 * Returns `null` when there's no frontmatter block.
 *
 * Mirrors the front delimiter detection from `parser.ts`
 * `extractFrontmatter` but only returns the inner body — no need to
 * walk the rest of the markdown.
 */
export function extractFrontmatterRaw(markdown: string): string | null {
  const trimmed = markdown.trimStart();
  if (!trimmed.startsWith("---")) return null;
  const endIndex = trimmed.indexOf("\n---", 3);
  if (endIndex === -1) return null;
  return trimmed.slice(4, endIndex).trim();
}
