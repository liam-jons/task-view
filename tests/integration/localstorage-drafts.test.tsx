/**
 * tests/integration/localstorage-drafts.test.tsx — PRODUCT inv 51
 * (failed save preserves textarea content in browser localStorage
 * keyed by `{ledgerPath, recordId, fieldPath}`; subsequent reload of
 * the same record re-populates textarea; cleared on successful save
 * of same triple).
 *
 * Acceptance:
 *   - On schema-error / mtime-conflict / network failure, the SPA
 *     calls `saveDraft` with the user's current textarea content +
 *     the `{ledgerPath, recordId, fieldPath}` triple.
 *   - On reload of the same record, `loadDraft` returns the stored
 *     value which is then passed as the descriptor.draft prop
 *     (pre-populating the textarea).
 *   - On successful save of the same triple, `clearDraft` removes
 *     the entry.
 *   - Different triples (different fieldPath, different recordId,
 *     different ledgerPath) have independent drafts.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TextareaField } from "../../packages/ui/record-view/edit-affordances";
import {
  clearDraft,
  createMemoryDraftStore,
  loadDraft,
  saveDraft,
} from "../../packages/ui/record-view/edit-state";

const LEDGER = "/repo/docs/reference/task-list.json";
const RECORD = "20";
const FIELD = ["tasks", "20", "description"];

describe("PRODUCT inv 51 — failed save preserves draft", () => {
  test("schema-error path: save draft → reload → load draft → textarea pre-populated", () => {
    const store = createMemoryDraftStore();

    // 1. User typed something + tried to save; server returned schema-error.
    const userDraft = "User-typed text that should not be lost.";
    saveDraft(store, LEDGER, RECORD, FIELD, userDraft);

    // 2. User navigates away + back (or page reloads). SPA queries
    //    localStorage for a draft of the same triple before rendering.
    const recovered = loadDraft(store, LEDGER, RECORD, FIELD);
    expect(recovered).toBe(userDraft);

    // 3. The recovered value is passed to the descriptor as `draft`.
    //    The rendered textarea pre-populates with it.
    const html = renderToStaticMarkup(
      <TextareaField fieldPath={FIELD} draft={recovered ?? ""} />,
    );
    expect(html).toContain("User-typed text that should not be lost.");
  });

  test("mtime-conflict path: same preservation behaviour", () => {
    const store = createMemoryDraftStore();
    const draft =
      "Long description Liam was mid-writing when a workflow agent\nupdated the ledger underneath.";
    saveDraft(store, LEDGER, RECORD, FIELD, draft);

    const recovered = loadDraft(store, LEDGER, RECORD, FIELD);
    expect(recovered).toBe(draft);
  });

  test("network-error path: same preservation behaviour", () => {
    const store = createMemoryDraftStore();
    const draft = "Edit attempted while offline.";
    saveDraft(store, LEDGER, RECORD, FIELD, draft);
    expect(loadDraft(store, LEDGER, RECORD, FIELD)).toBe(draft);
  });
});

describe("PRODUCT inv 51 — successful save clears draft for same triple", () => {
  test("clearDraft removes the entry after a successful save", () => {
    const store = createMemoryDraftStore();
    saveDraft(store, LEDGER, RECORD, FIELD, "Some pending text");
    expect(loadDraft(store, LEDGER, RECORD, FIELD)).toBe("Some pending text");

    // Save succeeded → SPA calls clearDraft
    clearDraft(store, LEDGER, RECORD, FIELD);
    expect(loadDraft(store, LEDGER, RECORD, FIELD)).toBeNull();
  });

  test("clearing one triple does not affect a sibling triple", () => {
    const store = createMemoryDraftStore();
    saveDraft(
      store,
      LEDGER,
      RECORD,
      ["tasks", "20", "description"],
      "desc draft",
    );
    saveDraft(
      store,
      LEDGER,
      RECORD,
      ["tasks", "20", "status_note"],
      "note draft",
    );

    // Save succeeded on `description` only
    clearDraft(store, LEDGER, RECORD, ["tasks", "20", "description"]);

    expect(
      loadDraft(store, LEDGER, RECORD, ["tasks", "20", "description"]),
    ).toBeNull();
    expect(
      loadDraft(store, LEDGER, RECORD, ["tasks", "20", "status_note"]),
    ).toBe("note draft");
  });
});

describe("PRODUCT inv 51 — independent triples", () => {
  test("different recordId → independent drafts", () => {
    const store = createMemoryDraftStore();
    saveDraft(store, LEDGER, "20", ["tasks", "20", "description"], "A");
    saveDraft(store, LEDGER, "21", ["tasks", "21", "description"], "B");
    expect(
      loadDraft(store, LEDGER, "20", ["tasks", "20", "description"]),
    ).toBe("A");
    expect(
      loadDraft(store, LEDGER, "21", ["tasks", "21", "description"]),
    ).toBe("B");
  });

  test("different ledgerPath → independent drafts", () => {
    const store = createMemoryDraftStore();
    saveDraft(store, "/a.json", "20", ["tasks", "20", "description"], "A");
    saveDraft(store, "/b.json", "20", ["tasks", "20", "description"], "B");
    expect(loadDraft(store, "/a.json", "20", ["tasks", "20", "description"])).toBe(
      "A",
    );
    expect(loadDraft(store, "/b.json", "20", ["tasks", "20", "description"])).toBe(
      "B",
    );
  });

  test("Subtask vs Task fieldPath have independent drafts", () => {
    const store = createMemoryDraftStore();
    saveDraft(store, LEDGER, "20", ["tasks", "20", "description"], "T");
    saveDraft(
      store,
      LEDGER,
      "20",
      ["tasks", "20", "subtasks", "10", "description"],
      "S",
    );
    expect(loadDraft(store, LEDGER, "20", ["tasks", "20", "description"])).toBe(
      "T",
    );
    expect(
      loadDraft(store, LEDGER, "20", [
        "tasks",
        "20",
        "subtasks",
        "10",
        "description",
      ]),
    ).toBe("S");
  });
});

describe("PRODUCT inv 51 — round-trip with textarea render", () => {
  test("full lifecycle: type → fail → reload → recover → succeed → cleared", () => {
    const store = createMemoryDraftStore();
    const draftV1 = "First attempt.";
    const draftV2 = "Second attempt (corrected).";

    // Type + save fails → preserve draftV1
    saveDraft(store, LEDGER, RECORD, FIELD, draftV1);

    // Reload → recover draft → render textarea pre-populated
    const recovered1 = loadDraft(store, LEDGER, RECORD, FIELD);
    expect(recovered1).toBe(draftV1);
    let html = renderToStaticMarkup(
      <TextareaField fieldPath={FIELD} draft={recovered1 ?? ""} />,
    );
    expect(html).toContain(draftV1);

    // User edits → save fails again → update draft to V2
    saveDraft(store, LEDGER, RECORD, FIELD, draftV2);
    const recovered2 = loadDraft(store, LEDGER, RECORD, FIELD);
    expect(recovered2).toBe(draftV2);
    html = renderToStaticMarkup(
      <TextareaField fieldPath={FIELD} draft={recovered2 ?? ""} />,
    );
    expect(html).toContain(draftV2);
    expect(html).not.toContain(draftV1);

    // Save succeeds → clear draft
    clearDraft(store, LEDGER, RECORD, FIELD);
    expect(loadDraft(store, LEDGER, RECORD, FIELD)).toBeNull();
  });
});
