/**
 * backlog-references.test.ts — findBacklogReferences dangling-ref scan
 * (backlog-ui-delete). The ledger schemas do NOT enforce referential
 * integrity, so deleting a backlog item can orphan:
 *   - other items' `dependencies[]` that name it, and
 *   - initiatives projects' `linked_backlog[]` that name it (ID-148.10,
 *     INV-6 "links are project-only" — repurposed from roadmap themes;
 *     the scan walks the WHOLE tree, any depth).
 * This pure scan powers the delete-confirmation warning.
 */
import { describe, expect, test } from "bun:test";
import type { BacklogItem } from "@task-view/schemas/backlog";
import type { InitiativesDocument, Project } from "@task-view/schemas/initiatives";
import {
  buildDeleteConfirmMessage,
  findBacklogReferences,
} from "./backlog-references";

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

const mkProjectFixture = (
  id: string,
  title: string,
  linkedBacklog: string[],
): Project => ({
  id,
  title,
  summary: "s",
  description: "d",
  substrate_doc: "",
  status: "idea",
  blocked_by: [],
  blocking: [],
  linked_tasks: [],
  linked_backlog: linkedBacklog,
  originating_session: [],
});

/** A single top-level initiative carrying the given direct projects — flat
 * (no nesting) unless a test needs depth. */
const mkInitiativesDoc = (
  projects: { id: string; title: string; linked_backlog: string[] }[],
): InitiativesDocument =>
  ({
    document_name: "Canonical Platform - Initiatives",
    document_purpose: "p",
    date: "2026-07-15",
    status: "active",
    related_documents: [] as string[],
    last_updated: "fixture",
    initiatives: [
      {
        id: "1",
        title: "Initiative 1",
        description: "d",
        status: "active",
        projects: projects.map((p) =>
          mkProjectFixture(p.id, p.title, p.linked_backlog),
        ),
        originating_session: [],
        "sub-initiatives": [],
      },
    ],
  }) as InitiativesDocument;

/** A doc with a project NESTED under a sub-initiative, to prove the scan
 * walks the whole tree (INV-13). */
const mkNestedInitiativesDoc = (
  id: string,
  title: string,
  linkedBacklog: string[],
): InitiativesDocument =>
  ({
    document_name: "Canonical Platform - Initiatives",
    document_purpose: "p",
    date: "2026-07-15",
    status: "active",
    related_documents: [] as string[],
    last_updated: "fixture",
    initiatives: [
      {
        id: "1",
        title: "Initiative 1",
        description: "d",
        status: "active",
        projects: [],
        originating_session: [],
        "sub-initiatives": [
          {
            id: "1",
            title: "Sub",
            description: "d",
            status: "planned",
            projects: [mkProjectFixture(id, title, linkedBacklog)],
            originating_session: [],
            "sub-initiatives": [],
          },
        ],
      },
    ],
  }) as InitiativesDocument;

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
    expect(refs.projects).toEqual([]);
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

describe("findBacklogReferences — initiatives projects (ID-148.10)", () => {
  test("lists direct projects whose linked_backlog includes the id, in order", () => {
    const doc = mkInitiativesDoc([
      { id: "p1", title: "One", linked_backlog: ["1"] },
      { id: "p2", title: "Two", linked_backlog: ["9"] },
      { id: "p3", title: "Three", linked_backlog: ["1", "2"] },
    ]);
    const refs = findBacklogReferences("1", { items: [], initiatives: doc });
    expect(refs.projects.map((p) => p.id)).toEqual(["p1", "p3"]);
    expect(refs.projects[0].title).toBe("One");
  });

  test("finds a NESTED project (under a sub-initiative) tree-wide (INV-13)", () => {
    const doc = mkNestedInitiativesDoc("nested-project", "Nested", ["1"]);
    const refs = findBacklogReferences("1", { items: [], initiatives: doc });
    expect(refs.projects.map((p) => p.id)).toEqual(["nested-project"]);
  });

  test("tolerates an omitted initiatives document", () => {
    const refs = findBacklogReferences("1", {
      items: [mkItem({ id: "2", dependencies: ["1"] })],
    });
    expect(refs.dependents.map((d) => d.id)).toEqual(["2"]);
    expect(refs.projects).toEqual([]);
  });

  test("tolerates a null initiatives document", () => {
    const refs = findBacklogReferences("1", {
      items: [mkItem({ id: "2", dependencies: ["1"] })],
      initiatives: null,
    });
    expect(refs.dependents.map((d) => d.id)).toEqual(["2"]);
    expect(refs.projects).toEqual([]);
  });
});

describe("findBacklogReferences — hasReferences flag", () => {
  test("is false when no dependents and no projects reference the id", () => {
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

  test("is true when only a project references the id", () => {
    const doc = mkInitiativesDoc([
      { id: "p1", title: "One", linked_backlog: ["1"] },
    ]);
    expect(
      findBacklogReferences("1", { items: [], initiatives: doc }).hasReferences,
    ).toBe(true);
  });
});

describe("buildDeleteConfirmMessage", () => {
  test("plain confirm when nothing references the id", () => {
    const refs = findBacklogReferences("45", { items: [mkItem({ id: "1" })] });
    const msg = buildDeleteConfirmMessage("45", refs);
    expect(msg).toContain("45");
    // No orphan warning when there are no references.
    expect(msg.toLowerCase()).not.toContain("orphan");
    expect(msg.toLowerCase()).not.toContain("depend");
  });

  test("warns + names dependent item ids when other items depend on it", () => {
    const refs = findBacklogReferences("1", {
      items: [
        mkItem({ id: "2", dependencies: ["1"] }),
        mkItem({ id: "7", dependencies: ["1"] }),
      ],
    });
    const msg = buildDeleteConfirmMessage("1", refs);
    expect(msg).toContain("2");
    expect(msg).toContain("7");
    // Surfaces that the deletion orphans references.
    expect(msg.toLowerCase()).toContain("depend");
  });

  test("warns + names project slugs when a project links the id", () => {
    const doc = mkInitiativesDoc([
      { id: "p1", title: "One", linked_backlog: ["1"] },
    ]);
    const refs = findBacklogReferences("1", { items: [], initiatives: doc });
    const msg = buildDeleteConfirmMessage("1", refs);
    expect(msg).toContain("p1");
    expect(msg.toLowerCase()).toContain("project");
  });

  test("is a plain string with no HTML markup (textContent-safe)", () => {
    const refs = findBacklogReferences("1", {
      items: [mkItem({ id: "2", dependencies: ["1"] })],
    });
    const msg = buildDeleteConfirmMessage("1", refs);
    expect(msg).not.toContain("<");
    expect(msg).not.toContain(">");
  });
});
