/**
 * task-view progressive-enhancement client (ID-20.24).
 *
 * Replaces the 20.6 placeholder stub. This is NOT a React mount — it is
 * a GENERIC delegated event dispatcher attached at document level. It
 * reads the SSR `data-*` hooks the record views emit and wires the
 * open → edit → save → classify → in-place-DOM-update loop against the
 * patch-server, WITHOUT a full reload and WITHOUT serialising any record
 * data into the page (no hydration-mismatch surface; matches the
 * render-viewer.tsx promise that the SSR markup "carries every data-*
 * hook those components emit so the eventual hydration layer can attach
 * without a re-render").
 *
 * Build: bundled at server boot by packages/server/client-bundle.ts via
 * Bun.build and inlined into wrapHtml's <script>. No committed dist
 * artifact; no separate dev server (PRODUCT inv 44).
 *
 * Wired consumer in 20.24: the Backlog-index rank pencil
 * (data-edit-kind="integer-nullable", data-edit-field="items>{id}>rank").
 *
 * DOM-construction safety: all DOM is built with createElement +
 * textContent + appendChild. No innerHTML anywhere — node snapshots for
 * cancel/restore are captured as detached clones, not HTML strings — so
 * there is no string-to-HTML parse surface and no XSS vector.
 *
 * EXTENSIBILITY (ID-20.25): the dispatcher keys ALL behaviour on the
 * stable hooks (data-edit-action / data-edit-kind / data-edit-field /
 * data-record-id / data-record-kind) and handles every DispatchKind. When
 * 20.25 mounts the dead edit-affordances.tsx form primitives (text /
 * textarea / enum / array-comma / doc-links) into the per-record views,
 * those affordances carry the same hooks and Just Work here — zero client
 * changes.
 *
 * ID-20.27: adds the `doc-links` branch to buildEditForm, collectDocLinks
 * helper for saveEditor, and handleDocLinkAction for the add/delete row
 * interactions. The raw-value is a JSON string of DocLink[] (parsed in
 * openEditor when kind === "doc-links"). Full-array REPLACEMENT per
 * TECH §5.1 + PRODUCT inv 34-35.
 */
// NB: relative imports (NOT the `@task-view/ui` workspace alias) so
// `Bun.build` resolves the entry purely by filesystem path regardless of
// runner context. The alias resolves fine under `vite`/`bun run` but
// `Bun.build` invoked from inside `bun test` fails to resolve the
// workspace subpath, returning an empty-log build failure. Relative
// paths are runner-agnostic.
// NB: hljs (OQ-1 client-side syntax highlighting) is imported via the
// packages/ui re-export shim, NOT the bare `highlight.js` specifier. The
// package is reachable only under packages/ui/node_modules (no root hoist), so
// a bare import from this entry's location fails BOTH when `bun test` loads
// this module directly AND when Bun.build bundles it. The shim (inside
// packages/ui) fixes the direct-import path; client-bundle.ts's onResolve
// plugin fixes the Bun.build path. Same runner-agnostic spirit as the relative
// edit-dispatch imports below.
import hljs from "../../../packages/ui/record-view/hljs";
import {
  buildDeleteRequest,
  buildMultiPatchRequest,
  buildPatchForKind,
  buildPatchRequest,
  isDispatchKind,
  parseFieldPathAttr,
  recordDeletePath,
  recordPatchPath,
  type DispatchKind,
  type DocLinkRowInput,
} from "../../../packages/ui/record-view/edit-dispatch";
import {
  classifyDeleteResult,
  classifySaveResult,
  type DeleteOutcome,
} from "../../../packages/ui/record-view/edit-state";
import {
  buildDeleteConfirmMessage,
  findBacklogReferences,
  type BacklogReferences,
} from "../../../packages/ui/record-view/backlog-references";
import {
  recomputeTierRanks,
  type RankAssignment,
} from "../../../packages/ui/record-view/backlog-reorder";
import {
  applyThemeClassesToHtml,
  writeThemeCookie,
} from "../../../packages/ui/record-view/theme-client";
import {
  FILTER_ALL,
  nextSearchForFlag,
  nextSearchForQuery,
  nextSortForField,
} from "../../../packages/ui/record-view/url-state";

/** Selector for the container that holds both a value + its affordance. */
const CONTAINER_SELECTOR =
  "td, .record-view-editable-field, [data-edit-container]";

// ── mtime tracking (optimistic concurrency, TECH §5.4) ──────────────────────
//
// The viewer's baseMtime is fetched lazily from GET /api/ledger on first
// save (the SSR HTML does not embed it). After each successful PATCH we
// adopt the returned newMtime so subsequent edits use the latest base.

let baseMtime: string | null = null;

async function ensureBaseMtime(): Promise<string> {
  if (baseMtime !== null) return baseMtime;
  const res = await fetch("/api/ledger", {
    headers: { accept: "application/json" },
  });
  const body = (await res.json()) as { ok?: boolean; mtime?: string };
  if (!body.ok || typeof body.mtime !== "string") {
    throw new Error("could not resolve ledger mtime");
  }
  baseMtime = body.mtime;
  return baseMtime;
}

// ── DOM helpers ──────────────────────────────────────────────────────────────

/**
 * Resolve the record id for an affordance. Per-record pages carry a
 * page-level `data-record-id`; the Backlog `*-index` view carries the id
 * per row via `data-backlog-row="{id}"`.
 */
function resolveRecordId(el: Element): string | null {
  const host = el.closest<HTMLElement>("[data-record-id]");
  if (host) return host.getAttribute("data-record-id");
  const row = el.closest<HTMLElement>("[data-backlog-row]");
  return row?.getAttribute("data-backlog-row") ?? null;
}

/** The editable display container the affordance lives in (rank cell, etc.). */
function editContainer(el: Element): HTMLElement | null {
  return el.closest<HTMLElement>(CONTAINER_SELECTOR);
}

