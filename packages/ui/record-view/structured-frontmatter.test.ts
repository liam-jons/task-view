/**
 * structured-frontmatter.test.ts — verifies the nested-DocLink-aware
 * frontmatter parser extension (TECH §4.1 last paragraph; covers the
 * 20.7 Executor's flagged parser limitation for cross_doc_links).
 */
import { describe, expect, test } from "bun:test";
import {
  extractFrontmatterRaw,
  parseStructuredFrontmatter,
} from "./structured-frontmatter";

describe("extractFrontmatterRaw", () => {
  test("returns the body when --- delimiters are present", () => {
    const md = "---\nkey: value\n---\n\nBody";
    expect(extractFrontmatterRaw(md)).toBe("key: value");
  });

  test("returns null when no frontmatter is present", () => {
    expect(extractFrontmatterRaw("# Just markdown")).toBeNull();
  });

  test("returns null when opening --- has no matching close", () => {
    expect(extractFrontmatterRaw("---\nincomplete")).toBeNull();
  });
});

describe("parseStructuredFrontmatter", () => {
  test("parses flat scalar key:value pairs", () => {
    const body = "type: task\nid: \"20\"\nstatus: in_progress";
    const fm = parseStructuredFrontmatter(body);
    expect(fm.type).toBe("task");
    expect(fm.id).toBe("20");
    expect(fm.status).toBe("in_progress");
  });

  test("parses null literal as JS null", () => {
    const body = "owner: null\npriority_note: null";
    const fm = parseStructuredFrontmatter(body);
    expect(fm.owner).toBeNull();
    expect(fm.priority_note).toBeNull();
  });

  test("parses flow-list `[a, b, c]` as string array", () => {
    const body = "session_refs: [s1, s2]\ncommit_refs: []";
    const fm = parseStructuredFrontmatter(body);
    expect(fm.session_refs).toEqual(["s1", "s2"]);
    expect(fm.commit_refs).toEqual([]);
  });

  test("parses flow-list with quoted entries", () => {
    const body = 'session_refs: [s1, "s2: with colon", s3]';
    const fm = parseStructuredFrontmatter(body);
    expect(fm.session_refs).toEqual(["s1", "s2: with colon", "s3"]);
  });

  test("parses nested DocLink block list — the 20.7 limitation fix", () => {
    const body = `cross_doc_links:
  - path: docs/foo.md
    anchor: null
    raw: "foo spec"
  - path: docs/bar.md
    anchor: "#section-2"
    raw: "bar §2"`;
    const fm = parseStructuredFrontmatter(body);
    expect(fm.cross_doc_links).toEqual([
      { path: "docs/foo.md", anchor: null, raw: "foo spec" },
      { path: "docs/bar.md", anchor: "#section-2", raw: "bar §2" },
    ]);
  });

  test("preserves quoted DocLink path containing reserved characters", () => {
    const body = `cross_doc_links:
  - path: "docs/foo: with colon.md"
    anchor: null
    raw: "foo"`;
    const fm = parseStructuredFrontmatter(body);
    expect(fm.cross_doc_links).toEqual([
      { path: "docs/foo: with colon.md", anchor: null, raw: "foo" },
    ]);
  });

  test("parses empty block list as empty array", () => {
    // The generator emits `cross_doc_links: []` when empty (flow form),
    // but defensively support the block-style empty too.
    const body = "cross_doc_links: []";
    const fm = parseStructuredFrontmatter(body);
    expect(fm.cross_doc_links).toEqual([]);
  });

  test("does not confuse DocLink keys with sibling top-level keys", () => {
    const body = `cross_doc_links:
  - path: docs/foo.md
    anchor: null
    raw: "foo"
status: pending`;
    const fm = parseStructuredFrontmatter(body);
    expect(fm.cross_doc_links).toEqual([
      { path: "docs/foo.md", anchor: null, raw: "foo" },
    ]);
    expect(fm.status).toBe("pending");
  });

  test("handles a mirror-generator-style full frontmatter", () => {
    // Lifted from a real generated Task mirror shape.
    const body = `type: task
id: "20"
title: "Task title"
status: pending
priority: must
effort_estimate: "~2h"
owner: Engineering
updated: "2026-05-21T15:30:00.000Z"
session_refs: [kh-prod-readiness-S63]
commit_refs: [abc1234]
dependencies: [19]
cross_doc_links:
  - path: docs/specs/per-task-mirror/PRODUCT.md
    anchor: null
    raw: PRODUCT.md
priority_note: null
status_note: null`;
    const fm = parseStructuredFrontmatter(body);
    expect(fm.type).toBe("task");
    expect(fm.id).toBe("20");
    expect(fm.session_refs).toEqual(["kh-prod-readiness-S63"]);
    expect(fm.dependencies).toEqual(["19"]);
    expect(fm.cross_doc_links).toEqual([
      {
        path: "docs/specs/per-task-mirror/PRODUCT.md",
        anchor: null,
        raw: "PRODUCT.md",
      },
    ]);
    expect(fm.priority_note).toBeNull();
    expect(fm.status_note).toBeNull();
  });
});
