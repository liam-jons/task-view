/**
 * Tests for gates/client-name-guard — ID-90 U4 (PRODUCT invariants 28–35).
 *
 * The de-ID gate: STRICT JSON denylist parser (T-1 — a legacy comma-separated
 * value is a LOUD config error, never comma-split), per-token case-flag
 * matcher (identity-guard.yml:384–390 model), net-new delta semantics
 * (invariant 31), FULLY REDACTED rejection surfaces (invariant 32 — the
 * 245c35ac `[${names}]` interpolation is deliberately NOT ported).
 *
 * Synthetic fixtures only (AC-I) — every token below is invented; no real
 * client identity appears anywhere in this file, its assertions, or any
 * output the guard produces.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CLIENT_NAME_DENYLIST_ENV,
  clientNameGuard,
  countDenylistHits,
  parseDenylist,
} from "./client-name-guard";
import { buildPreWriteGates, runPreWriteGates } from "./gate-chain";
import { startPatchServer, type PatchServerHandle } from "../patch-server";

// ── Synthetic denylist fixtures (AC-I — invented, clearly fictional) ─────────

const TOKEN_CI = "Zorblian Widgets Ltd"; // case_insensitive: true
const TOKEN_CS = "QUUXCORP"; // case_insensitive: false
const TOKEN_META = "Vexo+Partners (Group)"; // regex metacharacters, ci: true

const FIXTURE_TOKEN_FRAGMENTS = [
  "zorblian",
  "quuxcorp",
  "vexo",
  "widgets ltd",
  "partners (group)",
];

const VALID_DENYLIST = JSON.stringify({
  tokens: [
    { value: TOKEN_CI, case_insensitive: true, class: "client" },
    { value: TOKEN_CS, case_insensitive: false, class: "client" },
    { value: TOKEN_META, case_insensitive: true, class: "client" },
  ],
  exclusion_patterns: [
    { pattern: "zorblian_env_example_placeholder", reason: "synthetic carve-out" },
  ],
});

/** PARANOID redaction sweep: no fixture token (or fragment) may appear in
 * any string the guard emits — response bodies, details, warnings, config
 * reasons (invariant 32). Case-insensitive. */
function expectRedacted(output: string): void {
  const lower = output.toLowerCase();
  for (const fragment of FIXTURE_TOKEN_FRAGMENTS) {
    expect(lower).not.toContain(fragment);
  }
}

// ── Env + console isolation ──────────────────────────────────────────────────

let savedEnv: string | undefined;
let consoleSpies: ReturnType<typeof spyOn>[] = [];
const CONSOLE_METHODS = ["log", "warn", "error", "info", "debug"] as const;

beforeEach(() => {
  savedEnv = process.env[CLIENT_NAME_DENYLIST_ENV];
  delete process.env[CLIENT_NAME_DENYLIST_ENV];
  consoleSpies = CONSOLE_METHODS.map((m) => spyOn(console, m));
});

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env[CLIENT_NAME_DENYLIST_ENV];
  } else {
    process.env[CLIENT_NAME_DENYLIST_ENV] = savedEnv;
  }
  // Invariant 32: the guard never writes log lines (a log line is a leak
  // vector). Sweep every console call made during the test for fixture
  // tokens, then restore.
  for (const spy of consoleSpies) {
    for (const call of spy.mock.calls) {
      expectRedacted(call.map((a: unknown) => String(a)).join(" "));
    }
    spy.mockRestore();
  }
});

function guard(priorContent: string, requireDenylist = false) {
  return clientNameGuard({
    documentLabel: "task-list",
    priorContent,
    requireDenylist,
  });
}

// ── 1. parseDenylist — STRICT JSON (T-1, invariants 29 + 35) ─────────────────

