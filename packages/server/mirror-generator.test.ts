/**
 * Tests for mirror-generator — TECH §3.1, §3.2, §3.3, §3.4.
 *
 * Acceptance gates (per ID-20.7 PLAN, extended by ID-148.10 INV-9):
 *   - "mirror generator produces byte-identical output across runs (snapshot test)"
 *   - "orphan deletion verified by removing a Task and re-running"
 *   - detect-schema routes initiatives; mirror-generator emits initiatives +
 *     retros mirrors (ID-148.10 testStrategy).
 *
 * Covers:
 *   §3.1 — output layout: sibling `tasks/` / `initiatives/` / `backlog/` /
 *          `retros/` dir (ID-148.10: `roadmap` repurposed to `initiatives`;
 *          `retros` newly added — was previously excluded, INV-9).
 *   §3.2 — record-id filename rule (Liam-ratified OQ-C): raw id with
 *          filesystem-unsafe characters substituted to `-`; Task-list
 *          gets `ID-` prefix; Initiative (top-level) / Backlog item / Retro
 *          use the raw id.
 *   §3.3 — per-mode mirror content shape (YAML frontmatter + markdown body).
 *          Initiatives: ONE mirror per TOP-LEVEL initiative, nested
 *          sub-initiative -> project tree renders inline (INV-9).
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
  generateRecordMirror,
  generateRecordMirrors,
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
  related_documents: ["docs/reference/initiatives.json"],
  tasks: taskIds.map((id) => ({
    id,
    title: `Task ${id} title`,
    description: `Description for Task ${id}.`,
    status: "pending",
    priority: "must",
    dependencies: [],
    subtasks: [
      {
        id: "1",
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

/**
 * A two-initiative fixture (ID-148.10): initiative "1" carries ONE direct
 * project; initiative "2" carries a nested sub-initiative "2.1" with its
 * own project — so both the flat-project and nested-tree render paths are
 * exercised in a single fixture.
 */
const makeInitiatives = () => ({
  document_name: "Canonical Platform - Initiatives",
  document_purpose: "Structured record of active initiatives and their constituent projects.",
  date: "2026-07-15",
  status: "active",
  related_documents: ["docs/reference/product-backlog.json"],
  last_updated: "kh-main-S473 representative fixture",
  initiatives: [
    {
      id: "1",
      title: "Foundation",
      description: "Build the foundations.",
      status: "active",
      projects: [
        {
          id: "foundation-project",
          title: "Foundation project",
          summary: "One-sentence summary.",
          description: "Fuller description.",
          substrate_doc: "",
          status: "in-progress",
          blocked_by: [],
          blocking: [],
          linked_tasks: ["20"],
          linked_backlog: [],
          originating_session: ["S63"],
        },
      ],
      originating_session: ["S63"],
      "sub-initiatives": [],
    },
    {
      id: "2",
      title: "Expansion",
      description: "Expand the platform.",
      status: "proposed",
      projects: [],
      originating_session: [],
      "sub-initiatives": [
        {
          id: "1",
          title: "Sub expansion",
          description: "Nested sub-initiative.",
          status: "planned",
          projects: [
            {
              id: "nested-project",
              title: "Nested project",
              summary: "Nested summary.",
              description: "",
              substrate_doc: "",
              status: "backlog",
              blocked_by: [],
              blocking: [],
              linked_tasks: [],
              linked_backlog: ["45"],
              originating_session: [],
            },
          ],
          originating_session: [],
          "sub-initiatives": [],
        },
      ],
    },
  ],
});

