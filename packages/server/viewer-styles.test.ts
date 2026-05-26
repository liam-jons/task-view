/**
 * viewer-styles.test.ts — boot assembler determinism + isolation (SV-53).
 *
 * Network-free: reads CSS off disk + asserts cache identity, concatenation
 * order, theme-class resolution, and the safety-stylesheet failure path
 * (forced via the test-only uiDir override, mirroring the client-bundle
 * cache-reset pattern).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  getViewerStyles,
  _resetViewerStylesCacheForTests,
  _setUiDirOverrideForTests,
} from "./viewer-styles";

afterEach(() => {
  _setUiDirOverrideForTests(null);
  _resetViewerStylesCacheForTests();
});

describe("getViewerStyles — assembly + layers (TECH §1-§2)", () => {
  test("css carries a token rule, a base rule, and a record-view rule", async () => {
    const { css } = await getViewerStyles("task-view", "dark");
    expect(css).toContain("--background"); // token layer
    expect(css).toContain(":focus-visible"); // base layer (theme.base.css)
    expect(css).toContain(".record-view-frontmatter-card"); // record-view layer
    expect(css).toContain(".hljs-keyword"); // hljs token layer (OQ-1)
    expect(css).toContain("@media print"); // print layer
    expect(css).toContain(".task-view-print"); // print class overrides
  });

  test("concatenation order is fixed: tokens → base → record-view → hljs → print", async () => {
    const { css } = await getViewerStyles("task-view", "dark");
    const iToken = css.indexOf(".theme-task-view");
    const iBase = css.indexOf(":focus-visible");
    const iRecord = css.indexOf(".record-view-frontmatter-card");
    const iHljs = css.indexOf(".hljs-keyword");
    const iPrint = css.indexOf("@media print");
    expect(iToken).toBeGreaterThan(-1);
    expect(iToken).toBeLessThan(iBase);
    expect(iBase).toBeLessThan(iRecord);
    expect(iRecord).toBeLessThan(iHljs);
    expect(iHljs).toBeLessThan(iPrint);
  });

  test("a non-default theme inlines its tokens PLUS the task-view fallback", async () => {
    const { css } = await getViewerStyles("github", "light");
    expect(css).toContain(".theme-github");
    expect(css).toContain(".theme-task-view"); // guaranteed fallback token set
    // Fallback first so the selected theme's tokens win on cascade order.
    expect(css.indexOf(".theme-task-view")).toBeLessThan(
      css.indexOf(".theme-github"),
    );
  });
});

describe("getViewerStyles — determinism / cache (SV-53)", () => {
  test("two calls return byte-identical css (cached)", async () => {
    const a = await getViewerStyles("task-view", "dark");
    const b = await getViewerStyles("task-view", "dark");
    expect(a.css).toBe(b.css);
  });

  test("css is mode-agnostic; only htmlClass changes with mode", async () => {
    const dark = await getViewerStyles("github", "dark");
    const light = await getViewerStyles("github", "light");
    expect(dark.css).toBe(light.css); // same assembled sheet
    expect(dark.htmlClass).toBe("theme-github");
    expect(light.htmlClass).toBe("theme-github light");
  });
});

describe("getViewerStyles — htmlClass resolution (SV-7)", () => {
  test("default → theme-task-view (dark, no light)", async () => {
    const { htmlClass } = await getViewerStyles("task-view", "dark");
    expect(htmlClass).toBe("theme-task-view");
  });

  test("dark-only theme + light mode → no ' light'", async () => {
    const { htmlClass } = await getViewerStyles("dracula", "light");
    expect(htmlClass).toBe("theme-dracula");
  });

  test("invalid theme id → falls back to theme-task-view (never reaches disk path)", async () => {
    const { htmlClass, css } = await getViewerStyles("nope-not-real", "dark");
    expect(htmlClass).toBe("theme-task-view");
    // And the assembled css is the task-view sheet, not a failed read.
    expect(css).toContain(".theme-task-view");
    expect(css).toContain(".record-view-frontmatter-card");
  });
});

describe("getViewerStyles — failure isolation (SV-53 / TECH §4)", () => {
  test("a read failure returns the safety stylesheet, never throws", async () => {
    _setUiDirOverrideForTests("/task-view-nonexistent-dir-for-tests");
    _resetViewerStylesCacheForTests();

    let result: Awaited<ReturnType<typeof getViewerStyles>> | undefined;
    let threw = false;
    try {
      result = await getViewerStyles("task-view", "dark");
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).toBeDefined();
    // Safety sheet is small + still carries a token + a record-view rule so
    // the page renders themed-degraded, never unstyled-broken.
    expect(result!.css.length).toBeLessThan(2000);
    expect(result!.css).toContain("--background");
    expect(result!.css).toContain("record-view-");
    expect(result!.htmlClass).toBe("theme-task-view");
  });
});
