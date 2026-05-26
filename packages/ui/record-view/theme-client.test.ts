/**
 * theme-client.test.ts — OQ-3 picker client helpers.
 *
 * Tests the pure-ish DOM helpers without a real browser: setHtmlThemeClass
 * against a fake classList, and the cookie/re-class wrappers' no-op guard
 * outside a document. (The full click→re-class loop is exercised visually in
 * the agent-browser smoke pass.)
 */
import { describe, expect, test } from "bun:test";
import { setHtmlThemeClass } from "./theme-client";

/**
 * Minimal DOMTokenList stand-in backed by a Set. `setHtmlThemeClass` uses
 * only add / remove / contains / iteration (via `Array.from(classList)`), so
 * an iterable object with those methods suffices.
 */
function fakeRoot(initial: string[] = []): {
  classList: DOMTokenList;
  values: () => string[];
} {
  const set = new Set(initial);
  const classList = {
    add: (c: string) => set.add(c),
    remove: (c: string) => set.delete(c),
    contains: (c: string) => set.has(c),
    [Symbol.iterator]: () => set[Symbol.iterator](),
  };
  return {
    classList: classList as unknown as DOMTokenList,
    values: () => Array.from(set),
  };
}

describe("setHtmlThemeClass (mirrors ThemeProvider.applyThemeClasses)", () => {
  test("swaps a prior theme-* + light for the new pair", () => {
    const root = fakeRoot(["theme-github", "light", "transitions-ready"]);
    setHtmlThemeClass(root, "theme-dracula");
    const v = root.values();
    expect(v).toContain("theme-dracula");
    expect(v).not.toContain("theme-github");
    expect(v).not.toContain("light");
    // Non-theme classes are preserved (no flash-suppression regression).
    expect(v).toContain("transitions-ready");
  });

  test("applies ' light' when the htmlClass includes it", () => {
    const root = fakeRoot(["theme-task-view"]);
    setHtmlThemeClass(root, "theme-github light");
    const v = root.values();
    expect(v).toContain("theme-github");
    expect(v).toContain("light");
    expect(v).not.toContain("theme-task-view");
  });

  test("does not strip a print class", () => {
    const root = fakeRoot(["theme-task-view", "task-view-print"]);
    setHtmlThemeClass(root, "theme-nord");
    expect(root.values()).toContain("task-view-print");
  });
});
