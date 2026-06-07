/**
 * gates/client-name-guard.ts — ID-90 U4 the client-name guard (de-ID gate).
 *
 * Port of the KH ledger-CLI `guardClientName` (245c35ac lineage) onto the
 * patch-server's shared pre-write gate chain (PRODUCT invariants 28–35),
 * with two deliberate departures from the 245c35ac source:
 *
 *   1. STRICT JSON denylist parsing (T-1). `KH_CLIENT_NAME_DENYLIST` is the
 *      full canonical denylist JSON — `tokens[].{value, class,
 *      case_insensitive}` plus `exclusion_patterns[]`. The shape predicate
 *      mirrors identity-guard.yml:89 (`tokens` present, non-empty array). A
 *      legacy comma-separated value is a LOUD configuration error — it is
 *      NEVER comma-split (the bl-244 root cause was a JSON secret silently
 *      comma-split into garbage tokens).
 *
 *   2. FULL REDACTION (invariant 32). The 245c35ac rejection/override
 *      messages interpolated the joined denylist (`[${names}]`) — a
 *      redaction defect deliberately NOT ported. No token value, pattern
 *      text, or matched content ever appears in a verdict, response body,
 *      warning, or log line. The guard emits NO log lines at all; details
 *      carry delta counts + the document label only.
 *
 * Semantics:
 *   - NET-NEW DELTA (invariant 31): a write is rejected only when the total
 *     denylist-hit count over the bytes-about-to-be-written EXCEEDS the
 *     count over the prior on-disk bytes. Equal or decreasing counts pass
 *     (sanitising edits must not be blocked).
 *   - Per-token case flags (invariant 30): each token matches under its own
 *     `case_insensitive` flag (`'gi'` vs `'g'` — identity-guard.yml:384–390
 *     model), never one global flag.
 *   - `exclusion_patterns[]` parse-but-IGNORE (OQ-7 Semantics B, RATIFIED
 *     Liam S322): carve-outs never apply to the byte-delta count — the
 *     `allowClientName` override is the escape hatch. Pattern TEXT is not
 *     even retained after parsing (leak-surface minimisation); only a count
 *     survives for observability.
 *   - `options.allowClientName` (invariant 33): downgrades a rejection to a
 *     single redacted warning and allows the write. It does NOT bypass
 *     configuration errors (invariant 35 wins).
 *   - Unset/empty env → guard inactive locally; under `requireDenylist`
 *     (the record-11 `--require-denylist` flag, passed when CI is truthy)
 *     unset is the same loud config error (invariant 34).
 *   - Set-but-invalid env → 500 `client-name-guard-config` blocking every
 *     mutation in every context (invariant 35) — misconfiguration never
 *     silently disables the guard.
 */

import type { PreWriteGate } from "./gate-chain";

/** The ONE env knob (PRODUCT invariant 29; same secret the CI identity
 * guard consumes). */
export const CLIENT_NAME_DENYLIST_ENV = "KH_CLIENT_NAME_DENYLIST";

export interface DenylistToken {
  value: string;
  case_insensitive: boolean;
  /** Carried by the canonical shape; not used in matching. */
  class?: string;
}

export interface ClientNameDenylist {
  tokens: DenylistToken[];
  /** `exclusion_patterns[]` are parsed-but-IGNORED (OQ-7 Semantics B). The
   * pattern text is deliberately NOT retained — only the count, so the
   * parsed config can never leak carve-out text into any surface. */
  exclusionPatternCount: number;
}

/**
 * Discriminated configuration result. `unset` is distinct from `invalid` so
 * the record-11 `--require-denylist` lifecycle flag can escalate `unset` to
 * the same loud config error without re-parsing (invariant 34).
 */
export type DenylistConfig =
  | { state: "unset" }
  | { state: "active"; denylist: ClientNameDenylist }
  | {
      state: "invalid";
      /** REDACTED — describes the shape defect generically; never echoes
       * the raw env value, a token, or a pattern (invariant 32). */
      reason: string;
    };

/**
 * STRICT JSON denylist parser (T-1). Shape predicate mirrors
 * identity-guard.yml:89: parsed JSON object with a non-empty `tokens[]`
 * array; each token additionally needs the fields the matcher depends on
 * (`value` non-empty string, `case_insensitive` boolean). Anything else —
 * including a legacy comma-separated string — is `invalid`, never
 * comma-split.
 */
