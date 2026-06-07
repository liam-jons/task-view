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

import {
  CLIENT_NAME_DENYLIST_ENV,
  clientNameGuard,
  countDenylistHits,
  parseDenylist,
} from "./client-name-guard";
import { buildPreWriteGates, runPreWriteGates } from "./gate-chain";

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
