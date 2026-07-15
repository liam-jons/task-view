/**
 * cross-ledger.test.ts — slug ↔ document_name map + sibling path resolver
 * ({20.29} cross-ledger nav, SPEC §5 slice 1).
 *
 * The cross-ledger nav surface routes `/?ledger=<slug>&record=<id>` to a
 * SIBLING ledger file in the launched ledger's directory. This module owns
 * the stable slug ↔ canonical-`document_name` map and the directory scan
 * that resolves a sibling's path by name — reusing the `scanForLedgers`
 * shape `resolveTransactionSiblings` already relies on (patch-server.ts).
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEDGER_SLUGS,
  slugForDocumentName,
  documentNameForSlug,
  resolveLedgerPathByName,
} from "./cross-ledger";

const FIXTURE_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "tests",
  "fixtures",
  "live-ledgers",
);

describe("slug ↔ document_name map (SPEC §2)", () => {
  test("LEDGER_SLUGS enumerates the nav slugs (ID-148.10: 'roadmap' repurposed to 'initiatives', 'umbrellas' retired)", () => {
    expect([...LEDGER_SLUGS].sort()).toEqual([
      "backlog",
      "initiatives",
      "retro",
      "task-list",
    ]);
  });

  test("slugForDocumentName maps each canonical document_name to its slug", () => {
    expect(slugForDocumentName("Knowledge Hub Task List")).toBe("task-list");
    expect(slugForDocumentName("Canonical Platform - Initiatives")).toBe(
      "initiatives",
    );
    expect(slugForDocumentName("Product Backlog")).toBe("backlog");
    // WS-C C2: the retro ledger document_name → 'retro' slug.
    expect(slugForDocumentName("Knowledge Hub Retros")).toBe("retro");
  });

  test("slugForDocumentName returns null for a retired document_name (roadmap / umbrellas)", () => {
    expect(slugForDocumentName("Knowledge Hub Roadmap")).toBeNull();
    expect(slugForDocumentName("umbrellas")).toBeNull();
  });

  test("slugForDocumentName returns null for an unknown document_name", () => {
    expect(slugForDocumentName("Some Other Doc")).toBeNull();
  });

  test("documentNameForSlug maps each slug back to its canonical name", () => {
    expect(documentNameForSlug("task-list")).toBe("Knowledge Hub Task List");
    expect(documentNameForSlug("initiatives")).toBe(
      "Canonical Platform - Initiatives",
    );
    expect(documentNameForSlug("backlog")).toBe("Product Backlog");
    expect(documentNameForSlug("retro")).toBe("Knowledge Hub Retros");
  });

  test("documentNameForSlug returns null for a retired slug (roadmap / umbrellas) or an unknown slug", () => {
    expect(documentNameForSlug("roadmap")).toBeNull();
    expect(documentNameForSlug("umbrellas")).toBeNull();
    expect(documentNameForSlug("not-a-slug")).toBeNull();
  });

  test("slug round-trips through both maps", () => {
    for (const slug of LEDGER_SLUGS) {
      const name = documentNameForSlug(slug);
      expect(name).not.toBeNull();
      expect(slugForDocumentName(name!)).toBe(slug);
    }
  });
});

describe("resolveLedgerPathByName (SPEC §1, reuses scanForLedgers shape)", () => {
  test("resolves a real sibling against the live-ledgers fixture dir", async () => {
    // Launched ledger is initiatives; resolve its task-list + backlog siblings.
    const launched = join(FIXTURE_DIR, "initiatives.json");

    const taskListPath = await resolveLedgerPathByName(
      launched,
      "Knowledge Hub Task List",
    );
    expect(taskListPath).toBe(join(FIXTURE_DIR, "task-list.json"));

    const backlogPath = await resolveLedgerPathByName(
      launched,
      "Product Backlog",
    );
    expect(backlogPath).toBe(join(FIXTURE_DIR, "product-backlog.json"));
  });

  test("resolves the launched ledger's OWN document_name to its own path", async () => {
    const launched = join(FIXTURE_DIR, "initiatives.json");
    const self = await resolveLedgerPathByName(
      launched,
      "Canonical Platform - Initiatives",
    );
    expect(self).toBe(launched);
  });

  test("returns null when the named sibling is absent from the directory", async () => {
    // A directory holding only the initiatives ledger — no task-list / backlog siblings.
    const initiativesText = await Bun.file(
      join(FIXTURE_DIR, "initiatives.json"),
    ).text();
    const dir = await mkdtemp(join(tmpdir(), "cross-ledger-test-"));
    const lonelyInitiatives = join(dir, "initiatives.json");
    await writeFile(lonelyInitiatives, initiativesText, "utf8");
    try {
      const taskListPath = await resolveLedgerPathByName(
        lonelyInitiatives,
        "Knowledge Hub Task List",
      );
      expect(taskListPath).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
