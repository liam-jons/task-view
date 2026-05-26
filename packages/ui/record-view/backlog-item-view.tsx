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
import { BacklogStatus } from "@task-view/schemas/backlog";
import {
  MaybeCrossDocLink,
  MaybeRecordLink,
  PageTopWarning,
} from "./broken-target";
import { FieldPencil } from "./field-pencil";
import { NavStrip } from "./nav-strip";
import {
  RecordFrontmatterCard,
  type FrontmatterRow,
} from "./record-frontmatter-card";
import {
  DetailsBodyWithJournal,
  MarkdownBody,
} from "./markdown-renderer";
import { recordRouteHref } from "./anchors";
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
    {
      key: "status",
      label: "Status",
      value: item.status,
      editAffordance: (
        <FieldPencil
          fieldPath={["items", item.id, "status"]}
          kind="enum"
          options={BacklogStatus.options}
          ariaLabel={`Edit status for backlog item ${item.id}`}
        />
      ),
    },
    {
      key: "effort_estimate",
      label: "Effort estimate",
      value: item.effort_estimate,
      editAffordance: (
        <FieldPencil
          fieldPath={["items", item.id, "effort_estimate"]}
          kind="text"
          ariaLabel={`Edit effort estimate for backlog item ${item.id}`}
        />
      ),
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
                  href={recordRouteHref(depId)}
                  label={depId}
                  exists={ledger.backlogItemIds.has(depId)}
                />
              )),
              ", ",
            ),
      editAffordance: (
        <FieldPencil
          fieldPath={["items", item.id, "dependencies"]}
          kind="array-comma"
          rawValue={item.dependencies.join(",")}
          ariaLabel={`Edit dependencies for backlog item ${item.id}`}
        />
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
      editAffordance: (
        <FieldPencil
          fieldPath={["items", item.id, "cross_doc_links"]}
          kind="doc-links"
          // JSON-serialised DocLink[] — the dispatcher parses this in openEditor
          // to pre-fill the multi-row editor (ID-20.27).
          rawValue={JSON.stringify(item.cross_doc_links)}
          ariaLabel={`Edit cross-doc links for backlog item ${item.id}`}
        />
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

      <header className="record-view-backlog-header" data-edit-container>
        <h1>
          {`${item.id}: `}
          <span className="record-view-field-value">{item.description}</span>
        </h1>
        <FieldPencil
          fieldPath={["items", item.id, "description"]}
          kind="textarea"
          rawValue={item.description}
          ariaLabel={`Edit description for backlog item ${item.id}`}
        />
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
          data-edit-container
        >
          <span className="record-view-field-value">
            <MarkdownBody markdown={item.notes} />
          </span>
          <FieldPencil
            fieldPath={["items", item.id, "notes"]}
            kind="textarea"
            rawValue={item.notes}
            ariaLabel={`Edit notes for backlog item ${item.id}`}
          />
        </section>
      )}

      {item.details !== null && item.details !== undefined && (
        <section
          className="record-view-backlog-details"
          data-section="details"
          data-edit-container
        >
          <h2>Details</h2>
          <span className="record-view-field-value">
            <DetailsBodyWithJournal details={item.details} />
          </span>
          <FieldPencil
            fieldPath={["items", item.id, "details"]}
            kind="textarea"
            // Full raw details string incl. <info added on …> journal
            // blocks (PRODUCT inv 28).
            rawValue={item.details}
            ariaLabel={`Edit details for backlog item ${item.id}`}
          />
        </section>
      )}

      {item.testStrategy !== null && item.testStrategy !== undefined && (
        <section
          className="record-view-backlog-test-strategy"
          data-section="test-strategy"
          data-edit-container
        >
          <h2>Test strategy</h2>
          <p>
            <span className="record-view-field-value">
              {item.testStrategy}
            </span>
            <FieldPencil
              fieldPath={["items", item.id, "testStrategy"]}
              kind="textarea"
              rawValue={item.testStrategy}
              ariaLabel={`Edit test strategy for backlog item ${item.id}`}
            />
          </p>
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
