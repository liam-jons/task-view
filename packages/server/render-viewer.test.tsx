/**
 * render-viewer.test.tsx — ID-20.24 script-reference contract for the
 * SSR viewer (pure; no Bun.build).
 *
 * renderViewer optionally references the client bundle via a
 * `<script type="module" src=…>`; when omitted the page is read-only SSR
 * (fully usable without JS). Verifies the script tag lands at the end of
 * <body> after the markup. The bundle itself is served by the patch-server
 * at GET /client.js (see client-bundle.test.ts), not inlined.
 */
import { describe, expect, test } from "bun:test";
import { renderViewer } from "./render-viewer";
import type { KnownDetected } from "./render-viewer";

const BACKLOG_DETECTED: KnownDetected = {
  kind: "backlog",
  data: {
    document_name: "Product Backlog",
    document_purpose: "fixture",
    related_documents: [],
    items: [
      {
        id: "ID-30",
        description: "An item",
        type: "feature",
        status: "ready",
        priority: "high",
        rank: 3,
        track: "platform",
        effort_estimate: "M",
      },
    ],
  },
} as unknown as KnownDetected;

describe("renderViewer — client-script reference (ID-20.24)", () => {
  test("no clientScriptSrc → no <script> emitted (read-only SSR)", () => {
    const { html } = renderViewer({
      detected: BACKLOG_DETECTED,
      search: new URLSearchParams(),
    });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('data-record-kind="backlog-index"');
    expect(html).not.toContain("<script");
  });

  test("clientScriptSrc present → module <script src> at end of body", () => {
    const { html } = renderViewer({
      detected: BACKLOG_DETECTED,
      search: new URLSearchParams(),
      clientScriptSrc: "/client.js",
    });
    // Referenced, not inlined — the bundle is served from its own route.
    expect(html).toContain('<script type="module" src="/client.js"></script>');
    const scriptIdx = html.indexOf("<script");
    const bodyCloseIdx = html.indexOf("</body>");
    const markupIdx = html.indexOf('data-record-kind="backlog-index"');
    // Script sits after the markup but before </body>.
    expect(scriptIdx).toBeGreaterThan(markupIdx);
    expect(scriptIdx).toBeLessThan(bodyCloseIdx);
  });

  test("empty clientScriptSrc string → treated as absent (no script tag)", () => {
    const { html } = renderViewer({
      detected: BACKLOG_DETECTED,
      search: new URLSearchParams(),
      clientScriptSrc: "",
    });
    expect(html).not.toContain("<script");
  });

  test("a record page's back-to-index link carries #record-<id> (page-point restoration)", () => {
    // A record page (not the index) needs the full item shape the record view
    // reads (dependencies, *_refs, …), so use a complete fixture here.
    const detected: KnownDetected = {
      kind: "backlog",
      data: {
        document_name: "Product Backlog",
        document_purpose: "fixture",
        related_documents: [],
        items: [
          {
            id: "ID-30",
            description: "An item",
            type: "feature",
            status: "ready",
            priority: "high",
            rank: 3,
            track: "platform",
            effort_estimate: "M",
            dependencies: [],
            session_refs: [],
            commit_refs: [],
            cross_doc_links: [],
            notes: null,
          },
        ],
      },
    } as unknown as KnownDetected;
    const { html } = renderViewer({
      detected,
      search: new URLSearchParams("record=ID-30"),
    });
    // The nav-strip "Back to … index" link returns to the row just viewed,
    // so the browser scrolls the index back to that record on return.
    expect(html).toContain('href="/#record-ID-30"');
  });
});

// ── record-view-styling: <style> + <html> class (SV-50, SV-51) ──────────────

const TASK_LIST_DETECTED: KnownDetected = {
  kind: "task-list",
  data: {
    document_name: "Task List",
    document_purpose: "fixture",
    related_documents: [],
    tasks: [],
  },
} as unknown as KnownDetected;

const ROADMAP_DETECTED: KnownDetected = {
  kind: "roadmap",
  data: {
    document_name: "Product Roadmap",
    document_purpose: "fixture",
    related_documents: [],
    forward_looking_only: true,
    themes: [],
  },
} as unknown as KnownDetected;

