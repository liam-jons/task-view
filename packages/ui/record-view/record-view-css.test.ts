/**
 * record-view-css.test.ts — the regression net for the original bug
 * (record-view-styling SPEC SV-54/55/56; TASKS T12).
 *
 * Reads record-view.css off disk and asserts:
 *   - SV-54: every `record-view-*` class the components emit (SPEC §3) has
 *     at least one matching rule — so a renamed/added class that loses its
 *     styling fails CI (this is exactly the gap that shipped unstyled HTML).
 *   - SV-55: no `outline:none` / `outline:0` (the focus-ring guard).
 *   - SV-56: a `prefers-reduced-motion: reduce` block is present.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const CSS_PATH = join(import.meta.dir, "record-view.css");
const HLJS_PATH = join(import.meta.dir, "hljs-tokens.css");

/**
 * Authoritative list of `record-view-*` classes emitted by the components,
 * client dispatcher, and render-viewer (SPEC §3). Maintained as a fixture so
 * the guard catches drift. Excludes:
 *   - `record-view-editable-field` — a CONTAINER_SELECTOR hook the dispatcher
 *     queries, never emitted as a class attribute (no visual element).
 *   - `record-view-markdown-raw` — appears only in a negative test assertion;
 *     never emitted.
 */
const EMITTED_CLASSES: readonly string[] = [
  // §3.1 page roots
  "record-view-task-list-index",
  "record-view-task-page",
  "record-view-roadmap-index",
  "record-view-roadmap-theme",
  "record-view-backlog-index",
  "record-view-backlog-item",
  "record-view-not-found",
  // §3.2 index tables + counts
  "record-view-task-list-table",
  "record-view-task-list-index-count",
  "record-view-roadmap-index-table",
  "record-view-roadmap-index-count",
  "record-view-backlog-table",
  "record-view-backlog-index-count",
  // §3.3 per-record sections
  "record-view-task-description",
  "record-view-task-subtasks",
  "record-view-subtask-block",
  "record-view-subtask-description",
  "record-view-subtask-details",
  "record-view-subtask-details-label",
  "record-view-test-strategy",
  "record-view-priority-note",
  "record-view-status-note",
  "record-view-empty-subtasks",
  "record-view-roadmap-theme-description",
  "record-view-roadmap-theme-cross-doc-links",
  "record-view-roadmap-theme-notes",
  "record-view-roadmap-theme-linked-tasks",
  "record-view-roadmap-theme-linked-backlog",
  "record-view-backlog-header",
  "record-view-backlog-notes",
  "record-view-backlog-details",
  "record-view-backlog-test-strategy",
  "record-view-promotion-badge",
  "record-view-status-badge",
  "record-view-priority-badge",
  "record-view-blocked-banner",
  // backlog-ui-delete: whole-record delete affordance + confirm dialog
  "record-view-record-actions",
  "record-view-delete-button",
  "record-view-delete-overlay",
  "record-view-delete-panel",
  "record-view-delete-confirm",
  "record-view-delete-cancel",
  // backlog-ui-delete: whole-record delete affordance + confirm dialog
  "record-view-record-actions",
  "record-view-delete-button",
  "record-view-delete-overlay",
  "record-view-delete-panel",
  "record-view-delete-confirm",
  "record-view-delete-cancel",
  // §3.4 frontmatter card
  "record-view-frontmatter-card",
  "record-view-frontmatter-row",
  "record-view-frontmatter-label",
  "record-view-frontmatter-value",
  "record-view-field-value",
  // §3.5 nav strip
  "record-view-nav-strip",
  "record-view-nav-prev",
  "record-view-nav-index",
  "record-view-nav-next",
  // §3.6 links + broken-target
  "record-view-record-link",
  "record-view-doc-link",
  "record-view-broken-link",
  "record-view-broken-suffix",
  "record-view-page-top-warning",
  // §3.7 edit affordances + forms
  "record-view-pencil-button",
  "record-view-edit-form",
  "record-view-text-input",
  "record-view-textarea",
  "record-view-enum-dropdown",
  "record-view-array-comma-input",
  "record-view-save-button",
  "record-view-cancel-button",
  "record-view-save-cancel-controls",
  "record-view-inline-error",
  "record-view-doclink-table",
  "record-view-doclink-row",
  "record-view-doclink-path",
  "record-view-doclink-anchor",
  "record-view-doclink-raw",
  "record-view-doclink-add",
  "record-view-doclink-delete",
  "record-view-doclink-form",
  // §3.8 backlog filters + drag/rank
  "record-view-backlog-filters",
  "record-view-filter-select",
  "record-view-filter-label",
  "record-view-drag-cell",
  "record-view-rank-cell",
  "record-view-rank-value",
  // §3.9 empty / not-found
  "record-view-empty-ledger",
  "record-view-empty-filtered",
  // OQ-3 theme picker toolbar (emitted by wrapHtml + ThemePicker)
  "record-view-toolbar",
  "record-view-theme-picker",
  // §3.10 markdown body
  "record-view-markdown-body",
  "record-view-details",
  "record-view-details-prose",
  "record-view-details-journal",
  "record-view-details-journal-label",
  "record-view-details-journal-ts",
  "record-view-details-journal-body",
];

async function readCss(path: string): Promise<string> {
  return Bun.file(path).text();
}

describe("record-view.css — selector coverage guard (SV-54)", () => {
  test("every emitted record-view-* class has at least one matching rule", async () => {
    const css = await readCss(CSS_PATH);
    const missing: string[] = [];
    for (const cls of EMITTED_CLASSES) {
      // Match `.<class>` as a whole token (followed by a non class-char), so
      // `record-view-details` does NOT spuriously satisfy
      // `record-view-details-prose` and vice-versa.
      const re = new RegExp(
        "\\." + cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\w-])",
      );
      if (!re.test(css)) missing.push(cls);
    }
    expect(missing).toEqual([]);
  });

  test("fixture itself is non-trivial (guards against an empty list)", () => {
    expect(EMITTED_CLASSES.length).toBeGreaterThan(60);
  });
});

describe("record-view.css — accessibility guards (SV-55, SV-56)", () => {
  test("contains no outline:none / outline:0 (focus-ring guard, SV-55)", async () => {
    const css = await readCss(CSS_PATH);
    expect(css).not.toMatch(/outline\s*:\s*none/i);
    expect(css).not.toMatch(/outline\s*:\s*0(?![\w.])/i);
  });

  test("contains a prefers-reduced-motion: reduce block (SV-56)", async () => {
    const css = await readCss(CSS_PATH);
    expect(css).toMatch(/prefers-reduced-motion\s*:\s*reduce/);
  });
});

describe("record-view.css — token discipline (SV-1)", () => {
  test("no raw #hex literals outside color-mix derivations or the print sheet", async () => {
    // record-view.css must drive colour through tokens. (The GitHub-alert /
    // directive literals are pre-existing in theme.base.css, out of scope.)
    const css = await readCss(CSS_PATH);
    const hexes = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hexes).toEqual([]);
  });
});

describe("hljs-tokens.css — theme-neutral palette (OQ-1 Option B)", () => {
  test("colours hljs tokens via theme custom properties, not hardcoded hex", async () => {
    const css = await readCss(HLJS_PATH);
    expect(css).toContain(".hljs-keyword");
    expect(css).toContain("var(--primary)");
    // No baked palette (would fight the active theme).
    const hexes = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hexes).toEqual([]);
  });
});
