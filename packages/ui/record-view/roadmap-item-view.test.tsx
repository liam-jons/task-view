/**
 * roadmap-item-view.test.tsx — verifies Roadmap item page rendering
 * (PRODUCT inv 16, 18; TECH §4.1, §4.2 Roadmap dependency cross-refs,
 * §4.6 owner inheritance display).
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  Roadmap,
  RoadmapItem,
  RoadmapSection,
} from "@task-view/schemas/roadmap";
import { buildLedgerContext, type NavStripData } from "./types";
import { RoadmapItemView } from "./roadmap-item-view";

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
  description: "Description.",
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
  narrative: null,
  spec_links: [],
  owner: "Engineering",
  table_columns: "item_desc_owner_effort_status",
  items: [],
  ...overrides,
});

const mkRoadmap = (sections: RoadmapSection[]): Roadmap => ({
  document_name: "Knowledge Hub Roadmap",
  document_purpose: "Test fixture.",
  date: "2026-05-21",
  status: "Active",
  forward_looking_only: true,
  related_documents: [],
  last_updated: "test",
  sections,
});

// ── PRODUCT inv 16 ────────────────────────────────────────────────────────────

describe("PRODUCT inv 16 (per-item: frontmatter + description + dep cross-refs)", () => {
  test("renders all required frontmatter rows", () => {
    const item = mkItem();
    const section = mkSection({ items: [item] });
    const ledger = buildLedgerContext({ roadmap: mkRoadmap([section]) });
    const html = renderToStaticMarkup(
      <RoadmapItemView item={item} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain("1.1: Item 1.1");
    expect(html).toContain('data-frontmatter-row="id"');
    expect(html).toContain('data-frontmatter-row="section_id"');
    expect(html).toContain('data-frontmatter-row="phase_label"');
    expect(html).toContain('data-frontmatter-row="owner"');
    expect(html).toContain('data-frontmatter-row="effort_estimate"');
    expect(html).toContain('data-frontmatter-row="priority"');
    expect(html).toContain('data-frontmatter-row="priority_note"');
    expect(html).toContain('data-frontmatter-row="severity"');
    expect(html).toContain('data-frontmatter-row="status"');
    expect(html).toContain('data-frontmatter-row="status_note"');
    expect(html).toContain('data-frontmatter-row="session_refs"');
    expect(html).toContain('data-frontmatter-row="commit_refs"');
    // Section ID is linked back to section page
    expect(html).toContain('data-section-link="1"');
    expect(html).toContain('href="section-1.md"');
  });

  test("renders dependency cross-refs as their own list sections", () => {
    const item = mkItem({
      id: "1.1",
      depends_on: ["1.2"],
      blocks: ["1.3"],
      coordinates_with: ["§5"],
    });
    const itemB = mkItem({ id: "1.2", title: "B" });
    const itemC = mkItem({ id: "1.3", title: "C" });
    const section = mkSection({ items: [item, itemB, itemC] });
    const ledger = buildLedgerContext({ roadmap: mkRoadmap([section]) });
    const html = renderToStaticMarkup(
      <RoadmapItemView item={item} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('data-section="depends_on"');
    expect(html).toContain("Depends on");
    expect(html).toContain('href="1.2.md"');
    expect(html).toContain('data-section="blocks"');
    expect(html).toContain("Blocks");
    expect(html).toContain('href="1.3.md"');
    expect(html).toContain('data-section="coordinates_with"');
    expect(html).toContain("Coordinates with");
    expect(html).toContain("data-freeform-ref");
    expect(html).toContain("§5");
  });

  test("omits dependency sections that are empty", () => {
    const item = mkItem({
      depends_on: ["1.2"],
      blocks: [],
      coordinates_with: [],
    });
    const itemB = mkItem({ id: "1.2", title: "B" });
    const section = mkSection({ items: [item, itemB] });
    const ledger = buildLedgerContext({ roadmap: mkRoadmap([section]) });
    const html = renderToStaticMarkup(
      <RoadmapItemView item={item} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('data-section="depends_on"');
    expect(html).not.toContain('data-section="blocks"');
    expect(html).not.toContain('data-section="coordinates_with"');
  });

  test("missing item-id refs render with '(missing)' marker + page-top warning", () => {
    const item = mkItem({ id: "1.1", depends_on: ["9.9"] });
    const section = mkSection({ items: [item] });
    const ledger = buildLedgerContext({ roadmap: mkRoadmap([section]) });
    const html = renderToStaticMarkup(
      <RoadmapItemView item={item} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain("(missing)");
    expect(html).toContain("line-through");
    expect(html).toContain("data-page-top-warning");
    expect(html).toContain("9.9");
  });

  test("free-form refs are NOT added to page-top warning", () => {
    const item = mkItem({ id: "1.1", coordinates_with: ["§5", "OPS-12"] });
    const section = mkSection({ items: [item] });
    const ledger = buildLedgerContext({ roadmap: mkRoadmap([section]) });
    const html = renderToStaticMarkup(
      <RoadmapItemView item={item} ledger={ledger} nav={NAV} />,
    );
    expect(html).not.toContain("data-page-top-warning");
  });

  test("renders cross_doc_links list when populated", () => {
    const item = mkItem({
      cross_doc_links: [
        {
          path: "docs/specs/foo.md",
          anchor: null,
          raw: "Foo spec",
        },
      ],
    });
    const section = mkSection({ items: [item] });
    const ledger = buildLedgerContext({
      roadmap: mkRoadmap([section]),
      existingPaths: new Set(["docs/specs/foo.md"]),
    });
    const html = renderToStaticMarkup(
      <RoadmapItemView item={item} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('data-section="cross-doc-links"');
    expect(html).toContain("Cross-doc links");
    expect(html).toContain('href="docs/specs/foo.md"');
  });
});

// ── PRODUCT inv 18 ────────────────────────────────────────────────────────────

describe("PRODUCT inv 18 (Roadmap owner inheritance qualifier)", () => {
  test("displays parent section's owner when item.owner is null", () => {
    const item = mkItem({ id: "1.1", section_id: "1", owner: null });
    const section = mkSection({
      id: "1",
      owner: "Engineering Platform",
      items: [item],
    });
    const ledger = buildLedgerContext({ roadmap: mkRoadmap([section]) });
    const html = renderToStaticMarkup(
      <RoadmapItemView item={item} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain("Engineering Platform");
    expect(html).toContain("(inherited from §1)");
    expect(html).toContain("data-inherited-owner");
    expect(html).toContain('data-inherited-from="1"');
  });

  test("displays em-dash when both item and section owner are null", () => {
    const item = mkItem({ id: "1.1", section_id: "1", owner: null });
    const section = mkSection({
      id: "1",
      owner: null,
      items: [item],
    });
    const ledger = buildLedgerContext({ roadmap: mkRoadmap([section]) });
    const html = renderToStaticMarkup(
      <RoadmapItemView item={item} ledger={ledger} nav={NAV} />,
    );
    // The Owner row contains em-dash (em-dash is rendered via the
    // RecordFrontmatterCard `data-unset` span; React 19 SSR emits the
    // boolean attribute as `data-unset="true"`).
    expect(html).toMatch(
      /data-frontmatter-row="owner"[\s\S]*?data-unset[\s\S]*?—/,
    );
    expect(html).not.toContain("(inherited from");
  });

  test("displays item.owner verbatim when set (no inheritance qualifier)", () => {
    const item = mkItem({
      id: "1.1",
      section_id: "1",
      owner: "Item Owner",
    });
    const section = mkSection({
      id: "1",
      owner: "Section Owner",
      items: [item],
    });
    const ledger = buildLedgerContext({ roadmap: mkRoadmap([section]) });
    const html = renderToStaticMarkup(
      <RoadmapItemView item={item} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain("Item Owner");
    expect(html).not.toContain("(inherited from");
    expect(html).not.toContain("data-inherited-owner");
  });
});
