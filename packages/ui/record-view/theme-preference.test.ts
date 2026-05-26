/**
 * theme-preference.test.ts — SV-52 resolver contract.
 *
 * Pure-function tests: precedence (query > cookie > default), registry
 * validation, mode-support resolution (SV-7), and injection safety (an
 * invalid theme id is never echoed into the htmlClass).
 */
import { describe, expect, test } from "bun:test";
import {
  resolveThemePreference,
  readCookie,
  DEFAULT_THEME_ID,
  DEFAULT_MODE,
} from "./theme-preference";

describe("resolveThemePreference — defaults (SV-6)", () => {
  test("no input → task-view / dark / theme-task-view (no light)", () => {
    const r = resolveThemePreference();
    expect(r.themeId).toBe("task-view");
    expect(r.mode).toBe("dark");
    expect(r.htmlClass).toBe("theme-task-view");
    expect(DEFAULT_THEME_ID).toBe("task-view");
    expect(DEFAULT_MODE).toBe("dark");
  });

  test("empty cookie + empty query → defaults", () => {
    const r = resolveThemePreference({
      cookieHeader: "",
      query: new URLSearchParams(""),
    });
    expect(r.htmlClass).toBe("theme-task-view");
  });
});

describe("resolveThemePreference — precedence (SV-8)", () => {
  test("cookie beats default", () => {
    const r = resolveThemePreference({
      cookieHeader: "task-view-color-theme=github; task-view-theme=light",
    });
    expect(r.themeId).toBe("github");
    expect(r.mode).toBe("light");
    expect(r.htmlClass).toBe("theme-github light");
  });

  test("query beats cookie", () => {
    const r = resolveThemePreference({
      cookieHeader: "task-view-color-theme=github; task-view-theme=light",
      query: new URLSearchParams("theme=dracula&mode=dark"),
    });
    expect(r.themeId).toBe("dracula");
    expect(r.mode).toBe("dark");
  });

  test("query theme only; mode falls back to cookie", () => {
    const r = resolveThemePreference({
      cookieHeader: "task-view-theme=light",
      query: new URLSearchParams("theme=github"),
    });
    expect(r.themeId).toBe("github");
    expect(r.mode).toBe("light");
    expect(r.htmlClass).toBe("theme-github light");
  });
});

describe("resolveThemePreference — mode-support (SV-7)", () => {
  test("dark-only theme + requested light → no ' light' suffix", () => {
    // 'dracula' is modeSupport: 'dark-only' in the registry.
    const r = resolveThemePreference({
      query: new URLSearchParams("theme=dracula&mode=light"),
    });
    expect(r.themeId).toBe("dracula");
    expect(r.mode).toBe("light"); // requested mode preserved…
    expect(r.htmlClass).toBe("theme-dracula"); // …but no light applied
    expect(r.htmlClass).not.toContain("light");
  });

  test("light-only theme + requested dark → always ' light'", () => {
    // 'one-light' is modeSupport: 'light-only'.
    const r = resolveThemePreference({
      query: new URLSearchParams("theme=one-light&mode=dark"),
    });
    expect(r.htmlClass).toBe("theme-one-light light");
  });

  test("both-mode theme + system → resolves dark server-side", () => {
    const r = resolveThemePreference({
      query: new URLSearchParams("theme=github&mode=system"),
    });
    expect(r.mode).toBe("system");
    expect(r.htmlClass).toBe("theme-github"); // system → dark on the server
  });
});

describe("resolveThemePreference — injection safety (SV-51/52)", () => {
  test("unknown query theme → falls back; value never echoed", () => {
    const malicious = '"><script>alert(1)</script>';
    const r = resolveThemePreference({
      query: new URLSearchParams([["theme", malicious]]),
    });
    expect(r.themeId).toBe("task-view");
    expect(r.htmlClass).toBe("theme-task-view");
    expect(r.htmlClass).not.toContain("script");
    expect(r.htmlClass).not.toContain(malicious);
  });

  test("unknown cookie theme → falls back to default", () => {
    const r = resolveThemePreference({
      cookieHeader: "task-view-color-theme=not-a-real-theme",
    });
    expect(r.themeId).toBe("task-view");
  });

  test("invalid mode → ignored (default dark)", () => {
    const r = resolveThemePreference({
      query: new URLSearchParams("theme=github&mode=sideways"),
    });
    expect(r.mode).toBe("dark");
    expect(r.htmlClass).toBe("theme-github");
  });
});

describe("readCookie", () => {
  test("extracts a named cookie value, trimming whitespace", () => {
    expect(readCookie("a=1; task-view-theme=light ; b=2", "task-view-theme")).toBe(
      "light",
    );
  });
  test("absent cookie → null", () => {
    expect(readCookie("a=1", "task-view-theme")).toBeNull();
    expect(readCookie(null, "task-view-theme")).toBeNull();
    expect(readCookie("", "task-view-theme")).toBeNull();
  });
});