/** Detach every child of an element (innerHTML-free clear). */
function clearChildren(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Replace an element's children with a snapshot of cloned nodes. */
function restoreChildren(el: HTMLElement, snapshot: readonly Node[]): void {
  clearChildren(el);
  for (const node of snapshot) el.appendChild(node.cloneNode(true));
}

// ── Active-edit registry — one open editor at a time per container ───────────

interface ActiveEdit {
  container: HTMLElement;
  fieldPath: readonly string[];
  kind: DispatchKind;
  recordId: string;
  /** Cloned original child nodes, restored verbatim on cancel. */
  originalNodes: Node[];
  /**
   * The primary form input — used for all kinds EXCEPT `doc-links`, where
   * `collectDocLinks()` reads the full row table instead. For `doc-links`,
   * this is a hidden sentinel `<input>` (value always "") to satisfy the
   * type without branching every consumer.
   */
  input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  /**
   * ID-20.28: re-edit hook stash. Captured at openEditor time so
   * commitDisplay can write them back onto the rebuilt pencil after a
   * successful save — otherwise a same-session re-edit loses its editor
   * state (enum options empty; textarea/array-comma falls back to rendered
   * display text instead of raw source).
   *
   * - `options`: the raw `data-edit-options` string for enum / enum-nullable
   *   kinds (comma-separated literals). Absent for all other kinds.
   * - `rawValue`: the raw `data-edit-raw-value` string for textarea /
   *   array-comma / doc-links kinds (raw Markdown source, comma-joined ids,
   *   or JSON-serialised DocLink[]). Absent for kinds that don't emit it
   *   (text / integer / rank).
   */
  options: string | null;
  rawValue: string | null;
}

const activeEdits = new Map<HTMLElement, ActiveEdit>();

// ── Open: replace the display with an input form ─────────────────────────────

function openEditor(openButton: HTMLElement): void {
  const fieldAttr = openButton.getAttribute("data-edit-field");
  const fieldPath = parseFieldPathAttr(fieldAttr);
  if (!fieldPath) return;

  const kindAttr = openButton.getAttribute("data-edit-kind");
  const kind: DispatchKind = isDispatchKind(kindAttr) ? kindAttr : "text";

  const recordId = resolveRecordId(openButton);
  if (!recordId) return;

  const container = editContainer(openButton);
  if (!container || activeEdits.has(container)) return;

  const originalNodes = Array.from(container.childNodes).map((n) =>
    n.cloneNode(true),
  );
  // ID-20.25: prefer the raw-source hook on the affordance so textarea
  // fields (description / details / notes) pre-populate with the RAW
  // Markdown source — incl. `<info added on …>` journal blocks — rather
  // than the rendered textContent (PRODUCT inv 27-28). Falls back to the
  // existing rank/textContent resolution when the hook is absent.
  const rawValueAttr = openButton.getAttribute("data-edit-raw-value");
  const currentValue =
    rawValueAttr !== null ? rawValueAttr : readDisplayedValue(container);

  // ID-20.25: enum affordances carry their allowed values on a
  // `data-edit-options` hook (comma-separated enum literals — every enum
  // value is a simple token with no comma, so comma is a safe delimiter).
  // The dispatcher builds the `<select>` from these (inv 31), with every
  // value selectable (inv 32 — no state-machine gating).
  const optionsAttr = openButton.getAttribute("data-edit-options");

  // ID-20.27: doc-links raw-value is a JSON string of DocLink[]. Parse it
  // here so buildEditForm receives the structured array. Falls back to []
  // when the JSON is absent or malformed (defensive; the SSR always emits
  // valid JSON from JSON.stringify).
  let parsedDocLinks: DocLinkRowInput[] = [];
  if (kind === "doc-links" && rawValueAttr !== null) {
    try {
      const parsed = JSON.parse(rawValueAttr) as unknown;
      if (Array.isArray(parsed)) {
        parsedDocLinks = parsed as DocLinkRowInput[];
      }
    } catch {
      // malformed JSON → start with empty array
    }
  }

  const { wrapper, input } = buildEditForm(
    kind,
    fieldAttr ?? "",
    currentValue,
    optionsAttr,
    parsedDocLinks,
  );
  clearChildren(container);
  container.appendChild(wrapper);
  input.focus();
  if ("select" in input && typeof input.select === "function") input.select();

  // ID-20.28: stash re-edit hooks so commitDisplay can write them back onto
  // the rebuilt pencil after a successful save (same-session re-edit support).
  activeEdits.set(container, {
    container,
    fieldPath,
    kind,
    recordId,
    originalNodes,
    input,
    options: optionsAttr,
    rawValue: rawValueAttr,
  });
}

/**
 * Read the current displayed value so the input pre-populates. Resolution
 * order:
 *   1. The authoritative `data-rank-value` hook on the rank cell (empty
 *      string = unset) — the 20.24 Backlog rank path.
 *   2. ID-20.25: a dedicated `.record-view-field-value` span (emitted by
 *      the frontmatter card around editable values) so the pencil glyph
 *      `✎` does NOT contaminate the value — critical for enum current
 *      value, which must match an `<option>` exactly to pre-select.
 *   3. The `.record-view-rank-value` span (20.24).
 *   4. Trimmed `container.textContent`.
 * The "—" unset glyph is normalised to "" in the span / textContent
 * fallbacks.
 */
function readDisplayedValue(container: HTMLElement): string {
  const rankHost =
    container.closest<HTMLElement>("[data-rank-value]") ?? container;
  const rankAttr = rankHost.getAttribute("data-rank-value");
  if (rankAttr !== null) return rankAttr; // "" when unset
  const fieldSpan = container.querySelector(".record-view-field-value");
  const valueSpan =
    fieldSpan ?? container.querySelector(".record-view-rank-value");
  const text = (valueSpan?.textContent ?? container.textContent ?? "").trim();
  return text === "—" ? "" : text;
}

/**
 * Build the on-demand edit form for a kind. Returns wrapper + the input.
 *
 * ID-20.27: for `doc-links`, `parsedDocLinks` carries the pre-populated
 * array (from the JSON raw-value). The form is a `<table>` of rows; the
 * returned `input` is a hidden sentinel (value ""), because the save path
 * collects data via `collectDocLinks()` instead of reading `input.value`.
 */
function buildEditForm(
  kind: DispatchKind,
  fieldAttr: string,
  currentValue: string,
  optionsAttr?: string | null,
  parsedDocLinks?: DocLinkRowInput[],
): {
  wrapper: HTMLFormElement;
  input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
} {
  const form = document.createElement("form");
  form.className = "record-view-edit-form";
  form.setAttribute("data-edit-form", "");
  form.setAttribute("data-edit-field", fieldAttr);
  form.setAttribute("data-edit-kind", kind);

  let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

  if (kind === "doc-links") {
    // ID-20.27 — multi-row doc-links editor (PRODUCT inv 35).
    // Build a <table> with one row per existing link + Add/Delete controls.
    // The sentinel <input> satisfies the ActiveEdit.input type without
    // being visible or focussed — data flows through collectDocLinks() on save.
    const table = document.createElement("table");
    table.className = "record-view-doclink-table";

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    for (const label of ["Path", "Anchor", "Raw", ""]) {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = label;
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    tbody.setAttribute("data-doclink-rows", "");
    table.appendChild(tbody);
    form.appendChild(table);

    // Populate existing rows from parsedDocLinks
    const links = parsedDocLinks ?? [];
    links.forEach((link, i) => {
      tbody.appendChild(buildDocLinkRow(i, link.path, link.anchor ?? "", link.raw));
    });

    // "Add link" button — appends a fresh blank row via delegated click
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "record-view-doclink-add";
    addBtn.setAttribute("data-doclink-action", "add");
    addBtn.textContent = "Add link";
    form.appendChild(addBtn);

    // Hidden sentinel satisfies ActiveEdit.input
    const sentinel = document.createElement("input");
    sentinel.type = "hidden";
    sentinel.value = "";
    sentinel.setAttribute("data-edit-input", "");
    sentinel.setAttribute("data-edit-field", fieldAttr);
    sentinel.setAttribute("data-keyboard-shortcut", "cmd-enter,esc");
    form.appendChild(sentinel);
    input = sentinel;
  } else if (kind === "textarea") {
    const ta = document.createElement("textarea");
    ta.className = "record-view-textarea";
    ta.rows = 4;
    ta.value = currentValue;
    ta.addEventListener("input", () => autosize(ta));
    input = ta;
    input.setAttribute("data-edit-input", "");
    input.setAttribute("data-edit-field", fieldAttr);
    input.setAttribute("data-keyboard-shortcut", "cmd-enter,esc");
    form.appendChild(input);
  } else if (kind === "enum" || kind === "enum-nullable") {
    // ID-20.25: enum dropdown built from the `data-edit-options` hook
    // (PRODUCT inv 30-32). For `enum-nullable` an empty-value "(unset)"
    // sentinel is prepended; `buildPatchForKind` serialises that ""
    // back to `null` on save. Every option is selectable regardless of
    // the current value (inv 32 — no state-machine transition gating).
    const select = document.createElement("select");
    select.className = "record-view-enum-dropdown";
    if (kind === "enum-nullable") {
      const unset = document.createElement("option");
      unset.value = "";
      unset.setAttribute("data-nullable-sentinel", "");
      unset.textContent = "(unset)";
      select.appendChild(unset);
    }
    for (const opt of parseOptionsAttr(optionsAttr)) {
      const option = document.createElement("option");
      option.value = opt;
      option.textContent = opt;
      select.appendChild(option);
    }
    // Pre-select the current value. happy-dom + browsers both honour
    // assigning `.value` to the matching option; when no option matches
    // (e.g. an unset nullable), the empty sentinel stays selected.
    select.value = currentValue;
    input = select;
    input.setAttribute("data-edit-input", "");
    input.setAttribute("data-edit-field", fieldAttr);
    input.setAttribute("data-keyboard-shortcut", "cmd-enter,esc");
    form.appendChild(input);
  } else {
    const el = document.createElement("input");
    el.type =
      kind === "integer" || kind === "integer-nullable" ? "number" : "text";
    el.className = "record-view-text-input";
    el.value = currentValue;
    input = el;
    input.setAttribute("data-edit-input", "");
    input.setAttribute("data-edit-field", fieldAttr);
    input.setAttribute("data-keyboard-shortcut", "cmd-enter,esc");
    form.appendChild(input);
  }

  form.appendChild(makeActionButton("save", "Save", "record-view-save-button", fieldAttr));
  form.appendChild(
    makeActionButton("cancel", "Cancel", "record-view-cancel-button", fieldAttr),
  );
  return { wrapper: form, input };
}

/**
 * Build a single doc-link row `<tr>` with 3 text inputs (path / anchor /
 * raw) + a Delete button. Uses createElement + .value — no innerHTML.
 *
 * ID-20.27: `data-doclink-row-index` is the row's position in the tbody
 * at append time; when rows are deleted the indices are reassigned via
 * `renumberDocLinkRows()`.
 */
function buildDocLinkRow(
  index: number,
  path: string,
  anchor: string,
  raw: string,
): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.className = "record-view-doclink-row";
  tr.setAttribute("data-doclink-row-index", String(index));

  for (const [field, val] of [
    ["path", path],
    ["anchor", anchor],
    ["raw", raw],
  ] as const) {
    const td = document.createElement("td");
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = `record-view-doclink-${field}`;
    inp.setAttribute("data-doclink-field", field);
    inp.setAttribute("data-doclink-row-index", String(index));
    inp.value = val;
    td.appendChild(inp);
    tr.appendChild(td);
  }

  // Delete button
  const deleteTd = document.createElement("td");
  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "record-view-doclink-delete";
  deleteBtn.setAttribute("data-doclink-action", "delete");
  deleteBtn.setAttribute("data-doclink-row-index", String(index));
  deleteBtn.setAttribute("aria-label", `Delete cross-doc link ${index + 1}`);
  deleteBtn.textContent = "Delete";
  deleteTd.appendChild(deleteBtn);
  tr.appendChild(deleteTd);

  return tr;
}

/**
 * Re-number all rows in a doc-links `<tbody>` after an add or delete.
 * Updates `data-doclink-row-index` on the `<tr>` and all its child inputs
 * + delete button so the indices stay contiguous.
 */
function renumberDocLinkRows(tbody: HTMLElement): void {
  const rows = Array.from(tbody.querySelectorAll<HTMLElement>("tr[data-doclink-row-index]"));
  rows.forEach((row, i) => {
    row.setAttribute("data-doclink-row-index", String(i));
    row.querySelectorAll<HTMLElement>("[data-doclink-row-index]").forEach((el) => {
      el.setAttribute("data-doclink-row-index", String(i));
    });
  });
}

/**
 * Collect the current doc-link rows from a form into a DocLinkRowInput[].
 * Reads `data-doclink-row-index` + `data-doclink-field` from inputs;
 * empty anchor → null per the affordance contract.
 *
 * ID-20.27: called by saveEditor when kind === "doc-links". Produces the
 * exact array shape `buildPatchForKind`'s doc-links case expects.
 */
function collectDocLinks(
  form: HTMLElement,
): DocLinkRowInput[] {
  const tbody = form.querySelector<HTMLElement>("[data-doclink-rows]");
  if (!tbody) return [];

  const rows = Array.from(
    tbody.querySelectorAll<HTMLElement>("tr[data-doclink-row-index]"),
  );
  return rows.map((row) => {
    const pathInput = row.querySelector<HTMLInputElement>('[data-doclink-field="path"]');
    const anchorInput = row.querySelector<HTMLInputElement>('[data-doclink-field="anchor"]');
    const rawInput = row.querySelector<HTMLInputElement>('[data-doclink-field="raw"]');
    const anchor = anchorInput?.value ?? "";
    return {
      path: pathInput?.value ?? "",
      anchor: anchor === "" ? null : anchor,
      raw: rawInput?.value ?? "",
    };
  });
}

/**
 * Handle add / delete row actions on a doc-links form.
 * Called from onClick when `data-doclink-action` is present.
 */
function handleDocLinkAction(target: HTMLElement): void {
  const form = target.closest<HTMLElement>("form.record-view-edit-form");
  if (!form) return;
  const tbody = form.querySelector<HTMLElement>("[data-doclink-rows]");
  if (!tbody) return;

  const action = target.getAttribute("data-doclink-action");
  if (action === "add") {
    const rowCount = tbody.querySelectorAll("tr[data-doclink-row-index]").length;
    tbody.appendChild(buildDocLinkRow(rowCount, "", "", ""));
  } else if (action === "delete") {
    const rowIndex = target.getAttribute("data-doclink-row-index");
    const row = tbody.querySelector<HTMLElement>(
      `tr[data-doclink-row-index="${rowIndex}"]`,
    );
    if (row) {
      tbody.removeChild(row);
      renumberDocLinkRows(tbody);
    }
  }
}

function makeActionButton(
  action: "save" | "cancel" | "open",
  label: string,
  className: string,
  fieldAttr: string,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.setAttribute("data-edit-action", action);
  btn.setAttribute("data-edit-field", fieldAttr);
  btn.textContent = label;
  return btn;
}

function autosize(ta: HTMLTextAreaElement): void {
  ta.style.height = "auto";
  ta.style.height = `${ta.scrollHeight}px`;
}

/**
 * Parse the `data-edit-options` hook into the list of enum literals.
 * Comma-separated (enum values are simple tokens — no commas); empty
 * entries are dropped. An absent/empty attr yields no options (the
 * `<select>` then carries only the nullable sentinel, if any).
 */
function parseOptionsAttr(attr: string | null | undefined): string[] {
  if (typeof attr !== "string" || attr === "") return [];
  return attr
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ── Cancel: restore original display ─────────────────────────────────────────

function cancelEditor(container: HTMLElement): void {
  const active = activeEdits.get(container);
  if (!active) return;
  restoreChildren(container, active.originalNodes);
  activeEdits.delete(container);
}

// ── Save: build patch, PATCH, classify, re-render in place ───────────────────

async function saveEditor(container: HTMLElement): Promise<void> {
  const active = activeEdits.get(container);
  if (!active) return;
  clearInlineError(container);

  // ID-20.27: doc-links kind collects structured rows instead of reading
  // a single input.value — full-array replacement per TECH §5.1 + inv 34-35.
  let rawValue: string | readonly DocLinkRowInput[];
  if (active.kind === "doc-links") {
    const form = container.querySelector<HTMLElement>("form.record-view-edit-form");
    rawValue = form ? collectDocLinks(form) : [];
  } else {
    rawValue = active.input.value;
  }
  const patch = buildPatchForKind(active.kind, active.fieldPath, rawValue);

  let base: string;
  try {
    base = await ensureBaseMtime();
  } catch (err) {
    renderInlineError(container, active, (err as Error).message);
    return;
  }
  const body = buildPatchRequest(patch, base);

  let json: unknown;
  try {
    const res = await fetch(recordPatchPath(active.recordId), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    json = await res.json();
  } catch (err) {
    renderInlineError(
      container,
      active,
      `Network error: ${(err as Error).message}`,
    );
    return;
  }

  const outcome = classifySaveResult(json);
  switch (outcome.kind) {
    case "ok":
    case "mirror-regen-failed": {
      // Both persisted the canonical → adopt newMtime + re-render the
      // value in place. mirror-regen-failed is SOFT (TECH §5.4): mirrors
      // may be stale but the edit landed.
      if (outcome.newMtime) baseMtime = outcome.newMtime;
      commitDisplay(container, active, rawValue);
      activeEdits.delete(container);
      break;
    }
    case "schema-error":
    case "walk-error":
      // Inline error; form stays open with the user's draft (PRODUCT inv 29).
      renderInlineError(container, active, outcome.message);
      break;
    case "mtime-conflict":
      // 409 — canonical NOT mutated. Show the conflict hint inline; keep
      // the draft. Re-base so a retry can succeed (PRODUCT inv 37).
      if (outcome.currentMtime) baseMtime = outcome.currentMtime;
      renderInlineError(container, active, outcome.message);
      break;
    case "network-error":
      renderInlineError(container, active, outcome.message);
      break;
  }
}

/**
 * Replace the editor with the new value display + a fresh pencil.
 *
 * ID-20.27: for `doc-links`, rawSaved is the collected DocLink[]. The
 * display shows the `raw` labels joined by ", " (the same text the SSR
 * originally rendered); the pencil's `data-edit-raw-value` is updated to
 * the serialised JSON of the new array so a re-open pre-fills correctly.
 *
 * ID-20.28: for all other kinds, the rebuilt pencil re-emits the re-edit
 * hooks that the original SSR FieldPencil carried:
 *   - enum / enum-nullable → `data-edit-options` (the options string stashed
 *     on ActiveEdit at openEditor time) so a second open builds the <select>
 *     with all options, not an empty one.
 *   - textarea / array-comma → `data-edit-raw-value` = the just-saved raw
 *     string so a re-open pre-fills with the raw source (incl. Markdown /
 *     journal blocks), not the rendered display text.
 */
function commitDisplay(
  container: HTMLElement,
  active: ActiveEdit,
  rawSaved: string | readonly DocLinkRowInput[],
): void {
  const fieldAttr = active.fieldPath.join(">");
  clearChildren(container);

  const valueSpan = document.createElement("span");
  const pencil = document.createElement("button");

  if (active.kind === "doc-links") {
    // Build the post-save display for doc-links.
    const links = Array.isArray(rawSaved) ? (rawSaved as readonly DocLinkRowInput[]) : [];
    const displayText =
      links.length === 0 ? "—" : links.map((l) => l.raw).join(", ");
    valueSpan.className = "record-view-field-value";
    valueSpan.textContent = displayText;

    pencil.type = "button";
    pencil.className = "record-view-pencil-button";
    pencil.setAttribute("data-edit-action", "open");
    pencil.setAttribute("data-edit-field", fieldAttr);
    pencil.setAttribute("data-edit-kind", "doc-links");
    // Update the raw-value hook so a re-open uses the new saved JSON.
    pencil.setAttribute("data-edit-raw-value", JSON.stringify(links));
    pencil.setAttribute("aria-label", "Edit");
  } else {
    const rawStr = typeof rawSaved === "string" ? rawSaved : "";
    const trimmed = rawStr.trim();
    const display = trimmed === "" ? "—" : trimmed;
    // Update the authoritative rank-value hook when present so a re-open
    // reads the new value.
    const rankHost =
      container.closest<HTMLElement>("[data-rank-value]") ?? container;
    if (rankHost.hasAttribute("data-rank-value")) {
      rankHost.setAttribute("data-rank-value", trimmed);
      // rank cells use the legacy class; all other editable fields use the
      // neutral record-view-field-value class (ID-20.28 nit).
      valueSpan.className = "record-view-rank-value";
    } else {
      valueSpan.className = "record-view-field-value";
    }
    valueSpan.textContent = display;

    pencil.type = "button";
    pencil.className = "record-view-pencil-button";
    pencil.setAttribute("data-edit-action", "open");
    pencil.setAttribute("data-edit-field", fieldAttr);
    pencil.setAttribute("data-edit-kind", active.kind);
    pencil.setAttribute("aria-label", "Edit");

    // ID-20.28: re-emit re-edit hooks so a same-session second edit works
    // correctly (enum options not lost; textarea/array-comma raw source
    // preserved instead of falling back to rendered display text).
    if (active.options !== null) {
      pencil.setAttribute("data-edit-options", active.options);
    }
    // For textarea / array-comma: use the just-saved raw string as the new
    // raw-value (it IS the canonical source after the PATCH succeeded).
    // For doc-links: handled in the if-branch above.
    // For text / integer / rank: rawValue is null → no hook emitted (correct).
    if (
      active.kind === "textarea" ||
      active.kind === "array-comma" ||
      active.kind === "array-comma-number"
    ) {
      pencil.setAttribute("data-edit-raw-value", rawStr);
    } else if (active.rawValue !== null) {
      // Preserve any other stashed rawValue (defensive; no current consumer).
      pencil.setAttribute("data-edit-raw-value", active.rawValue);
    }
  }

  const glyph = document.createElement("span");
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = "✎";
  pencil.appendChild(glyph);

  container.appendChild(valueSpan);
  container.appendChild(pencil);
}

function renderInlineError(
  container: HTMLElement,
  active: ActiveEdit,
  message: string,
): void {
  clearInlineError(container);
  const p = document.createElement("p");
  p.className = "record-view-inline-error";
  p.setAttribute("data-edit-error", "");
  p.setAttribute("data-edit-field", active.fieldPath.join(">"));
  p.setAttribute("role", "alert");
  p.textContent = message;
  const form = container.querySelector("form.record-view-edit-form");
  (form ?? container).appendChild(p);
}

function clearInlineError(container: HTMLElement): void {
  container.querySelectorAll("[data-edit-error]").forEach((n) => n.remove());
}

// ── Whole-record delete (backlog-ui-delete) ──────────────────────────────────
//
// The SSR emits a `[data-delete-action]` button on the Backlog item page
// (inside the page-level `[data-record-id]` article) and one per index row
// (inside `[data-backlog-row]`). The delegated `onClick` routes both here. The
// flow is intentionally thin — all logic lives in the tested pure helpers
// (`findBacklogReferences` / `buildDeleteConfirmMessage` / `recordDeletePath` /
// `buildDeleteRequest` / `classifyDeleteResult`); this shell only does DOM:
//
//   1. Scan the ACTIVE ledger (GET /api/ledger → `data.items`) for backlog
//      dependents the deletion would orphan, build the confirm prompt.
//   2. Show a DOM-built confirm dialog (createElement + textContent — NO
//      innerHTML, matching this file's strict convention). Cancel aborts.
//   3. DELETE /api/ledger/record/:id with `{ baseMtime }`. The server
//      regenerates mirrors internally on success — we do NOT fire a separate
//      /api/ledger/regen.
//   4. Route `classifyDeleteResult`:
//        - ok (incl. SOFT mirror-regen-failed): adopt newMtime; on the index
//          remove the `<tr>` + decrement the "Showing N of M" count; on the
//          per-item page redirect to `/` (the backlog index).
//        - mtime-conflict (409): adopt currentMtime; surface a page banner.
//        - not-found (404): the row is already gone — drop it on the index;
//          on the item page redirect (it no longer exists).
//        - schema-error / network-error: surface a page banner.

/**
 * Fetch the active ledger's backlog references for `id`. Returns an empty
 * (no-references) scan when the ledger fetch fails or the active ledger is
 * not the backlog — the confirm still proceeds, just without the orphan
 * warning (the core delete must never be blocked by a soft warning fetch).
 *
 * GET /api/ledger returns only the ACTIVE ledger, so cross-ledger roadmap
 * `linked_backlog` refs are not covered here (the pure helper supports them;
 * the sibling roadmap is simply not on the page). See the follow-up note.
 */
async function scanBacklogReferences(id: string): Promise<BacklogReferences> {
  const empty: BacklogReferences = {
    dependents: [],
    themes: [],
    hasReferences: false,
  };
  try {
    const res = await fetch("/api/ledger", {
      headers: { accept: "application/json" },
    });
    const body = (await res.json()) as {
      ok?: boolean;
      kind?: unknown;
      data?: { items?: unknown };
    };
    if (!body.ok || body.kind !== "backlog") return empty;
    const items = Array.isArray(body.data?.items) ? body.data.items : [];
    // The pure helper only reads `.id` + `.dependencies` off each item; the
    // wire JSON carries those, so the cast is safe for the scan.
    return findBacklogReferences(id, {
      items: items as BacklogReferences["dependents"],
    });
  } catch {
    return empty;
  }
}

/**
 * Surface a page-level delete error banner (mirrors `saveEditor`'s inline
 * error, but the delete affordance has no field container to attach to). A
 * single reusable `[data-delete-error]` alert is inserted at the top of the
 * record article / table region. Built with createElement + textContent.
 */
function setDeleteError(anchor: Element, message: string): void {
  const host =
    anchor.closest<HTMLElement>("[data-record-kind]") ??
    document.body;
  let el = host.querySelector<HTMLElement>("[data-delete-error]");
  if (!el) {
    el = document.createElement("p");
    el.setAttribute("data-delete-error", "");
    el.setAttribute("role", "alert");
    el.className = "record-view-inline-error";
    host.insertBefore(el, host.firstChild);
  }
  el.textContent = message;
}

/**
 * Remove the deleted row from the Backlog index `<tr>` and decrement the
 * "Showing N of M" count using the authoritative `data-item-count` /
 * `data-item-total` hooks (no rendered-text re-parse). No-op off the index.
 */
function removeIndexRow(id: string): void {
  const row = document.querySelector<HTMLElement>(
    `[data-backlog-row="${CSS.escape(id)}"]`,
  );
  if (row) row.remove();

  const count = document.querySelector<HTMLElement>(
    "[data-item-count][data-item-total]",
  );
  if (!count) return;
  const shown = Number(count.getAttribute("data-item-count"));
  const total = Number(count.getAttribute("data-item-total"));
  const nextShown = Number.isFinite(shown) ? Math.max(0, shown - 1) : 0;
  const nextTotal = Number.isFinite(total) ? Math.max(0, total - 1) : 0;
  count.setAttribute("data-item-count", String(nextShown));
  count.setAttribute("data-item-total", String(nextTotal));
  count.textContent = `Showing ${nextShown} of ${nextTotal} items`;
}

/** True when the delete affordance lives on a per-item page (not the index). */
function isItemPage(anchor: Element): boolean {
  return anchor.closest('[data-record-kind="backlog-item"]') !== null;
}

/**
 * Build + mount the confirm dialog. Resolves true if the user confirms,
 * false if they cancel (or dismiss via the overlay / Escape). All DOM is
 * createElement + textContent — no innerHTML.
 */
function confirmDelete(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "record-view-delete-overlay";
    overlay.setAttribute("data-delete-overlay", "");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");

    const panel = document.createElement("div");
    panel.className = "record-view-delete-panel";

    const prompt = document.createElement("p");
    prompt.className = "record-view-delete-warning";
    prompt.textContent = message;
    panel.appendChild(prompt);

    const actions = document.createElement("div");
    actions.className = "record-view-delete-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "record-view-delete-cancel";
    cancelBtn.textContent = "Cancel";

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "record-view-delete-confirm";
    confirmBtn.textContent = "Delete";

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    panel.appendChild(actions);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    confirmBtn.focus();

    const close = (result: boolean): void => {
      overlay.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(result);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(false);
      }
    };
    cancelBtn.addEventListener("click", () => close(false));
    confirmBtn.addEventListener("click", () => close(true));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(false);
    });
    overlay.addEventListener("keydown", onKey);
  });
}

