/**
 * edit-state-delete.test.ts — classifyDeleteResult, mirroring
 * classifySaveResult against the REAL handleDeleteRecord wire shapes
 * (packages/server/patch-server.ts):
 *
 *   200 → { ok: true, newMtime, recordId, mirrorsDeleted }
 *   409 → { ok: false, error: "mtime-mismatch", currentMtime, hint }
 *   404 → { ok: false, error: "record-not-found", recordId }
 *   422 → { ok: false, error: "schema-error", issues }
 *   422 → { ok: false, error: "unknown-document-name", documentName }
 *   500 → { ok: false, error: "mirror-regen-failed", canonicalWritten: true,
 *                              newMtime, detail }   ← SOFT (canonical saved)
 *   400/500 → other tokens (invalid-json / missing-baseMtime /
 *             invalid-baseMtime / write-failed / ledger-read-failed)
 */
import { describe, expect, test } from "bun:test";
import { classifyDeleteResult } from "./edit-state";

describe("classifyDeleteResult", () => {
  test("200 ok carries the server newMtime string", () => {
    const out = classifyDeleteResult({
      ok: true,
      newMtime: "2026-05-30T12:00:00.000Z",
      recordId: "45",
      mirrorsDeleted: 1,
    });
    expect(out).toEqual({
      kind: "ok",
      newMtime: "2026-05-30T12:00:00.000Z",
    });
  });

  test("200 ok without a usable newMtime yields undefined", () => {
    const out = classifyDeleteResult({ ok: true, recordId: "45" });
    expect(out).toEqual({ kind: "ok", newMtime: undefined });
  });

  test("409 mtime-mismatch maps to mtime-conflict with currentMtime + hint", () => {
    const out = classifyDeleteResult({
      ok: false,
      error: "mtime-mismatch",
      currentMtime: "2026-05-30T13:00:00.000Z",
      hint: "ledger changed underneath you",
    });
    expect(out).toEqual({
      kind: "mtime-conflict",
      message: "ledger changed underneath you",
      currentMtime: "2026-05-30T13:00:00.000Z",
    });
  });

  test("409 mtime-mismatch falls back to a default message when hint absent", () => {
    const out = classifyDeleteResult({
      ok: false,
      error: "mtime-mismatch",
      currentMtime: "2026-05-30T13:00:00.000Z",
    });
    expect(out.kind).toBe("mtime-conflict");
    if (out.kind === "mtime-conflict") {
      expect(out.message.length).toBeGreaterThan(0);
      expect(out.currentMtime).toBe("2026-05-30T13:00:00.000Z");
    }
  });

  test("404 record-not-found maps to not-found", () => {
    const out = classifyDeleteResult({
      ok: false,
      error: "record-not-found",
      recordId: "999",
    });
    expect(out).toEqual({
      kind: "not-found",
      message: "That record no longer exists in the ledger.",
    });
  });

  test("422 schema-error formats the first issue inline", () => {
    const out = classifyDeleteResult({
      ok: false,
      error: "schema-error",
      issues: [{ path: ["items", 0, "id"], message: "Required" }],
    });
    expect(out).toEqual({
      kind: "schema-error",
      message: "items.0.id: Required",
    });
  });

  test("422 unknown-document-name maps to schema-error with the doc name", () => {
    const out = classifyDeleteResult({
      ok: false,
      error: "unknown-document-name",
      documentName: "Mystery Ledger",
    });
    expect(out.kind).toBe("schema-error");
    if (out.kind === "schema-error") {
      expect(out.message).toContain("Mystery Ledger");
    }
  });

  test("mirror-regen-failed is SOFT — delete succeeded, adopt newMtime", () => {
    const out = classifyDeleteResult({
      ok: false,
      error: "mirror-regen-failed",
      canonicalWritten: true,
      newMtime: "2026-05-30T14:00:00.000Z",
      detail: "regen blew up",
    });
    expect(out).toEqual({
      kind: "ok",
      newMtime: "2026-05-30T14:00:00.000Z",
    });
  });

  test("unrecognised error tokens fall through to network-error", () => {
    const out = classifyDeleteResult({
      ok: false,
      error: "write-failed",
      detail: "disk full",
    });
    expect(out.kind).toBe("network-error");
    if (out.kind === "network-error") {
      expect(out.message).toContain("write-failed");
    }
  });

  test("a non-object response is a network-error", () => {
    expect(classifyDeleteResult(null).kind).toBe("network-error");
    expect(classifyDeleteResult("nope").kind).toBe("network-error");
  });
});
