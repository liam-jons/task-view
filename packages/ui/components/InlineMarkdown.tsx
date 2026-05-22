/**
 * InlineMarkdown — task-view inline-markdown rendering primitives.
 *
 * `trimUrlTail` is the inherited pure helper (covered by
 * `InlineMarkdown.test.ts`).
 *
 * `InlineMarkdown` is the React component used by `BlockRenderer` to
 * render inline-level markdown (emphasis, bold, code spans, links).
 * Re-introduced in ID-20.11.e1 as part of the S64 W1 close-out
 * carryforward (Finding-4: MarkdownBody CommonMark rewire) — the
 * 20.6 fork strip removed the upstream annotation-coupled version,
 * and 20.9 deferred the re-implementation. This minimal version
 * covers the CommonMark + GFM floor (PRODUCT inv 10):
 *
 *   - bold:    `**text**` → `<strong>`
 *   - italic:  `*text*` / `_text_` → `<em>`
 *   - code:    `` `text` `` → `<code>`
 *   - link:    `[text](url)` → `<a href="url">text</a>`
 *   - autolink: bare URLs `https://...` → `<a>`
 *
 * The full annotation surface props (`imageBaseDir`, `onImageClick`,
 * `onOpenLinkedDoc`, `onOpenCodeFile`, `githubRepo`, `onNavigateAnchor`)
 * are accepted but only `onNavigateAnchor` is wired today — they
 * remain present in the prop type so the BlockRenderer call sites
 * compile unchanged and the annotation features can be re-attached
 * incrementally without churning the call sites.
 */
import React from "react";

// Trim trailing sentence punctuation from a bare URL, but keep closing
// brackets when they balance an opener inside the URL (Wikipedia-style
// https://…/Function_(mathematics) should keep its closing paren).
export function trimUrlTail(url: string): string {
  const balanced = (u: string, close: string, open: string): boolean => {
    let opens = 0, closes = 0;
    for (const c of u) {
      if (c === open) opens++;
      else if (c === close) closes++;
    }
    return opens >= closes;
  };
  while (url.length > 0) {
    const last = url[url.length - 1];
    if (!/[.,;:!?)\]}>"']/.test(last)) break;
    if (last === ')' && balanced(url, ')', '(')) break;
    if (last === ']' && balanced(url, ']', '[')) break;
    if (last === '}' && balanced(url, '}', '{')) break;
    url = url.slice(0, -1);
  }
  return url;
}

// ── InlineMarkdown component ─────────────────────────────────────────────────

export interface InlineMarkdownProps {
  text: string;
  /** Reserved for future image rendering (not wired yet). */
  imageBaseDir?: string;
  /** Reserved for future image click handler (not wired yet). */
  onImageClick?: (src: string, alt: string) => void;
  /** Reserved for future linked-doc navigation (not wired yet). */
  onOpenLinkedDoc?: (path: string) => void;
  /** Reserved for future code-file navigation (not wired yet). */
  onOpenCodeFile?: (path: string) => void;
  /** Reserved for future GitHub repo link formatting (not wired yet). */
  githubRepo?: string;
  /** Anchor-navigation callback for in-page links (`#anchor`). */
  onNavigateAnchor?: (hash: string) => void;
}

/**
 * Inline-markdown token. The parser produces a flat sequence of these
 * which the React render path maps to elements. We deliberately avoid
 * nested tokens (e.g. bold-inside-italic) to keep the parser tractable
 * — CommonMark's nesting rules are complex and outside the inv 10
 * floor that this minimal renderer satisfies. A future Subtask may
 * upgrade to a full CommonMark engine (remark, marked) without
 * changing this component's public prop surface.
 */
type InlineToken =
  | { kind: "text"; value: string }
  | { kind: "bold"; value: string }
  | { kind: "italic"; value: string }
  | { kind: "code"; value: string }
  | { kind: "link"; text: string; href: string };

// Token-order matters: code spans `` `…` `` must be matched first to
// shield their interior from emphasis-marker interpretation. Then
// links `[…](…)`. Then bold `**…**` (must precede italic to avoid
// `*` being eaten as italic markers). Then italic `*…*` / `_…_`.
const TOKEN_PATTERNS: Array<{
  kind: InlineToken["kind"];
  pattern: RegExp;
}> = [
  { kind: "code", pattern: /`([^`]+)`/ },
  { kind: "link", pattern: /\[([^\]]+)\]\(([^)]+)\)/ },
  { kind: "bold", pattern: /\*\*([^*]+)\*\*/ },
  { kind: "italic", pattern: /(?:\*([^*]+)\*|_([^_]+)_)/ },
];

function tokenize(text: string): InlineToken[] {
  const out: InlineToken[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    // Find the earliest match across all token types. We use match()
    // rather than exec() so the search restarts from index 0 each
    // iteration; the slice() at the bottom advances the cursor.
    let earliest:
      | { kind: InlineToken["kind"]; match: RegExpMatchArray; index: number }
      | null = null;
    for (const { kind, pattern } of TOKEN_PATTERNS) {
      const m = remaining.match(pattern);
      if (m && m.index !== undefined) {
        if (earliest === null || m.index < earliest.index) {
          earliest = { kind, match: m, index: m.index };
        }
      }
    }
    if (!earliest) {
      out.push({ kind: "text", value: remaining });
      break;
    }
    if (earliest.index > 0) {
      out.push({ kind: "text", value: remaining.slice(0, earliest.index) });
    }
    if (earliest.kind === "link") {
      out.push({
        kind: "link",
        text: earliest.match[1],
        href: earliest.match[2],
      });
    } else if (earliest.kind === "italic") {
      const v = earliest.match[1] ?? earliest.match[2] ?? "";
      out.push({ kind: "italic", value: v });
    } else {
      out.push({
        kind: earliest.kind,
        value: earliest.match[1],
      } as InlineToken);
    }
    remaining = remaining.slice(earliest.index + earliest.match[0].length);
  }
  return out;
}

export const InlineMarkdown: React.FC<InlineMarkdownProps> = ({
  text,
  onNavigateAnchor,
}) => {
  const tokens = tokenize(text);
  return (
    <>
      {tokens.map((t, i) => {
        switch (t.kind) {
          case "text":
            return <React.Fragment key={i}>{t.value}</React.Fragment>;
          case "bold":
            return <strong key={i}>{t.value}</strong>;
          case "italic":
            return <em key={i}>{t.value}</em>;
          case "code":
            return <code key={i}>{t.value}</code>;
          case "link": {
            const isAnchor = t.href.startsWith("#");
            if (isAnchor) {
              return (
                <a
                  key={i}
                  href={t.href}
                  onClick={(e) => {
                    if (onNavigateAnchor) {
                      e.preventDefault();
                      onNavigateAnchor(t.href);
                    }
                  }}
                >
                  {t.text}
                </a>
              );
            }
            return (
              <a key={i} href={t.href}>
                {t.text}
              </a>
            );
          }
        }
      })}
    </>
  );
};
