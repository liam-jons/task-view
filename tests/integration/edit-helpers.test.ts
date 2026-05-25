/**
 * tests/integration/edit-helpers.test.ts — pure-helper unit tests for
 * ID-20.10 edit affordances (PRODUCT inv 26-35 + 51).
 *
 * The viewer's SSR test convention can't exercise DOM behaviour
 * (no happy-dom / testing-library); behaviour-level integration tests
 * live here and assert on the pure helpers + SSR markup output. The
 * keystroke-level wiring (Cmd+Enter / Esc handlers, fetch call,
 * window.localStorage hook) lives in the SPA hydration layer at
 * `apps/server/web/` and is exercised end-to-end via the patch-server's
 * own integration tests (which round-trip a full edit through the
 * helpers tested here).
 */
import { describe, expect, test } from "bun:test";
import { z, ZodError } from "zod";
import {
  buildArrayPatch,
  buildFieldPatch,
  classifySaveResult,
  clearDraft,
  createMemoryDraftStore,
  formatZodErrorInline,
  getDraftKey,
  loadDraft,
  parseCommaSeparatedIds,
  parseCommaSeparatedNumbers,
  saveDraft,
} from "../../packages/ui/record-view/edit-state";

// ── FieldPatch construction (TECH §5.1 wire format) ──────────────────────────

describe("buildFieldPatch — passthrough for text + enum edits", () => {
  test("string newValue", () => {
    const p = buildFieldPatch(["tasks", "20", "description"], "New desc");
    expect(p).toEqual({
      fieldPath: ["tasks", "20", "description"],
      newValue: "New desc",
    });
  });

  test("enum newValue", () => {
    const p = buildFieldPatch(["tasks", "20", "status"], "done");
    expect(p.newValue).toBe("done");
  });

  test("null newValue (nullable enum unset)", () => {
    const p = buildFieldPatch(
      ["themes", "3", "notes"],
      null,
    );
    expect(p.newValue).toBeNull();
  });

  test("clones fieldPath array — caller cannot mutate", () => {
    const path = ["tasks", "20", "status"];
    const p = buildFieldPatch(path, "done");
    path[1] = "21";
    expect(p.fieldPath[1]).toBe("20"); // patch is independent
  });
});

// ── Comma-separated array parsing (PRODUCT inv 34) ───────────────────────────

describe("parseCommaSeparatedIds — PRODUCT inv 34", () => {
  test("plain comma-separated", () => {
    expect(parseCommaSeparatedIds("20, 19, 18")).toEqual(["20", "19", "18"]);
  });

  test("trims surrounding whitespace per element", () => {
    expect(parseCommaSeparatedIds("  20  ,  19  ")).toEqual(["20", "19"]);
  });

  test("drops empty entries (double comma)", () => {
    expect(parseCommaSeparatedIds("20,,19")).toEqual(["20", "19"]);
  });

  test("empty string → empty array", () => {
    expect(parseCommaSeparatedIds("")).toEqual([]);
  });

  test("commas-only → empty array", () => {
    expect(parseCommaSeparatedIds(",,,")).toEqual([]);
  });

  test("single id", () => {
    expect(parseCommaSeparatedIds("ID-42")).toEqual(["ID-42"]);
  });
});

describe("parseCommaSeparatedNumbers — Subtask.dependencies", () => {
  test("parses to numbers", () => {
    expect(parseCommaSeparatedNumbers("1, 2, 3")).toEqual([1, 2, 3]);
  });

  test("malformed entries become NaN (server's Zod rejects)", () => {
    expect(parseCommaSeparatedNumbers("1, abc, 3")).toEqual([1, NaN, 3]);
  });

  test("empty string → empty array", () => {
    expect(parseCommaSeparatedNumbers("")).toEqual([]);
  });
});

describe("buildArrayPatch — wraps parseCommaSeparatedIds in FieldPatch shape", () => {
  test("typical dependencies edit", () => {
    const p = buildArrayPatch(
      ["tasks", "20", "dependencies"],
      "19, 18, 17",
    );
    expect(p).toEqual({
      fieldPath: ["tasks", "20", "dependencies"],
      newValue: ["19", "18", "17"],
    });
  });

  test("trims + drops empty", () => {
    const p = buildArrayPatch(
      ["tasks", "20", "session_refs"],
      "S60,, S61 ,",
    );
    expect(p.newValue).toEqual(["S60", "S61"]);
  });
});

// ── Zod error formatting (PRODUCT inv 29 inline display) ──────────────────────

describe("formatZodErrorInline", () => {
  test("formats first issue with path prefix", () => {
    const schema = z.object({
      status: z.enum(["pending", "done"]),
    });
    try {
      schema.parse({ status: "wrong" });
    } catch (e) {
      const msg = formatZodErrorInline(e as ZodError);
      expect(msg).toContain("status:");
      // Zod's message body varies by version but mentions the enum
      expect(msg.length).toBeGreaterThan("status:".length);
    }
  });

  test("formats nested path", () => {
    const schema = z.object({
      subtasks: z.array(
        z.object({
          status: z.enum(["pending", "done"]),
        }),
      ),
    });
    try {
      schema.parse({ subtasks: [{ status: "wrong" }] });
    } catch (e) {
      const msg = formatZodErrorInline(e as ZodError);
      expect(msg).toMatch(/subtasks\.0\.status:/);
    }
  });

  test("(root) prefix when path is empty", () => {
    // Synthesise a top-level error
    const schema = z.string();
    try {
      schema.parse(42);
    } catch (e) {
      const msg = formatZodErrorInline(e as ZodError);
      expect(msg.startsWith("(root):")).toBe(true);
    }
  });
});

