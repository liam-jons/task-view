/**
 * edit-dispatch-delete.test.ts — pure DELETE-dispatch helpers
 * (backlog-ui-delete). Mirrors the PATCH pair (`recordPatchPath` /
 * `buildPatchRequest`) verified against the real patch-server contract:
 *   - route:   DELETE /api/ledger/record/:recordId  (id URL-encoded)
 *   - body:    { baseMtime }  where baseMtime is the ISO mtime STRING
 *              the server `Date.parse`s for optimistic-concurrency.
 */
import { describe, expect, test } from "bun:test";
import {
  buildDeleteRequest,
  recordDeletePath,
  recordPatchPath,
} from "./edit-dispatch";

describe("recordDeletePath", () => {
  test("uses the same /api/ledger/record/:id route as PATCH", () => {
    expect(recordDeletePath("45")).toBe("/api/ledger/record/45");
    // DELETE + PATCH share the per-record route on the server.
    expect(recordDeletePath("45")).toBe(recordPatchPath("45"));
  });

  test("URL-encodes ids carrying reserved characters", () => {
    expect(recordDeletePath("ID/1 2")).toBe("/api/ledger/record/ID%2F1%202");
  });

  test("a slug routes the delete to the named sibling ledger", () => {
    expect(recordDeletePath("45", "initiatives")).toBe(
      "/api/ledger/initiatives/record/45",
    );
    // DELETE + PATCH share the slug-scoped per-record route on the server.
    expect(recordDeletePath("45", "initiatives")).toBe(
      recordPatchPath("45", "initiatives"),
    );
  });
});

describe("buildDeleteRequest", () => {
  test("wraps the baseMtime string in a { baseMtime } body", () => {
    const body = buildDeleteRequest("2026-05-30T12:00:00.000Z");
    expect(body).toEqual({ baseMtime: "2026-05-30T12:00:00.000Z" });
  });

  test("is a plain JSON-serialisable body (no method/headers)", () => {
    // Matches buildPatchRequest's convention: the DOM layer owns
    // method + headers + JSON.stringify; this helper only shapes the body.
    const body = buildDeleteRequest("x");
    expect(JSON.parse(JSON.stringify(body))).toEqual({ baseMtime: "x" });
  });
});
