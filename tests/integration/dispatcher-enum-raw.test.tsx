/**
 * tests/integration/dispatcher-enum-raw.test.tsx — ID-20.25 + ID-20.27
 * dispatcher extensions.
 *
 * ID-20.25 (original): enum `<select>` editor branch + raw-value prefill.
 *
 * The 20.24 PE dispatcher (apps/server/web/index.tsx) built only a
 * `<textarea>` (kind="textarea") or an `<input>` (text/number) on
 * pencil-click — there was NO `<select>` branch for enum kinds and the
 * current value was read from `textContent` only. 20.25 extends the
 * dispatcher so:
 *
 *   1. A pencil carrying `data-edit-kind="enum"` (or "enum-nullable")
 *      plus `data-edit-options="a,b,c"` opens a `<select>` populated
 *      from the options, with the current value pre-selected (inv 31/32:
 *      options from the canonical Zod enum, every value selectable, no
 *      state-machine gating).
 *   2. A pencil carrying `data-edit-raw-value="<raw>"` pre-fills the
 *      editor with the RAW source (inv 27/28 — raw Markdown incl.
 *      `<info added on …>` journal blocks), NOT the rendered textContent.
 *
 * ID-20.27 (appended): `doc-links` multi-row editor — add / delete rows,
 * JSON pre-fill, full-array save, empty-array save, 409/422/Esc.
 *
 * These tests mount the REAL dispatcher in a happy-dom document and drive
 * it via real DOM events (click / change / keydown) — the first DOM-level
 * coverage of the dispatcher (20.24 only had SSR-markup + pure-helper
 * tests). Network is intercepted via a stubbed global `fetch`.
 *
 * No 20.24 regression: text/textarea/integer/rank behaviour is exercised
 * here too to lock it in.
 *
 * Note: GlobalRegistrator is a singleton — doc-links tests are appended to
 * THIS file rather than a separate file so they share the same happy-dom
 * registration lifecycle without cross-file interference.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

// happy-dom must be registered BEFORE the dispatcher module is imported,
// because the module attaches document-level listeners at import time
// (the `if (typeof document !== "undefined")` block at the bottom of
// index.tsx). We register in beforeAll and dynamic-import the module
// once the global `document` exists.
let dispatcherImported = false;

async function ensureDispatcher(): Promise<void> {
  if (dispatcherImported) return;
  await import("../../apps/server/web/index");
  dispatcherImported = true;
}

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

// ── fetch stub ───────────────────────────────────────────────────────────────

interface FetchCall {
  url: string;
  init?: RequestInit;
}

let fetchCalls: FetchCall[] = [];
let nextResponses: Array<{ status: number; body: unknown }> = [];
const originalFetch = globalThis.fetch;

function stubFetch(): void {
  fetchCalls = [];
  nextResponses = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    fetchCalls.push({ url, init });
    // GET /api/ledger (mtime resolution) — always succeed with a base mtime.
    if (url === "/api/ledger" && (!init || init.method === undefined)) {
      return jsonResponse(200, { ok: true, mtime: "2026-05-25T00:00:00.000Z" });
    }
    // PATCH responses are queued by the test.
    const next = nextResponses.shift();
    if (!next) {
      return jsonResponse(200, {
        ok: true,
        newMtime: "2026-05-25T00:00:01.000Z",
      });
    }
    return jsonResponse(next.status, next.body);
  }) as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function queuePatchResponse(status: number, body: unknown): void {
  nextResponses.push({ status, body });
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

/** Detach every child of the document body (innerHTML-free reset). */
function clearBody(): void {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
}

beforeEach(async () => {
  await ensureDispatcher();
  stubFetch();
  clearBody();
});

afterEach(() => {
  restoreFetch();
});

// ── DOM scaffolding helpers ────────────────────────────────────────────────────

/**
 * Build a minimal per-record container with a single editable field +
 * its pencil. Mirrors the SSR markup the views emit: a record-scoped
 * host carrying `data-record-id` / `data-record-kind`, a value display,
 * and a pencil `<button>` with the edit hooks.
 */
function mountField(opts: {
  recordId: string;
  recordKind: string;
  fieldPath: string;
  kind: string;
  displayed: string;
  options?: string;
  rawValue?: string;
}): HTMLButtonElement {
  const host = document.createElement("article");
  host.setAttribute("data-record-id", opts.recordId);
  host.setAttribute("data-record-kind", opts.recordKind);

  const container = document.createElement("div");
  container.setAttribute("data-edit-container", "");

  const value = document.createElement("span");
  value.className = "record-view-field-value";
  value.textContent = opts.displayed;
  container.appendChild(value);

  const pencil = document.createElement("button");
  pencil.type = "button";
  pencil.className = "record-view-pencil-button";
  pencil.setAttribute("data-edit-action", "open");
  pencil.setAttribute("data-edit-field", opts.fieldPath);
  pencil.setAttribute("data-edit-kind", opts.kind);
  if (opts.options !== undefined)
    pencil.setAttribute("data-edit-options", opts.options);
  if (opts.rawValue !== undefined)
    pencil.setAttribute("data-edit-raw-value", opts.rawValue);
  container.appendChild(pencil);

  host.appendChild(container);
  document.body.appendChild(host);
  return pencil;
}

function clickOpen(pencil: HTMLButtonElement): HTMLElement {
  // Capture the container BEFORE the click: opening the editor replaces
  // the container's children (detaching the pencil), so a post-click
  // `pencil.closest(...)` would return null.
  const container = pencil.closest<HTMLElement>("[data-edit-container]");
  if (!container) throw new Error("container missing before open");
  pencil.dispatchEvent(new Event("click", { bubbles: true }));
  return container;
}