describe("parseDenylist — strict JSON shape predicate (T-1)", () => {
  test("unset / empty / whitespace-only → unset (guard inactive locally)", () => {
    expect(parseDenylist(undefined).state).toBe("unset");
    expect(parseDenylist("").state).toBe("unset");
    expect(parseDenylist("   \n").state).toBe("unset");
  });

  test("canonical JSON shape parses: tokens[] + exclusion_patterns[]", () => {
    const config = parseDenylist(VALID_DENYLIST);
    expect(config.state).toBe("active");
    if (config.state !== "active") throw new Error("unreachable");
    expect(config.denylist.tokens).toHaveLength(3);
    expect(config.denylist.tokens[0]).toEqual({
      value: TOKEN_CI,
      case_insensitive: true,
      class: "client",
    });
  });

  test("legacy comma-separated value is a LOUD config error, never comma-split (bl-244 root cause)", () => {
    const config = parseDenylist(`${TOKEN_CI},${TOKEN_CS}`);
    expect(config.state).toBe("invalid");
    if (config.state !== "invalid") throw new Error("unreachable");
    // The reason is redacted — it must not echo the raw env value.
    expectRedacted(config.reason);
  });

  test("unparseable JSON → invalid with redacted reason", () => {
    const config = parseDenylist("{tokens: [oops");
    expect(config.state).toBe("invalid");
    if (config.state !== "invalid") throw new Error("unreachable");
    expectRedacted(config.reason);
  });

  test("wrong shapes → invalid: no tokens, empty tokens, non-array tokens, non-object root", () => {
    for (const bad of [
      "{}",
      '{"tokens": []}',
      '{"tokens": "Zorblian Widgets Ltd"}',
      '{"tokens": 4}',
      "[1, 2]",
      '"just-a-string"',
      "null",
      "42",
    ]) {
      const config = parseDenylist(bad);
      expect(config.state).toBe("invalid");
      if (config.state === "invalid") expectRedacted(config.reason);
    }
  });

  test("malformed token entries → invalid, reason carries the index only (redacted)", () => {
    const missingValue = JSON.stringify({
      tokens: [{ case_insensitive: true, class: "client" }],
    });
    const emptyValue = JSON.stringify({
      tokens: [{ value: "", case_insensitive: true, class: "client" }],
    });
    const nonBooleanFlag = JSON.stringify({
      tokens: [{ value: TOKEN_CI, case_insensitive: "yes", class: "client" }],
    });
    for (const bad of [missingValue, emptyValue, nonBooleanFlag]) {
      const config = parseDenylist(bad);
      expect(config.state).toBe("invalid");
      if (config.state === "invalid") expectRedacted(config.reason);
    }
  });

  test("non-array exclusion_patterns is a misconfiguration → invalid (invariant 35)", () => {
    const config = parseDenylist(
      JSON.stringify({
        tokens: [{ value: TOKEN_CI, case_insensitive: true, class: "client" }],
        exclusion_patterns: "not-an-array",
      }),
    );
    expect(config.state).toBe("invalid");
  });

  test("exclusion_patterns are parsed-but-IGNORED — pattern text is NOT retained (OQ-7 Semantics B)", () => {
    const config = parseDenylist(VALID_DENYLIST);
    expect(config.state).toBe("active");
    // The parsed result deliberately drops the pattern TEXT (leak-surface
    // minimisation); only a count survives. (Token values legitimately
    // remain in memory — the matcher needs them; redaction applies to
    // OUTPUT surfaces, asserted throughout the verdict tests below.)
    if (config.state === "active") {
      expect(config.denylist.exclusionPatternCount).toBe(1);
      expect(JSON.stringify(config)).not.toContain("zorblian_env_example_placeholder");
    }
  });
});

// ── 2. Matcher — per-token case flags + regex escaping (invariant 30) ────────

describe("countDenylistHits — per-token case-flag matcher", () => {
  const denylist = (() => {
    const config = parseDenylist(VALID_DENYLIST);
    if (config.state !== "active") throw new Error("fixture must parse");
    return config.denylist;
  })();

  test("case_insensitive: true matches any casing", () => {
    expect(countDenylistHits(denylist, "zorblian widgets ltd")).toBe(1);
    expect(countDenylistHits(denylist, "ZORBLIAN WIDGETS LTD")).toBe(1);
    expect(countDenylistHits(denylist, "Zorblian Widgets Ltd")).toBe(1);
  });

  test("case_insensitive: false matches exact casing only — NEVER one global flag", () => {
    expect(countDenylistHits(denylist, "QUUXCORP")).toBe(1);
    expect(countDenylistHits(denylist, "quuxcorp")).toBe(0);
    expect(countDenylistHits(denylist, "QuuxCorp")).toBe(0);
  });

  test("regex metacharacters in token values are matched literally", () => {
    expect(countDenylistHits(denylist, "met vexo+partners (group) today")).toBe(1);
    // Without escaping, `+` and `(...)` would alter the pattern: "VexoPartners"
    // must NOT match.
    expect(countDenylistHits(denylist, "VexooPartners Group")).toBe(0);
  });

  test("counts every occurrence across all tokens", () => {
    const text = "Zorblian Widgets Ltd, QUUXCORP, zorblian widgets ltd";
    expect(countDenylistHits(denylist, text)).toBe(3);
  });
});

