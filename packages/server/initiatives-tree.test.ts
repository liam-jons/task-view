/**
 * initiatives-tree.ts acceptance (ID-148.10, INV-13).
 *
 * Fixture shape mirrors the real `initiatives.json` topology (TECH §1.4):
 * a top-level initiative "1" with a direct project; a top-level initiative
 * "4" with an initiative-level linked_tasks tolerance AND a nested
 * sub-initiative "4.2" carrying its own project AND a further-nested
 * sub-sub-initiative "4.2.1".
 */
import { describe, expect, test } from "bun:test";
import {
  resolveInitiativeNode,
  allInitiativePaths,
  findProjectBySlug,
  allProjectSlugs,
  insertProjectAt,
  removeProjectBySlug,
  resolveRecordId,
  type TreeDoc,
} from "./initiatives-tree";

function fixtureDoc(): TreeDoc {
  return {
    document_name: "Canonical Platform - Initiatives",
    initiatives: [
      {
        id: "1",
        title: "Foundation",
        projects: [{ id: "foundation-project", title: "Foundation project" }],
        "sub-initiatives": [],
      },
      {
        id: "4",
        title: "SDLC workflow orchestration",
        linked_tasks: ["99"],
        projects: [{ id: "top-level-project", title: "Top level" }],
        "sub-initiatives": [
          {
            id: "2",
            title: "Sub two",
            projects: [
              { id: "sub-project-a", title: "Sub project A" },
              { id: "sub-project-b", title: "Sub project B" },
            ],
            "sub-initiatives": [
              {
                id: "1",
                title: "Deep sub",
                projects: [{ id: "deep-project", title: "Deep project" }],
                "sub-initiatives": [],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("resolveInitiativeNode", () => {
  test("resolves a top-level initiative by bare id", () => {
    const node = resolveInitiativeNode(fixtureDoc(), "1");
    expect(node?.id).toBe("1");
    expect(node?.title).toBe("Foundation");
  });

  test("resolves a one-level-deep sub-initiative by dotted path", () => {
    const node = resolveInitiativeNode(fixtureDoc(), "4.2");
    expect(node?.title).toBe("Sub two");
  });

  test("resolves a two-level-deep sub-sub-initiative by dotted path", () => {
    const node = resolveInitiativeNode(fixtureDoc(), "4.2.1");
    expect(node?.title).toBe("Deep sub");
  });

  test("returns null for a missing top-level id", () => {
    expect(resolveInitiativeNode(fixtureDoc(), "999")).toBeNull();
  });

  test("returns null for a missing sub-initiative segment", () => {
    expect(resolveInitiativeNode(fixtureDoc(), "4.99")).toBeNull();
  });

  test("returns null for a path that runs past a leaf with no sub-initiatives", () => {
    expect(resolveInitiativeNode(fixtureDoc(), "1.1")).toBeNull();
  });

  test("returns null for an empty path", () => {
    expect(resolveInitiativeNode(fixtureDoc(), "")).toBeNull();
  });
});

describe("allInitiativePaths", () => {
  test("enumerates every node depth-first, top-level first", () => {
    expect(allInitiativePaths(fixtureDoc())).toEqual([
      "1",
      "4",
      "4.2",
      "4.2.1",
    ]);
  });

  test("empty document yields an empty list", () => {
    expect(allInitiativePaths({ initiatives: [] })).toEqual([]);
  });
});

describe("findProjectBySlug", () => {
  test("finds a project directly under a top-level initiative", () => {
    const located = findProjectBySlug(fixtureDoc(), "foundation-project");
    expect(located?.topLevelInitiativeId).toBe("1");
    expect(located?.project.title).toBe("Foundation project");
  });

  test("finds a project nested two levels deep (initiative -> sub -> sub)", () => {
    const located = findProjectBySlug(fixtureDoc(), "deep-project");
    expect(located?.topLevelInitiativeId).toBe("4");
    expect(located?.project.title).toBe("Deep project");
  });

  test("finds a project among siblings in the same node", () => {
    const located = findProjectBySlug(fixtureDoc(), "sub-project-b");
    expect(located?.project.id).toBe("sub-project-b");
  });

  test("returns null for an unknown slug", () => {
    expect(findProjectBySlug(fixtureDoc(), "does-not-exist")).toBeNull();
  });
});

describe("allProjectSlugs", () => {
  test("flattens every project slug tree-wide", () => {
    const slugs = allProjectSlugs(fixtureDoc()).sort();
    expect(slugs).toEqual(
      [
        "deep-project",
        "foundation-project",
        "sub-project-a",
        "sub-project-b",
        "top-level-project",
      ].sort(),
    );
  });
});

describe("insertProjectAt", () => {
  test("inserts into a top-level initiative's projects[]", () => {
    const doc = fixtureDoc();
    const result = insertProjectAt(doc, "1", { id: "new-project", title: "New" });
    expect(result.ok).toBe(true);
    expect(allProjectSlugs(doc)).toContain("new-project");
    expect(findProjectBySlug(doc, "new-project")?.topLevelInitiativeId).toBe("1");
  });

  test("inserts into a deeply-nested sub-initiative's projects[]", () => {
    const doc = fixtureDoc();
    const result = insertProjectAt(doc, "4.2.1", { id: "deeper-new", title: "Deeper" });
    expect(result.ok).toBe(true);
    expect(findProjectBySlug(doc, "deeper-new")?.topLevelInitiativeId).toBe("4");
  });

  test("fails with a detail message for an unresolvable path", () => {
    const doc = fixtureDoc();
    const result = insertProjectAt(doc, "999", { id: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("999");
  });
});

describe("removeProjectBySlug", () => {
  test("removes a project and reports its top-level initiative id", () => {
    const doc = fixtureDoc();
    const result = removeProjectBySlug(doc, "sub-project-a");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.topLevelInitiativeId).toBe("4");
    expect(allProjectSlugs(doc)).not.toContain("sub-project-a");
    // sibling untouched
    expect(allProjectSlugs(doc)).toContain("sub-project-b");
  });

  test("removes a deeply-nested project", () => {
    const doc = fixtureDoc();
    const result = removeProjectBySlug(doc, "deep-project");
    expect(result.ok).toBe(true);
    expect(allProjectSlugs(doc)).not.toContain("deep-project");
  });

  test("returns not-ok for an unknown slug", () => {
    const result = removeProjectBySlug(fixtureDoc(), "does-not-exist");
    expect(result.ok).toBe(false);
  });
});

describe("resolveRecordId — project-vs-initiative disambiguation", () => {
  test("a bare-digit id resolves as an initiative path", () => {
    const resolved = resolveRecordId(fixtureDoc(), "4");
    expect(resolved.kind).toBe("initiative");
    if (resolved.kind === "initiative") expect(resolved.node.title).toBe("SDLC workflow orchestration");
  });

  test("a dotted bare-digit path resolves as a sub-initiative", () => {
    const resolved = resolveRecordId(fixtureDoc(), "4.2");
    expect(resolved.kind).toBe("initiative");
  });

  test("a kebab-slug resolves as a project", () => {
    const resolved = resolveRecordId(fixtureDoc(), "foundation-project");
    expect(resolved.kind).toBe("project");
    if (resolved.kind === "project") {
      expect(resolved.location.topLevelInitiativeId).toBe("1");
    }
  });

  test("an unknown id resolves as not-found", () => {
    expect(resolveRecordId(fixtureDoc(), "nope").kind).toBe("not-found");
  });
});
