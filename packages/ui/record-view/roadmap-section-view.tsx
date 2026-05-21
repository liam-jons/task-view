/**
 * record-view/roadmap-section-view.tsx — Roadmap section page renderer.
 *
 * PRODUCT inv 14 (Roadmap index page lists sections) — covered by
 *              roadmap-index-view.tsx; this file renders the per-section
 *              page selected from that index.
 *              15 (per-section: frontmatter + narrative + spec_links +
 *              items table),
 *              17 (empty section → italic "No items in this section."
 *                  per Markdown shorthand `_No items in this section._`
 *                  in spec),
 *              19 (forward_looking_only honoured: no shipped-framing UI).
 * TECH §4.1 RecordFrontmatterCard (Roadmap), §4.2 Roadmap column.
 */
import React from "react";
import type {
  RoadmapItem,
  RoadmapSection,
} from "@task-view/schemas/roadmap";
import { MaybeCrossDocLink } from "./broken-target";
import { NavStrip } from "./nav-strip";
import {
  RecordFrontmatterCard,
  type FrontmatterRow,
} from "./record-frontmatter-card";
import { MarkdownBody } from "./markdown-renderer";
import { roadmapItemHref } from "./anchors";
import type { LedgerContext, NavStripData } from "./types";

export const RoadmapSectionView: React.FC<{
  section: RoadmapSection;
  ledger: LedgerContext;
  nav: NavStripData;
}> = ({ section, ledger, nav }) => {
  const rows: FrontmatterRow[] = [
    { key: "id", label: "ID", value: section.id },
    { key: "parent_id", label: "Parent ID", value: section.parent_id },
    { key: "number", label: "Number", value: section.number },
    { key: "owner", label: "Owner", value: section.owner },
    {
      key: "table_columns",
      label: "Table columns",
      value: section.table_columns,
    },
    { key: "item_count", label: "Item count", value: String(section.items.length) },
  ];

  return (
    <article
      className="record-view-roadmap-section"
      data-record-kind="roadmap-section"
      data-record-id={section.id}
    >
      <NavStrip data={nav} />
      {/* Inv 19: no shipped-framing UI. The renderer surfaces no `shipped`
          affordance — `last_updated` narrative on the root document is
          plain text per the spec. */}
      <header>
        <h1>{`${section.id}: ${section.title}`}</h1>
      </header>

      <RecordFrontmatterCard
        rows={rows}
        ariaLabel={`Roadmap section ${section.id} metadata`}
      />

      <section
        className="record-view-roadmap-narrative"
        data-section="narrative"
      >
        {section.narrative !== null && (
          <MarkdownBody markdown={section.narrative} />
        )}
      </section>

      {section.spec_links.length > 0 && (
        <section
          className="record-view-roadmap-spec-links"
          data-section="spec-links"
        >
          <h2>Spec links</h2>
          <ul>
            {section.spec_links.map((link, i) => (
              <li key={`${link.path}#${i}`}>
                <MaybeCrossDocLink
                  path={link.path}
                  anchor={link.anchor}
                  label={link.raw}
                  existingPaths={ledger.existingPaths}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section
        className="record-view-roadmap-items"
        data-section="items"
      >
        <h2>Items</h2>
        {section.items.length === 0 ? (
          // PRODUCT inv 17 — `_No items in this section._` is Markdown-
          // italic shorthand; surface as <em>No items in this section.</em>
          // with no literal underscores in the rendered DOM. (S63 WP5c
          // Checker Finding-1 Option A ratification.)
          <p
            className="record-view-empty-section"
            data-empty-section
          >
            <em>No items in this section.</em>
          </p>
        ) : (
          <ItemsTable
            section={section}
            items={section.items}
            ledger={ledger}
          />
        )}
      </section>
    </article>
  );
};

/**
 * Render a section's items as a table, with columns determined by the
 * section's `table_columns` value (TECH §4.1: "Table columns ... not
 * editable; informational only").
 *
 * The renderer maps each ColumnSet variant to a header row + per-item
 * cells; unrecognised future variants fall back to a minimal "ID /
 * Title / Status" schema so partial schema upgrades degrade gracefully.
 */
const ItemsTable: React.FC<{
  section: RoadmapSection;
  items: readonly RoadmapItem[];
  ledger: LedgerContext;
}> = ({ section, items, ledger }) => {
  const columns = columnsForColumnSet(section.table_columns);

  return (
    <table
      className="record-view-roadmap-items-table"
      data-items-table={section.table_columns}
    >
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={col.key} scope="col">
              {col.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id} data-item-id={item.id}>
            {columns.map((col) => (
              <td
                key={col.key}
                data-cell={col.key}
              >
                {col.render(item, ledger)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
};

interface ColumnDescriptor {
  key: string;
  label: string;
  render: (item: RoadmapItem, ledger: LedgerContext) => React.ReactNode;
}

const COL_ID_LINKED: ColumnDescriptor = {
  key: "id",
  label: "ID",
  render: (item) => (
    <a href={roadmapItemHref(item.id)} data-item-link={item.id}>
      {item.id}
    </a>
  ),
};

const COL_TITLE: ColumnDescriptor = {
  key: "title",
  label: "Title",
  render: (item) => item.title,
};

const COL_DESC: ColumnDescriptor = {
  key: "description",
  label: "Description",
  render: (item) => item.description,
};

const COL_OWNER: ColumnDescriptor = {
  key: "owner",
  label: "Owner",
  render: (item) => item.owner ?? "—",
};

const COL_EFFORT: ColumnDescriptor = {
  key: "effort_estimate",
  label: "Effort",
  render: (item) => item.effort_estimate ?? "—",
};

const COL_PRIORITY: ColumnDescriptor = {
  key: "priority",
  label: "Priority",
  render: (item) => item.priority_note ?? item.priority ?? "—",
};

const COL_STATUS: ColumnDescriptor = {
  key: "status",
  label: "Status",
  render: (item) => item.status_note ?? item.status ?? "—",
};

const COL_SEVERITY: ColumnDescriptor = {
  key: "severity",
  label: "Severity",
  render: (item) => item.severity ?? "—",
};

const COL_PHASE: ColumnDescriptor = {
  key: "phase_label",
  label: "Phase",
  render: (item) => item.phase_label ?? "—",
};

const FALLBACK_COLUMNS: ColumnDescriptor[] = [
  COL_ID_LINKED,
  COL_TITLE,
  COL_STATUS,
];

function columnsForColumnSet(
  cs: RoadmapSection["table_columns"],
): ColumnDescriptor[] {
  switch (cs) {
    case "item_desc_owner_effort_status":
      return [COL_ID_LINKED, COL_DESC, COL_OWNER, COL_EFFORT, COL_STATUS];
    case "item_desc_effort_priority":
      return [COL_ID_LINKED, COL_DESC, COL_EFFORT, COL_PRIORITY];
    case "phase_desc_effort_priority":
      return [COL_ID_LINKED, COL_PHASE, COL_DESC, COL_EFFORT, COL_PRIORITY];
    case "item_desc_effort_severity":
      return [COL_ID_LINKED, COL_DESC, COL_EFFORT, COL_SEVERITY];
    case "item_desc_priority_status":
      return [COL_ID_LINKED, COL_DESC, COL_PRIORITY, COL_STATUS];
    case "item_desc_effort_priority_status":
      return [COL_ID_LINKED, COL_DESC, COL_EFFORT, COL_PRIORITY, COL_STATUS];
    default:
      // Defensive default for forward-compat with new ColumnSet variants.
      return FALLBACK_COLUMNS;
  }
}

// Re-exported for any external code (e.g. roadmap-item-view) that wants
// to use the same column descriptors.
export { columnsForColumnSet };
