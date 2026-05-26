/**
 * record-view/theme-client.ts — tiny client-side theme helpers for the
 * in-page picker (OQ-3) + the no-flash mode-correction enhancement (SV-9).
 *
 * These run inside the inlined client dispatcher (apps/server/web/index.tsx),
 * NOT React. They reuse the SAME class grammar + cookie keys as
 * ThemeProvider (ThemeProvider.tsx:44-58,77-78) so the record-view picker and
 * the (future) full SPA stay in lock-step — picking a theme here is honoured
 * by the SPA and vice-versa.
 *
 * Kept in a separate module (not buried in the dispatcher) so the cookie +
 * re-class logic is unit-testable; the dispatcher's added surface is just the
 * change listener + a beforeprint/afterprint toggle.
 */
import { resolveThemePreference, type ThemeMode } from "./theme-preference";

export const COLOR_THEME_COOKIE = "task-view-color-theme";
export const MODE_COOKIE = "task-view-theme";

/**
 * Sync the theme classes on `<html>` without stripping non-theme classes
 * (e.g. `transitions-ready`, `task-view-print`). Mirrors
 * ThemeProvider.applyThemeClasses (ThemeProvider.tsx:44-58): remove any
 * prior `theme-*` + `light`, then add the resolved pair. `htmlClass` is the
 * `theme-{id}[ light]` string from `resolveThemePreference`.
 */
export function setHtmlThemeClass(
  root: { classList: DOMTokenList },
  htmlClass: string,
): void {
  const classes = htmlClass.split(/\s+/).filter(Boolean);
  for (const cls of Array.from(root.classList)) {
    if (cls.startsWith("theme-")) root.classList.remove(cls);
  }
  root.classList.remove("light");
  for (const cls of classes) root.classList.add(cls);
}

/**
 * Resolve a (themeId, mode) selection to its `<html>` class and apply it to
 * `document.documentElement`. Validates through the shared resolver so an
 * unknown id can never reach the class (falls back to task-view).
 */
export function applyThemeClassesToHtml(themeId: string, mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  const { htmlClass } = resolveThemePreference({
    query: new URLSearchParams([
      ["theme", themeId],
      ["mode", mode],
    ]),
  });
  setHtmlThemeClass(document.documentElement, htmlClass);
}

/**
 * Persist a theme + mode choice to the SAME cookies ThemeProvider reads
 * (SV-10 — the client owns persistence; the server only reads). 1-year
 * max-age, path=/, SameSite=Lax. No-op outside a document.
 */
export function writeThemeCookie(themeId: string, mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  const maxAge = 60 * 60 * 24 * 365;
  const attrs = `; path=/; max-age=${maxAge}; SameSite=Lax`;
  document.cookie = `${COLOR_THEME_COOKIE}=${encodeURIComponent(themeId)}${attrs}`;
  document.cookie = `${MODE_COOKIE}=${encodeURIComponent(mode)}${attrs}`;
}
