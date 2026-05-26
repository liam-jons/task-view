/**
 * record-view/theme-preference.ts — pure theme-preference resolver
 * (record-view-styling SPEC SV-7, SV-8, SV-52; TASKS T2).
 *
 * The record-view SSR surface is a hand-assembled `<html>` string (no
 * `ThemeProvider` runs on it — SPEC §2.2). This module resolves which theme
 * class to bake onto that `<html>` and which token theme to inline, from the
 * request's `Cookie` header + query string, with full injection safety.
 *
 * Precedence (SV-8): query override > cookie > default.
 *   - Cookie keys are the SAME ones `ThemeProvider` writes
 *     (`task-view-color-theme` for the palette, `task-view-theme` for the
 *     mode) so a browser that has used the SPA inherits its choice here with
 *     no UI of its own.
 *   - Query keys are `?theme=<id>&mode=<dark|light|system>`.
 * Validation is mandatory: an unknown theme id or mode is IGNORED (falls
 * through to the next source), never echoed into the output — so a crafted
 * `?theme="><script>` value can never reach the served `<html>` class.
 *
 * `htmlClass` reproduces `ThemeProvider.resolveThemeClasses`
 * (ThemeProvider.tsx:32-40): mode-support from the registry decides whether
 * the ` light` suffix is applied. `system` resolves to `dark` server-side
 * (no `matchMedia` on the server; the client may correct it — SV-9).
 *
 * Defaults (SV-6): colour theme `task-view`, mode `dark`.
 */
import { BUILT_IN_THEMES } from "../utils/themeRegistry";

export type ThemeMode = "dark" | "light" | "system";

export const DEFAULT_THEME_ID = "task-view";
export const DEFAULT_MODE: ThemeMode = "dark";

/** Cookie keys — identical to ThemeProvider's storage keys. */
export const COLOR_THEME_COOKIE = "task-view-color-theme";
export const MODE_COOKIE = "task-view-theme";

export interface ThemePreference {
  /** Validated colour-theme id (always a real BUILT_IN_THEMES id). */
  themeId: string;
  /** Validated requested mode (pre-mode-support resolution). */
  mode: ThemeMode;
  /**
   * The class string for the served `<html>` element: `theme-{id}` plus
   * ` light` when the resolved mode is light AND the theme supports it
   * (SV-7). Never contains an unvalidated value.
   */
  htmlClass: string;
}

export interface ResolveThemeInput {
  /** Raw `Cookie:` header value off the Request (may be undefined/empty). */
  cookieHeader?: string | null;
  /** The request URL's search params (query overrides). */
  query?: URLSearchParams | null;
}

const VALID_MODES: ReadonlySet<string> = new Set(["dark", "light", "system"]);

function isValidThemeId(id: string | null | undefined): id is string {
  if (typeof id !== "string" || id.length === 0) return false;
  return BUILT_IN_THEMES.some((t) => t.id === id);
}

function isValidMode(mode: string | null | undefined): mode is ThemeMode {
  return typeof mode === "string" && VALID_MODES.has(mode);
}

/**
 * Parse a single cookie value out of a raw `Cookie:` header. Returns null
 * when absent. Tolerant of surrounding whitespace + `;`-separated pairs;
 * does NOT URL-decode (theme ids + modes are bare tokens with no reserved
 * characters, and decoding would be an injection surface we don't want).
 */
export function readCookie(
  cookieHeader: string | null | undefined,
  name: string,
): string | null {
  if (typeof cookieHeader !== "string" || cookieHeader.length === 0) {
    return null;
  }
  for (const pair of cookieHeader.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    if (key === name) {
      return pair.slice(eq + 1).trim();
    }
  }
  return null;
}

/**
 * Resolve the effective light/dark application for a theme + requested mode,
 * honouring the registry's `modeSupport` (mirrors
 * ThemeProvider.resolveThemeClasses, ThemeProvider.tsx:32-40):
 *   - `dark-only`  → never light
 *   - `light-only` → always light
 *   - `both`       → light iff the requested (resolved) mode is light
 * `system` is treated as `dark` server-side (SV-7).
 */
function buildHtmlClass(themeId: string, mode: ThemeMode): string {
  const info = BUILT_IN_THEMES.find((t) => t.id === themeId);
  const modeSupport = info?.modeSupport ?? "both";

  const effectiveMode: "dark" | "light" = mode === "system" ? "dark" : mode;
  let applyLight = effectiveMode === "light";
  if (modeSupport === "dark-only") applyLight = false;
  if (modeSupport === "light-only") applyLight = true;

  return `theme-${themeId}${applyLight ? " light" : ""}`;
}

/**
 * Resolve the theme preference for a request. Pure + deterministic.
 *
 * @example
 *   resolveThemePreference({}) // → task-view / dark / "theme-task-view"
 *   resolveThemePreference({ query: new URLSearchParams("theme=github&mode=light") })
 *     // → github / light / "theme-github light"
 */
export function resolveThemePreference(
  input: ResolveThemeInput = {},
): ThemePreference {
  const { cookieHeader = null, query = null } = input;

  // Query override (highest precedence). Validate before trusting.
  const queryTheme = query?.get("theme") ?? null;
  const queryMode = query?.get("mode") ?? null;

  // Cookie (medium precedence).
  const cookieTheme = readCookie(cookieHeader, COLOR_THEME_COOKIE);
  const cookieMode = readCookie(cookieHeader, MODE_COOKIE);

  let themeId = DEFAULT_THEME_ID;
  if (isValidThemeId(queryTheme)) {
    themeId = queryTheme;
  } else if (isValidThemeId(cookieTheme)) {
    themeId = cookieTheme;
  }

  let mode: ThemeMode = DEFAULT_MODE;
  if (isValidMode(queryMode)) {
    mode = queryMode;
  } else if (isValidMode(cookieMode)) {
    mode = cookieMode;
  }

  return { themeId, mode, htmlClass: buildHtmlClass(themeId, mode) };
}
