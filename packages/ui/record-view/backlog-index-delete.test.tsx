/**
 * backlog-index-delete.test.tsx — per-row delete affordance on the
 * Backlog index (backlog-ui-delete). One button per rendered row,
 * resolvable to its record id via the existing data-backlog-row hook,
 * suppressed under a read-only render (DR-6).
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { BacklogItem } from "@task-view/schemas/backlog";
import { BacklogIndexView } from "./backlog-index-view";

const mkItem = (overrides: Partial<BacklogItem> = {}): BacklogItem => ({
  id: "1",
  description: "Item.",
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

describe("backlog index — per-row delete affordance", () => {
  test("renders one delete button per row, each a real button", () => {
    const items = [mkItem({ id: "1" }), mkItem({ id: "2" })];
    const html = renderToStaticMarkup(
      <BacklogIndexView items={items} filters={NO_FILTERS} />,
    );
    const matches = [...html.matchAll(/data-delete-action/g)];
    expect(matches.length).toBe(2);
    expect(html).toMatch(/<button[^>]*type="button"[^>]*data-delete-action/);
    expect(html).toContain('aria-label="Delete backlog item 1"');
    expect(html).toContain('aria-label="Delete backlog item 2"');
  });

  test("renders a guarded Actions column header", () => {
    const html = renderToStaticMarkup(
      <BacklogIndexView items={[mkItem()]} filters={NO_FILTERS} />,
    );
    expect(html).toContain('<th scope="col">Actions</th>');
  });

  test("count carries data-item-count + data-item-total hooks for the client", () => {
    // After a delete the client decrements both shown + total; it needs an
    // authoritative total hook rather than re-parsing the rendered text.
    const items = [mkItem({ id: "1" }), mkItem({ id: "2" }), mkItem({ id: "3" })];
    const html = renderToStaticMarkup(
      <BacklogIndexView items={items} filters={NO_FILTERS} />,
    );
    expect(html).toContain('data-item-count="3"');
    expect(html).toContain('data-item-total="3"');
  });

});