const makeBacklog = () => ({
  document_name: "Product Backlog",
  document_purpose: "Forward-looking backlog of unscheduled work items.",
  related_documents: ["docs/reference/initiatives.json"],
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

const makeRetros = () => ({
  document_name: "Knowledge Hub Retros",
  document_purpose: "Session retros.",
  related_documents: [],
  last_updated: "kh-main-S473 fixture",
  retros: [
    {
      id: "S473",
      session_id: "kh-main-S473",
      date: "2026-07-15",
      track: "main",
      session_refs: [],
      commit_refs: [],
      cross_doc_links: [],
      bugs_discovered: [{ text: "Found a bug.", cross_doc_links: [] }],
      failed_assumptions: [],
      architecture_decisions: [],
      rejected_approaches: [],
      workflow_improvements: [],
      unresolved_questions: [],
      deprecated: false,
      deprecation_reason: null,
      superseding_record_id: null,
      last_conflict_check: null,
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

  test("Initiatives mode uses the raw TOP-LEVEL initiative id with '.md' suffix (ID-148.10, INV-9)", () => {
    expect(computeRecordFilename("initiatives", { id: "1" })).toBe("1.md");
    expect(computeRecordFilename("initiatives", { id: "42" })).toBe("42.md");
  });

  test("Backlog mode uses raw id with '.md' suffix", () => {
    expect(computeRecordFilename("backlog", { id: "30" })).toBe("30.md");
    expect(computeRecordFilename("backlog", { id: "C2-PA5" })).toBe(
      "C2-PA5.md",
    );
  });

  test("Retro mode uses the raw session id with '.md' suffix (ID-148.10, INV-9)", () => {
    expect(computeRecordFilename("retro", { id: "S473" })).toBe("S473.md");
  });
});

describe("computeMirrorDirName (TECH §3.1 sibling dir layout)", () => {
  test("task-list → 'tasks'", () => {
    expect(computeMirrorDirName("task-list")).toBe("tasks");
  });
  test("initiatives → 'initiatives' (ID-148.10, repurposed from 'roadmap')", () => {
    expect(computeMirrorDirName("initiatives")).toBe("initiatives");
  });
  test("backlog → 'backlog'", () => {
    expect(computeMirrorDirName("backlog")).toBe("backlog");
  });
  test("retro → 'retros' (ID-148.10, INV-9 — newly mirrored)", () => {
    expect(computeMirrorDirName("retro")).toBe("retros");
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

describe("generateMirrors — Initiatives mode (ID-148.10, TECH §3.3, INV-9)", () => {
  beforeEach(async () => {
    ledgerPath = join(testDir, "initiatives.json");
    mirrorDir = join(testDir, "initiatives");
    await writeFile(
      ledgerPath,
      JSON.stringify(makeInitiatives(), null, 2),
      "utf8",
    );
  });

  test("creates ONE mirror per TOP-LEVEL initiative id (not per project, not per sub-initiative)", async () => {
    const parsed = JSON.parse(await readFile(ledgerPath, "utf8"));
    const detected = detectSchema(parsed);
    expect(detected.kind).toBe("initiatives");
    await generateMirrors(detected, ledgerPath);
    const files = (await readdir(mirrorDir)).sort();
    expect(files).toEqual(["1.md", "2.md"]);
  });

  test("initiative mirror contains description + frontmatter type 'initiative' + its direct project", async () => {
    const parsed = JSON.parse(await readFile(ledgerPath, "utf8"));
    const detected = detectSchema(parsed);
    await generateMirrors(detected, ledgerPath);
    const content = await readFile(join(mirrorDir, "1.md"), "utf8");
    expect(content).toContain("type: initiative");
    expect(content).toContain('id: "1"');
    expect(content).toContain("status: active");
    expect(content).toContain("# 1: Foundation");
    expect(content).toContain("Build the foundations.");
    expect(content).toContain("## Projects");
    expect(content).toContain("foundation-project");
    expect(content).toContain("Foundation project");
    expect(content).toContain("Linked tasks: 20");
  });

  test("initiative mirror renders the NESTED sub-initiative -> project tree inline (INV-9 — one file, no separate sub-initiative file)", async () => {
    const parsed = JSON.parse(await readFile(ledgerPath, "utf8"));
    const detected = detectSchema(parsed);
    await generateMirrors(detected, ledgerPath);
    const content = await readFile(join(mirrorDir, "2.md"), "utf8");
    expect(content).toContain("# 2: Expansion");
    expect(content).toContain("## Sub-initiatives");
    expect(content).toContain("Sub expansion");
    expect(content).toContain("nested-project");
    expect(content).toContain("Nested project");
    expect(content).toContain("Linked backlog: 45");
    // No separate mirror file exists for the sub-initiative or its project.
    const files = await readdir(mirrorDir);
    expect(files).not.toContain("2.1.md");
    expect(files).not.toContain("nested-project.md");
  });

  test("initiative with no direct projects renders the '_none_' placeholder", async () => {
    const parsed = JSON.parse(await readFile(ledgerPath, "utf8"));
    const detected = detectSchema(parsed);
    await generateMirrors(detected, ledgerPath);
    const content = await readFile(join(mirrorDir, "2.md"), "utf8");
    expect(content).toContain("## Projects");
    // Initiative 2 has zero DIRECT projects (only a nested one) — the
    // Projects section for the top-level node itself is empty.
    const projectsSectionIdx = content.indexOf("## Projects");
    const subInitiativesSectionIdx = content.indexOf("## Sub-initiatives");
    const projectsSection = content.slice(
      projectsSectionIdx,
      subInitiativesSectionIdx,
    );
    expect(projectsSection).toContain("_none_");
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

describe("generateMirrors — Retro mode (ID-148.10, INV-9 — newly mirrored)", () => {
  beforeEach(async () => {
    ledgerPath = join(testDir, "product-retros.json");
    mirrorDir = join(testDir, "retros");
    await writeFile(ledgerPath, JSON.stringify(makeRetros(), null, 2), "utf8");
  });

  test("creates one mirror per retro record keyed by session id", async () => {
    const parsed = JSON.parse(await readFile(ledgerPath, "utf8"));
    const detected = detectSchema(parsed);
    expect(detected.kind).toBe("retro");
    await generateMirrors(detected, ledgerPath);
    const files = (await readdir(mirrorDir)).sort();
    expect(files).toEqual(["S473.md"]);
  });

  test("retro mirror contains frontmatter type 'retro' + the six category headings", async () => {
    const parsed = JSON.parse(await readFile(ledgerPath, "utf8"));
    const detected = detectSchema(parsed);
    await generateMirrors(detected, ledgerPath);
    const content = await readFile(join(mirrorDir, "S473.md"), "utf8");
    expect(content).toContain("type: retro");
    expect(content).toContain('id: "S473"');
    expect(content).toContain("## Bugs discovered");
    expect(content).toContain("Found a bug.");
    expect(content).toContain("## Failed assumptions");
    expect(content).toContain("_none_");
  });
});

// ── §3.4 idempotency + orphan deletion ────────────────────────────────────────

describe("generateRecordMirror — scoped single-record regen (Subtask 20.23)", () => {
  test("writes ONLY the named record's mirror + leaves siblings untouched", async () => {
    const ledger = makeTaskList(["20", "30"]);
    ledgerPath = join(testDir, "task-list.json");
    await writeFile(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");
    const detected = detectSchema(ledger);

    // Materialise both mirrors via a full regen first.
    await generateMirrors(detected, ledgerPath);
    mirrorDir = join(testDir, "tasks");
    const otherBefore = await readFile(join(mirrorDir, "ID-30.md"), "utf8");

    const result = await generateRecordMirror(detected, ledgerPath, "20");
    expect(result.written).toEqual(["ID-20.md"]);
    expect(result.deleted).toEqual([]);

    // The untouched sibling mirror is byte-identical to its pre-call form.
    const otherAfter = await readFile(join(mirrorDir, "ID-30.md"), "utf8");
    expect(otherAfter).toBe(otherBefore);
  });

  test("the scoped write is byte-identical to the same record's slot in a full regen", async () => {
    const ledger = makeTaskList(["20", "30"]);
    ledgerPath = join(testDir, "task-list.json");
    await writeFile(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");
    const detected = detectSchema(ledger);

    await generateRecordMirror(detected, ledgerPath, "20");
    mirrorDir = join(testDir, "tasks");
    const scoped = await readFile(join(mirrorDir, "ID-20.md"), "utf8");

    // Now full-regen and compare the same record's mirror content.
    await generateMirrors(detected, ledgerPath);
    const full = await readFile(join(mirrorDir, "ID-20.md"), "utf8");
    expect(scoped).toBe(full);
  });

  test("returns written:[] when the record id is not found (defensive)", async () => {
    const ledger = makeTaskList(["20"]);
    ledgerPath = join(testDir, "task-list.json");
    await writeFile(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");
    const detected = detectSchema(ledger);

    const result = await generateRecordMirror(detected, ledgerPath, "999");
    expect(result.written).toEqual([]);
    expect(result.deleted).toEqual([]);
  });

  test("initiatives: scoped regen by a PROJECT SLUG writes only the owning top-level initiative's mirror (INV-9)", async () => {
    const ledger = makeInitiatives();
    ledgerPath = join(testDir, "initiatives.json");
    await writeFile(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");
    const detected = detectSchema(ledger);
    await generateMirrors(detected, ledgerPath);
    mirrorDir = join(testDir, "initiatives");
    const untouchedBefore = await readFile(join(mirrorDir, "1.md"), "utf8");

    // "nested-project" lives under initiative "2"'s sub-initiative "1".
    const result = await generateRecordMirror(
      detected,
      ledgerPath,
      "nested-project",
    );
    expect(result.written).toEqual(["2.md"]);

    const untouchedAfter = await readFile(join(mirrorDir, "1.md"), "utf8");
    expect(untouchedAfter).toBe(untouchedBefore);
  });

  test("initiatives: scoped regen by an INITIATIVE PATH writes the correct top-level mirror (INV-9)", async () => {
    const ledger = makeInitiatives();
    ledgerPath = join(testDir, "initiatives.json");
    await writeFile(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");
    const detected = detectSchema(ledger);

    const result = await generateRecordMirror(detected, ledgerPath, "2.1");
    expect(result.written).toEqual(["2.md"]);
  });
});

describe("generateRecordMirrors — multi-record scoped regen (ID-158)", () => {
  test("regenerates BOTH owning top-level initiatives' mirrors when the ids span two initiatives", async () => {
    const ledger = makeInitiatives();
    ledgerPath = join(testDir, "initiatives.json");
    await writeFile(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");
    const detected = detectSchema(ledger);

    // "foundation-project" is owned by top-level initiative "1";
    // "nested-project" is owned (via sub-initiative "2.1") by initiative "2"
    // — a move batch re-parenting a linked id between them touches both.
    const result = await generateRecordMirrors(detected, ledgerPath, [
      "foundation-project",
      "nested-project",
    ]);
    expect(result.written.sort()).toEqual(["1.md", "2.md"]);

    mirrorDir = join(testDir, "initiatives");
    // Both files actually landed on disk, not just reported as written.
    await readFile(join(mirrorDir, "1.md"), "utf8");
    await readFile(join(mirrorDir, "2.md"), "utf8");
  });

  test("de-duplicates when multiple ids resolve to the SAME owning initiative", async () => {
    const ledger = makeInitiatives();
    ledgerPath = join(testDir, "initiatives.json");
    await writeFile(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");
    const detected = detectSchema(ledger);

    // "foundation-project" and bare initiative path "1" both resolve to
    // top-level initiative "1" — must write "1.md" exactly once.
    const result = await generateRecordMirrors(detected, ledgerPath, [
      "foundation-project",
      "1",
    ]);
    expect(result.written).toEqual(["1.md"]);
  });

  test("task-list mode: behaves like one generateRecordMirror call per id (no owning-record indirection)", async () => {
    const ledger = makeTaskList(["20", "30"]);
    ledgerPath = join(testDir, "task-list.json");
    await writeFile(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");
    const detected = detectSchema(ledger);

    const result = await generateRecordMirrors(detected, ledgerPath, [
      "20",
      "30",
    ]);
    expect(result.written.sort()).toEqual(["ID-20.md", "ID-30.md"]);
  });
});

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

  test("produces byte-identical output across repeated runs (Initiatives mode)", async () => {
    ledgerPath = join(testDir, "initiatives.json");
    mirrorDir = join(testDir, "initiatives");
    await writeFile(ledgerPath, JSON.stringify(makeInitiatives(), null, 2), "utf8");
    const detected = detectSchema(makeInitiatives());
    await generateMirrors(detected, ledgerPath);
    const first = await readFile(join(mirrorDir, "1.md"), "utf8");
    await generateMirrors(detected, ledgerPath);
    const second = await readFile(join(mirrorDir, "1.md"), "utf8");
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

  test("removes mirrors for top-level initiatives no longer in canonical (ID-148.10)", async () => {
    ledgerPath = join(testDir, "initiatives.json");
    mirrorDir = join(testDir, "initiatives");
    await writeFile(ledgerPath, JSON.stringify(makeInitiatives(), null, 2), "utf8");
    await generateMirrors(detectSchema(makeInitiatives()), ledgerPath);
    expect((await readdir(mirrorDir)).sort()).toEqual(["1.md", "2.md"]);

    // Drop initiative 2 from the canonical
    const trimmed = makeInitiatives();
    trimmed.initiatives = trimmed.initiatives.filter((i) => i.id !== "2");
    await writeFile(ledgerPath, JSON.stringify(trimmed, null, 2), "utf8");
    await generateMirrors(detectSchema(trimmed), ledgerPath);
    expect((await readdir(mirrorDir)).sort()).toEqual(["1.md"]);
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
