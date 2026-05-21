/**
 * Tests for path-resolution — TECH §2.2 + §2.3.
 *
 * Acceptance gates (per ID-20.7 PLAN):
 *   "record-level path resolution opens parent ledger + preselects named
 *    record via ?record= URL fragment per TECH §2.2"
 *
 * Covers:
 *   §2.2 — record-level path resolution: .md filename → ascend one dir,
 *          find sibling JSON matching one of the three document_name
 *          literals, return { ledgerPath, kind, recordId, mirrorPath }.
 *   §2.3 — CWD inference: when no path argument, scan CWD for files
 *          matching the three known document_name literals; return
 *          exactly-one / zero / multiple results.
 *
 * Reads ledger JSON files lazily and tolerantly: parse failures during
 * scanning are "skip" not "error" (per TECH §2.3 wording "lenient").
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveLedgerForPath,
  scanForLedgers,
  buildLedgerLaunchUrl,
} from "./path-resolution";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "task-view-path-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

const minimalTaskListJson = JSON.stringify({
  document_name: "Knowledge Hub Task List",
  document_purpose: "Active + recently-closed structured work — Taskmaster JSON shape.",
  last_updated: "kh-prod-readiness-S63 representative fixture",
  related_documents: [],
  tasks: [
    {
      id: "20",
      title: "Per-Task mirror",
      description: "Outer task description.",
      status: "in_progress",
      priority: "must",
      dependencies: [],
      subtasks: [],
      updatedAt: "2026-05-21T15:30:00.000Z",
      effort_estimate: "~2-3h",
      owner: "Engineering",
      priority_note: null,
      status_note: null,
      cross_doc_links: [],
      session_refs: [],
      commit_refs: [],
    },
  ],
}, null, 2);

const minimalRoadmapJson = JSON.stringify({
  document_name: "Knowledge Hub Roadmap",
  document_purpose: "Forward-looking roadmap.",
  date: "2026-05-21",
  status: "Active",
  forward_looking_only: true,
  related_documents: [],
  last_updated: "kh-prod-readiness-S63 representative fixture",
  sections: [],
}, null, 2);

const minimalBacklogJson = JSON.stringify({
  document_name: "Product Backlog",
  document_purpose: "Forward-looking backlog.",
  last_updated: "kh-prod-readiness-S63 representative fixture",
  related_documents: [],
  items: [],
}, null, 2);

// ── §2.2 — record-level path resolution ──────────────────────────────────────

describe("resolveLedgerForPath — JSON ledger path (passthrough)", () => {
  test("returns ledger path unchanged when input is the canonical JSON itself", async () => {
    const ledgerPath = join(testDir, "task-list.json");
    await writeFile(ledgerPath, minimalTaskListJson, "utf8");
    const result = await resolveLedgerForPath(ledgerPath);
    expect(result.kind).toBe("ledger");
    if (result.kind === "ledger") {
      expect(result.ledgerPath).toBe(ledgerPath);
      expect(result.documentName).toBe("Knowledge Hub Task List");
      expect(result.recordId).toBeNull();
    }
  });
});

describe("resolveLedgerForPath — mirror .md path (record-level)", () => {
  test("ascends one dir + finds sibling task-list.json + extracts recordId from filename", async () => {
    const ledgerPath = join(testDir, "task-list.json");
    await writeFile(ledgerPath, minimalTaskListJson, "utf8");
    const mirrorDir = join(testDir, "tasks");
    await mkdir(mirrorDir, { recursive: true });
    const mirrorPath = join(mirrorDir, "ID-20.md");
    await writeFile(mirrorPath, "---\nid: \"20\"\n---\n\n# ID-20", "utf8");

    const result = await resolveLedgerForPath(mirrorPath);
    expect(result.kind).toBe("ledger");
    if (result.kind === "ledger") {
      expect(result.ledgerPath).toBe(ledgerPath);
      expect(result.documentName).toBe("Knowledge Hub Task List");
      expect(result.recordId).toBe("20");
    }
  });

  test("strips 'ID-' prefix to recover Task id from Task-list mirror filename", async () => {
    const ledgerPath = join(testDir, "task-list.json");
    await writeFile(ledgerPath, minimalTaskListJson, "utf8");
    const mirrorDir = join(testDir, "tasks");
    await mkdir(mirrorDir, { recursive: true });
    await writeFile(join(mirrorDir, "ID-15.md"), "", "utf8");

    const result = await resolveLedgerForPath(join(mirrorDir, "ID-15.md"));
    if (result.kind !== "ledger") throw new Error("Expected ledger result");
    expect(result.recordId).toBe("15");
  });

  test("strips 'section-' prefix to recover section id from Roadmap mirror filename", async () => {
    const ledgerPath = join(testDir, "product-roadmap.json");
    await writeFile(ledgerPath, minimalRoadmapJson, "utf8");
    const mirrorDir = join(testDir, "roadmap");
    await mkdir(mirrorDir, { recursive: true });
    await writeFile(join(mirrorDir, "section-3.1.md"), "", "utf8");

    const result = await resolveLedgerForPath(
      join(mirrorDir, "section-3.1.md"),
    );
    if (result.kind !== "ledger") throw new Error("Expected ledger result");
    expect(result.documentName).toBe("Knowledge Hub Roadmap");
    expect(result.recordId).toBe("3.1");
    expect(result.recordIsSection).toBe(true);
  });

  test("preserves raw id for Roadmap item mirrors (no prefix to strip)", async () => {
    const ledgerPath = join(testDir, "product-roadmap.json");
    await writeFile(ledgerPath, minimalRoadmapJson, "utf8");
    const mirrorDir = join(testDir, "roadmap");
    await mkdir(mirrorDir, { recursive: true });
    await writeFile(join(mirrorDir, "3.1.8.md"), "", "utf8");

    const result = await resolveLedgerForPath(join(mirrorDir, "3.1.8.md"));
    if (result.kind !== "ledger") throw new Error("Expected ledger result");
    expect(result.documentName).toBe("Knowledge Hub Roadmap");
    expect(result.recordId).toBe("3.1.8");
    expect(result.recordIsSection).toBeFalsy();
  });

  test("preserves raw id for Backlog mirrors", async () => {
    const ledgerPath = join(testDir, "product-backlog.json");
    await writeFile(ledgerPath, minimalBacklogJson, "utf8");
    const mirrorDir = join(testDir, "backlog");
    await mkdir(mirrorDir, { recursive: true });
    await writeFile(join(mirrorDir, "30.md"), "", "utf8");

    const result = await resolveLedgerForPath(join(mirrorDir, "30.md"));
    if (result.kind !== "ledger") throw new Error("Expected ledger result");
    expect(result.documentName).toBe("Product Backlog");
    expect(result.recordId).toBe("30");
  });
});

describe("resolveLedgerForPath — error cases (PRODUCT inv 43 alignment)", () => {
  test("returns kind:'no-ledger' when mirror has no sibling ledger JSON", async () => {
    const mirrorDir = join(testDir, "tasks");
    await mkdir(mirrorDir, { recursive: true });
    await writeFile(join(mirrorDir, "ID-20.md"), "", "utf8");

    const result = await resolveLedgerForPath(join(mirrorDir, "ID-20.md"));
    expect(result.kind).toBe("no-ledger");
  });

  test("returns kind:'multiple-ledgers' when mirror parent dir contains multiple ledger JSONs", async () => {
    await writeFile(join(testDir, "task-list.json"), minimalTaskListJson, "utf8");
    await writeFile(join(testDir, "product-roadmap.json"), minimalRoadmapJson, "utf8");
    const mirrorDir = join(testDir, "tasks");
    await mkdir(mirrorDir, { recursive: true });
    await writeFile(join(mirrorDir, "ID-20.md"), "", "utf8");

    const result = await resolveLedgerForPath(join(mirrorDir, "ID-20.md"));
    expect(result.kind).toBe("multiple-ledgers");
    if (result.kind === "multiple-ledgers") {
      expect(result.paths.sort()).toEqual([
        join(testDir, "product-roadmap.json"),
        join(testDir, "task-list.json"),
      ]);
    }
  });

  test("returns kind:'file-not-found' when path does not exist", async () => {
    const result = await resolveLedgerForPath(
      join(testDir, "does-not-exist.json"),
    );
    expect(result.kind).toBe("file-not-found");
  });

  test("returns kind:'unknown-format' when JSON path is not a recognised ledger", async () => {
    const path = join(testDir, "stuff.json");
    await writeFile(path, JSON.stringify({ document_name: "Some Other Doc" }), "utf8");
    const result = await resolveLedgerForPath(path);
    expect(result.kind).toBe("unknown-format");
    if (result.kind === "unknown-format") {
      expect(result.documentName).toBe("Some Other Doc");
    }
  });

  test("returns kind:'unknown-format' when JSON file fails to parse", async () => {
    const path = join(testDir, "broken.json");
    await writeFile(path, "{ not valid json", "utf8");
    const result = await resolveLedgerForPath(path);
    expect(result.kind).toBe("unknown-format");
  });
});

// ── §2.3 — CWD inference ──────────────────────────────────────────────────────

describe("scanForLedgers (TECH §2.3)", () => {
  test("finds exactly one ledger in CWD when one canonical name present", async () => {
    await writeFile(join(testDir, "task-list.json"), minimalTaskListJson, "utf8");
    const result = await scanForLedgers(testDir);
    expect(result.kind).toBe("one");
    if (result.kind === "one") {
      expect(result.path).toBe(join(testDir, "task-list.json"));
      expect(result.documentName).toBe("Knowledge Hub Task List");
    }
  });

  test("finds all three when all three canonical-named files present", async () => {
    await writeFile(join(testDir, "task-list.json"), minimalTaskListJson, "utf8");
    await writeFile(join(testDir, "product-roadmap.json"), minimalRoadmapJson, "utf8");
    await writeFile(join(testDir, "product-backlog.json"), minimalBacklogJson, "utf8");
    const result = await scanForLedgers(testDir);
    expect(result.kind).toBe("multiple");
    if (result.kind === "multiple") {
      expect(result.paths).toHaveLength(3);
      expect(result.paths.sort()).toEqual([
        join(testDir, "product-backlog.json"),
        join(testDir, "product-roadmap.json"),
        join(testDir, "task-list.json"),
      ]);
    }
  });

  test("returns 'none' when no JSON in CWD matches a known document_name", async () => {
    await writeFile(
      join(testDir, "unrelated.json"),
      JSON.stringify({ document_name: "Random Doc" }),
      "utf8",
    );
    const result = await scanForLedgers(testDir);
    expect(result.kind).toBe("none");
  });

  test("returns 'none' when CWD has no JSON files at all", async () => {
    const result = await scanForLedgers(testDir);
    expect(result.kind).toBe("none");
  });

  test("skips JSON files that fail to parse (lenient scan)", async () => {
    await writeFile(join(testDir, "broken.json"), "{ malformed", "utf8");
    await writeFile(join(testDir, "task-list.json"), minimalTaskListJson, "utf8");
    const result = await scanForLedgers(testDir);
    expect(result.kind).toBe("one");
    if (result.kind === "one") {
      expect(result.path).toBe(join(testDir, "task-list.json"));
    }
  });

  test("does not recurse into subdirectories (TECH §2.3 explicit non-recursive)", async () => {
    const subdir = join(testDir, "subdir");
    await mkdir(subdir, { recursive: true });
    await writeFile(join(subdir, "task-list.json"), minimalTaskListJson, "utf8");
    const result = await scanForLedgers(testDir);
    expect(result.kind).toBe("none");
  });
});

// ── ?record= URL fragment construction (acceptance for ID-20.7) ───────────────

describe("buildLedgerLaunchUrl — ?record= preselection (TECH §2.2 last paragraph)", () => {
  test("appends ?record={raw-id} when recordId is supplied", () => {
    const url = buildLedgerLaunchUrl("http://localhost:8765", {
      recordId: "ID-20",
    });
    expect(url).toBe("http://localhost:8765/?record=ID-20");
  });

  test("URL-encodes the recordId when it contains reserved characters", () => {
    const url = buildLedgerLaunchUrl("http://localhost:8765", {
      recordId: "3.1.8",
    });
    // dot is unreserved in query; should pass through
    expect(url).toBe("http://localhost:8765/?record=3.1.8");
  });

  test("returns the bare URL when no recordId is supplied", () => {
    const url = buildLedgerLaunchUrl("http://localhost:8765", {});
    expect(url).toBe("http://localhost:8765/");
  });

  test("preserves recordIsSection signal via &section=1 when true", () => {
    const url = buildLedgerLaunchUrl("http://localhost:8765", {
      recordId: "3.1",
      recordIsSection: true,
    });
    expect(url).toBe("http://localhost:8765/?record=3.1&section=1");
  });
});
