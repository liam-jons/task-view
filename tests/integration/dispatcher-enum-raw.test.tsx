/**
 * tests/integration/dispatcher-enum-raw.test.tsx — ID-20.25 dispatcher
 * extensions: the enum `<select>` editor branch + raw-value prefill.
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
 * These tests mount the REAL dispatcher in a happy-dom document and drive
 * it via real DOM events (click / change / keydown) — the first DOM-level
 * coverage of the dispatcher (20.24 only had SSR-markup + pure-helper
 * tests). Network is intercepted via a stubbed global `fetch`.
 *
 * No 20.24 regression: text/textarea/integer/rank behaviour is exercised
 * here too to lock it in.
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
