/**
 * ledger-switcher.test.tsx — runtime editable ledger switcher
 * (editable-ledger-switch SPEC §2 / §5 slice 2). Replaces the read-only
 * ledger-banner: every viewer-renderable sibling in the launch directory is
 * an EDITABLE switch target, rendered as a nav of `/?ledger=<slug>` links
 * with the active ledger marked `aria-current="page"`.
 *
 * ID-148.10: `roadmap` slug repurposed to `initiatives`.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LedgerSwitcher } from "./ledger-switcher";

describe("LedgerSwitcher (editable-ledger-switch SPEC §5 slice 2)", () => {
  test("renders a nav with a link per available ledger, in canonical order", () => {
    const html = renderToStaticMarkup(
      <LedgerSwitcher
        available={["task-list", "initiatives", "backlog"]}
        active="task-list"
      />,
    );
    expect(html).toContain("data-ledger-switcher");
    // Human-readable display names for all three present.
    expect(html).toContain("Task List");
    expect(html).toContain("Initiatives");
    expect(html).toContain("Backlog");
    // Each links to its own /?ledger=<slug> index (switch = land on its index).
    expect(html).toContain('href="/?ledger=task-list"');
    expect(html).toContain('href="/?ledger=initiatives"');
    expect(html).toContain('href="/?ledger=backlog"');
    // Canonical order regardless of input order: task-list < initiatives < backlog.
    expect(html.indexOf("Task List")).toBeLessThan(html.indexOf("Initiatives"));
    expect(html.indexOf("Initiatives")).toBeLessThan(html.indexOf("Backlog"));
  });

  test("marks the active ledger with aria-current=page and exposes it as a data hook", () => {
    const html = renderToStaticMarkup(
      <LedgerSwitcher
        available={["task-list", "initiatives", "backlog"]}
        active="initiatives"
      />,
    );
    // Exactly one entry is current.
    expect(html).toContain('aria-current="page"');
    expect(html.match(/aria-current="page"/g)?.length).toBe(1);
    // The nav exposes the active slug so the client can read it without ?ledger=.
    expect(html).toContain('data-active-ledger="initiatives"');
  });

  test("renders only the ledgers present in the directory (allow-list)", () => {
    // A directory with just task-list + initiatives — no backlog sibling.
    const html = renderToStaticMarkup(
      <LedgerSwitcher
        available={["task-list", "initiatives"]}
        active="task-list"
      />,
    );
    expect(html).toContain("Task List");
    expect(html).toContain("Initiatives");
    expect(html).not.toContain('href="/?ledger=backlog"');
  });

  test("a single available ledger still renders the switcher, marked active", () => {
    const html = renderToStaticMarkup(
      <LedgerSwitcher available={["backlog"]} active="backlog" />,
    );
    expect(html).toContain("data-ledger-switcher");
    expect(html).toContain("Backlog");
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('data-active-ledger="backlog"');
  });
});