/**
 * Drive the whole delete flow for a `[data-delete-action]` button. Banner-
 * guarded by the caller; this assumes an editable (launched) ledger.
 */
async function deleteBacklogRecord(button: HTMLElement): Promise<void> {
  const recordId = resolveRecordId(button);
  if (!recordId) return;

  const refs = await scanBacklogReferences(recordId);
  const confirmed = await confirmDelete(
    buildDeleteConfirmMessage(recordId, refs),
  );
  if (!confirmed) return;

  let base: string;
  try {
    base = await ensureBaseMtime();
  } catch (err) {
    setDeleteError(button, `Could not delete — ${(err as Error).message}.`);
    return;
  }

  let json: unknown;
  try {
    const res = await fetch(recordDeletePath(recordId), {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildDeleteRequest(base)),
    });
    json = await res.json();
  } catch (err) {
    setDeleteError(
      button,
      `Could not delete — network error: ${(err as Error).message}. Please retry.`,
    );
    return;
  }

  const outcome: DeleteOutcome = classifyDeleteResult(json);
  switch (outcome.kind) {
    case "ok":
      // Canonical persisted (mirror regen ran server-side; SOFT regen failure
      // collapses to ok). Adopt the new mtime so later edits re-base correctly.
      if (outcome.newMtime) baseMtime = outcome.newMtime;
      if (isItemPage(button)) {
        window.location.assign("/");
      } else {
        removeIndexRow(recordId);
      }
      break;
    case "not-found":
      // Already gone (concurrent delete / stale page). Reconcile the view: drop
      // the row on the index, leave the item page (it no longer exists).
      if (isItemPage(button)) {
        window.location.assign("/");
      } else {
        removeIndexRow(recordId);
      }
      break;
    case "mtime-conflict":
      // 409 — canonical NOT mutated. Adopt currentMtime so a retry can succeed.
      if (outcome.currentMtime) baseMtime = outcome.currentMtime;
      setDeleteError(button, outcome.message);
      break;
    case "schema-error":
    case "network-error":
      setDeleteError(button, outcome.message);
      break;
  }
}

