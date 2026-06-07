/**
 * Vendored umbrellas-schema parse acceptance (ID-90 U0).
 *
 * Mirrors the schemas.test.ts pattern: the schema vendored from KH
 * `lib/validation/umbrellas-schema.ts` parses a representative KH-shape
 * umbrellas.json without any `@/lib/validation/` imports. Feeds the ID-90
 * document-kind registration (record 10).
 */
import { describe, expect, test } from "bun:test";
import {
  UmbrellasSchema,
  UmbrellaEntrySchema,
  UmbrellaStatus,
} from "./umbrellas-schema";

const minimalUmbrellas = {
  document_name: "umbrellas",
  document_purpose: "Linear-Initiative analogue grouping Tasks under substrate docs.",
  last_updated: "kh-main-S323 representative fixture",
  related_documents: ["docs/reference/task-list.json"],
  umbrellas: [
    {
      id: "server-ledger-cutover",
      title: "Server Ledger Cutover",
      substrate_doc: "docs/specs/ID-90-server-ledger-cutover/PRODUCT.md",
      task_ids: ["90", "68"],
      status: "in_progress",
      phase: "Phase 0",
    },
  ],
};

describe("Vendored umbrellas schema: parse acceptance (ID-90 U0)", () => {
  test("UmbrellasSchema parses representative umbrellas JSON", () => {
    const result = UmbrellasSchema.safeParse(minimalUmbrellas);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.document_name).toBe("umbrellas");
      expect(result.data.umbrellas).toHaveLength(1);
      expect(result.data.umbrellas[0].id).toBe("server-ledger-cutover");
      expect(result.data.umbrellas[0].task_ids).toEqual(["90", "68"]);
    }
  });

  test("UmbrellaStatus accepts exactly the 4 canonical values", () => {
    for (const v of ["proposed", "in_progress", "done", "archived"]) {
      expect(UmbrellaStatus.safeParse(v).success).toBe(true);
    }
    expect(UmbrellaStatus.safeParse("blocked").success).toBe(false);
    expect(UmbrellaStatus.safeParse("deferred").success).toBe(false);
  });

  test("UmbrellaEntrySchema rejects non-kebab-case ids", () => {
    const base = minimalUmbrellas.umbrellas[0];
    expect(UmbrellaEntrySchema.safeParse({ ...base, id: "UpperCase" }).success).toBe(false);
    expect(UmbrellaEntrySchema.safeParse({ ...base, id: "-leading" }).success).toBe(false);
    expect(UmbrellaEntrySchema.safeParse({ ...base, id: "trailing-" }).success).toBe(false);
    expect(UmbrellaEntrySchema.safeParse({ ...base, id: "with spaces" }).success).toBe(false);
  });

  test("task_ids[] entries must be bare-digit Task ids", () => {
    const base = minimalUmbrellas.umbrellas[0];
    expect(UmbrellaEntrySchema.safeParse({ ...base, task_ids: ["ID-90"] }).success).toBe(false);
    expect(UmbrellaEntrySchema.safeParse({ ...base, task_ids: ["90"] }).success).toBe(true);
  });

  test("UmbrellaEntrySchema is strict — unknown fields rejected", () => {
    const base = minimalUmbrellas.umbrellas[0];
    const result = UmbrellaEntrySchema.safeParse({ ...base, extra: "nope" });
    expect(result.success).toBe(false);
  });

  test("last_updated freshness-marker discipline enforced (prefix, single line, single session-id, 200-char cap)", () => {
    const mk = (last_updated: string) => ({ ...minimalUmbrellas, last_updated });
    expect(UmbrellasSchema.safeParse(mk("no-prefix marker")).success).toBe(false);
    expect(UmbrellasSchema.safeParse(mk("kh-main-S1 line\nline2")).success).toBe(false);
    expect(UmbrellasSchema.safeParse(mk("kh-main-S1 then kh-main-S2 append")).success).toBe(false);
    expect(UmbrellasSchema.safeParse(mk(`kh-main-S1 ${"x".repeat(200)}`)).success).toBe(false);
    expect(UmbrellasSchema.safeParse(mk("kh-prod-readiness-S64 close-out")).success).toBe(true);
  });
});