describe("renderViewer — inline <style> presence + placement (SV-50)", () => {
  test("exactly one <style> in <head>, before the body markup", () => {
    const { html } = renderViewer({
      detected: BACKLOG_DETECTED,
      search: new URLSearchParams(),
    });
    expect(html.match(/<style>/g)?.length).toBe(1);
    const styleIdx = html.indexOf("<style>");
    const headCloseIdx = html.indexOf("</head>");
    const markupIdx = html.indexOf('data-record-kind="backlog-index"');
    expect(styleIdx).toBeGreaterThan(-1);
    expect(styleIdx).toBeLessThan(headCloseIdx); // inside <head>
    expect(styleIdx).toBeLessThan(markupIdx); // before body markup
  });

  test("the fallback stylesheet carries each layer's sentinel", () => {
    // The pure-SSR path (no `styles` threaded) emits the hermetic fallback,
    // which still carries a token rule, a base rule, and a record-view rule.
    const { html } = renderViewer({
      detected: BACKLOG_DETECTED,
      search: new URLSearchParams(),
    });
    expect(html).toContain("--background"); // token layer
    expect(html).toContain(":focus-visible"); // base layer
    expect(html).toContain(".record-view-frontmatter-card"); // record-view layer
  });

  test("a real assembled stylesheet inlines verbatim with sentinels", () => {
    const css =
      ".theme-task-view{--background:#000}\n" +
      ":focus-visible{outline:2px solid var(--ring)}\n" +
      ".record-view-frontmatter-card{border-collapse:collapse}";
    const { html } = renderViewer({
      detected: BACKLOG_DETECTED,
      search: new URLSearchParams(),
      styles: { css, htmlClass: "theme-task-view" },
    });
    expect(html).toContain("<style>" + css.split("\n")[0]);
    expect(html).toContain(":focus-visible");
    expect(html).toContain(".record-view-frontmatter-card");
  });

  test("</style> inside the CSS is neutralised (no breakout)", () => {
    const { html } = renderViewer({
      detected: BACKLOG_DETECTED,
      search: new URLSearchParams(),
      styles: {
        css: 'a::before{content:"</style>"}',
        htmlClass: "theme-task-view",
      },
    });
    expect(html).toContain("<\\/style>");
    // The only real </style> is the wrapper's own.
    expect(html.match(/<\/style>/g)?.length).toBe(1);
  });

  test("every page root selector is present in the assembled stylesheet", () => {
    // Render with the full hermetic fallback replaced by a sheet containing
    // each root selector — proves the contract the real assembler satisfies.
    // (The real coverage guard over record-view.css lives in
    // record-view-css.test.ts / SV-54.)
    const roots = [
      ".record-view-task-list-index",
      ".record-view-roadmap-index",
      ".record-view-backlog-index",
      ".record-view-task-page",
      ".record-view-backlog-item",
      ".record-view-roadmap-theme",
      ".record-view-not-found",
    ];
    const css = roots.map((r) => `${r}{display:block}`).join("\n");
    const { html } = renderViewer({
      detected: BACKLOG_DETECTED,
      search: new URLSearchParams(),
      styles: { css, htmlClass: "theme-task-view" },
    });
    for (const r of roots) expect(html).toContain(r);
  });
});

describe("renderViewer — <html> theme class (SV-51)", () => {
  test("default (no styles) → <html lang=\"en\" class=\"theme-task-view\">", () => {
    for (const detected of [
      BACKLOG_DETECTED,
      TASK_LIST_DETECTED,
      ROADMAP_DETECTED,
    ]) {
      const { html } = renderViewer({
        detected,
        search: new URLSearchParams(),
      });
      expect(html).toContain('<html lang="en" class="theme-task-view">');
    }
  });

  test("explicit github+light styles → class=\"theme-github light\"", () => {
    const { html } = renderViewer({
      detected: BACKLOG_DETECTED,
      search: new URLSearchParams(),
      styles: { css: ".theme-github{}", htmlClass: "theme-github light" },
    });
    expect(html).toContain('<html lang="en" class="theme-github light">');
  });

  test("404 not-found route is also themed + styled", () => {
    const { status, html } = renderViewer({
      detected: BACKLOG_DETECTED,
      search: new URLSearchParams("record=does-not-exist"),
    });
    expect(status).toBe(404);
    expect(html).toContain('class="theme-task-view"');
    expect(html).toContain("<style>");
    expect(html).toContain('data-record-kind="not-found"');
  });
});