// ── Delegated listeners ──────────────────────────────────────────────────────

function onClick(event: MouseEvent): void {
  const target = event.target as Element | null;
  if (!target) return;

  // ID-20.27: doc-link row actions (add / delete) are nested inside the
  // edit form and carry `data-doclink-action` rather than `data-edit-action`.
  // Check for these FIRST so they don't fall through to the edit-action handler.
  const doclinkEl = target.closest<HTMLElement>("[data-doclink-action]");
  if (doclinkEl) {
    event.preventDefault();
    handleDocLinkAction(doclinkEl);
    return;
  }

  // backlog-ui-delete: whole-record delete affordance. Banner-guarded
  // (defence-in-depth, same posture as wireBacklogReorder) — a read-only
  // sibling page never emits the button, but never wire a mutation on one
  // even if it somehow appears.
  const deleteEl = target.closest<HTMLElement>("[data-delete-action]");
  if (deleteEl) {
    event.preventDefault();
    if (document.querySelector("[data-ledger-banner]")) return;
    void deleteBacklogRecord(deleteEl);
    return;
  }

  const actionEl = target.closest<HTMLElement>("[data-edit-action]");
  if (!actionEl) return;
  const action = actionEl.getAttribute("data-edit-action");
  if (action === "open") {
    event.preventDefault();
    openEditor(actionEl);
    return;
  }
  const container = editContainer(actionEl);
  if (!container) return;
  if (action === "save") {
    event.preventDefault();
    void saveEditor(container);
  } else if (action === "cancel") {
    event.preventDefault();
    cancelEditor(container);
  }
}

