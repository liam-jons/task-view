/**
 * anchors.test.ts — verifies in-page anchor + cross-record href builders
 * (PRODUCT inv 12, 13, 22, TECH §4.4).
 */
import { describe, expect, test } from "bun:test";
import {
  backlogItemHref,
  roadmapThemeHref,
  subtaskAnchorId,
  subtaskDepLabel,
  subtaskHref,
  taskDepLabel,
  taskMirrorHref,
} from "./anchors";

describe("Sibling-Subtask anchors (PRODUCT inv 13, TECH §4.4)", () => {
  test("subtaskAnchorId returns deterministic `subtask-{id}` form", () => {
    expect(subtaskAnchorId(1)).toBe("subtask-1");
    expect(subtaskAnchorId(13)).toBe("subtask-13");
  });

  test("subtaskHref returns `#subtask-{id}`", () => {
    expect(subtaskHref(3)).toBe("#subtask-3");
  });

  test("subtaskDepLabel returns `ID-{taskId}.{subtaskId}`", () => {
    expect(subtaskDepLabel("20", 9)).toBe("ID-20.9");
    expect(subtaskDepLabel("100", 1)).toBe("ID-100.1");
  });
});

describe("Cross-record hrefs (PRODUCT inv 12, 22)", () => {
  test("taskMirrorHref returns `ID-{id}.md`", () => {
    expect(taskMirrorHref("20")).toBe("ID-20.md");
  });

  test("taskDepLabel returns `ID-{id}`", () => {
    expect(taskDepLabel("20")).toBe("ID-20");
  });

  test("roadmapThemeHref returns `{id}.md` (ID-20.19 themes)", () => {
    expect(roadmapThemeHref("3")).toBe("3.md");
    expect(roadmapThemeHref("42")).toBe("42.md");
  });

  test("backlogItemHref returns `{id}.md`", () => {
    expect(backlogItemHref("45")).toBe("45.md");
  });
});