// ── localStorage draft keys (PRODUCT inv 51) ──────────────────────────────────

describe("getDraftKey — PRODUCT inv 51", () => {
  test("composes {ledgerPath, recordId, fieldPath} into stable key", () => {
    const key = getDraftKey(
      "/repo/docs/reference/task-list.json",
      "20",
      ["tasks", "20", "description"],
    );
    expect(key).toBe(
      "task-view-draft:/repo/docs/reference/task-list.json:20:tasks>20>description",
    );
  });

  test("distinguishes nested fieldPath from top-level same suffix", () => {
    const k1 = getDraftKey("/a.json", "20", ["tasks", "20", "details"]);
    const k2 = getDraftKey("/a.json", "20", [
      "tasks",
      "20",
      "subtasks",
      "10",
      "details",
    ]);
    expect(k1).not.toBe(k2);
  });

  test("distinguishes different recordIds", () => {
    const k1 = getDraftKey("/a.json", "20", ["tasks", "20", "description"]);
    const k2 = getDraftKey("/a.json", "21", ["tasks", "21", "description"]);
    expect(k1).not.toBe(k2);
  });

  test("distinguishes different ledgerPaths", () => {
    const k1 = getDraftKey("/a.json", "20", ["tasks", "20", "description"]);
    const k2 = getDraftKey("/b.json", "20", ["tasks", "20", "description"]);
    expect(k1).not.toBe(k2);
  });
});

describe("createMemoryDraftStore — mirrors window.localStorage", () => {
  test("get returns null for absent key", () => {
    const s = createMemoryDraftStore();
    expect(s.get("any")).toBeNull();
  });

  test("set + get roundtrip", () => {
    const s = createMemoryDraftStore();
    s.set("k", "v");
    expect(s.get("k")).toBe("v");
  });

  test("remove deletes key", () => {
    const s = createMemoryDraftStore();
    s.set("k", "v");
    s.remove("k");
    expect(s.get("k")).toBeNull();
  });

  test("set with empty string is distinct from absent (truthiness trap guard)", () => {
    const s = createMemoryDraftStore();
    s.set("k", "");
    expect(s.get("k")).toBe(""); // not null
  });
});

describe("saveDraft / loadDraft / clearDraft — full draft lifecycle (inv 51)", () => {
  test("save then load returns same value", () => {
    const s = createMemoryDraftStore();
    saveDraft(
      s,
      "/repo/task-list.json",
      "20",
      ["tasks", "20", "description"],
      "Unsaved text",
    );
    expect(
      loadDraft(s, "/repo/task-list.json", "20", [
        "tasks",
        "20",
        "description",
      ]),
    ).toBe("Unsaved text");
  });

  test("load returns null for never-saved triple", () => {
    const s = createMemoryDraftStore();
    expect(
      loadDraft(s, "/repo/task-list.json", "20", [
        "tasks",
        "20",
        "description",
      ]),
    ).toBeNull();
  });

  test("clear removes the draft", () => {
    const s = createMemoryDraftStore();
    saveDraft(
      s,
      "/repo/task-list.json",
      "20",
      ["tasks", "20", "description"],
      "draft",
    );
    clearDraft(s, "/repo/task-list.json", "20", [
      "tasks",
      "20",
      "description",
    ]);
    expect(
      loadDraft(s, "/repo/task-list.json", "20", [
        "tasks",
        "20",
        "description",
      ]),
    ).toBeNull();
  });

  test("clearing one triple does not affect a sibling triple", () => {
    const s = createMemoryDraftStore();
    saveDraft(s, "/a.json", "20", ["tasks", "20", "description"], "A");
    saveDraft(s, "/a.json", "20", ["tasks", "20", "status_note"], "B");
    clearDraft(s, "/a.json", "20", ["tasks", "20", "description"]);
    expect(loadDraft(s, "/a.json", "20", ["tasks", "20", "status_note"])).toBe(
      "B",
    );
  });
});

// ── Server-result classification ──────────────────────────────────────────────

describe("classifySaveResult — TECH §5.1 response shape", () => {
  test("ok response", () => {
    expect(
      classifySaveResult({ ok: true, newMtime: "2026-05-22T00:00:00Z" }),
    ).toEqual({ kind: "ok" });
  });

  test("schema error", () => {
    expect(
      classifySaveResult({
        ok: false,
        error: {
          kind: "schema-error",
          message: "Field x: invalid enum",
        },
      }),
    ).toEqual({
      kind: "schema-error",
      message: "Field x: invalid enum",
    });
  });

  test("mtime conflict", () => {
    expect(
      classifySaveResult({
        ok: false,
        error: {
          kind: "mtime-conflict",
          message: "Ledger changed underneath you.",
        },
      }),
    ).toEqual({
      kind: "mtime-conflict",
      message: "Ledger changed underneath you.",
    });
  });

  test("walk error", () => {
    expect(
      classifySaveResult({
        ok: false,
        error: {
          kind: "walk-error",
          detail: "Task id 99 not found.",
        },
      }),
    ).toEqual({
      kind: "walk-error",
      message: "Task id 99 not found.",
    });
  });

  test("malformed response → network error", () => {
    expect(classifySaveResult(null).kind).toBe("network-error");
    expect(classifySaveResult("oops").kind).toBe("network-error");
    expect(classifySaveResult({ random: true }).kind).toBe("network-error");
  });
});