function onKeydown(event: KeyboardEvent): void {
  const target = event.target as Element | null;
  if (!target) return;
  const form = target.closest<HTMLElement>("form.record-view-edit-form");
  if (!form) return;
  const container = editContainer(form);
  if (!container) return;
  // Cmd/Ctrl+Enter → save (PRODUCT inv 27).
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    void saveEditor(container);
  } else if (event.key === "Escape") {
    event.preventDefault();
    cancelEditor(container);
  }
}

// ── OQ-1: client-side syntax highlighting ────────────────────────────────────
//
// The SSR markdown emits `<pre><code class="hljs font-mono language-…">…</code>`
// (the React CodeBlock's useEffect hljs pass does NOT run during
// renderToStaticMarkup). Run hljs over those nodes once after DOM parse so
// code blocks gain real syntax highlighting. Colours come from the inlined
// theme-neutral hljs-tokens.css (token-driven), so they track the active
// theme. Base legibility (mono on --code-bg) holds even if this never runs.
function highlightCodeBlocks(): void {
  const nodes = document.querySelectorAll<HTMLElement>(
    ".record-view-markdown-body pre code, .record-view-details pre code",
  );
  nodes.forEach((node) => {
    // Idempotent: skip nodes hljs already processed.
    if (node.getAttribute("data-highlighted") === "yes") return;
    try {
      hljs.highlightElement(node);
    } catch {
      // A failed highlight must never break the page — leave the node as the
      // legible token-styled plaintext it already is.
    }
  });
}

// ── print.css integration: toggle `.task-view-print` on <html> ───────────────
//
// Plannotator's print.css uses a two-pronged approach (print.css:10-13):
// `@media print` rules PLUS a `.task-view-print` class added on
// beforeprint/afterprint for overrides that must beat the hljs theme colours.
// Mirror that mechanism here so the record-view prints cleanly.
function wirePrintClassToggle(): void {
  const root = document.documentElement;
  window.addEventListener("beforeprint", () => {
    root.classList.add("task-view-print");
  });
  window.addEventListener("afterprint", () => {
    root.classList.remove("task-view-print");
  });
}

// ── OQ-3: in-page theme picker ───────────────────────────────────────────────
//
// The nav strip carries a server-rendered <select data-theme-picker> wired to
// the SAME cookie keys ThemeProvider uses. On change we write the cookie +
// re-class <html> via the shared applyThemeClassesToHtml (no reload). Mode is
// kept at the current resolved value (dark unless the page is `.light`).
function wireThemePicker(): void {
  const picker = document.querySelector<HTMLSelectElement>("[data-theme-picker]");
  if (!picker) return;
  picker.addEventListener("change", () => {
    const themeId = picker.value;
    const mode = document.documentElement.classList.contains("light")
      ? "light"
      : "dark";
    writeThemeCookie(themeId, mode);
    applyThemeClassesToHtml(themeId, mode);
  });
}

// ── Backlog filter dropdowns (PRODUCT inv 23) ────────────────────────────────
//
// The SSR backlog index emits a `<form data-backlog-filters>` with three
// `<select data-filter-control="track|status|priority">` controls plus a
// `<noscript>` submit button. The server already decodes `?track=&status=
// &priority=` via `decodeBacklogFilters` and filters the table — but with JS
// enabled the `<noscript>` button is absent AND a native `<select>` change does
// NOT submit a GET form on its own, so the dropdowns were inert (the bug).
//
// On change we rebuild the query string from ALL three selects and navigate;
// the SSR re-renders the filtered table and the URL stays bookmarkable /
// shareable (inv 23). FILTER_ALL / empty is the canonical "no filter" → the
// key is dropped so the URL stays minimal (matches `encodeBacklogFilters`).
// Non-filter params already on the URL (e.g. a cross-ledger `?ledger=` slug)
// are preserved. Mirrors `wireThemePicker`'s feature-detect + change pattern.
function wireBacklogFilters(): void {
  const form = document.querySelector<HTMLFormElement>("[data-backlog-filters]");
  if (!form) return;
  const selects = Array.from(
    form.querySelectorAll<HTMLSelectElement>("select[data-filter-control]"),
  );
  if (selects.length === 0) return;

  function applyFilters(): void {
    const params = new URLSearchParams(window.location.search);
    for (const select of selects) {
      const name = select.getAttribute("data-filter-control");
      if (!name) continue;
      if (select.value === FILTER_ALL || select.value === "") {
        params.delete(name);
      } else {
        params.set(name, select.value);
      }
    }
    // Assigning location.search triggers a navigation + SSR re-render. An empty
    // string drops the query entirely (all filters cleared); assigning the
    // current value is a no-op, so a redundant re-select never reloads.
    window.location.search = params.toString();
  }

  for (const select of selects) {
    select.addEventListener("change", applyFilters);
  }
}

// ── Index keyword search (PRODUCT inv 23 — URL-reflected) ─────────────────────
//
// Each index page renders a `<form data-index-search>` carrying an
// `<input type="search" data-search-control name="q">`. The server already
// decodes `?q=` and filters the list — but a native search input does not
// navigate on its own. On change (Enter / blur) or submit we rebuild the query
// string via `nextSearchForQuery` (set/clear `q`, PRESERVING every other param
// — filters, `?ledger=`, sort) and navigate; the SSR re-renders the filtered
// list and the URL stays bookmarkable / shareable (inv 23). Keyed off the
// INPUT (not a specific form) so it wires the backlog and the read-only index
// surfaces alike. Mirrors `wireBacklogFilters`.
export function wireIndexSearch(): void {
  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement>("[data-search-control]"),
  );
  if (inputs.length === 0) return;
  for (const input of inputs) {
    const navigate = (): void => {
      window.location.search = nextSearchForQuery(
        window.location.search,
        input.value,
      );
    };
    // `change` fires on Enter / blur for a search input (not per keystroke), so
    // we navigate once per committed query, never mid-typing.
    input.addEventListener("change", navigate);
    const form = input.closest("form");
    if (form) {
      // Intercept the native GET submit (which would drop sibling params) and
      // navigate with everything preserved instead.
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        navigate();
      });
    }
  }
}

// ── Index column sort (docs/notes/ledger-sorting.md) ──────────────────────────
//
// The task-list / roadmap index headers render `<button data-sort-trigger=
// "<field>">`. A click cycles the column sort (ascending → descending → off)
// via `nextSortForField`, PRESERVING every other param (search `q`,
// `?ledger=`), and navigates; the SSR re-sorts. Backlog is intentionally
// excluded — its order is the persisted `rank` (docs/notes/ledger-sorting.md).
export function wireSortControl(): void {
  const triggers = Array.from(
    document.querySelectorAll<HTMLElement>("[data-sort-trigger]"),
  );
  if (triggers.length === 0) return;
  for (const trigger of triggers) {
    trigger.addEventListener("click", () => {
      const field = trigger.getAttribute("data-sort-trigger");
      if (!field) return;
      window.location.search = nextSortForField(window.location.search, field);
    });
  }
}

