/**
 * inverse-project-index.test.ts — reverse cross-ledger index ({20.30}, OQ-P1
 * option (a): a fork-only, server-computed inverse index — NO knowledge-hub
 * ledger-contract change). ID-148.10: repurposed from
 * inverse-theme-index.test.ts (roadmap themes -> initiatives projects).
 *
 * The {20.29}-equivalent forward edges run Project → Task
 * (`project.linked_tasks`) and Project → Backlog (`project.linked_backlog`),
 * tree-wide (INV-13 — a project may live at any depth under
 * `initiatives[]`/`sub-initiatives[]`; INV-6 "links are project-only").
 * Backlog / Task records carry NO initiatives pointer field, so reverse nav
 * (backlog → project, task → project) has no field-bearing edge to follow.
 * {20.30} closes this by computing an in-memory inverse index at
 * render-load from every project's forward edges: `projectsByLinkedTask` /
 * `projectsByLinkedBacklog` map a record id → the SLUGS of the projects
 * that reference it. No persisted field, pure load-time compute.
 *
 * Tested directly against `buildLedgerContext` (the single load-time builder)
 * because the inverse index is part of the `LedgerContext` the views read.
 */
import { describe, expect, test } from "bun:test";
import type { InitiativesDocument } from "@task-view/schemas/initiatives";
import { buildLedgerContext } from "./types";

const mkProject = (
  id: string,
  linked_tasks: string[],
  linked_backlog: string[],
) => ({
  id,
  title: `Project ${id}`,
  summary: "s",
  description: "d",
  substrate_doc: "",
  status: "idea" as const,
  blocked_by: [],
  blocking: [],
  linked_tasks,
  linked_backlog,
  originating_session: [],
});

const mkInitiativesDoc = (
  projects: ReturnType<typeof mkProject>[],
): InitiativesDocument =>
  ({
    document_name: "Canonical Platform - Initiatives",
    document_purpose: "p",
    date: "2026-07-15",
    status: "active",
    related_documents: [],
    last_updated: "fixture",
    initiatives: [
      {
        id: "1",
        title: "Initiative 1",
        description: "d",
        status: "active",
        projects,
        originating_session: [],
        "sub-initiatives": [],
      },
    ],
  }) as unknown as InitiativesDocument;

/** Same set of projects, but each nested one level deeper under a
 * sub-initiative — proves the walk is tree-wide (INV-13), not flat. */
const mkNestedInitiativesDoc = (
  projects: ReturnType<typeof mkProject>[],
): InitiativesDocument =>
  ({
    document_name: "Canonical Platform - Initiatives",
    document_purpose: "p",
    date: "2026-07-15",
    status: "active",
    related_documents: [],
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
            projects,
            originating_session: [],
            "sub-initiatives": [],
          },
        ],
      },
    ],
  }) as unknown as InitiativesDocument;

describe("{20.30} inverse project index (buildLedgerContext, ID-148.10)", () => {
  test("maps a task id to the project SLUGS whose linked_tasks include it", () => {
    const initiatives = mkInitiativesDoc([
      mkProject("foundations", ["15", "29"], []),
      mkProject("procurement", ["15"], []),
    ]);
    const ledger = buildLedgerContext({ initiatives });
    // Task 15 appears in BOTH projects, in tree declaration order.
    expect(ledger.projectsByLinkedTask.get("15")).toEqual([
      "foundations",
      "procurement",
    ]);
    // Task 29 only in "foundations".
    expect(ledger.projectsByLinkedTask.get("29")).toEqual(["foundations"]);
    // Unreferenced task → undefined.
    expect(ledger.projectsByLinkedTask.get("999")).toBeUndefined();
  });

  test("maps a backlog id to the project slugs whose linked_backlog include it", () => {
    const initiatives = mkInitiativesDoc([
      mkProject("procurement", [], ["87", "103"]),
      mkProject("ai-eval", [], ["87", "103"]),
    ]);
    const ledger = buildLedgerContext({ initiatives });
    // Backlog 87 appears in BOTH projects (the key reverse-nav case:
    // backlog carries no forward pointer field).
    expect(ledger.projectsByLinkedBacklog.get("87")).toEqual([
      "procurement",
      "ai-eval",
    ]);
    expect(ledger.projectsByLinkedBacklog.get("103")).toEqual([
      "procurement",
      "ai-eval",
    ]);
  });

  test("dedupes a repeated id within a single project's link array", () => {
    const initiatives = mkInitiativesDoc([
      mkProject("p1", ["15", "15"], ["40", "40"]),
    ]);
    const ledger = buildLedgerContext({ initiatives });
    expect(ledger.projectsByLinkedTask.get("15")).toEqual(["p1"]);
    expect(ledger.projectsByLinkedBacklog.get("40")).toEqual(["p1"]);
  });

  test("both reverse maps are empty when no initiatives document is threaded in", () => {
    const ledger = buildLedgerContext({ tasks: [], backlogItems: [] });
    expect(ledger.projectsByLinkedTask.size).toBe(0);
    expect(ledger.projectsByLinkedBacklog.size).toBe(0);
  });

  test("walks NESTED projects (under a sub-initiative) tree-wide, not just direct ones (INV-13)", () => {
    const initiatives = mkNestedInitiativesDoc([
      mkProject("nested-project", ["15"], ["87"]),
    ]);
    const ledger = buildLedgerContext({ initiatives });
    expect(ledger.projectsByLinkedTask.get("15")).toEqual(["nested-project"]);
    expect(ledger.projectsByLinkedBacklog.get("87")).toEqual([
      "nested-project",
    ]);
    expect(ledger.projectIds.has("nested-project")).toBe(true);
    expect(ledger.projectsBySlug.get("nested-project")?.title).toBe(
      "Project nested-project",
    );
  });
});
