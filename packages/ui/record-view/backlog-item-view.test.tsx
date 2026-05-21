/**
 * backlog-item-view.test.tsx — verifies Backlog item page rendering
 * (PRODUCT inv 21, 22, 24, 25).
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { BacklogItem } from "@task-view/schemas/backlog";
import { buildLedgerContext, type NavStripData } from "./types";
import { BacklogItemView } from "./backlog-item-view";

const NAV: NavStripData = {
  prevHref: null,
  prevLabel: null,
  nextHref: null,
  nextLabel: null,
  indexHref: "/",
  indexLabel: "Back to ledger index",
};

const mkItem = (overrides: Partial<BacklogItem> = {}): BacklogItem => ({
  id: "45",
  description: "Backlog item description.",
  type: "feature",
  status: "ready",
  effort_estimate: "1-2 sessions",
  priority: "high",
  track: "Bid",
  dependencies: [],
  session_refs: [],
  commit_refs: [],
  cross_doc_links: [],
  notes: null,
  ...overrides,
});

// ── PRODUCT inv 21 ────────────────────────────────────────────────────────────

describe("PRODUCT inv 21 (Backlog per-item: frontmatter + description + notes + details + testStrategy)", () => {
  test("renders all required Zod-schema fields in frontmatter", () => {
    const item = mkItem();
    const ledger = buildLedgerContext({ backlogItems: [item] });
    const html = renderToStaticMarkup(
      <BacklogItemView item={item} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('data-frontmatter-row="id"');
    expect(html).toContain('data-frontmatter-row="type"');
    expect(html).toContain('data-frontmatter-row="status"');
    expect(html).toContain('data-frontmatter-row="effort_estimate"');
    expect(html).toContain('data-frontmatter-row="priority"');
    expect(html).toContain('data-frontmatter-row="track"');
    expect(html).toContain('data-frontmatter-row="dependencies"');
    expect(html).toContain('data-frontmatter-row="session_refs"');
    expect(html).toContain('data-frontmatter-row="commit_refs"');
    expect(html).toContain('data-frontmatter-row="cross_doc_links"');
    expect(html).toContain('data-frontmatter-row="notes"');
    // Description in the heading
    expect(html).toContain("45: Backlog item description");
  });

  test("renders notes as markdown when present", () => {
    const item = mkItem({ notes: "Some prose notes." });
    const ledger = buildLedgerContext({ backlogItems: [item] });
    const html = renderToStaticMarkup(
      <BacklogItemView item={item} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('data-section="notes"');
    expect(html).toContain("Some prose notes");
  });

  test("omits notes section when notes is null", () => {
    const item = mkItem({ notes: null });
    const ledger = buildLedgerContext({ backlogItems: [item] });
    const html = renderToStaticMarkup(
      <BacklogItemView item={item} ledger={ledger} nav={NAV} />,
    );
    expect(html).not.toContain('data-section="notes"');
  });

  test("renders details with journal-block distinction when present", () => {
    const item = mkItem({
      details:
        "Pre-journal.\n<info added on 2026-05-21T15:00:00.000Z>\nJ.\n</info added on 2026-05-21T15:00:00.000Z>",
    });
    const ledger = buildLedgerContext({ backlogItems: [item] });
    const html = renderToStaticMarkup(
      <BacklogItemView item={item} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('data-section="details"');
    expect(html).toMatch(/<h2[^>]*>Details<\/h2>/);
    expect(html).toContain('data-segment="journal"');
    expect(html).toContain('data-journal-timestamp="2026-05-21T15:00:00.000Z"');
  });

  test("renders testStrategy when present", () => {
    const item = mkItem({ testStrategy: "Acceptance: foo." });
    const ledger = buildLedgerContext({ backlogItems: [item] });
    const html = renderToStaticMarkup(
      <BacklogItemView item={item} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('data-section="test-strategy"');
    expect(html).toMatch(/<h2[^>]*>Test strategy<\/h2>/);
    expect(html).toContain("Acceptance: foo");
  });

  test("omits details and testStrategy sections when both undefined", () => {
    const item = mkItem();
    const ledger = buildLedgerContext({ backlogItems: [item] });
    const html = renderToStaticMarkup(
      <BacklogItemView item={item} ledger={ledger} nav={NAV} />,
    );
    expect(html).not.toContain('data-section="details"');
    expect(html).not.toContain('data-section="test-strategy"');
  });
});

// ── PRODUCT inv 22 ────────────────────────────────────────────────────────────

describe("PRODUCT inv 22 (Backlog dependencies → inline links + missing-target marker)", () => {
  test("live deps render as links to {depId}.md", () => {
    const a = mkItem({ id: "45", dependencies: ["46"] });
    const b = mkItem({ id: "46" });
    const ledger = buildLedgerContext({ backlogItems: [a, b] });
    const html = renderToStaticMarkup(
      <BacklogItemView item={a} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('href="46.md"');
    expect(html).toContain(">46<");
    expect(html).not.toContain("data-page-top-warning");
  });

  test("missing deps render with '(missing)' marker + page-top warning", () => {
    const a = mkItem({ id: "45", dependencies: ["999"] });
    const ledger = buildLedgerContext({ backlogItems: [a] });
    const html = renderToStaticMarkup(
      <BacklogItemView item={a} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain("(missing)");
    expect(html).toContain("line-through");
    expect(html).toContain("data-page-top-warning");
    expect(html).toContain("999");
  });
});

// ── PRODUCT inv 24 ────────────────────────────────────────────────────────────

describe("PRODUCT inv 24 (Promotion-ready badge when details OR testStrategy present)", () => {
  test("badge appears when details is present, even if testStrategy is null", () => {
    const item = mkItem({ details: "Brief.", testStrategy: null });
    const ledger = buildLedgerContext({ backlogItems: [item] });
    const html = renderToStaticMarkup(
      <BacklogItemView item={item} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain("data-promotion-ready");
    expect(html).toContain("Promotion-ready");
  });

  test("badge appears when testStrategy is present, even if details is null", () => {
    const item = mkItem({ details: null, testStrategy: "Acceptance." });
    const ledger = buildLedgerContext({ backlogItems: [item] });
    const html = renderToStaticMarkup(
      <BacklogItemView item={item} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain("data-promotion-ready");
    expect(html).toContain("Promotion-ready");
  });

  test("badge appears when both details and testStrategy are present", () => {
    const item = mkItem({
      details: "Brief.",
      testStrategy: "Acceptance.",
    });
    const ledger = buildLedgerContext({ backlogItems: [item] });
    const html = renderToStaticMarkup(
      <BacklogItemView item={item} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain("data-promotion-ready");
  });

  test("badge is absent when both details and testStrategy are undefined", () => {
    const item = mkItem();
    const ledger = buildLedgerContext({ backlogItems: [item] });
    const html = renderToStaticMarkup(
      <BacklogItemView item={item} ledger={ledger} nav={NAV} />,
    );
    expect(html).not.toContain("data-promotion-ready");
    expect(html).not.toContain("Promotion-ready");
  });

  test("badge is absent when details and testStrategy are explicit null", () => {
    const item = mkItem({ details: null, testStrategy: null });
    const ledger = buildLedgerContext({ backlogItems: [item] });
    const html = renderToStaticMarkup(
      <BacklogItemView item={item} ledger={ledger} nav={NAV} />,
    );
    expect(html).not.toContain("data-promotion-ready");
  });
});

// ── PRODUCT inv 25 ────────────────────────────────────────────────────────────

describe("PRODUCT inv 25 (Backlog blocked banner)", () => {
  test("renders blocked banner when status is 'blocked'", () => {
    const item = mkItem({ status: "blocked" });
    const ledger = buildLedgerContext({ backlogItems: [item] });
    const html = renderToStaticMarkup(
      <BacklogItemView item={item} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain("data-blocked-banner");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Blocked");
  });

  test("no blocked banner for other status values", () => {
    for (const status of ["ready", "spec_needed", "needs_research", "parked"] as const) {
      const item = mkItem({ status });
      const ledger = buildLedgerContext({ backlogItems: [item] });
      const html = renderToStaticMarkup(
        <BacklogItemView item={item} ledger={ledger} nav={NAV} />,
      );
      expect(html).not.toContain("data-blocked-banner");
    }
  });
});
