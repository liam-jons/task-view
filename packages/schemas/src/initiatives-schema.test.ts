/**
 * initiatives-schema.ts acceptance (ID-148.10, TECH §3.1(a), INV-2/INV-12(a)).
 *
 * Covers what the smoke test in schemas.test.ts does not: recursive
 * sub-initiatives, lenient-read/strict-write status behaviour, the
 * initiative-4 off-project-link tolerance, and the INITIATIVES_BUDGETS /
 * gitignored-substrate_doc soft warnings.
 */
import { describe, expect, test } from "bun:test";
import {
  InitiativesSchema,
  InitiativeSchema,
  SubInitiativeSchema,
  ProjectSchema,
  INITIATIVE_STATUSES,
  PROJECT_STATUSES,
  INITIATIVES_BUDGETS,
  parseInitiativesWithWarnings,
} from "./initiatives-schema";

function project(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "sample-project",
    title: "Sample project",
    summary: "One-sentence summary.",
    description: "Fuller description.",
    substrate_doc: "",
    status: "idea",
    blocked_by: [],
    blocking: [],
    linked_tasks: [],
    linked_backlog: [],
    originating_session: [],
    ...overrides,
  };
}

function initiative(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "1",
    title: "Sample initiative",
    description: "Initiative description.",
    status: "active",
    projects: [],
    originating_session: [],
    "sub-initiatives": [],
    ...overrides,
  };
}

