/**
 * Tests for U9 slug routing + the health endpoint — ID-90.11 (PRODUCT
 * invariants 55, 56; TECH §Proposed changes U9, OQ-2 ratified: singleton
 * multi-document loopback daemon per ledger directory).
 *
 *   - `/api/ledger/:slug/…` routes any request to the named document in
 *     the launch directory (all four known kinds — ID-148.10: task-list,
 *     initiatives, backlog, retro; `umbrellas` is fully retired, INV-12(b)).
 *   - Bare `/api/ledger/…` keeps routing to the LAUNCH document (viewer
 *     back-compat).
 *   - `GET /api/health` → {ok, version, ledgerDir, documents: [{slug,
 *     document_name, path}]}.
 *   - Loopback-only binding UNCHANGED (inv 55: U9 changes routing, not
 *     binding).
 *
 * Real Bun.serve servers on port 0; fetch never mocked. Network binds
 * need `dangerouslyDisableSandbox: true` under the Claude harness.
 * Synthetic fixtures only (AC-I).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { startPatchServer, type PatchServerHandle } from "./patch-server";
import rootPkg from "../../package.json";

let testDir: string;
let handle: PatchServerHandle | null;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "task-view-slug-routing-"));
  handle = null;
});

afterEach(async () => {
  if (handle) {
    await handle.stop(true);
    handle = null;
  }
  await rm(testDir, { recursive: true, force: true });
});

// ── Synthetic fixtures (all four known document kinds, ID-148.10) ───────────

function makeTaskListLedger() {
  return {
    document_name: "Knowledge Hub Task List",
    document_purpose: "Synthetic fixture.",
    related_documents: [],
    tasks: [
      {
        id: "20",
        title: "Synthetic task 20",
        description: "Body.",
        status: "in_progress",
        priority: "must",
        dependencies: [],
        subtasks: [],
        updatedAt: "2026-05-21T15:30:00.000Z",
        effort_estimate: null,
        owner: null,
        priority_note: null,
        status_note: null,
        cross_doc_links: [],
        session_refs: [],
        commit_refs: [],
      },
    ],
  };
}

// ID-148.10 (INV-12(a)): repurposed roadmap fixture — a top-level Initiative
// (id "10", matching the retired theme's id so test intent stays legible)
// with one Project carrying the SAME cross-ledger links the old theme
// fixture carried (linked_tasks: ["20"] into the task-list fixture).
function makeInitiativesLedger() {
  return {
    document_name: "Canonical Platform - Initiatives",
    document_purpose: "Synthetic fixture.",
    date: "2026-05-25",
    status: "active",
    related_documents: [],
    last_updated: "synthetic fixture",
    initiatives: [
      {
        id: "10",
        title: "Synthetic initiative",
        description: "Initiative body.",
        status: "active",
        projects: [
          {
            id: "synthetic-project",
            title: "Synthetic project",
            summary: "Summary.",
            description: "Description.",
            substrate_doc: "",
            status: "in-progress",
            blocked_by: [],
            blocking: [],
            linked_tasks: ["20"],
            linked_backlog: [],
            originating_session: [],
          },
        ],
        originating_session: [],
        "sub-initiatives": [],
      },
    ],
  };
}

function makeBacklogLedger() {
  return {
    document_name: "Product Backlog",
    document_purpose: "Synthetic fixture.",
    related_documents: [],
    items: [
      {
        id: "101",
        description: "Synthetic backlog item.",
        type: "feature",
        status: "ready",
        effort_estimate: null,
        priority: "medium",
        track: "infra",
        dependencies: [],
        session_refs: [],
        commit_refs: [],
        cross_doc_links: [],
        notes: null,
      },
    ],
  };
}

// ID-148.10 (INV-12(b)): umbrellas is fully retired — the fourth-document
// slot in the fixture set is now `retro` (WS-C C2's fourth known kind).
function makeRetrosDoc() {
  return {
    document_name: "Knowledge Hub Retros",
    document_purpose: "Synthetic retros fixture.",
    related_documents: [],
    last_updated: "kh-main-S1 synthetic fixture",
    retros: [
      {
        id: "S1",
        session_id: "S1",
        date: "2026-05-25",
        track: "main",
        session_refs: [],
        commit_refs: [],
        cross_doc_links: [],
        bugs_discovered: [],
        failed_assumptions: [],
        architecture_decisions: [],
        rejected_approaches: [],
        workflow_improvements: [],
        unresolved_questions: [],
        deprecated: false,
        deprecation_reason: null,
        superseding_record_id: null,
        last_conflict_check: null,
      },
    ],
  };
}

/** Write all four known documents into the test dir; return their paths. */
async function writeAllFour(): Promise<Record<string, string>> {
  const paths = {
    taskList: join(testDir, "task-list.json"),
    initiatives: join(testDir, "initiatives.json"),
    backlog: join(testDir, "product-backlog.json"),
    retro: join(testDir, "product-retros.json"),
  };
  await writeFile(
    paths.taskList,
    JSON.stringify(makeTaskListLedger(), null, 2),
    "utf8",
  );
  await writeFile(
    paths.initiatives,
    JSON.stringify(makeInitiativesLedger(), null, 2),
    "utf8",
  );
  await writeFile(
    paths.backlog,
    JSON.stringify(makeBacklogLedger(), null, 2),
    "utf8",
  );
  await writeFile(
    paths.retro,
    JSON.stringify(makeRetrosDoc(), null, 2),
    "utf8",
  );
  return paths;
}

