/**
 * patch-server.ts — TECH §5.1, §5.4, §5.5, §5.6, §5.7, §5.8 patch server.
 *
 * Composes the per-slice primitives shipped earlier in 20.8:
 *   - 20.8a `atomicWriteFile` — TECH §5.3 atomic write-to-temp + rename
 *   - 20.8b `resolveServerHostname` / LOOPBACK_HOSTNAME — TECH §5.8 loopback
 *   - 20.8c `applyPatches` — TECH §5.2 + §5.5 patch application + multi-field
 * with the ID-20.7 schema-detection and mirror-generator primitives:
 *   - `detectSchema` — TECH §2.1 three-way kind discriminator
 *   - `generateMirrors` — TECH §3 mirror generator (idempotent + orphan delete)
 *
 * Endpoints (TECH §5.1):
 *   GET /api/ledger
 *     → { kind, data, mirrorDir, mtime }
 *   GET /api/ledger/record/:recordId
 *     → { kind, record, mirror, mtime }
 *   PATCH /api/ledger/record/:recordId
 *     body: { patches: FieldPatch[], baseMtime: string }
 *     → 200 { ok: true, newMtime }
 *     → 409 Conflict { ok: false, error: 'mtime-mismatch', currentMtime, hint }
 *     → 400 Bad Request { ok: false, error: 'walk-error' | 'schema-error' | ... }
 *     → 500 { ok: false, error: 'write-failed', detail }
 *   POST /api/ledger/regen
 *     body: { baseMtime?: string }
 *     → 200 { ok: true, mirrorDir, written, deleted, newMtime }
 *     → 409 if baseMtime supplied and stale
 *     → 500 on regen failure
 *
 * mtime collision (§5.4 / PRODUCT inv 37):
 *   - `baseMtime` is the file mtime the viewer last loaded. Sent with
 *     every PATCH (and optionally with regen).
 *   - Before applying, we stat the canonical file and compare. If the
 *     on-disk mtime is GREATER than baseMtime (strict, per §5.4 "current
 *     > baseMtime"), return 409 with currentMtime so the client can
 *     offer "Reload from disk" + preserve textarea in localStorage
 *     (PRODUCT inv 37).
 *   - mtime is exchanged as the ISO 8601 string form of `stat.mtime.toISOString()`
 *     to avoid floating-point precision pitfalls across JSON parse cycles.
 *
 * Multi-field save (§5.5 / PRODUCT inv 38):
 *   - Single PATCH may carry N FieldPatches; applyPatches walks all then
 *     does ONE Zod parse. Mirror regen runs ONCE at the end. NOT once per
 *     field.
 *
 * Tier 2.2 hook non-coupling (§5.6):
 *   - The patch server writes via `Bun.write` / `fs.rename` (atomicWriteFile),
 *     NOT via the Claude Code Write tool. The KH .claude/settings.json
 *     PreToolUse hook fires only on Claude tool calls; subprocess I/O is
 *     not intercepted. No special handling required.
 *
 * Concurrency / no file locking (§5.7):
 *   - Multiple tabs / processes against the same canonical: each holds
 *     its own baseMtime; the second writer loses with 409. No flock(2).
 *
 * Loopback-only bind (§5.8 / PRODUCT inv 44):
 *   - `Bun.serve({ port, hostname: resolveServerHostname(opts.hostname) })`.
 *     resolveServerHostname canonicalises loopback variants and REJECTS
 *     non-loopback (throws). Never silently downgrade.
 *
 * Patch-value logging (TECH OQ-T3 ratification):
 *   - Server emits NO log lines containing patch values. If logging is
 *     ever added it must follow OQ-T3: { method, path, fieldPaths,
 *     mtime, outcome } shape — fieldPaths only, never values. For now
 *     the server is silent on the happy path; errors surface to the
 *     HTTP response only.
 */

import { stat } from "node:fs/promises";
import { ZodError } from "zod";

import { detectSchema, type DetectSchemaResult } from "./detect-schema";
import {
  generateMirrors,
  resolveMirrorDir,
  computeRecordFilename,
  computeMirrorDirName,
  sanitiseFilenameStem,
} from "./mirror-generator";
import {
  applyPatches,
  type ApplyPatchesResult,
  type FieldPatch,
} from "./patch-apply";
import { atomicWriteFile } from "./atomic-write";
import {
  LOOPBACK_HOSTNAME,
  resolveServerHostname,
} from "./loopback-bind";

// ── Public types ──────────────────────────────────────────────────────────────

