/**
 * schema-fail-load.test.ts — verifies PRODUCT inv 48: "Schema validation
 * failure on load: when the canonical JSON fails Zod parse, the tool
 * displays the formatted ZodError and exits with non-zero status."
 *
 * The CLI shell (ID-20.11) catches the ZodError and renders the error
 * page; the schema-detection module's contract here is: ZodError MUST
 * surface (not be swallowed) when a known document_name routes to a
 * schema whose `.parse(...)` rejects the body.
 *
 * Per PLAN.md §20.9 acceptance bullets: "ZodError fail-on-load test
 * (inv 48)".
 */
import { describe, expect, test } from "bun:test";
import { ZodError } from "zod";
import { detectSchema } from "./detect-schema";

describe("PRODUCT inv 48 — Schema validation failure on load surfaces ZodError", () => {
  test("known document_name + invalid body throws ZodError (not silently coerced)", () => {
    const invalid = {
      document_name: "Knowledge Hub Task List",
      // Missing every other required field — TaskListSchema.parse must throw
    };
    expect(() => detectSchema(invalid)).toThrow(ZodError);
  });

  test("invalid Task.subtasks superRefine failure surfaces ZodError too", () => {
    const invalid = {
      document_name: "Knowledge Hub Task List",
      document_purpose: "p",
      last_updated: "u",
      related_documents: [],
      tasks: [
        {
          id: "20",
          title: "T",
          description: "d",
          status: "pending",
          priority: "must",
          dependencies: [],
          subtasks: [
            {
              id: 1,
              title: "S1",
              description: "S1",
              details: "",
              status: "pending",
              dependencies: [99], // 99 is not a sibling
              testStrategy: null,
            },
          ],
          updatedAt: "2026-05-21T15:30:00.000Z",
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
    expect(() => detectSchema(invalid)).toThrow(ZodError);
  });

  test("ZodError carries usable issues (not a raw Error)", () => {
    const invalid = {
      document_name: "Product Backlog",
      // Missing required `document_purpose`, `last_updated`, etc.
    };
    let thrown: unknown = null;
    try {
      detectSchema(invalid);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ZodError);
    if (thrown instanceof ZodError) {
      expect(thrown.issues.length).toBeGreaterThan(0);
      // Issues should reference missing fields
      const paths = thrown.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p === "document_purpose")).toBe(true);
    }
  });

  test("Initiatives schema rejection surfaces ZodError too (ID-148.10, repurposed roadmap arm)", () => {
    const invalid = {
      document_name: "Canonical Platform - Initiatives",
      // Missing date, initiatives, etc.
    };
    expect(() => detectSchema(invalid)).toThrow(ZodError);
  });

  test("unknown document_name returns kind=unknown rather than throwing", () => {
    // Inv 48 is for schema-parse failure on KNOWN document_name; unknown
    // document_name routes to the friendly "unknown-format" error page
    // per inv 4 last bullet, not a ZodError.
    const result = detectSchema({ document_name: "unknown-doc" });
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.documentName).toBe("unknown-doc");
    }
  });
});
