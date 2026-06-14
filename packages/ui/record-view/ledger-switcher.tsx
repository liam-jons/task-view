/**
 * record-view/ledger-switcher.tsx — runtime editable ledger switcher
 * (editable-ledger-switch SPEC §2). Replaces the read-only `ledger-banner`:
 * a nav of the launch directory's viewer-renderable ledgers, each an
 * EDITABLE switch target (`/?ledger=<slug>`). The active ledger is marked
 * `aria-current="page"`. Mounted by `renderViewer` on EVERY page (launched
 * + switched-to) so the reader can move between siblings and keep editing.
 *
 * The slug write seam (`patch-server.ts` `effCtx`) already routes a
 * slug-scoped write to the named sibling, so a switched-to ledger is a
 * first-class mutation target — there is no longer a read-only posture to
 * announce, only a directory of editable ledgers with one active.
 */
import React from "react";
import type { LedgerSlug } from "./anchors";

/** Human-readable display name per nav slug. */
const LEDGER_DISPLAY_NAME: Record<LedgerSlug, string> = {
  "task-list": "Task List",
  roadmap: "Roadmap",
  backlog: "Backlog",
};

/**
 * Canonical render order — stable regardless of directory scan order so the
 * switcher reads the same on every page.
 */
const LEDGER_ORDER: readonly LedgerSlug[] = ["task-list", "roadmap", "backlog"];

export const LedgerSwitcher: React.FC<{
  /** Viewer-renderable ledger slugs present in the launch directory. */
  available: readonly LedgerSlug[];
  /** The currently-rendered (active) ledger. */
  active: LedgerSlug;
}> = ({ available, active }) => {
  const present = LEDGER_ORDER.filter((slug) => available.includes(slug));
  return (
    <nav
      className="record-view-ledger-switcher"
      aria-label="Switch ledger"
      data-ledger-switcher=""
      data-active-ledger={active}
    >
      {present.map((slug) => {
        const isActive = slug === active;
        return (
          <a
            key={slug}
            className="record-view-ledger-switcher-item"
            href={`/?ledger=${slug}`}
            data-ledger-slug={slug}
            {...(isActive ? { "aria-current": "page" as const } : {})}
          >
            {LEDGER_DISPLAY_NAME[slug]}
          </a>
        );
      })}
    </nav>
  );
};