export interface PatchServerOptions {
  /** Absolute or process-relative path to the canonical ledger JSON. */
  ledgerPath: string;
  /** Port for Bun.serve. 0 = OS-assigned (recommended for tests). */
  port?: number;
  /** Optional hostname override — must be a loopback variant (§5.8). */
  hostname?: string;
  /**
   * Optional per-request callback fired BEFORE the patch-server's
   * dispatcher runs. The caller (e.g. `startTaskViewServer` in ledger.ts)
   * uses this to track `last_request_at` for browser-close detection
   * (TECH §6.5 / PRODUCT inv 50). Errors thrown from this callback are
   * swallowed so a buggy tracker can never break the HTTP layer.
   *
   * NOT exposed via the bare HTTP API surface — purely a lifecycle
   * hook for the wrapping `startTaskViewServer` factory.
   */
  onRequest?: (request: Request) => void;
}

export interface PatchServerHandle {
  url: string;
  port: number;
  hostname: string;
  /** Stop the server and release the port. Force=true closes in-flight requests. */
  stop: (force?: boolean) => Promise<void>;
}

// ── Internal: fetch handler factory ──────────────────────────────────────────

interface RequestContext {
  ledgerPath: string;
}

async function readCanonical(ledgerPath: string): Promise<{
  rawText: string;
  detected: DetectSchemaResult;
  mtimeIso: string;
}> {
  const file = Bun.file(ledgerPath);
  const rawText = await file.text();
  const parsed = JSON.parse(rawText);
  const detected = detectSchema(parsed);
  const st = await stat(ledgerPath);
  const mtimeIso = st.mtime.toISOString();
  return { rawText, detected, mtimeIso };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  // Loopback-only server (PRODUCT inv 44) so CORS is irrelevant; we
  // explicitly omit Access-Control-Allow-Origin to avoid unintentional
  // cross-origin leakage.
  return new Response(JSON.stringify(body), { ...init, headers });
}

/**
 * Look up a record by id within a parsed ledger.
 * Returns the record object + (for task-list) the kind-specific shape
 * the client expects, or null if not found.
 */
function lookupRecord(
  detected: Exclude<DetectSchemaResult, { kind: "unknown" }>,
  recordId: string,
): { kind: string; record: unknown } | null {
  if (detected.kind === "task-list") {
    const task = detected.data.tasks.find((t) => t.id === recordId);
    if (!task) return null;
    return { kind: "task", record: task };
  }
  if (detected.kind === "roadmap") {
    // recordId may match either a section.id or an item.id (or
    // 'section-<id>' to disambiguate against item collisions). We accept
    // both forms — the client URL uses raw ids for items and the prefix
    // form for sections to mirror the filename rule (TECH §3.2).
    const sectionPrefix = "section-";
    if (recordId.startsWith(sectionPrefix)) {
      const rawSectionId = recordId.slice(sectionPrefix.length);
      const section = detected.data.sections.find((s) => s.id === rawSectionId);
      if (!section) return null;
      return { kind: "roadmap-section", record: section };
    }
    for (const section of detected.data.sections) {
      const item = section.items.find((it) => it.id === recordId);
      if (item) return { kind: "roadmap-item", record: item };
    }
    // Fallback: also match section by raw id (no prefix) for callers
    // that omit the prefix.
    const section = detected.data.sections.find((s) => s.id === recordId);
    if (section) return { kind: "roadmap-section", record: section };
    return null;
  }
  // backlog
  const item = detected.data.items.find((it) => it.id === recordId);
  if (!item) return null;
  return { kind: "backlog-item", record: item };
}

function computeMirrorFilename(
  detected: Exclude<DetectSchemaResult, { kind: "unknown" }>,
  recordId: string,
  recordKind: string,
): string {
  if (recordKind === "task") {
    return computeRecordFilename("task-list", { id: recordId });
  }
  if (recordKind === "roadmap-section") {
    // recordId might still have the 'section-' prefix passed in by the
    // client; strip it before computing the filename so the substitution
    // doesn't double-prefix.
    const sectionPrefix = "section-";
    const rawId = recordId.startsWith(sectionPrefix)
      ? recordId.slice(sectionPrefix.length)
      : recordId;
    return computeRecordFilename("roadmap", { id: rawId, isSection: true });
  }
  if (recordKind === "roadmap-item") {
    return computeRecordFilename("roadmap", { id: recordId });
  }
  // backlog-item
  return computeRecordFilename("backlog", { id: recordId });
}

