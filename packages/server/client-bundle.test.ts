/**
 * client-bundle.test.ts — ID-20.24 build-bridge.
 *
 * Verifies that the progressive-enhancement client bundle is built (via
 * Bun.build at boot), cached in-process, and SERVED from its own cacheable
 * route (GET /client.js) — referenced by the SSR HTML rather than inlined,
 * so the ~1MB bundle is fetched once + revalidated (304) instead of
 * re-shipped in every page. No separate dev server, no committed dist
 * artifact (PRODUCT inv 44 single-file CLI distribution).
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

describe("GET / + GET /client.js — client bundle served, not inlined (ID-20.24)", () => {
  test("GET / references the client bundle via <script src> (not inlined)", async () => {
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
    // The hydration bundle is referenced by src — NOT inlined (the ~1MB JS
    // no longer rides inside every page; its body lives behind /client.js).
    expect(html).toContain('<script type="module" src="/client.js"></script>');
    expect(html).not.toContain("/api/ledger/record/");
    // Script tag sits at the end of <body> after the markup.
    const scriptIdx = html.indexOf("<script");
    const markupIdx = html.indexOf('data-record-kind="backlog-index"');
    expect(scriptIdx).toBeGreaterThan(markupIdx);
  });

  test("GET /client.js serves the byte-identical bundle as JavaScript", async () => {
    const ledger = await writeBacklog();
    handle = startPatchServer({ ledgerPath: ledger });

    const res = await fetch(`${handle.url}/client.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const served = await res.text();
    const bundle = await getClientBundle();
    expect(served).toBe(bundle);
    // The dispatch wiring lives in the served bundle, not the page HTML.
    expect(served).toContain("/api/ledger/record/");
  });

  test("GET /client.js revalidates via ETag (304 on If-None-Match)", async () => {
    const ledger = await writeBacklog();
    handle = startPatchServer({ ledgerPath: ledger });

    const first = await fetch(`${handle.url}/client.js`);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    await first.text();

    const second = await fetch(`${handle.url}/client.js`, {
      headers: { "if-none-match": etag as string },
    });
    expect(second.status).toBe(304);
  });
});
