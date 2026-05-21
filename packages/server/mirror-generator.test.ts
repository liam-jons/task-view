/**
 * Tests for mirror-generator — TECH §3.1, §3.2, §3.3, §3.4.
 *
 * Acceptance gates (per ID-20.7 PLAN):
 *   - "mirror generator produces byte-identical output across runs (snapshot test)"
 *   - "orphan deletion verified by removing a Task and re-running"
 *
 * Covers:
 *   §3.1 — output layout: sibling `tasks/` / `roadmap/` / `backlog/` dir
 *   §3.2 — record-id filename rule (Liam-ratified OQ-C): raw id with
 *          filesystem-unsafe characters substituted to `-`; Task-list
 *          gets `ID-` prefix; Roadmap section gets `section-` prefix.
 *   §3.3 — per-mode mirror content shape (YAML frontmatter + markdown body).
 *   §3.4 — idempotency (byte-identical) + orphan deletion + atomic
 *          write-to-temp + rename.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectSchema } from "./detect-schema";
import {
  computeMirrorDirName,
  computeRecordFilename,
  generateMirrors,
  sanitiseFilenameStem,
} from "./mirror-generator";

let testDir: string;
let ledgerPath: string;
let mirrorDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "task-view-mirror-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const makeTaskList = (taskIds: string[]) => ({
  document_name: "Knowledge Hub Task List",
  document_purpose: "Active + recently-closed structured work — Taskmaster JSON shape.",
  last_updated: "kh-prod-readiness-S63 representative fixture",
  related_documents: ["docs/reference/product-roadmap.json"],
  tasks: taskIds.map((id) => ({
    id,
    title: `Task ${id} title`,
    description: `Description for Task ${id}.`,
    status: "pending",
    priority: "must",
    dependencies: [],
    subtasks: [
      {
        id: 1,
        title: `Subtask ${id}.1 title`,
        description: `Description for Subtask ${id}.1.`,
        status: "pending",
        dependencies: [],
        details: `Details body for Subtask ${id}.1.\n\n<info added on 2026-05-21T15:00:00.000Z>\nJournal block.\n</info added on 2026-05-21T15:00:00.000Z>`,
        testStrategy: `Acceptance for Subtask ${id}.1.`,
      },
    ],
    updatedAt: "2026-05-21T15:30:00.000Z",
    effort_estimate: "~2h",
    owner: "Engineering",
    priority_note: null,
    status_note: null,
    cross_doc_links: [
      {
        path: "docs/specs/per-task-mirror/PRODUCT.md",
        anchor: null,
        raw: "PRODUCT.md",
      },
    ],
    session_refs: ["kh-prod-readiness-S63"],
    commit_refs: ["abc1234"],
  })),
});

const makeRoadmap = () => ({
  document_name: "Knowledge Hub Roadmap",
  document_purpose: "Forward-looking roadmap of Knowledge Hub phases and themes.",
  date: "2026-05-21",
  status: "Active",
  forward_looking_only: true,
  related_documents: ["docs/reference/product-backlog.json"],
  last_updated: "kh-prod-readiness-S63 representative fixture",
  sections: [
    {
      id: "1",
      parent_id: null,
      number: "1",
      title: "Foundation",
      narrative: "Build the foundations.",
      spec_links: [],
      owner: "Engineering",
      table_columns: "item_desc_owner_effort_status",
      items: [
        {
          id: "1.1",
          section_id: "1",
          title: "First item",
          phase_label: null,
          description: "First item description.",
          effort_estimate: null,
          priority: "must",
          priority_note: null,
          severity: null,
          status: "pending",
          status_note: null,
          owner: null,
          depends_on: [],
          blocks: [],
          coordinates_with: [],
          cross_doc_links: [],
          session_refs: [],
          commit_refs: [],
        },
        {
          id: "1.2",
          section_id: "1",
          title: "Second item",
          phase_label: null,
          description: "Second item description.",
          effort_estimate: null,
          priority: "should",
          priority_note: null,
          severity: null,
          status: "pending",
          status_note: null,
          owner: null,
          depends_on: ["1.1"],
          blocks: [],
          coordinates_with: [],
          cross_doc_links: [],
          session_refs: [],
          commit_refs: [],
        },
      ],
    },
  ],
});

const makeBacklog = () => ({
  document_name: "Product Backlog",
  document_purpose: "Forward-looking backlog of unscheduled work items.",
  last_updated: "kh-prod-readiness-S63 representative fixture",
  related_documents: ["docs/reference/product-roadmap.json"],
  items: [
    {
      id: "1",
      description: "First backlog item.",
      type: "feature",
      status: "spec_needed",
      effort_estimate: "~2h",
      priority: "should",
      track: "platform",
      dependencies: [],
      session_refs: ["S63"],
      commit_refs: [],
      cross_doc_links: [],
      notes: "Notes body.",
    },
    {
      id: "2",
      description: "Second backlog item (promotion-ready).",
      type: "bug",
      status: "ready",
      effort_estimate: null,
      priority: "high",
      track: "ux",
      dependencies: ["1"],
      session_refs: [],
      commit_refs: [],
      cross_doc_links: [],
      notes: null,
      details: "Pre-thought details.",
      testStrategy: "Acceptance line.",
    },
  ],
});

// ── §3.2 — record-id filename rule ────────────────────────────────────────────

describe("sanitiseFilenameStem (TECH §3.2)", () => {
  test("leaves safe characters untouched", () => {
    expect(sanitiseFilenameStem("ID-20")).toBe("ID-20");
    expect(sanitiseFilenameStem("3.1.8")).toBe("3.1.8");
    expect(sanitiseFilenameStem("9.18")).toBe("9.18");
    expect(sanitiseFilenameStem("C2-PA5")).toBe("C2-PA5");
  });

  test("substitutes filesystem-unsafe characters to '-'", () => {
    expect(sanitiseFilenameStem("a/b")).toBe("a-b");
    expect(sanitiseFilenameStem("a\\b")).toBe("a-b");
    expect(sanitiseFilenameStem("a:b")).toBe("a-b");
    expect(sanitiseFilenameStem("a*b")).toBe("a-b");
    expect(sanitiseFilenameStem("a?b")).toBe("a-b");
    expect(sanitiseFilenameStem("a\"b")).toBe("a-b");
    expect(sanitiseFilenameStem("a<b")).toBe("a-b");
    expect(sanitiseFilenameStem("a>b")).toBe("a-b");
    expect(sanitiseFilenameStem("a|b")).toBe("a-b");
  });

  test("substitutes control characters (0x00-0x1F + 0x7F) to '-'", () => {
    expect(sanitiseFilenameStem("a\x00b")).toBe("a-b");
    expect(sanitiseFilenameStem("a\x1fb")).toBe("a-b");
    expect(sanitiseFilenameStem("a\x7fb")).toBe("a-b");
  });
});

describe("computeRecordFilename (TECH §3.2 prefix rules)", () => {
  test("Task-list mode adds 'ID-' prefix and '.md' suffix", () => {
    expect(computeRecordFilename("task-list", { id: "20" })).toBe("ID-20.md");
    expect(computeRecordFilename("task-list", { id: "15" })).toBe("ID-15.md");
  });

  test("Roadmap mode (item) uses raw id with '.md' suffix", () => {
    expect(computeRecordFilename("roadmap", { id: "3.1.8" })).toBe("3.1.8.md");
    expect(computeRecordFilename("roadmap", { id: "9.18" })).toBe("9.18.md");
  });

  test("Roadmap mode (section) uses 'section-' prefix", () => {
    expect(computeRecordFilename("roadmap", { id: "1", isSection: true })).toBe(
      "section-1.md",
    );
    expect(
      computeRecordFilename("roadmap", { id: "3.1", isSection: true }),
    ).toBe("section-3.1.md");
  });

  test("Backlog mode uses raw id with '.md' suffix", () => {
    expect(computeRecordFilename("backlog", { id: "30" })).toBe("30.md");
    expect(computeRecordFilename("backlog", { id: "C2-PA5" })).toBe(
      "C2-PA5.md",
    );
  });
});

describe("computeMirrorDirName (TECH §3.1 sibling dir layout)", () => {
  test("task-list → 'tasks'", () => {
    expect(computeMirrorDirName("task-list")).toBe("tasks");
  });
  test("roadmap → 'roadmap'", () => {
    expect(computeMirrorDirName("roadmap")).toBe("roadmap");
  });
  test("backlog → 'backlog'", () => {
    expect(computeMirrorDirName("backlog")).toBe("backlog");
  });
});

// ── §3.3 + §3.4 — content shape + idempotency + orphan deletion ──────────────

describe("generateMirrors — Task-list mode (TECH §3.3, §3.4)", () => {
  beforeEach(async () => {
    ledgerPath = join(testDir, "task-list.json");
    mirrorDir = join(testDir, "tasks");
    await writeFile(
      ledgerPath,
      JSON.stringify(makeTaskList(["20", "21"]), null, 2),
      "utf8",
    );
  });

  test("creates one mirror per Task with `ID-{taskId}.md` filename", async () => {
    const parsed = JSON.parse(await readFile(ledgerPath, "utf8"));
    const detected = detectSchema(parsed);
    expect(detected.kind).toBe("task-list");
    await generateMirrors(detected, ledgerPath);
    const files = (await readdir(mirrorDir)).sort();
    expect(files).toEqual(["ID-20.md", "ID-21.md"]);
  });

  test("mirror content includes YAML frontmatter with structured fields", async () => {
    const parsed = JSON.parse(await readFile(ledgerPath, "utf8"));
    const detected = detectSchema(parsed);
    await generateMirrors(detected, ledgerPath);
    const content = await readFile(join(mirrorDir, "ID-20.md"), "utf8");
    expect(content).toStartWith("---\n");
    expect(content).toContain('type: task\n');
    expect(content).toContain('id: "20"\n');
    expect(content).toContain("title: Task 20 title\n");
    expect(content).toContain("status: pending\n");
    expect(content).toContain("priority: must\n");
    expect(content).toContain("owner: Engineering\n");
  });

  test("mirror body includes Task description as Markdown heading + body", async () => {
    const parsed = JSON.parse(await readFile(ledgerPath, "utf8"));
    const detected = detectSchema(parsed);
    await generateMirrors(detected, ledgerPath);
    const content = await readFile(join(mirrorDir, "ID-20.md"), "utf8");
    expect(content).toContain("# ID-20: Task 20 title");
    expect(content).toContain("Description for Task 20.");
  });

  test("mirror body includes Subtasks section with heading per Subtask", async () => {
    const parsed = JSON.parse(await readFile(ledgerPath, "utf8"));
    const detected = detectSchema(parsed);
    await generateMirrors(detected, ledgerPath);
    const content = await readFile(join(mirrorDir, "ID-20.md"), "utf8");
    expect(content).toContain("## Subtasks");
    expect(content).toContain("### ID-20.1: Subtask 20.1 title");
    expect(content).toContain("Acceptance for Subtask 20.1.");
  });

  test("mirror body preserves Subtask.details verbatim including journal blocks", async () => {
    const parsed = JSON.parse(await readFile(ledgerPath, "utf8"));
    const detected = detectSchema(parsed);
    await generateMirrors(detected, ledgerPath);
    const content = await readFile(join(mirrorDir, "ID-20.md"), "utf8");
    expect(content).toContain("<info added on 2026-05-21T15:00:00.000Z>");
    expect(content).toContain("Journal block.");
    expect(content).toContain("</info added on 2026-05-21T15:00:00.000Z>");
  });

  test("renders `_No subtasks._` when Subtasks array is empty (PRODUCT inv 9 shape supplied via mirror)", async () => {
    const ledger = makeTaskList(["30"]);
    ledger.tasks[0].subtasks = [];
    await writeFile(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");
    const detected = detectSchema(ledger);
    await generateMirrors(detected, ledgerPath);
    const content = await readFile(join(mirrorDir, "ID-30.md"), "utf8");
    expect(content).toContain("## Subtasks");
    expect(content).toContain("_No subtasks._");
  });
});

describe("generateMirrors — Roadmap mode (TECH §3.3)", () => {
  beforeEach(async () => {
    ledgerPath = join(testDir, "product-roadmap.json");
    mirrorDir = join(testDir, "roadmap");
    await writeFile(
      ledgerPath,
      JSON.stringify(makeRoadmap(), null, 2),
      "utf8",
    );
  });

  test("creates one mirror per item plus one section mirror per section", async () => {
    const parsed = JSON.parse(await readFile(ledgerPath, "utf8"));
    const detected = detectSchema(parsed);
    await generateMirrors(detected, ledgerPath);
    const files = (await readdir(mirrorDir)).sort();
    expect(files).toEqual(["1.1.md", "1.2.md", "section-1.md"]);
  });

  test("section mirror contains section narrative + frontmatter type 'roadmap-section'", async () => {
    const parsed = JSON.parse(await readFile(ledgerPath, "utf8"));
    const detected = detectSchema(parsed);
    await generateMirrors(detected, ledgerPath);
    const content = await readFile(join(mirrorDir, "section-1.md"), "utf8");
    expect(content).toContain('type: roadmap-section');
    expect(content).toContain('id: "1"');
    expect(content).toContain("# 1: Foundation");
    expect(content).toContain("Build the foundations.");
  });

  test("item mirror contains item description + frontmatter type 'roadmap-item'", async () => {
    const parsed = JSON.parse(await readFile(ledgerPath, "utf8"));
    const detected = detectSchema(parsed);
    await generateMirrors(detected, ledgerPath);
    const content = await readFile(join(mirrorDir, "1.1.md"), "utf8");
    expect(content).toContain('type: roadmap-item');
    expect(content).toContain('id: "1.1"');
    expect(content).toContain('section_id: "1"');
    expect(content).toContain("# 1.1: First item");
    expect(content).toContain("First item description.");
  });
});

describe("generateMirrors — Backlog mode (TECH §3.3)", () => {
  beforeEach(async () => {
    ledgerPath = join(testDir, "product-backlog.json");
    mirrorDir = join(testDir, "backlog");
    await writeFile(
      ledgerPath,
      JSON.stringify(makeBacklog(), null, 2),
      "utf8",
    );
  });

  test("creates one mirror per backlog item", async () => {
    const parsed = JSON.parse(await readFile(ledgerPath, "utf8"));
    const detected = detectSchema(parsed);
    await generateMirrors(detected, ledgerPath);
    const files = (await readdir(mirrorDir)).sort();
    expect(files).toEqual(["1.md", "2.md"]);
  });

  test("backlog item mirror uses 'type_field' for Zod type (frontmatter 'type' reserved for document class)", async () => {
    const parsed = JSON.parse(await readFile(ledgerPath, "utf8"));
    const detected = detectSchema(parsed);
    await generateMirrors(detected, ledgerPath);
    const content = await readFile(join(mirrorDir, "1.md"), "utf8");
    expect(content).toContain('type: backlog-item');
    expect(content).toContain('type_field: feature');
  });

  test("backlog item mirror with details + testStrategy preserves both in body", async () => {
    const parsed = JSON.parse(await readFile(ledgerPath, "utf8"));
    const detected = detectSchema(parsed);
    await generateMirrors(detected, ledgerPath);
    const content = await readFile(join(mirrorDir, "2.md"), "utf8");
    expect(content).toContain("Pre-thought details.");
    expect(content).toContain("Acceptance line.");
  });
});

// ── §3.4 idempotency + orphan deletion ────────────────────────────────────────

describe("generateMirrors — idempotency (TECH §3.4)", () => {
  beforeEach(async () => {
    ledgerPath = join(testDir, "task-list.json");
    mirrorDir = join(testDir, "tasks");
    await writeFile(
      ledgerPath,
      JSON.stringify(makeTaskList(["20"]), null, 2),
      "utf8",
    );
  });

  test("produces byte-identical output across repeated runs (Task-list mode)", async () => {
    const parsed = JSON.parse(await readFile(ledgerPath, "utf8"));
    const detected = detectSchema(parsed);
    await generateMirrors(detected, ledgerPath);
    const first = await readFile(join(mirrorDir, "ID-20.md"), "utf8");
    await generateMirrors(detected, ledgerPath);
    const second = await readFile(join(mirrorDir, "ID-20.md"), "utf8");
    expect(second).toBe(first);
  });

  test("produces byte-identical output across repeated runs (Roadmap mode)", async () => {
    ledgerPath = join(testDir, "product-roadmap.json");
    mirrorDir = join(testDir, "roadmap");
    await writeFile(ledgerPath, JSON.stringify(makeRoadmap(), null, 2), "utf8");
    const detected = detectSchema(makeRoadmap());
    await generateMirrors(detected, ledgerPath);
    const first = await readFile(join(mirrorDir, "1.1.md"), "utf8");
    await generateMirrors(detected, ledgerPath);
    const second = await readFile(join(mirrorDir, "1.1.md"), "utf8");
    expect(second).toBe(first);
  });

  test("produces byte-identical output across repeated runs (Backlog mode)", async () => {
    ledgerPath = join(testDir, "product-backlog.json");
    mirrorDir = join(testDir, "backlog");
    await writeFile(ledgerPath, JSON.stringify(makeBacklog(), null, 2), "utf8");
    const detected = detectSchema(makeBacklog());
    await generateMirrors(detected, ledgerPath);
    const first = await readFile(join(mirrorDir, "1.md"), "utf8");
    await generateMirrors(detected, ledgerPath);
    const second = await readFile(join(mirrorDir, "1.md"), "utf8");
    expect(second).toBe(first);
  });
});

describe("generateMirrors — orphan deletion (TECH §3.4)", () => {
  beforeEach(async () => {
    ledgerPath = join(testDir, "task-list.json");
    mirrorDir = join(testDir, "tasks");
  });

  test("removes mirrors for Tasks no longer in canonical (Task-list)", async () => {
    // First run: 2 Tasks
    await writeFile(
      ledgerPath,
      JSON.stringify(makeTaskList(["20", "21"]), null, 2),
      "utf8",
    );
    await generateMirrors(detectSchema(makeTaskList(["20", "21"])), ledgerPath);
    expect((await readdir(mirrorDir)).sort()).toEqual(["ID-20.md", "ID-21.md"]);

    // Second run with Task 21 removed
    await writeFile(
      ledgerPath,
      JSON.stringify(makeTaskList(["20"]), null, 2),
      "utf8",
    );
    await generateMirrors(detectSchema(makeTaskList(["20"])), ledgerPath);
    expect((await readdir(mirrorDir)).sort()).toEqual(["ID-20.md"]);
  });

  test("removes mirrors for Roadmap items no longer in canonical", async () => {
    ledgerPath = join(testDir, "product-roadmap.json");
    mirrorDir = join(testDir, "roadmap");
    await writeFile(ledgerPath, JSON.stringify(makeRoadmap(), null, 2), "utf8");
    await generateMirrors(detectSchema(makeRoadmap()), ledgerPath);
    expect((await readdir(mirrorDir)).sort()).toEqual([
      "1.1.md",
      "1.2.md",
      "section-1.md",
    ]);

    // Drop item 1.2 from the canonical
    const trimmed = makeRoadmap();
    trimmed.sections[0].items = trimmed.sections[0].items.filter(
      (i) => i.id !== "1.2",
    );
    await writeFile(ledgerPath, JSON.stringify(trimmed, null, 2), "utf8");
    await generateMirrors(detectSchema(trimmed), ledgerPath);
    expect((await readdir(mirrorDir)).sort()).toEqual([
      "1.1.md",
      "section-1.md",
    ]);
  });

  test("removes mirrors for backlog items no longer in canonical", async () => {
    ledgerPath = join(testDir, "product-backlog.json");
    mirrorDir = join(testDir, "backlog");
    await writeFile(ledgerPath, JSON.stringify(makeBacklog(), null, 2), "utf8");
    await generateMirrors(detectSchema(makeBacklog()), ledgerPath);
    expect((await readdir(mirrorDir)).sort()).toEqual(["1.md", "2.md"]);

    // Drop item 2
    const trimmed = makeBacklog();
    trimmed.items = trimmed.items.filter((i) => i.id !== "2");
    await writeFile(ledgerPath, JSON.stringify(trimmed, null, 2), "utf8");
    await generateMirrors(detectSchema(trimmed), ledgerPath);
    expect((await readdir(mirrorDir)).sort()).toEqual(["1.md"]);
  });

  test("ignores non-.md files in mirror dir (does not delete e.g. .gitkeep)", async () => {
    await writeFile(
      ledgerPath,
      JSON.stringify(makeTaskList(["20"]), null, 2),
      "utf8",
    );
    await generateMirrors(detectSchema(makeTaskList(["20"])), ledgerPath);
    // Add a non-mirror file
    await writeFile(join(mirrorDir, ".gitkeep"), "", "utf8");
    await generateMirrors(detectSchema(makeTaskList(["20"])), ledgerPath);
    const files = (await readdir(mirrorDir)).sort();
    expect(files).toContain(".gitkeep");
    expect(files).toContain("ID-20.md");
  });
});

// ── §3.4 first-run / mirror absence (PRODUCT inv 40) ──────────────────────────

describe("generateMirrors — first-run tolerance (PRODUCT inv 40)", () => {
  test("creates mirror directory when it does not exist", async () => {
    ledgerPath = join(testDir, "task-list.json");
    mirrorDir = join(testDir, "tasks");
    await writeFile(
      ledgerPath,
      JSON.stringify(makeTaskList(["20"]), null, 2),
      "utf8",
    );
    // mirrorDir does not exist yet
    await generateMirrors(detectSchema(makeTaskList(["20"])), ledgerPath);
    const files = await readdir(mirrorDir);
    expect(files).toContain("ID-20.md");
  });
});

// ── §3.4 atomic write-to-temp + rename ────────────────────────────────────────

describe("generateMirrors — atomic write (TECH §3.4)", () => {
  test("does not leave .tmp files in mirror dir on successful write", async () => {
    ledgerPath = join(testDir, "task-list.json");
    mirrorDir = join(testDir, "tasks");
    await writeFile(
      ledgerPath,
      JSON.stringify(makeTaskList(["20", "21", "22"]), null, 2),
      "utf8",
    );
    await generateMirrors(
      detectSchema(makeTaskList(["20", "21", "22"])),
      ledgerPath,
    );
    const files = await readdir(mirrorDir);
    expect(files.filter((f) => f.endsWith(".tmp") || f.includes(".tmp."))).toEqual(
      [],
    );
  });
});
