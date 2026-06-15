/**
 * render-viewer.tsx — SSR entry point for the per-record viewer (Subtask 20.17).
 *
 * Closes the SPA wiring gap surfaced by the S66 manual smoke-test plan:
 * the patch-server previously served only JSON; GET / 404'd. This module
 * renders the existing read-mode record-view components to static HTML so
 * the loopback server can serve a viewer surface against any of the three
 * ledger shapes (task-list / roadmap / backlog).
 *
 * Routing:
 *   - GET /?record=                         → index view for the ledger kind
 *   - GET /?record=ID-N                     → per-Task / per-Backlog-item page
 *   - GET /?record=<theme-id>               → per-Roadmap-theme page
 *
 * Roadmap shape note (ID-20.19): the Phase-B themes[] roadmap replaced the
 * retired sections[]/items[] model. A roadmap record is a theme keyed by
 * its bare-digit id; the old `section-` prefix routing is gone.
 *
 * Backlog mode honours PRODUCT inv 23 — `?track=…&status=…&priority=…`
 * query-string filter state is decoded via the canonical
 * `decodeBacklogFilters` helper and threaded into `BacklogIndexView`.
 *
 * Scope:
 *   - SSR only — pure read-mode markup. Pencil-edit interactivity needs a
 *     client hydration layer; that lands in a follow-on Subtask alongside
 *     the existing edit-affordance test coverage (PRODUCT inv 26–35).
 *     The SSR HTML still carries every `data-*` hook those components emit
 *     so the eventual hydration layer can attach without a re-render.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskListIndexView } from "@task-view/ui/record-view/task-list-index-view";
import { TaskListView } from "@task-view/ui/record-view/task-list-view";
import { BacklogIndexView } from "@task-view/ui/record-view/backlog-index-view";
import { BacklogItemView } from "@task-view/ui/record-view/backlog-item-view";
import { RoadmapIndexView } from "@task-view/ui/record-view/roadmap-index-view";
import { RoadmapThemeView } from "@task-view/ui/record-view/roadmap-theme-view";
import {
  buildLedgerContext,
  type NavStripData,
} from "@task-view/ui/record-view/types";
import {
  decodeBacklogFilters,
  decodeLedgerParam,
  decodeRoadmapFilters,
  decodeSort,
  decodeTaskListFilters,
} from "@task-view/ui/record-view/url-state";
import {
  activeRecordHref,
  indexHrefWithAnchor,
} from "@task-view/ui/record-view/anchors";
import { ThemePicker } from "@task-view/ui/record-view/theme-picker";
import { LedgerSwitcher } from "@task-view/ui/record-view/ledger-switcher";
import type { LedgerSlug } from "@task-view/ui/record-view/anchors";
import type { DetectSchemaResult } from "./detect-schema";
import type { Roadmap } from "@task-view/schemas/roadmap";
import type {
  Task,
  RoadmapTheme,
  BacklogItem,
} from "@task-view/ui/record-view/types";

// ID-90 U8: the viewer renders the three MIRRORED kinds only — umbrellas
// documents have no record-view surface (PRODUCT invariant 53); callers
// guard the umbrellas kind before invoking renderViewer. WS-C C2: retros have
// no viewer surface yet either — callers (patch-server) guard the retro kind
// before invoking renderViewer, identically to umbrellas.
export type KnownDetected = Exclude<
  DetectSchemaResult,
  { kind: "unknown" | "umbrellas" | "retro" }
>;

export interface RenderViewerInput {
  detected: KnownDetected;
  search: URLSearchParams;
  /**
   * URL the progressive-enhancement client bundle is served from (e.g.
   * `/client.js`). Emitted as `<script type="module" src=…>` at the end
   * of `<body>` (ID-20.24). The patch-server serves the bundle as a
   * separate, cacheable resource rather than inlining it, so the ~1MB JS
   * is fetched once and revalidated (304) instead of re-shipped inside
   * every page's HTML. When omitted (pure-SSR tests), no script is
   * emitted and the page renders read-only — the SSR markup is fully
   * usable without it.
   */
  clientScriptSrc?: string;
  /**
   * Pre-resolved record-view stylesheet + `<html>` theme class
   * (record-view-styling SPEC SV-2/SV-3). Assembled by
   * `viewer-styles.ts#getViewerStyles` (async, cached at boot) and threaded
   * in by `handleGetRoot`, which reads the theme cookie/query first.
   *
   * `renderViewer` is synchronous, so the async assembly happens upstream
   * and the result is passed here. When omitted (pure-SSR unit tests), a
   * tiny hermetic fallback stylesheet + the default `theme-task-view` class
   * are emitted so EVERY route is still styled (SV-3) without a disk read.
   */
  styles?: ViewerStylesInput;
  /**
   * {20.29}: parsed SIBLING ledger records threaded in so outbound
   * cross-ledger links on the CURRENT page can compute `exists` against the
   * sibling id sets (SPEC §4 approach A). For a roadmap theme page these
   * carry the task-list + backlog siblings; for a Task page the roadmap
   * sibling (so the capability_theme chip resolves a title). Omitted on the
   * launched-ledger path → empty sibling sets → cross-ledger links render as
   * broken-target until the sibling resolves.
   */
  siblings?: SiblingLedgers;
  /**
   * editable-ledger-switch §2: the viewer-renderable ledger slugs present in
   * the launch directory. Threaded in by `handleGetRoot` (from
   * `scanForLedgers`) to render the editable ledger switcher on every page.
   * Omitted by pure-SSR unit callers → no switcher mounted.
   */
  availableLedgers?: readonly LedgerSlug[];
  /**
   * editable-ledger-switch §2: the slug of the ACTIVE (currently-rendered)
   * ledger — the launched ledger on the bare path, or the `?ledger=` target on
   * a switch. Marks the active entry in the switcher.
   */
  activeSlug?: LedgerSlug;
}