// ── {20.29} cross-ledger read-only render (SPEC §5 slice 6) ─────────────────

const ROADMAP_WITH_THEME: KnownDetected = {
  kind: "roadmap",
  data: {
    document_name: "Knowledge Hub Roadmap",
    document_purpose: "fixture",
    date: "2026-05-21",
    status: "Active",
    forward_looking_only: true,
    related_documents: [],
    last_updated: "fixture",
    themes: [
      {
        id: "10",
        title: "Procurement intelligence",
        description: "Theme 10 description.",
        time_horizon: "now",
        status: "in_progress",
        linked_tasks: ["6"],
        linked_backlog: ["45"],
        session_refs: [],
        commit_refs: [],
        cross_doc_links: [],
        notes: null,
      },
    ],
  },
} as unknown as KnownDetected;

const TASK_LIST_WITH_TASK: KnownDetected = {
  kind: "task-list",
  data: {
    document_name: "Knowledge Hub Task List",
    document_purpose: "fixture",
    related_documents: [],
    tasks: [
      {
        id: "6",
        title: "Procurement task",
        description: "Task 6 description.",
        status: "in_progress",
        priority: "must",
        dependencies: [],
        subtasks: [],
        updatedAt: "2026-05-21T15:30:00.000Z",
        effort_estimate: null,
        owner: null,
        priority_note: null,
        status_note: null,
        cross_doc_links: [],
        session_refs: [],
        commit_refs: [],
        capability_theme: "10",
      },
    ],
  },
} as unknown as KnownDetected;

describe("renderViewer — sibling render is editable (editable-ledger-switch §3)", () => {
  test("a switched-to sibling renders edit affordances (read-only model removed)", () => {
    const { status, html } = renderViewer({
      detected: TASK_LIST_WITH_TASK,
      search: new URLSearchParams("record=6"),
    });
    expect(status).toBe(200);
    expect(html).toContain('data-record-kind="task"');
    expect(html).toContain('data-record-id="6"');
    expect(html).toContain("Procurement task");
    // Every page is editable now — pencils + dispatcher hooks present.
    expect(html).toContain("data-edit-action");
    expect(html).toContain("data-edit-field");
  });

  test("a sibling roadmap theme resolves linked_tasks against sibling ids", () => {
    // Sibling task-list (id 6) + backlog (id 45) threaded → live cross-ledger
    // links, NOT (missing).
    const { status, html } = renderViewer({
      detected: ROADMAP_WITH_THEME,
      search: new URLSearchParams("record=10"),
      siblings: {
        tasks: (TASK_LIST_WITH_TASK as { data: { tasks: unknown[] } }).data
          .tasks as never,
        backlogItems: [{ id: "45" } as never],
      },
    });
    expect(status).toBe(200);
    expect(html).toContain('data-record-kind="roadmap-theme"');
    expect(html).toContain('href="/?ledger=task-list&amp;record=6"');
    expect(html).toContain('data-cross-ledger="task-list"');
    expect(html).toContain('href="/?ledger=backlog&amp;record=45"');
    expect(html).not.toContain("(missing)");
  });

  test("missing record id in a sibling → 404 not-found body", () => {
    const { status, html } = renderViewer({
      detected: ROADMAP_WITH_THEME,
      search: new URLSearchParams("record=999"),
    });
    expect(status).toBe(404);
    expect(html).toContain('data-record-kind="not-found"');
  });

  test("no page mounts a read-only ledger banner (banner removed)", () => {
    const { html } = renderViewer({
      detected: TASK_LIST_WITH_TASK,
      search: new URLSearchParams("record=6"),
    });
    expect(html).not.toContain("data-ledger-banner");
  });
});

// ── {20.30} reverse cross-ledger backlinks through renderViewer ─────────────

const BACKLOG_WITH_ITEM: KnownDetected = {
  kind: "backlog",
  data: {
    document_name: "Product Backlog",
    document_purpose: "fixture",
    related_documents: [],
    items: [
      {
        id: "45",
        description: "A backlog item linked from theme 10.",
        type: "feature",
        status: "ready",
        effort_estimate: null,
        priority: "high",
        track: "procurement",
        dependencies: [],
        session_refs: [],
        commit_refs: [],
        cross_doc_links: [],
        notes: null,
      },
    ],
  },
} as unknown as KnownDetected;