async function flushPromises(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

// ── enum `<select>` build ──────────────────────────────────────────────────────

describe("ID-20.25 dispatcher — enum `<select>` editor (PRODUCT inv 30-32)", () => {
  test("pencil(kind=enum) opens a <select> with one <option> per data-edit-options literal", () => {
    const pencil = mountField({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>status",
      kind: "enum",
      displayed: "in_progress",
      options: "done,pending,in_progress,blocked,deferred,cancelled",
    });
    const container = clickOpen(pencil);

    const select = container.querySelector("select");
    expect(select).not.toBeNull();
    const optionValues = Array.from(
      select!.querySelectorAll("option"),
    ).map((o) => o.getAttribute("value"));
    expect(optionValues).toEqual([
      "done",
      "pending",
      "in_progress",
      "blocked",
      "deferred",
      "cancelled",
    ]);
  });

  test("frontmatter-card shape: enum value read from .record-view-field-value, NOT polluted by the pencil glyph", () => {
    // Replicate the real frontmatter value cell: a <td> containing a
    // value span + the pencil. The dispatcher must pre-select "blocked",
    // not "blocked✎" (which would match no option).
    const host = document.createElement("article");
    host.setAttribute("data-record-id", "20");
    host.setAttribute("data-record-kind", "task");
    const cell = document.createElement("td");
    cell.setAttribute("data-frontmatter-value", "");
    const valueSpan = document.createElement("span");
    valueSpan.className = "record-view-field-value";
    valueSpan.textContent = "blocked";
    cell.appendChild(valueSpan);
    const pencil = document.createElement("button");
    pencil.type = "button";
    pencil.setAttribute("data-edit-action", "open");
    pencil.setAttribute("data-edit-field", "tasks>20>status");
    pencil.setAttribute("data-edit-kind", "enum");
    pencil.setAttribute(
      "data-edit-options",
      "done,pending,in_progress,blocked,deferred,cancelled",
    );
    const glyph = document.createElement("span");
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = "✎";
    pencil.appendChild(glyph);
    cell.appendChild(pencil);
    host.appendChild(cell);
    document.body.appendChild(host);

    pencil.dispatchEvent(new Event("click", { bubbles: true }));
    const select = cell.querySelector("select") as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select.value).toBe("blocked");
  });

  test("the current displayed value is pre-selected (inv 32: no state-machine gating)", () => {
    const pencil = mountField({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>status",
      kind: "enum",
      displayed: "blocked",
      options: "done,pending,in_progress,blocked,deferred,cancelled",
    });
    const container = clickOpen(pencil);
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("blocked");
  });

  test("enum-nullable prepends an empty-value (unset) option and serialises '' → null on save", async () => {
    const pencil = mountField({
      recordId: "3",
      recordKind: "roadmap-theme",
      fieldPath: "themes>3>notes",
      kind: "enum-nullable",
      displayed: "—",
      options: "pending,in_progress,done",
    });
    const container = clickOpen(pencil);
    const select = container.querySelector("select") as HTMLSelectElement;
    const first = select.querySelector("option") as HTMLOptionElement;
    expect(first.getAttribute("value")).toBe("");
    // Leave the empty (unset) option selected and save.
    select.value = "";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const save = container.querySelector(
      '[data-edit-action="save"]',
    ) as HTMLButtonElement;
    save.dispatchEvent(new Event("click", { bubbles: true }));
    await flushPromises();
    await flushPromises();

    const patchCall = fetchCalls.find((c) => c.init?.method === "PATCH");
    expect(patchCall).toBeDefined();
    const body = JSON.parse(String(patchCall!.init!.body));
    expect(body.patches[0].newValue).toBeNull();
  });

  test("selecting a new enum value sends it as newValue on save (200 → in-place re-render)", async () => {
    const pencil = mountField({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>status",
      kind: "enum",
      displayed: "in_progress",
      options: "done,pending,in_progress,blocked,deferred,cancelled",
    });
    queuePatchResponse(200, {
      ok: true,
      newMtime: "2026-05-25T00:00:02.000Z",
    });
    const container = clickOpen(pencil);
    const select = container.querySelector("select") as HTMLSelectElement;
    select.value = "done";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const save = container.querySelector(
      '[data-edit-action="save"]',
    ) as HTMLButtonElement;
    save.dispatchEvent(new Event("click", { bubbles: true }));
    await flushPromises();
    await flushPromises();

    const patchCall = fetchCalls.find((c) => c.init?.method === "PATCH");
    const body = JSON.parse(String(patchCall!.init!.body));
    expect(body.patches[0].fieldPath).toEqual(["tasks", "20", "status"]);
    expect(body.patches[0].newValue).toBe("done");
    // In-place re-render: the editor is gone, value display restored.
    expect(container.querySelector("select")).toBeNull();
    expect(container.textContent).toContain("done");
  });

  test("409 mtime-mismatch keeps the <select> open + shows an inline error (no canonical mutation)", async () => {
    const pencil = mountField({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>status",
      kind: "enum",
      displayed: "in_progress",
      options: "done,pending,in_progress,blocked,deferred,cancelled",
    });
    queuePatchResponse(409, {
      ok: false,
      error: "mtime-mismatch",
      currentMtime: "2026-05-25T09:99:99.000Z",
      hint: "Ledger changed underneath you — reload and re-apply.",
    });
    const container = clickOpen(pencil);
    const select = container.querySelector("select") as HTMLSelectElement;
    select.value = "done";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    (
      container.querySelector('[data-edit-action="save"]') as HTMLButtonElement
    ).dispatchEvent(new Event("click", { bubbles: true }));
    await flushPromises();
    await flushPromises();

    // Form stays open (draft preserved) + inline error rendered.
    expect(container.querySelector("select")).not.toBeNull();
    const err = container.querySelector("[data-edit-error]");
    expect(err).not.toBeNull();
    expect(err!.textContent).toContain("Ledger changed");
  });

  test("422 schema-error keeps the <select> open + shows the inline Zod message", async () => {
    const pencil = mountField({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>status",
      kind: "enum",
      displayed: "in_progress",
      options: "done,pending,in_progress,blocked,deferred,cancelled",
    });
    queuePatchResponse(422, {
      ok: false,
      error: "schema-error",
      issues: [
        {
          path: ["tasks", 0, "status"],
          message: "Invalid enum value.",
        },
      ],
    });
    const container = clickOpen(pencil);
    const select = container.querySelector("select") as HTMLSelectElement;
    select.value = "done";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    (
      container.querySelector('[data-edit-action="save"]') as HTMLButtonElement
    ).dispatchEvent(new Event("click", { bubbles: true }));
    await flushPromises();
    await flushPromises();

    expect(container.querySelector("select")).not.toBeNull();
    const err = container.querySelector("[data-edit-error]");
    expect(err).not.toBeNull();
    expect(err!.textContent).toContain("Invalid enum value.");
  });

  test("Cmd+Enter inside the enum form triggers save", async () => {
    const pencil = mountField({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>status",
      kind: "enum",
      displayed: "in_progress",
      options: "done,pending,in_progress,blocked,deferred,cancelled",
    });
    queuePatchResponse(200, { ok: true, newMtime: "2026-05-25T00:00:03.000Z" });
    const container = clickOpen(pencil);
    const select = container.querySelector("select") as HTMLSelectElement;
    select.value = "pending";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    select.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: true,
        bubbles: true,
      }),
    );
    await flushPromises();
    await flushPromises();

    const patchCall = fetchCalls.find((c) => c.init?.method === "PATCH");
    expect(patchCall).toBeDefined();
    expect(JSON.parse(String(patchCall!.init!.body)).patches[0].newValue).toBe(
      "pending",
    );
  });

  test("Esc inside the enum form cancels (restores the original display, no PATCH)", () => {
    const pencil = mountField({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>status",
      kind: "enum",
      displayed: "in_progress",
      options: "done,pending,in_progress,blocked,deferred,cancelled",
    });
    const container = clickOpen(pencil);
    const select = container.querySelector("select") as HTMLSelectElement;
    select.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(container.querySelector("select")).toBeNull();
    expect(container.textContent).toContain("in_progress");
    expect(fetchCalls.find((c) => c.init?.method === "PATCH")).toBeUndefined();
  });
});

