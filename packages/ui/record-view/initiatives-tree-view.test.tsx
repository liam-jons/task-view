/**
 * initiatives-tree-view.test.tsx — verifies the Initiative page rendering
 * (ID-148.10, repurposed from roadmap-theme-view.test.tsx; TECH §3.1(c),
 * OQ2 — an initiatives view WITH editing).
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  InitiativesDocument,
  Initiative,
  SubInitiative,
  Project,
} from "@task-view/schemas/initiatives";
import type { Task } from "@task-view/schemas/task-list";
import type { BacklogItem } from "@task-view/schemas/backlog";
import { buildLedgerContext, type NavStripData } from "./types";
import { InitiativesTreeView } from "./initiatives-tree-view";

const NAV: NavStripData = {
  prevHref: null,
  prevLabel: null,
  nextHref: null,
  nextLabel: null,
  indexHref: "/",
  indexLabel: "Back to ledger index",
};

const mkProject = (overrides: Partial<Project> = {}): Project => ({
  id: "sample-project",
  title: "Sample project",
  summary: "Summary.",
  description: "Description.",
  substrate_doc: "",
  status: "idea",
  blocked_by: [],
  blocking: [],
  linked_tasks: [],
  linked_backlog: [],
  originating_session: [],
  ...overrides,
});

const mkSubInitiative = (
  overrides: Partial<SubInitiative> = {},
): SubInitiative => ({
  id: "1",
  title: "Sub one",
  description: "Sub description.",
  status: "planned",
  projects: [],
  originating_session: [],
  "sub-initiatives": [],
  ...overrides,
});

const mkInitiative = (overrides: Partial<Initiative> = {}): Initiative => ({
  id: "1",
  title: "Initiative 1",
  description: "Initiative 1 description.",
  status: "active",
  projects: [],
  originating_session: [],
  "sub-initiatives": [],
  ...overrides,
});

const mkInitiativesDoc = (
  initiatives: Initiative[],
): InitiativesDocument => ({
  document_name: "Canonical Platform - Initiatives",
  document_purpose: "Structured record of active initiatives.",
  date: "2026-07-15",
  status: "active",
  related_documents: [],
  last_updated: "kh-main-S473 fixture",
  initiatives,
});

const mkTask = (id: string): Task => ({
  id,
  title: `Task ${id}`,
  description: "d",
  status: "in_progress",
  priority: "must",
  dependencies: [],
  blocked_by: [],
  blocking: [],
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

describe("InitiativesTreeView — initiative-level surfaces", () => {
  test("renders title + description + status frontmatter with edit affordances", () => {
    const initiative = mkInitiative();
    const ledger = buildLedgerContext({ initiatives: mkInitiativesDoc([initiative]) });
    const html = renderToStaticMarkup(
      <InitiativesTreeView initiative={initiative} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain("1: ");
    expect(html).toContain(
      '<span class="record-view-field-value">Initiative 1</span>',
    );
    expect(html).toContain("Initiative 1 description");
    expect(html).toContain('data-frontmatter-row="id"');
    expect(html).toContain('data-frontmatter-row="status"');
    // Status enum affordance addressed by dotted PATH (INV-13).
    expect(html).toContain('data-edit-field="initiatives&gt;1&gt;status"');
    expect(html).toContain('data-edit-kind="enum"');
    expect(html).toContain(
      'data-edit-options="proposed,planned,active,completed,cancelled"',
    );
    expect(html).toContain('data-edit-field="initiatives&gt;1&gt;title"');
    expect(html).toContain('data-edit-field="initiatives&gt;1&gt;description"');
  });

  test("renders originating_session + substrate_doc rows", () => {
    const initiative = mkInitiative({
      originating_session: ["S470", "S471"],
      substrate_doc: "docs/specs/foo/PRODUCT.md",
    });
    const ledger = buildLedgerContext({ initiatives: mkInitiativesDoc([initiative]) });
    const html = renderToStaticMarkup(
      <InitiativesTreeView initiative={initiative} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('data-frontmatter-row="originating_session"');
    expect(html).toContain("S470, S471");
    expect(html).toContain('data-frontmatter-row="substrate_doc"');
    expect(html).toContain("docs/specs/foo/PRODUCT.md");
  });

  test("initiative-4 transitional linked_tasks/linked_backlog render read-only when present", () => {
    const initiative = mkInitiative({
      linked_tasks: ["20"],
      linked_backlog: ["45"],
    });
    const ledger = buildLedgerContext({
      initiatives: mkInitiativesDoc([initiative]),
      tasks: [mkTask("20")],
      backlogItems: [mkBacklogItem("45")],
    });
    const html = renderToStaticMarkup(
      <InitiativesTreeView initiative={initiative} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('data-section="transitional-links"');
    expect(html).toContain("initiative-level, transitional");
    // Read-only: no FieldPencil for these two fields at the initiative level.
    expect(html).not.toContain('data-edit-field="initiatives&gt;1&gt;linked_tasks"');
    expect(html).not.toContain(
      'data-edit-field="initiatives&gt;1&gt;linked_backlog"',
    );
  });

  test("omits the transitional-links section when both are empty", () => {
    const initiative = mkInitiative({ linked_tasks: [], linked_backlog: [] });
    const ledger = buildLedgerContext({ initiatives: mkInitiativesDoc([initiative]) });
    const html = renderToStaticMarkup(
      <InitiativesTreeView initiative={initiative} ledger={ledger} nav={NAV} />,
    );
    expect(html).not.toContain('data-section="transitional-links"');
  });
});

describe("InitiativesTreeView — direct projects (editing, INV-13 slug addressing)", () => {
  test("renders a direct project's fields with slug-addressed edit affordances", () => {
    const project = mkProject({ id: "foundation-project", title: "Foundation" });
    const initiative = mkInitiative({ projects: [project] });
    const ledger = buildLedgerContext({ initiatives: mkInitiativesDoc([initiative]) });
    const html = renderToStaticMarkup(
      <InitiativesTreeView initiative={initiative} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('data-section="project"');
    expect(html).toContain('data-project-slug="foundation-project"');
    expect(html).toContain(
      'data-edit-field="projects&gt;foundation-project&gt;title"',
    );
    expect(html).toContain(
      'data-edit-field="projects&gt;foundation-project&gt;status"',
    );
    expect(html).toContain(
      'data-edit-options="idea,proposal,backlog,discovery,accepted,ready,paused,in-progress,maintenance,completed,cancelled"',
    );
    expect(html).toContain(
      'data-edit-field="projects&gt;foundation-project&gt;summary"',
    );
    expect(html).toContain(
      'data-edit-field="projects&gt;foundation-project&gt;description"',
    );
    expect(html).toContain(
      'data-edit-field="projects&gt;foundation-project&gt;substrate_doc"',
    );
  });

  test("linked_tasks/linked_backlog render as array-comma FieldPencils (link/unlink, OQ2)", () => {
    const project = mkProject({
      id: "foundation-project",
      linked_tasks: ["20", "21"],
    });
    const initiative = mkInitiative({ projects: [project] });
    const ledger = buildLedgerContext({
      initiatives: mkInitiativesDoc([initiative]),
      tasks: [mkTask("20"), mkTask("21")],
    });
    const html = renderToStaticMarkup(
      <InitiativesTreeView initiative={initiative} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain(
      'data-edit-field="projects&gt;foundation-project&gt;linked_tasks"',
    );
    expect(html).toContain('data-edit-kind="array-comma"');
    expect(html).toContain('data-edit-raw-value="20,21"');
    // Cross-ledger link rendering + no broken-target when both exist.
    expect(html).toContain('href="/?ledger=task-list&amp;record=20"');
    expect(html).toContain('data-cross-ledger="task-list"');
    expect(html).not.toContain("(missing)");
  });

  test("a missing linked task renders broken-target treatment", () => {
    const project = mkProject({ id: "p1", linked_tasks: ["99"] });
    const initiative = mkInitiative({ projects: [project] });
    const ledger = buildLedgerContext({
      initiatives: mkInitiativesDoc([initiative]),
      tasks: [],
    });
    const html = renderToStaticMarkup(
      <InitiativesTreeView initiative={initiative} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain("(missing)");
  });

  test("linked_backlog renders CROSS-LEDGER links + array-comma editing", () => {
    const project = mkProject({ id: "p1", linked_backlog: ["45"] });
    const initiative = mkInitiative({ projects: [project] });
    const ledger = buildLedgerContext({
      initiatives: mkInitiativesDoc([initiative]),
      backlogItems: [mkBacklogItem("45")],
    });
    const html = renderToStaticMarkup(
      <InitiativesTreeView initiative={initiative} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('data-edit-field="projects&gt;p1&gt;linked_backlog"');
    expect(html).toContain('href="/?ledger=backlog&amp;record=45"');
    expect(html).toContain('data-cross-ledger="backlog"');
  });

  test("empty linked_tasks/linked_backlog render a 'None.' placeholder (edit affordance still visible)", () => {
    const project = mkProject({ id: "p1" });
    const initiative = mkInitiative({ projects: [project] });
    const ledger = buildLedgerContext({ initiatives: mkInitiativesDoc([initiative]) });
    const html = renderToStaticMarkup(
      <InitiativesTreeView initiative={initiative} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain("None.");
    expect(html).toContain('data-edit-field="projects&gt;p1&gt;linked_tasks"');
  });

  test("blocked_by / blocking render when present", () => {
    const project = mkProject({
      id: "p1",
      blocked_by: ["other-project"],
      blocking: ["another-project"],
    });
    const initiative = mkInitiative({ projects: [project] });
    const ledger = buildLedgerContext({ initiatives: mkInitiativesDoc([initiative]) });
    const html = renderToStaticMarkup(
      <InitiativesTreeView initiative={initiative} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('data-section="blocked_by"');
    expect(html).toContain("other-project");
    expect(html).toContain('data-section="blocking"');
    expect(html).toContain("another-project");
  });

  test("renders '_none_'-style empty state when the initiative has no direct projects", () => {
    const initiative = mkInitiative({ projects: [] });
    const ledger = buildLedgerContext({ initiatives: mkInitiativesDoc([initiative]) });
    const html = renderToStaticMarkup(
      <InitiativesTreeView initiative={initiative} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain("data-empty-projects");
    expect(html).toContain("No direct projects");
  });
});

describe("InitiativesTreeView — nested sub-initiatives (arbitrary depth, INV-13)", () => {
  test("renders a one-level-deep sub-initiative with dotted-path edit affordances", () => {
    const sub = mkSubInitiative({ id: "2", title: "Sub two" });
    const initiative = mkInitiative({ id: "4", "sub-initiatives": [sub] });
    const ledger = buildLedgerContext({ initiatives: mkInitiativesDoc([initiative]) });
    const html = renderToStaticMarkup(
      <InitiativesTreeView initiative={initiative} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('data-sub-initiative-path="4.2"');
    expect(html).toContain('data-edit-field="initiatives&gt;4.2&gt;title"');
    expect(html).toContain('data-edit-field="initiatives&gt;4.2&gt;status"');
    expect(html).toContain('data-edit-field="initiatives&gt;4.2&gt;description"');
    expect(html).toContain("Sub two");
  });

  test("renders a TWO-level-deep sub-sub-initiative with the fully dotted path", () => {
    const deepSub = mkSubInitiative({ id: "1", title: "Deep sub" });
    const midSub = mkSubInitiative({
      id: "2",
      title: "Mid sub",
      "sub-initiatives": [deepSub],
    });
    const initiative = mkInitiative({ id: "4", "sub-initiatives": [midSub] });
    const ledger = buildLedgerContext({ initiatives: mkInitiativesDoc([initiative]) });
    const html = renderToStaticMarkup(
      <InitiativesTreeView initiative={initiative} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('data-sub-initiative-path="4.2"');
    expect(html).toContain('data-sub-initiative-path="4.2.1"');
    expect(html).toContain('data-edit-field="initiatives&gt;4.2.1&gt;title"');
    expect(html).toContain("Deep sub");
  });

  test("a sub-initiative's own project is slug-addressed identically to a direct project", () => {
    const nestedProject = mkProject({ id: "nested-project" });
    const sub = mkSubInitiative({ id: "2", projects: [nestedProject] });
    const initiative = mkInitiative({ id: "4", "sub-initiatives": [sub] });
    const ledger = buildLedgerContext({ initiatives: mkInitiativesDoc([initiative]) });
    const html = renderToStaticMarkup(
      <InitiativesTreeView initiative={initiative} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('data-project-slug="nested-project"');
    expect(html).toContain(
      'data-edit-field="projects&gt;nested-project&gt;title"',
    );
  });

  test("renders empty-state when there are no sub-initiatives", () => {
    const initiative = mkInitiative({ "sub-initiatives": [] });
    const ledger = buildLedgerContext({ initiatives: mkInitiativesDoc([initiative]) });
    const html = renderToStaticMarkup(
      <InitiativesTreeView initiative={initiative} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain("data-empty-sub-initiatives");
    expect(html).toContain("No sub-initiatives");
  });
});

// ── ID-148.10 Checker Finding B: whole-record create/delete/move ────────────

describe("InitiativesTreeView — whole-record create/delete/move (INV-13, OQ2)", () => {
  test("a top-level initiative's Projects section carries a create-project form addressed to its own path", () => {
    const initiative = mkInitiative({ id: "4", projects: [] });
    const ledger = buildLedgerContext({ initiatives: mkInitiativesDoc([initiative]) });
    const html = renderToStaticMarkup(
      <InitiativesTreeView initiative={initiative} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain("data-project-create-form");
    expect(html).toContain('data-initiative-path="4"');
    expect(html).toContain("data-project-create-slug");
    expect(html).toContain("data-project-create-title");
    expect(html).toContain("data-project-create-action");
  });

  test("a sub-initiative's Projects section carries its OWN create form, addressed by its dotted path", () => {
    const sub = mkSubInitiative({ id: "2" });
    const initiative = mkInitiative({ id: "4", "sub-initiatives": [sub] });
    const ledger = buildLedgerContext({ initiatives: mkInitiativesDoc([initiative]) });
    const html = renderToStaticMarkup(
      <InitiativesTreeView initiative={initiative} ledger={ledger} nav={NAV} />,
    );
    // Both the top-level (path "4") and the sub-initiative (path "4.2")
    // forms are present, each addressed to its own node.
    expect(html).toContain('data-initiative-path="4"');
    expect(html).toContain('data-initiative-path="4.2"');
  });

  test("a project carries a delete-project button scoped to its own slug", () => {
    const project = mkProject({ id: "foundation-project" });
    const initiative = mkInitiative({ projects: [project] });
    const ledger = buildLedgerContext({ initiatives: mkInitiativesDoc([initiative]) });
    const html = renderToStaticMarkup(
      <InitiativesTreeView initiative={initiative} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain("data-project-delete-action");
    expect(html).toContain("Delete project foundation-project");
  });

  test("a project's linked_tasks/linked_backlog sections each carry a move form addressed to the project's own slug", () => {
    const project = mkProject({ id: "foundation-project", linked_tasks: ["20"] });
    const initiative = mkInitiative({ projects: [project] });
    const ledger = buildLedgerContext({
      initiatives: mkInitiativesDoc([initiative]),
      tasks: [mkTask("20")],
    });
    const html = renderToStaticMarkup(
      <InitiativesTreeView initiative={initiative} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain("data-move-form");
    expect(html).toContain('data-move-section="linked_tasks"');
    expect(html).toContain('data-move-section="linked_backlog"');
    expect(html).toContain('data-source-slug="foundation-project"');
    expect(html).toContain("data-move-id");
    expect(html).toContain("data-move-target");
    expect(html).toContain("data-move-action");
  });
});