/**
 * Serialise the parsed ledger back to JSON with the same indent as the
 * existing ledgers (2-space, per the canonical KH ledger files).
 */
function serialiseLedger(detected: Exclude<DetectSchemaResult, { kind: "unknown" }>): string {
  return JSON.stringify(detected.data, null, 2);
}

async function handleGetLedger(ctx: RequestContext): Promise<Response> {
  let canonical;
  try {
    canonical = await readCanonical(ctx.ledgerPath);
  } catch (err) {
    return jsonResponse(
      { ok: false, error: "ledger-read-failed", detail: (err as Error).message },
      { status: 500 },
    );
  }
  if (canonical.detected.kind === "unknown") {
    return jsonResponse(
      {
        ok: false,
        error: "unknown-document-name",
        documentName: canonical.detected.documentName,
      },
      { status: 422 },
    );
  }
  const mirrorDir = resolveMirrorDir(canonical.detected.kind, ctx.ledgerPath);
  return jsonResponse({
    ok: true,
    kind: canonical.detected.kind,
    data: canonical.detected.data,
    mirrorDir,
    mirrorDirName: computeMirrorDirName(canonical.detected.kind),
    mtime: canonical.mtimeIso,
  });
}

async function handleGetRecord(
  ctx: RequestContext,
  recordId: string,
): Promise<Response> {
  let canonical;
  try {
    canonical = await readCanonical(ctx.ledgerPath);
  } catch (err) {
    return jsonResponse(
      { ok: false, error: "ledger-read-failed", detail: (err as Error).message },
      { status: 500 },
    );
  }
  if (canonical.detected.kind === "unknown") {
    return jsonResponse(
      {
        ok: false,
        error: "unknown-document-name",
        documentName: canonical.detected.documentName,
      },
      { status: 422 },
    );
  }
  const detected = canonical.detected;
  const lookup = lookupRecord(detected, recordId);
  if (!lookup) {
    return jsonResponse(
      { ok: false, error: "record-not-found", recordId },
      { status: 404 },
    );
  }
  const mirrorFilename = computeMirrorFilename(
    detected,
    sanitiseFilenameStem(
      lookup.kind === "roadmap-section" && recordId.startsWith("section-")
        ? recordId.slice("section-".length)
        : recordId,
    ),
    lookup.kind,
  );
  return jsonResponse({
    ok: true,
    kind: lookup.kind,
    record: lookup.record,
    mirrorFilename,
    mtime: canonical.mtimeIso,
  });
}

function walkErrorStatus(result: ApplyPatchesResult<unknown>): number {
  if (result.ok) return 200;
  if (result.kind === "empty-patches") return 400;
  if (result.kind === "walk-error") return 400;
  if (result.kind === "schema-error") return 422;
  if (result.kind === "kind-mismatch") return 400;
  return 500;
}

