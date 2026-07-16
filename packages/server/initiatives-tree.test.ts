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
  insertInitiativeAt,
  siblingInitiativeIds,
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

// ID-156.8: "parent-or-root" initiative/sub-initiative CREATE — a new
// top-level initiative (parentPath absent) or a new sub-initiative under an
// existing path (INV-13's second addressable node shape, previously
// create-only via `insertProjectAt`).
describe("insertInitiativeAt", () => {
  test("inserts a new top-level initiative when parentPath is absent", () => {
    const doc = fixtureDoc();
    const result = insertInitiativeAt(doc, undefined, {
      id: "6",
      title: "New top-level initiative",
    });
    expect(result.ok).toBe(true);
    expect(allInitiativePaths(doc)).toContain("6");
  });

  test("inserts a new top-level initiative when parentPath is the empty string", () => {
    const doc = fixtureDoc();
    const result = insertInitiativeAt(doc, "", {
      id: "7",
      title: "Also top-level",
    });
    expect(result.ok).toBe(true);
    expect(allInitiativePaths(doc)).toContain("7");
  });

  test("inserts a new sub-initiative under an existing top-level path", () => {
    const doc = fixtureDoc();
    const result = insertInitiativeAt(doc, "1", {
      id: "1",
      title: "New sub under 1",
    });
    expect(result.ok).toBe(true);
    expect(allInitiativePaths(doc)).toContain("1.1");
  });

  test("inserts a new sub-sub-initiative under an existing nested path", () => {
    const doc = fixtureDoc();
    const result = insertInitiativeAt(doc, "4.2", {
      id: "9",
      title: "New sub-sub under 4.2",
    });
    expect(result.ok).toBe(true);
    expect(allInitiativePaths(doc)).toContain("4.2.9");
    // sibling untouched
    expect(allInitiativePaths(doc)).toContain("4.2.1");
  });

  test("fails with a detail message for an unresolvable parentPath", () => {
    const doc = fixtureDoc();
    const result = insertInitiativeAt(doc, "999", { id: "x", title: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("999");
  });

  test("creates the sub-initiatives array when a node structurally lacks one", () => {
    const doc = fixtureDoc();
    // "1.1" has none of its own children — resolveInitiativeNode requires it
    // to already carry a "sub-initiatives" array per the schema, but this
    // guards the defensive branch the way insertProjectAt's projects-array
    // creation is guarded.
    const inserted = insertInitiativeAt(doc, "1", { id: "1", title: "Sub" });
    expect(inserted.ok).toBe(true);
    const deeper = insertInitiativeAt(doc, "1.1", { id: "1", title: "Deeper" });
    expect(deeper.ok).toBe(true);
    expect(allInitiativePaths(doc)).toContain("1.1.1");
  });
});

describe("siblingInitiativeIds", () => {
  test("returns top-level initiative ids when parentPath is absent", () => {
    expect(siblingInitiativeIds(fixtureDoc(), undefined).sort()).toEqual(
      ["1", "4"].sort(),
    );
  });

  test("returns top-level initiative ids when parentPath is the empty string", () => {
    expect(siblingInitiativeIds(fixtureDoc(), "").sort()).toEqual(
      ["1", "4"].sort(),
    );
  });

  test("returns the resolved parent's existing sub-initiative ids", () => {
    expect(siblingInitiativeIds(fixtureDoc(), "4")).toEqual(["2"]);
  });

  test("returns an empty array for a childless node", () => {
    expect(siblingInitiativeIds(fixtureDoc(), "4.2.1")).toEqual([]);
  });

  test("returns an empty array for an unresolvable parentPath (insert step surfaces the error)", () => {
    expect(siblingInitiativeIds(fixtureDoc(), "999")).toEqual([]);
  });

  test("the SAME bare id legitimately recurs at unrelated tree positions", () => {
    // Fixture: top-level "1" and "4.2"'s own child "1" already coexist.
    expect(siblingInitiativeIds(fixtureDoc(), undefined)).toContain("1");
    expect(siblingInitiativeIds(fixtureDoc(), "4.2")).toContain("1");
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