describe("InitiativesSchema — root document", () => {
  test("parses a minimal document with no initiatives", () => {
    const doc = {
      document_name: "Canonical Platform - Initiatives",
      document_purpose: "purpose",
      date: "2026-07-15",
      status: "active",
      related_documents: [],
      last_updated: "kh-main-S473",
      initiatives: [],
    };
    const result = InitiativesSchema.safeParse(doc);
    expect(result.success).toBe(true);
  });

  test("rejects a wrong document_name (literal discriminator)", () => {
    const result = InitiativesSchema.safeParse({
      document_name: "Knowledge Hub Roadmap",
      document_purpose: "purpose",
      date: "2026-07-15",
      status: "active",
      related_documents: [],
      last_updated: "kh-main-S473",
      initiatives: [],
    });
    expect(result.success).toBe(false);
  });

  test("root is .strict() — rejects an unknown top-level field", () => {
    const result = InitiativesSchema.safeParse({
      document_name: "Canonical Platform - Initiatives",
      document_purpose: "purpose",
      date: "2026-07-15",
      status: "active",
      related_documents: [],
      last_updated: "kh-main-S473",
      initiatives: [],
      themes: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("Recursive sub-initiatives (INV-2)", () => {
  test("parses second-level nesting under an initiative", () => {
    const doc = {
      document_name: "Canonical Platform - Initiatives",
      document_purpose: "purpose",
      date: "2026-07-15",
      status: "active",
      related_documents: [],
      last_updated: "kh-main-S473",
      initiatives: [
        initiative({
          id: "4",
          "sub-initiatives": [
            {
              id: "1",
              title: "Sub one",
              description: "Sub description.",
              status: "planned",
              projects: [project({ id: "sub-project" })],
              originating_session: [],
              "sub-initiatives": [
                {
                  id: "1",
                  title: "Sub-sub one",
                  description: "Deep nesting.",
                  status: "proposed",
                  projects: [],
                  originating_session: [],
                  "sub-initiatives": [],
                },
              ],
            },
          ],
        }),
      ],
    };
    const result = InitiativesSchema.safeParse(doc);
    expect(result.success).toBe(true);
    if (result.success) {
      const sub = result.data.initiatives[0]["sub-initiatives"][0];
      expect(sub.projects[0].id).toBe("sub-project");
      expect(sub["sub-initiatives"][0].id).toBe("1");
    }
  });

  test("sub-initiative substrate_doc is OPTIONAL (absent parses)", () => {
    const result = SubInitiativeSchema.safeParse({
      id: "2",
      title: "No substrate doc",
      description: "desc",
      status: "planned",
      projects: [],
      originating_session: [],
      "sub-initiatives": [],
    });
    expect(result.success).toBe(true);
  });
});

describe("Lenient read / strict write on status (INV-2/INV-3)", () => {
  test("an out-of-enum initiative status still PARSES (lenient read)", () => {
    const result = InitiativeSchema.safeParse(
      initiative({ status: "some-dirty-legacy-value" }),
    );
    expect(result.success).toBe(true);
  });

  test("an out-of-enum project status still PARSES (lenient read)", () => {
    const result = ProjectSchema.safeParse(project({ status: "totally-unknown" }));
    expect(result.success).toBe(true);
  });

  test("INITIATIVE_STATUSES carries the 5 canonical values", () => {
    expect(INITIATIVE_STATUSES).toEqual([
      "proposed",
      "planned",
      "active",
      "completed",
      "cancelled",
    ]);
  });

  test("PROJECT_STATUSES carries the 11 canonical values", () => {
    expect(PROJECT_STATUSES).toEqual([
      "idea",
      "proposal",
      "backlog",
      "discovery",
      "accepted",
      "ready",
      "paused",
      "in-progress",
      "maintenance",
      "completed",
      "cancelled",
    ]);
  });
});

describe("Initiative-4 off-project-link tolerance (audit A3 / INV-2)", () => {
  test("linked_tasks/linked_backlog at the INITIATIVE level are optional and accepted", () => {
    const result = InitiativeSchema.safeParse(
      initiative({ linked_tasks: ["99"], linked_backlog: ["12"] }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.linked_tasks).toEqual(["99"]);
    }
  });

  test("linked_tasks/linked_backlog absent at the initiative level still parses", () => {
    const result = InitiativeSchema.safeParse(initiative());
    expect(result.success).toBe(true);
  });
});

describe("parseInitiativesWithWarnings (D2 + INITIATIVES_BUDGETS soft warnings)", () => {
  function doc(initiatives: unknown[]) {
    return {
      document_name: "Canonical Platform - Initiatives",
      document_purpose: "purpose",
      date: "2026-07-15",
      status: "active",
      related_documents: [],
      last_updated: "kh-main-S473",
      initiatives,
    };
  }

  test("within-budget document emits zero warnings", () => {
    const { warnings } = parseInitiativesWithWarnings(doc([initiative()]));
    expect(warnings).toHaveLength(0);
  });

  test("over-budget initiative description emits a soft warning, still parses", () => {
    const { value, warnings } = parseInitiativesWithWarnings(
      doc([
        initiative({
          description: "d".repeat(INITIATIVES_BUDGETS.initiative.description + 1),
        }),
      ]),
    );
    expect(value.initiatives).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain(
      `budget ${INITIATIVES_BUDGETS.initiative.description}`,
    );
  });

  test("over-budget project summary emits a soft warning scoped by path", () => {
    const { warnings } = parseInitiativesWithWarnings(
      doc([
        initiative({
          projects: [
            project({
              id: "over-summary",
              summary: "s".repeat(INITIATIVES_BUDGETS.project.summary + 1),
            }),
          ],
        }),
      ]),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].path).toContain("project:over-summary");
  });

  test("a substrate_doc pointing into a gitignored dir emits a D2 warning", () => {
    const { warnings } = parseInitiativesWithWarnings(
      doc([initiative({ substrate_doc: ".user-scratch/notes.md" })]),
    );
    expect(warnings.some((w) => w.message.includes("git-ignored"))).toBe(true);
  });

  test("a substrate_doc containing '.lavish' as a SEGMENT (not substring) is flagged", () => {
    const { warnings } = parseInitiativesWithWarnings(
      doc([initiative({ substrate_doc: "docs/.lavish/report.md" })]),
    );
    expect(warnings.some((w) => w.message.includes("git-ignored"))).toBe(true);
  });

  test("a substrate_doc merely CONTAINING '.lavish' as a substring is NOT flagged", () => {
    const { warnings } = parseInitiativesWithWarnings(
      doc([initiative({ substrate_doc: "docs/my.lavish-report/notes.md" })]),
    );
    expect(warnings.some((w) => w.message.includes("git-ignored"))).toBe(false);
  });

  test("hard-invalid shape still throws ZodError (not silently swallowed)", () => {
    expect(() =>
      parseInitiativesWithWarnings({ document_name: "wrong" }),
    ).toThrow();
  });
});