async function mtimeOf(path: string): Promise<string> {
  return (await stat(path)).mtime.toISOString();
}

// ── Slug routing: all four documents reachable from one daemon ──────────────

describe("slug routing — /api/ledger/:slug/… serves every known document (inv 56)", () => {
  test("GET via each slug returns the named document's kind + data", async () => {
    const paths = await writeAllFour();
    handle = startPatchServer({ ledgerPath: paths.taskList });

    const expectations: Array<{ slug: string; kind: string }> = [
      { slug: "task-list", kind: "task-list" },
      { slug: "initiatives", kind: "initiatives" },
      { slug: "backlog", kind: "backlog" },
      { slug: "retro", kind: "retro" },
    ];
    for (const { slug, kind } of expectations) {
      const res = await fetch(`${handle.url}/api/ledger/${slug}`);
      expect(`${slug}:${res.status}`).toBe(`${slug}:200`);
      const body = (await res.json()) as { ok: boolean; kind: string };
      expect(body.ok).toBe(true);
      expect(body.kind).toBe(kind);
    }
  });

  test("slug-routed record GET resolves a sibling document's record", async () => {
    const paths = await writeAllFour();
    handle = startPatchServer({ ledgerPath: paths.taskList });

    const res = await fetch(`${handle.url}/api/ledger/initiatives/record/10`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      record: { id: string; title: string };
    };
    expect(body.kind).toBe("initiative");
    expect(body.record.id).toBe("10");
  });

  test("slug-routed PATCH lands bytes in the named sibling — incl. an initiatives project edit", async () => {
    const paths = await writeAllFour();
    handle = startPatchServer({ ledgerPath: paths.taskList });

    const res = await fetch(
      `${handle.url}/api/ledger/initiatives/record/synthetic-project`,
      {
        method: "PATCH",
        body: JSON.stringify({
          baseMtime: await mtimeOf(paths.initiatives),
          patches: [
            {
              fieldPath: ["projects", "synthetic-project", "linked_tasks"],
              newValue: ["20", "21"],
            },
          ],
        }),
      },
    );
    expect(res.status).toBe(200);

    const initiatives = JSON.parse(
      await readFile(paths.initiatives, "utf8"),
    ) as {
      initiatives: Array<{ projects: Array<{ id: string; linked_tasks: string[] }> }>;
    };
    expect(initiatives.initiatives[0].projects[0].linked_tasks).toEqual([
      "20",
      "21",
    ]);
    // The LAUNCH document is untouched — the slug routed, it did not alias.
    const taskList = JSON.parse(await readFile(paths.taskList, "utf8")) as {
      tasks: Array<{ id: string }>;
    };
    expect(taskList.tasks).toHaveLength(1);
  });

  test("slug-routed subtask CREATE works against a sibling task-list", async () => {
    const paths = await writeAllFour();
    // Launch on the BACKLOG; mutate the task-list via its slug.
    handle = startPatchServer({ ledgerPath: paths.backlog });

    const res = await fetch(
      `${handle.url}/api/ledger/task-list/record/20/subtask`,
      {
        method: "POST",
        body: JSON.stringify({
          baseMtime: await mtimeOf(paths.taskList),
          subtasks: [{ title: "New slice", description: "Body." }],
        }),
      },
    );
    expect(res.status).toBe(201);
    const taskList = JSON.parse(await readFile(paths.taskList, "utf8")) as {
      tasks: Array<{ subtasks: Array<{ id: number; title: string }> }>;
    };
    expect(taskList.tasks[0].subtasks.map((s) => s.title)).toContain(
      "New slice",
    );
  });

  test("slug-routed transaction promotes across the directory's ledgers", async () => {
    const paths = await writeAllFour();
    handle = startPatchServer({ ledgerPath: paths.retro });

    const res = await fetch(`${handle.url}/api/ledger/backlog/transaction`, {
      method: "POST",
      body: JSON.stringify({
        op: "promote",
        sourceBacklogId: "101",
        taskRecord: {
          id: "30",
          title: "Promoted synthetic task",
          description: "Promoted.",
          status: "pending",
          priority: "should",
          dependencies: [],
          subtasks: [],
          updatedAt: "2026-05-25T12:00:00.000Z",
          effort_estimate: null,
          owner: null,
          priority_note: null,
          status_note: null,
          cross_doc_links: [],
          session_refs: [],
          commit_refs: [],
        },
        taskListBaseMtime: await mtimeOf(paths.taskList),
        backlogBaseMtime: await mtimeOf(paths.backlog),
      }),
    });
    expect(res.status).toBe(200);
    const taskList = JSON.parse(await readFile(paths.taskList, "utf8")) as {
      tasks: Array<{ id: string }>;
    };
    expect(taskList.tasks.map((t) => t.id)).toContain("30");
  });

  test("a slug whose document is absent from the directory → 404 document-not-found", async () => {
    // Only the task-list exists — no initiatives sibling.
    const taskListPath = join(testDir, "task-list.json");
    await writeFile(
      taskListPath,
      JSON.stringify(makeTaskListLedger(), null, 2),
      "utf8",
    );
    handle = startPatchServer({ ledgerPath: taskListPath });

    const res = await fetch(`${handle.url}/api/ledger/initiatives`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; slug: string };
    expect(body.error).toBe("document-not-found");
    expect(body.slug).toBe("initiatives");
  });
});

