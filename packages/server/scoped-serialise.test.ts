/**
 * scoped-serialise.test.ts — byte-level tests for the conforming serialisation
 * port (ID-90 U1; PRODUCT invariants 18-20, 52).
 *
 * Proves the scoped-write primitive on synthetic fixtures (committed, CI-safe)
 * and — when `KH_LEDGER_DIR` is set — on copies of the live KH ledgers:
 *   - a no-op `JSON.parse -> escapeSerialise` round-trip is byte-identical
 *     (invariant 20 / OQ-LS-2 conformance),
 *   - a single-field mutation touches ONLY the mutated record's line(s)
 *     (invariant 19 — the whole-file re-emit class is structurally impossible),
 *   - all non-ASCII is emitted as \uXXXX escapes with on-disk key order and a
 *     trailing newline (invariant 18),
 *   - the umbrellas walk (['umbrellas', id, field]) yields the same
 *     minimal-diff discipline (invariant 52).
 *
 * The live-ledger suite reads from `KH_LEDGER_DIR` (an operator-local path to
 * the KH `docs/reference/` directory) and is skipped when unset — the KH
 * ledgers are NOT committed into this repo. The fuller upstream port of the
 * KH suite lands at U11.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  escapeNonAscii,
  escapeSerialise,
  scopedSerialise,
  scopedSpliceSerialise,
} from "./scoped-serialise";
import { detectSchema } from "./detect-schema";

// Built from an ASCII-only string source (never a regex literal containing
// high characters) to avoid heredoc/editor mangling of the high range — the
// same discipline the escaper itself uses. Matches any raw non-ASCII code unit.
const RAW_NON_ASCII = new RegExp("[\\u0080-\\uffff]");

// Non-ASCII glyphs assembled from escape sequences so this source file stays
// pure ASCII.
const EM_DASH = "—";
const SECTION = "§";
const ARROW = "→";

// ── escapeNonAscii ────────────────────────────────────────────────────────────

describe("escapeNonAscii", () => {
  test("escapes em-dash, section sign, and arrow to their \\uXXXX forms", () => {
    expect(escapeNonAscii(`a ${EM_DASH} b`)).toBe("a \\u2014 b");
    expect(escapeNonAscii(`${SECTION}3.4`)).toBe("\\u00a73.4");
    expect(escapeNonAscii(`A ${ARROW} B`)).toBe("A \\u2192 B");
  });

  test("leaves pure ASCII untouched", () => {
    const ascii = 'plain ASCII: {"k": "v"}\n';
    expect(escapeNonAscii(ascii)).toBe(ascii);
  });

  test("escapes astral characters per UTF-16 code unit (surrogate pair)", () => {
    // U+1F600 grinning face = surrogate pair D83D DE00
    expect(escapeNonAscii("\u{1F600}")).toBe("\\ud83d\\ude00");
  });
});

// ── escapeSerialise (invariant 18) ────────────────────────────────────────────

describe("escapeSerialise — conforming whole-file emit", () => {
  test("emits exactly one trailing newline", () => {
    const out = escapeSerialise({ a: 1 });
    expect(out.endsWith("}\n")).toBe(true);
    expect(out.endsWith("}\n\n")).toBe(false);
  });

  test("emits zero raw non-ASCII bytes for a doc containing an em-dash", () => {
    const out = escapeSerialise({
      note: `a ${EM_DASH} b, ${SECTION}3, A ${ARROW} B`,
    });
    expect(RAW_NON_ASCII.test(out)).toBe(false);
    expect(out).toContain("\\u2014");
  });

  test("no-op parse -> escapeSerialise round-trip is byte-identical", () => {
    const text = escapeSerialise(taskListFixtureDoc());
    expect(escapeSerialise(JSON.parse(text))).toBe(text);
  });
});

// ── Synthetic fixtures (committed — synthetic data only, AC-I) ────────────────

/** A two-Task task-list fixture; both Tasks carry em-dashes in their details. */
function taskListFixtureDoc() {
  return {
    document_name: "Knowledge Hub Task List",
    document_purpose: `Two-Task fixture ${EM_DASH} scoped-serialise byte-stability.`,
    related_documents: [],
    tasks: [
      {
        id: "900",
        title: `First task ${EM_DASH} alpha`,
        description: `Compact what+why ${EM_DASH} first.`,
        status: "pending",
        priority: "should",
        dependencies: [],
        subtasks: [
          {
            id: 1,
            title: `Sub one ${EM_DASH} uno`,
            description: `Subtask summary ${EM_DASH} one.`,
            details: `Details with an em-dash ${EM_DASH} and a section ${SECTION}1.`,
            status: "pending",
            dependencies: [],
            testStrategy: `verify ${EM_DASH} n/a`,
          },
        ],
        updatedAt: "2026-05-26T00:00:00.000Z",
        effort_estimate: null,
        owner: null,
        priority_note: null,
        status_note: null,
        cross_doc_links: [],
        session_refs: [],
        commit_refs: [],
      },
      {
        id: "901",
        title: `Second task ${EM_DASH} beta`,
        description: `Compact what+why ${EM_DASH} second.`,
        status: "pending",
        priority: "should",
        dependencies: [],
        subtasks: [
          {
            id: 1,
            title: `Sub ${EM_DASH} solo`,
            description: `Untouched subtask ${EM_DASH} two.`,
            details: `Untouched details ${EM_DASH} arrow ${ARROW} here.`,
            status: "pending",
            dependencies: [],
            testStrategy: `verify ${EM_DASH} n/a`,
          },
        ],
        updatedAt: "2026-05-26T00:00:00.000Z",
        effort_estimate: null,
        owner: null,
        priority_note: null,
        status_note: null,
        cross_doc_links: [],
        session_refs: [],
        commit_refs: [],
      },
    ],
  };
}

