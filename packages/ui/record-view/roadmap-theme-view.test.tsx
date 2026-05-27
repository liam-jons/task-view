/**
 * roadmap-theme-view.test.tsx — verifies Roadmap theme page rendering
 * (Phase-B themes[] roadmap — ID-20.19). Replaces the retired
 * roadmap-section-view.test.tsx + roadmap-item-view.test.tsx pair.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Roadmap, RoadmapTheme } from "@task-view/schemas/roadmap";
import type { Task } from "@task-view/schemas/task-list";
import type { BacklogItem } from "@task-view/schemas/backlog";
import { buildLedgerContext, type NavStripData } from "./types";
import { RoadmapThemeView } from "./roadmap-theme-view";

const NAV: NavStripData = {
  prevHref: null,
  prevLabel: null,
  nextHref: null,
  nextLabel: null,
  indexHref: "/",
  indexLabel: "Back to ledger index",
};

const mkTheme = (overrides: Partial<RoadmapTheme> = {}): RoadmapTheme => ({
  id: "1",
  title: "Theme 1",
  description: "Theme 1 description.",
  time_horizon: "now",
  status: "in_progress",
  linked_tasks: [],
  linked_backlog: [],
  session_refs: [],
  commit_refs: [],
  cross_doc_links: [],
  notes: null,
  ...overrides,
});

const mkRoadmap = (themes: RoadmapTheme[]): Roadmap => ({
  document_name: "Knowledge Hub Roadmap",
  document_purpose: "Forward-looking roadmap.",
  date: "2026-05-21",
  status: "Active",
  forward_looking_only: true,
  related_documents: [],
  last_updated: "kh-prod-readiness-S63 fixture",
  themes,
});

const mkTask = (id: string): Task => ({
  id,
  title: `Task ${id}`,
  description: "d",
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
});

const mkBacklogItem = (id: string): BacklogItem => ({
  id,
  description: `Backlog ${id}`,
  type: "feature",
  status: "blocked",
  effort_estimate: null,
  priority: "high",
  track: "Bid",
  dependencies: [],
  session_refs: [],
  commit_refs: [],
  cross_doc_links: [],
  notes: null,
});

describe("RoadmapThemeView — core surfaces", () => {
  test("renders title + description + time_horizon + status frontmatter", () => {
    const theme = mkTheme();
    const ledger = buildLedgerContext({ roadmap: mkRoadmap([theme]) });
    const html = renderToStaticMarkup(
      <RoadmapThemeView theme={theme} ledger={ledger} nav={NAV} />,
    );
    // ID-20.25: title split into a .record-view-field-value span + a
    // text-kind pencil so the dispatcher reads the title cleanly.
    expect(html).toContain("1: ");
    expect(html).toContain(
      '<span class="record-view-field-value">Theme 1</span>',
    );
    expect(html).toContain("Theme 1 description");
    expect(html).toContain('data-frontmatter-row="id"');
    expect(html).toContain('data-frontmatter-row="time_horizon"');
    expect(html).toContain('data-frontmatter-row="status"');
    // Status enum affordance (inv 31): theme status is the 3-value enum.
    expect(html).toContain('data-edit-field="themes&gt;1&gt;status"');
    expect(html).toContain('data-edit-kind="enum"');
    expect(html).toContain('data-edit-options="pending,in_progress,done"');
    // Title + description affordances.
    expect(html).toContain('data-edit-field="themes&gt;1&gt;title"');
    expect(html).toContain('data-edit-field="themes&gt;1&gt;description"');
  });

  test("notes section carries a textarea-kind pencil with raw source (ID-20.25)", () => {
    const theme = mkTheme({ notes: "## Notes\n\nRaw markdown." });
    const ledger = buildLedgerContext({ roadmap: mkRoadmap([theme]) });
    const html = renderToStaticMarkup(
      <RoadmapThemeView theme={theme} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('data-edit-field="themes&gt;1&gt;notes"');
    expect(html).toContain('data-edit-kind="textarea"');
    expect(html).toContain("## Notes");
  });

  test("renders linked_tasks as live CROSS-LEDGER links when present in ledger", () => {
    // {20.29}: linked_tasks now route to the task-list sibling ledger via
    // /?ledger=task-list&record=<id> and carry data-cross-ledger.
    const theme = mkTheme({ linked_tasks: ["20", "21"] });
    const ledger = buildLedgerContext({
      roadmap: mkRoadmap([theme]),
      tasks: [mkTask("20"), mkTask("21")],
    });
    const html = renderToStaticMarkup(
      <RoadmapThemeView theme={theme} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('data-section="linked_tasks"');
    expect(html).toContain('href="/?ledger=task-list&amp;record=20"');
    expect(html).toContain('href="/?ledger=task-list&amp;record=21"');
    expect(html).toContain('data-cross-ledger="task-list"');
    expect(html).not.toContain("(missing)");
  });

  test("renders a missing linked_task with broken-target treatment", () => {
    const theme = mkTheme({ linked_tasks: ["99"] });
    const ledger = buildLedgerContext({
      roadmap: mkRoadmap([theme]),
      tasks: [],
    });
    const html = renderToStaticMarkup(
      <RoadmapThemeView theme={theme} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('data-section="linked_tasks"');
    expect(html).toContain("(missing)");
  });

  test("renders linked_backlog as CROSS-LEDGER links", () => {
    // {20.29}: linked_backlog now routes to the backlog sibling ledger.
    const theme = mkTheme({ linked_backlog: ["45"] });
    const ledger = buildLedgerContext({
      roadmap: mkRoadmap([theme]),
      backlogItems: [mkBacklogItem("45")],
    });
    const html = renderToStaticMarkup(
      <RoadmapThemeView theme={theme} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('data-section="linked_backlog"');
    expect(html).toContain('href="/?ledger=backlog&amp;record=45"');
    expect(html).toContain('data-cross-ledger="backlog"');
  });

  test("omits linked_tasks / linked_backlog sections when empty", () => {
    const theme = mkTheme({ linked_tasks: [], linked_backlog: [] });
    const ledger = buildLedgerContext({ roadmap: mkRoadmap([theme]) });
    const html = renderToStaticMarkup(
      <RoadmapThemeView theme={theme} ledger={ledger} nav={NAV} />,
    );
    expect(html).not.toContain('data-section="linked_tasks"');
    expect(html).not.toContain('data-section="linked_backlog"');
  });

  test("renders cross_doc_links list when populated", () => {
    const theme = mkTheme({
      cross_doc_links: [
        { path: "docs/specs/foo.md", anchor: null, raw: "Foo spec" },
      ],
    });
    const ledger = buildLedgerContext({
      roadmap: mkRoadmap([theme]),
      existingPaths: new Set(["docs/specs/foo.md"]),
    });
    const html = renderToStaticMarkup(
      <RoadmapThemeView theme={theme} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain("Cross-doc links");
    expect(html).toContain('href="docs/specs/foo.md"');
    expect(html).toContain(">Foo spec<");
  });

  test("renders notes section when notes is non-null; omits when null", () => {
    const withNotes = mkTheme({ notes: "Some notes." });
    const ledgerA = buildLedgerContext({ roadmap: mkRoadmap([withNotes]) });
    const htmlA = renderToStaticMarkup(
      <RoadmapThemeView theme={withNotes} ledger={ledgerA} nav={NAV} />,
    );
    expect(htmlA).toContain('data-section="notes"');
    expect(htmlA).toContain("Some notes");

    const noNotes = mkTheme({ notes: null });
    const ledgerB = buildLedgerContext({ roadmap: mkRoadmap([noNotes]) });
    const htmlB = renderToStaticMarkup(
      <RoadmapThemeView theme={noNotes} ledger={ledgerB} nav={NAV} />,
    );
    expect(htmlB).not.toContain('data-section="notes"');
  });
});

describe("PRODUCT inv 19 (forward_looking_only honoured; no shipped UI)", () => {
  test("renders no 'shipped' affordances in the theme page", () => {
    const theme = mkTheme();
    const ledger = buildLedgerContext({ roadmap: mkRoadmap([theme]) });
    const html = renderToStaticMarkup(
      <RoadmapThemeView theme={theme} ledger={ledger} nav={NAV} />,
    );
    const lowered = html.toLowerCase();
    expect(lowered).not.toContain("shipped");
    expect(lowered).not.toContain("mark as");
  });
});