describe("renderViewer — reverse appears-in-themes backlinks ({20.30})", () => {
  test("a backlog item resolves its appears-in-themes backlink from the roadmap sibling", () => {
    // Roadmap theme 10 links backlog 45 (forward). The backlog page has no
    // pointer field of its own — the reverse index threaded via the roadmap
    // sibling is what produces the backlink.
    const { status, html } = renderViewer({
      detected: BACKLOG_WITH_ITEM,
      search: new URLSearchParams("record=45"),
      siblings: {
        roadmap: (ROADMAP_WITH_THEME as { data: unknown }).data as never,
      },
    });
    expect(status).toBe(200);
    expect(html).toContain('data-record-kind="backlog-item"');
    expect(html).toContain('data-frontmatter-row="appears_in_themes"');
    expect(html).toContain('href="/?ledger=roadmap&amp;record=10"');
    expect(html).toContain('data-cross-ledger="roadmap"');
    expect(html).toContain("theme 10: Procurement intelligence");
  });

  test("a backlog page WITHOUT a roadmap sibling shows no backlink row", () => {
    const { html } = renderViewer({
      detected: BACKLOG_WITH_ITEM,
      search: new URLSearchParams("record=45"),
    });
    expect(html).not.toContain('data-frontmatter-row="appears_in_themes"');
  });

  test("a task resolves its appears-in-themes backlink from the roadmap sibling", () => {
    // Theme 10's linked_tasks include task 6 → reverse backlink on task 6.
    const { html } = renderViewer({
      detected: TASK_LIST_WITH_TASK,
      search: new URLSearchParams("record=6"),
      siblings: {
        roadmap: (ROADMAP_WITH_THEME as { data: unknown }).data as never,
      },
    });
    expect(html).toContain('data-frontmatter-row="appears_in_themes"');
    expect(html).toContain('href="/?ledger=roadmap&amp;record=10"');
  });
});

describe("renderViewer — in-page theme picker (OQ-3)", () => {
  test("renders a server-side <select data-theme-picker> pre-selected to the active theme", () => {
    const { html } = renderViewer({
      detected: BACKLOG_DETECTED,
      search: new URLSearchParams(),
      styles: { css: ".theme-github{}", htmlClass: "theme-github light" },
    });
    expect(html).toContain("data-record-view-toolbar");
    expect(html).toContain("data-theme-picker");
    // defaultValue → React renders `selected` on the matching <option>.
    expect(html).toContain('value="github" selected');
  });

  test("picker is present on every surface incl. the default (no-styles) page", () => {
    const { html } = renderViewer({
      detected: TASK_LIST_DETECTED,
      search: new URLSearchParams(),
    });
    expect(html).toContain("data-theme-picker");
    expect(html).toContain('value="task-view" selected');
  });
});

// ── editable-ledger-switch: ledger switcher mount (SPEC §5 slice 2) ──────────

describe("renderViewer — ledger switcher (editable-ledger-switch SPEC §5 slice 2)", () => {
  test("mounts the switcher when availableLedgers + activeSlug are threaded in", () => {
    const { html } = renderViewer({
      detected: BACKLOG_DETECTED,
      search: new URLSearchParams(),
      availableLedgers: ["task-list", "roadmap", "backlog"],
      activeSlug: "backlog",
    });
    expect(html).toContain("data-ledger-switcher");
    expect(html).toContain('data-active-ledger="backlog"');
    // Editable switch targets for the siblings.
    expect(html).toContain('href="/?ledger=task-list"');
    expect(html).toContain('href="/?ledger=roadmap"');
  });

  test("no switcher when availableLedgers is absent (pure-SSR unit path)", () => {
    const { html } = renderViewer({
      detected: BACKLOG_DETECTED,
      search: new URLSearchParams(),
    });
    expect(html).not.toContain("data-ledger-switcher");
  });

  test("the switcher sits before the record body", () => {
    const { html } = renderViewer({
      detected: BACKLOG_DETECTED,
      search: new URLSearchParams(),
      availableLedgers: ["backlog"],
      activeSlug: "backlog",
    });
    const switcherIdx = html.indexOf("data-ledger-switcher");
    const bodyIdx = html.indexOf('data-record-kind="backlog-index"');
    expect(switcherIdx).toBeGreaterThan(-1);
    expect(switcherIdx).toBeLessThan(bodyIdx);
  });
});