/** Parsed sibling-ledger records for cross-ledger `exists` resolution. */
export interface SiblingLedgers {
  tasks?: readonly Task[];
  roadmap?: Roadmap;
  backlogItems?: readonly BacklogItem[];
}

/** Shape of the resolved styling injected into `wrapHtml` (SV-2/SV-3). */
export interface ViewerStylesInput {
  /** Full stylesheet text inlined into a single `<style>` in `<head>`. */
  css: string;
  /** The `theme-{id}[ light]` class for the served `<html>`. */
  htmlClass: string;
}

export interface RenderViewerResult {
  status: 200 | 404;
  html: string;
}

export function renderViewer(input: RenderViewerInput): RenderViewerResult {
  const body = renderBody(input);
  // editable-ledger-switch §2: mount the editable ledger switcher on every
  // page when the launch-directory registry is threaded in (handleGetRoot
  // supplies it; pure-SSR unit callers omit it → no switcher mounted).
  const switcherMarkup =
    input.availableLedgers &&
    input.availableLedgers.length > 0 &&
    input.activeSlug !== undefined
      ? renderToStaticMarkup(
          <LedgerSwitcher
            available={input.availableLedgers}
            active={input.activeSlug}
          />,
        )
      : "";
  return {
    status: body.status,
    html: wrapHtml(
      switcherMarkup + body.markup,
      input.clientScriptSrc,
      input.styles,
    ),
  };
}

/**
 * Render a record body to static markup. Every page is editable since the
 * read-only-sibling model was removed (editable-ledger-switch §3) — the slug
 * write seam makes any switched-to sibling a first-class mutation target.
 */