async function handlePatchRecord(
  ctx: RequestContext,
  recordId: string,
  request: Request,
): Promise<Response> {
  let body: { patches?: unknown; baseMtime?: unknown };
  try {
    body = (await request.json()) as { patches?: unknown; baseMtime?: unknown };
  } catch (err) {
    return jsonResponse(
      { ok: false, error: "invalid-json", detail: (err as Error).message },
      { status: 400 },
    );
  }
  if (typeof body.baseMtime !== "string" || body.baseMtime === "") {
    return jsonResponse(
      { ok: false, error: "missing-baseMtime" },
      { status: 400 },
    );
  }
  if (!Array.isArray(body.patches)) {
    return jsonResponse(
      { ok: false, error: "missing-patches" },
      { status: 400 },
    );
  }
  const patches = body.patches as FieldPatch[];

  let canonical;
  try {
    canonical = await readCanonical(ctx.ledgerPath);
  } catch (err) {
    return jsonResponse(
      { ok: false, error: "ledger-read-failed", detail: (err as Error).message },
      { status: 500 },
    );
  }
  if (canonical.detected.kind === "unknown") {
    return jsonResponse(
      {
        ok: false,
        error: "unknown-document-name",
        documentName: canonical.detected.documentName,
      },
      { status: 422 },
    );
  }

  // §5.4 mtime check — BEFORE patch apply. Compare ISO strings as Date
  // values to be robust to formatting differences (millisecond precision
  // preserved on both sides).
  const baseMtimeMs = Date.parse(body.baseMtime);
  const currentMtimeMs = Date.parse(canonical.mtimeIso);
  if (!Number.isFinite(baseMtimeMs)) {
    return jsonResponse(
      { ok: false, error: "invalid-baseMtime", detail: body.baseMtime },
      { status: 400 },
    );
  }
  if (currentMtimeMs > baseMtimeMs) {
    // PRODUCT inv 37: 409 Conflict; client offers Reload + preserves
    // textarea content in localStorage.
    return jsonResponse(
      {
        ok: false,
        error: "mtime-mismatch",
        currentMtime: canonical.mtimeIso,
        hint: "ledger changed underneath you — reload from disk and re-apply your edit",
      },
      { status: 409 },
    );
  }

  // §5.5 apply patches single-pass. structuredClone the parsed snapshot
  // so a mid-walk mutation does NOT leak into our in-memory canonical
  // copy (we re-read anyway, but cleanliness first).
  const detectedForPatch = {
    kind: canonical.detected.kind,
    data: structuredClone(canonical.detected.data) as typeof canonical.detected.data,
  } as Exclude<DetectSchemaResult, { kind: "unknown" }>;

  const applyResult = applyPatches(detectedForPatch, patches);

  if (!applyResult.ok) {
    if (applyResult.kind === "schema-error") {
      // Surface the formatted ZodError so the viewer can render inline
      // per PRODUCT inv 29.
      return jsonResponse(
        {
          ok: false,
          error: "schema-error",
          issues: applyResult.zodError.issues,
        },
        { status: walkErrorStatus(applyResult) },
      );
    }
    if (applyResult.kind === "walk-error") {
      return jsonResponse(
        {
          ok: false,
          error: "walk-error",
          fieldPath: applyResult.fieldPath,
          detail: applyResult.detail,
        },
        { status: walkErrorStatus(applyResult) },
      );
    }
    return jsonResponse(
      { ok: false, error: applyResult.kind },
      { status: walkErrorStatus(applyResult) },
    );
  }

  // Serialise + atomic write.
  // Reconstruct a typed `detected` so generateMirrors sees the right
  // discriminant + parsed shape.
  const serialisedDetected = {
    kind: canonical.detected.kind,
    data: applyResult.parsed,
  } as Exclude<DetectSchemaResult, { kind: "unknown" }>;
  const serialised = serialiseLedger(serialisedDetected);

  try {
    await atomicWriteFile(ctx.ledgerPath, serialised);
  } catch (err) {
    return jsonResponse(
      { ok: false, error: "write-failed", detail: (err as Error).message },
      { status: 500 },
    );
  }

  // §5.5 mirror regen — runs ONCE after the whole multi-field PATCH,
  // not once per field. Even when only one field was patched, the
  // single-call shape is preserved for symmetry.
  let regen;
  try {
    regen = await generateMirrors(serialisedDetected, ctx.ledgerPath);
  } catch (err) {
    // The canonical wrote successfully; mirror regen failed. Surface
    // a soft error — the client can still re-issue a regen request.
    const newMtime = (await stat(ctx.ledgerPath)).mtime.toISOString();
    return jsonResponse(
      {
        ok: false,
        error: "mirror-regen-failed",
        detail: (err as Error).message,
        canonicalWritten: true,
        newMtime,
      },
      { status: 500 },
    );
  }

  // Fresh stat after the rename to surface the new mtime to the client.
  const newMtime = (await stat(ctx.ledgerPath)).mtime.toISOString();
  return jsonResponse({
    ok: true,
    newMtime,
    recordId,
    mirrorDir: regen.mirrorDir,
    mirrorsWritten: regen.written,
    mirrorsDeleted: regen.deleted,
  });
}

async function handlePostRegen(
  ctx: RequestContext,
  request: Request,
): Promise<Response> {
  let body: { baseMtime?: unknown } = {};
  try {
    body = (await request.json()) as { baseMtime?: unknown };
  } catch {
    // Empty body is acceptable for regen; default to no baseMtime check.
    body = {};
  }

  let canonical;
  try {
    canonical = await readCanonical(ctx.ledgerPath);
  } catch (err) {
    return jsonResponse(
      { ok: false, error: "ledger-read-failed", detail: (err as Error).message },
      { status: 500 },
    );
  }
  if (canonical.detected.kind === "unknown") {
    return jsonResponse(
      {
        ok: false,
        error: "unknown-document-name",
        documentName: canonical.detected.documentName,
      },
      { status: 422 },
    );
  }

  if (typeof body.baseMtime === "string" && body.baseMtime !== "") {
    const baseMtimeMs = Date.parse(body.baseMtime);
    const currentMtimeMs = Date.parse(canonical.mtimeIso);
    if (Number.isFinite(baseMtimeMs) && currentMtimeMs > baseMtimeMs) {
      return jsonResponse(
        {
          ok: false,
          error: "mtime-mismatch",
          currentMtime: canonical.mtimeIso,
        },
        { status: 409 },
      );
    }
  }

  try {
    const regen = await generateMirrors(canonical.detected, ctx.ledgerPath);
    return jsonResponse({
      ok: true,
      mirrorDir: regen.mirrorDir,
      mirrorsWritten: regen.written,
      mirrorsDeleted: regen.deleted,
      mtime: canonical.mtimeIso,
    });
  } catch (err) {
    return jsonResponse(
      { ok: false, error: "regen-failed", detail: (err as Error).message },
      { status: 500 },
    );
  }
}

