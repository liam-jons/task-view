/**
 * backlog-references.test.ts — findBacklogReferences dangling-ref scan
 * (backlog-ui-delete). The ledger schemas do NOT enforce referential
 * integrity, so deleting a backlog item can orphan:
 *   - other items' `dependencies[]` that name it, and
 *   - roadmap themes' `linked_backlog[]` that name it.
 * This pure scan powers the delete-confirmation warning.
 */
import { describe, expect, test } from "bun:test";
import type { BacklogItem } from "@task-view/schemas/backlog";
import type { Roadmap } from "@task-view/schemas/roadmap";
import { findBacklogReferences } from "./backlog-references";

const mkItem = (overrides: Partial<BacklogItem> = {}): BacklogItem => ({
  id: "1",
  description: "Item.",
  type: "feature",
  status: "ready",
  effort_estimate: "S",
  priority: "high",
  track: "Bid",
  dependencies: [],
  session_refs: [],
  commit_refs: [],
  cross_doc_links: [],
  notes: null,
  ...overrides,
});

const mkRoadmap = (
  themes: { id: string; title: string; linked_backlog: string[] }[],
): Roadmap =>
  ({
    document_name: "Knowledge Hub Roadmap",
    document_purpose: "p",
    date: "2026-05-30",
    status: "Active",
    forward_looking_only: true,
    related_documents: [] as string[],
    last_updated: "fixture",
    themes: themes.map((t) => ({
      id: t.id,
      title: t.title,
      description: "d",
      time_horizon: "now" as const,
      status: "in_progress" as const,
      linked_tasks: [],
      linked_backlog: t.linked_backlog,
      session_refs: [],
      commit_refs: [],
      cross_doc_links: [],
      notes: null,
    })),
  }) as Roadmap;

describe("findBacklogReferences — dependents", () => {
  test("lists other items whose dependencies include the id, in order", () => {
    const items = [
      mkItem({ id: "1" }),
      mkItem({ id: "2", dependencies: ["1"] }),
      mkItem({ id: "3", dependencies: ["9"] }),
      mkItem({ id: "4", dependencies: ["1", "2"] }),
    ];
    const refs = findBacklogReferences("1", { items });
    expect(refs.dependents.map((d) => d.id)).toEqual(["2", "4"]);
    expect(refs.themes).toEqual([]);
  });

  test("never reports the target item itself as a dependent", () => {
    const items = [mkItem({ id: "1", dependencies: ["1"] })];
    const refs = findBacklogReferences("1", { items });
    expect(refs.dependents).toEqual([]);
  });

  test("returns no dependents when nothing references the id", () => {
    const items = [mkItem({ id: "1" }), mkItem({ id: "2", dependencies: ["3"] })];
    const refs = findBacklogReferences("1", { items });
    expect(refs.dependents).toEqual([]);
  });
});

describe("findBacklogReferences — roadmap themes", () => {
  test("lists themes whose linked_backlog includes the id, in order", () => {
    const roadmap = mkRoadmap([
      { id: "T1", title: "One", linked_backlog: ["1"] },
      { id: "T2", title: "Two", linked_backlog: ["9"] },
      { id: "T3", title: "Three", linked_backlog: ["1", "2"] },
    ]);
    const refs = findBacklogReferences("1", { items: [], roadmap });
    expect(refs.themes.map((t) => t.id)).toEqual(["T1", "T3"]);
    expect(refs.themes[0].title).toBe("One");
  });

  test("tolerates an omitted roadmap", () => {
    const refs = findBacklogReferences("1", {
      items: [mkItem({ id: "2", dependencies: ["1"] })],
    });
    expect(refs.dependents.map((d) => d.id)).toEqual(["2"]);
    expect(refs.themes).toEqual([]);
  });

  test("tolerates a null roadmap", () => {
    const refs = findBacklogReferences("1", {
      items: [mkItem({ id: "2", dependencies: ["1"] })],
      roadmap: null,
    });
    expect(refs.dependents.map((d) => d.id)).toEqual(["2"]);
    expect(refs.themes).toEqual([]);
  });
});

describe("findBacklogReferences — hasReferences flag", () => {
  test("is false when no dependents and no themes reference the id", () => {
    expect(
      findBacklogReferences("1", { items: [mkItem({ id: "2" })] }).hasReferences,
    ).toBe(false);
  });

  test("is true when a dependent exists", () => {
    expect(
      findBacklogReferences("1", {
        items: [mkItem({ id: "2", dependencies: ["1"] })],
      }).hasReferences,
    ).toBe(true);
  });

  test("is true when only a theme references the id", () => {
    const roadmap = mkRoadmap([{ id: "T1", title: "One", linked_backlog: ["1"] }]);
    expect(
      findBacklogReferences("1", { items: [], roadmap }).hasReferences,
    ).toBe(true);
  });
});
