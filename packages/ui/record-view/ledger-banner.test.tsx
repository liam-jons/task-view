/**
 * ledger-banner.test.tsx — read-only cross-ledger banner ({20.29}, SPEC §5
 * slice 7 / §6).
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LedgerBanner } from "./ledger-banner";

describe("LedgerBanner ({20.29} SPEC §5 slice 7)", () => {
  test("names the sibling ledger + the launched ledger + a back link", () => {
    const html = renderToStaticMarkup(
      <LedgerBanner siblingSlug="roadmap" launchedSlug="task-list" />,
    );
    expect(html).toContain("data-ledger-banner");
    // Human-readable sibling + launched ledger names.
    expect(html).toContain("Roadmap");
    expect(html).toContain("read-only");
    expect(html).toContain("Task List");
    // Back-to-launched link points at the launched ledger root.
    expect(html).toContain('href="/"');
    expect(html).toContain("Back to launched ledger");
  });

  test("renders each sibling slug with its display name", () => {
    const backlog = renderToStaticMarkup(
      <LedgerBanner siblingSlug="backlog" launchedSlug="roadmap" />,
    );
    expect(backlog).toContain("Backlog");
    expect(backlog).toContain("Roadmap");

    const taskList = renderToStaticMarkup(
      <LedgerBanner siblingSlug="task-list" launchedSlug="backlog" />,
    );
    expect(taskList).toContain("Task List");
    expect(taskList).toContain("Backlog");
  });

  test("carries the sibling slug as a data hook", () => {
    const html = renderToStaticMarkup(
      <LedgerBanner siblingSlug="roadmap" launchedSlug="task-list" />,
    );
    expect(html).toContain('data-ledger-banner="roadmap"');
  });
});
