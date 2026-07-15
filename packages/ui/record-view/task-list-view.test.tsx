/**
 * task-list-view.test.tsx — verifies Task-list mode rendering against
 * PRODUCT inv 7-13 (covers TECH §4.1, §4.2 Task-list column, §4.4, §4.5).
 *
 * Maps to TECH "Testing and validation" table rows:
 *   - inv 7 → tests/integration/task-list-render.test.ts
 *   - inv 8 → tests/integration/subtask-block.test.ts
 *   - inv 9 → tests/integration/empty-subtasks.test.ts
 *   - inv 12 → tests/integration/dependency-links.test.ts
 *   - inv 13 → tests/integration/sibling-subtask-deps.test.ts
 *
 * Colocated here per repo convention (packages/ui/utils/*.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Subtask, Task } from "@task-view/schemas/task-list";
import { buildLedgerContext, type NavStripData } from "./types";
import { TaskListView } from "./task-list-view";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NAV: NavStripData = {
  prevHref: null,
  prevLabel: null,
  nextHref: "/record/ID-21",
  nextLabel: "ID-21",
  indexHref: "/",
  indexLabel: "Back to ledger index",
};

const mkSubtask = (overrides: Partial<Subtask> = {}): Subtask => ({
  id: "1",
  title: "Subtask title",
  description: "Subtask description.",
  status: "pending",
  dependencies: [],
  details: "Details body.",
  testStrategy: "Acceptance prose.",
  updatedAt: "2026-05-21T15:30:00.000Z",
  ...overrides,
});

const mkTask = (overrides: Partial<Task> = {}): Task => ({
  id: "20",
  title: "Task title",
  description: "Task description.",
  status: "in_progress",
  priority: "must",
  dependencies: [],
  subtasks: [mkSubtask()],
  updatedAt: "2026-05-21T15:30:00.000Z",
  effort_estimate: "~2h",
  owner: "Engineering",
  priority_note: null,
  status_note: null,
  cross_doc_links: [],
  session_refs: ["kh-prod-readiness-S63"],
  commit_refs: ["abc1234"],
  ...overrides,
});

// ── PRODUCT inv 7 ─────────────────────────────────────────────────────────────

describe("PRODUCT inv 7 (Task-list mode: frontmatter + description + Subtasks + nav strip)", () => {
  test("renders all required frontmatter rows + body + nav strip", () => {
    const task = mkTask();
    const ledger = buildLedgerContext({ tasks: [task] });
    const html = renderToStaticMarkup(
      <TaskListView task={task} ledger={ledger} nav={NAV} />,
    );
    // Title heading — ID-20.25 splits the editable title into a
    // .record-view-field-value span so the dispatcher reads the title
    // cleanly (without the pencil glyph), and adds a text-kind pencil.
    expect(html).toContain("ID-20: ");
    expect(html).toContain(
      '<span class="record-view-field-value">Task title</span>',
    );
    expect(html).toContain('data-edit-field="tasks&gt;20&gt;title"');
    expect(html).toContain('data-edit-kind="text"');
    // Editable status enum affordance (inv 31-32 — options from the
    // canonical Zod enum, every value selectable).
    expect(html).toContain('data-edit-field="tasks&gt;20&gt;status"');
    expect(html).toContain('data-edit-kind="enum"');
    expect(html).toContain(
      'data-edit-options="done,pending,in_progress,blocked,deferred,cancelled,spec_needed,imp_deferred"',
    );
    // Frontmatter rows (per inv 7)
    expect(html).toContain('data-frontmatter-row="status"');
    expect(html).toContain('data-frontmatter-row="priority"');
    expect(html).toContain('data-frontmatter-row="effort_estimate"');
    expect(html).toContain('data-frontmatter-row="owner"');
    expect(html).toContain('data-frontmatter-row="updated"');
    expect(html).toContain('data-frontmatter-row="session_refs"');
    expect(html).toContain('data-frontmatter-row="commit_refs"');
    expect(html).toContain('data-frontmatter-row="dependencies"');
    expect(html).toContain('data-frontmatter-row="cross_doc_links"');
    // Description body present
    expect(html).toContain("Task description");
    // Subtasks section heading
    expect(html).toMatch(/<h2[^>]*>Subtasks<\/h2>/);
    // Nav strip present
    expect(html).toContain("data-nav-strip");
  });

  test("renders commit refs as GitHub links when githubBaseUrl is provided", () => {
    const task = mkTask({ commit_refs: ["abc1234", "def5678"] });
    const ledger = buildLedgerContext({ tasks: [task] });
    const html = renderToStaticMarkup(
      <TaskListView
        task={task}
        ledger={ledger}
        nav={NAV}
        githubBaseUrl="https://github.com/example/repo"
      />,
    );
    expect(html).toContain(
      'href="https://github.com/example/repo/commit/abc1234"',
    );
    expect(html).toContain('data-commit-ref="abc1234"');
    expect(html).toContain(
      'href="https://github.com/example/repo/commit/def5678"',
    );
  });

  test("renders commit refs as plain code when no GitHub URL", () => {
    const task = mkTask({ commit_refs: ["abc1234"] });
    const ledger = buildLedgerContext({ tasks: [task] });
    const html = renderToStaticMarkup(
      <TaskListView task={task} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain("<code>abc1234</code>");
    expect(html).not.toContain("github.com");
  });

  test("renders priority_note and status_note when populated", () => {
    const task = mkTask({
      priority_note: "Bumped to Must in S62.",
      status_note: "Waiting on review feedback.",
    });
    const ledger = buildLedgerContext({ tasks: [task] });
    const html = renderToStaticMarkup(
      <TaskListView task={task} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain("Priority note:");
    expect(html).toContain("Bumped to Must");
    expect(html).toContain("Status note:");
    expect(html).toContain("Waiting on review");
    expect(html).toContain("data-priority-note");
    expect(html).toContain("data-status-note");
  });

  test("omits priority_note / status_note paragraphs when null", () => {
    const task = mkTask({ priority_note: null, status_note: null });
    const ledger = buildLedgerContext({ tasks: [task] });
    const html = renderToStaticMarkup(
      <TaskListView task={task} ledger={ledger} nav={NAV} />,
    );
    expect(html).not.toContain("data-priority-note");
    expect(html).not.toContain("data-status-note");
  });
});

// ── PRODUCT inv 8 ─────────────────────────────────────────────────────────────

describe("PRODUCT inv 8 (Subtask block: frontmatter + description + testStrategy + details + journal)", () => {
  test("renders each Subtask as a level-3 heading with ID prefix + frontmatter", () => {
    const task = mkTask({
      subtasks: [
        mkSubtask({ id: "1", title: "First sub" }),
        mkSubtask({ id: "2", title: "Second sub" }),
      ],
    });
    const ledger = buildLedgerContext({ tasks: [task] });
    const html = renderToStaticMarkup(
      <TaskListView task={task} ledger={ledger} nav={NAV} />,
    );
    // ID-20.25: the Subtask heading splits the editable title into a
    // .record-view-field-value span (so the dispatcher reads it without
    // the pencil glyph) and carries a text-kind title affordance.
    expect(html).toContain("ID-20.1: ");
    expect(html).toContain(
      '<span class="record-view-field-value">First sub</span>',
    );
    expect(html).toContain(
      '<span class="record-view-field-value">Second sub</span>',
    );
    expect(html).toContain(
      'data-edit-field="tasks&gt;20&gt;subtasks&gt;1&gt;title"',
    );
    expect(html).toContain(
      'data-edit-field="tasks&gt;20&gt;subtasks&gt;2&gt;title"',
    );
    // Subtask status enum affordance + the 6-value Subtask subset.
    expect(html).toContain(
      'data-edit-field="tasks&gt;20&gt;subtasks&gt;1&gt;status"',
    );
    expect(html).toContain(
      'data-edit-options="done,pending,in_progress,blocked,deferred,cancelled"',
    );
    expect(html).toContain('data-subtask-id="1"');
    expect(html).toContain('data-subtask-id="2"');
    expect(html).toContain('id="subtask-1"');
    expect(html).toContain('id="subtask-2"');
  });

  test("renders Subtask testStrategy when non-null", () => {
    const task = mkTask({
      subtasks: [mkSubtask({ testStrategy: "Must pass X." })],
    });
    const ledger = buildLedgerContext({ tasks: [task] });
    const html = renderToStaticMarkup(
      <TaskListView task={task} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain("Test strategy:");
    expect(html).toContain("Must pass X");
    expect(html).toContain("data-test-strategy");
  });

  test("omits Test-strategy paragraph when null", () => {
    const task = mkTask({
      subtasks: [mkSubtask({ testStrategy: null })],
    });
    const ledger = buildLedgerContext({ tasks: [task] });
    const html = renderToStaticMarkup(
      <TaskListView task={task} ledger={ledger} nav={NAV} />,
    );
    expect(html).not.toContain("data-test-strategy");
  });

  test("renders details body verbatim with journal-block visual distinction", () => {
    const task = mkTask({
      subtasks: [
        mkSubtask({
          details:
            "Pre-journal.\n\n<info added on 2026-05-21T15:00:00.000Z>\nShipped.\n</info added on 2026-05-21T15:00:00.000Z>",
        }),
      ],
    });
    const ledger = buildLedgerContext({ tasks: [task] });
    const html = renderToStaticMarkup(
      <TaskListView task={task} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain("Pre-journal");
    expect(html).toContain('data-segment="prose"');
    expect(html).toContain('data-segment="journal"');
    expect(html).toContain('data-journal-timestamp="2026-05-21T15:00:00.000Z"');
    expect(html).toContain("Shipped");
    // The "Journal" label is visible
    expect(html).toContain("Journal");
  });
});

// ── ID-20.25 edit affordances ───────────────────────────────────────────────

describe("ID-20.25 (Task + Subtask edit affordances)", () => {
  test("Task: owner + effort_estimate carry text-kind pencils", () => {
    const task = mkTask();
    const ledger = buildLedgerContext({ tasks: [task] });
    const html = renderToStaticMarkup(
      <TaskListView task={task} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('data-edit-field="tasks&gt;20&gt;owner"');
    expect(html).toContain('data-edit-field="tasks&gt;20&gt;effort_estimate"');
  });

  test("Task: description pencil carries raw Markdown source (inv 27-28)", () => {
    const task = mkTask({ description: "## Heading\n\nBody." });
    const ledger = buildLedgerContext({ tasks: [task] });
    const html = renderToStaticMarkup(
      <TaskListView task={task} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('data-edit-field="tasks&gt;20&gt;description"');
    expect(html).toContain('data-edit-kind="textarea"');
    // Raw source carried verbatim on the hook (HTML-escaped by React).
    expect(html).toContain("## Heading");
  });

  test("Task: dependencies pencil is array-comma with raw bare-id source (not link labels)", () => {
    const a = mkTask({ id: "20", dependencies: ["19", "18"] });
    const ledger = buildLedgerContext({
      tasks: [a, mkTask({ id: "19" }), mkTask({ id: "18" })],
    });
    const html = renderToStaticMarkup(
      <TaskListView task={a} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('data-edit-field="tasks&gt;20&gt;dependencies"');
    expect(html).toContain('data-edit-kind="array-comma"');
    // Raw value is the bare comma-joined canonical ids, NOT "ID-19, ID-18".
    expect(html).toContain('data-edit-raw-value="19,18"');
  });

  test("Subtask: details pencil carries the FULL raw string incl. journal block (inv 28)", () => {
    const details =
      "Pre.\n\n<info added on 2026-05-21T15:00:00.000Z>\nShipped.\n</info added on 2026-05-21T15:00:00.000Z>";
    const task = mkTask({ subtasks: [mkSubtask({ id: "1", details })] });
    const ledger = buildLedgerContext({ tasks: [task] });
    const html = renderToStaticMarkup(
      <TaskListView task={task} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain(
      'data-edit-field="tasks&gt;20&gt;subtasks&gt;1&gt;details"',
    );
    // The journal block survives verbatim in the raw-value hook.
    expect(html).toContain("info added on 2026-05-21T15:00:00.000Z");
    expect(html).toContain("Shipped.");
  });

  test("Subtask: dependencies pencil raw value is bare integer ids", () => {
    const task = mkTask({
      subtasks: [
        mkSubtask({ id: "1" }),
        mkSubtask({ id: "2", dependencies: ["1"] }),
      ],
    });
    const ledger = buildLedgerContext({ tasks: [task] });
    const html = renderToStaticMarkup(
      <TaskListView task={task} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain(
      'data-edit-field="tasks&gt;20&gt;subtasks&gt;2&gt;dependencies"',
    );
    expect(html).toContain('data-edit-raw-value="1"');
  });
});

// ── PRODUCT inv 9 ─────────────────────────────────────────────────────────────

describe("PRODUCT inv 9 (empty Subtasks → italic 'No subtasks.')", () => {
  test("renders the italic placeholder when subtasks array is empty", () => {
    const task = mkTask({ subtasks: [] });
    const ledger = buildLedgerContext({ tasks: [task] });
    const html = renderToStaticMarkup(
      <TaskListView task={task} ledger={ledger} nav={NAV} />,
    );
    // The Subtasks section is NOT omitted (per inv 9 last sentence)
    expect(html).toMatch(/<h2[^>]*>Subtasks<\/h2>/);
    // Empty-state marker present
    expect(html).toContain("data-empty-subtasks");
    // S63 WP5c Finding-1 Option A regression: rendered DOM must contain
    // an <em>No subtasks.</em> with no literal underscore characters
    // (the spec's `_..._` shorthand denotes Markdown italics, not literal
    // underscores in display).
    expect(html).toMatch(/<em>No subtasks\.<\/em>/);
    expect(html).not.toContain("_No subtasks._");
  });
});

// ── PRODUCT inv 12 ────────────────────────────────────────────────────────────

describe("PRODUCT inv 12 (Task dependency links + missing-target + page-top warning)", () => {
  test("live deps render as links to the record route", () => {
    const a = mkTask({ id: "20", dependencies: ["19"] });
    const b = mkTask({ id: "19" });
    const ledger = buildLedgerContext({ tasks: [a, b] });
    const html = renderToStaticMarkup(
      <TaskListView task={a} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('href="/?record=19"');
    expect(html).toContain(">ID-19<");
    // No page-top warning when all deps are live
    expect(html).not.toContain("data-page-top-warning");
  });

  test("missing deps render with '(missing)' marker + page-top warning", () => {
    const a = mkTask({ id: "20", dependencies: ["19", "999"] });
    const live = mkTask({ id: "19" });
    const ledger = buildLedgerContext({ tasks: [a, live] });
    const html = renderToStaticMarkup(
      <TaskListView task={a} ledger={ledger} nav={NAV} />,
    );
    // Live dep is a link
    expect(html).toContain('href="/?record=19"');
    // Missing dep has strikethrough + "(missing)" suffix
    expect(html).toContain("(missing)");
    expect(html).toContain("line-through");
    // Page-top warning lists the missing id
    expect(html).toContain("data-page-top-warning");
    expect(html).toContain("ID-999");
  });
});

// ── PRODUCT inv 13 ────────────────────────────────────────────────────────────

describe("PRODUCT inv 13 (sibling-Subtask deps → in-page anchor)", () => {
  test("sibling deps render as #subtask-{id} fragment links", () => {
    const task = mkTask({
      subtasks: [
        mkSubtask({ id: "1", dependencies: [] }),
        mkSubtask({ id: "2", dependencies: ["1"] }),
      ],
    });
    const ledger = buildLedgerContext({ tasks: [task] });
    const html = renderToStaticMarkup(
      <TaskListView task={task} ledger={ledger} nav={NAV} />,
    );
    // The dep link href is the in-page anchor
    expect(html).toContain('href="#subtask-1"');
    // Label shows ID-20.1
    expect(html).toContain(">ID-20.1<");
    // The Subtask 1 block carries the matching anchor id
    expect(html).toContain('id="subtask-1"');
  });

  test("stray cross-Task dep renders with '(missing)' marker", () => {
    // Schema's superRefine would reject this in normal validation, but the
    // renderer must defensively flag any sibling id not in the parent.
    const task = mkTask({
      subtasks: [
        mkSubtask({ id: "1", dependencies: ["99"] }), // "99" is not a sibling
      ],
    });
    const ledger = buildLedgerContext({ tasks: [task] });
    const html = renderToStaticMarkup(
      <TaskListView task={task} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain("ID-20.99");
    expect(html).toContain("(missing)");
    expect(html).toContain("line-through");
  });
});

// ── PRODUCT inv 11 ────────────────────────────────────────────────────────────

describe("PRODUCT inv 11 (cross-doc-link rendering + broken-target marker)", () => {
  test("renders live cross-doc link when path is in existingPaths", () => {
    const task = mkTask({
      cross_doc_links: [
        {
          path: "docs/specs/foo.md",
          anchor: null,
          raw: "foo spec",
        },
      ],
    });
    const ledger = buildLedgerContext({
      tasks: [task],
      existingPaths: new Set(["docs/specs/foo.md"]),
    });
    const html = renderToStaticMarkup(
      <TaskListView task={task} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('href="docs/specs/foo.md"');
    expect(html).toContain(">foo spec<");
  });

  test("renders missing cross-doc link with '(missing target)' marker", () => {
    const task = mkTask({
      cross_doc_links: [
        {
          path: "docs/specs/missing.md",
          anchor: null,
          raw: "missing spec",
        },
      ],
    });
    const ledger = buildLedgerContext({
      tasks: [task],
      existingPaths: new Set(["docs/specs/foo.md"]),
    });
    const html = renderToStaticMarkup(
      <TaskListView task={task} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain("(missing target)");
    expect(html).toContain("line-through");
  });
});

// ── ID-148.10: capability_theme chip RETIRED (TECH §3.1(d), INV-12(d)) ───────
//
// The former {20.29} capability_theme cross-ledger chip pointed at a
// "roadmap theme", a kind that no longer exists — this view no longer
// renders it (the field itself is dormant legacy data on Task; cleanup is a
// separate deferred task per TECH §8).

// ── {20.30} reverse cross-ledger backlinks (repurposed to projects) ─────────

describe("{20.30} appears-in-projects backlinks (reverse of project.linked_tasks, ID-148.10)", () => {
  const mkInitiativesWith = (
    projects: { id: string; title: string; linked_tasks: string[] }[],
  ) =>
    ({
      document_name: "Canonical Platform - Initiatives",
      document_purpose: "p",
      date: "2026-07-15",
      status: "active",
      related_documents: [],
      last_updated: "fixture",
      initiatives: [
        {
          id: "1",
          title: "Initiative 1",
          description: "d",
          status: "active",
          projects: projects.map((p) => ({
            id: p.id,
            title: p.title,
            summary: "s",
            description: "d",
            substrate_doc: "",
            status: "idea" as const,
            blocked_by: [],
            blocking: [],
            linked_tasks: p.linked_tasks,
            linked_backlog: [],
            originating_session: [],
          })),
          originating_session: [],
          "sub-initiatives": [],
        },
      ],
    }) as never;

  test("renders an Appears-in-projects row with a cross-ledger link per project", () => {
    const task = mkTask({ id: "15" });
    const ledger = buildLedgerContext({
      tasks: [task],
      initiatives: mkInitiativesWith([
        { id: "foundations", title: "Foundations", linked_tasks: ["15", "29"] },
        { id: "procurement", title: "Procurement", linked_tasks: ["15"] },
      ]),
    });
    const html = renderToStaticMarkup(
      <TaskListView task={task} ledger={ledger} nav={NAV} />,
    );
    expect(html).toContain('data-frontmatter-row="appears_in_projects"');
    // Cross-ledger hrefs to the initiatives sibling, one per referencing project.
    expect(html).toContain('href="/?ledger=initiatives&amp;record=foundations"');
    expect(html).toContain('href="/?ledger=initiatives&amp;record=procurement"');
    expect(html).toContain('data-cross-ledger="initiatives"');
    // Titles resolved from the sibling initiatives document.
    expect(html).toContain("project foundations: Foundations");
    expect(html).toContain("project procurement: Procurement");
  });

  test("omits the Appears-in-projects row when no project references the task", () => {
    const task = mkTask({ id: "99" });
    const ledger = buildLedgerContext({
      tasks: [task],
      initiatives: mkInitiativesWith([
        { id: "foundations", title: "Foundations", linked_tasks: ["15"] },
      ]),
    });
    const html = renderToStaticMarkup(
      <TaskListView task={task} ledger={ledger} nav={NAV} />,
    );
    expect(html).not.toContain('data-frontmatter-row="appears_in_projects"');
  });

  test("omits the row when no initiatives sibling is threaded in", () => {
    const task = mkTask({ id: "15" });
    const ledger = buildLedgerContext({ tasks: [task] });
    const html = renderToStaticMarkup(
      <TaskListView task={task} ledger={ledger} nav={NAV} />,
    );
    expect(html).not.toContain('data-frontmatter-row="appears_in_projects"');
  });
});
