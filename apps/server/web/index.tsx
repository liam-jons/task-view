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
  input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
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

  const { wrapper, input } = buildEditForm(
    kind,
    fieldAttr ?? "",
    currentValue,
    optionsAttr,
  );
  clearChildren(container);
  container.appendChild(wrapper);
  input.focus();
  if ("select" in input && typeof input.select === "function") input.select();

  activeEdits.set(container, {
    container,
    fieldPath,
    kind,
    recordId,
    originalNodes,
    input,
  });
}

/**
 * Read the current displayed value so the input pre-populates. For the
 * rank cell we prefer the authoritative `data-rank-value` hook (empty
 * string = unset); otherwise fall back to trimmed text content (with the
 * "—" unset glyph normalised to "").
 */
function readDisplayedValue(container: HTMLElement): string {
  const rankHost =
    container.closest<HTMLElement>("[data-rank-value]") ?? container;
  const rankAttr = rankHost.getAttribute("data-rank-value");
  if (rankAttr !== null) return rankAttr; // "" when unset
  const valueSpan = container.querySelector(".record-view-rank-value");
  const text = (valueSpan?.textContent ?? container.textContent ?? "").trim();
  return text === "—" ? "" : text;
}

/** Build the on-demand edit form for a kind. Returns wrapper + the input. */
function buildEditForm(
  kind: DispatchKind,
  fieldAttr: string,
  currentValue: string,
  optionsAttr?: string | null,
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
  if (kind === "textarea") {
    const ta = document.createElement("textarea");
    ta.className = "record-view-textarea";
    ta.rows = 4;
    ta.value = currentValue;
    ta.addEventListener("input", () => autosize(ta));
    input = ta;
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
  } else {
    const el = document.createElement("input");
    el.type =
      kind === "integer" || kind === "integer-nullable" ? "number" : "text";
    el.className = "record-view-text-input";
    el.value = currentValue;
    input = el;
  }
  input.setAttribute("data-edit-input", "");
  input.setAttribute("data-edit-field", fieldAttr);
  input.setAttribute("data-keyboard-shortcut", "cmd-enter,esc");
  form.appendChild(input);

  form.appendChild(makeActionButton("save", "Save", "record-view-save-button", fieldAttr));
  form.appendChild(
    makeActionButton("cancel", "Cancel", "record-view-cancel-button", fieldAttr),
  );
  return { wrapper: form, input };
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

  const rawValue = active.input.value;
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

/** Replace the editor with the new value display + a fresh pencil. */
function commitDisplay(
  container: HTMLElement,
  active: ActiveEdit,
  rawValue: string,
): void {
  const trimmed = rawValue.trim();
  const display = trimmed === "" ? "—" : trimmed;
  // Update the authoritative rank-value hook when present so a re-open
  // reads the new value.
  const rankHost =
    container.closest<HTMLElement>("[data-rank-value]") ?? container;
  if (rankHost.hasAttribute("data-rank-value")) {
    rankHost.setAttribute("data-rank-value", trimmed);
  }
  const fieldAttr = active.fieldPath.join(">");
  clearChildren(container);

  const valueSpan = document.createElement("span");
  valueSpan.className = "record-view-rank-value";
  valueSpan.textContent = display;

  const pencil = document.createElement("button");
  pencil.type = "button";
  pencil.className = "record-view-pencil-button";
  pencil.setAttribute("data-edit-action", "open");
  pencil.setAttribute("data-edit-field", fieldAttr);
  pencil.setAttribute("data-edit-kind", active.kind);
  pencil.setAttribute("aria-label", "Edit");
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
