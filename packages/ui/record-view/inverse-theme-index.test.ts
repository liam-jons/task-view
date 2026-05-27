/**
 * inverse-theme-index.test.ts — reverse cross-ledger index ({20.30}, OQ-P1
 * option (a): a fork-only, server-computed inverse index — NO knowledge-hub
 * ledger-contract change).
 *
 * The {20.29} forward edges run Roadmap → Task (`theme.linked_tasks`) and
 * Roadmap → Backlog (`theme.linked_backlog`). Backlog / Task records carry
 * NO roadmap pointer field, so reverse nav (backlog → theme, task → theme)
 * has no field-bearing edge to follow. {20.30} closes this by computing an
 * in-memory inverse index at render-load from the roadmap's forward edges:
 * `themesByLinkedTask` / `themesByLinkedBacklog` map a record id → the ids of
 * the themes that reference it. No persisted field, pure load-time compute.
 *
 * Tested directly against `buildLedgerContext` (the single load-time builder)
 * because the inverse index is part of the `LedgerContext` the views read.
 */
import { describe, expect, test } from "bun:test";
import type { Roadmap } from "@task-view/schemas/roadmap";
import { buildLedgerContext } from "./types";

const mkTheme = (
  id: string,
  linked_tasks: string[],
  linked_backlog: string[],
) => ({
  id,
  title: `Theme ${id}`,
  description: "d",
  time_horizon: "now" as const,
  status: "in_progress" as const,
  linked_tasks,
  linked_backlog,
  session_refs: [],
  commit_refs: [],
  cross_doc_links: [],
  notes: null,
});

const mkRoadmap = (themes: ReturnType<typeof mkTheme>[]): Roadmap =>
  ({
    document_name: "Knowledge Hub Roadmap",
    document_purpose: "p",
    date: "2026-05-27",
    status: "Active",
    forward_looking_only: true,
    related_documents: [],
    last_updated: "fixture",
    themes,
  }) as unknown as Roadmap;

describe("{20.30} inverse theme index (buildLedgerContext)", () => {
  test("maps a task id to the themes whose linked_tasks include it", () => {
    const roadmap = mkRoadmap([
      mkTheme("1", ["15", "29"], []),
      mkTheme("10", ["15"], []),
    ]);
    const ledger = buildLedgerContext({ roadmap });
    // Task 15 appears in BOTH theme 1 and theme 10, in theme order.
    expect(ledger.themesByLinkedTask.get("15")).toEqual(["1", "10"]);
    // Task 29 only in theme 1.
    expect(ledger.themesByLinkedTask.get("29")).toEqual(["1"]);
    // Unreferenced task → undefined.
    expect(ledger.themesByLinkedTask.get("999")).toBeUndefined();
  });

  test("maps a backlog id to the themes whose linked_backlog include it", () => {
    const roadmap = mkRoadmap([
      mkTheme("2", [], ["87", "103"]),
      mkTheme("4", [], ["87", "103"]),
    ]);
    const ledger = buildLedgerContext({ roadmap });
    // Backlog 87 appears in theme 2 AND theme 4 (the key reverse-nav case:
    // backlog carries no forward pointer field).
    expect(ledger.themesByLinkedBacklog.get("87")).toEqual(["2", "4"]);
    expect(ledger.themesByLinkedBacklog.get("103")).toEqual(["2", "4"]);
  });

  test("dedupes a repeated id within a single theme's link array", () => {
    const roadmap = mkRoadmap([mkTheme("1", ["15", "15"], ["40", "40"])]);
    const ledger = buildLedgerContext({ roadmap });
    expect(ledger.themesByLinkedTask.get("15")).toEqual(["1"]);
    expect(ledger.themesByLinkedBacklog.get("40")).toEqual(["1"]);
  });

  test("both reverse maps are empty when no roadmap is threaded in", () => {
    const ledger = buildLedgerContext({ tasks: [], backlogItems: [] });
    expect(ledger.themesByLinkedTask.size).toBe(0);
    expect(ledger.themesByLinkedBacklog.size).toBe(0);
  });
});
