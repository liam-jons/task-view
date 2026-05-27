/**
 * record-view/ledger-banner.tsx — read-only cross-ledger banner ({20.29},
 * SPEC §5 slice 7 / §6).
 *
 * Mounted by `renderViewer` ONLY when serving a SIBLING ledger (a read-only
 * cross-ledger nav target). Tells the reader which ledger they are in, that
 * it is read-only, which ledger was launched, and gives a one-click "Back to
 * launched ledger" link (to `/`). Without it, a user who follows a
 * cross-ledger link has no obvious way back to the editable launched ledger.
 */
import React from "react";
import type { LedgerSlug } from "./anchors";

/** Human-readable display name per nav slug ({20.29} §6). */
const LEDGER_DISPLAY_NAME: Record<LedgerSlug, string> = {
  "task-list": "Task List",
  roadmap: "Roadmap",
  backlog: "Backlog",
};

export const LedgerBanner: React.FC<{
  /** The sibling ledger being shown read-only. */
  siblingSlug: LedgerSlug;
  /** The ledger task-view was launched against (the editable one). */
  launchedSlug: LedgerSlug;
}> = ({ siblingSlug, launchedSlug }) => {
  const siblingName = LEDGER_DISPLAY_NAME[siblingSlug];
  const launchedName = LEDGER_DISPLAY_NAME[launchedSlug];
  return (
    <div
      className="record-view-ledger-banner"
      role="status"
      data-ledger-banner={siblingSlug}
    >
      <span className="record-view-ledger-banner-label">
        {siblingName} — read-only · launched ledger is {launchedName}
      </span>
      <a className="record-view-ledger-banner-back" href="/">
        Back to launched ledger
      </a>
    </div>
  );
};
