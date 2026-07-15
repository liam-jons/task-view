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
 *   - the initiatives nested tree-walk (['projects', slug, field] /
 *     ['initiatives', path, field]) yields the same minimal-diff discipline
 *     (ID-148.10, INV-13 — repurposed from the retired roadmap themes walk).
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

  // ── ID-90 F5/Bug2: DEL (U+007F) must escape to match Python ensure_ascii ──
  test("escapes DEL (U+007F) to \\u007f (Python ensure_ascii parity)", () => {
    // Python json.dumps("a\x7fb", ensure_ascii=True) === '"a\\u007fb"'.
    // The pre-fix regex lower bound `` skipped DEL, leaving it raw and
    // diverging the JS write from the on-disk convention.
    expect(escapeNonAscii("ab")).toBe("a\\u007fb");
    expect(escapeNonAscii("")).toBe("\\u007f");
  });

  test("regression: em-dash / curly-quotes / astral emoji still round-trip byte-faithfully", () => {
    // The DEL widening must not regress the existing non-ASCII escapes. Each
    // value, once escaped and wrapped in a JSON string, must JSON.parse back to
    // the original (byte-faithful), and emit the exact Python-ensure_ascii form.
    const CURLY_OPEN = "“";
    const CURLY_CLOSE = "”";
    const value = `WS-C4 ${EM_DASH} ${CURLY_OPEN}done${CURLY_CLOSE} ${SECTION}3.5 ${ARROW} \u{1F3AF}`;
    const escaped = escapeNonAscii(value);
    // exact byte form (lowercase hex, surrogate pair for the astral emoji)
    expect(escaped).toBe(
      "WS-C4 \\u2014 \\u201cdone\\u201d \\u00a73.5 \\u2192 \\ud83c\\udfaf",
    );
    // byte-faithful round-trip through a JSON string token
    expect(JSON.parse(`"${escaped}"`)).toBe(value);
    // zero raw non-ASCII bytes survive
    expect(RAW_NON_ASCII.test(escaped)).toBe(false);
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
            id: "1",
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
            id: "1",
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

/** A minimal initiatives fixture (vendored InitiativesSchema shape,
 * ID-148.10) — one top-level initiative with a direct project, plus a
 * second top-level initiative with a nested sub-initiative + its own
 * project, so tree-walk depth is exercised. */
function initiativesFixtureDoc() {
  return {
    document_name: "Canonical Platform - Initiatives",
    document_purpose: `Initiatives fixture ${EM_DASH} byte-stability.`,
    date: "2026-07-15",
    status: "active",
    related_documents: [],
    last_updated: "fixture",
    initiatives: [
      {
        id: "10",
        title: `Initiative ten ${EM_DASH} alpha`,
        description: `Initiative 10 description ${SECTION}1.`,
        status: "active",
        projects: [
          {
            id: "alpha-project",
            title: `Alpha project ${EM_DASH} one`,
            summary: `Alpha summary ${SECTION}1.`,
            description: `Alpha description ${ARROW} forward.`,
            substrate_doc: "",
            status: "idea",
            blocked_by: [],
            blocking: [],
            linked_tasks: [],
            linked_backlog: [],
            originating_session: [],
          },
        ],
        originating_session: [],
        "sub-initiatives": [],
      },
      {
        id: "11",
        title: `Initiative eleven ${EM_DASH} beta`,
        description: `Initiative 11 description ${ARROW} forward.`,
        status: "planned",
        projects: [],
        originating_session: [],
        "sub-initiatives": [
          {
            id: "1",
            title: `Sub eleven-one ${EM_DASH} nested`,
            description: `Sub description ${SECTION}2.`,
            status: "proposed",
            projects: [
              {
                id: "beta-nested-project",
                title: `Beta nested project ${EM_DASH} two`,
                summary: `Beta summary ${ARROW} later.`,
                description: `Beta description.`,
                substrate_doc: "",
                status: "backlog",
                blocked_by: [],
                blocking: [],
                linked_tasks: [],
                linked_backlog: [],
                originating_session: [],
              },
            ],
            originating_session: [],
            "sub-initiatives": [],
          },
        ],
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

  test("initiatives: a direct top-level project field edit changes exactly one line", () => {
    const original = escapeSerialise(initiativesFixtureDoc());
    const r = scopedSerialise(original, {
      fieldPath: ["projects", "alpha-project", "status"],
      newValue: "in-progress",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("initiatives");
    expect(changedLineIndices(original, r.text)).toHaveLength(1);
  });

  test("initiatives: a NESTED (sub-initiative) project field edit changes exactly one line", () => {
    const original = escapeSerialise(initiativesFixtureDoc());
    const r = scopedSerialise(original, {
      fieldPath: ["projects", "beta-nested-project", "status"],
      newValue: "ready",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(changedLineIndices(original, r.text)).toHaveLength(1);
    // The untouched sibling initiative's direct project stays byte-identical.
    expect(r.text).toContain('"id": "alpha-project"');
  });

  test("initiatives: a top-level Initiative field edit by bare path changes exactly one line", () => {
    const original = escapeSerialise(initiativesFixtureDoc());
    const r = scopedSerialise(original, {
      fieldPath: ["initiatives", "10", "status"],
      newValue: "completed",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(changedLineIndices(original, r.text)).toHaveLength(1);
  });

  test("initiatives: a sub-initiative field edit by dotted path changes exactly one line", () => {
    const original = escapeSerialise(initiativesFixtureDoc());
    const r = scopedSerialise(original, {
      fieldPath: ["initiatives", "11.1", "status"],
      newValue: "active",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
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

// ── scopedSerialise — initiatives nested tree-walk (ID-148.10, INV-13) ────────

describe("scopedSerialise — initiatives nested tree-walk (['projects', slug, field] / ['initiatives', path, field])", () => {
  test("linked_tasks membership edit on a project preserves escapes + trailing newline", () => {
    const original = escapeSerialise(initiativesFixtureDoc());
    const r = scopedSerialise(original, {
      fieldPath: ["projects", "alpha-project", "linked_tasks"],
      newValue: ["900", "901"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(RAW_NON_ASCII.test(r.text)).toBe(false);
    expect(r.text.endsWith("}\n")).toBe(true);
    expect(r.text).toContain("\\u2014");
    const parsed = JSON.parse(r.text) as {
      initiatives: { projects: { id: string; linked_tasks: string[] }[] }[];
    };
    expect(parsed.initiatives[0].projects[0].linked_tasks).toEqual([
      "900",
      "901",
    ]);
  });

  test("ATOMIC MOVE: a 2-patch fold re-parenting a task between two projects leaves every OTHER record byte-identical", () => {
    // "Move" simulated as patch-server.ts's PATCH handler actually applies a
    // multi-patch batch: fold scopedSerialise once per patch over the
    // running text (§5.5 all-or-nothing — one Zod re-parse gates the WHOLE
    // batch before any of it is written; the fold here mirrors the bytes
    // that eventually land). No dedicated splice exists for "move" — it is
    // exactly this 2-patch batch (INV-13, patch-apply.ts header). NOTE: a
    // line-COUNT invariant ("exactly N lines changed") does not hold here —
    // pretty-printed JSON renders a non-empty array across multiple lines,
    // so appending/removing an array ELEMENT inherently shifts every
    // subsequent line's index even though its CONTENT is unchanged. The
    // real byte-stability property is per-RECORD, not per-line: untouched
    // records survive as an exact substring (mirrors the existing
    // "flip-subtask: untouched Task 901 record stays byte-identical" style
    // above).
    const withLink = scopedSerialise(escapeSerialise(initiativesFixtureDoc()), {
      fieldPath: ["projects", "alpha-project", "linked_tasks"],
      newValue: ["900"],
    });
    expect(withLink.ok).toBe(true);
    if (!withLink.ok) return;

    const step1 = scopedSerialise(withLink.text, {
      fieldPath: ["projects", "alpha-project", "linked_tasks"],
      newValue: [],
    });
    expect(step1.ok).toBe(true);
    if (!step1.ok) return;
    const step2 = scopedSerialise(step1.text, {
      fieldPath: ["projects", "beta-nested-project", "linked_tasks"],
      newValue: ["900"],
    });
    expect(step2.ok).toBe(true);
    if (!step2.ok) return;

    const parsed = JSON.parse(step2.text) as {
      initiatives: {
        projects: { id: string; linked_tasks: string[] }[];
        "sub-initiatives": {
          projects: { id: string; linked_tasks: string[] }[];
        }[];
      }[];
    };
    expect(parsed.initiatives[0].projects[0].linked_tasks).toEqual([]);
    expect(
      parsed.initiatives[1]["sub-initiatives"][0].projects[0].linked_tasks,
    ).toEqual(["900"]);

    // The untouched initiative "10" (containing alpha-project's SIBLING
    // fields other than linked_tasks) keeps its title/description bytes.
    expect(step2.text).toContain('"title": "Initiative ten \\u2014 alpha"');
    expect(step2.text).toContain('"title": "Alpha project \\u2014 one"');
    // The moved-INTO sub-initiative's own identity fields are untouched by
    // the fold — only linked_tasks changed on its project.
    expect(step2.text).toContain(
      '"title": "Sub eleven-one \\u2014 nested"',
    );
  });

  test("schema-violating project field is lenient at THIS layer (strict-write is a separate gate, INV-3)", () => {
    // initiatives-schema.ts's status is z.string() (lenient read) — a
    // dirty/out-of-enum value still passes THIS module's Zod re-parse.
    // Strict-write enforcement lives at the server budget/write-gate layer,
    // not scoped-serialise. Document the boundary explicitly.
    const original = escapeSerialise(initiativesFixtureDoc());
    const r = scopedSerialise(original, {
      fieldPath: ["projects", "alpha-project", "status"],
      newValue: "not-a-real-status",
    });
    expect(r.ok).toBe(true);
  });

  test("walk-error for a non-existent project slug", () => {
    const original = escapeSerialise(initiativesFixtureDoc());
    const r = scopedSerialise(original, {
      fieldPath: ["projects", "does-not-exist", "status"],
      newValue: "idea",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("walk-error");
  });

  test("walk-error for a non-existent initiative path", () => {
    const original = escapeSerialise(initiativesFixtureDoc());
    const r = scopedSerialise(original, {
      fieldPath: ["initiatives", "999", "status"],
      newValue: "active",
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
function newSubtaskRecord(id: string) {
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
      record: newSubtaskRecord("2"),
    });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    expect(inserted.text).toContain('"id": "2"');

    const removed = scopedSpliceSerialise(inserted.text, {
      kind: "remove",
      collection: "subtasks",
      taskId: "900",
      recordId: "2",
    });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.text).toBe(original);
  });

  test("initiatives: project insert under a TOP-LEVEL initiative -> remove round-trips byte-identically (INV-13)", () => {
    const original = escapeSerialise(initiativesFixtureDoc());
    const doc = initiativesFixtureDoc();
    const record = { ...doc.initiatives[0].projects[0], id: "999900-project" };

    const inserted = scopedSpliceSerialise(original, {
      kind: "insert",
      collection: "projects",
      initiativePath: "10",
      record,
    });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    expect(inserted.kind).toBe("initiatives");
    expect(inserted.text).toContain('"id": "999900-project"');

    const removed = scopedSpliceSerialise(inserted.text, {
      kind: "remove",
      collection: "projects",
      recordId: "999900-project",
    });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.text).toBe(original);
  });

  test("initiatives: project insert under a NESTED sub-initiative -> remove round-trips byte-identically (INV-13)", () => {
    const original = escapeSerialise(initiativesFixtureDoc());
    const doc = initiativesFixtureDoc();
    const record = { ...doc.initiatives[0].projects[0], id: "999901-nested" };

    const inserted = scopedSpliceSerialise(original, {
      kind: "insert",
      collection: "projects",
      initiativePath: "11.1",
      record,
    });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    expect(inserted.text).toContain('"id": "999901-nested"');

    const removed = scopedSpliceSerialise(inserted.text, {
      kind: "remove",
      collection: "projects",
      recordId: "999901-nested",
    });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.text).toBe(original);
  });

  test("initiatives: insert with a missing initiativePath is a walk-error", () => {
    const original = escapeSerialise(initiativesFixtureDoc());
    const r = scopedSpliceSerialise(original, {
      kind: "insert",
      collection: "projects",
      record: { id: "x" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("walk-error");
  });

  test("initiatives: insert with an unresolvable initiativePath is a walk-error", () => {
    const original = escapeSerialise(initiativesFixtureDoc());
    const r = scopedSpliceSerialise(original, {
      kind: "insert",
      collection: "projects",
      initiativePath: "999",
      record: { id: "x" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("walk-error");
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
      record: newSubtaskRecord("1"),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("walk-error");
  });

  // KH port (ID-90.13 U11): __tests__/lib/ledger/scoped-serialise.test.ts —
  // "a subtask insert with a non-digit-string id fails schema-error".
  // Post-ID-102.7 the id contract is a digit-string (`/^\d+$/`, positive);
  // a non-digit string like "not-a-number" fails the schema, as does a number.
  test("a subtask insert with a non-digit-string id fails schema-error", () => {
    const original = taskListFixtureText();
    const hostId = (JSON.parse(original) as { tasks: { id: string }[] })
      .tasks[0].id;
    const r = scopedSpliceSerialise(original, {
      kind: "insert",
      collection: "subtasks",
      taskId: hostId,
      record: {
        ...newSubtaskRecord("1"),
        id: "not-a-number",
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("schema-error");
  });

  // KH port (ID-90.13 U11): the splice path's unknown-document rejection —
  // the scopedSerialise twin exists above; the splice surface needs its own.
  test("unknown-document when the splice target is not a recognised ledger", () => {
    const r = scopedSpliceSerialise(
      JSON.stringify({ document_name: "Not A Ledger", tasks: [] }),
      { kind: "insert", collection: "tasks", record: newTaskRecord("1") },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("unknown-document");
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

// The core ledgers were normalised by KH's OQ-LS-2 pass (S270) — the
// no-op round-trip MUST be byte-identical (invariant 20). ID-148.10:
// product-roadmap.json was manually repurposed into initiatives.json (TECH
// §Revision note) — this replaces the former roadmap entry.
const normalisedLedgers = [
  "task-list.json",
  "product-backlog.json",
  "initiatives.json",
];

// Not yet byte-conforming on disk:
//   - product-retros.json is outside the substrate document set — included
//     here as a content-neutral check only.
//   - umbrellas.json's file DELETION is deferred (Decision 4a / OQ4) but its
//     document_name is no longer a recognised detectSchema kind (ID-148.10,
//     INV-12(b) — full retirement); it is intentionally OMITTED from this
//     list — detectSchema now routes it to 'unknown', so no scoped-write
//     round-trip claim applies to it any more.
const unnormalisedLedgers = ["product-retros.json"];

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
    "flipping one real project status touches exactly one line of the live initiatives ledger (INV-13)",
    () => {
      const path = join(KH_LEDGER_DIR, "initiatives.json");
      if (!existsSync(path)) return;
      const original = readFileSync(path, "utf8");
      const doc = JSON.parse(original) as {
        initiatives: { projects: { id: string; status: string }[] }[];
      };
      const firstWithProject = doc.initiatives.find(
        (i) => i.projects.length > 0,
      );
      if (!firstWithProject) return;
      const target = firstWithProject.projects[0];
      const newStatus = target.status === "idea" ? "proposal" : "idea";
      const r = scopedSerialise(original, {
        fieldPath: ["projects", target.id, "status"],
        newValue: newStatus,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.kind).toBe("initiatives");
      expect(changedLineIndices(original, r.text)).toHaveLength(1);
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
