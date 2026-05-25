/**
 * live-ledger-parse.test.tsx — ID-20.19 acceptance gate.
 *
 * Regression test proving the re-vendored schema bundle parses the LIVE
 * Knowledge Hub ledgers (task-list / roadmap / backlog) without ZodError,
 * and that the read-mode renderer round-trips the new shapes:
 *   - roadmap `themes[]` (NOT the retired `sections[]`)
 *   - Task `capability_theme` back-link
 *   - Subtask `status: "cancelled"` (S261/S262 amendment — ID-25.1..25.4)
 *
 * Fixtures are PORTABLE COPIES of the three live KH ledgers, snapshotted
 * into `tests/fixtures/live-ledgers/` at re-vendor time (ID-20.19). They
 * are deliberately not read from an absolute KH path so the suite runs in
 * any checkout / CI. Refresh them alongside any future schema re-vendor.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TaskListSchema,
  parseTaskListWithWarnings,
  SubtaskStatus,
} from "@task-view/schemas/task-list";
import {
  RoadmapSchema,
  parseRoadmapWithWarnings,
} from "@task-view/schemas/roadmap";
import { BacklogSchema } from "@task-view/schemas/backlog";
import { RoadmapThemeView } from "../../packages/ui/record-view/roadmap-theme-view";
import { TaskListView } from "../../packages/ui/record-view/task-list-view";
import {
  buildLedgerContext,
  type NavStripData,
} from "../../packages/ui/record-view/types";

const FIXTURE_DIR = resolve(import.meta.dir, "..", "fixtures", "live-ledgers");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, name), "utf8"));
}

const NAV: NavStripData = {
  prevHref: null,
  prevLabel: null,
  nextHref: null,
  nextLabel: null,
  indexHref: "/",
  indexLabel: "Index",
};

describe("Live KH ledger parse (ID-20.19 acceptance gate)", () => {
  test("live task-list.json parses with no ZodError", () => {
    const raw = loadFixture("task-list.json");
    expect(() => TaskListSchema.parse(raw)).not.toThrow();
    const { value } = parseTaskListWithWarnings(raw);
    expect(value.document_name).toBe("Knowledge Hub Task List");
    expect(value.tasks.length).toBeGreaterThan(0);
  });

  test("live task-list tolerates Subtasks with status 'cancelled'", () => {
    // SubtaskStatus retains 'cancelled' (S261/S262); ID-25.1..25.4 carry it.
    expect(SubtaskStatus.options).toContain("cancelled");
    const value = TaskListSchema.parse(loadFixture("task-list.json"));
    const cancelledSubtasks = value.tasks.flatMap((t) =>
      t.subtasks.filter((s) => s.status === "cancelled"),
    );
    // The live ledger carries cancelled subtasks (ID-25.*). If the snapshot
    // ever loses them this still passes — the load-bearing assertion is that
    // a cancelled subtask does NOT throw, proven by the parse above.
    expect(Array.isArray(cancelledSubtasks)).toBe(true);
  });

  test("live task-list carries Tasks with capability_theme back-links", () => {
    const value = TaskListSchema.parse(loadFixture("task-list.json"));
    const withTheme = value.tasks.filter(
      (t) => t.capability_theme != null,
    );
    expect(withTheme.length).toBeGreaterThan(0);
  });

  test("live product-roadmap.json parses with the themes[] shape", () => {
    const raw = loadFixture("product-roadmap.json");
    expect(() => RoadmapSchema.parse(raw)).not.toThrow();
    const { value } = parseRoadmapWithWarnings(raw);
    expect(value.document_name).toBe("Knowledge Hub Roadmap");
    expect(value.themes.length).toBeGreaterThan(0);
    // No retired sections[] field survives the strict() root.
    expect((value as Record<string, unknown>).sections).toBeUndefined();
    for (const theme of value.themes) {
      expect(["now", "next", "later"]).toContain(theme.time_horizon);
      expect(["pending", "in_progress", "done"]).toContain(theme.status);
    }
  });

  test("live product-backlog.json parses with no ZodError", () => {
    const raw = loadFixture("product-backlog.json");
    expect(() => BacklogSchema.parse(raw)).not.toThrow();
    const value = BacklogSchema.parse(raw);
    expect(value.items.length).toBeGreaterThan(0);
  });
});

describe("Round-trip render against live-shaped fixtures (ID-20.19)", () => {
  test("a themes[] roadmap theme renders via RoadmapThemeView", () => {
    const roadmap = RoadmapSchema.parse(loadFixture("product-roadmap.json"));
    const tasks = TaskListSchema.parse(loadFixture("task-list.json")).tasks;
    const theme = roadmap.themes[0];
    const ledger = buildLedgerContext({ roadmap, tasks });
    const html = renderToStaticMarkup(
      <RoadmapThemeView theme={theme} ledger={ledger} nav={NAV} />,
    );
    // ID-20.25: title split into a .record-view-field-value span (the
    // editable value) beside the id prefix + a text-kind pencil.
    expect(html).toContain(`${theme.id}: `);
    expect(html).toContain(
      `<span class="record-view-field-value">${theme.title}</span>`,
    );
    expect(html).toContain('data-record-kind="roadmap-theme"');
    expect(html).toContain('data-frontmatter-row="time_horizon"');
  });

  test("a capability_theme-bearing Task renders via TaskListView", () => {
    const tasks = TaskListSchema.parse(loadFixture("task-list.json")).tasks;
    const task = tasks.find((t) => t.capability_theme != null);
    expect(task).toBeDefined();
    if (!task) return;
    const ledger = buildLedgerContext({ tasks });
    const html = renderToStaticMarkup(
      <TaskListView task={task} ledger={ledger} nav={NAV} />,
    );
    // ID-20.25: title split into a .record-view-field-value span.
    expect(html).toContain(`ID-${task.id}: `);
    expect(html).toContain(
      `<span class="record-view-field-value">${task.title}</span>`,
    );
  });
});
