/**
 * Tests for gates/gate-chain + the U2/U3 hook wiring in patch-server /
 * ledger-transaction — ID-90.7 (PRODUCT invariants 22–27).
 *
 * Three layers:
 *   1. gate-chain unit tests — the explicit ordered pre-write seam record 8
 *      (client-name guard) registers into.
 *   2. HTTP wiring — real Bun.serve servers on port 0 (same pattern as
 *      patch-server.test.ts): over-budget PATCH/POST reject `budget-exceeded`
 *      with NOTHING WRITTEN; exempt + soft-warn paths succeed; record-set
 *      deltas (none / add / remove) pass on real mutations.
 *   3. promoteTransaction wiring — promote task-leg budget (create mode +
 *      force downgrade) and per-leg record-set deltas at stage time.
 *
 * Network binds need `dangerouslyDisableSandbox: true` under the Claude
 * harness (Bun.serve binds a real socket).
 *
 * Synthetic fixtures only (AC-I) — no client-name tokens anywhere.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildPreWriteGates,
  runPreWriteGates,
  type PreWriteGate,
  type GateVerdict,
} from "./gate-chain";
import { startPatchServer, type PatchServerHandle } from "../patch-server";
import { promoteTransaction } from "../ledger-transaction";

let testDir: string;
let handle: PatchServerHandle | null;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "task-view-gate-wiring-test-"));
  handle = null;
});

afterEach(async () => {
  if (handle) {
    await handle.stop(true);
    handle = null;
  }
  await rm(testDir, { recursive: true, force: true });
});

// ── Fixtures (synthetic) ─────────────────────────────────────────────────────

const OVER_1500 = "z".repeat(1510);

function makeTask(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    title: `Synthetic task ${id}`,
    description: "Body.",
    status: "pending",
    priority: "should",
    dependencies: [],
    subtasks: [
      {
        id: 1,
        title: "Slice one",
        description: "First slice.",
        details: "Initial details.",
        status: "pending",
        dependencies: [],
        testStrategy: null,
      },
    ],
    updatedAt: "2026-06-01T12:00:00.000Z",
    effort_estimate: null,
    owner: null,
    priority_note: null,
    status_note: null,
    cross_doc_links: [],
    session_refs: [],
    commit_refs: [],
    ...overrides,
  };
}

function makeTaskListDoc(taskOverrides: Partial<Record<string, unknown>> = {}) {
  return {
    document_name: "Knowledge Hub Task List",
    document_purpose: "Synthetic test ledger.",
    related_documents: [],
    tasks: [makeTask("20", taskOverrides)],
  };
}

function makeBacklogDoc() {
  return {
    document_name: "Product Backlog",
    document_purpose: "Synthetic forward-looking items.",
    related_documents: [],
    items: [
      {
        id: "101",
        description: "A synthetic item ready to promote.",
        type: "feature",
        status: "ready",
        effort_estimate: "2-3h",
        priority: "high",
        track: "platform",
        dependencies: [],
        session_refs: [],
        commit_refs: [],
        cross_doc_links: [],
        notes: null,
      },
    ],
  };
}

function makeNewTask(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return makeTask(id, { subtasks: [], ...overrides });
}

async function startServerWith(doc: unknown): Promise<{
  url: string;
  ledgerPath: string;
  originalBytes: string;
  baseMtime: string;
}> {
  const ledgerPath = join(testDir, "task-list.json");
  const originalBytes = JSON.stringify(doc, null, 2);
  await writeFile(ledgerPath, originalBytes, "utf8");
  handle = startPatchServer({ ledgerPath, port: 0 });
  const baseMtime = (await stat(ledgerPath)).mtime.toISOString();
  return { url: handle.url, ledgerPath, originalBytes, baseMtime };
}

// ── 1. gate-chain seam ───────────────────────────────────────────────────────

function fakeGate(name: string, verdict: GateVerdict, calls: string[]): PreWriteGate {
  return {
    name,
    check: () => {
      calls.push(name);
      return verdict;
    },
  };
}

describe("runPreWriteGates — ordered chain, short-circuit, warning accumulation", () => {
  test("runs gates in order and merges warnings on success", () => {
    const calls: string[] = [];
    const verdict = runPreWriteGates(
      [
        fakeGate("alpha", { ok: true, warnings: ["w-alpha"] }, calls),
        fakeGate("beta", { ok: true, warnings: ["w-beta"] }, calls),
      ],
      { content: "{}" },
    );
    expect(calls).toEqual(["alpha", "beta"]);
    expect(verdict).toEqual({ ok: true, warnings: ["w-alpha", "w-beta"] });
  });

  test("short-circuits on the first failure, carrying prior warnings", () => {
    const calls: string[] = [];
    const verdict = runPreWriteGates(
      [
        fakeGate("alpha", { ok: true, warnings: ["w-alpha"] }, calls),
        fakeGate(
          "beta",
          { ok: false, error: "beta-error", detail: "boom", status: 500, warnings: [] },
          calls,
        ),
        fakeGate("gamma", { ok: true, warnings: ["w-gamma"] }, calls),
      ],
      { content: "{}" },
    );
    expect(calls).toEqual(["alpha", "beta"]); // gamma never runs
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.error).toBe("beta-error");
      expect(verdict.status).toBe(500);
      expect(verdict.warnings).toEqual(["w-alpha"]);
    }
  });

  test("buildPreWriteGates returns record-set + client-name-guard (record 8 registered)", () => {
    const gates = buildPreWriteGates({
      recordSet: {
        ledgerLabel: "task-list",
        beforeIds: new Set(["20"]),
        descriptor: { collection: "tasks" },
        expectedDelta: { kind: "none" },
      },
      clientName: { priorContent: "{}" },
    });
    expect(gates.map((g) => g.name)).toEqual(["record-set", "client-name-guard"]);
    // The built gate runs against the EXACT bytes handed to the chain: a
    // dropped record in the content is a record-set-violation.
    const verdict = runPreWriteGates(gates, {
      content: JSON.stringify({ tasks: [] }),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.error).toBe("record-set-violation");
      expect(verdict.detail).toContain("missing [20]");
      expect(verdict.status).toBe(500);
    }
  });
});

// ── 2. HTTP wiring — budget gate (U2) ────────────────────────────────────────

describe("PATCH wiring — budget gate", () => {
  test("over-budget patched field → 422 budget-exceeded, NOTHING written", async () => {
    const s = await startServerWith(makeTaskListDoc());
    const res = await fetch(`${s.url}/api/ledger/record/20`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseMtime: s.baseMtime,
        patches: [{ fieldPath: ["tasks", "20", "description"], newValue: OVER_1500 }],
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("budget-exceeded");
    expect(body.detail).toContain(
      "description is 1510 chars (budget 1500, over by 10) on task 20",
    );
    // Nothing written: the canonical bytes are untouched.
    expect(await readFile(s.ledgerPath, "utf8")).toBe(s.originalBytes);
  });

  test("subtask.details of any length is exempt → 200 and written (invariant 27)", async () => {
    const s = await startServerWith(makeTaskListDoc());
    const hugeDetails = "journal ".repeat(10_000);
    const res = await fetch(`${s.url}/api/ledger/record/20`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseMtime: s.baseMtime,
        patches: [
          { fieldPath: ["tasks", "20", "subtasks", "1", "details"], newValue: hugeDetails },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const written = JSON.parse(await readFile(s.ledgerPath, "utf8")) as {
      tasks: { subtasks: { details: string }[] }[];
    };
    expect(written.tasks[0].subtasks[0].details).toBe(hugeDetails);
  });

  test("untouched over-budget field soft-warns on the success envelope", async () => {
    const s = await startServerWith(makeTaskListDoc({ description: OVER_1500 }));
    const res = await fetch(`${s.url}/api/ledger/record/20`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseMtime: s.baseMtime,
        patches: [{ fieldPath: ["tasks", "20", "status"], newValue: "in_progress" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; warnings?: string[] };
    expect(body.ok).toBe(true);
    expect(body.warnings).toBeDefined();
    // ID-90.12 U10: the envelope now ALSO carries the {35.30}-scoped
    // discipline line for the same over-budget field (KH commitMutation
    // order — discipline first), so assert presence rather than position.
    expect(
      body.warnings!.some((w) =>
        w.startsWith("budget (untouched): description is 1510 chars"),
      ),
    ).toBe(true);
    expect(
      body.warnings!.some((w) => w.startsWith('Task "20" description is')),
    ).toBe(true);
    // The status flip itself landed.
    const written = JSON.parse(await readFile(s.ledgerPath, "utf8")) as {
      tasks: { status: string }[];
    };
    expect(written.tasks[0].status).toBe("in_progress");
  });
});

describe("POST wiring — budget gate (create mode) + record-set add delta", () => {
  test("over-budget create → 422 budget-exceeded, NOTHING written", async () => {
    const s = await startServerWith(makeTaskListDoc());
    const res = await fetch(`${s.url}/api/ledger/record`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseMtime: s.baseMtime,
        record: makeNewTask("21", { description: OVER_1500 }),
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("budget-exceeded");
    expect(body.detail).toContain("on task 21");
    expect(await readFile(s.ledgerPath, "utf8")).toBe(s.originalBytes);
  });

  test("valid create → 201; record-set add delta passes on the spliced bytes", async () => {
    const s = await startServerWith(makeTaskListDoc());
    const res = await fetch(`${s.url}/api/ledger/record`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseMtime: s.baseMtime, record: makeNewTask("21") }),
    });
    expect(res.status).toBe(201);
    const written = JSON.parse(await readFile(s.ledgerPath, "utf8")) as {
      tasks: { id: string }[];
    };
    expect(written.tasks.map((t) => t.id)).toEqual(["20", "21"]);
  });
});

describe("DELETE wiring — record-set remove delta", () => {
  test("valid delete → 200; record-set remove delta passes on the re-emitted bytes", async () => {
    const doc = makeTaskListDoc();
    doc.tasks.push(makeTask("30", { subtasks: [] }));
    const s = await startServerWith(doc);
    const res = await fetch(`${s.url}/api/ledger/record/30`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseMtime: s.baseMtime }),
    });
    expect(res.status).toBe(200);
    const written = JSON.parse(await readFile(s.ledgerPath, "utf8")) as {
      tasks: { id: string }[];
    };
    expect(written.tasks.map((t) => t.id)).toEqual(["20"]);
  });
});

// ── 3. promoteTransaction wiring (per-leg, at stage time) ────────────────────

async function setupPromote(): Promise<{
  taskListPath: string;
  backlogPath: string;
  taskListBytes: string;
  backlogBytes: string;
  taskListMtime: string;
  backlogMtime: string;
}> {
  const taskListPath = join(testDir, "task-list.json");
  const backlogPath = join(testDir, "product-backlog.json");
  const taskListBytes = JSON.stringify(makeTaskListDoc(), null, 2);
  const backlogBytes = JSON.stringify(makeBacklogDoc(), null, 2);
  await writeFile(taskListPath, taskListBytes, "utf8");
  await writeFile(backlogPath, backlogBytes, "utf8");
  return {
    taskListPath,
    backlogPath,
    taskListBytes,
    backlogBytes,
    taskListMtime: (await stat(taskListPath)).mtime.toISOString(),
    backlogMtime: (await stat(backlogPath)).mtime.toISOString(),
  };
}

describe("promoteTransaction wiring — budget (task leg, create mode) + record-set per leg", () => {
  test("over-budget promoted task → budget-exceeded 422, BOTH files untouched", async () => {
    const s = await setupPromote();
    const result = await promoteTransaction({
      taskListPath: s.taskListPath,
      backlogPath: s.backlogPath,
      taskListBaseMtime: s.taskListMtime,
      backlogBaseMtime: s.backlogMtime,
      sourceBacklogId: "101",
      taskRecord: makeNewTask("42", { description: OVER_1500 }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("budget-exceeded");
      expect(result.status).toBe(422);
      expect(result.detail).toContain("on task 42");
    }
    expect(await readFile(s.taskListPath, "utf8")).toBe(s.taskListBytes);
    expect(await readFile(s.backlogPath, "utf8")).toBe(s.backlogBytes);
  });

  test("force downgrades the promote budget rejection to a (forced) warning and commits", async () => {
    const s = await setupPromote();
    const result = await promoteTransaction({
      taskListPath: s.taskListPath,
      backlogPath: s.backlogPath,
      taskListBaseMtime: s.taskListMtime,
      backlogBaseMtime: s.backlogMtime,
      sourceBacklogId: "101",
      taskRecord: makeNewTask("42", { description: OVER_1500 }),
      force: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toStartWith("(forced) budget-exceeded:");
    }
    const taskList = JSON.parse(await readFile(s.taskListPath, "utf8")) as {
      tasks: { id: string }[];
    };
    expect(taskList.tasks.map((t) => t.id)).toEqual(["20", "42"]);
    const backlog = JSON.parse(await readFile(s.backlogPath, "utf8")) as {
      items: { id: string }[];
    };
    expect(backlog.items).toEqual([]);
  });

  test("valid promote passes both per-leg record-set gates: task-list +1, backlog −1", async () => {
    const s = await setupPromote();
    const result = await promoteTransaction({
      taskListPath: s.taskListPath,
      backlogPath: s.backlogPath,
      taskListBaseMtime: s.taskListMtime,
      backlogBaseMtime: s.backlogMtime,
      sourceBacklogId: "101",
      taskRecord: makeNewTask("42"),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings).toEqual([]);
    const taskList = JSON.parse(await readFile(s.taskListPath, "utf8")) as {
      tasks: { id: string }[];
    };
    expect(taskList.tasks.map((t) => t.id)).toEqual(["20", "42"]);
    const backlog = JSON.parse(await readFile(s.backlogPath, "utf8")) as {
      items: { id: string }[];
    };
    expect(backlog.items).toEqual([]);
  });
});

// ── 5. HTTP wiring — client-name guard (U4, invariants 28 + 31–32 + 35) ──────
//
// Synthetic denylist only (AC-I) — "Zorblian Widgets Ltd" is invented.

describe("PATCH wiring — client-name guard", () => {
  const SYNTH_DENYLIST = JSON.stringify({
    tokens: [
      { value: "Zorblian Widgets Ltd", case_insensitive: true, class: "client" },
    ],
  });
  let savedDenylist: string | undefined;

  beforeEach(() => {
    savedDenylist = process.env.KH_CLIENT_NAME_DENYLIST;
    process.env.KH_CLIENT_NAME_DENYLIST = SYNTH_DENYLIST;
  });

  afterEach(() => {
    if (savedDenylist === undefined) delete process.env.KH_CLIENT_NAME_DENYLIST;
    else process.env.KH_CLIENT_NAME_DENYLIST = savedDenylist;
  });

  test("net-new token in the patched bytes → 422 client-name-guard, REDACTED body, NOTHING written", async () => {
    const s = await startServerWith(makeTaskListDoc());
    const res = await fetch(`${s.url}/api/ledger/record/20`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseMtime: s.baseMtime,
        patches: [
          {
            fieldPath: ["tasks", "20", "description"],
            newValue: "met Zorblian Widgets Ltd on Tuesday",
          },
        ],
      }),
    });
    expect(res.status).toBe(422);
    const text = await res.text();
    const body = JSON.parse(text) as { error: string; detail: string };
    expect(body.error).toBe("client-name-guard");
    expect(body.detail).toContain("+1");
    // Invariant 32: the response body never echoes the matched token.
    expect(text.toLowerCase()).not.toContain("zorblian");
    // Nothing written.
    expect(await readFile(s.ledgerPath, "utf8")).toBe(s.originalBytes);
  });

  test("sanitising edit (count decreases) passes and writes (invariant 31)", async () => {
    const s = await startServerWith(
      makeTaskListDoc({ description: "legacy note about Zorblian Widgets Ltd" }),
    );
    const res = await fetch(`${s.url}/api/ledger/record/20`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseMtime: s.baseMtime,
        patches: [
          { fieldPath: ["tasks", "20", "description"], newValue: "de-identified note" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const written = JSON.parse(await readFile(s.ledgerPath, "utf8")) as {
      tasks: { description: string }[];
    };
    expect(written.tasks[0].description).toBe("de-identified note");
  });

  test("set-but-invalid (comma-shaped) denylist → 500 client-name-guard-config, NOTHING written (invariant 35)", async () => {
    process.env.KH_CLIENT_NAME_DENYLIST = "ZorbCo,QuuxCo";
    const s = await startServerWith(makeTaskListDoc());
    const res = await fetch(`${s.url}/api/ledger/record/20`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseMtime: s.baseMtime,
        patches: [
          { fieldPath: ["tasks", "20", "status"], newValue: "in_progress" },
        ],
      }),
    });
    expect(res.status).toBe(500);
    const text = await res.text();
    const body = JSON.parse(text) as { error: string };
    expect(body.error).toBe("client-name-guard-config");
    // The raw misconfigured value is never echoed.
    expect(text).not.toContain("ZorbCo");
    expect(await readFile(s.ledgerPath, "utf8")).toBe(s.originalBytes);
  });
});
