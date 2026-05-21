/**
 * record-view/roadmap-item-view.tsx — Roadmap item page renderer.
 *
 * PRODUCT inv 16 (per-item: frontmatter + description + dependency
 *              cross-refs as their own list sections),
 *              18 (owner inheritance qualifier),
 *              19 (forward_looking_only honoured).
 * TECH §4.1 Roadmap RecordFrontmatterCard, §4.2 Roadmap dependency
 * cross-refs, §4.6 owner inheritance display.
 */
import React from "react";
import type { RoadmapItem } from "@task-view/schemas/roadmap";
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
import { MarkdownBody } from "./markdown-renderer";
import {
  roadmapItemHref,
  roadmapSectionHref,
} from "./anchors";
import type { LedgerContext, NavStripData } from "./types";

export const RoadmapItemView: React.FC<{
  item: RoadmapItem;
  ledger: LedgerContext;
  nav: NavStripData;
}> = ({ item, ledger, nav }) => {
  // Owner inheritance (PRODUCT inv 18, TECH §4.6):
  //   - When `item.owner === null`, display the parent section's owner
  //     with "(inherited from §{sectionId})" suffix.
  //   - When both are null, the field displays `—`.
  const parentSection = ledger.roadmapSectionsById.get(item.section_id);
  const inheritedOwner = parentSection?.owner ?? null;
  const ownerCell = renderOwnerCell(item.owner, inheritedOwner, item.section_id);

  // Page-top warning aggregates ALL missing record refs (depends_on,
  // blocks, coordinates_with). Free-form `§5`-style refs (non-id-shaped)
  // are skipped from the warning since they're not ledger-record refs.
  const missingDeps: string[] = [];
  for (const ref of item.depends_on) {
    if (looksLikeItemId(ref) && !ledger.roadmapItemIds.has(ref)) {
      missingDeps.push(ref);
    }
  }
  for (const ref of item.blocks) {
    if (looksLikeItemId(ref) && !ledger.roadmapItemIds.has(ref)) {
      missingDeps.push(ref);
    }
  }
  for (const ref of item.coordinates_with) {
    if (looksLikeItemId(ref) && !ledger.roadmapItemIds.has(ref)) {
      missingDeps.push(ref);
    }
  }

  const rows: FrontmatterRow[] = [
    { key: "id", label: "ID", value: item.id },
    {
      key: "section_id",
      label: "Section ID",
      value: (
        <a
          href={roadmapSectionHref(item.section_id)}
          data-section-link={item.section_id}
        >
          §{item.section_id}
        </a>
      ),
    },
    { key: "phase_label", label: "Phase label", value: item.phase_label },
    { key: "owner", label: "Owner", value: ownerCell },
    {
      key: "effort_estimate",
      label: "Effort estimate",
      value: item.effort_estimate,
    },
    { key: "priority", label: "Priority", value: item.priority },
    { key: "priority_note", label: "Priority note", value: item.priority_note },
    { key: "severity", label: "Severity", value: item.severity },
    { key: "status", label: "Status", value: item.status },
    { key: "status_note", label: "Status note", value: item.status_note },
    {
      key: "session_refs",
      label: "Session refs",
      value:
        item.session_refs.length === 0 ? null : item.session_refs.join(", "),
    },
    {
      key: "commit_refs",
      label: "Commit refs",
      value:
        item.commit_refs.length === 0 ? null : item.commit_refs.join(", "),
    },
  ];

  return (
    <article
      className="record-view-roadmap-item"
      data-record-kind="roadmap-item"
      data-record-id={item.id}
    >
      <NavStrip data={nav} />

      <PageTopWarning subject="This Roadmap item" missingIds={missingDeps} />

      <header>
        <h1>{`${item.id}: ${item.title}`}</h1>
      </header>

      <RecordFrontmatterCard
        rows={rows}
        ariaLabel={`Roadmap item ${item.id} metadata`}
      />

      <section
        className="record-view-roadmap-item-description"
        data-section="description"
      >
        <MarkdownBody markdown={item.description} />
      </section>

      <DependencyList
        title="Depends on"
        sectionKey="depends_on"
        refs={item.depends_on}
        ledger={ledger}
      />
      <DependencyList
        title="Blocks"
        sectionKey="blocks"
        refs={item.blocks}
        ledger={ledger}
      />
      <DependencyList
        title="Coordinates with"
        sectionKey="coordinates_with"
        refs={item.coordinates_with}
        ledger={ledger}
      />

      {item.cross_doc_links.length > 0 && (
        <section
          className="record-view-roadmap-item-cross-doc-links"
          data-section="cross-doc-links"
        >
          <h2>Cross-doc links</h2>
          <ul>
            {item.cross_doc_links.map((link, i) => (
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
    </article>
  );
};

/**
 * Build the Owner cell content with optional inheritance qualifier.
 * Implements PRODUCT inv 18 and TECH §4.6.
 */
function renderOwnerCell(
  itemOwner: string | null,
  sectionOwner: string | null,
  sectionId: string,
): React.ReactNode {
  if (itemOwner !== null) {
    return itemOwner;
  }
  if (sectionOwner !== null) {
    return (
      <span data-inherited-owner>
        {sectionOwner}{" "}
        <span
          className="record-view-owner-inherited"
          data-inherited-from={sectionId}
        >
          (inherited from §{sectionId})
        </span>
      </span>
    );
  }
  // Both null — RecordFrontmatterCard will render em-dash.
  return null;
}

/**
 * Render one of the three Roadmap dependency list sections (`depends_on`,
 * `blocks`, `coordinates_with`). When the array is empty the section is
 * omitted entirely (per inv 16: "each as their own list section").
 *
 * Each ref renders as a link to the target item when it resolves to an
 * item id in the ledger; free-form refs (`§5`, `OPS-12`) render as plain
 * strings per inv 16: "render as links to other items by id when the
 * target resolves to an item, or as plain strings when the target is a
 * free-form reference".
 */
const DependencyList: React.FC<{
  title: string;
  sectionKey: "depends_on" | "blocks" | "coordinates_with";
  refs: readonly string[];
  ledger: LedgerContext;
}> = ({ title, sectionKey, refs, ledger }) => {
  if (refs.length === 0) return null;
  return (
    <section
      className={`record-view-roadmap-${sectionKey}`}
      data-section={sectionKey}
    >
      <h2>{title}</h2>
      <ul>
        {refs.map((ref) => (
          <li key={ref}>
            {looksLikeItemId(ref) ? (
              <MaybeRecordLink
                href={roadmapItemHref(ref)}
                label={ref}
                exists={ledger.roadmapItemIds.has(ref)}
              />
            ) : (
              <span data-freeform-ref>{ref}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
};

/**
 * Heuristic: a Roadmap item id is dotted-decimal (e.g. `1.4`, `3.1.8`).
 * Free-form refs like `§5`, `OPS-12`, or `D-NN` are not item ids and
 * render as plain text per PRODUCT inv 16.
 */
function looksLikeItemId(ref: string): boolean {
  return /^\d+(\.\d+)*$/.test(ref);
}
