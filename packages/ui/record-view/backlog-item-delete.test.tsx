/**
 * backlog-item-delete.test.tsx — the per-item-page delete affordance
 * (backlog-ui-delete). Asserts the button + its data hooks are present
 * by default and SUPPRESSED under a read-only sibling render (DR-6: a
 * read-only cross-ledger page is never a mutation target).
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { BacklogItem } from "@task-view/schemas/backlog";
import { buildLedgerContext, type NavStripData } from "./types";
import { BacklogItemView } from "./backlog-item-view";
import { ReadOnlyProvider } from "./read-only-context";

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

describe("backlog item page — delete affordance", () => {
  test("renders a delete button carrying data-delete-action by default", () => {
    const item = mkItem();
    const ledger = buildLedgerContext({ backlogItems: [item] });
    const html = renderToStaticMarkup(
      <BacklogItemView item={item} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain("data-delete-action");
    // It is a real <button type="button"> with an accessible name.
    expect(html).toMatch(/<button[^>]*type="button"[^>]*data-delete-action/);
    expect(html).toContain('aria-label="Delete backlog item 45"');
    // The record id is resolvable from the surrounding data-record-id.
    expect(html).toContain('data-record-id="45"');
  });

  test("suppresses the delete affordance under a read-only render (DR-6)", () => {
    const item = mkItem();
    const ledger = buildLedgerContext({ backlogItems: [item] });
    const html = renderToStaticMarkup(
      <ReadOnlyProvider readOnly={true}>
        <BacklogItemView item={item} ledger={ledger} nav={NAV} />
      </ReadOnlyProvider>,
    );
    expect(html).not.toContain("data-delete-action");
  });
});
