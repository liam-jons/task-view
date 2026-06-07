/**
 * Tests for mutation-options + discipline-warnings — ID-90.12 (U10).
 *
 * U10 unit layer:
 *   - `parseMutationOptions` — the per-request JSON body fields
 *     {dryRun?, force?, allowClientName?, regenMirrors?} (T-3 ratified:
 *     body fields, never headers; defaults applied per request — the
 *     server holds NO override state, PRODUCT invariants 26/33).
 *   - `disciplineWarnings` — port of KH ledger-cli.ts disciplineWarnings
 *     with the {35.30} warningScope bounding, over the U0 vendored
 *     `parseTaskListWithWarnings` (invariant 41).
 *
 * Synthetic fixtures only (AC-I) — no client-name tokens anywhere.
 */
import { describe, expect, test } from "bun:test";

import {
  parseMutationOptions,
  type MutationOptions,
} from "./mutation-options";
import {
  disciplineWarnings,
  disciplineWarningsForScopes,
  warningScopesForPatches,
} from "./discipline-warnings";
import { detectSchema, type DetectSchemaResult } from "./detect-schema";

type KnownDetected = Exclude<DetectSchemaResult, { kind: "unknown" }>;

// ── Fixtures (synthetic) ─────────────────────────────────────────────────────

const OVER_250 = "x".repeat(260);
const OVER_1500 = "z".repeat(1510);

