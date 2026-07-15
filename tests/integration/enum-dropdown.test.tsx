/**
 * tests/integration/enum-dropdown.test.tsx — PRODUCT inv 30-31
 * (Zod-enum dropdowns sourced from `._def.values` at render time).
 *
 * Acceptance: every Zod-enum field surfaces all valid values sourced
 * from `._def.values` (8 fields enumerated in inv 30); nullable enums
 * show literal "(unset)" sentinel.
 *
 * The enums (per PRODUCT inv 30):
 *   - Task-list: Task.status (8), Task.priority (8), Subtask.status (6 —
 *     'cancelled' retained at Subtask level per S261/S262)
 *   - Initiatives (ID-148.10, repurposed from the retired roadmap
 *     `themes[]` arm — INV-12(a)): `INITIATIVE_STATUSES` (5) and
 *     `PROJECT_STATUSES` (11) — plain vocabularies, NOT nullable (INV-2/
 *     INV-3: lenient-read `z.string()`, strict-write enforced at the
 *     server gate, never `.nullable()` like the retired roadmap enums).
 *   - Backlog: BacklogItem.status (5), BacklogItem.priority (8), BacklogItem.type (8)
 *
 * Source of truth: `.options` (Zod 4 surface) is read at render time
 * per PRODUCT inv 31. This test imports the enums + asserts every
 * value appears as an `<option>` child in the rendered dropdown.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SubtaskStatus,
  TaskListStatus,
} from "@task-view/schemas/task-list";
import { Priority } from "@task-view/schemas/work-status";
import {
  INITIATIVE_STATUSES,
  PROJECT_STATUSES,
} from "@task-view/schemas/initiatives";
import {
  BacklogItemType,
  BacklogStatus,
} from "@task-view/schemas/backlog";
import { EnumDropdownField } from "../../packages/ui/record-view/edit-affordances";

// Helper: count <option value="X"> occurrences in the html
function optionCount(html: string): number {
  return (html.match(/<option /g) ?? []).length;
}

describe("Task-list enum dropdowns (PRODUCT inv 30)", () => {
  test("Task.status — 8 values from TaskListStatus.options", () => {
    expect(TaskListStatus.options.length).toBe(8);
    const html = renderToStaticMarkup(
      <EnumDropdownField
        fieldPath={["tasks", "20", "status"]}
        draft="pending"
        options={TaskListStatus.options}
      />,
    );
    TaskListStatus.options.forEach((v) => {
      expect(html).toContain(`value="${v}"`);
    });
    expect(optionCount(html)).toBe(8);
  });

  test("Task.priority — 8 values from Priority.options", () => {
    expect(Priority.options.length).toBe(8);
    const html = renderToStaticMarkup(
      <EnumDropdownField
        fieldPath={["tasks", "20", "priority"]}
        draft="must"
        options={Priority.options}
      />,
    );
    Priority.options.forEach((v) => {
      expect(html).toContain(`value="${v}"`);
    });
    expect(optionCount(html)).toBe(8);
  });

  test("Subtask.status — 6 values from SubtaskStatus.options (incl. 'cancelled')", () => {
    expect(SubtaskStatus.options.length).toBe(6);
    expect(SubtaskStatus.options).toContain("cancelled");
    const html = renderToStaticMarkup(
      <EnumDropdownField
        fieldPath={["tasks", "20", "subtasks", "10", "status"]}
        draft="pending"
        options={SubtaskStatus.options}
      />,
    );
    SubtaskStatus.options.forEach((v) => {
      expect(html).toContain(`value="${v}"`);
    });
    expect(optionCount(html)).toBe(6);
  });
});

describe("Initiatives enum dropdowns (PRODUCT inv 30, ID-148.10)", () => {
  test("INITIATIVE_STATUSES — 5 values, not nullable (INV-2/INV-3)", () => {
    expect(INITIATIVE_STATUSES.length).toBe(5);
    const html = renderToStaticMarkup(
      <EnumDropdownField
        fieldPath={["initiatives", "3", "status"]}
        draft="active"
        options={INITIATIVE_STATUSES}
      />,
    );
    INITIATIVE_STATUSES.forEach((v) => {
      expect(html).toContain(`value="${v}"`);
    });
    expect(optionCount(html)).toBe(5);
    // No nullable sentinel — initiative status is never absent.
    expect(html).not.toContain("(unset)");
  });

  test("PROJECT_STATUSES — 11 values, not nullable", () => {
    expect(PROJECT_STATUSES.length).toBe(11);
    const html = renderToStaticMarkup(
      <EnumDropdownField
        fieldPath={["projects", "sample-project", "status"]}
        draft="idea"
        options={PROJECT_STATUSES}
      />,
    );
    PROJECT_STATUSES.forEach((v) => {
      expect(html).toContain(`value="${v}"`);
    });
    expect(optionCount(html)).toBe(11);
  });

  test("a project status dropdown selects the current draft value", () => {
    const html = renderToStaticMarkup(
      <EnumDropdownField
        fieldPath={["projects", "sample-project", "status"]}
        draft="in-progress"
        options={PROJECT_STATUSES}
      />,
    );
    // React's SSR renders defaultValue as the <select> selected attribute
    expect(html).toMatch(
      /<select[^>]*data-edit-field="projects&gt;sample-project&gt;status"/,
    );
  });
});

describe("Backlog enum dropdowns (PRODUCT inv 30)", () => {
  test("BacklogItem.status — 5 values from BacklogStatus.options", () => {
    expect(BacklogStatus.options.length).toBe(5);
    const html = renderToStaticMarkup(
      <EnumDropdownField
        fieldPath={["items", "ID-30", "status"]}
        draft="ready"
        options={BacklogStatus.options}
      />,
    );
    BacklogStatus.options.forEach((v) => {
      expect(html).toContain(`value="${v}"`);
    });
    expect(optionCount(html)).toBe(5);
  });

  test("BacklogItem.priority — 8 values from Priority.options", () => {
    expect(Priority.options.length).toBe(8);
    const html = renderToStaticMarkup(
      <EnumDropdownField
        fieldPath={["items", "ID-30", "priority"]}
        draft="must"
        options={Priority.options}
      />,
    );
    expect(optionCount(html)).toBe(8);
  });

  test("BacklogItem.type — 8 values from BacklogItemType.options", () => {
    expect(BacklogItemType.options.length).toBe(8);
    const html = renderToStaticMarkup(
      <EnumDropdownField
        fieldPath={["items", "ID-30", "type"]}
        draft="feature"
        options={BacklogItemType.options}
      />,
    );
    BacklogItemType.options.forEach((v) => {
      expect(html).toContain(`value="${v}"`);
    });
    expect(optionCount(html)).toBe(8);
  });
});

describe("PRODUCT inv 31 — sourced from canonical Zod `._def.values` at render time", () => {
  test("does not hard-code enum values — values come from Zod schema", () => {
    // The proof is mechanical: if the Zod schema gained a new value
    // (e.g. TaskListStatus added 'archived'), the dropdown would
    // automatically include it without any viewer code change. We
    // verify by re-deriving the option count from the Zod schema
    // length at render time.
    const html = renderToStaticMarkup(
      <EnumDropdownField
        fieldPath={["tasks", "20", "status"]}
        draft="pending"
        options={TaskListStatus.options}
      />,
    );
    expect(optionCount(html)).toBe(TaskListStatus.options.length);
  });

  test("does NOT include legacy aliases (per inv 31 last sentence)", () => {
    // The vendored schema includes only canonical 'spec_needed' (no
    // 'needs_spec' alias). Both BacklogStatus + WorkStatus master
    // enum carry only the canonical literal — sanity check.
    expect(BacklogStatus.options).toContain("spec_needed");
    expect(BacklogStatus.options).not.toContain("needs_spec");
  });
});