export function parseDenylist(raw: string | undefined): DenylistConfig {
  if (raw === undefined || raw.trim() === "") return { state: "unset" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      state: "invalid",
      reason:
        `${CLIENT_NAME_DENYLIST_ENV} is not valid JSON. Legacy ` +
        "comma-separated denylists are not accepted (T-1) — supply the " +
        "canonical denylist JSON ({tokens: [...]}).",
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      state: "invalid",
      reason: `${CLIENT_NAME_DENYLIST_ENV} must be a JSON object with a non-empty tokens[] array.`,
    };
  }

  const tokens = (parsed as { tokens?: unknown }).tokens;
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return {
      state: "invalid",
      reason: `${CLIENT_NAME_DENYLIST_ENV} is missing a non-empty tokens[] array.`,
    };
  }

  const parsedTokens: DenylistToken[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Record<string, unknown> | null;
    if (
      typeof t !== "object" ||
      t === null ||
      typeof t.value !== "string" ||
      t.value.length === 0 ||
      typeof t.case_insensitive !== "boolean"
    ) {
      return {
        state: "invalid",
        // Index only — never the malformed entry's content.
        reason: `${CLIENT_NAME_DENYLIST_ENV} tokens[${i}] is malformed (expected {value: non-empty string, case_insensitive: boolean}).`,
      };
    }
    parsedTokens.push({
      value: t.value,
      case_insensitive: t.case_insensitive,
      ...(typeof t.class === "string" ? { class: t.class } : {}),
    });
  }

  const exclusionPatterns = (parsed as { exclusion_patterns?: unknown })
    .exclusion_patterns;
  if (exclusionPatterns !== undefined && !Array.isArray(exclusionPatterns)) {
    return {
      state: "invalid",
      reason: `${CLIENT_NAME_DENYLIST_ENV} exclusion_patterns must be an array when present.`,
    };
  }

  return {
    state: "active",
    denylist: {
      tokens: parsedTokens,
      exclusionPatternCount: exclusionPatterns?.length ?? 0,
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Total denylist-hit count over `text`. Per-token regex-escaped matcher
 * honouring each token's `case_insensitive` flag (`'gi'` vs `'g'` —
 * identity-guard.yml:384–390 model; never one global flag, invariant 30).
 */
export function countDenylistHits(
  denylist: ClientNameDenylist,
  text: string,
): number {
  let total = 0;
  for (const token of denylist.tokens) {
    const re = new RegExp(
      escapeRegExp(token.value),
      token.case_insensitive ? "gi" : "g",
    );
    total += text.match(re)?.length ?? 0;
  }
  return total;
}

export interface ClientNameGuardParams {
  /** Names the document in redacted details (e.g. `task-list`) so
   * cross-ledger transactions report which leg rejected. */
  documentLabel: string;
  /** The prior on-disk canonical bytes (`rawText` at load) — the BEFORE
   * side of the net-new delta (invariant 31). */
  priorContent: string;
  /** Record-11 `--require-denylist` seam (invariant 34): when true, an
   * unset denylist is the same loud config error as an invalid one.
   * Default false (unset → guard inactive). */
  requireDenylist?: boolean;
}

/**
 * The U4 client-name guard as a pre-write chain member. Registered by
 * {@link import("./gate-chain").buildPreWriteGates} after the record-set
 * gate, so every mutating write path — PATCH / POST / DELETE / each
 * transaction leg — evaluates the exact bytes about to land (invariant 28).
 *
 * The denylist env is resolved at CHECK time (per request), so a config fix
 * takes effect without a server restart and tests can drive every state.
 */
export function clientNameGuard(params: ClientNameGuardParams): PreWriteGate {
  return {
    name: "client-name-guard",
    check(ctx) {
      const config = parseDenylist(process.env[CLIENT_NAME_DENYLIST_ENV]);

      if (config.state === "invalid") {
        return {
          ok: false,
          error: "client-name-guard-config",
          detail: config.reason,
          status: 500,
          warnings: [],
        };
      }

      if (config.state === "unset") {
        if (params.requireDenylist) {
          return {
            ok: false,
            error: "client-name-guard-config",
            detail:
              `${CLIENT_NAME_DENYLIST_ENV} is unset or empty but this server ` +
              "requires a denylist (--require-denylist). Sync the canonical " +
              "denylist secret before mutating.",
            status: 500,
            warnings: [],
          };
        }
        return { ok: true, warnings: [] };
      }

      const before = countDenylistHits(config.denylist, params.priorContent);
      const after = countDenylistHits(config.denylist, ctx.content);
      if (after <= before) return { ok: true, warnings: [] };

      const delta = after - before;
      if (ctx.options?.allowClientName) {
        // Invariant 33: override → redacted warning + allow. Counts + label
        // only — never the matched content.
        return {
          ok: true,
          warnings: [
            `client-name-guard: net-new denylist hits on ${params.documentLabel} (+${delta}) allowed by override`,
          ],
        };
      }

      // Invariant 32: counts + document label ONLY. The 245c35ac
      // `[${names}]` interpolation is deliberately not ported.
      return {
        ok: false,
        error: "client-name-guard",
        detail:
          `net-new client-name denylist hits on ${params.documentLabel}: ` +
          `+${delta} (before ${before}, after ${after}). De-identify the ` +
          "content, or use the allow-client-name override for a legitimate " +
          "de-ID journal entry.",
        status: 422,
        warnings: [],
      };
    },
  };
}
