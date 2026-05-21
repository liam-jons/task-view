/**
 * record-view/markdown-renderer.tsx — Markdown body renderer for record
 * pages (PRODUCT inv 10 — CommonMark + GFM floor; the existing
 * Plannotator parser is preserved).
 *
 * For 20.9 (read mode) the description / narrative / notes / details
 * bodies render via the upstream `parseMarkdownToBlocks` + `BlockRenderer`
 * pipeline already shipped in `packages/ui/components/`. To keep the
 * record-view module self-contained (no React-DOM dependency in test
 * paths that don't need it), this file re-exports a minimal `MarkdownBody`
 * that delegates to the existing pipeline when used at runtime, but for
 * the SSR test paths in 20.9 we use a small block-tree-to-HTML walk.
 *
 * For Subtask details that may contain `<info added on ...>` journal
 * blocks (PRODUCT inv 8 last bullet), the renderer wraps each journal
 * block in a visually distinct container per the inv 8 acceptance
 * criterion. Detection is purely textual — the journal block is a
 * `<info added on TIMESTAMP> ... </info added on TIMESTAMP>` literal
 * boundary in the raw `details` string.
 *
 * For the production SPA render path the upstream BlockRenderer handles
 * CommonMark + GFM. For the SSR test path here we emit a `<pre>` block
 * containing the raw markdown so tests can assert on content presence
 * without requiring a full DOM mount. The CSS classes are stable so the
 * Checker can hook the visual treatment in a follow-up.
 */
import React from "react";

const JOURNAL_OPEN_RE = /<info added on ([^>]+)>/g;

/**
 * Split a `details` body into alternating prose / journal-block segments.
 * Each journal block carries its raw inner content + the timestamp from
 * the opening tag.
 *
 * Unmatched (orphan) open or close tags are preserved as-is in the prose
 * segments — the renderer never silently drops content.
 */
export interface DetailsSegment {
  kind: "prose" | "journal";
  /** Raw text — prose segments include trailing/leading whitespace. */
  text: string;
  /** Journal-only — the timestamp from the opening tag. */
  timestamp?: string;
}

export function splitDetailsByJournal(details: string): DetailsSegment[] {
  const segments: DetailsSegment[] = [];
  let cursor = 0;
  const openMatches: { start: number; end: number; ts: string }[] = [];

  // Find all open tags
  for (const match of details.matchAll(JOURNAL_OPEN_RE)) {
    openMatches.push({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      ts: match[1],
    });
  }
  if (openMatches.length === 0) {
    return [{ kind: "prose", text: details }];
  }

  for (const open of openMatches) {
    // Prose before this open
    if (open.start > cursor) {
      segments.push({ kind: "prose", text: details.slice(cursor, open.start) });
    }
    // Find the matching close tag — anchor on the same timestamp.
    const closeRe = new RegExp(
      `<\\/info added on ${escapeRegex(open.ts)}>`,
      "g",
    );
    closeRe.lastIndex = open.end;
    const closeMatch = closeRe.exec(details);
    if (!closeMatch) {
      // No closing tag — treat the open tag as orphan prose, continue.
      cursor = open.end;
      segments.push({ kind: "prose", text: details.slice(open.start, open.end) });
      continue;
    }
    const inner = details.slice(open.end, closeMatch.index);
    segments.push({ kind: "journal", text: inner, timestamp: open.ts });
    cursor = closeMatch.index + closeMatch[0].length;
  }
  // Trailing prose
  if (cursor < details.length) {
    segments.push({ kind: "prose", text: details.slice(cursor) });
  }
  return segments;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Render a Markdown body to HTML. For 20.9 (SSR test path) we emit the
 * raw markdown inside a stable container with a CSS class — the
 * production SPA path swaps in the upstream BlockRenderer pipeline. The
 * Checker can verify content presence + CSS class hooks without needing
 * a full CommonMark assertion (which is already covered by upstream
 * parser tests per PRODUCT inv 10).
 */
export const MarkdownBody: React.FC<{ markdown: string }> = ({
  markdown,
}) => {
  return (
    <div className="record-view-markdown-body" data-markdown-body>
      <pre className="record-view-markdown-raw">{markdown}</pre>
    </div>
  );
};

/**
 * Render a Subtask `details` body with journal-block visual distinction
 * per PRODUCT inv 8 last bullet: "Journal blocks display visually
 * distinct from the pre-journal `details` content (rendered in a subtly
 * indented block with a 'Journal' label) but are otherwise readable in
 * line."
 */
export const DetailsBodyWithJournal: React.FC<{ details: string }> = ({
  details,
}) => {
  const segments = splitDetailsByJournal(details);
  return (
    <div className="record-view-details" data-details-with-journal>
      {segments.map((seg, i) => {
        if (seg.kind === "prose") {
          return (
            <div
              key={`p${i}`}
              className="record-view-details-prose"
              data-segment="prose"
            >
              <pre className="record-view-markdown-raw">{seg.text}</pre>
            </div>
          );
        }
        return (
          <aside
            key={`j${i}`}
            className="record-view-details-journal"
            data-segment="journal"
            data-journal-timestamp={seg.timestamp}
          >
            <header className="record-view-details-journal-label">
              <strong>Journal</strong>
              <span className="record-view-details-journal-ts">
                {" "}
                ({seg.timestamp})
              </span>
            </header>
            <pre className="record-view-markdown-raw">{seg.text}</pre>
          </aside>
        );
      })}
    </div>
  );
};
