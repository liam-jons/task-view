/**
 * roadmap-section-view.test.tsx — verifies Roadmap section page rendering
 * (PRODUCT inv 15, 17, 19; TECH §4.1, §4.2 Roadmap column).
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  Roadmap,
  RoadmapItem,
  RoadmapSection,
} from "@task-view/schemas/roadmap";
import { buildLedgerContext, type NavStripData } from "./types";
import { RoadmapSectionView } from "./roadmap-section-view";

const NAV: NavStripData = {
  prevHref: null,
  prevLabel: null,
  nextHref: null,
  nextLabel: null,
  indexHref: "/",
  indexLabel: "Back to ledger index",
};

const mkItem = (overrides: Partial<RoadmapItem> = {}): RoadmapItem => ({
  id: "1.1",
  section_id: "1",
  title: "Item 1.1",
  phase_label: null,
  description: "Item 1.1 description.",
  effort_estimate: "S",
  priority: "must",
  priority_note: null,
  severity: null,
  status: "pending",
  status_note: null,
  owner: "Engineering",
  depends_on: [],
  blocks: [],
  coordinates_with: [],
  cross_doc_links: [],
  session_refs: [],
  commit_refs: [],
  ...overrides,
});

const mkSection = (overrides: Partial<RoadmapSection> = {}): RoadmapSection => ({
  id: "1",
  parent_id: null,
  number: "1",
  title: "Section 1",
  narrative: "Section 1 narrative.",
  spec_links: [],
  owner: "Engineering",
  table_columns: "item_desc_owner_effort_status",
  items: [mkItem()],
  ...overrides,
});

const mkRoadmap = (sections: RoadmapSection[]): Roadmap => ({
  document_name: "Knowledge Hub Roadmap",
  document_purpose: "Forward-looking roadmap.",
  date: "2026-05-21",
  status: "Active",
  forward_looking_only: true,
  related_documents: [],
  last_updated: "kh-prod-readiness-S63 fixture",
  sections,
});

// ── PRODUCT inv 15 ────────────────────────────────────────────────────────────

describe("PRODUCT inv 15 (per-section page: frontmatter + narrative + spec_links + items table)", () => {
  test("renders frontmatter + narrative + items table when populated", () => {
    const section = mkSection();
    const ledger = buildLedgerContext({ roadmap: mkRoadmap([section]) });
    const html = renderToStaticMarkup(
      <RoadmapSectionView section={section} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain("1: Section 1");
    expect(html).toContain("Section 1 narrative");
    expect(html).toContain('data-frontmatter-row="id"');
    expect(html).toContain('data-frontmatter-row="parent_id"');
    expect(html).toContain('data-frontmatter-row="number"');
    expect(html).toContain('data-frontmatter-row="owner"');
    expect(html).toContain('data-frontmatter-row="table_columns"');
    expect(html).toContain('data-frontmatter-row="item_count"');
    expect(html).toContain('data-items-table="item_desc_owner_effort_status"');
    expect(html).toContain('data-item-link="1.1"');
  });

  test("omits narrative section content when narrative is null", () => {
    const section = mkSection({ narrative: null });
    const ledger = buildLedgerContext({ roadmap: mkRoadmap([section]) });
    const html = renderToStaticMarkup(
      <RoadmapSectionView section={section} ledger={ledger} nav={NAV} />,
    );
    // Narrative section wrapper still present but no MarkdownBody inside
    expect(html).not.toContain("data-markdown-body");
  });

  test("renders spec_links list when populated", () => {
    const section = mkSection({
      spec_links: [
        {
          path: "docs/specs/foo.md",
          anchor: null,
          raw: "Foo spec",
        },
      ],
    });
    const ledger = buildLedgerContext({
      roadmap: mkRoadmap([section]),
      existingPaths: new Set(["docs/specs/foo.md"]),
    });
    const html = renderToStaticMarkup(
      <RoadmapSectionView section={section} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain("Spec links");
    expect(html).toContain('href="docs/specs/foo.md"');
    expect(html).toContain(">Foo spec<");
  });

  test("omits spec_links section when empty", () => {
    const section = mkSection({ spec_links: [] });
    const ledger = buildLedgerContext({ roadmap: mkRoadmap([section]) });
    const html = renderToStaticMarkup(
      <RoadmapSectionView section={section} ledger={ledger} nav={NAV} />,
    );
    expect(html).not.toContain("Spec links");
  });

  test("renders columns appropriate to table_columns value", () => {
    const section = mkSection({
      table_columns: "item_desc_effort_priority",
      items: [
        mkItem({ id: "1.1", title: "A", description: "Desc A" }),
        mkItem({ id: "1.2", title: "B", description: "Desc B" }),
      ],
    });
    const ledger = buildLedgerContext({ roadmap: mkRoadmap([section]) });
    const html = renderToStaticMarkup(
      <RoadmapSectionView section={section} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('data-items-table="item_desc_effort_priority"');
    expect(html).toContain('data-cell="id"');
    expect(html).toContain('data-cell="description"');
    expect(html).toContain('data-cell="effort_estimate"');
    expect(html).toContain('data-cell="priority"');
    // Should NOT contain owner / status columns for this ColumnSet
    expect(html).not.toContain('data-cell="owner"');
    expect(html).not.toContain('data-cell="status"');
  });
});

// ── PRODUCT inv 17 ────────────────────────────────────────────────────────────

describe("PRODUCT inv 17 (empty section → `_No items in this section._`)", () => {
  test("renders the italic placeholder when items array is empty", () => {
    const section = mkSection({ items: [] });
    const ledger = buildLedgerContext({ roadmap: mkRoadmap([section]) });
    const html = renderToStaticMarkup(
      <RoadmapSectionView section={section} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain("data-empty-section");
    expect(html).toContain("_No items in this section._");
    // Items section heading still rendered (the section is NOT omitted)
    expect(html).toMatch(/<h2[^>]*>Items<\/h2>/);
  });
});

// ── PRODUCT inv 19 ────────────────────────────────────────────────────────────

describe("PRODUCT inv 19 (forward_looking_only honoured; no shipped UI)", () => {
  test("renders no 'shipped' affordances in the section page", () => {
    const section = mkSection();
    const ledger = buildLedgerContext({ roadmap: mkRoadmap([section]) });
    const html = renderToStaticMarkup(
      <RoadmapSectionView section={section} ledger={ledger} nav={NAV} />,
    );
    // The viewer never renders a "Mark as shipped" or "Shipped status"
    // affordance — case-insensitive scan to catch class names, buttons,
    // labels, etc.
    const lowered = html.toLowerCase();
    expect(lowered).not.toContain("shipped");
    expect(lowered).not.toContain("mark as");
  });
});
