/**
 * record-view/backlog-item-view.tsx — Backlog item page renderer.
 *
 * PRODUCT inv 21 (per-item: frontmatter + description + notes + details
 *              + testStrategy when present),
 *              22 (dependencies → inline links + missing-target marker),
 *              24 (Promotion-ready badge when details OR testStrategy
 *              present),
 *              25 (Blocked banner when status is blocked).
 * TECH §4.1 Backlog RecordFrontmatterCard, §4.5 broken-target marker.
 */
import React from "react";
import type { BacklogItem } from "@task-view/schemas/backlog";
import {
  MaybeCrossDocLink,
  MaybeRecordLink,
  PageTopWarning,
} from "./broken-target";
import { NavStrip } from "./nav-strip";
import {
  RecordFrontmatterCard,
  type FrontmatterRow,
} from "./record-frontmatter-card";
import {
  DetailsBodyWithJournal,
  MarkdownBody,
} from "./markdown-renderer";
import { backlogItemHref } from "./anchors";
import type { LedgerContext, NavStripData } from "./types";

export const BacklogItemView: React.FC<{
  item: BacklogItem;
  ledger: LedgerContext;
  nav: NavStripData;
}> = ({ item, ledger, nav }) => {
  const missingDeps = item.dependencies.filter(
    (depId) => !ledger.backlogItemIds.has(depId),
  );

  // Promotion-ready badge (PRODUCT inv 24): visible if `details` OR
  // `testStrategy` is non-null. Both nullable AND optional in the
  // schema; treat undefined the same as null.
  const promotionReady =
    (item.details !== null && item.details !== undefined) ||
    (item.testStrategy !== null && item.testStrategy !== undefined);

  const rows: FrontmatterRow[] = [
    { key: "id", label: "ID", value: item.id },
    { key: "type", label: "Type", value: item.type },
    { key: "status", label: "Status", value: item.status },
    {
      key: "effort_estimate",
      label: "Effort estimate",
      value: item.effort_estimate,
    },
    { key: "priority", label: "Priority", value: item.priority },
    { key: "track", label: "Track", value: item.track },
    {
      key: "dependencies",
      label: "Dependencies",
      value:
        item.dependencies.length === 0
          ? null
          : interleave(
              item.dependencies.map((depId) => (
                <MaybeRecordLink
                  key={depId}
                  href={backlogItemHref(depId)}
                  label={depId}
                  exists={ledger.backlogItemIds.has(depId)}
                />
              )),
              ", ",
            ),
    },
    {
      key: "session_refs",
      label: "Session refs",
      value:
        item.session_refs.length === 0
          ? null
          : item.session_refs.join(", "),
    },
    {
      key: "commit_refs",
      label: "Commit refs",
      value:
        item.commit_refs.length === 0 ? null : item.commit_refs.join(", "),
    },
    {
      key: "cross_doc_links",
      label: "Cross-doc links",
      value:
        item.cross_doc_links.length === 0
          ? null
          : interleave(
              item.cross_doc_links.map((link, i) => (
                <MaybeCrossDocLink
                  key={`${link.path}#${i}`}
                  path={link.path}
                  anchor={link.anchor}
                  label={link.raw}
                  existingPaths={ledger.existingPaths}
                />
              )),
              ", ",
            ),
    },
    {
      key: "notes",
      label: "Notes",
      value: item.notes,
    },
  ];

  // Per inv 21: details / testStrategy fields are rendered when present.
  // Show them as frontmatter rows too so the Checker can find them via
  // the shared `data-frontmatter-row` query.
  if (item.details !== null && item.details !== undefined) {
    rows.push({
      key: "details",
      label: "Details (present)",
      value: <em>see Details section below</em>,
    });
  }
  if (item.testStrategy !== null && item.testStrategy !== undefined) {
    rows.push({
      key: "test_strategy",
      label: "Test strategy (present)",
      value: <em>see Test strategy below</em>,
    });
  }

  return (
    <article
      className="record-view-backlog-item"
      data-record-kind="backlog-item"
      data-record-id={item.id}
    >
      <NavStrip data={nav} />

      {/* Blocked banner (PRODUCT inv 25) — same visual treatment as
          missing-dependency warnings per the spec. */}
      {item.status === "blocked" && (
        <div
          className="record-view-blocked-banner"
          role="alert"
          data-blocked-banner
        >
          <strong>Blocked.</strong> This Backlog item is currently
          blocked.
        </div>
      )}

      <PageTopWarning
        subject="This Backlog item"
        missingIds={missingDeps}
      />

      <header className="record-view-backlog-header">
        <h1>
          {`${item.id}: ${item.description}`}
        </h1>
        {promotionReady && (
          <span
            className="record-view-promotion-badge"
            data-promotion-ready
          >
            Promotion-ready
          </span>
        )}
      </header>

      <RecordFrontmatterCard
        rows={rows}
        ariaLabel={`Backlog item ${item.id} metadata`}
      />

      {item.notes !== null && (
        <section
          className="record-view-backlog-notes"
          data-section="notes"
        >
          <MarkdownBody markdown={item.notes} />
        </section>
      )}

      {item.details !== null && item.details !== undefined && (
        <section
          className="record-view-backlog-details"
          data-section="details"
        >
          <h2>Details</h2>
          <DetailsBodyWithJournal details={item.details} />
        </section>
      )}

      {item.testStrategy !== null && item.testStrategy !== undefined && (
        <section
          className="record-view-backlog-test-strategy"
          data-section="test-strategy"
        >
          <h2>Test strategy</h2>
          <p>{item.testStrategy}</p>
        </section>
      )}
    </article>
  );
};

function interleave(
  nodes: readonly React.ReactNode[],
  sep: string,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  nodes.forEach((node, i) => {
    if (i > 0) {
      out.push(<React.Fragment key={`sep-${i}`}>{sep}</React.Fragment>);
    }
    out.push(node);
  });
  return out;
}