/**
 * Build the per-request dispatcher. Pure function — no closure state
 * other than `ctx`.
 */
function buildFetchHandler(ctx: RequestContext) {
  return async function fetchHandler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // GET /api/ledger
    if (path === "/api/ledger" && request.method === "GET") {
      return handleGetLedger(ctx);
    }

    // GET / PATCH /api/ledger/record/:recordId
    const recordMatch = path.match(/^\/api\/ledger\/record\/(.+)$/);
    if (recordMatch) {
      const recordId = decodeURIComponent(recordMatch[1]);
      if (request.method === "GET") {
        return handleGetRecord(ctx, recordId);
      }
      if (request.method === "PATCH") {
        return handlePatchRecord(ctx, recordId, request);
      }
      return jsonResponse(
        { ok: false, error: "method-not-allowed" },
        { status: 405, headers: { allow: "GET, PATCH" } },
      );
    }

    // POST /api/ledger/regen
    if (path === "/api/ledger/regen" && request.method === "POST") {
      return handlePostRegen(ctx, request);
    }

    return jsonResponse(
      { ok: false, error: "not-found", path },
      { status: 404 },
    );
  };
}

// ── Public: server factory ────────────────────────────────────────────────────

/**
 * Start the patch server. Loopback-only (§5.8 enforced via
 * resolveServerHostname). Returns a handle with the live URL + port +
 * a stop() function.
 *
 * The caller is responsible for:
 *   - Awaiting the returned promise (server is ready when it resolves).
 *   - Calling handle.stop() when done (releases the port).
 *
 * Throws (rejects) when the hostname override is non-loopback —
 * security-relevant per PRODUCT inv 44 / TECH §5.8.
 */
export function startPatchServer(
  opts: PatchServerOptions,
): PatchServerHandle {
  const hostname = resolveServerHostname(opts.hostname); // throws if non-loopback
  // Default to OS-assigned port (0) when caller doesn't specify. Port
  // retry policy (§6.6) lands in 20.11 — for 20.8 we expose the bare
  // Bun.serve behaviour.
  const port = opts.port ?? 0;

  const ctx: RequestContext = { ledgerPath: opts.ledgerPath };
  const fetchHandler = buildFetchHandler(ctx);
  const onRequest = opts.onRequest;

  // Wrap the dispatcher to fire `onRequest` BEFORE the body handler.
  // Errors from `onRequest` are swallowed so a buggy tracker cannot
  // break the HTTP layer (per the onRequest doc-comment).
  const wrappedFetch: typeof fetchHandler = async (request) => {
    if (onRequest) {
      try {
        onRequest(request);
      } catch {
        // Intentional: tracker errors must not surface to HTTP clients.
      }
    }
    return fetchHandler(request);
  };

  const server = Bun.serve({
    port,
    hostname,
    fetch: wrappedFetch,
  });

  // Bun.serve types server.port as number | undefined to cover the
  // edge case of unix-socket binds (which task-view does not use; we
  // always bind to a TCP loopback address). Coerce here to surface a
  // hard error if Bun ever returns undefined unexpectedly rather than
  // silently emitting `NaN` into the URL.
  if (typeof server.port !== "number") {
    throw new Error(
      "Bun.serve returned a non-numeric port — task-view requires a TCP bind.",
    );
  }
  const boundPort = server.port;

  return {
    url: `http://${hostname}:${boundPort}`,
    port: boundPort,
    hostname,
    stop: async (force = true) => {
      server.stop(force);
    },
  };
}

// Re-export so callers can import the bind constant from this module
// surface without reaching into loopback-bind.ts directly.
export { LOOPBACK_HOSTNAME };
