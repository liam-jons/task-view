/**
 * record-view/nav-strip.tsx — top-of-page navigation strip
 * (PRODUCT inv 7 last bullet, inv 14 back link, inv 20 back link).
 *
 * Renders a row of prev / index / next links. The data is provided by
 * the caller (SPA) — the renderer stays mode-agnostic.
 *
 * For first-record (`prevHref === null`) or last-record (`nextHref ===
 * null`) edges, the side without a target renders a disabled span so the
 * strip's geometry stays stable across records.
 */
import React from "react";
import type { NavStripData } from "./types";
import { toForwardSlashHref } from "./broken-target";

export const NavStrip: React.FC<{ data: NavStripData }> = ({ data }) => {
  return (
    <nav
      className="record-view-nav-strip"
      aria-label="Record navigation"
      data-nav-strip
    >
      <span className="record-view-nav-prev" data-nav-prev>
        {data.prevHref !== null ? (
          <a href={toForwardSlashHref(data.prevHref)} rel="prev">
            ← {data.prevLabel ?? "Previous"}
          </a>
        ) : (
          <span aria-disabled="true" data-nav-prev-disabled>
            ← (start of ledger)
          </span>
        )}
      </span>
      <span className="record-view-nav-index" data-nav-index>
        <a href={toForwardSlashHref(data.indexHref)}>{data.indexLabel}</a>
      </span>
      <span className="record-view-nav-next" data-nav-next>
        {data.nextHref !== null ? (
          <a href={toForwardSlashHref(data.nextHref)} rel="next">
            {data.nextLabel ?? "Next"} →
          </a>
        ) : (
          <span aria-disabled="true" data-nav-next-disabled>
            (end of ledger) →
          </span>
        )}
      </span>
    </nav>
  );
};
