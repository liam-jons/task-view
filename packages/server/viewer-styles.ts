/**
 * viewer-styles.ts — boot-time inline-stylesheet assembler for the SSR
 * record-view surface (record-view-styling SPEC TECH §1-§4, SV-3; TASKS T3).
 *
 * The record-view page is a hand-assembled `<html>` string served by the
 * patch server; no `ThemeProvider` runs on it and there is no `dist`/CDN
 * (C-NoDist, C-Inv44). So the complete stylesheet is assembled ONCE from
 * on-disk CSS, cached in-process (exactly like client-bundle.ts), and inlined
 * into a single `<style>` in `<head>` by `wrapHtml`.
 *
 * Concatenation order (TECH §2), deterministic + fixed:
 *   1. Token layer — the SELECTED theme file's `.theme-{id}` blocks PLUS the
 *      `task-view` token file as a guaranteed fallback (so an edge theme with
 *      a missing token still has a full set). We read 1-2 small files, never
 *      all 49.
 *   2. Base layer — `theme.base.css` (browser-valid subset split out of
 *      theme.css per OQ-2: body, scrollbars, ::selection, transitions,
 *      :focus-visible, reduced-motion, .html-block prose, .sr-only).
 *   3. Record-view layer — `record-view/record-view.css` (the bulk).
 *   4. hljs token layer — `record-view/hljs-tokens.css` (theme-neutral
 *      syntax-highlight palette for the client-side hljs pass, OQ-1 Option B).
 *   5. Print layer — `print.css` (`@media print` + `.task-view-print`
 *      overrides; the client dispatcher toggles `.task-view-print` on
 *      beforeprint/afterprint).
 *
 * Path resolution uses `import.meta.dir` + `node:path` (TECH §3, the proven
 * client-bundle.ts:34-41 pattern) — no `process.cwd()`, no glob ordering, so
 * the same input yields byte-identical CSS on macOS/Linux/Windows
 * (C-Deterministic). On a read failure we log to stderr and fall back to a
 * tiny built-in safety stylesheet — a broken read must never take down the
 * viewer (TECH §4, mirroring getClientBundle's fallback).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveThemePreference,
  type ThemeMode,
} from "@task-view/ui/record-view/theme-preference";

export interface ViewerStyles {
  /** The full stylesheet text to inline inside a single <style>. */
  css: string;
  /** The `theme-{id}[ light]` class for the served <html> (SV-2/SV-7). */
  htmlClass: string;
}

/**
 * Test-only override for the packages/ui directory so a test can point the
 * assembler at a missing directory to exercise the safety-stylesheet path
 * (SV-53) without touching real files. `null` = use the real resolution.
 */
let _uiDirOverride: string | null = null;

/** Resolve the packages/ui directory from this module (packages/server). */
function uiDir(): string {
  if (_uiDirOverride !== null) return _uiDirOverride;
  const here =
    typeof import.meta.dir === "string"
      ? import.meta.dir
      : dirname(fileURLToPath(import.meta.url));
  // packages/server → packages/ui
  return join(here, "..", "ui");
}

/**
 * Fixed, theme-independent layers (base + record-view + hljs + print). Read
 * once and cached; concatenated after the per-theme token layer.
 */
const FIXED_LAYER_FILES = (ui: string): readonly string[] => [
  join(ui, "theme.base.css"),
  join(ui, "record-view", "record-view.css"),
  join(ui, "record-view", "hljs-tokens.css"),
  join(ui, "print.css"),
];

const FALLBACK_THEME_ID = "task-view";

// ── In-process caches (built once per server process) ───────────────────────
let cachedFixedLayers: string | null = null;
/** Per-theme token-file text, keyed by theme id. */
const cachedTokenLayers = new Map<string, string>();
/** Per-theme fully-assembled css, keyed by theme id. */
const cachedAssembled = new Map<string, string>();

/**
 * A minimal token-driven safety stylesheet. Emitted only if reading the
 * real CSS off disk fails — the page renders themed-degraded (dark
 * task-view tokens + readable type + table borders), never unstyled-broken.
 */