// ── Bare-route back-compat: the launch document keeps its old URLs ──────────

describe("bare /api/ledger/* back-compat — launch document routing unchanged", () => {
  test("bare GET + PATCH still target the LAUNCH document with siblings present", async () => {
    const paths = await writeAllFour();
    handle = startPatchServer({ ledgerPath: paths.taskList });

    const get = await fetch(`${handle.url}/api/ledger`);
    expect(get.status).toBe(200);
    expect(((await get.json()) as { kind: string }).kind).toBe("task-list");

    const patch = await fetch(`${handle.url}/api/ledger/record/20`, {
      method: "PATCH",
      body: JSON.stringify({
        baseMtime: await mtimeOf(paths.taskList),
        patches: [
          { fieldPath: ["tasks", "20", "status_note"], newValue: "bare edit" },
        ],
      }),
    });
    expect(patch.status).toBe(200);
    expect(await readFile(paths.taskList, "utf8")).toContain("bare edit");
    // Siblings untouched.
    expect(await readFile(paths.backlog, "utf8")).not.toContain("bare edit");
  });

  test("a record id that collides with no slug still resolves through the bare record route", async () => {
    const paths = await writeAllFour();
    handle = startPatchServer({ ledgerPath: paths.taskList });
    const res = await fetch(`${handle.url}/api/ledger/record/20`);
    expect(res.status).toBe(200);
  });
});

// ── GET /api/health ──────────────────────────────────────────────────────────

