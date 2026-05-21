/**
 * record-view/broken-target.tsx — broken-target rendering primitives
 * (TECH §4.5, PRODUCT inv 11, 12, 13, 22).
 *
 * "Visual treatment: text rendered with strikethrough + a small `(missing)`
 *  suffix" — implemented as CSS-styled <span> elements. No Warm Meridian
 *  token dependency per inv 54 (the tool ships its own neutral palette;
 *  consumers may override via CSS targeting the data-* attributes).
 *
 * Three exported primitives:
 *   - `BrokenLink` — wraps a missing dependency or cross-doc link
 *   - `MaybeRecordLink` — renders a live anchor if the target id is in the
 *     ledger context, otherwise renders a `BrokenLink`
 *   - `MaybeCrossDocLink` — same behaviour for repo-relative path links
 *   - `PageTopWarning` — surfaces a one-line warning bar above the page
 *     body when at least one missing target was found
 *
 * Link `href` always uses forward slashes per PRODUCT inv 52 — even on
 * Windows, where filesystem paths would use backslashes. The renderer
 * normalises the input path before emission.
 */
import React from "react";
import type { ExistingPathsSet } from "./types";

const MISSING_SUFFIX = " (missing)";
const MISSING_TARGET_SUFFIX = " (missing target)";

/**
 * Normalise OS-native path separators to forward slashes for use in URL
 * hrefs. Applied at emission time per PRODUCT inv 52.
 */
export function toForwardSlashHref(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Render a strikethrough span with a "(missing)" or "(missing target)"
 * suffix per TECH §4.5.
 *
 * @param children - The text the missing link would have shown if live
 * @param suffix - 'record' → " (missing)"; 'doc' → " (missing target)"
 */
export const BrokenLink: React.FC<{
  children: React.ReactNode;
  suffix: "record" | "doc";
}> = ({ children, suffix }) => {
  return (
    <span
      className="record-view-broken-link"
      data-broken-target={suffix}
      style={{ textDecoration: "line-through", opacity: 0.6 }}
    >
      {children}
      <span className="record-view-broken-suffix" data-suffix>
        {suffix === "record" ? MISSING_SUFFIX : MISSING_TARGET_SUFFIX}
      </span>
    </span>
  );
};

/**
 * Render a link to another record (Task, Roadmap item, Roadmap section,
 * Backlog item) within the same ledger. If the target id is missing from
 * the ledger's presence set, render a `BrokenLink` instead.
 */
export const MaybeRecordLink: React.FC<{
  href: string;
  label: string;
  exists: boolean;
}> = ({ href, label, exists }) => {
  if (!exists) {
    return <BrokenLink suffix="record">{label}</BrokenLink>;
  }
  return (
    <a
      className="record-view-record-link"
      href={toForwardSlashHref(href)}
      data-record-link
    >
      {label}
    </a>
  );
};

/**
 * Render a link to a repo-relative cross-doc path. Existence is checked
 * against `existingPaths` when provided; when `null`, the link is
 * conservatively rendered live (the renderer treats "no check available"
 * as "do not flag").
 */
export const MaybeCrossDocLink: React.FC<{
  path: string;
  anchor: string | null;
  label: string;
  existingPaths: ExistingPathsSet;
}> = ({ path, anchor, label, existingPaths }) => {
  const exists = existingPaths === null ? true : existingPaths.has(path);
  const href = toForwardSlashHref(anchor ? `${path}${anchor}` : path);
  if (!exists) {
    return <BrokenLink suffix="doc">{label}</BrokenLink>;
  }
  return (
    <a className="record-view-doc-link" href={href} data-doc-link>
      {label}
    </a>
  );
};

/**
 * A one-line warning surface that lists missing-target ids found on the
 * page. Rendered above the page body per TECH §4.5: "A one-line page-top
 * warning ('This Task references dependencies that don't exist in the
 * ledger: ID-99') surfaces missing-target counts per inv 12."
 *
 * The component renders nothing when `missingIds` is empty so callers can
 * unconditionally mount it without an extra empty-state branch.
 */
export const PageTopWarning: React.FC<{
  /** Human-readable subject e.g. "This Task" or "This Backlog item". */
  subject: string;
  /** Missing ids; rendered as a comma-separated list. */
  missingIds: readonly string[];
}> = ({ subject, missingIds }) => {
  if (missingIds.length === 0) return null;
  return (
    <div
      className="record-view-page-top-warning"
      role="alert"
      data-page-top-warning
    >
      <strong>Warning:</strong> {subject} references dependencies that
      don&apos;t exist in the ledger: {missingIds.join(", ")}
    </div>
  );
};