// ── raw-value prefill ───────────────────────────────────────────────────────────

describe("ID-20.25 dispatcher — raw-value prefill for textarea (PRODUCT inv 27-28)", () => {
  test("textarea pre-fills with data-edit-raw-value (raw source), NOT rendered textContent", () => {
    const raw =
      "## Heading\n\nRaw **Markdown**.\n\n<info added on 2026-05-25>\njournal\n</info added on 2026-05-25>";
    const pencil = mountField({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>subtasks>4>details",
      kind: "textarea",
      displayed: "Heading Raw Markdown journal", // rendered text (no markup)
      rawValue: raw,
    });
    const container = clickOpen(pencil);
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(ta).not.toBeNull();
    expect(ta.value).toBe(raw);
    // Specifically: the journal block survives verbatim (inv 28).
    expect(ta.value).toContain("<info added on 2026-05-25>");
  });

  test("textarea WITHOUT data-edit-raw-value still falls back to textContent (no regression)", () => {
    const pencil = mountField({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>description",
      kind: "textarea",
      displayed: "Plain description text",
    });
    const container = clickOpen(pencil);
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(ta.value).toBe("Plain description text");
  });
});

// ── 20.24 no-regression: text + integer + rank still work ───────────────────────

describe("ID-20.25 dispatcher — 20.24 paths preserved (no regression)", () => {
  test("text kind still opens a plain text <input> pre-filled from textContent", () => {
    const pencil = mountField({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>owner",
      kind: "text",
      displayed: "Liam",
    });
    const container = clickOpen(pencil);
    const input = container.querySelector("input") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.type).toBe("text");
    expect(input.value).toBe("Liam");
    expect(container.querySelector("select")).toBeNull();
  });

  test("integer-nullable (rank) prefers data-rank-value and builds a number input", () => {
    // Replicate the backlog rank cell shape: a rank cell carrying the
    // authoritative data-rank-value hook.
    const host = document.createElement("article");
    host.setAttribute("data-backlog-row", "30");
    const cell = document.createElement("td");
    cell.className = "record-view-rank-cell";
    cell.setAttribute("data-rank-value", "5");
    const value = document.createElement("span");
    value.className = "record-view-rank-value";
    value.textContent = "5";
    cell.appendChild(value);
    const pencil = document.createElement("button");
    pencil.type = "button";
    pencil.setAttribute("data-edit-action", "open");
    pencil.setAttribute("data-edit-field", "items>30>rank");
    pencil.setAttribute("data-edit-kind", "integer-nullable");
    cell.appendChild(pencil);
    host.appendChild(cell);
    document.body.appendChild(host);

    pencil.dispatchEvent(new Event("click", { bubbles: true }));
    const input = cell.querySelector("input") as HTMLInputElement;
    expect(input.type).toBe("number");
    expect(input.value).toBe("5");
  });
});