describe("GET /api/health — daemon identity + document registry", () => {
  test("reports ok, version, ledgerDir and ALL four documents with slug/document_name/path", async () => {
    const paths = await writeAllFour();
    handle = startPatchServer({ ledgerPath: paths.taskList });

    const res = await fetch(`${handle.url}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      version: string;
      ledgerDir: string;
      documents: Array<{ slug: string; document_name: string; path: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.version).toBe(rootPkg.version);
    expect(body.ledgerDir).toBe(resolve(testDir));

    const bySlug = Object.fromEntries(
      body.documents.map((d) => [d.slug, d]),
    );
    expect(Object.keys(bySlug).sort()).toEqual([
      "backlog",
      "initiatives",
      "retro",
      "task-list",
    ]);
    expect(bySlug["task-list"].document_name).toBe("Knowledge Hub Task List");
    expect(bySlug["task-list"].path).toBe(resolve(paths.taskList));
    expect(bySlug["initiatives"].document_name).toBe(
      "Canonical Platform - Initiatives",
    );
    expect(bySlug["initiatives"].path).toBe(resolve(paths.initiatives));
  });

  test("lists only the documents actually present in the directory", async () => {
    const taskListPath = join(testDir, "task-list.json");
    await writeFile(
      taskListPath,
      JSON.stringify(makeTaskListLedger(), null, 2),
      "utf8",
    );
    handle = startPatchServer({ ledgerPath: taskListPath });

    const res = await fetch(`${handle.url}/api/health`);
    const body = (await res.json()) as {
      documents: Array<{ slug: string }>;
    };
    expect(body.documents.map((d) => d.slug)).toEqual(["task-list"]);
  });
});

// ── Inv 55 regression: U9 changes routing, NOT binding ──────────────────────

describe("loopback-only binding unchanged by U9 (inv 55)", () => {
  test("non-loopback hostname still throws with the new options present", async () => {
    const paths = await writeAllFour();
    expect(() =>
      startPatchServer({
        ledgerPath: paths.taskList,
        hostname: "0.0.0.0",
        requireDenylist: true,
      }),
    ).toThrow(/loopback/i);
  });

  test("the multi-document daemon binds 127.0.0.1", async () => {
    const paths = await writeAllFour();
    handle = startPatchServer({ ledgerPath: paths.taskList });
    expect(handle.hostname).toBe("127.0.0.1");
    expect(handle.url).toContain("127.0.0.1");
  });
});

// ── editable-ledger-switch: GET / switch is editable + slug-routed writes land ─
//
// End-to-end glue (editable-ledger-switch SPEC §5 slice 5): launch on one
// ledger, switch the active editable target in the browser, and confirm the
// write lands in the switched-to sibling while the others stay untouched. Ties
// the viewer (switcher + editable siblings) to the slug write seam.

describe("editable-ledger-switch — editable switch + slug-routed writes (E2E)", () => {
  test("launched on task-list, /?ledger=initiatives is EDITABLE with a switcher (no banner)", async () => {
    const paths = await writeAllFour();
    handle = startPatchServer({ ledgerPath: paths.taskList });

    const res = await fetch(`${handle.url}/?ledger=initiatives&record=10`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-record-kind="initiative"');
    expect(html).toContain('data-record-id="10"');
    // Switched-to sibling is editable — edit affordances present, banner gone.
    expect(html).toContain("data-edit-action");
    expect(html).not.toContain("data-ledger-banner");
    // The switcher is mounted, marking initiatives active, with task-list +
    // backlog as switch targets (all present in the launch directory; retro
    // has no viewer surface and stays hidden).
    expect(html).toContain("data-ledger-switcher");
    expect(html).toContain('data-active-ledger="initiatives"');
    expect(html).toContain('href="/?ledger=task-list"');
    expect(html).toContain('href="/?ledger=backlog"');
  });

  test("a slug-routed PATCH from the switched-to initiatives lands in initiatives; task-list untouched", async () => {
    const paths = await writeAllFour();
    handle = startPatchServer({ ledgerPath: paths.taskList });

    // The client, viewing /?ledger=initiatives, writes via
    // recordPatchPath(id,"initiatives") → /api/ledger/initiatives/record/10.
    const res = await fetch(
      `${handle.url}/api/ledger/initiatives/record/10`,
      {
        method: "PATCH",
        body: JSON.stringify({
          baseMtime: await mtimeOf(paths.initiatives),
          patches: [
            {
              fieldPath: ["initiatives", "10", "description"],
              newValue: "Edited via switch.",
            },
          ],
        }),
      },
    );
    expect(res.status).toBe(200);
    expect(await readFile(paths.initiatives, "utf8")).toContain(
      "Edited via switch.",
    );
    // The launch ledger (task-list) is untouched — the slug routed, not aliased.
    expect(await readFile(paths.taskList, "utf8")).not.toContain(
      "Edited via switch.",
    );
  });

  test("switching the active target to backlog routes the write into the backlog", async () => {
    const paths = await writeAllFour();
    handle = startPatchServer({ ledgerPath: paths.taskList });

    // Viewer GET confirms backlog is editable when switched to.
    const view = await fetch(`${handle.url}/?ledger=backlog&record=101`);
    expect(view.status).toBe(200);
    const html = await view.text();
    expect(html).toContain('data-active-ledger="backlog"');
    expect(html).toContain("data-edit-action");

    // The slug-routed write lands in the backlog; the launch task-list is clear.
    const res = await fetch(`${handle.url}/api/ledger/backlog/record/101`, {
      method: "PATCH",
      body: JSON.stringify({
        baseMtime: await mtimeOf(paths.backlog),
        patches: [{ fieldPath: ["items", "101", "status"], newValue: "blocked" }],
      }),
    });
    expect(res.status).toBe(200);
    const backlog = JSON.parse(await readFile(paths.backlog, "utf8")) as {
      items: Array<{ id: string; status: string }>;
    };
    expect(backlog.items[0].status).toBe("blocked");
    expect(await readFile(paths.taskList, "utf8")).not.toContain("blocked");
  });
});
