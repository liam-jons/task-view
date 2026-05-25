/**
 * tests/integration/edit-dispatch.test.ts — pure-core dispatch tests for
 * the ID-20.24 progressive-enhancement hydration layer.
 *
 * Exercises the kind-keyed FieldPatch builder, the data-edit-field hook
 * parser, and the PATCH request-body assembler — the DOM-free core the
 * client shell wires document-level listeners on top of.
 *
 * The Backlog-index rank pencil (`integer-nullable`) is the ONLY consumer
 * wired in 20.24, but the dispatcher handles all kinds so 20.25 is purely
 * additive (mount the form primitives carrying the same hooks → they Just
 * Work). These tests assert the all-kinds contract up-front.
 */
import { describe, expect, test } from "bun:test";
import {
  buildMultiPatchRequest,
  buildPatchForKind,
  buildPatchRequest,
  isDispatchKind,
  parseFieldPathAttr,
  recordPatchPath,
  type DispatchKind,
} from "../../packages/ui/record-view/edit-dispatch";

describe("parseFieldPathAttr — inverse of fieldPath.join('>')", () => {
  test("splits the data-edit-field hook back into a FieldPath", () => {
    expect(parseFieldPathAttr("items>ID-30>rank")).toEqual([
      "items",
      "ID-30",
      "rank",
    ]);
  });

  test("single-segment field", () => {
    expect(parseFieldPathAttr("tasks")).toEqual(["tasks"]);
  });

  test("nested subtask path", () => {
    expect(parseFieldPathAttr("tasks>20>subtasks>10>status")).toEqual([
      "tasks",
      "20",
      "subtasks",
      "10",
      "status",
    ]);
  });

  test("null / empty hook → null", () => {
    expect(parseFieldPathAttr(null)).toBeNull();
    expect(parseFieldPathAttr(undefined)).toBeNull();
    expect(parseFieldPathAttr("")).toBeNull();
  });
});

describe("isDispatchKind — narrows known kinds", () => {
  test("accepts all nine known kinds", () => {
    const kinds: DispatchKind[] = [
      "text",
      "textarea",
      "enum",
      "enum-nullable",
      "array-comma",
      "array-comma-number",
      "doc-links",
      "integer",
      "integer-nullable",
    ];
    for (const k of kinds) expect(isDispatchKind(k)).toBe(true);
  });

  test("rejects unknown / null", () => {
    expect(isDispatchKind("frobnicate")).toBe(false);
    expect(isDispatchKind(null)).toBe(false);
    expect(isDispatchKind(undefined)).toBe(false);
  });
});

describe("buildPatchForKind — wire shape is { fieldPath, newValue }", () => {
  test("text → passthrough string", () => {
    const p = buildPatchForKind("text", ["tasks", "20", "owner"], "Liam");
    expect(p).toEqual({ fieldPath: ["tasks", "20", "owner"], newValue: "Liam" });
  });

  test("textarea → passthrough string", () => {
    const p = buildPatchForKind(
      "textarea",
      ["tasks", "20", "description"],
      "Multi\nline",
    );
    expect(p.newValue).toBe("Multi\nline");
  });

  test("enum → passthrough string", () => {
    const p = buildPatchForKind("enum", ["tasks", "20", "status"], "done");
    expect(p.newValue).toBe("done");
  });

  test("enum-nullable: value → string", () => {
    const p = buildPatchForKind(
      "enum-nullable",
      ["themes", "3", "status"],
      "shaping",
    );
    expect(p.newValue).toBe("shaping");
  });

  test("enum-nullable: '' sentinel → null", () => {
    const p = buildPatchForKind("enum-nullable", ["themes", "3", "status"], "");
    expect(p.newValue).toBeNull();
  });

  test("array-comma → trimmed string array", () => {
    const p = buildPatchForKind(
      "array-comma",
      ["tasks", "20", "dependencies"],
      "19, 18 , ,17",
    );
    expect(p.newValue).toEqual(["19", "18", "17"]);
  });

  test("array-comma-number → number array (NaN for malformed, server rejects)", () => {
    const p = buildPatchForKind(
      "array-comma-number",
      ["tasks", "20", "subtasks", "1", "dependencies"],
      "1, 2, x",
    );
    expect(p.newValue).toEqual([1, 2, NaN]);
  });

  test("integer → numeric coercion", () => {
    const p = buildPatchForKind("integer", ["items", "ID-30", "rank"], "5");
    expect(p.newValue).toBe(5);
  });

  test("integer-nullable: numeric value", () => {
    const p = buildPatchForKind(
      "integer-nullable",
      ["items", "ID-30", "rank"],
      "  7  ",
    );
    expect(p.newValue).toBe(7);
  });

  test("integer-nullable: empty input → null (clear-to-unset)", () => {
    const p = buildPatchForKind(
      "integer-nullable",
      ["items", "ID-30", "rank"],
      "",
    );
    expect(p.newValue).toBeNull();
  });

  test("integer-nullable: non-numeric → NaN (server's Zod rejects, surfaces 422)", () => {
    const p = buildPatchForKind(
      "integer-nullable",
      ["items", "ID-30", "rank"],
      "abc",
    );
    expect(Number.isNaN(p.newValue as number)).toBe(true);
  });

  test("doc-links: assembles rows, empty anchor → null", () => {
    const p = buildPatchForKind(
      "doc-links",
      ["tasks", "20", "cross_doc_links"],
      [
        { path: "docs/a.md", anchor: "intro", raw: "[A](docs/a.md#intro)" },
        { path: "docs/b.md", anchor: "", raw: "[B](docs/b.md)" },
      ],
    );
    expect(p.newValue).toEqual([
      { path: "docs/a.md", anchor: "intro", raw: "[A](docs/a.md#intro)" },
      { path: "docs/b.md", anchor: null, raw: "[B](docs/b.md)" },
    ]);
  });

  test("fieldPath is cloned — caller cannot mutate the patch", () => {
    const fp = ["items", "ID-30", "rank"];
    const p = buildPatchForKind("integer", fp, "1");
    fp[1] = "ID-99";
    expect(p.fieldPath[1]).toBe("ID-30");
  });
});

describe("buildPatchRequest / buildMultiPatchRequest — handlePatchRecord body", () => {
  test("single patch wraps in { patches:[...], baseMtime }", () => {
    const patch = buildPatchForKind("integer-nullable", ["items", "ID-30", "rank"], "3");
    const body = buildPatchRequest(patch, "2026-05-25T10:00:00.000Z");
    expect(body).toEqual({
      patches: [{ fieldPath: ["items", "ID-30", "rank"], newValue: 3 }],
      baseMtime: "2026-05-25T10:00:00.000Z",
    });
  });

  test("multi-field save carries N patches (PRODUCT inv 38)", () => {
    const a = buildPatchForKind("text", ["tasks", "20", "owner"], "Liam");
    const b = buildPatchForKind("enum", ["tasks", "20", "status"], "done");
    const body = buildMultiPatchRequest([a, b], "2026-05-25T10:00:00.000Z");
    expect(body.patches).toHaveLength(2);
    expect(body.baseMtime).toBe("2026-05-25T10:00:00.000Z");
  });
});

describe("recordPatchPath — /api/ledger/record/:recordId", () => {
  test("encodes the record id", () => {
    expect(recordPatchPath("ID-30")).toBe("/api/ledger/record/ID-30");
  });

  test("encodes reserved characters", () => {
    expect(recordPatchPath("a/b")).toBe("/api/ledger/record/a%2Fb");
  });
});