function makeTask(
  id: string,
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    id,
    title: `Synthetic task ${id}`,
    description: "Short description.",
    status: "pending",
    priority: "should",
    dependencies: [],
    subtasks: [
      {
        id: 1,
        title: "Synthetic subtask one",
        description: "Short subtask description.",
        details: "Initial details.",
        status: "pending",
        dependencies: [],
        testStrategy: "Short strategy.",
      },
    ],
    updatedAt: "2026-06-01T00:00:00.000Z",
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

/** Two tasks — task 7 (over-budget description + over-budget subtask 7.1
 * description) and task 8 (over-budget description) — so the scope filter
 * has cross-record noise to drop. */
function makeNoisyTaskList(): KnownDetected {
  const doc = {
    document_name: "Knowledge Hub Task List",
    document_purpose: "Synthetic test ledger.",
    related_documents: [],
    tasks: [
      makeTask("7", {
        description: OVER_1500,
        subtasks: [
          {
            id: 1,
            title: "Synthetic subtask one",
            description: OVER_250,
            details: "Initial details.",
            status: "pending",
            dependencies: [],
            testStrategy: "Short strategy.",
          },
          {
            id: 2,
            title: "Synthetic subtask two",
            description: "Short.",
            details: "Initial details.",
            status: "pending",
            dependencies: [],
            testStrategy: "Short strategy.",
          },
        ],
      }),
      makeTask("8", { description: OVER_1500 }),
    ],
  };
  const detected = detectSchema(doc);
  if (detected.kind === "unknown") throw new Error("fixture failed to parse");
  return detected;
}

function makeBacklogDetected(): KnownDetected {
  const detected = detectSchema({
    document_name: "Product Backlog",
    document_purpose: "Synthetic test backlog.",
    related_documents: [],
    items: [
      {
        id: "100",
        description: "Short item description.",
        type: "feature",
        status: "ready",
        effort_estimate: null,
        priority: "medium",
        track: "infra",
        dependencies: [],
        session_refs: [],
        commit_refs: [],
        cross_doc_links: [],
        notes: null,
      },
    ],
  });
  if (detected.kind === "unknown") throw new Error("fixture failed to parse");
  return detected;
}

// ── parseMutationOptions (T-3: per-request body fields) ─────────────────────

describe("parseMutationOptions", () => {
  test("absent fields apply the per-request defaults (nothing stored server-side)", () => {
    const result = parseMutationOptions({ baseMtime: "x", patches: [] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.options).toEqual({
        dryRun: false,
        force: false,
        allowClientName: false,
        regenMirrors: true,
      } satisfies MutationOptions);
    }
  });

  test("explicit booleans are honoured, including regenMirrors: false", () => {
    const result = parseMutationOptions({
      dryRun: true,
      force: true,
      allowClientName: true,
      regenMirrors: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.options).toEqual({
        dryRun: true,
        force: true,
        allowClientName: true,
        regenMirrors: false,
      });
    }
  });

  test.each(["dryRun", "force", "allowClientName", "regenMirrors"])(
    "non-boolean %s is rejected with a detail naming the field",
    (key) => {
      const result = parseMutationOptions({ [key]: "yes" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.detail).toContain(key);
    },
  );
});

// ── disciplineWarnings ({35.30} warningScope bounding) ──────────────────────

describe("disciplineWarnings", () => {
  test("non-task-list documents short-circuit to []", () => {
    expect(disciplineWarnings(makeBacklogDetected())).toEqual([]);
    expect(
      disciplineWarnings(makeBacklogDetected(), { taskId: "100" }),
    ).toEqual([]);
  });

  test("no scope → the whole-ledger sweep (legacy fallback)", () => {
    const all = disciplineWarnings(makeNoisyTaskList());
    // task 7 description + subtask 7.1 description + task 8 description.
    expect(all).toHaveLength(3);
  });

  test("task scope keeps ONLY the named task's task-level lines", () => {
    const scoped = disciplineWarnings(makeNoisyTaskList(), { taskId: "7" });
    expect(scoped).toHaveLength(1);
    expect(scoped[0]).toContain('Task "7" description');
    // No sibling-subtask noise, no other-task noise.
    expect(scoped.some((w) => w.startsWith("Subtask "))).toBe(false);
    expect(scoped.some((w) => w.includes('"8"'))).toBe(false);
  });

  test("subtask scope keeps ONLY the named subtask's lines", () => {
    const scoped = disciplineWarnings(makeNoisyTaskList(), {
      taskId: "7",
      subId: 1,
    });
    expect(scoped).toHaveLength(1);
    expect(scoped[0]).toStartWith("Subtask 7.1 description");
  });

  test("a clean record under scope yields []", () => {
    expect(
      disciplineWarnings(makeNoisyTaskList(), { taskId: "7", subId: 2 }),
    ).toEqual([]);
  });
});

describe("disciplineWarningsForScopes", () => {
  test("unions scopes and de-duplicates messages", () => {
    const warnings = disciplineWarningsForScopes(makeNoisyTaskList(), [
      { taskId: "7" },
      { taskId: "7" }, // duplicate scope — must not duplicate the message
      { taskId: "7", subId: 1 },
    ]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('Task "7" description');
    expect(warnings[1]).toStartWith("Subtask 7.1 description");
  });

  test("empty scope list yields [] (never the whole-ledger dump)", () => {
    expect(disciplineWarningsForScopes(makeNoisyTaskList(), [])).toEqual([]);
  });
});

// ── warningScopesForPatches (scope derivation from the PATCH batch) ─────────

describe("warningScopesForPatches", () => {
  test("task-level patch derives a task scope; subtask patch derives a subtask scope", () => {
    const scopes = warningScopesForPatches([
      { fieldPath: ["tasks", "7", "status"], newValue: "in_progress" },
      { fieldPath: ["tasks", "7", "subtasks", "1", "details"], appendText: "x" },
    ]);
    expect(scopes).toEqual([
      { taskId: "7" },
      { taskId: "7", subId: "1" },
    ]);
  });

  test("duplicate scopes collapse; non-task-list paths are ignored", () => {
    const scopes = warningScopesForPatches([
      { fieldPath: ["tasks", "7", "status"], newValue: "done" },
      { fieldPath: ["tasks", "7", "priority"], newValue: "must" },
      { fieldPath: ["themes", "3", "notes"], newValue: "n" },
      { fieldPath: ["umbrellas", "u-1", "task_ids"], newValue: [] },
    ]);
    expect(scopes).toEqual([{ taskId: "7" }]);
  });
});
