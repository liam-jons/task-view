/**
 * gates/gate-chain.ts — ID-90.7 the SHARED pre-write gate-chain seam.
 *
 * Every mutating handler runs an ORDERED list of pre-write gates against the
 * EXACT serialised bytes about to land (post-serialisation /
 * pre-`atomicWriteFile` — PRODUCT invariant 22's hook point). The chain is
 * explicit — an array of named gates executed in order — so later records
 * register additional gates in ONE place instead of editing every handler:
 *
 *   - U3 record-set gate (this record) — registered via
 *     {@link buildPreWriteGates}.
 *   - U4 client-name guard (record 8) — APPENDS its gate inside
 *     {@link buildPreWriteGates} (post-serialisation / pre-write, reads
 *     `options.allowClientName`, may verdict a config error).
 *
 * Semantics:
 *   - Gates run in registration order.
 *   - The first failing gate SHORT-CIRCUITS the chain; its verdict (error /
 *     detail / HTTP status) is returned, carrying any warnings accumulated
 *     by earlier gates. The caller writes NOTHING.
 *   - On success, all gates' warnings are merged in order for the response
 *     envelope.
 *
 * NOTE: the U2 budget gate is NOT in this chain — it hooks earlier
 * (post-mutation / pre-serialisation, on the parsed snapshot) because it
 * measures field values, not bytes. See gates/budget-gate.ts.
 */

import {
  checkRecordSet,
  type CollectionDescriptor,
  type IdValue,
  type RecordSetDelta,
} from "./record-set-gate";

/** What a pre-write gate sees: the exact bytes about to be written, plus
 * per-request options threaded from the U10 envelope (record 12). */
export interface PreWriteGateContext {
  /** The EXACT serialised bytes about to be handed to atomicWriteFile. */
  content: string;
  /** Per-request gate options. Record 8's client-name guard reads
   * `allowClientName`; absent = defaults (never stored server-side). */
  options?: PreWriteGateOptions;
}

export interface PreWriteGateOptions {
  /** U4 (record 8): downgrade a client-name rejection to a warning. Arrives
   * via the U10 request envelope (record 12); default false. */
  allowClientName?: boolean;
}

export type GateVerdict =
  | { ok: true; warnings: string[] }
  | {
      ok: false;
      error: string;
      detail: string;
      /** HTTP status the handler maps the rejection to. */
      status: number;
      warnings: string[];
    };

/** One named gate in the pre-write chain. */
export interface PreWriteGate {
  name: string;
  check(ctx: PreWriteGateContext): GateVerdict;
}

/** Per-write parameters for the U3 record-set gate. */
export interface RecordSetGateParams {
  /** Names the ledger in violation details (e.g. `task-list`) so
   * cross-ledger transactions report which leg failed. */
  ledgerLabel: string;
  /** Pre-write id-set, captured from the typed document BEFORE mutation. */
  beforeIds: Set<IdValue>;
  descriptor: CollectionDescriptor;
  expectedDelta: RecordSetDelta;
}

/**
 * The U3 record-set gate as a chain member. A violation is an INTERNAL
 * serialisation defect (the oracle passed but the bytes are wrong) → 500.
 */
export function recordSetGate(params: RecordSetGateParams): PreWriteGate {
  return {
    name: "record-set",
    check(ctx) {
      const result = checkRecordSet(
        params.ledgerLabel,
        ctx.content,
        params.beforeIds,
        params.descriptor,
        params.expectedDelta,
      );
      if (result.ok) return { ok: true, warnings: [] };
      return {
        ok: false,
        error: result.error,
        detail: result.detail,
        status: 500,
        warnings: [],
      };
    },
  };
}

/** Everything a mutating handler supplies to assemble its pre-write chain. */
export interface PreWriteGateParams {
  /** U3 record-set preservation — every mutating write supplies these. */
  recordSet: RecordSetGateParams;
}

/**
 * Assemble the standard pre-write gate chain for one ledger write.
 *
 * THE registration point: record 8 appends its client-name guard here
 * (after the record-set gate) and every mutating handler picks it up
 * without further edits.
 */
export function buildPreWriteGates(params: PreWriteGateParams): PreWriteGate[] {
  return [recordSetGate(params.recordSet)];
}

/**
 * Run the chain in order against the bytes about to land. First failure
 * short-circuits (carrying warnings accumulated so far); success merges all
 * warnings in order.
 */
export function runPreWriteGates(
  gates: readonly PreWriteGate[],
  ctx: PreWriteGateContext,
): GateVerdict {
  const warnings: string[] = [];
  for (const gate of gates) {
    const verdict = gate.check(ctx);
    if (!verdict.ok) {
      return { ...verdict, warnings: [...warnings, ...verdict.warnings] };
    }
    warnings.push(...verdict.warnings);
  }
  return { ok: true, warnings };
}
