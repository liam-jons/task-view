/**
 * mutation-options.ts — ID-90.12 U10 per-request mutation-body overrides.
 *
 * TECH T-3 (ratified): the overrides ride as per-request **JSON body
 * fields** on every mutation body — never HTTP headers — and the server
 * holds **no** override state between requests (PRODUCT invariants 26, 33).
 * The façade maps `--dry-run` / `--force` / `--no-regen-mirrors` and the
 * `KH_LEDGER_ALLOW_CLIENT_NAME=1` env to these fields per invocation.
 *
 * Field semantics (PRODUCT invariants 16, 26, 33; TECH §Proposed changes
 * U10):
 *   - `dryRun`          — run the FULL gate chain, return the would-be
 *                         payload, write NOTHING (no canonical write, no
 *                         mirror regen, no mtime change — invariant 16).
 *   - `force`           — downgrade a budget-gate rejection to a
 *                         `(forced) budget-exceeded:` response warning
 *                         (invariant 26; strictly per-invocation).
 *   - `allowClientName` — downgrade a client-name-guard rejection to a
 *                         redacted response warning (invariant 33; never
 *                         bypasses guard CONFIG errors — invariant 35 wins).
 *   - `regenMirrors`    — default true; `false` skips the mirror regen and
 *                         reports it (`mirrorRegen: "suppressed"` — the K2
 *                         mapping surfaces `mirrorStaleReason: 'suppressed'`).
 */

export interface MutationOptions {
  dryRun: boolean;
  force: boolean;
  allowClientName: boolean;
  regenMirrors: boolean;
}

/** The four U10 body fields, in documentation order. */
export const MUTATION_OPTION_KEYS = [
  "dryRun",
  "force",
  "allowClientName",
  "regenMirrors",
] as const;

export type ParseMutationOptionsResult =
  | { ok: true; options: MutationOptions }
  | { ok: false; detail: string };

/**
 * Extract + validate the U10 override fields from a mutation request body.
 * Absent fields apply the per-request defaults (dryRun/force/allowClientName
 * false; regenMirrors true). A PRESENT non-boolean value is a 400-class
 * request error — never silently coerced (the typed-body discipline T-3
 * chose body fields for).
 */
export function parseMutationOptions(
  body: Record<string, unknown>,
): ParseMutationOptionsResult {
  for (const key of MUTATION_OPTION_KEYS) {
    const value = body[key];
    if (value !== undefined && typeof value !== "boolean") {
      return {
        ok: false,
        detail: `${key} must be a boolean when present (got ${typeof value})`,
      };
    }
  }
  return {
    ok: true,
    options: {
      dryRun: body.dryRun === true,
      force: body.force === true,
      allowClientName: body.allowClientName === true,
      regenMirrors: body.regenMirrors !== false,
    },
  };
}