// ── ID-20.27: doc-links multi-row editor ────────────────────────────────────────

/**
 * These tests cover the `doc-links` kind dispatcher branch: multi-row
 * editor, JSON raw-value pre-fill, add-row, delete-row, save (full-array
 * patch), empty-array save, 409/422, and Esc.
 *
 * Appended to this file (rather than a separate test file) to share the
 * existing happy-dom GlobalRegistrator lifecycle without cross-file
 * interference.
 */

interface DocLink {
  path: string;
  anchor: string | null;
  raw: string;
}

const SAMPLE_DOC_LINKS: DocLink[] = [
  {
    path: "docs/specs/per-task-mirror/PRODUCT.md",
    anchor: "§3.2 invariant 4",
    raw: "PRODUCT.md §3.2 inv 4",
  },
  {
    path: "docs/runbooks/staging-refresh.md",
    anchor: null,
    raw: "staging-refresh runbook",
  },
];

function mountDocLinksPencil(opts: {
  recordId: string;
  recordKind: string;
  fieldPath: string;
  links?: DocLink[];
}): { pencil: HTMLButtonElement; container: HTMLElement } {
  const links = opts.links ?? SAMPLE_DOC_LINKS;

  const host = document.createElement("article");
  host.setAttribute("data-record-id", opts.recordId);
  host.setAttribute("data-record-kind", opts.recordKind);

  const container = document.createElement("div");
  container.setAttribute("data-edit-container", "");

  const value = document.createElement("span");
  value.className = "record-view-field-value";
  value.textContent = links.map((l) => l.raw).join(", ");
  container.appendChild(value);

  const pencil = document.createElement("button");
  pencil.type = "button";
  pencil.className = "record-view-pencil-button";
  pencil.setAttribute("data-edit-action", "open");
  pencil.setAttribute("data-edit-field", opts.fieldPath);
  pencil.setAttribute("data-edit-kind", "doc-links");
  pencil.setAttribute("data-edit-raw-value", JSON.stringify(links));
  container.appendChild(pencil);

  host.appendChild(container);
  document.body.appendChild(host);
  return { pencil, container };
}

function docLinkRows(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>("[data-doclink-row-index]"),
  ).filter((el) => el.tagName.toLowerCase() === "tr");
}

function rowFieldValue(
  row: HTMLElement,
  field: "path" | "anchor" | "raw",
): string {
  const input = row.querySelector<HTMLInputElement>(
    `[data-doclink-field="${field}"]`,
  );
  return input?.value ?? "";
}

describe("ID-20.27 — doc-links editor open + pre-fill from JSON raw-value", () => {
  test("pencil(kind=doc-links) opens a form with one row per existing link", () => {
    const { pencil } = mountDocLinksPencil({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>cross_doc_links",
    });
    const container = clickOpen(pencil);

    const form = container.querySelector("form");
    expect(form).not.toBeNull();
    expect(form!.getAttribute("data-edit-kind")).toBe("doc-links");

    const rows = docLinkRows(container);
    expect(rows).toHaveLength(2);
  });

  test("rows are pre-filled with path / anchor / raw from the JSON raw-value", () => {
    const { pencil } = mountDocLinksPencil({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>cross_doc_links",
    });
    const container = clickOpen(pencil);
    const rows = docLinkRows(container);

    expect(rowFieldValue(rows[0], "path")).toBe(
      "docs/specs/per-task-mirror/PRODUCT.md",
    );
    expect(rowFieldValue(rows[0], "anchor")).toBe("§3.2 invariant 4");
    expect(rowFieldValue(rows[0], "raw")).toBe("PRODUCT.md §3.2 inv 4");

    expect(rowFieldValue(rows[1], "path")).toBe(
      "docs/runbooks/staging-refresh.md",
    );
    expect(rowFieldValue(rows[1], "anchor")).toBe(""); // null → empty
    expect(rowFieldValue(rows[1], "raw")).toBe("staging-refresh runbook");
  });

  test("anchor=null serialises as empty string in the input (not the literal 'null')", () => {
    const { pencil } = mountDocLinksPencil({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>cross_doc_links",
      links: [{ path: "docs/foo.md", anchor: null, raw: "foo" }],
    });
    const container = clickOpen(pencil);
    const rows = docLinkRows(container);
    expect(rows).toHaveLength(1);
    const anchorInput = rows[0].querySelector<HTMLInputElement>(
      '[data-doclink-field="anchor"]',
    );
    expect(anchorInput?.value).toBe("");
    expect(anchorInput?.value).not.toBe("null");
  });

  test("empty-array raw-value: opens form with zero rows + Add link button", () => {
    const { pencil } = mountDocLinksPencil({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>cross_doc_links",
      links: [],
    });
    const container = clickOpen(pencil);
    expect(docLinkRows(container)).toHaveLength(0);
    const addBtn = container.querySelector('[data-doclink-action="add"]');
    expect(addBtn).not.toBeNull();
  });

  test("Save + Cancel controls are present in the form", () => {
    const { pencil } = mountDocLinksPencil({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>cross_doc_links",
    });
    const container = clickOpen(pencil);
    expect(container.querySelector('[data-edit-action="save"]')).not.toBeNull();
    expect(container.querySelector('[data-edit-action="cancel"]')).not.toBeNull();
  });
});