// ── 3. Net-new delta semantics (invariant 31) ────────────────────────────────

describe("clientNameGuard — net-new delta over (prior bytes, serialised bytes)", () => {
  beforeEach(() => {
    process.env[CLIENT_NAME_DENYLIST_ENV] = VALID_DENYLIST;
  });

  test("net-new hit rejects 422 client-name-guard with REDACTED detail", () => {
    const verdict = guard("{}").check({
      content: JSON.stringify({ note: `met ${TOKEN_CI} yesterday` }),
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.error).toBe("client-name-guard");
    expect(verdict.status).toBe(422);
    // Detail: delta count + document label ONLY (invariant 32).
    expect(verdict.detail).toContain("+1");
    expect(verdict.detail).toContain("task-list");
    expectRedacted(JSON.stringify(verdict));
  });

  test("equal count passes (no net-new content)", () => {
    const prior = JSON.stringify({ note: `historic ${TOKEN_CS} mention` });
    const verdict = guard(prior).check({ content: prior });
    expect(verdict.ok).toBe(true);
  });

  test("decreasing count passes (sanitising edit)", () => {
    const prior = JSON.stringify({ a: TOKEN_CI, b: TOKEN_CS });
    const verdict = guard(prior).check({
      content: JSON.stringify({ a: "de-identified", b: TOKEN_CS }),
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.warnings).toEqual([]);
  });

  test("increase from a non-zero baseline rejects with the delta count", () => {
    const prior = JSON.stringify({ a: TOKEN_CS });
    const verdict = guard(prior).check({
      content: JSON.stringify({ a: TOKEN_CS, b: TOKEN_CS, c: TOKEN_CS }),
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.detail).toContain("+2");
    expectRedacted(verdict.detail);
  });

  test("case-insensitive token: recased net-new content still counts", () => {
    const verdict = guard("{}").check({
      content: JSON.stringify({ note: "zOrBlIaN wIdGeTs lTd" }),
    });
    expect(verdict.ok).toBe(false);
  });
});

// ── 4. Override escape hatch (invariant 33) ──────────────────────────────────

describe("clientNameGuard — allowClientName override", () => {
  beforeEach(() => {
    process.env[CLIENT_NAME_DENYLIST_ENV] = VALID_DENYLIST;
  });

  test("override downgrades a rejection to a single REDACTED warning + allow", () => {
    const verdict = guard("{}").check({
      content: JSON.stringify({ note: TOKEN_CI }),
      options: { allowClientName: true },
    });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error("unreachable");
    expect(verdict.warnings).toHaveLength(1);
    expect(verdict.warnings[0]).toContain("client-name-guard");
    expectRedacted(verdict.warnings[0]);
  });

  test("override does NOT bypass a config error (invariant 35 beats invariant 33)", () => {
    process.env[CLIENT_NAME_DENYLIST_ENV] = "not json at all";
    const verdict = guard("{}").check({
      content: "{}",
      options: { allowClientName: true },
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.error).toBe("client-name-guard-config");
  });
});

// ── 5. Configuration states (invariants 34 + 35) ─────────────────────────────

describe("clientNameGuard — configuration states", () => {
  test("unset env → inactive locally: clean content and token-bearing content both pass", () => {
    // No env set (beforeEach deletes it).
    expect(guard("{}").check({ content: "{}" }).ok).toBe(true);
    expect(
      guard("{}").check({ content: JSON.stringify({ a: TOKEN_CI }) }).ok,
    ).toBe(true);
  });

  test("unset env + requireDenylist → loud 500 config error (invariant 34, record 11 seam)", () => {
    const verdict = guard("{}", true).check({ content: "{}" });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.error).toBe("client-name-guard-config");
    expect(verdict.status).toBe(500);
  });

  test("set-but-invalid env → 500 client-name-guard-config blocks EVERY mutation (invariant 35)", () => {
    for (const bad of ["{broken", `${TOKEN_CI},${TOKEN_CS}`, '{"tokens": []}']) {
      process.env[CLIENT_NAME_DENYLIST_ENV] = bad;
      const verdict = guard("{}").check({ content: "{}" });
      expect(verdict.ok).toBe(false);
      if (verdict.ok) throw new Error("unreachable");
      expect(verdict.error).toBe("client-name-guard-config");
      expect(verdict.status).toBe(500);
      expectRedacted(JSON.stringify(verdict));
    }
  });
});

// ── 6. Chain registration (invariant 28 — buildPreWriteGates seam) ───────────

describe("gate-chain registration — the guard rides every pre-write chain", () => {
  test("buildPreWriteGates appends client-name-guard after record-set", () => {
    const gates = buildPreWriteGates({
      recordSet: {
        ledgerLabel: "task-list",
        beforeIds: new Set(["7"]),
        descriptor: { collection: "tasks" },
        expectedDelta: { kind: "none" },
      },
      clientName: { priorContent: "{}" },
    });
    expect(gates.map((g) => g.name)).toEqual(["record-set", "client-name-guard"]);
  });

  test("active denylist + net-new hit in the bytes about to land → 422 through the chain", () => {
    process.env[CLIENT_NAME_DENYLIST_ENV] = VALID_DENYLIST;
    const prior = JSON.stringify({ tasks: [{ id: "7", note: "clean" }] });
    const content = JSON.stringify({
      tasks: [{ id: "7", note: `met ${TOKEN_CI}` }],
    });
    const verdict = runPreWriteGates(
      buildPreWriteGates({
        recordSet: {
          ledgerLabel: "task-list",
          beforeIds: new Set(["7"]),
          descriptor: { collection: "tasks" },
          expectedDelta: { kind: "none" },
        },
        clientName: { priorContent: prior },
      }),
      { content },
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.error).toBe("client-name-guard");
    expect(verdict.status).toBe(422);
    expectRedacted(JSON.stringify(verdict));
  });

  test("record-set violation short-circuits BEFORE the guard (registration order)", () => {
    process.env[CLIENT_NAME_DENYLIST_ENV] = VALID_DENYLIST;
    const verdict = runPreWriteGates(
      buildPreWriteGates({
        recordSet: {
          ledgerLabel: "task-list",
          beforeIds: new Set(["7"]),
          descriptor: { collection: "tasks" },
          expectedDelta: { kind: "none" },
        },
        clientName: { priorContent: "{}" },
      }),
      { content: JSON.stringify({ tasks: [] }) },
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.error).toBe("record-set-violation");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// RELOCATION — ID-90.13 U11 (PRODUCT invariant 36, AC-H2).
//
// The 245c35ac (7 evaluator tests) + 52ef3d5b (3 mutation-guard tests) suites
// from the KH `id68-relocation-phase23` branch relocate HERE as their formal
// new home — those branch files were never merged to canonical (Inv 42) and
// are superseded by this suite at AC-H2.
//
//   - 245c35ac exercised `evaluateLedgers` (the CI twin's pure delta
//     evaluator) over (base, head) text pairs. The substrate's equivalent
//     delta surface is `clientNameGuard` over (priorContent, content) —
//     the same shared net-new algebra (invariant 31). Cases are ported
//     1:1 onto that surface with JSON-shaped fixtures.
//   - 52ef3d5b drove the KH CLI `run()` (append-journal exemplar) against
//     temp copies of the REAL (token-bearing) ledgers. Here the exemplar is
//     the appendText PATCH against a real Bun.serve server (port 0, fetch
//     never mocked) on a synthetic token-BEARING baseline ledger — the
//     written-vs-not-written behaviour is the assertion surface.
//
// Fixtures are SYNTHETIC ONLY (AC-I): the source suites' real token family
// is never reproduced; the established Zorblian/ZorbCo family stands in.
// Every response body and all console output is swept for fixture-token
// ABSENCE (the file-scope console sweep plus per-test body sweeps).
// ═════════════════════════════════════════════════════════════════════════════

// ── 7. Relocated 245c35ac evaluator suite (7 tests → delta semantics) ────────

describe("RELOCATED 245c35ac evaluator suite — net-new delta over JSON-shaped documents", () => {
  beforeEach(() => {
    process.env[CLIENT_NAME_DENYLIST_ENV] = VALID_DENYLIST;
  });

  function doc(notes: string[]): string {
    return JSON.stringify({
      tasks: notes.map((note, i) => ({ id: String(i + 1), status_note: note })),
    });
  }

  // 245c35ac #1: "reports no finding when head adds no new client-name hits"
  test("clean edit on a clean baseline passes (no net-new hits)", () => {
    const verdict = guard(doc(["clean baseline journal line"])).check({
      content: doc(["clean baseline journal line, edited"]),
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.warnings).toEqual([]);
  });

  // 245c35ac #2: "flags a net-new client-name introduction"
  test("net-new introduction rejects with before/after/delta counts (redacted)", () => {
    const verdict = guard(doc(["clean"])).check({
      content: doc([`now names ${TOKEN_CI}`]),
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.error).toBe("client-name-guard");
    // baseHits 0 / headHits 1 / delta 1 — counts survive the relocation.
    expect(verdict.detail).toContain("+1");
    expect(verdict.detail).toContain("before 0, after 1");
    expectRedacted(JSON.stringify(verdict));
  });

  // 245c35ac #3: "tolerates a pre-existing reference — only NET-NEW additions
  // are blocked"
  test("pre-existing reference plus a clean append passes (delta 0)", () => {
    const verdict = guard(doc([`${TOKEN_CI} is already here`])).check({
      content: doc([`${TOKEN_CI} is already here`, "plus a clean append"]),
    });
    expect(verdict.ok).toBe(true);
  });

  // 245c35ac #4: "allows a sanitise sweep (hit count DROPS)"
  test("sanitise sweep (count drops) passes", () => {
    const verdict = guard(doc([`${TOKEN_CI} and ${TOKEN_CI} again`])).check({
      content: doc([`only one ${TOKEN_CI} remains`]),
    });
    expect(verdict.ok).toBe(true);
  });

  // 245c35ac #5: "counts a brand-new file (absent at base) as all net-new"
  test("brand-new document (empty prior) counts every hit net-new", () => {
    const verdict = guard("").check({
      content: doc([`${TOKEN_CI} in a brand new ledger`]),
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.detail).toContain("before 0, after 1");
    expectRedacted(verdict.detail);
  });

  // 245c35ac #6: "is case-insensitive and counts multiple net-new hits".
  // NOTE the deliberate semantic upgrade: the source applied ONE global
  // case-insensitive flag; the substrate honours each token's OWN
  // case_insensitive flag (invariant 30) — TOKEN_CI carries `true`, so the
  // recased variants all count, exactly as the source case expected.
  test("recased variants of a case-insensitive token all count (delta 3)", () => {
    const verdict = guard(doc(["clean"])).check({
      content: doc([
        `${TOKEN_CI.toUpperCase()} and ${TOKEN_CI.toLowerCase()} and ${TOKEN_CI}`,
      ]),
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.detail).toContain("before 0, after 3");
    expect(verdict.detail).toContain("+3");
  });

  // 245c35ac #7: "scans multiple ledgers and returns findings sorted by
  // path". The substrate has no multi-ledger sweep — each document's leg
  // carries its OWN guard (the cross-ledger transaction runs one per leg);
  // the per-document attribution relocates as the documentLabel in each
  // rejection detail.
  test("per-document attribution: each document's guard names ITS label in the rejection", () => {
    const dirty = doc([`names ${TOKEN_CI}`]);
    for (const label of ["product-backlog", "task-list"]) {
      const verdict = clientNameGuard({
        documentLabel: label,
        priorContent: doc(["clean"]),
      }).check({ content: dirty });
      expect(verdict.ok).toBe(false);
      if (verdict.ok) throw new Error("unreachable");
      expect(verdict.detail).toContain(label);
      expectRedacted(verdict.detail);
    }
  });
});

// ── 8. Relocated 52ef3d5b mutation-guard suite (3 tests → HTTP write path) ───

describe("RELOCATED 52ef3d5b mutation-guard suite — append-journal at the HTTP write path", () => {
  let testDir: string;
  let handle: PatchServerHandle | null = null;

  // The source suite ran against temp copies of the REAL ledgers, whose
  // nonzero token baseline exercised the delta semantics. The synthetic
  // analogue: a baseline ledger that ALREADY carries one fixture token.
  function makeBaselineDoc() {
    return {
      document_name: "Knowledge Hub Task List",
      document_purpose: "Synthetic relocation fixture.",
      related_documents: [],
      tasks: [
        {
          id: "20",
          title: "Synthetic task 20",
          description: `Historic baseline mention of ${TOKEN_CI}.`,
          status: "pending",
          priority: "should",
          dependencies: [],
          subtasks: [
            {
              id: "1",
              title: "Slice one",
              description: "First slice.",
              details: "Initial details.",
              status: "pending",
              dependencies: [],
              testStrategy: null,
            },
          ],
          updatedAt: "2026-06-01T12:00:00.000Z",
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

  const CLEAN_APPEND =
    "\nde-ID guard relocation test - clean journal line, no client identity.";
  const DIRTY_APPEND = `\nnames ${TOKEN_CI} and should be blocked.`;

  beforeEach(async () => {
    process.env[CLIENT_NAME_DENYLIST_ENV] = VALID_DENYLIST;
    testDir = await mkdtemp(join(tmpdir(), "client-name-guard-relocation-"));
  });

  afterEach(async () => {
    if (handle) {
      await handle.stop(true);
      handle = null;
    }
    await rm(testDir, { recursive: true, force: true });
  });

  async function startServer(): Promise<{
    url: string;
    ledgerPath: string;
    originalBytes: string;
    baseMtime: string;
  }> {
    const ledgerPath = join(testDir, "task-list.json");
    const originalBytes = JSON.stringify(makeBaselineDoc(), null, 2);
    await writeFile(ledgerPath, originalBytes, "utf8");
    handle = startPatchServer({ ledgerPath, port: 0 });
    const baseMtime = (await stat(ledgerPath)).mtime.toISOString();
    return { url: handle.url, ledgerPath, originalBytes, baseMtime };
  }

  function appendJournal(
    s: { url: string; baseMtime: string },
    appendText: string,
    allowClientName = false,
  ): Promise<Response> {
    return fetch(`${s.url}/api/ledger/record/20`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseMtime: s.baseMtime,
        regenMirrors: false,
        ...(allowClientName ? { allowClientName: true } : {}),
        patches: [
          {
            fieldPath: ["tasks", "20", "subtasks", "1", "details"],
            appendText,
          },
        ],
      }),
    });
  }

  // 52ef3d5b #1: "allows a write that adds NO client-name reference
  // (existing baseline tolerated)"
  test("clean append on a token-BEARING baseline → 200 and the file IS written", async () => {
    const s = await startServer();
    // Baseline is nonzero — the fixture mirrors the real pre-flip ledgers.
    expect(s.originalBytes.toLowerCase()).toContain("zorblian");

    const res = await appendJournal(s, CLEAN_APPEND);
    expect(res.status).toBe(200);
    expectRedacted(await res.text());

    const after = await readFile(s.ledgerPath, "utf8");
    expect(after).not.toBe(s.originalBytes); // it DID write
    expect(after).toContain(
      "clean journal line, no client identity.",
    );
  });

  // 52ef3d5b #2: "rejects a write that introduces a client-name reference"
  test("net-new append → 422 client-name-guard, file byte-identical, body REDACTED", async () => {
    const s = await startServer();

    const res = await appendJournal(s, DIRTY_APPEND);
    expect(res.status).toBe(422);
    const text = await res.text();
    const body = JSON.parse(text) as { error: string };
    expect(body.error).toBe("client-name-guard");
    expectRedacted(text);

    // Nothing written — byte-identical, not merely parse-equal.
    expect(await readFile(s.ledgerPath, "utf8")).toBe(s.originalBytes);
  });

  // 52ef3d5b #3: "allows the introduction under KH_LEDGER_ALLOW_CLIENT_NAME=1
  // with a warning". The env knob relocates to the per-request
  // `allowClientName` option (invariant 33 — U10 envelope).
  test("allowClientName override → 200 with a REDACTED warning; the append lands", async () => {
    const s = await startServer();

    const res = await appendJournal(s, DIRTY_APPEND, true);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as { ok: boolean; warnings?: string[] };
    expect(body.ok).toBe(true);
    const warning = body.warnings?.find((w) => w.includes("client-name-guard"));
    expect(warning).toBeDefined();
    // The RESPONSE stays redacted even though the FILE legitimately carries
    // the appended content now.
    expectRedacted(text);

    const after = await readFile(s.ledgerPath, "utf8");
    expect(after).toContain("and should be blocked.");
  });

  // U11 config-error extension: all three misconfiguration shapes are loud
  // 500s at the HTTP write path — invalid JSON, empty tokens[], legacy
  // comma string (the gate-wiring suite covers the comma shape; this is the
  // full trio per the U11 brief).
  test("invalid JSON / empty tokens[] / legacy comma env → 500 client-name-guard-config, nothing written, body REDACTED", async () => {
    const s = await startServer();
    for (const bad of [
      "{tokens: [oops",
      '{"tokens": []}',
      `${TOKEN_CI},${TOKEN_CS}`,
    ]) {
      process.env[CLIENT_NAME_DENYLIST_ENV] = bad;
      const res = await appendJournal(s, CLEAN_APPEND);
      expect(res.status).toBe(500);
      const text = await res.text();
      const body = JSON.parse(text) as { error: string };
      expect(body.error).toBe("client-name-guard-config");
      expectRedacted(text);
      expect(await readFile(s.ledgerPath, "utf8")).toBe(s.originalBytes);
    }
  });
});
