/**
 * broken-target.test.tsx — exercise the missing-target rendering
 * primitives (TECH §4.5, PRODUCT inv 11, 12, 13, 22, 52).
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BrokenLink,
  MaybeCrossDocLink,
  MaybeRecordLink,
  PageTopWarning,
  toForwardSlashHref,
} from "./broken-target";

describe("toForwardSlashHref (PRODUCT inv 52)", () => {
  test("converts Windows backslashes to forward slashes", () => {
    expect(toForwardSlashHref("docs\\specs\\foo.md")).toBe("docs/specs/foo.md");
  });

  test("is a no-op for already-POSIX paths", () => {
    expect(toForwardSlashHref("docs/specs/foo.md")).toBe("docs/specs/foo.md");
  });

  test("handles mixed separators (Windows-WSL2 edge)", () => {
    expect(toForwardSlashHref("docs/specs\\nested/foo.md")).toBe(
      "docs/specs/nested/foo.md",
    );
  });
});

describe("BrokenLink (TECH §4.5)", () => {
  test("renders strikethrough span with '(missing)' suffix for record refs", () => {
    const html = renderToStaticMarkup(
      <BrokenLink suffix="record">ID-99</BrokenLink>,
    );
    expect(html).toContain("ID-99");
    expect(html).toContain("(missing)");
    expect(html).toContain("text-decoration:line-through");
    expect(html).toContain('data-broken-target="record"');
  });

  test("renders '(missing target)' suffix for cross-doc paths", () => {
    const html = renderToStaticMarkup(
      <BrokenLink suffix="doc">docs/foo/bar.md</BrokenLink>,
    );
    expect(html).toContain("docs/foo/bar.md");
    expect(html).toContain("(missing target)");
    expect(html).toContain('data-broken-target="doc"');
  });
});

describe("MaybeRecordLink (PRODUCT inv 12, 13, 22)", () => {
  test("renders a live anchor when the target id exists", () => {
    const html = renderToStaticMarkup(
      <MaybeRecordLink href="ID-20.md" label="ID-20" exists={true} />,
    );
    expect(html).toContain('href="ID-20.md"');
    expect(html).toContain(">ID-20<");
    expect(html).not.toContain("line-through");
  });

  test("renders a broken-link when the target id is missing", () => {
    const html = renderToStaticMarkup(
      <MaybeRecordLink href="ID-99.md" label="ID-99" exists={false} />,
    );
    expect(html).toContain("ID-99");
    expect(html).toContain("(missing)");
    expect(html).toContain("line-through");
    expect(html).not.toContain('href="ID-99.md"');
  });

  test("forces forward-slash separators in href (PRODUCT inv 52)", () => {
    // Simulate a Windows-style ledger path coming through the renderer.
    // Use braces + JS string literal so `\\` becomes a real single backslash
    // (a JSX attribute string would keep both backslashes literal).
    const windowsHref = "subdir\\ID-20.md";
    const html = renderToStaticMarkup(
      <MaybeRecordLink href={windowsHref} label="ID-20" exists={true} />,
    );
    expect(html).toContain('href="subdir/ID-20.md"');
    expect(html).not.toContain("subdir\\ID-20.md");
  });
});

describe("MaybeCrossDocLink (PRODUCT inv 11)", () => {
  test("renders live anchor when path is in existingPaths", () => {
    const html = renderToStaticMarkup(
      <MaybeCrossDocLink
        path="docs/specs/foo.md"
        anchor={null}
        label="foo spec"
        existingPaths={new Set(["docs/specs/foo.md"])}
      />,
    );
    expect(html).toContain('href="docs/specs/foo.md"');
    expect(html).toContain(">foo spec<");
  });

  test("appends anchor to href when provided", () => {
    const html = renderToStaticMarkup(
      <MaybeCrossDocLink
        path="docs/specs/foo.md"
        anchor="#section-2"
        label="foo §2"
        existingPaths={new Set(["docs/specs/foo.md"])}
      />,
    );
    expect(html).toContain('href="docs/specs/foo.md#section-2"');
  });

  test("renders broken-link when path is missing from existingPaths", () => {
    const html = renderToStaticMarkup(
      <MaybeCrossDocLink
        path="docs/specs/missing.md"
        anchor={null}
        label="missing"
        existingPaths={new Set(["docs/specs/foo.md"])}
      />,
    );
    expect(html).toContain("(missing target)");
    expect(html).toContain("line-through");
  });

  test("conservatively renders live when existingPaths is null", () => {
    const html = renderToStaticMarkup(
      <MaybeCrossDocLink
        path="docs/specs/foo.md"
        anchor={null}
        label="foo"
        existingPaths={null}
      />,
    );
    expect(html).toContain('href="docs/specs/foo.md"');
    expect(html).not.toContain("line-through");
  });

  test("normalises Windows backslashes in href even when live (PRODUCT inv 52)", () => {
    // Use braces + JS string literal so `\\` becomes real single backslashes.
    const windowsPath = "docs\\specs\\foo.md";
    const html = renderToStaticMarkup(
      <MaybeCrossDocLink
        path={windowsPath}
        anchor={null}
        label="foo"
        existingPaths={null}
      />,
    );
    expect(html).toContain('href="docs/specs/foo.md"');
  });
});

describe("PageTopWarning (TECH §4.5, PRODUCT inv 12)", () => {
  test("renders nothing when missingIds is empty", () => {
    const html = renderToStaticMarkup(
      <PageTopWarning subject="This Task" missingIds={[]} />,
    );
    expect(html).toBe("");
  });

  test("renders an alert with subject + comma-separated missing ids", () => {
    const html = renderToStaticMarkup(
      <PageTopWarning
        subject="This Task"
        missingIds={["ID-99", "ID-101"]}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("This Task");
    expect(html).toContain("dependencies that");
    expect(html).toContain("ID-99");
    expect(html).toContain("ID-101");
  });
});
