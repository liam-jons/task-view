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

describe("PRODUCT inv 20 (Backlog index columns + sorted by track / status / id)", () => {
  test("renders all required columns", () => {
    const items = [mkItem()];
    const html = renderToStaticMarkup(
      <BacklogIndexView items={items} filters={NO_FILTERS} />,
    );
    expect(html).toContain('<th scope="col">ID</th>');
    expect(html).toContain('<th scope="col">Description</th>');
    expect(html).toContain('<th scope="col">Type</th>');
    expect(html).toContain('<th scope="col">Status</th>');
    expect(html).toContain('<th scope="col">Priority</th>');
    expect(html).toContain('<th scope="col">Track</th>');
    expect(html).toContain('<th scope="col">Effort</th>');
  });

  test("sorts by track, then status, then numeric id", () => {
    const items = [
      mkItem({ id: "10", track: "Bid", status: "ready" }),
      mkItem({ id: "2", track: "Bid", status: "ready" }),
      mkItem({ id: "3", track: "Bid", status: "blocked" }),
      mkItem({ id: "4", track: "Procurement", status: "ready" }),
    ];
    const html = renderToStaticMarkup(
      <BacklogIndexView items={items} filters={NO_FILTERS} />,
    );
    // Extract row id sequence
    const matches = [...html.matchAll(/data-backlog-row="(\d+)"/g)].map(
      (m) => m[1],
    );
    // Expected: track Bid/blocked first (id 3), then Bid/ready (2 then 10),
    // then Procurement/ready (4)
    expect(matches).toEqual(["3", "2", "10", "4"]);
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
