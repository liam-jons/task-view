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
import {
  buildPatchForKind,
  buildPatchRequest,
  isDispatchKind,
  parseFieldPathAttr,
  recordPatchPath,
  type DispatchKind,
  type DocLinkRowInput,
} from "../../../packages/ui/record-view/edit-dispatch";
import { classifySaveResult } from "../../../packages/ui/record-view/edit-state";

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

function init(): void {
  document.addEventListener("click", onClick);
  document.addEventListener("keydown", onKeydown);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}