function taskListFixtureText(): string {
  // The on-disk convention: escaped non-ASCII + trailing newline.
  return escapeSerialise(taskListFixtureDoc());
}

/** A minimal roadmap fixture (vendored RoadmapSchema shape). */
function roadmapFixtureDoc() {
  return {
    document_name: "Knowledge Hub Roadmap",
    document_purpose: `Roadmap fixture ${EM_DASH} byte-stability.`,
    date: "2026-06-07",
    status: "Active",
    forward_looking_only: true,
    related_documents: [],
    last_updated: "fixture",
    themes: [
      {
        id: "10",
        title: `Theme ten ${EM_DASH} alpha`,
        description: `Theme 10 description ${SECTION}1.`,
        time_horizon: "now",
        status: "in_progress",
        linked_tasks: [],
        linked_backlog: [],
        session_refs: [],
        commit_refs: [],
        cross_doc_links: [],
        notes: null,
      },
      {
        id: "11",
        title: `Theme eleven ${EM_DASH} beta`,
        description: `Theme 11 description ${ARROW} forward.`,
        time_horizon: "next",
        status: "pending",
        linked_tasks: [],
        linked_backlog: [],
        session_refs: [],
        commit_refs: [],
        cross_doc_links: [],
        notes: null,
      },
    ],
  };
}

