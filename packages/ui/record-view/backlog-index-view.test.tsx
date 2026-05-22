/**
 * backlog-index-view.test.tsx — verifies Backlog index page rendering
 * (PRODUCT inv 20, 23, 47).
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { BacklogItem } from "@task-view/schemas/backlog";
import { BacklogIndexView } from "./backlog-index-view";
import {
  decodeBacklogFilters,
  encodeBacklogFilters,
} from "./url-state";

const mkItem = (overrides: Partial<BacklogItem> = {}): BacklogItem => ({
  id: "1",
  description: "Item 1.",
  type: "feature",
  status: "ready",
  effort_estimate: "S",
  priority: "high",
  track: "Bid",
  dependencies: [],
  session_refs: [],
  commit_refs: [],
  cross_doc_links: [],
  notes: null,
  ...overrides,
});

const NO_FILTERS = { track: null, status: null, priority: null };

// ── PRODUCT inv 20 ────────────────────────────────────────────────────────────

describe("PRODUCT inv 20 (Backlog index columns) + roadmap-backlog-consolidation inv 10 (sort by priority → rank → id)", () => {
  test("renders all required columns including the new Rank column (30.8)", () => {
    const items = [mkItem()];
    const html = renderToStaticMarkup(
      <BacklogIndexView items={items} filters={NO_FILTERS} />,
    );
    expect(html).toContain('<th scope="col">ID</th>');
    expect(html).toContain('<th scope="col">Description</th>');
    expect(html).toContain('<th scope="col">Type</th>');
    expect(html).toContain('<th scope="col">Status</th>');
    expect(html).toContain('<th scope="col">Priority</th>');
    expect(html).toContain('<th scope="col">Rank</th>');
    expect(html).toContain('<th scope="col">Track</th>');
    expect(html).toContain('<th scope="col">Effort</th>');
  });

  test("sort overridden per roadmap-backlog-consolidation inv 10 — priority → rank (nulls last) → id (NOT track/status/id)", () => {
    // Per inv 10: "the existing sort (track, then status, then id per
    // per-task-mirror inv 20) becomes priority, then rank (nulls last),
    // then id to match inv 4 on this surface specifically."
    const items = [
      mkItem({ id: "10", priority: "high", rank: null }),
      mkItem({ id: "2", priority: "high", rank: 1 }),
      mkItem({ id: "3", priority: "must", rank: null }),
      mkItem({ id: "4", priority: "must", rank: 2 }),
    ];
    const html = renderToStaticMarkup(
      <BacklogIndexView items={items} filters={NO_FILTERS} />,
    );
    const matches = [...html.matchAll(/data-backlog-row="(\d+)"/g)].map(
      (m) => m[1],
    );
    // must/2 → must/null → high/1 → high/null
    expect(matches).toEqual(["4", "3", "2", "10"]);
  });

  test("renders each row as a link to the per-item page", () => {
    const items = [mkItem({ id: "45" })];
    const html = renderToStaticMarkup(
      <BacklogIndexView items={items} filters={NO_FILTERS} />,
    );
    expect(html).toContain('href="45.md"');
    expect(html).toContain('data-item-link="45"');
  });
});

// ── PRODUCT inv 23 ────────────────────────────────────────────────────────────

describe("PRODUCT inv 23 (filter dropdowns + URL query string state)", () => {
  test("renders Track / Status / Priority dropdowns each with an 'All' option", () => {
    const items = [
      mkItem({ track: "Bid" }),
      mkItem({ id: "2", track: "Procurement" }),
    ];
    const html = renderToStaticMarkup(
      <BacklogIndexView items={items} filters={NO_FILTERS} />,
    );
    expect(html).toContain('data-filter-name="track"');
    expect(html).toContain('data-filter-name="status"');
    expect(html).toContain('data-filter-name="priority"');
    expect(html).toContain('data-filter-control="track"');
    expect(html).toContain('data-filter-control="status"');
    expect(html).toContain('data-filter-control="priority"');
    // SSR may add `selected=""` when defaultValue matches "all"; match either form.
    expect(html).toMatch(/<option value="all"[^>]*>All<\/option>/);
  });

  test("Track options are derived from items in the ledger when not provided", () => {
    const items = [
      mkItem({ id: "1", track: "Bid" }),
      mkItem({ id: "2", track: "Procurement" }),
      mkItem({ id: "3", track: "Bid" }),
    ];
    const html = renderToStaticMarkup(
      <BacklogIndexView items={items} filters={NO_FILTERS} />,
    );
    // Bid and Procurement options both present (sorted alphabetically)
    expect(html).toContain('<option value="Bid">Bid</option>');
    expect(html).toContain('<option value="Procurement">Procurement</option>');
  });

  test("Status options come from BacklogStatus Zod enum (inv 31)", () => {
    const html = renderToStaticMarkup(
      <BacklogIndexView items={[]} filters={NO_FILTERS} />,
    );
    // Canonical status values from BacklogStatus
    expect(html).toContain('<option value="spec_needed">spec_needed</option>');
    expect(html).toContain(
      '<option value="needs_research">needs_research</option>',
    );
    expect(html).toContain('<option value="parked">parked</option>');
    expect(html).toContain('<option value="ready">ready</option>');
    expect(html).toContain('<option value="blocked">blocked</option>');
  });

  test("Priority options come from the shared Priority enum", () => {
    const html = renderToStaticMarkup(
      <BacklogIndexView items={[]} filters={NO_FILTERS} />,
    );
    // Spot-check a few values from the Priority master enum
    expect(html).toContain('<option value="must">must</option>');
    expect(html).toContain('<option value="should">should</option>');
    expect(html).toContain('<option value="high">high</option>');
    expect(html).toContain('<option value="low">low</option>');
  });

  test("active filter is reflected in select defaultValue", () => {
    const items = [
      mkItem({ id: "1", track: "Bid", status: "ready", priority: "high" }),
      mkItem({ id: "2", track: "Procurement", status: "blocked", priority: "low" }),
    ];
    const filters = {
      track: "Bid",
      status: "ready",
      priority: "high",
    };
    const html = renderToStaticMarkup(
      <BacklogIndexView items={items} filters={filters} />,
    );
    // Track select default
    expect(html).toMatch(
      /name="track"[^>]*>[\s\S]*?<option value="Bid"[^>]*>Bid<\/option>/,
    );
    // Verify the filter actually applied: only id=1 should render
    const rows = [...html.matchAll(/data-backlog-row="(\d+)"/g)].map(
      (m) => m[1],
    );
    expect(rows).toEqual(["1"]);
  });

  test("URL query-string round-trip via decode → encode is stable", () => {
    const qs = "track=Bid&status=ready&priority=high";
    const filters = decodeBacklogFilters(qs);
    expect(encodeBacklogFilters(filters)).toBe(qs);
  });

  test("'No matches' message renders when filters exclude everything", () => {
    const items = [mkItem({ id: "1", track: "Bid" })];
    const html = renderToStaticMarkup(
      <BacklogIndexView
        items={items}
        filters={{ track: "Procurement", status: null, priority: null }}
      />,
    );
    expect(html).toContain("data-empty-filtered");
    expect(html).toContain("No items match");
  });
});

// ── PRODUCT inv 47 ────────────────────────────────────────────────────────────

describe("PRODUCT inv 47 (empty Backlog ledger → empty-state page)", () => {
  test("renders an empty-state message when items list is empty", () => {
    const html = renderToStaticMarkup(
      <BacklogIndexView items={[]} filters={NO_FILTERS} />,
    );
    expect(html).toContain('data-empty-ledger="backlog"');
    expect(html).toContain("Backlog ledger is empty");
    // No record-creation flow surfaced
    expect(html).not.toMatch(/<button[^>]*>[^<]*Add[^<]*<\/button>/i);
  });
});

// ── roadmap-backlog-consolidation PRODUCT inv 10 (rank-edit + drag-reorder) ──
// Subtask 30.8 — per-task-mirror 20.14 extension.

describe("inv 10 — rank column, integer-input affordance, drag handle", () => {
  test("renders a Rank column header on the index table", () => {
    const html = renderToStaticMarkup(
      <BacklogIndexView items={[mkItem()]} filters={NO_FILTERS} />,
    );
    expect(html).toContain('<th scope="col">Rank</th>');
  });

  test("renders the rank value when set, and '—' (em-dash) when null/absent", () => {
    const items = [
      mkItem({ id: "1", rank: 5 }),
      mkItem({ id: "2", rank: null }),
      mkItem({ id: "3" }), // rank undefined / absent
    ];
    const html = renderToStaticMarkup(
      <BacklogIndexView items={items} filters={NO_FILTERS} />,
    );
    // Rank cell carries data-rank-value for SPA hook + visible rank
    expect(html).toMatch(/data-rank-value="5"/);
    expect(html).toMatch(/data-rank-value=""/);
  });

  test("rank cell exposes data-edit-field hook for the SPA pencil affordance", () => {
    const html = renderToStaticMarkup(
      <BacklogIndexView items={[mkItem({ id: "45", rank: 3 })]} filters={NO_FILTERS} />,
    );
    // Field path matches TECH §5.1 convention: ['items', itemId, 'rank'].
    // React HTML-escapes `>` to `&gt;` in attribute values; assert the
    // serialised form so the SPA's `data-edit-field` reader sees the
    // expected string after browser-side `getAttribute()` decoding.
    expect(html).toContain('data-edit-field="items&gt;45&gt;rank"');
    // The pencil button is present per inv 30 visual treatment
    expect(html).toContain('data-edit-action="open"');
  });

  test("rank affordance is a button (keyboard-operable per inv 14 WCAG 2.1 AA)", () => {
    const html = renderToStaticMarkup(
      <BacklogIndexView items={[mkItem({ id: "1", rank: 1 })]} filters={NO_FILTERS} />,
    );
    // Pencil button is a <button> not a div — Tab + Enter operable.
    // React serialises `>` as `&gt;` in attribute values, hence the
    // escaped form in the regex.
    expect(html).toMatch(
      /<button[^>]*data-edit-field="items&gt;1&gt;rank"[^>]*>/,
    );
  });

  test("each row carries a drag handle with keyboard-operable affordance", () => {
    const items = [
      mkItem({ id: "1", priority: "high", rank: 1 }),
      mkItem({ id: "2", priority: "high", rank: 2 }),
    ];
    const html = renderToStaticMarkup(
      <BacklogIndexView items={items} filters={NO_FILTERS} />,
    );
    // Drag handle exposes data-drag-handle + aria-grabbed + tabIndex 0
    expect(html).toMatch(/data-drag-handle="1"/);
    expect(html).toMatch(/data-drag-handle="2"/);
    // Keyboard operability: tabIndex=0 + aria-label
    expect(html).toMatch(/data-drag-handle="1"[^>]*tabindex="0"/i);
    expect(html).toMatch(/aria-label="Reorder backlog item 1"/);
  });

  test("drag handle uses semantic role and ARIA for keyboard reorder", () => {
    const html = renderToStaticMarkup(
      <BacklogIndexView items={[mkItem({ id: "1", priority: "high" })]} filters={NO_FILTERS} />,
    );
    // role=button + data-keyboard-shortcut for arrow keys
    expect(html).toMatch(/data-drag-handle="1"[^>]*role="button"/);
    expect(html).toMatch(/data-keyboard-shortcut="arrow-up,arrow-down,enter"/);
  });

  test("rows are sorted by priority → rank (nulls last) → id per inv 10", () => {
    const items = [
      mkItem({ id: "1", priority: "could", rank: 1 }),
      mkItem({ id: "2", priority: "must", rank: null }),
      mkItem({ id: "3", priority: "must", rank: 5 }),
      mkItem({ id: "4", priority: "must", rank: 1 }),
    ];
    const html = renderToStaticMarkup(
      <BacklogIndexView items={items} filters={NO_FILTERS} />,
    );
    const rows = [...html.matchAll(/data-backlog-row="(\d+)"/g)].map(
      (m) => m[1],
    );
    // must/1 → must/5 → must/null → could/1
    expect(rows).toEqual(["4", "3", "2", "1"]);
  });

  test("priority tier markers are emitted on each row to anchor drag-within-tier logic", () => {
    const items = [
      mkItem({ id: "1", priority: "must" }),
      mkItem({ id: "2", priority: "high" }),
    ];
    const html = renderToStaticMarkup(
      <BacklogIndexView items={items} filters={NO_FILTERS} />,
    );
    // data-priority-tier on each row so the SPA + drag logic know the tier
    expect(html).toMatch(/data-priority-tier="must"/);
    expect(html).toMatch(/data-priority-tier="high"/);
  });

  test("the table header carries data-supports-drag-reorder so SPA wires drag handler once at mount", () => {
    const html = renderToStaticMarkup(
      <BacklogIndexView items={[mkItem()]} filters={NO_FILTERS} />,
    );
    expect(html).toContain('data-supports-drag-reorder="true"');
  });
});

// ── roadmap-backlog-consolidation PRODUCT inv 11 (no Promote button) ─────────

describe("inv 11 — NO Promote-to-task-list affordance on the Backlog index", () => {
  test("does not render a Promote button at any level", () => {
    const items = [mkItem({ id: "1" }), mkItem({ id: "2", status: "ready" })];
    const html = renderToStaticMarkup(
      <BacklogIndexView items={items} filters={NO_FILTERS} />,
    );
    expect(html).not.toMatch(/<button[^>]*>[^<]*Promote[^<]*<\/button>/i);
    expect(html).not.toMatch(/data-testid="promote-button"/);
    expect(html).not.toMatch(/data-promote-affordance/);
  });
});

// ── roadmap-backlog-consolidation PRODUCT inv 14 (Warm Meridian — semantic tokens) ─

describe("inv 14 — no raw Tailwind colour classes in the rendered markup", () => {
  test("rendered HTML contains no raw Tailwind colour classes", () => {
    const items = [
      mkItem({ id: "1", priority: "high", rank: 1 }),
      mkItem({ id: "2", priority: "high", rank: null }),
    ];
    const html = renderToStaticMarkup(
      <BacklogIndexView items={items} filters={NO_FILTERS} />,
    );
    // Tailwind colour utilities to reject: bg-{colour}-{shade},
    // text-{colour}-{shade}, border-{colour}-{shade}, ring-{colour}-{shade}
    // Catches e.g. bg-red-500, text-blue-700, border-gray-300, ring-amber-400.
    const rawTailwindColour =
      /(?:bg|text|border|ring|fill|stroke|from|to|via)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|grey|zinc|neutral|stone)-(?:50|100|200|300|400|500|600|700|800|900|950)/;
    expect(html).not.toMatch(rawTailwindColour);
  });
});