describe("ID-20.27 — doc-links editor add-row", () => {
  test("clicking Add link appends a blank row (3 empty inputs + Delete button)", () => {
    const { pencil } = mountDocLinksPencil({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>cross_doc_links",
      links: [SAMPLE_DOC_LINKS[0]],
    });
    const container = clickOpen(pencil);
    expect(docLinkRows(container)).toHaveLength(1);

    const addBtn = container.querySelector<HTMLButtonElement>(
      '[data-doclink-action="add"]',
    );
    expect(addBtn).not.toBeNull();
    addBtn!.dispatchEvent(new Event("click", { bubbles: true }));

    const rowsAfter = docLinkRows(container);
    expect(rowsAfter).toHaveLength(2);
    expect(rowFieldValue(rowsAfter[1], "path")).toBe("");
    expect(rowFieldValue(rowsAfter[1], "anchor")).toBe("");
    expect(rowFieldValue(rowsAfter[1], "raw")).toBe("");
    expect(
      rowsAfter[1].querySelector('[data-doclink-action="delete"]'),
    ).not.toBeNull();
  });

  test("multiple adds accumulate rows", () => {
    const { pencil } = mountDocLinksPencil({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>cross_doc_links",
      links: [],
    });
    const container = clickOpen(pencil);
    const addBtn = container.querySelector<HTMLButtonElement>(
      '[data-doclink-action="add"]',
    )!;

    addBtn.dispatchEvent(new Event("click", { bubbles: true }));
    addBtn.dispatchEvent(new Event("click", { bubbles: true }));
    addBtn.dispatchEvent(new Event("click", { bubbles: true }));

    expect(docLinkRows(container)).toHaveLength(3);
  });
});

describe("ID-20.27 — doc-links editor delete-row", () => {
  test("clicking Delete on a row removes only that row", () => {
    const { pencil } = mountDocLinksPencil({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>cross_doc_links",
    }); // 2 rows
    const container = clickOpen(pencil);
    expect(docLinkRows(container)).toHaveLength(2);

    const firstRow = docLinkRows(container)[0];
    firstRow
      .querySelector<HTMLButtonElement>('[data-doclink-action="delete"]')!
      .dispatchEvent(new Event("click", { bubbles: true }));

    const rowsAfter = docLinkRows(container);
    expect(rowsAfter).toHaveLength(1);
    expect(rowFieldValue(rowsAfter[0], "path")).toBe(
      "docs/runbooks/staging-refresh.md",
    );
  });

  test("deleting all rows leaves an empty tbody (not null)", () => {
    const { pencil } = mountDocLinksPencil({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>cross_doc_links",
      links: [SAMPLE_DOC_LINKS[0]],
    });
    const container = clickOpen(pencil);
    docLinkRows(container)[0]
      .querySelector<HTMLButtonElement>('[data-doclink-action="delete"]')!
      .dispatchEvent(new Event("click", { bubbles: true }));

    expect(docLinkRows(container)).toHaveLength(0);
    const tbody = container.querySelector("[data-doclink-rows]");
    expect(tbody).not.toBeNull();
  });
});

describe("ID-20.27 — doc-links editor save → full-array patch", () => {
  test("Save sends a DocLink[] full-replacement patch (both rows present)", async () => {
    const { pencil } = mountDocLinksPencil({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>cross_doc_links",
    });
    queuePatchResponse(200, { ok: true, newMtime: "2026-05-26T00:00:02.000Z" });
    const container = clickOpen(pencil);

    (
      container.querySelector('[data-edit-action="save"]') as HTMLButtonElement
    ).dispatchEvent(new Event("click", { bubbles: true }));
    await flushPromises();
    await flushPromises();

    const patchCall = fetchCalls.find((c) => c.init?.method === "PATCH");
    expect(patchCall).toBeDefined();
    const body = JSON.parse(String(patchCall!.init!.body));
    expect(body.patches[0].fieldPath).toEqual(["tasks", "20", "cross_doc_links"]);
    const links = body.patches[0].newValue as DocLink[];
    expect(links).toHaveLength(2);
    expect(links[0].path).toBe("docs/specs/per-task-mirror/PRODUCT.md");
    expect(links[0].anchor).toBe("§3.2 invariant 4");
    expect(links[0].raw).toBe("PRODUCT.md §3.2 inv 4");
    expect(links[1].path).toBe("docs/runbooks/staging-refresh.md");
    expect(links[1].anchor).toBeNull(); // empty string → null
    expect(links[1].raw).toBe("staging-refresh runbook");
  });

  test("add-row then save: new row appears in the patch", async () => {
    const { pencil } = mountDocLinksPencil({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>cross_doc_links",
      links: [SAMPLE_DOC_LINKS[0]],
    });
    queuePatchResponse(200, { ok: true, newMtime: "2026-05-26T00:00:03.000Z" });
    const container = clickOpen(pencil);

    const addBtn = container.querySelector<HTMLButtonElement>(
      '[data-doclink-action="add"]',
    )!;
    addBtn.dispatchEvent(new Event("click", { bubbles: true }));

    const rows = docLinkRows(container);
    expect(rows).toHaveLength(2);
    const newRow = rows[1];
    newRow.querySelector<HTMLInputElement>('[data-doclink-field="path"]')!.value =
      "docs/new-spec.md";
    newRow.querySelector<HTMLInputElement>('[data-doclink-field="raw"]')!.value =
      "new spec link";

    (
      container.querySelector('[data-edit-action="save"]') as HTMLButtonElement
    ).dispatchEvent(new Event("click", { bubbles: true }));
    await flushPromises();
    await flushPromises();

    const patchCall = fetchCalls.find((c) => c.init?.method === "PATCH");
    const body = JSON.parse(String(patchCall!.init!.body));
    const links = body.patches[0].newValue as DocLink[];
    expect(links).toHaveLength(2);
    expect(links[1].path).toBe("docs/new-spec.md");
    expect(links[1].raw).toBe("new spec link");
    expect(links[1].anchor).toBeNull();
  });

  test("delete-row then save: deleted row absent from patch", async () => {
    const { pencil } = mountDocLinksPencil({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>cross_doc_links",
    }); // 2 rows
    queuePatchResponse(200, { ok: true, newMtime: "2026-05-26T00:00:04.000Z" });
    const container = clickOpen(pencil);

    docLinkRows(container)[0]
      .querySelector<HTMLButtonElement>('[data-doclink-action="delete"]')!
      .dispatchEvent(new Event("click", { bubbles: true }));

    (
      container.querySelector('[data-edit-action="save"]') as HTMLButtonElement
    ).dispatchEvent(new Event("click", { bubbles: true }));
    await flushPromises();
    await flushPromises();

    const patchCall = fetchCalls.find((c) => c.init?.method === "PATCH");
    const body = JSON.parse(String(patchCall!.init!.body));
    const links = body.patches[0].newValue as DocLink[];
    expect(links).toHaveLength(1);
    expect(links[0].path).toBe("docs/runbooks/staging-refresh.md");
  });

  test("saving an EMPTY array (all rows deleted) persists [] — not a silent no-op", async () => {
    const { pencil } = mountDocLinksPencil({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>cross_doc_links",
      links: [SAMPLE_DOC_LINKS[0]],
    });
    queuePatchResponse(200, { ok: true, newMtime: "2026-05-26T00:00:05.000Z" });
    const container = clickOpen(pencil);

    docLinkRows(container)[0]
      .querySelector<HTMLButtonElement>('[data-doclink-action="delete"]')!
      .dispatchEvent(new Event("click", { bubbles: true }));

    (
      container.querySelector('[data-edit-action="save"]') as HTMLButtonElement
    ).dispatchEvent(new Event("click", { bubbles: true }));
    await flushPromises();
    await flushPromises();

    const patchCall = fetchCalls.find((c) => c.init?.method === "PATCH");
    expect(patchCall).toBeDefined(); // PATCH was sent (not silently skipped)
    const body = JSON.parse(String(patchCall!.init!.body));
    expect(body.patches[0].newValue).toEqual([]);
  });

  test("200 success: editor closes + container shows updated display", async () => {
    const { pencil } = mountDocLinksPencil({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>cross_doc_links",
    });
    queuePatchResponse(200, { ok: true, newMtime: "2026-05-26T00:00:06.000Z" });
    const container = clickOpen(pencil);

    (
      container.querySelector('[data-edit-action="save"]') as HTMLButtonElement
    ).dispatchEvent(new Event("click", { bubbles: true }));
    await flushPromises();
    await flushPromises();

    expect(container.querySelector("form")).toBeNull();
  });
});

