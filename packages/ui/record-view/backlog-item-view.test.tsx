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
    // Description in the heading — ID-20.25 splits it into a
    // .record-view-field-value span (so the dispatcher reads it cleanly)
    // + a textarea-kind pencil.
    expect(html).toContain("45: ");
    expect(html).toContain(
      '<span class="record-view-field-value">Backlog item description.</span>',
    );
    // Status enum affordance (inv 31): 5-value Backlog subset.
    expect(html).toContain('data-edit-field="items&gt;45&gt;status"');
    expect(html).toContain('data-edit-kind="enum"');
    expect(html).toContain(
      'data-edit-options="blocked,spec_needed,needs_research,parked,ready"',
    );
  });

  test("ID-20.25: description / effort_estimate / dependencies carry affordances", () => {
    const item = mkItem({ dependencies: ["44", "43"] });
    const ledger = buildLedgerContext({ backlogItems: [item] });
    const html = renderToStaticMarkup(
      <BacklogItemView item={item} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('data-edit-field="items&gt;45&gt;description"');
    expect(html).toContain('data-edit-field="items&gt;45&gt;effort_estimate"');
    expect(html).toContain('data-edit-field="items&gt;45&gt;dependencies"');
    expect(html).toContain('data-edit-kind="array-comma"');
    expect(html).toContain('data-edit-raw-value="44,43"');
  });

  test("ID-20.25: details section pencil carries the full raw string incl. journal (inv 28)", () => {
    const details =
      "Brief.\n\n<info added on 2026-05-25T00:00:00.000Z>\nNote.\n</info added on 2026-05-25T00:00:00.000Z>";
    const item = mkItem({ details });
    const ledger = buildLedgerContext({ backlogItems: [item] });
    const html = renderToStaticMarkup(
      <BacklogItemView item={item} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('data-edit-field="items&gt;45&gt;details"');
    expect(html).toContain("info added on 2026-05-25T00:00:00.000Z");
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
  test("live deps render as links to the record route", () => {
    const a = mkItem({ id: "45", dependencies: ["46"] });
    const b = mkItem({ id: "46" });
    const ledger = buildLedgerContext({ backlogItems: [a, b] });
    const html = renderToStaticMarkup(
      <BacklogItemView item={a} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('href="/?record=46"');
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

// ── {20.30} reverse cross-ledger backlinks (repurposed to projects) ─────────

describe("{20.30} appears-in-projects backlinks (reverse of project.linked_backlog, ID-148.10)", () => {
  const mkInitiativesWith = (
    projects: { id: string; title: string; linked_backlog: string[] }[],
  ) =>
    ({
      document_name: "Canonical Platform - Initiatives",
      document_purpose: "p",
      date: "2026-07-15",
      status: "active",
      related_documents: [],
      last_updated: "fixture",
      initiatives: [
        {
          id: "1",
          title: "Initiative 1",
          description: "d",
          status: "active",
          projects: projects.map((p) => ({
            id: p.id,
            title: p.title,
            summary: "s",
            description: "d",
            substrate_doc: "",
            status: "idea" as const,
            blocked_by: [],
            blocking: [],
            linked_tasks: [],
            linked_backlog: p.linked_backlog,
            originating_session: [],
          })),
          originating_session: [],
          "sub-initiatives": [],
        },
      ],
    }) as never;

  test("renders an Appears-in-projects row — the ONLY backlog → initiatives path", () => {
    // Backlog 87 appears in project "procurement" AND project "ai-eval".
    // Backlog carries no initiatives pointer field, so this reverse index
    // is the sole navigation back.
    const item = mkItem({ id: "87" });
    const ledger = buildLedgerContext({
      backlogItems: [item],
      initiatives: mkInitiativesWith([
        { id: "procurement", title: "Procurement", linked_backlog: ["87", "103"] },
        { id: "ai-eval", title: "AI eval", linked_backlog: ["87"] },
      ]),
    });
    const html = renderToStaticMarkup(
      <BacklogItemView item={item} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('data-frontmatter-row="appears_in_projects"');
    expect(html).toContain('href="/?ledger=initiatives&amp;record=procurement"');
    expect(html).toContain('href="/?ledger=initiatives&amp;record=ai-eval"');
    expect(html).toContain('data-cross-ledger="initiatives"');
    expect(html).toContain("project procurement: Procurement");
    expect(html).toContain("project ai-eval: AI eval");
  });

  test("omits the row when no project references the backlog item", () => {
    const item = mkItem({ id: "999" });
    const ledger = buildLedgerContext({
      backlogItems: [item],
      initiatives: mkInitiativesWith([
        { id: "procurement", title: "Procurement", linked_backlog: ["87"] },
      ]),
    });
    const html = renderToStaticMarkup(
      <BacklogItemView item={item} ledger={ledger} nav={NAV} />,
    );
    expect(html).not.toContain('data-frontmatter-row="appears_in_projects"');
  });

  test("omits the row when no initiatives sibling is threaded in", () => {
    const item = mkItem({ id: "87" });
    const ledger = buildLedgerContext({ backlogItems: [item] });
    const html = renderToStaticMarkup(
      <BacklogItemView item={item} ledger={ledger} nav={NAV} />,
    );
    expect(html).not.toContain('data-frontmatter-row="appears_in_projects"');
  });
});
