/**
 * client-bundle.test.ts — ID-20.24 build-bridge.
 *
 * Verifies that the progressive-enhancement client bundle is built (via
 * Bun.build at boot), cached in-process, and inlined into the GET / SSR
 * HTML as a self-contained <script> — with no separate dev server and no
 * committed dist artifact (PRODUCT inv 44 single-file CLI distribution).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  _resetClientBundleCacheForTests,
  getClientBundle,
} from "./client-bundle";
import { startPatchServer, type PatchServerHandle } from "./patch-server";

let testDir: string;
let handle: PatchServerHandle | undefined;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "task-view-client-bundle-test-"));
  _resetClientBundleCacheForTests();
});

afterEach(async () => {
  if (handle) {
    await handle.stop(true);
    handle = undefined;
  }
  await rm(testDir, { recursive: true, force: true });
});

const BACKLOG_LEDGER = {
  document_name: "Product Backlog",
  document_purpose: "fixture",
  related_documents: [],
  items: [
    {
      id: "30",
      description: "A backlog item",
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
};

async function writeBacklog(): Promise<string> {
  const p = join(testDir, "product-backlog.json");
  await writeFile(p, JSON.stringify(BACKLOG_LEDGER, null, 2), "utf8");
  return p;
}

describe("getClientBundle — Bun.build at boot, cached", () => {
  test("builds a non-empty IIFE bundle containing the dispatch wiring", async () => {
    const js = await getClientBundle();
    expect(js.length).toBeGreaterThan(0);
    // Not the inert fallback.
    expect(js).not.toContain("client bundle failed to build");
    // The dispatch core + PATCH wiring landed in the bundle.
    expect(js).toContain("/api/ledger/record/");
    expect(js).toContain("fetch");
  });

  test("second call returns the SAME cached string (no rebuild)", async () => {
    const a = await getClientBundle();
    const b = await getClientBundle();
    expect(a).toBe(b);
  });
});

describe("GET / — inlines the client bundle <script> (ID-20.24)", () => {
  test("HTML carries the doctype, the SSR markup, and an inline module <script>", async () => {
    const ledger = await writeBacklog();
    handle = startPatchServer({ ledgerPath: ledger });

    const res = await fetch(`${handle.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const html = await res.text();
    // SSR markup is present (the rank affordance hook from backlog-index).
    expect(html).toContain('data-record-kind="backlog-index"');
    expect(html).toContain('data-edit-action="open"');
    expect(html).toContain('data-edit-kind="integer-nullable"');
    // The hydration script is inlined (no separate dev server).
    expect(html).toContain('<script type="module">');
    expect(html).toContain("/api/ledger/record/");
    // Script sits at the end of <body> after the markup.
    const scriptIdx = html.indexOf('<script type="module">');
    const markupIdx = html.indexOf('data-record-kind="backlog-index"');
    expect(scriptIdx).toBeGreaterThan(markupIdx);
  });

  test("the bundle inlined into HTML is byte-identical to getClientBundle()", async () => {
    const ledger = await writeBacklog();
    handle = startPatchServer({ ledgerPath: ledger });
    const res = await fetch(`${handle.url}/`);
    const html = await res.text();
    const bundle = await getClientBundle();
    // The inlined script body contains the bundle (modulo </script>
    // neutralisation, which the minified IIFE bundle does not trigger).
    expect(html).toContain(bundle);
  });
});