const SAFETY_CSS = `:root,.theme-task-view{--background:#16161f;--foreground:#e6e6ef;--card:#1f1f2b;--card-foreground:#e6e6ef;--muted:#262633;--muted-foreground:#b7b7c6;--primary:#a78bfa;--primary-foreground:#16161f;--destructive:#f87171;--border:#3a3a4a;--input:#262633;--ring:#a78bfa;--success:#4ade80;--warning:#fbbf24;--radius:0.625rem;--font-sans:system-ui,sans-serif;--font-mono:ui-monospace,monospace;--code-bg:#262633}
body{background:var(--background);color:var(--foreground);font-family:var(--font-sans);line-height:1.6}
:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
[class^="record-view-"]{max-width:64rem;margin-inline:auto;padding:1.5rem}
.record-view-frontmatter-card,table{border-collapse:collapse}
.record-view-frontmatter-card th,.record-view-frontmatter-card td,th,td{border:1px solid var(--border);padding:0.5rem 0.75rem;text-align:left}
a{color:var(--primary)}`;

async function readFileText(path: string): Promise<string> {
  return Bun.file(path).text();
}

/** Read + cache the fixed (theme-independent) layers. */
async function getFixedLayers(): Promise<string> {
  if (cachedFixedLayers !== null) return cachedFixedLayers;
  const parts = await Promise.all(
    FIXED_LAYER_FILES(uiDir()).map((p) => readFileText(p)),
  );
  cachedFixedLayers = parts.join("\n");
  return cachedFixedLayers;
}

/**
 * Read + cache the token layer for a theme: the selected theme file plus the
 * task-view fallback (deduped when the selection IS task-view). The token
 * file lives at `ui/themes/{id}.css`.
 */
async function getTokenLayer(themeId: string): Promise<string> {
  const cached = cachedTokenLayers.get(themeId);
  if (cached !== undefined) return cached;

  const ui = uiDir();
  const files =
    themeId === FALLBACK_THEME_ID
      ? [join(ui, "themes", `${FALLBACK_THEME_ID}.css`)]
      : [
          // Fallback FIRST so the selected theme's tokens win on cascade.
          join(ui, "themes", `${FALLBACK_THEME_ID}.css`),
          join(ui, "themes", `${themeId}.css`),
        ];
  const parts = await Promise.all(files.map((p) => readFileText(p)));
  const text = parts.join("\n");
  cachedTokenLayers.set(themeId, text);
  return text;
}

/**
 * Assemble (and cache) the full record-view stylesheet for a theme id, in
 * the fixed order. Token layer → base → record-view → hljs → print.
 * On any read failure: log to stderr + return the safety stylesheet
 * (cached so we don't re-fail every request). Never throws.
 */
async function assembleCss(themeId: string): Promise<string> {
  const cached = cachedAssembled.get(themeId);
  if (cached !== undefined) return cached;

  let css: string;
  try {
    const [tokens, fixed] = await Promise.all([
      getTokenLayer(themeId),
      getFixedLayers(),
    ]);
    css = `${tokens}\n${fixed}`;
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    console.error(`task-view: viewer stylesheet assembly failed: ${message}`);
    css = SAFETY_CSS;
  }
  cachedAssembled.set(themeId, css);
  return css;
}

/**
 * Get the inline stylesheet + `<html>` class for a resolved theme + mode.
 *
 * `mode` only affects `htmlClass` (the ` light` suffix, via the registry's
 * mode-support — SV-7). The token CSS is mode-agnostic: both `.theme-{id}`
 * and `.theme-{id}.light` blocks are inlined, and the `<html>` class decides
 * which applies. So the assembled `css` is cached per theme id alone.
 */
export async function getViewerStyles(
  themeId: string,
  mode: ThemeMode,
): Promise<ViewerStyles> {
  // Re-resolve through the canonical resolver so an unknown id can never
  // reach the token-file path (`themes/<id>.css`) or the htmlClass — it
  // falls back to task-view. Query/cookie precedence is handled upstream;
  // here we just validate the already-chosen id+mode.
  const pref = resolveThemePreference({
    query: new URLSearchParams([
      ["theme", themeId],
      ["mode", mode],
    ]),
  });
  const css = await assembleCss(pref.themeId);
  return { css, htmlClass: pref.htmlClass };
}

/**
 * Test-only: reset every in-process cache so a test can force a re-read
 * (mirrors `_resetClientBundleCacheForTests`, client-bundle.ts:119-122).
 * NOT used by the server runtime.
 */
export function _resetViewerStylesCacheForTests(): void {
  cachedFixedLayers = null;
  cachedTokenLayers.clear();
  cachedAssembled.clear();
}

/**
 * Test-only: point the assembler at a different `packages/ui` directory (or
 * `null` to restore real resolution) to exercise the safety-stylesheet path
 * (SV-53). Call `_resetViewerStylesCacheForTests()` after changing it so the
 * next assembly is cache-cold.
 */
export function _setUiDirOverrideForTests(dir: string | null): void {
  _uiDirOverride = dir;
}