// ── Task-list "hide done/cancelled" toggle ───────────────────────────────────
//
// The task-list index renders a `<input type="checkbox"
// data-exclude-done-control>`. On change we set/clear `excludeDone=1` via
// `nextSearchForFlag` (PRESERVING search `q`, sort, `?ledger=`) and navigate;
// the SSR drops `done`/`cancelled` rows. Trims the active working set
// (complements the ledger-compaction write-path).
export function wireExcludeDoneToggle(): void {
  const checkbox = document.querySelector<HTMLInputElement>(
    "[data-exclude-done-control]",
  );
  if (!checkbox) return;
  checkbox.addEventListener("change", () => {
    window.location.search = nextSearchForFlag(
      window.location.search,
      "excludeDone",
      checkbox.checked,
    );
  });
}

// ── Backlog reorder (backlog-drag-reorder SPEC §2, §3, §4, §7, §8 — Slice C) ──
//
// Slice A wired the drag mechanics + within-tier DOM reorder + cross-tier
// refusal. Slice B added PERSISTENCE: a valid drop commits the new order via a
// single atomic multi-patch PATCH (SPEC §4.3, DR-8), adopts the returned mtime,
// updates rank cells in place (SPEC §8.4), and fires the follow-up full mirror
// regen (SPEC §0.7). On a 409 / schema / walk / network failure the DOM is
// rolled back to the last-known-good order (captured at dragstart, SPEC §4.5)
// and a brief inline message is surfaced near the table.
//
// Slice C adds KEYBOARD reorder (SPEC §2, DR-2) on the focused `[data-drag-handle]`
// (already `role="button" tabIndex=0`): ArrowUp/ArrowDown move the focused row
// one position WITHIN its tier in the DOM (LIVE, no PATCH) with a tier-boundary
// hard stop (SPEC §3.3); Enter COMMITS via the SAME `commitReorder` atomic PATCH
// path Slice B uses; Escape REVERTS un-committed live moves to the baseline. The
// keyboard path shares the table's `lastGoodOrder` baseline with the mouse path
// (focus captures a fresh baseline when no gesture is mid-flight; a commit
// advances it) so the two modalities never clobber each other's snapshot.
//
// The SPA sets `draggable="true"` on each row's drag HANDLE at wire time — NOT
// the SSR, and NOT the whole row (a draggable <tr> suppresses text selection /
// copy-paste in the row's cells). Per SPEC §7.2 `draggable` only means something
// with JS listeners attached, so coupling them is correct, and it keeps DR-6
// trivial (read-only / no-wire ⇒ no handle ⇒ nothing draggable). Feature-detected
// off `[data-supports-drag-reorder="true"]`
// with a banner-guard: a read-only sibling (`[data-ledger-banner]`) is NEVER
// wired (SPEC §6.2, DR-6).

/** CSS classes for the transient drag visual states (SPEC §8.1). */
const ROW_DRAGGING_CLASS = "record-view-row-dragging";
const ROW_DROP_TARGET_CLASS = "record-view-drop-target";
/** Transient pulse on a row moved by the keyboard (SPEC §8.3). */
const ROW_KEYBOARD_MOVED_CLASS = "record-view-row-keyboard-moved";
const KEYBOARD_MOVED_PULSE_MS = 600;

/** Read a row's tier (the `data-priority-tier` enum value, SPEC §3.1). */
function rowTier(row: HTMLElement): string {
  return row.getAttribute("data-priority-tier") ?? "";
}

/** The ordered list of `[data-backlog-row]` `<tr>`s currently in the table. */
function backlogRows(table: HTMLElement): HTMLElement[] {
  return Array.from(table.querySelectorAll<HTMLElement>("[data-backlog-row]"));
}

/** The current top-to-bottom id sequence of a table's backlog rows. */
function rowIdSequence(table: HTMLElement): string[] {
  return backlogRows(table).map((r) => r.getAttribute("data-backlog-row") ?? "");
}

/**
 * The contiguous run `[start, end]` of rows that share `tier`, expressed as
 * indices into the live row list. The SSR sort keeps each tier contiguous
 * (SPEC §3.2), so a tier owns one unbroken index range. Returns `null` if no
 * row of that tier is present.
 */
function tierRunBounds(
  rows: readonly HTMLElement[],
  tier: string,
): { start: number; end: number } | null {
  let start = -1;
  let end = -1;
  for (let i = 0; i < rows.length; i += 1) {
    if (rowTier(rows[i]!) === tier) {
      if (start === -1) start = i;
      end = i;
    }
  }
  return start === -1 ? null : { start, end };
}

/**
 * Lazily create (once per table) the visually-hidden `role="status"`
 * `aria-live="polite"` region used for reorder announcements (SPEC §8.3).
 * Appended adjacent to the table so AT reads it in context.
 */
function ensureReorderStatus(table: HTMLElement): HTMLElement {
  const parent = table.parentElement ?? table;
  let region = parent.querySelector<HTMLElement>("[data-reorder-status]");
  if (!region) {
    region = document.createElement("div");
    region.setAttribute("data-reorder-status", "");
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    region.className = "sr-only";
    parent.appendChild(region);
  }
  return region;
}

/** Announce a reorder status message to AT via the polite live region. */
function announceReorder(table: HTMLElement, message: string): void {
  ensureReorderStatus(table).textContent = message;
}

/**
 * Show a brief inline reorder error near the table (SPEC §4.5). A single
 * `[data-reorder-error]` element is reused (created once, adjacent to the
 * table). Passing `null` clears it.
 */
function setReorderError(table: HTMLElement, message: string | null): void {
  const parent = table.parentElement ?? table;
  let el = parent.querySelector<HTMLElement>("[data-reorder-error]");
  if (message === null) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement("p");
    el.setAttribute("data-reorder-error", "");
    el.setAttribute("role", "alert");
    el.className = "record-view-reorder-error";
    parent.insertBefore(el, table);
  }
  el.textContent = message;
}

/**
 * Write a row's new dense rank into BOTH the `data-rank-value` attribute and
 * the visible `.record-view-rank-value` text (SPEC §8.4). Keeping the hook
 * fresh means a subsequent rank-pencil open reads the new rank, not a stale
 * one (mirrors `commitDisplay`'s `data-rank-value` write).
 */
function updateRowRankCell(table: HTMLElement, id: string, rank: number): void {
  const row = table.querySelector<HTMLElement>(
    `[data-backlog-row="${CSS.escape(id)}"]`,
  );
  if (!row) return;
  const cell = row.querySelector<HTMLElement>("[data-rank-value]");
  if (!cell) return;
  cell.setAttribute("data-rank-value", String(rank));
  const valueSpan = cell.querySelector<HTMLElement>(".record-view-rank-value");
  if (valueSpan) valueSpan.textContent = String(rank);
}

/**
 * Restore the table's row order to a captured id sequence (SPEC §4.5 rollback).
 * Re-appends each `[data-backlog-row]` `<tr>` to its `<tbody>` in `idOrder`;
 * re-appending an existing node moves it, so the live DOM order matches the
 * snapshot afterward. Ids no longer present are skipped defensively.
 */
function restoreRowOrder(table: HTMLElement, idOrder: readonly string[]): void {
  const byId = new Map<string, HTMLElement>();
  for (const row of backlogRows(table)) {
    byId.set(row.getAttribute("data-backlog-row") ?? "", row);
  }
  for (const id of idOrder) {
    const row = byId.get(id);
    if (row && row.parentNode) row.parentNode.appendChild(row);
  }
}

/**
 * Commit a reordered tier (SPEC §4.3, §4.5, DR-8). Builds ONE atomic
 * multi-patch PATCH over the changed ranks, classifies the outcome, and:
 *   - ok / mirror-regen-failed (SOFT — canonical written, live order correct):
 *     adopt newMtime, write the new dense ranks into the rank cells in place
 *     (§8.4), announce success, then fire-and-forget the full mirror regen
 *     (§0.7 — a failed regen logs only, no rollback, no user error).
 *   - mtime-conflict (409) / schema-error / walk-error / network-error:
 *     roll back the DOM to `lastGoodOrder`, surface the inline error, and
 *     (409) adopt the returned currentMtime so a retry can succeed.
 *
 * `onCommitted(idOrder)` is invoked after a successful commit so the caller can
 * advance its last-known-good baseline to the just-persisted order.
 */
