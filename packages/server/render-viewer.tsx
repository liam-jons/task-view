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
import { decodeBacklogFilters } from "@task-view/ui/record-view/url-state";
import { recordRouteHref } from "@task-view/ui/record-view/anchors";
import type { DetectSchemaResult } from "./detect-schema";
import type {
  Task,
  RoadmapTheme,
  BacklogItem,
} from "@task-view/ui/record-view/types";

export type KnownDetected = Exclude<DetectSchemaResult, { kind: "unknown" }>;

export interface RenderViewerInput {
  detected: KnownDetected;
  search: URLSearchParams;
  /**
   * The progressive-enhancement client bundle JS to inline inside a
   * `<script>` at the end of `<body>` (ID-20.24). Built + cached at
   * server boot by `client-bundle.ts` (Bun.build). When omitted (e.g.
   * pure SSR tests), no script is emitted and the page renders
   * read-only — the SSR markup is fully usable without it.
   */
  clientScript?: string;
}

export interface RenderViewerResult {
  status: 200 | 404;
  html: string;
}

export function renderViewer(input: RenderViewerInput): RenderViewerResult {
  const body = renderBody(input);
  return {
    status: body.status,
    html: wrapHtml(body.markup, input.clientScript),
  };
}

interface RenderedBody {
  status: 200 | 404;
  markup: string;
}

function renderBody({ detected, search }: RenderViewerInput): RenderedBody {
  const recordParam = search.get("record");

  if (detected.kind === "task-list") {
    const tasks = detected.data.tasks;
    if (recordParam === null) {
      return {
        status: 200,
        markup: renderToStaticMarkup(<TaskListIndexView tasks={tasks} />),
      };
    }
    const task = tasks.find((t) => t.id === recordParam);
    if (!task) return renderNotFound("task", recordParam);
    const ledger = buildLedgerContext({ tasks });
    const nav = computeTaskNav(tasks, task);
    return {
      status: 200,
      markup: renderToStaticMarkup(
        <TaskListView task={task} ledger={ledger} nav={nav} />,
      ),
    };
  }

  if (detected.kind === "backlog") {
    const items = detected.data.items;
    if (recordParam === null) {
      const filters = decodeBacklogFilters(search);
      return {
        status: 200,
        markup: renderToStaticMarkup(
          <BacklogIndexView items={items} filters={filters} />,
        ),
      };
    }
    const item = items.find((i) => i.id === recordParam);
    if (!item) return renderNotFound("backlog-item", recordParam);
    const ledger = buildLedgerContext({ backlogItems: items });
    const nav = computeBacklogNav(items, item);
    return {
      status: 200,
      markup: renderToStaticMarkup(
        <BacklogItemView item={item} ledger={ledger} nav={nav} />,
      ),
    };
  }

  // roadmap
  if (recordParam === null) {
    return {
      status: 200,
      markup: renderToStaticMarkup(<RoadmapIndexView roadmap={detected.data} />),
    };
  }
  const ledger = buildLedgerContext({ roadmap: detected.data });
  const themes = detected.data.themes;

  const theme = themes.find((t) => t.id === recordParam);
  if (!theme) return renderNotFound("roadmap-theme", recordParam);
  const nav = computeThemeNav(themes, theme);
  return {
    status: 200,
    markup: renderToStaticMarkup(
      <RoadmapThemeView theme={theme} ledger={ledger} nav={nav} />,
    ),
  };
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

function computeTaskNav(tasks: readonly Task[], current: Task): NavStripData {
  const idx = tasks.findIndex((t) => t.id === current.id);
  const prev = idx > 0 ? tasks[idx - 1] : null;
  const next = idx >= 0 && idx < tasks.length - 1 ? tasks[idx + 1] : null;
  return {
    prevHref: prev ? recordRouteHref(prev.id) : null,
    prevLabel: prev ? `ID-${prev.id}: ${prev.title}` : null,
    nextHref: next ? recordRouteHref(next.id) : null,
    nextLabel: next ? `ID-${next.id}: ${next.title}` : null,
    indexHref: "/",
    indexLabel: "Back to ledger index",
  };
}

function computeBacklogNav(
  items: readonly BacklogItem[],
  current: BacklogItem,
): NavStripData {
  const idx = items.findIndex((i) => i.id === current.id);
  const prev = idx > 0 ? items[idx - 1] : null;
  const next = idx >= 0 && idx < items.length - 1 ? items[idx + 1] : null;
  return {
    prevHref: prev ? recordRouteHref(prev.id) : null,
    prevLabel: prev ? `#${prev.id}: ${prev.description}` : null,
    nextHref: next ? recordRouteHref(next.id) : null,
    nextLabel: next ? `#${next.id}: ${next.description}` : null,
    indexHref: "/",
    indexLabel: "Back to backlog index",
  };
}

function computeThemeNav(
  themes: readonly RoadmapTheme[],
  current: RoadmapTheme,
): NavStripData {
  const idx = themes.findIndex((t) => t.id === current.id);
  const prev = idx > 0 ? themes[idx - 1] : null;
  const next = idx >= 0 && idx < themes.length - 1 ? themes[idx + 1] : null;
  return {
    prevHref: prev ? recordRouteHref(prev.id) : null,
    prevLabel: prev ? `${prev.id}: ${prev.title}` : null,
    nextHref: next ? recordRouteHref(next.id) : null,
    nextLabel: next ? `${next.id}: ${next.title}` : null,
    indexHref: "/",
    indexLabel: "Back to roadmap index",
  };
}

function wrapHtml(body: string, clientScript?: string): string {
  // Inline the progressive-enhancement client at the end of <body> so it
  // runs after the SSR markup is parsed (ID-20.24). The bundle is a
  // self-contained IIFE; we defensively neutralise any literal
  // `</script>` sequence so a future bundle string can never break out of
  // the script element.
  const scriptTag =
    typeof clientScript === "string" && clientScript.length > 0
      ? '<script type="module">' +
        clientScript.replace(/<\/script>/gi, "<\\/script>") +
        "</script>\n"
      : "";
  return (
    "<!doctype html>\n" +
    '<html lang="en">\n' +
    "<head>\n" +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    "<title>task-view</title>\n" +
    "</head>\n" +
    '<body data-app="task-view">\n' +
    body +
    "\n" +
    scriptTag +
    "</body>\n" +
    "</html>\n"
  );
}
