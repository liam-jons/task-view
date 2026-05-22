/**
 * record-view/markdown-renderer.tsx — Markdown body renderer for record
 * pages (PRODUCT inv 10 — CommonMark + GFM floor; the existing
 * Plannotator parser is preserved).
 *
 * For 20.9 (read mode) the description / narrative / notes / details
 * bodies render via the upstream `parseMarkdownToBlocks` + `BlockRenderer`
 * pipeline already shipped in `packages/ui/components/`. The earlier
 * 20.9 implementation used a `<pre>` placeholder; the S64 W1 close-out
 * carryforward (Finding-4) rewires `MarkdownBody` to the full pipeline
 * so pipe-formatted tables, code blocks, headings, lists, and inline
 * emphasis all render correctly.
 *
 * For Subtask details that may contain `<info added on ...>` journal
 * blocks (PRODUCT inv 8 last bullet), the renderer wraps each journal
 * block in a visually distinct container per the inv 8 acceptance
 * criterion. Detection is purely textual — the journal block is a
 * `<info added on TIMESTAMP> ... </info added on TIMESTAMP>` literal
 * boundary in the raw `details` string.
 *
 * Both `MarkdownBody` and `DetailsBodyWithJournal` route through the
 * same upstream BlockRenderer pipeline. The previous `<pre>` rendering
 * path is GONE — that was a 20.9 placeholder, not a deliberate fallback.
 */
import React from "react";

import {
  parseMarkdownToBlocks,
  computeListIndices,
} from "../utils/parser";
import { BlockRenderer } from "../components/BlockRenderer";
import type { Block } from "../types";

/**
 * Group consecutive list-item blocks into a single render group. Matches
 * the Viewer.tsx convention so ordered-list numbering is correct (per
 * `computeListIndices`) and list items share a container.
 *
 * The Viewer.tsx version of this helper is internal — replicated here
 * to keep the record-view package self-contained without forcing an
 * extra public-API surface on the components package.
 */
type RenderGroup =
  | { type: "single"; block: Block }
  | { type: "list-group"; blocks: Block[]; key: string };

function groupBlocks(blocks: Block[]): RenderGroup[] {
  const groups: RenderGroup[] = [];
  let i = 0;
  while (i < blocks.length) {
    if (blocks[i].type === "list-item") {
      const listBlocks: Block[] = [];
      while (i < blocks.length && blocks[i].type === "list-item") {
        listBlocks.push(blocks[i]);
        i++;
      }
      groups.push({
        type: "list-group",
        blocks: listBlocks,
        key: `list-${listBlocks[0].id}`,
      });
    } else {
      groups.push({ type: "single", block: blocks[i] });
      i++;
    }
  }
  return groups;
}

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
 * Render a Markdown body to HTML via the upstream CommonMark + GFM
 * pipeline. Routes through `parseMarkdownToBlocks` → `groupBlocks` →
 * `BlockRenderer` so pipe tables, code blocks, headings, lists, and
 * inline emphasis all render correctly (PRODUCT inv 10 floor).
 *
 * Empty markdown renders an empty container — no `<pre>` placeholder.
 *
 * The container retains the `record-view-markdown-body` class +
 * `data-markdown-body` attribute as a stable hook for CSS / tests.
 */
export const MarkdownBody: React.FC<{ markdown: string }> = ({
  markdown,
}) => {
  const blocks = parseMarkdownToBlocks(markdown);
  return (
    <div className="record-view-markdown-body" data-markdown-body>
      {renderBlockGroups(blocks)}
    </div>
  );
};

/**
 * Iterate parsed blocks → grouped render units → BlockRenderer calls.
 * Extracted as a helper so DetailsBodyWithJournal can reuse it for the
 * prose segments without duplicating the group + BlockRenderer call
 * fan-out.
 */
function renderBlockGroups(blocks: Block[]): React.ReactElement[] {
  return groupBlocks(blocks).map((group) => {
    if (group.type === "list-group") {
      const indices = computeListIndices(group.blocks);
      return (
        <div key={group.key} data-render-group="list">
          {group.blocks.map((block, i) => (
            <BlockRenderer
              key={block.id}
              block={block}
              orderedIndex={indices[i]}
            />
          ))}
        </div>
      );
    }
    return <BlockRenderer key={group.block.id} block={group.block} />;
  });
}

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
          // Prose segments route through the same CommonMark + GFM
          // pipeline as MarkdownBody — empty / whitespace-only segments
          // are skipped to avoid stray empty containers between
          // adjacent journal blocks.
          if (seg.text.trim() === "") return null;
          return (
            <div
              key={`p${i}`}
              className="record-view-details-prose"
              data-segment="prose"
            >
              {renderBlockGroups(parseMarkdownToBlocks(seg.text))}
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
            <div className="record-view-details-journal-body">
              {renderBlockGroups(parseMarkdownToBlocks(seg.text))}
            </div>
          </aside>
        );
      })}
    </div>
  );
};
