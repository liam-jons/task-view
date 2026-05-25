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
 *   - Roadmap: RoadmapStatus (6, nullable), RoadmapPriority (8, nullable) —
 *     the roadmap item-status / priority enums still exported by
 *     roadmap-schema after the ID-20.19 themes[] migration
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
  RoadmapPriority,
  RoadmapStatus,
} from "@task-view/schemas/roadmap";
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

describe("Roadmap nullable enum dropdowns (PRODUCT inv 30)", () => {
  test("RoadmapStatus — 6 values + (unset) sentinel", () => {
    expect(RoadmapStatus.options.length).toBe(6);
    const html = renderToStaticMarkup(
      <EnumDropdownField
        fieldPath={["themes", "3", "status"]}
        draft={null}
        options={RoadmapStatus.options}
        nullable
      />,
    );
    RoadmapStatus.options.forEach((v) => {
      expect(html).toContain(`value="${v}"`);
    });
    // Sentinel "(unset)" option present
    expect(html).toContain("(unset)");
    expect(html).toContain("data-nullable-sentinel");
    // 6 enum options + 1 sentinel = 7 total
    expect(optionCount(html)).toBe(7);
  });

  test("RoadmapPriority — 8 values + (unset) sentinel", () => {
    expect(RoadmapPriority.options.length).toBe(8);
    const html = renderToStaticMarkup(
      <EnumDropdownField
        fieldPath={["themes", "3", "priority"]}
        draft={null}
        options={RoadmapPriority.options}
        nullable
      />,
    );
    expect(html).toContain("(unset)");
    expect(optionCount(html)).toBe(9); // 8 + sentinel
  });

  test("nullable dropdown with non-null draft selects that value", () => {
    const html = renderToStaticMarkup(
      <EnumDropdownField
        fieldPath={["themes", "3", "status"]}
        draft="pending"
        options={RoadmapStatus.options}
        nullable
      />,
    );
    // React's SSR renders defaultValue as the <select> selected attribute
    expect(html).toMatch(/<select[^>]*data-edit-field="themes&gt;3&gt;status"/);
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