describe("ID-20.27 — doc-links editor 409 / 422 / Esc", () => {
  test("409 stale-mtime keeps the form open + shows inline error", async () => {
    const { pencil } = mountDocLinksPencil({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>cross_doc_links",
    });
    queuePatchResponse(409, {
      ok: false,
      error: "mtime-mismatch",
      currentMtime: "2026-05-26T01:00:00.000Z",
      hint: "Ledger changed underneath you — reload and re-apply.",
    });
    const container = clickOpen(pencil);

    (
      container.querySelector('[data-edit-action="save"]') as HTMLButtonElement
    ).dispatchEvent(new Event("click", { bubbles: true }));
    await flushPromises();
    await flushPromises();

    expect(container.querySelector("form")).not.toBeNull();
    const err = container.querySelector("[data-edit-error]");
    expect(err).not.toBeNull();
    expect(err!.textContent).toContain("Ledger changed");
  });

  test("422 schema-error keeps the form open + shows inline error", async () => {
    const { pencil } = mountDocLinksPencil({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>cross_doc_links",
    });
    queuePatchResponse(422, {
      ok: false,
      error: "schema-error",
      issues: [
        {
          path: ["tasks", 0, "cross_doc_links", 0, "path"],
          message: "String must contain at least 1 character(s)",
        },
      ],
    });
    const container = clickOpen(pencil);

    (
      container.querySelector('[data-edit-action="save"]') as HTMLButtonElement
    ).dispatchEvent(new Event("click", { bubbles: true }));
    await flushPromises();
    await flushPromises();

    expect(container.querySelector("form")).not.toBeNull();
    const err = container.querySelector("[data-edit-error]");
    expect(err).not.toBeNull();
    expect(err!.textContent).toContain("String must contain");
  });

  test("Esc discards the editor without sending a PATCH", () => {
    const { pencil } = mountDocLinksPencil({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>cross_doc_links",
    });
    const container = clickOpen(pencil);

    // Add a row to confirm the discard is real
    container
      .querySelector<HTMLButtonElement>('[data-doclink-action="add"]')!
      .dispatchEvent(new Event("click", { bubbles: true }));
    expect(docLinkRows(container)).toHaveLength(3);

    container.querySelector<HTMLFormElement>("form")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );

    expect(container.querySelector("form")).toBeNull();
    expect(fetchCalls.find((c) => c.init?.method === "PATCH")).toBeUndefined();
    expect(container.textContent).toContain("PRODUCT.md §3.2 inv 4");
  });
});

// ── ID-20.28: re-edit hooks restored after a successful save ─────────────────
//
// After a successful save, `commitDisplay` rebuilds the pencil button. The
// bug: the else-branch (non-doc-links kinds) dropped `data-edit-options` and
// `data-edit-raw-value` from the rebuilt pencil, so a second same-session
// edit opened an enum <select> with zero options and a textarea pre-filled
// with the rendered text instead of the raw Markdown source.
//
// Fix: stash `options` and `rawValue` on `ActiveEdit` at openEditor time and
// write them back onto the rebuilt pencil in commitDisplay for ALL kinds.