function renderRecordMarkup(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

/**
 * Hermetic fallback styling for pure-SSR callers (unit tests) that don't
 * thread real assembled styles in. Keeps every route styled (SV-3) and the
 * `<html>` themed (default `task-view` dark) without a disk read. This is a
 * deliberately tiny token + base sheet — production always passes the full
 * assembled stylesheet from `getViewerStyles`.
 */
const FALLBACK_STYLES: ViewerStylesInput = {
  htmlClass: "theme-task-view",
  css:
    ".theme-task-view{--background:#16161f;--foreground:#e6e6ef;--card:#1f1f2b;" +
    "--muted:#262633;--muted-foreground:#b7b7c6;--primary:#a78bfa;--border:#3a3a4a;" +
    "--ring:#a78bfa;--radius:0.625rem;--font-sans:system-ui,sans-serif;--code-bg:#262633}" +
    "body{background:var(--background);color:var(--foreground);font-family:var(--font-sans)}" +
    ":focus-visible{outline:2px solid var(--ring);outline-offset:2px}" +
    ".record-view-frontmatter-card{border-collapse:collapse}",
};

interface RenderedBody {
  status: 200 | 404;
  markup: string;
}

function renderBody({
  detected,
  search,
  siblings,
}: RenderViewerInput): RenderedBody {
  const recordParam = search.get("record");
  // editable-ledger-switch fix: preserve the page's active `?ledger=<slug>` on
  // every intra-ledger nav link (index rows, dep links, prev/next/back) so a
  // switched-to sibling doesn't silently fall back to the launched ledger.
  // `null` on the launched path (no `?ledger=`) → bare back-compat hrefs.
  const activeSlug = decodeLedgerParam(search);

  if (detected.kind === "task-list") {
    const tasks = detected.data.tasks;
    if (recordParam === null) {
      const filters = decodeTaskListFilters(search);
      const sort = decodeSort(search);
      return {
        status: 200,
        markup: renderRecordMarkup(
          <TaskListIndexView
            tasks={tasks}
            filters={filters}
            sort={sort}
            activeSlug={activeSlug}
          />,
        ),
      };
    }
    const task = tasks.find((t) => t.id === recordParam);
    if (!task) return renderNotFound("task", recordParam);
    // {20.29}: thread the sibling roadmap so the capability_theme chip
    // resolves a title (SPEC §6).
    const ledger = buildLedgerContext({ tasks, roadmap: siblings?.roadmap });
    const nav = computeTaskNav(tasks, task, activeSlug);
    return {
      status: 200,
      markup: renderRecordMarkup(
        <TaskListView
          task={task}
          ledger={ledger}
          nav={nav}
          activeSlug={activeSlug}
        />,
      ),
    };
  }

  if (detected.kind === "backlog") {
    const items = detected.data.items;
    if (recordParam === null) {
      const filters = decodeBacklogFilters(search);
      return {
        status: 200,
        markup: renderRecordMarkup(
          <BacklogIndexView
            items={items}
            filters={filters}
            activeSlug={activeSlug}
          />,
        ),
      };
    }
    const item = items.find((i) => i.id === recordParam);
    if (!item) return renderNotFound("backlog-item", recordParam);
    // {20.30}: thread the sibling roadmap so the backlog item's reverse
    // "Appears in themes" backlinks resolve (the inverse index is built from
    // the roadmap's linked_backlog forward edges). Backlog carries no roadmap
    // pointer field, so without this sibling the page has no path to roadmap.
    const ledger = buildLedgerContext({
      backlogItems: items,
      roadmap: siblings?.roadmap,
    });
    const nav = computeBacklogNav(items, item, activeSlug);
    return {
      status: 200,
      markup: renderRecordMarkup(
        <BacklogItemView
          item={item}
          ledger={ledger}
          nav={nav}
          activeSlug={activeSlug}
        />,
      ),
    };
  }

  // roadmap
  if (recordParam === null) {
    const filters = decodeRoadmapFilters(search);
    const sort = decodeSort(search);
    return {
      status: 200,
      markup: renderRecordMarkup(
        <RoadmapIndexView
          roadmap={detected.data}
          filters={filters}
          sort={sort}
          activeSlug={activeSlug}
        />,
      ),
    };
  }
  // {20.29}: thread the sibling task-list + backlog id sets so the theme's
  // outbound linked_tasks / linked_backlog cross-ledger links compute
  // `exists` correctly (SPEC §4 approach A) instead of always (missing).
  const ledger = buildLedgerContext({
    roadmap: detected.data,
    tasks: siblings?.tasks,
    backlogItems: siblings?.backlogItems,
  });
  const themes = detected.data.themes;

  const theme = themes.find((t) => t.id === recordParam);
  if (!theme) return renderNotFound("roadmap-theme", recordParam);
  const nav = computeThemeNav(themes, theme, activeSlug);
  return {
    status: 200,
    markup: renderRecordMarkup(
      <RoadmapThemeView theme={theme} ledger={ledger} nav={nav} />,
    ),
  };
}

/**
 * {20.29}: full-page 404 for an absent / broken sibling ledger (SPEC §5
 * step 2/3). A linked ledger that is not present in the launch directory is
 * a navigation dead-end — render a styled page (so it is themed like every
 * other route) with a "back to launched ledger" link. The slug is a
 * validated nav slug, safe to interpolate.
 */
export function renderSiblingNotAvailable(
  slug: string,
  styles?: ViewerStylesInput,
): RenderViewerResult {
  const markup = renderToStaticMarkup(
    <article
      className="record-view-not-found"
      data-record-kind="ledger-not-available"
      data-ledger-slug={slug}
    >
      <h1>Linked ledger not available</h1>
      <p>
        The <code>{slug}</code> ledger is not present alongside the launched
        ledger, so this cross-ledger link cannot be followed.{" "}
        <a href="/">Back to launched ledger</a>
      </p>
    </article>,
  );
  return { status: 404, html: wrapHtml(markup, undefined, styles) };
}

function renderNotFound(kind: string, requested: string): RenderedBody {
  const markup = renderToStaticMarkup(
    <article className="record-view-not-found" data-record-kind="not-found">
      <h1>Record not found</h1>
      <p>
        No {kind} record matches <code>{requested}</code> in the active ledger.
        <a href="/">Back to index</a>
      </p>
    </article>,
  );
  return { status: 404, markup };
}

function computeTaskNav(
  tasks: readonly Task[],
  current: Task,
  activeSlug?: LedgerSlug | null,
): NavStripData {
  const idx = tasks.findIndex((t) => t.id === current.id);
  const prev = idx > 0 ? tasks[idx - 1] : null;
  const next = idx >= 0 && idx < tasks.length - 1 ? tasks[idx + 1] : null;
  return {
    prevHref: prev ? activeRecordHref(prev.id, activeSlug) : null,
    prevLabel: prev ? `ID-${prev.id}: ${prev.title}` : null,
    nextHref: next ? activeRecordHref(next.id, activeSlug) : null,
    nextLabel: next ? `ID-${next.id}: ${next.title}` : null,
    indexHref: indexHrefWithAnchor(
      current.id,
      activeSlug ? `ledger=${activeSlug}` : undefined,
    ),
    indexLabel: "Back to ledger index",
  };
}

function computeBacklogNav(
  items: readonly BacklogItem[],
  current: BacklogItem,
  activeSlug?: LedgerSlug | null,
): NavStripData {
  const idx = items.findIndex((i) => i.id === current.id);
  const prev = idx > 0 ? items[idx - 1] : null;
  const next = idx >= 0 && idx < items.length - 1 ? items[idx + 1] : null;
  return {
    prevHref: prev ? activeRecordHref(prev.id, activeSlug) : null,
    prevLabel: prev ? `#${prev.id}: ${prev.description}` : null,
    nextHref: next ? activeRecordHref(next.id, activeSlug) : null,
    nextLabel: next ? `#${next.id}: ${next.description}` : null,
    indexHref: indexHrefWithAnchor(
      current.id,
      activeSlug ? `ledger=${activeSlug}` : undefined,
    ),
    indexLabel: "Back to backlog index",
  };
}

function computeThemeNav(
  themes: readonly RoadmapTheme[],
  current: RoadmapTheme,
  activeSlug?: LedgerSlug | null,
): NavStripData {
  const idx = themes.findIndex((t) => t.id === current.id);
  const prev = idx > 0 ? themes[idx - 1] : null;
  const next = idx >= 0 && idx < themes.length - 1 ? themes[idx + 1] : null;
  return {
    prevHref: prev ? activeRecordHref(prev.id, activeSlug) : null,
    prevLabel: prev ? `${prev.id}: ${prev.title}` : null,
    nextHref: next ? activeRecordHref(next.id, activeSlug) : null,
    nextLabel: next ? `${next.id}: ${next.title}` : null,
    indexHref: indexHrefWithAnchor(
      current.id,
      activeSlug ? `ledger=${activeSlug}` : undefined,
    ),
    indexLabel: "Back to roadmap index",
  };
}

function wrapHtml(
  body: string,
  clientScriptSrc?: string,
  styles?: ViewerStylesInput,
): string {
  // Reference the progressive-enhancement client at the end of <body> so it
  // runs after the SSR markup is parsed (ID-20.24). The bundle is served by
  // the patch-server as a separate cacheable resource (GET /client.js) and
  // referenced by src rather than inlined — the ~1MB minified IIFE is then
  // fetched once + revalidated (304) instead of re-shipped in every page.
  // `clientScriptSrc` is a server-controlled constant, so there is no
  // injection surface to neutralise.
  const scriptTag =
    typeof clientScriptSrc === "string" && clientScriptSrc.length > 0
      ? `<script type="module" src="${clientScriptSrc}"></script>\n`
      : "";

  // Inline the record-view stylesheet into a single <style> in <head>
  // (record-view-styling SPEC SV-3) and bake the resolved theme class onto
  // the served <html> (SV-2) — no ThemeProvider runs on this surface, so the
  // class must be a server-side string. Defensively neutralise any literal
  // `</style>` in the assembled CSS the same way the script guards
  // `</script>`, so authored CSS can never break out of the element (the
  // only real `</style>` is the one we emit — SV-50). When no styles are
  // threaded in (pure-SSR tests), fall back to a tiny hermetic sheet so
  // every route is still themed.
  const resolved = styles ?? FALLBACK_STYLES;
  const styleTag =
    "<style>" + resolved.css.replace(/<\/style>/gi, "<\\/style>") + "</style>\n";
  // The <html> class is built from validated theme ids only (the resolver +
  // assembler guarantee this), so it is safe to interpolate directly.
  const htmlClassAttr = ` class="${resolved.htmlClass}"`;

  // OQ-3 — in-page theme picker. Derive the active theme id from the resolved
  // <html> class (`theme-{id}[ light]`) and render the server-side <select>
  // into a small top toolbar; the inlined dispatcher wires its change to the
  // cookie + a live <html> re-class. Rendered once here so every surface
  // (index + per-record + 404) carries it without per-component prop threading.
  const activeThemeId = resolved.htmlClass
    .replace(/(^|\s)light(\s|$)/g, " ")
    .trim()
    .replace(/^theme-/, "");
  const toolbar =
    '<div class="record-view-toolbar" data-record-view-toolbar>' +
    renderToStaticMarkup(<ThemePicker activeThemeId={activeThemeId} />) +
    "</div>\n";

  return (
    "<!doctype html>\n" +
    '<html lang="en"' +
    htmlClassAttr +
    ">\n" +
    "<head>\n" +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    "<title>task-view</title>\n" +
    styleTag +
    "</head>\n" +
    '<body data-app="task-view">\n' +
    toolbar +
    body +
    "\n" +
    scriptTag +
    "</body>\n" +
    "</html>\n"
  );
}
