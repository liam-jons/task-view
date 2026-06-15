/**
 * anchors.test.ts — verifies in-page anchor + cross-record href builders
 * (PRODUCT inv 12, 13, 22, TECH §4.4).
 */
import { describe, expect, test } from "bun:test";
import {
  activeRecordHref,
  crossLedgerRecordHref,
  indexHrefWithAnchor,
  indexRowAnchorId,
  recordRouteHref,
  subtaskAnchorId,
  subtaskDepLabel,
  subtaskHref,
  taskDepLabel,
} from "./anchors";

describe("Sibling-Subtask anchors (PRODUCT inv 13, TECH §4.4)", () => {
  test("subtaskAnchorId returns deterministic `subtask-{id}` form", () => {
    expect(subtaskAnchorId("1")).toBe("subtask-1");
    expect(subtaskAnchorId("13")).toBe("subtask-13");
  });

  test("subtaskHref returns `#subtask-{id}`", () => {
    expect(subtaskHref("3")).toBe("#subtask-3");
  });

  test("subtaskDepLabel returns `ID-{taskId}.{subtaskId}`", () => {
    expect(subtaskDepLabel("20", "9")).toBe("ID-20.9");
    expect(subtaskDepLabel("100", "1")).toBe("ID-100.1");
  });
});

describe("Cross-record hrefs (PRODUCT inv 12, 22)", () => {
  test("taskDepLabel returns `ID-{id}`", () => {
    expect(taskDepLabel("20")).toBe("ID-20");
  });

  test("recordRouteHref returns the live `/?record=<id>` server route", () => {
    // One builder serves all three record kinds — the server routes on
    // the bare id, not a per-kind `.md` filename.
    expect(recordRouteHref("20")).toBe("/?record=20");
    expect(recordRouteHref("42")).toBe("/?record=42");
    expect(recordRouteHref("45")).toBe("/?record=45");
  });

  test("recordRouteHref URL-encodes the record id", () => {
    expect(recordRouteHref("a b")).toBe("/?record=a%20b");
  });
});

describe("crossLedgerRecordHref ({20.29} cross-ledger nav, SPEC §5 slice 2)", () => {
  test("builds /?ledger=<slug>&record=<id> for each sibling slug", () => {
    expect(crossLedgerRecordHref("task-list", "6")).toBe(
      "/?ledger=task-list&record=6",
    );
    expect(crossLedgerRecordHref("roadmap", "10")).toBe(
      "/?ledger=roadmap&record=10",
    );
    expect(crossLedgerRecordHref("backlog", "45")).toBe(
      "/?ledger=backlog&record=45",
    );
  });

  test("URL-encodes the record id but keeps the slug literal", () => {
    expect(crossLedgerRecordHref("task-list", "a b")).toBe(
      "/?ledger=task-list&record=a%20b",
    );
  });

  test("recordRouteHref stays the intra-ledger form (no ledger param)", () => {
    // Regression guard: the cross-ledger builder must not change the
    // bare intra-ledger href contract.
    expect(recordRouteHref("6")).toBe("/?record=6");
  });
});

describe("activeRecordHref — preserve the active sibling on intra-ledger links", () => {
  test("with an active slug → slug-qualified /?ledger=<slug>&record=<id>", () => {
    // Regression: on a switched-to sibling page, record/index/nav links must
    // carry ?ledger=<slug> so they resolve within that sibling instead of
    // falling back to the launched ledger.
    expect(activeRecordHref("284", "backlog")).toBe(
      "/?ledger=backlog&record=284",
    );
    expect(activeRecordHref("10", "roadmap")).toBe("/?ledger=roadmap&record=10");
  });

  test("with no active slug (null / undefined) → bare back-compat form", () => {
    // Launched ledger (no ?ledger= in the URL): links stay byte-for-byte the
    // bare intra-ledger form.
    expect(activeRecordHref("6", null)).toBe("/?record=6");
    expect(activeRecordHref("6")).toBe("/?record=6");
  });

  test("URL-encodes the record id, keeps the slug literal", () => {
    expect(activeRecordHref("a b", "task-list")).toBe(
      "/?ledger=task-list&record=a%20b",
    );
  });
});

describe("Index row anchors — return to page point on 'Back to…'", () => {
  test("indexRowAnchorId returns `record-{id}` (the index <tr> id AND the back fragment)", () => {
    expect(indexRowAnchorId("20")).toBe("record-20");
    expect(indexRowAnchorId("ID-30")).toBe("record-ID-30");
  });

  test("indexHrefWithAnchor returns `/#record-{id}` so Back lands on the viewed row", () => {
    expect(indexHrefWithAnchor("20")).toBe("/#record-20");
    expect(indexHrefWithAnchor("42")).toBe("/#record-42");
  });

  test("indexHrefWithAnchor folds an optional query string before the fragment", () => {
    // So a future filtered/sorted index can return to the same filtered view
    // scrolled to the row (Task 3/4). Empty query → bare path.
    expect(indexHrefWithAnchor("20", "status=ready")).toBe(
      "/?status=ready#record-20",
    );
    expect(indexHrefWithAnchor("20", "")).toBe("/#record-20");
  });
});