describe("ID-20.28 — enum re-edit: rebuilt pencil retains data-edit-options", () => {
  test("after saving an enum field, re-opening the pencil builds a <select> with ALL options (not empty)", async () => {
    // First edit
    const pencil = mountField({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>status",
      kind: "enum",
      displayed: "in_progress",
      options: "done,pending,in_progress,blocked,deferred,cancelled",
    });
    queuePatchResponse(200, { ok: true, newMtime: "2026-05-26T00:01:00.000Z" });

    const container = clickOpen(pencil);
    const select1 = container.querySelector("select") as HTMLSelectElement;
    select1.value = "done";
    select1.dispatchEvent(new Event("change", { bubbles: true }));
    (container.querySelector('[data-edit-action="save"]') as HTMLButtonElement)
      .dispatchEvent(new Event("click", { bubbles: true }));
    await flushPromises();
    await flushPromises();

    // Confirm first save landed + form is gone
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector("form")).toBeNull();

    // Second edit — click the REBUILT pencil
    const rebuiltPencil = container.querySelector<HTMLButtonElement>(
      '[data-edit-action="open"]',
    );
    expect(rebuiltPencil).not.toBeNull();

    rebuiltPencil!.dispatchEvent(new Event("click", { bubbles: true }));

    // The <select> must have all 6 options, NOT zero options
    const select2 = container.querySelector("select");
    expect(select2).not.toBeNull();
    const optionValues = Array.from(
      select2!.querySelectorAll("option"),
    ).map((o) => o.value);
    expect(optionValues).toEqual([
      "done",
      "pending",
      "in_progress",
      "blocked",
      "deferred",
      "cancelled",
    ]);
    // The saved value must be pre-selected
    expect((select2 as HTMLSelectElement).value).toBe("done");
  });

  test("after saving an enum-nullable field, re-opening retains the (unset) sentinel + all options", async () => {
    const pencil = mountField({
      recordId: "3",
      recordKind: "roadmap-theme",
      fieldPath: "themes>3>category",
      kind: "enum-nullable",
      displayed: "alpha",
      options: "alpha,beta,gamma",
    });
    queuePatchResponse(200, { ok: true, newMtime: "2026-05-26T00:01:01.000Z" });

    const container = clickOpen(pencil);
    const select1 = container.querySelector("select") as HTMLSelectElement;
    // Pick a value and save
    select1.value = "beta";
    select1.dispatchEvent(new Event("change", { bubbles: true }));
    (container.querySelector('[data-edit-action="save"]') as HTMLButtonElement)
      .dispatchEvent(new Event("click", { bubbles: true }));
    await flushPromises();
    await flushPromises();

    expect(container.querySelector("form")).toBeNull();

    // Re-open
    container
      .querySelector<HTMLButtonElement>('[data-edit-action="open"]')!
      .dispatchEvent(new Event("click", { bubbles: true }));

    const select2 = container.querySelector("select") as HTMLSelectElement;
    expect(select2).not.toBeNull();
    const opts = Array.from(select2.querySelectorAll("option")).map((o) => o.value);
    // Nullable sentinel ("") + the 3 options
    expect(opts).toEqual(["", "alpha", "beta", "gamma"]);
    expect(select2.value).toBe("beta");
  });
});

describe("ID-20.28 — textarea re-edit: rebuilt pencil retains data-edit-raw-value", () => {
  test("after saving a textarea, the rebuilt pencil carries data-edit-raw-value set to the saved string", async () => {
    // The key invariant: the rebuilt pencil MUST have data-edit-raw-value so that
    // a real browser (where the display span shows *rendered* HTML, not raw source)
    // can pre-fill the editor from the hook rather than from the rendered text.
    // In this DOM test the span holds the raw string too, so we assert on the
    // hook attribute directly — the presence of data-edit-raw-value on the rebuilt
    // pencil is the spec-level invariant (inv 27-28).
    const rawSource =
      "## Title\n\nBody text.\n\n<info added on 2026-05-26>\njournal block\n</info added on 2026-05-26>";
    const pencil = mountField({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>subtasks>4>details",
      kind: "textarea",
      displayed: "Title Body text. journal block",
      rawValue: rawSource,
    });
    queuePatchResponse(200, { ok: true, newMtime: "2026-05-26T00:01:02.000Z" });

    const container = clickOpen(pencil);
    const ta1 = container.querySelector("textarea") as HTMLTextAreaElement;
    const editedRaw =
      "## Title\n\nEdited body.\n\n<info added on 2026-05-26>\njournal block\n</info added on 2026-05-26>";
    ta1.value = editedRaw;
    (container.querySelector('[data-edit-action="save"]') as HTMLButtonElement)
      .dispatchEvent(new Event("click", { bubbles: true }));
    await flushPromises();
    await flushPromises();

    expect(container.querySelector("form")).toBeNull();

    // The rebuilt pencil MUST carry data-edit-raw-value = the saved raw string.
    const rebuiltPencil = container.querySelector<HTMLButtonElement>(
      '[data-edit-action="open"]',
    );
    expect(rebuiltPencil).not.toBeNull();
    expect(rebuiltPencil!.getAttribute("data-edit-raw-value")).toBe(editedRaw);
    // Specifically: the journal block is preserved in the hook value.
    expect(rebuiltPencil!.getAttribute("data-edit-raw-value")).toContain(
      "<info added on 2026-05-26>",
    );
  });

  test("after saving a textarea (no pre-existing rawValue), re-open pre-fills with the raw saved string including Markdown that differs from rendered text", async () => {
    // No rawValue on the initial pencil — first open falls back to textContent.
    // After save, commitDisplay must stash the submitted value on the rebuilt
    // pencil's data-edit-raw-value so re-open reads the raw source, not the
    // now-rendered displayed text (which omits Markdown syntax + journal blocks).
    const pencil = mountField({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>description",
      kind: "textarea",
      displayed: "Original description",
      // no rawValue — first open uses textContent
    });
    queuePatchResponse(200, { ok: true, newMtime: "2026-05-26T00:01:03.000Z" });

    const container = clickOpen(pencil);
    const ta1 = container.querySelector("textarea") as HTMLTextAreaElement;
    // The user types raw Markdown including a journal block — the *saved* value
    // will be this raw string, but the commitDisplay span will show trimmed text
    // (the displayed value loses Markdown and the journal block delimiters)
    const savedRaw =
      "## New heading\n\nSome **bold** text.\n\n<info added on 2026-05-26>\nappended note\n</info added on 2026-05-26>";
    ta1.value = savedRaw;
    (container.querySelector('[data-edit-action="save"]') as HTMLButtonElement)
      .dispatchEvent(new Event("click", { bubbles: true }));
    await flushPromises();
    await flushPromises();

    expect(container.querySelector("form")).toBeNull();

    // Re-open: the textarea MUST pre-fill with savedRaw (the raw string submitted),
    // NOT with the displayed span text (which is just the trimmed version
    // "## New heading\n\nSome **bold** text.\n\n<info added on 2026-05-26>…"
    // because commitDisplay puts rawStr.trim() into valueSpan.textContent).
    // The raw source contains Markdown syntax + the journal block — the
    // data-edit-raw-value hook on the rebuilt pencil is the ONLY source for it.
    container
      .querySelector<HTMLButtonElement>('[data-edit-action="open"]')!
      .dispatchEvent(new Event("click", { bubbles: true }));

    const ta2 = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(ta2.value).toBe(savedRaw);
    expect(ta2.value).toContain("<info added on 2026-05-26>");
  });
});