async function commitReorder(
  table: HTMLElement,
  draggedId: string,
  changed: readonly RankAssignment[],
  lastGoodOrder: readonly string[],
  onCommitted: (idOrder: string[]) => void,
): Promise<void> {
  // SPEC §4.3 last bullet: empty changed → no PATCH, silent no-op.
  if (changed.length === 0) return;
  setReorderError(table, null);

  let base: string;
  try {
    base = await ensureBaseMtime();
  } catch (err) {
    restoreRowOrder(table, lastGoodOrder);
    setReorderError(table, `Could not save — ${(err as Error).message}.`);
    announceReorder(
      table,
      "Could not save — ledger changed, please reload.",
    );
    return;
  }

  // SPEC §4.3: one integer patch per changed rank; one atomic multi-patch body.
  const patches = changed.map(({ id, rank }) =>
    buildPatchForKind("integer", ["items", id, "rank"], String(rank)),
  );
  const body = buildMultiPatchRequest(patches, base);

  let json: unknown;
  try {
    // SPEC §4.3: URL recordId = the dragged row's id (the walk ignores it; the
    // per-fieldPath item ids drive the writes — §0.6).
    const res = await fetch(recordPatchPath(draggedId), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    json = await res.json();
  } catch (err) {
    restoreRowOrder(table, lastGoodOrder);
    setReorderError(
      table,
      `Could not save — network error: ${(err as Error).message}. Please retry.`,
    );
    announceReorder(
      table,
      "Could not save — ledger changed, please reload.",
    );
    return;
  }

  const outcome = classifySaveResult(json);
  switch (outcome.kind) {
    case "ok":
    case "mirror-regen-failed": {
      // SOFT for mirror-regen-failed: canonical written, live order correct.
      if (outcome.newMtime) baseMtime = outcome.newMtime;
      // SPEC §8.4: write the new dense ranks in place so a later pencil-open
      // reads fresh ranks.
      for (const { id, rank } of changed) updateRowRankCell(table, id, rank);
      announceReorder(table, "Order saved.");
      onCommitted(rowIdSequence(table));
      // SPEC §0.7: fire-and-forget full mirror regen. A failed regen logs to
      // console only — NO rollback, NO user-facing error (soft follow-up).
      void fireRegen(baseMtime);
      break;
    }
    case "mtime-conflict": {
      // 409 — canonical NOT mutated. Roll back to last-known-good order, adopt
      // the returned currentMtime as the new base so a retry can succeed.
      restoreRowOrder(table, lastGoodOrder);
      if (outcome.currentMtime) baseMtime = outcome.currentMtime;
      setReorderError(table, outcome.message);
      announceReorder(
        table,
        "Could not save — ledger changed, please reload.",
      );
      break;
    }
    case "schema-error":
    case "walk-error":
    case "network-error": {
      // Should not occur for a well-formed dense renumber against existing ids;
      // defensively roll back the DOM and surface the error / retry hint.
      restoreRowOrder(table, lastGoodOrder);
      setReorderError(table, outcome.message);
      announceReorder(
        table,
        "Could not save — ledger changed, please reload.",
      );
      break;
    }
  }
}

/**
 * Fire-and-forget the full mirror regen after a successful reorder PATCH
 * (SPEC §0.7). We send the just-adopted mtime so the regen never 409s against
 * our own write. Any failure is SOFT: the canonical + live viewer are already
 * correct, so we only log — no rollback, no user-facing error.
 */
async function fireRegen(mtime: string | null): Promise<void> {
  try {
    const res = await fetch("/api/ledger/regen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mtime ? { baseMtime: mtime } : {}),
    });
    const body = (await res.json()) as { ok?: boolean; error?: unknown };
    if (!body.ok) {
      console.debug("[backlog-reorder] follow-up regen failed (soft):", body);
    }
  } catch (err) {
    console.debug(
      "[backlog-reorder] follow-up regen request failed (soft):",
      (err as Error).message,
    );
  }
}

/**
 * Briefly pulse a row to give a sighted keyboard user visual feedback of a
 * keyboard move (SPEC §8.3). Removing then re-adding the class restarts the
 * animation if the SAME row is moved again before the previous pulse ended.
 */
function pulseKeyboardMoved(row: HTMLElement): void {
  row.classList.remove(ROW_KEYBOARD_MOVED_CLASS);
  // Force a reflow so re-adding the class restarts the CSS animation.
  void row.offsetWidth;
  row.classList.add(ROW_KEYBOARD_MOVED_CLASS);
  window.setTimeout(() => {
    row.classList.remove(ROW_KEYBOARD_MOVED_CLASS);
  }, KEYBOARD_MOVED_PULSE_MS);
}

/**
 * Move the focused row ONE position within its tier (SPEC §2/§3.3 keyboard
 * arrow move). `direction` is -1 (ArrowUp) or +1 (ArrowDown). Tier-boundary is
 * a HARD STOP (SPEC §3.3): ArrowUp at the FIRST of its tier, or ArrowDown at the
 * LAST, is a no-op (does NOT cross into the adjacent tier). On a real move the
 * DOM reorders LIVE (no PATCH), focus is re-applied to the moved row's handle so
 * repeated presses keep moving the SAME row (SPEC §2 focus management), a pulse
 * plays, and the move is announced. Returns `true` iff a move happened.
 */
function moveRowWithinTier(
  table: HTMLElement,
  row: HTMLElement,
  direction: -1 | 1,
): boolean {
  const tier = rowTier(row);
  const rows = backlogRows(table);
  // Index of `row` AMONG its same-tier siblings (in DOM order).
  const tierRows = rows.filter((r) => rowTier(r) === tier);
  const pos = tierRows.indexOf(row);
  if (pos === -1) return false;
  const targetPos = pos + direction;
  // SPEC §3.3 HARD STOP: out of the tier's [0, K-1] range → no-op.
  if (targetPos < 0 || targetPos >= tierRows.length) return false;

  const neighbour = tierRows[targetPos]!;
  const tbody = row.parentNode;
  if (!tbody) return false;
  if (direction < 0) {
    // ArrowUp: place the row before its upper neighbour.
    tbody.insertBefore(row, neighbour);
  } else {
    // ArrowDown: place the row after its lower neighbour.
    tbody.insertBefore(row, neighbour.nextSibling);
  }

  // SPEC §2: re-focus the moved row's handle so repeated presses keep moving
  // the SAME row (moving the <tr> in the DOM does not preserve focus by itself).
  const handle = row.querySelector<HTMLElement>("[data-drag-handle]");
  handle?.focus();

  pulseKeyboardMoved(row);

  // SPEC §8.3 announcement: "Item {id} moved to position {n} of {K} in {tier}."
  const id = row.getAttribute("data-backlog-row") ?? "";
  announceReorder(
    table,
    `Item ${id} moved to position ${targetPos + 1} of ${tierRows.length} in ${tier}.`,
  );
  return true;
}

/**
 * The reorder controller for one backlog table. Tracks the dragged row +
 * highlighted drop target across the dragstart→dragover→drop→dragend lifecycle,
 * AND the keyboard reorder gesture on the focused drag handle (SPEC §2).
 */