/** A minimal backlog fixture (vendored BacklogSchema shape). */
function backlogFixtureDoc() {
  return {
    document_name: "Product Backlog",
    document_purpose: `Backlog fixture ${EM_DASH} byte-stability.`,
    related_documents: [],
    items: [
      {
        id: "101",
        description: `First item ${EM_DASH} CSV export.`,
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
      {
        id: "102",
        description: `Second item ${EM_DASH} flaky e2e ${ARROW} investigate.`,
        type: "bug",
        status: "needs_research",
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
  };
}

/** A two-umbrella fixture (vendored UmbrellasSchema shape — invariant 52). */
function umbrellasFixtureDoc() {
  return {
    document_name: "umbrellas",
    document_purpose: `Umbrellas fixture ${EM_DASH} scoped membership edits.`,
    last_updated: "kh-main-S1 fixture seed",
    related_documents: [],
    umbrellas: [
      {
        id: "alpha-initiative",
        title: `Alpha initiative ${EM_DASH} first`,
        substrate_doc: "docs/specs/alpha/PRODUCT.md",
        task_ids: ["900"],
        status: "in_progress",
        phase: "Phase 1",
      },
      {
        id: "beta-initiative",
        title: `Beta initiative ${EM_DASH} second ${ARROW} later`,
        substrate_doc: "docs/specs/beta/PRODUCT.md",
        task_ids: ["901"],
        status: "proposed",
        phase: "Phase 2",
      },
    ],
  };
}

function changedLineIndices(original: string, next: string): number[] {
  const origLines = original.split("\n");
  const newLines = next.split("\n");
  expect(newLines.length).toBe(origLines.length);
  return origLines
    .map((line, i) => (line === newLines[i] ? null : i))
    .filter((i): i is number => i !== null);
}

// ── scopedSerialise — minimal scoped diff (invariants 18 + 19) ────────────────

describe("scopedSerialise — multi-record byte-stability", () => {
  test("flip-task: the ONLY changed line is the mutated record status line", () => {
    const original = taskListFixtureText();
    const r = scopedSerialise(original, {
      fieldPath: ["tasks", "900", "status"],
      newValue: "in_progress",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const changed = changedLineIndices(original, r.text);
    expect(changed).toHaveLength(1);
    const origLines = original.split("\n");
    const newLines = r.text.split("\n");
    expect(origLines[changed[0]]).toContain('"status": "pending"');
    expect(newLines[changed[0]]).toContain('"status": "in_progress"');
  });

  test("flip-subtask: untouched Task 901 record stays byte-identical", () => {
    const original = taskListFixtureText();
    const r = scopedSerialise(original, {
      fieldPath: ["tasks", "900", "subtasks", "1", "status"],
      newValue: "done",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Task 901's full block (from its id line to EOF) must appear verbatim.
    const block901Start = original.indexOf('"id": "901"');
    const block901 = original.slice(block901Start);
    expect(r.text).toContain(block901);

    // And exactly one line changed overall.
    expect(changedLineIndices(original, r.text)).toHaveLength(1);
  });

  test("introduces NO raw non-ASCII anywhere; untouched escapes survive", () => {
    const original = taskListFixtureText();
    const r = scopedSerialise(original, {
      fieldPath: ["tasks", "900", "status"],
      newValue: "in_progress",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(RAW_NON_ASCII.test(r.text)).toBe(false);
    // Untouched records keep their \uXXXX escapes.
    expect(r.text).toContain("\\u2014"); // em-dash
    expect(r.text).toContain("\\u2192"); // arrow (Task 901 details)
    expect(r.text).toContain("\\u00a7"); // section sign (Task 900 subtask details)
  });

  test("roadmap theme field edit changes exactly one line", () => {
    const original = escapeSerialise(roadmapFixtureDoc());
    const r = scopedSerialise(original, {
      fieldPath: ["themes", "11", "status"],
      newValue: "in_progress",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("roadmap");
    expect(changedLineIndices(original, r.text)).toHaveLength(1);
  });

  test("backlog item field edit changes exactly one line", () => {
    const original = escapeSerialise(backlogFixtureDoc());
    const r = scopedSerialise(original, {
      fieldPath: ["items", "102", "status"],
      newValue: "ready",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("backlog");
    expect(changedLineIndices(original, r.text)).toHaveLength(1);
  });
});

// ── scopedSerialise — umbrellas walk (invariant 52) ───────────────────────────

describe("scopedSerialise — umbrellas walk (['umbrellas', id, field])", () => {
  test("status flip on one umbrella changes exactly one line", () => {
    const original = escapeSerialise(umbrellasFixtureDoc());
    const r = scopedSerialise(original, {
      fieldPath: ["umbrellas", "beta-initiative", "status"],
      newValue: "in_progress",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("umbrellas");
    expect(changedLineIndices(original, r.text)).toHaveLength(1);
    // The sibling umbrella stays byte-identical.
    const alphaStart = original.indexOf('"id": "alpha-initiative"');
    const alphaEnd = original.indexOf('"id": "beta-initiative"');
    expect(r.text).toContain(original.slice(alphaStart, alphaEnd));
  });

  test("task_ids membership edit preserves escapes + trailing newline", () => {
    const original = escapeSerialise(umbrellasFixtureDoc());
    const r = scopedSerialise(original, {
      fieldPath: ["umbrellas", "alpha-initiative", "task_ids"],
      newValue: ["900", "901"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(RAW_NON_ASCII.test(r.text)).toBe(false);
    expect(r.text.endsWith("}\n")).toBe(true);
    expect(r.text).toContain("\\u2014");
    const parsed = JSON.parse(r.text) as {
      umbrellas: { id: string; task_ids: string[] }[];
    };
    expect(parsed.umbrellas[0].task_ids).toEqual(["900", "901"]);
  });

  test("schema-violating umbrella status fails WITHOUT emitting text", () => {
    const original = escapeSerialise(umbrellasFixtureDoc());
    const r = scopedSerialise(original, {
      fieldPath: ["umbrellas", "alpha-initiative", "status"],
      newValue: "not-a-real-status",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("schema-error");
  });

  test("walk-error for a non-existent umbrella id", () => {
    const original = escapeSerialise(umbrellasFixtureDoc());
    const r = scopedSerialise(original, {
      fieldPath: ["umbrellas", "does-not-exist", "status"],
      newValue: "done",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("walk-error");
  });
});

// ── scopedSerialise — validation + failure kinds ──────────────────────────────

describe("scopedSerialise — validation + re-parse", () => {
  test("result re-parses via detectSchema (task-list)", () => {
    const original = taskListFixtureText();
    const r = scopedSerialise(original, {
      fieldPath: ["tasks", "900", "status"],
      newValue: "in_progress",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const detected = detectSchema(JSON.parse(r.text));
    expect(detected.kind).toBe("task-list");
  });

  test("rejects a schema-invalid status WITHOUT emitting text", () => {
    const original = taskListFixtureText();
    const r = scopedSerialise(original, {
      fieldPath: ["tasks", "900", "status"],
      newValue: "not-a-real-status",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("schema-error");
  });

  test("walk-error for a non-existent task id", () => {
    const original = taskListFixtureText();
    const r = scopedSerialise(original, {
      fieldPath: ["tasks", "does-not-exist", "status"],
      newValue: "done",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("walk-error");
  });

  test("unknown-document for an unrecognised ledger", () => {
    const r = scopedSerialise(
      JSON.stringify({ document_name: "Not A Ledger", tasks: [] }),
      { fieldPath: ["tasks", "1", "status"], newValue: "done" },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("unknown-document");
  });
});

// ── scopedSpliceSerialise — record insert/remove ──────────────────────────────

/** A schema-valid Task body not present in the fixture. */
function newTaskRecord(id: string) {
  return {
    id,
    title: `Splice probe Task ${id} ${EM_DASH} U1`,
    description: `Synthetic Task ${EM_DASH} byte-stability probe, ${SECTION}U1.`,
    status: "pending",
    priority: "should",
    dependencies: [],
    subtasks: [],
    updatedAt: "2026-06-07T00:00:00.000Z",
    effort_estimate: null,
    owner: null,
    priority_note: null,
    status_note: null,
    cross_doc_links: [],
    session_refs: [],
    commit_refs: [],
  };
}

/** A schema-valid Subtask body (numeric id) with an arrow glyph in details. */
function newSubtaskRecord(id: number) {
  return {
    id,
    title: `Splice probe subtask ${id} ${EM_DASH} uno`,
    description: `Synthetic subtask ${EM_DASH} byte-stability probe.`,
    details: `Details with an arrow ${ARROW} and a section ${SECTION}U1.`,
    status: "pending",
    dependencies: [],
    testStrategy: `verify ${EM_DASH} n/a`,
  };
}

describe("scopedSpliceSerialise — insert/remove byte stability", () => {
  test("task insert -> remove round-trip reproduces the original byte-for-byte", () => {
    const original = taskListFixtureText();
    const probeId = "999000";

    const inserted = scopedSpliceSerialise(original, {
      kind: "insert",
      collection: "tasks",
      record: newTaskRecord(probeId),
    });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;

    const removed = scopedSpliceSerialise(inserted.text, {
      kind: "remove",
      collection: "tasks",
      recordId: probeId,
    });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.text).toBe(original);
  });

  test("insert touches ONLY the new record lines + one comma on the prior last record", () => {
    const original = taskListFixtureText();
    const probeId = "999001";
    const r = scopedSpliceSerialise(original, {
      kind: "insert",
      collection: "tasks",
      record: newTaskRecord(probeId),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const origLines = original.split("\n");
    const newLines = r.text.split("\n");
    const recordLineCount =
      escapeSerialise(newTaskRecord(probeId)).split("\n").length - 1; // drop trailing-newline empty
    expect(newLines.length).toBe(origLines.length + recordLineCount);

    // Walk both line arrays; every original line must reappear verbatim in the
    // output EXCEPT exactly one (the prior last Task's `}` which gains a `,`).
    let perturbed = 0;
    let oi = 0;
    for (let ni = 0; ni < newLines.length && oi < origLines.length; ni++) {
      if (newLines[ni] === origLines[oi]) {
        oi++;
      } else if (newLines[ni] === origLines[oi] + ",") {
        perturbed++;
        oi++;
      }
      // else: an inserted (new-record) line — do not advance oi.
    }
    expect(oi).toBe(origLines.length);
    expect(perturbed).toBe(1);
    expect(r.text).toContain(`"id": "${probeId}"`);
    expect(RAW_NON_ASCII.test(r.text)).toBe(false);
  });

  test("subtask insert -> remove round-trip is byte-identical", () => {
    const original = taskListFixtureText();
    const inserted = scopedSpliceSerialise(original, {
      kind: "insert",
      collection: "subtasks",
      taskId: "900",
      record: newSubtaskRecord(2),
    });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    expect(inserted.text).toContain('"id": 2');

    const removed = scopedSpliceSerialise(inserted.text, {
      kind: "remove",
      collection: "subtasks",
      taskId: "900",
      recordId: 2,
    });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.text).toBe(original);
  });

  test("roadmap themes insert -> remove round-trips byte-identically", () => {
    const original = escapeSerialise(roadmapFixtureDoc());
    const doc = roadmapFixtureDoc();
    const record = { ...doc.themes[0], id: "999900" };

    const inserted = scopedSpliceSerialise(original, {
      kind: "insert",
      collection: "themes",
      record,
    });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    expect(inserted.kind).toBe("roadmap");

    const removed = scopedSpliceSerialise(inserted.text, {
      kind: "remove",
      collection: "themes",
      recordId: "999900",
    });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.text).toBe(original);
  });

  test("backlog items insert -> remove round-trips byte-identically", () => {
    const original = escapeSerialise(backlogFixtureDoc());
    const doc = backlogFixtureDoc();
    const record = { ...doc.items[0], id: "999901" };

    const inserted = scopedSpliceSerialise(original, {
      kind: "insert",
      collection: "items",
      record,
    });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    expect(inserted.kind).toBe("backlog");

    const removed = scopedSpliceSerialise(inserted.text, {
      kind: "remove",
      collection: "items",
      recordId: "999901",
    });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.text).toBe(original);
  });

  test("a schema-violating insert returns ok:false kind:schema-error and emits NO text", () => {
    const original = taskListFixtureText();
    const r = scopedSpliceSerialise(original, {
      kind: "insert",
      collection: "tasks",
      record: { id: "999002", title: "incomplete" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("schema-error");
    expect((r as { text?: string }).text).toBeUndefined();
  });

  test("walk-error when the addressed taskId is not found for a subtask splice", () => {
    const original = taskListFixtureText();
    const r = scopedSpliceSerialise(original, {
      kind: "insert",
      collection: "subtasks",
      taskId: "does-not-exist",
      record: newSubtaskRecord(1),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("walk-error");
  });

  test("a no-op remove (id absent) re-validates and round-trips byte-identically", () => {
    const original = taskListFixtureText();
    const r = scopedSpliceSerialise(original, {
      kind: "remove",
      collection: "tasks",
      recordId: "no-such-task-id",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe(original);
  });
});

// ── Live KH ledgers — env-keyed, never committed (data-exposure rule) ─────────
//
// Set KH_LEDGER_DIR to the KH docs/reference directory to run these against
// copies of the live ledgers. CI does not set the knob, so the suite skips —
// the synthetic fixtures above provide the committed coverage.

const KH_LEDGER_DIR = process.env.KH_LEDGER_DIR ?? "";

// The three core ledgers were normalised by KH's OQ-LS-2 pass (S270) — the
// no-op round-trip MUST be byte-identical (invariant 20).
const normalisedLedgers = [
  "task-list.json",
  "product-backlog.json",
  "product-roadmap.json",
];

// Not yet byte-conforming on disk (verified 07/06/2026 — raw em-dashes):
//   - umbrellas.json is normalised by the K6 commit (PRODUCT inv 51), which
//     lands KH-side in Phase 1 — until then only a content-neutral round-trip
//     can hold. The byte-level inv 52 property is proven on the synthetic
//     umbrellas fixture above.
//   - product-retros.json is outside the substrate document set (TECH: three
//     ledgers + umbrellas.json) — included here as a content-neutral check
//     only.
const unnormalisedLedgers = ["product-retros.json", "umbrellas.json"];

describe("live KH ledgers (KH_LEDGER_DIR) — no-op round-trip (invariant 20)", () => {
  for (const name of normalisedLedgers) {
    test.skipIf(!KH_LEDGER_DIR)(
      `escapeSerialise(JSON.parse(text)) round-trips ${name} byte-identically`,
      () => {
        const path = join(KH_LEDGER_DIR, name);
        const original = readFileSync(path, "utf8");
        expect(escapeSerialise(JSON.parse(original))).toBe(original);
      },
    );
  }

  for (const name of unnormalisedLedgers) {
    test.skipIf(!KH_LEDGER_DIR)(
      `escapeSerialise round-trips ${name} content-neutrally (pre-K6 normalisation)`,
      () => {
        const path = join(KH_LEDGER_DIR, name);
        if (!existsSync(path)) return; // absent ledger — nothing to prove
        const original = readFileSync(path, "utf8");
        const emitted = escapeSerialise(JSON.parse(original));
        // Conforming output: no raw non-ASCII, single trailing newline.
        expect(RAW_NON_ASCII.test(emitted)).toBe(false);
        expect(emitted.endsWith("}\n")).toBe(true);
        // Content-neutral: parsed documents are deep-equal.
        expect(JSON.parse(emitted)).toEqual(JSON.parse(original));
      },
    );
  }

  test.skipIf(!KH_LEDGER_DIR)(
    "flipping one real Task status touches exactly one line of the live task-list",
    () => {
      const original = readFileSync(join(KH_LEDGER_DIR, "task-list.json"), "utf8");
      const doc = JSON.parse(original) as {
        tasks: { id: string; status: string }[];
      };
      const target = doc.tasks[0];
      const newStatus = target.status === "done" ? "pending" : "done";
      const r = scopedSerialise(original, {
        fieldPath: ["tasks", target.id, "status"],
        newValue: newStatus,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(changedLineIndices(original, r.text)).toHaveLength(1);
    },
  );

  test.skipIf(!KH_LEDGER_DIR)(
    "live task-list insert -> remove splice round-trip is byte-identical",
    () => {
      const original = readFileSync(join(KH_LEDGER_DIR, "task-list.json"), "utf8");
      const probeId = "999000";
      const inserted = scopedSpliceSerialise(original, {
        kind: "insert",
        collection: "tasks",
        record: newTaskRecord(probeId),
      });
      expect(inserted.ok).toBe(true);
      if (!inserted.ok) return;
      const removed = scopedSpliceSerialise(inserted.text, {
        kind: "remove",
        collection: "tasks",
        recordId: probeId,
      });
      expect(removed.ok).toBe(true);
      if (!removed.ok) return;
      expect(removed.text).toBe(original);
    },
  );

  test.skipIf(!KH_LEDGER_DIR)(
    "live umbrellas.json scoped status flip emits conforming bytes (invariant 52)",
    () => {
      // Pre-K6 the live file is not byte-conforming (PRODUCT inv 51 — the
      // normalisation commit lands KH-side in Phase 1), so the exact-one-line
      // property cannot hold against today's on-disk bytes; it is proven on
      // the synthetic umbrellas fixture above. Here we prove the walk accepts
      // the LIVE document and emits conforming output.
      const path = join(KH_LEDGER_DIR, "umbrellas.json");
      if (!existsSync(path)) return;
      const original = readFileSync(path, "utf8");
      const doc = JSON.parse(original) as {
        umbrellas: { id: string; status: string }[];
      };
      const target = doc.umbrellas[0];
      const newStatus = target.status === "done" ? "in_progress" : "done";
      const r = scopedSerialise(original, {
        fieldPath: ["umbrellas", target.id, "status"],
        newValue: newStatus,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.kind).toBe("umbrellas");
      expect(RAW_NON_ASCII.test(r.text)).toBe(false);
      expect(r.text.endsWith("}\n")).toBe(true);
      const mutated = JSON.parse(r.text) as {
        umbrellas: { id: string; status: string }[];
      };
      expect(mutated.umbrellas[0].status).toBe(newStatus);
    },
  );
});

// ── ID-90 U6: appendText op at apply time (PRODUCT invariant 39) ──────────────

describe("scopedSerialise — appendText op (ID-90 U6, invariant 39)", () => {
  const JOURNAL_BLOCK =
    "\n\n<info added on 2026-06-07T00:00:00.000Z>\nShipped " +
    EM_DASH +
    " slice.\n</info added on 2026-06-07T00:00:00.000Z>";

  test("append-journal: prior details bytes are preserved VERBATIM with the block appended", () => {
    const original = taskListFixtureText();
    const r = scopedSerialise(original, {
      fieldPath: ["tasks", "900", "subtasks", "1", "details"],
      appendText: JOURNAL_BLOCK,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // The on-disk JSON encoding of the PRIOR details value — escaped em-dash
    // + section sign — must survive byte-for-byte as a PREFIX of the new
    // details value (no re-escape, no normalisation; invariant 39).
    const priorDetailsEncoded =
      '"details": "Details with an em-dash \\u2014 and a section \\u00a71.';
    expect(original).toContain(priorDetailsEncoded + '"');
    expect(r.text).toContain(priorDetailsEncoded + "\\n\\n<info added on ");

    // Exactly one line changed (the details line); JSON-encoding keeps the
    // multi-line block on the single details line via \n escapes.
    const changed = changedLineIndices(original, r.text);
    expect(changed).toHaveLength(1);
    const newLine = r.text.split("\n")[changed[0]];
    expect(newLine).toContain("\\u2014 slice.");
    expect(newLine).toContain("</info added on 2026-06-07T00:00:00.000Z>");

    // Untouched Task 901 block stays byte-identical.
    const block901 = original.slice(original.indexOf('"id": "901"'));
    expect(r.text).toContain(block901);
    // No raw non-ASCII anywhere (the appended em-dash got escaped).
    expect(RAW_NON_ASCII.test(r.text)).toBe(false);
  });

  test("the appended result equals prior + appendText exactly (parsed value)", () => {
    const original = taskListFixtureText();
    const priorValue = (taskListFixtureDoc().tasks[0].subtasks[0] as { details: string }).details;
    const r = scopedSerialise(original, {
      fieldPath: ["tasks", "900", "subtasks", "1", "details"],
      appendText: JOURNAL_BLOCK,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = JSON.parse(r.text) as {
      tasks: { subtasks: { details: string }[] }[];
    };
    expect(parsed.tasks[0].subtasks[0].details).toBe(priorValue + JOURNAL_BLOCK);
  });

  test("appendText onto a null leaf (backlog notes) becomes the appended text", () => {
    const original = escapeSerialise(backlogFixtureDoc());
    const r = scopedSerialise(original, {
      fieldPath: ["items", "101", "notes"],
      appendText: "First note.",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = JSON.parse(r.text) as { items: { notes: string }[] }[] & {
      items: { notes: string }[];
    };
    expect(parsed.items[0].notes).toBe("First note.");
  });

  test("appendText onto a non-string leaf is a walk-error and emits NO text", () => {
    const original = taskListFixtureText();
    const r = scopedSerialise(original, {
      fieldPath: ["tasks", "900", "dependencies"],
      appendText: "nope",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("walk-error");
  });
});