describe("ID-20.28 — array-comma re-edit: rebuilt pencil retains data-edit-raw-value", () => {
  test("after saving an array-comma field, the rebuilt pencil carries data-edit-raw-value = the saved comma-string", async () => {
    // The rendered display shows link labels ("ID-19, ID-18"), but the raw value
    // is the canonical comma-joined ids ("19,18"). The rebuilt pencil MUST carry
    // data-edit-raw-value = the saved string so a re-open pre-fills with the raw
    // ids, not the rendered label text (which would round-trip wrong values).
    const pencil = mountField({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>subtasks>5>dependencies",
      kind: "array-comma",
      displayed: "ID-19, ID-18",
      rawValue: "19,18",
    });
    queuePatchResponse(200, { ok: true, newMtime: "2026-05-26T00:01:04.000Z" });

    const container = clickOpen(pencil);
    const input1 = container.querySelector("input") as HTMLInputElement;
    expect(input1.value).toBe("19,18"); // raw pre-fill on first open

    // Change and save
    input1.value = "19,18,21";
    (container.querySelector('[data-edit-action="save"]') as HTMLButtonElement)
      .dispatchEvent(new Event("click", { bubbles: true }));
    await flushPromises();
    await flushPromises();

    expect(container.querySelector("form")).toBeNull();

    // The rebuilt pencil MUST carry data-edit-raw-value = the saved comma string.
    const rebuiltPencil = container.querySelector<HTMLButtonElement>(
      '[data-edit-action="open"]',
    );
    expect(rebuiltPencil).not.toBeNull();
    expect(rebuiltPencil!.getAttribute("data-edit-raw-value")).toBe("19,18,21");
  });
});

describe("ID-20.28 — first-edit and doc-links unregressed", () => {
  test("first edit of an enum field still works after the fix", () => {
    const pencil = mountField({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>status",
      kind: "enum",
      displayed: "in_progress",
      options: "done,pending,in_progress,blocked,deferred,cancelled",
    });
    const container = clickOpen(pencil);
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select).not.toBeNull();
    const opts = Array.from(select.querySelectorAll("option")).map((o) => o.value);
    expect(opts).toEqual([
      "done",
      "pending",
      "in_progress",
      "blocked",
      "deferred",
      "cancelled",
    ]);
    expect(select.value).toBe("in_progress");
  });

  test("doc-links re-edit still works (existing coverage, no regression)", async () => {
    const { pencil } = mountDocLinksPencil({
      recordId: "20",
      recordKind: "task",
      fieldPath: "tasks>20>cross_doc_links",
    });
    queuePatchResponse(200, { ok: true, newMtime: "2026-05-26T00:01:05.000Z" });

    const container = clickOpen(pencil);
    (container.querySelector('[data-edit-action="save"]') as HTMLButtonElement)
      .dispatchEvent(new Event("click", { bubbles: true }));
    await flushPromises();
    await flushPromises();

    expect(container.querySelector("form")).toBeNull();

    // Re-open the doc-links editor — must still pre-fill with the saved links
    container
      .querySelector<HTMLButtonElement>('[data-edit-action="open"]')!
      .dispatchEvent(new Event("click", { bubbles: true }));

    const rows = docLinkRows(container);
    expect(rows).toHaveLength(2);
    expect(rowFieldValue(rows[0], "path")).toBe(
      "docs/specs/per-task-mirror/PRODUCT.md",
    );
    expect(rowFieldValue(rows[1], "path")).toBe(
      "docs/runbooks/staging-refresh.md",
    );
  });
});
