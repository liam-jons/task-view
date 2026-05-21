/**
 * nav-strip.test.tsx — verifies the prev / index / next navigation
 * strip per PRODUCT inv 7 last bullet, inv 14, inv 20.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NavStrip } from "./nav-strip";

describe("NavStrip", () => {
  test("renders prev + index + next when all three are present", () => {
    const html = renderToStaticMarkup(
      <NavStrip
        data={{
          prevHref: "/record/ID-19",
          prevLabel: "ID-19",
          nextHref: "/record/ID-21",
          nextLabel: "ID-21",
          indexHref: "/",
          indexLabel: "Back to ledger index",
        }}
      />,
    );
    expect(html).toContain('href="/record/ID-19"');
    expect(html).toContain("ID-19");
    expect(html).toContain('href="/"');
    expect(html).toContain("Back to ledger index");
    expect(html).toContain('href="/record/ID-21"');
    expect(html).toContain("ID-21");
  });

  test("disables prev when at the start of the ledger", () => {
    const html = renderToStaticMarkup(
      <NavStrip
        data={{
          prevHref: null,
          prevLabel: null,
          nextHref: "/record/ID-21",
          nextLabel: "ID-21",
          indexHref: "/",
          indexLabel: "Back to index",
        }}
      />,
    );
    expect(html).toContain("data-nav-prev-disabled");
    expect(html).toContain("(start of ledger)");
    expect(html).not.toMatch(/href="[^"]*"[^>]*rel="prev"/);
  });

  test("disables next when at the end of the ledger", () => {
    const html = renderToStaticMarkup(
      <NavStrip
        data={{
          prevHref: "/record/ID-19",
          prevLabel: "ID-19",
          nextHref: null,
          nextLabel: null,
          indexHref: "/",
          indexLabel: "Back to index",
        }}
      />,
    );
    expect(html).toContain("data-nav-next-disabled");
    expect(html).toContain("(end of ledger)");
    expect(html).not.toMatch(/href="[^"]*"[^>]*rel="next"/);
  });

  test("forward-slash-normalises hrefs (PRODUCT inv 52)", () => {
    const html = renderToStaticMarkup(
      <NavStrip
        data={{
          prevHref: "record\\ID-19",
          prevLabel: "ID-19",
          nextHref: "record\\ID-21",
          nextLabel: "ID-21",
          indexHref: "index\\page",
          indexLabel: "Back",
        }}
      />,
    );
    expect(html).toContain('href="record/ID-19"');
    expect(html).toContain('href="record/ID-21"');
    expect(html).toContain('href="index/page"');
    expect(html).not.toContain("\\");
  });
});