export function wireBacklogReorderTable(table: HTMLElement): void {
  let dragged: HTMLElement | null = null;
  let dropTarget: HTMLElement | null = null;
  // SPEC §4.5: last-known-good order — the row id sequence captured at the
  // start of a gesture (mouse: dragstart; keyboard: first focus/move after a
  // commit). Rollback (mouse 409) or Escape (keyboard) restores to this; a
  // successful commit advances it to the just-persisted order. SHARED between
  // the mouse and keyboard paths so they never clobber each other's baseline.
  let lastGoodOrder: string[] = rowIdSequence(table);
  // SPEC §2/§4.5: true once an un-committed keyboard arrow move has happened
  // since the baseline was captured. Gates whether focusin re-snapshots the
  // baseline (it must NOT mid-gesture) and whether Escape has anything to revert.
  let keyboardDirty = false;

  // SPEC §7.2: the CLIENT marks the drag HANDLE draggable (never the SSR, and
  // never the whole <tr> — a draggable row makes native HTML drag intercept
  // mousedown gestures over the row, which SUPPRESSES text selection /
  // copy-paste in its cells). Drag is initiated from the handle; `dragstart`
  // still resolves the row via `closest("[data-backlog-row]")` (the handle is a
  // row descendant). A read-only row has no handle (SSR-omitted) → nothing is
  // marked draggable, reinforcing DR-6.
  for (const row of backlogRows(table)) {
    row
      .querySelector<HTMLElement>("[data-drag-handle]")
      ?.setAttribute("draggable", "true");
  }

  function clearDropTarget(): void {
    if (dropTarget) {
      dropTarget.classList.remove(ROW_DROP_TARGET_CLASS);
      dropTarget = null;
    }
  }

  function endDrag(): void {
    if (dragged) dragged.classList.remove(ROW_DRAGGING_CLASS);
    clearDropTarget();
    dragged = null;
  }

  table.addEventListener("dragstart", (event) => {
    const target = event.target as Element | null;
    const row = target?.closest<HTMLElement>("[data-backlog-row]") ?? null;
    if (!row || !table.contains(row)) return;
    dragged = row;
    // SPEC §4.5: capture the last-known-good order at the START of the gesture
    // so a failed commit can roll the DOM back to exactly this sequence.
    lastGoodOrder = rowIdSequence(table);
    row.classList.add(ROW_DRAGGING_CLASS);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      // The handle is the drag source; render the full ROW as the drag ghost so
      // the gesture still reads as "moving this row", not "moving the ☰ glyph".
      if (typeof event.dataTransfer.setDragImage === "function") {
        event.dataTransfer.setDragImage(row, 0, 0);
      }
      // Some engines require data to be set for the drag to proceed.
      event.dataTransfer.setData(
        "text/plain",
        row.getAttribute("data-backlog-row") ?? "",
      );
    }
  });

  // Highlight only an in-tier row as a candidate drop target (SPEC §3.2 — the
  // implicit cross-tier-unavailable cue). dragover must preventDefault on a
  // valid target so `drop` fires.
  table.addEventListener("dragover", (event) => {
    if (!dragged) return;
    const target = event.target as Element | null;
    const over = target?.closest<HTMLElement>("[data-backlog-row]") ?? null;
    if (!over || over === dragged) {
      clearDropTarget();
      return;
    }
    if (rowTier(over) !== rowTier(dragged)) {
      // Different tier → not a valid drop target; no preventDefault, no cue.
      clearDropTarget();
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    if (over !== dropTarget) {
      clearDropTarget();
      dropTarget = over;
      over.classList.add(ROW_DROP_TARGET_CLASS);
    }
  });

  table.addEventListener("drop", (event) => {
    if (!dragged) return;
    event.preventDefault();
    const draggedRow = dragged;
    const target = event.target as Element | null;
    const over = target?.closest<HTMLElement>("[data-backlog-row]") ?? null;
    // Refuse: no row under pointer, dropping on self, or cross-tier (DR-3).
    if (!over || over === draggedRow || rowTier(over) !== rowTier(draggedRow)) {
      endDrag();
      return;
    }

    const tier = rowTier(draggedRow);
    const rowsBefore = backlogRows(table);
    const bounds = tierRunBounds(rowsBefore, tier);
    if (!bounds) {
      endDrag();
      return;
    }
    const overIndex = rowsBefore.indexOf(over);
    // The target row must be inside the dragged tier's contiguous run; the
    // tier-equality check above already guarantees this, but clamp defensively.
    if (overIndex < bounds.start || overIndex > bounds.end) {
      endDrag();
      return;
    }

    // Insert relative to the target row's vertical midpoint: above → before,
    // below → after.
    const rect = over.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    const tbody = over.parentNode;
    if (!tbody) {
      endDrag();
      return;
    }
    if (after) {
      tbody.insertBefore(draggedRow, over.nextSibling);
    } else {
      tbody.insertBefore(draggedRow, over);
    }

    // SPEC §4.1: recompute the ENTIRE affected tier densely from its new
    // top-to-bottom DOM order, then PATCH only the changed subset.
    const rowsAfter = backlogRows(table);
    const tierRows = rowsAfter
      .filter((r) => rowTier(r) === tier)
      .map((r) => ({
        id: r.getAttribute("data-backlog-row") ?? "",
        rank: rankOfRow(r),
      }));
    const { changed } = recomputeTierRanks(tierRows);
    const draggedId = draggedRow.getAttribute("data-backlog-row") ?? "";
    const goodOrder = lastGoodOrder;

    // End the drag visuals before the async commit so the row isn't left
    // greyed-out while the PATCH is in flight.
    endDrag();

    // SPEC §4.3/§4.5: commit the new order via one atomic multi-patch PATCH.
    // Empty `changed` (dropped back where it started) → silent no-op, no PATCH.
    void commitReorder(table, draggedId, changed, goodOrder, (idOrder) => {
      // Advance the last-known-good baseline to the just-persisted order so a
      // subsequent failed gesture rolls back to here, not the pre-commit order.
      lastGoodOrder = idOrder;
    });
  });

  table.addEventListener("dragend", () => {
    endDrag();
  });

  // SPEC §2 focus baseline: when a drag handle gains focus and no gesture is in
  // progress (no live drag, no un-committed keyboard moves), capture a fresh
  // last-known-good snapshot. This is the order Escape reverts to and the order
  // a failed commit rolls back to. Guarded by `keyboardDirty` so re-focusing the
  // handle that a move just re-focused does NOT clobber the pre-move baseline.
  table.addEventListener("focusin", (event) => {
    const target = event.target as Element | null;
    const handle = target?.closest<HTMLElement>("[data-drag-handle]") ?? null;
    if (!handle || !table.contains(handle)) return;
    if (dragged || keyboardDirty) return;
    lastGoodOrder = rowIdSequence(table);
  });

  // SPEC §2/§3.3/§8.3 — keyboard reorder on the focused handle. ArrowUp/Down
  // move LIVE within tier (no PATCH); Enter commits via the SHARED commitReorder;
  // Escape reverts un-committed moves to the baseline. preventDefault on each so
  // the page does not scroll / the handle's role=button default does not fire.
  table.addEventListener("keydown", (event) => {
    const target = event.target as Element | null;
    const handle = target?.closest<HTMLElement>("[data-drag-handle]") ?? null;
    if (!handle || !table.contains(handle)) return;
    const row = handle.closest<HTMLElement>("[data-backlog-row]");
    if (!row) return;

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const wasDirty = keyboardDirty;
      // Capture the baseline lazily on the first move of a fresh gesture so a
      // subsequent Escape / failed commit reverts to the pre-move order. (focusin
      // also captures it; this is belt-and-braces for engines/AT that move focus
      // without a focusin we observed.)
      if (!wasDirty) lastGoodOrder = rowIdSequence(table);
      // Mark the gesture dirty BEFORE the move: moveRowWithinTier re-focuses the
      // moved row's handle, which synchronously fires `focusin`; that listener
      // must see `keyboardDirty === true` so it does NOT re-snapshot the baseline
      // to the post-move order (which would defeat Escape / rollback).
      keyboardDirty = true;
      const moved = moveRowWithinTier(table, row, event.key === "ArrowUp" ? -1 : 1);
      // Tier-boundary hard stop (SPEC §3.3): no move happened. If this was the
      // first key of the gesture, the gesture is still clean — restore the flag
      // so a later focus re-snapshots and Escape has nothing stale to revert.
      if (!moved && !wasDirty) keyboardDirty = false;
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      // SPEC §2/§4.3: commit the focused row's tier's CURRENT visual order via
      // the SAME atomic multi-patch PATCH the mouse drop uses.
      const tier = rowTier(row);
      const tierRows = backlogRows(table)
        .filter((r) => rowTier(r) === tier)
        .map((r) => ({
          id: r.getAttribute("data-backlog-row") ?? "",
          rank: rankOfRow(r),
        }));
      const { changed } = recomputeTierRanks(tierRows);
      const draggedId = row.getAttribute("data-backlog-row") ?? "";
      const goodOrder = lastGoodOrder;
      // Net no-op (Escape-equivalent ordering / never moved) → no PATCH; just
      // clear the dirty flag so a later focus re-snapshots.
      if (changed.length === 0) {
        keyboardDirty = false;
        return;
      }
      void commitReorder(table, draggedId, changed, goodOrder, (idOrder) => {
        // SPEC §2: after commit, advance the baseline and clear the gesture so a
        // later focus/Escape works against the just-persisted order.
        lastGoodOrder = idOrder;
        keyboardDirty = false;
        // Keep focus on the moved row's handle after a successful commit.
        row.querySelector<HTMLElement>("[data-drag-handle]")?.focus();
      });
      // On a failed commit, commitReorder rolls the DOM back to `goodOrder`; the
      // gesture is over either way, so clear the dirty flag now. (A rollback
      // restores exactly `lastGoodOrder`, which is unchanged here.)
      keyboardDirty = false;
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      // SPEC §2/§4.5: revert any un-committed live arrow moves to the baseline.
      if (keyboardDirty) {
        restoreRowOrder(table, lastGoodOrder);
        announceReorder(table, "Reorder cancelled.");
        keyboardDirty = false;
        // Keep focus on the (now restored-position) row's handle.
        handle.focus();
      }
      return;
    }
  });
}

/**
 * Read a row's current rank from its rank cell's `data-rank-value` hook
 * (`""` ⇒ unset/null, else the integer). Mirrors how the dispatcher resolves
 * the rank value without re-parsing rendered text (SPEC §7.1).
 */
function rankOfRow(row: HTMLElement): number | null {
  const cell = row.querySelector<HTMLElement>("[data-rank-value]");
  const raw = cell?.getAttribute("data-rank-value");
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isNaN(n) ? null : n;
}

/**
 * Wire backlog drag-reorder on the launched (editable) page. Feature-detects
 * `[data-backlog-table][data-supports-drag-reorder="true"]` and refuses to wire
 * anything on a read-only sibling (`[data-ledger-banner]` present) — DR-6.
 */
function wireBacklogReorder(): void {
  // Banner-guard (SPEC §6.2, defence-in-depth): never wire on a read-only page.
  if (document.querySelector("[data-ledger-banner]")) return;
  const tables = document.querySelectorAll<HTMLElement>(
    '[data-backlog-table][data-supports-drag-reorder="true"]',
  );
  tables.forEach((table) => wireBacklogReorderTable(table));
}

function init(): void {
  document.addEventListener("click", onClick);
  document.addEventListener("keydown", onKeydown);
  highlightCodeBlocks();
  wirePrintClassToggle();
  wireThemePicker();
  wireBacklogFilters();
  wireIndexSearch();
  wireSortControl();
  wireExcludeDoneToggle();
  wireBacklogReorder();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}
