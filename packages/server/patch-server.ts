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
import { dirname, join } from "node:path";

import { detectSchema, type DetectSchemaResult } from "./detect-schema";
import {
  generateMirrors,
  generateRecordMirror,
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
import { insertRecord, removeRecord } from "./record-mutate";
import { promoteTransaction } from "./ledger-transaction";
import { scanForLedgers } from "./path-resolution";
import { LOOPBACK_HOSTNAME, resolveServerHostname } from "./loopback-bind";
import { renderViewer } from "./render-viewer";
import { getClientBundle } from "./client-bundle";
import { getViewerStyles } from "./viewer-styles";
import { resolveThemePreference } from "@task-view/ui/record-view/theme-preference";

// ── Public types ──────────────────────────────────────────────────────────────

export interface PatchServerOptions {
  /** Absolute or process-relative path to the canonical ledger JSON. */
  ledgerPath: string;
  /** Port for Bun.serve. 0 = OS-assigned (recommended for tests). */
  port?: number;
  /** Optional hostname override — must be a loopback variant (§5.8). */
  hostname?: string;
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
    // Roadmap shape note (ID-20.19): the Phase-B themes[] roadmap replaced
    // the retired sections[]/items[] model. A roadmap record is a theme
    // resolved by its bare-digit id; the old `section-` prefix form is gone.
    const theme = detected.data.themes.find((t) => t.id === recordId);
    if (!theme) return null;
    return { kind: "roadmap-theme", record: theme };
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
  if (recordKind === "roadmap-theme") {
    return computeRecordFilename("roadmap", { id: recordId });
  }
  // backlog-item
  return computeRecordFilename("backlog", { id: recordId });
}

/**
 * Serialise the parsed ledger back to JSON with the same indent as the
 * existing ledgers (2-space, per the canonical KH ledger files).
 */
function serialiseLedger(
  detected: Exclude<DetectSchemaResult, { kind: "unknown" }>,
): string {
  return JSON.stringify(detected.data, null, 2);
}

/**
 * GET / — SSR-rendered viewer (Subtask 20.17).
 *
 * Reads the canonical via the same `readCanonical` gate the JSON endpoints
 * use, then defers shape-specific rendering to {@link renderViewer}.
 *
 * Routing:
 *   /                           → ledger index page
 *   /?record=ID-N               → per-record page
 *   /?record=<theme-id>         → roadmap theme page
 *   /?track=…&status=…&priority=… → backlog index with filter state (PRODUCT inv 23)
 *
 * Responses:
 *   200 text/html on success.
 *   404 text/html when ?record=… does not resolve.
 *   422 application/json when document_name is unknown (matches the
 *       JSON endpoints' shape — clients can disambiguate by Content-Type).
 *   500 application/json on ledger read failure.
 */
async function handleGetRoot(
  ctx: RequestContext,
  search: URLSearchParams,
  cookieHeader: string | null,
): Promise<Response> {
  let canonical;
  try {
    canonical = await readCanonical(ctx.ledgerPath);
  } catch (err) {
    return jsonResponse(
      {
        ok: false,
        error: "ledger-read-failed",
        detail: (err as Error).message,
      },
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
  // Resolve the theme preference (record-view-styling SPEC SV-8): query
  // override > cookie (the SAME keys ThemeProvider writes) > default
  // task-view/dark. Then assemble the inline stylesheet + <html> class
  // (cached at boot; safety-stylesheet fallback on a read failure — never
  // throws). The server READS the cookie but writes none (SV-10).
  const pref = resolveThemePreference({ cookieHeader, query: search });
  const styles = await getViewerStyles(pref.themeId, pref.mode);

  const result = renderViewer({
    detected: canonical.detected,
    search,
    clientScriptSrc: CLIENT_BUNDLE_ROUTE,
    styles,
  });
  return new Response(result.html, {
    status: result.status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * Route the SSR HTML references for the progressive-enhancement client
 * bundle (ID-20.24). Served as a standalone resource rather than inlined,
 * so the ~1MB minified bundle is fetched once + revalidated cheaply
 * instead of re-shipped inside every page's HTML.
 */
const CLIENT_BUNDLE_ROUTE = "/client.js";

/**
 * GET /client.js — serve the boot-built client bundle from memory with a
 * content-derived weak ETag so the browser caches it across navigations
 * and revalidates with a cheap 304. The ETag changes when the server
 * restarts with a rebuilt bundle, so there is no stale-after-restart trap.
 * getClientBundle() returns an inert fallback on build failure (never
 * throws), so this route always 200s.
 */
async function handleGetClientBundle(request: Request): Promise<Response> {
  const js = await getClientBundle();
  const etag = `W/"${Bun.hash(js).toString(16)}"`;
  const headers: Record<string, string> = {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "no-cache",
    etag,
  };
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(js, { status: 200, headers });
}

async function handleGetLedger(ctx: RequestContext): Promise<Response> {
  let canonical;
  try {
    canonical = await readCanonical(ctx.ledgerPath);
  } catch (err) {
    return jsonResponse(
      {
        ok: false,
        error: "ledger-read-failed",
        detail: (err as Error).message,
      },
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
      {
        ok: false,
        error: "ledger-read-failed",
        detail: (err as Error).message,
      },
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
    sanitiseFilenameStem(recordId),
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
      {
        ok: false,
        error: "ledger-read-failed",
        detail: (err as Error).message,
      },
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
    data: structuredClone(
      canonical.detected.data,
    ) as typeof canonical.detected.data,
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

  // §5.5 mirror regen — runs ONCE after the whole multi-field PATCH, not
  // once per field. Subtask 20.23 (PRODUCT inv 38): scope the regen to the
  // touched record's mirror ONLY. A field PATCH mutates fields within one
  // existing record — it can never add or remove records — so unaffected
  // mirrors stay byte-identical (mtime stable). The prior full-ledger
  // regen rewrote every mirror (20.16 S10 / Side-observation 5).
  let regen;
  try {
    regen = await generateRecordMirror(
      serialisedDetected,
      ctx.ledgerPath,
      recordId,
    );
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

/**
 * POST /api/ledger/record — CREATE a new record (ID-20.15).
 *
 * Body: { baseMtime: string, record: <full record object> }
 *   → 201 { ok: true, newMtime, recordId, mirrorsWritten, ... }
 *   → 409 { error: 'mtime-mismatch' } stale baseMtime
 *   → 409 { error: 'duplicate-id' }   record id already present
 *   → 422 { error: 'schema-error', issues } record fails its schema
 *   → 400 invalid body / mtime
 *
 * Honours the SAME safety guarantees as PATCH: mtime collision → 409,
 * atomic write, single Zod re-parse of the WHOLE ledger (so document-level
 * invariants — backlog unique-id, task sibling-deps — run), scoped mirror
 * regen for the new record.
 */
async function handlePostRecord(
  ctx: RequestContext,
  request: Request,
): Promise<Response> {
  let body: { baseMtime?: unknown; record?: unknown };
  try {
    body = (await request.json()) as { baseMtime?: unknown; record?: unknown };
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
  if (body.record == null || typeof body.record !== "object") {
    return jsonResponse(
      { ok: false, error: "missing-record" },
      { status: 400 },
    );
  }

  let canonical;
  try {
    canonical = await readCanonical(ctx.ledgerPath);
  } catch (err) {
    return jsonResponse(
      {
        ok: false,
        error: "ledger-read-failed",
        detail: (err as Error).message,
      },
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

  // §5.4 mtime check — BEFORE mutation.
  const baseMtimeMs = Date.parse(body.baseMtime);
  if (!Number.isFinite(baseMtimeMs)) {
    return jsonResponse(
      { ok: false, error: "invalid-baseMtime", detail: body.baseMtime },
      { status: 400 },
    );
  }
  if (Date.parse(canonical.mtimeIso) > baseMtimeMs) {
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

  const result = insertRecord(canonical.detected, body.record);
  if (!result.ok) {
    if (result.kind === "duplicate-id") {
      return jsonResponse(
        { ok: false, error: "duplicate-id", recordId: result.recordId },
        { status: 409 },
      );
    }
    if (result.kind === "schema-error") {
      return jsonResponse(
        { ok: false, error: "schema-error", issues: result.zodError.issues },
        { status: 422 },
      );
    }
    return jsonResponse(
      {
        ok: false,
        error: result.kind,
        detail: "detail" in result ? result.detail : undefined,
      },
      { status: 422 },
    );
  }

  const serialised = serialiseLedger(result.detected);
  try {
    await atomicWriteFile(ctx.ledgerPath, serialised);
  } catch (err) {
    return jsonResponse(
      { ok: false, error: "write-failed", detail: (err as Error).message },
      { status: 500 },
    );
  }

  // Scoped mirror regen for the newly-created record (a CREATE only adds a
  // record; it never orphans an existing mirror, so a scoped write is
  // correct + cheap — matches the 20.23 PATCH regen discipline).
  let regen;
  try {
    regen = await generateRecordMirror(
      result.detected,
      ctx.ledgerPath,
      result.recordId,
    );
  } catch (err) {
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

  const newMtime = (await stat(ctx.ledgerPath)).mtime.toISOString();
  return jsonResponse(
    {
      ok: true,
      newMtime,
      recordId: result.recordId,
      mirrorDir: regen.mirrorDir,
      mirrorsWritten: regen.written,
      mirrorsDeleted: regen.deleted,
    },
    { status: 201 },
  );
}

/**
 * DELETE /api/ledger/record/:recordId — remove a record (ID-20.15).
 *
 * Body: { baseMtime: string }
 *   → 200 { ok: true, newMtime, recordId, mirrorsDeleted }
 *   → 404 { error: 'record-not-found' }
 *   → 409 { error: 'mtime-mismatch' }
 *
 * After the atomic write, the deleted record's orphaned mirror is removed
 * via a full regen of the now-smaller ledger (the generator's §3.4 orphan
 * deletion drops any .md no longer in the planned set). A full regen is the
 * right tool here — unlike PATCH/CREATE, a DELETE changes the orphan set.
 */
async function handleDeleteRecord(
  ctx: RequestContext,
  recordId: string,
  request: Request,
): Promise<Response> {
  let body: { baseMtime?: unknown };
  try {
    body = (await request.json()) as { baseMtime?: unknown };
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

  let canonical;
  try {
    canonical = await readCanonical(ctx.ledgerPath);
  } catch (err) {
    return jsonResponse(
      {
        ok: false,
        error: "ledger-read-failed",
        detail: (err as Error).message,
      },
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

  const baseMtimeMs = Date.parse(body.baseMtime);
  if (!Number.isFinite(baseMtimeMs)) {
    return jsonResponse(
      { ok: false, error: "invalid-baseMtime", detail: body.baseMtime },
      { status: 400 },
    );
  }
  if (Date.parse(canonical.mtimeIso) > baseMtimeMs) {
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

  const result = removeRecord(canonical.detected, recordId);
  if (!result.ok) {
    if (result.kind === "record-not-found") {
      return jsonResponse(
        { ok: false, error: "record-not-found", recordId },
        { status: 404 },
      );
    }
    if (result.kind === "schema-error") {
      return jsonResponse(
        { ok: false, error: "schema-error", issues: result.zodError.issues },
        { status: 422 },
      );
    }
    return jsonResponse({ ok: false, error: result.kind }, { status: 422 });
  }

  const serialised = serialiseLedger(result.detected);
  try {
    await atomicWriteFile(ctx.ledgerPath, serialised);
  } catch (err) {
    return jsonResponse(
      { ok: false, error: "write-failed", detail: (err as Error).message },
      { status: 500 },
    );
  }

  // Full regen so the deleted record's mirror is orphan-deleted (§3.4).
  let regen;
  try {
    regen = await generateMirrors(result.detected, ctx.ledgerPath);
  } catch (err) {
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

/**
 * Resolve the task-list + backlog sibling ledger paths from the launched
 * ledger's directory (TECH §2.2/§2.3 sibling logic). The transaction
 * spans BOTH ledgers regardless of which one the server was launched
 * against, so we scan the directory for both by document_name.
 *
 * Returns null when either sibling is absent.
 */
async function resolveTransactionSiblings(
  ledgerPath: string,
): Promise<{ taskListPath: string; backlogPath: string } | null> {
  const dir = dirname(ledgerPath);
  const scan = await scanForLedgers(dir);
  const byName: Record<string, string> = {};
  if (scan.kind === "one") {
    byName[scan.documentName] = scan.path;
  } else if (scan.kind === "multiple") {
    for (const p of scan.paths) byName[scan.perPathName[p]] = p;
  }
  const taskListPath = byName["Knowledge Hub Task List"];
  const backlogPath = byName["Product Backlog"];
  if (!taskListPath || !backlogPath) {
    // Defensive fallback: derive the missing sibling by conventional
    // filename in the same directory (covers a dir where one sibling is
    // present + the other named non-canonically — rare, but keeps the
    // error message actionable).
    return null;
  }
  return { taskListPath, backlogPath };
}

/**
 * POST /api/ledger/transaction — cross-ledger atomic Promote (ID-20.15).
 *
 * The canonical case: remove an item from product-backlog.json AND add a
 * corresponding Task to task-list.json in a single all-or-nothing op.
 *
 * Body:
 *   {
 *     op: "promote",
 *     sourceBacklogId: string,        // backlog item id to remove
 *     taskRecord: <full Task object>, // task to insert into task-list
 *     taskListBaseMtime: string,      // client's last-seen task-list mtime
 *     backlogBaseMtime: string,       // client's last-seen backlog mtime
 *   }
 *
 * Responses:
 *   → 200 { ok: true, newTaskId, removedBacklogId, taskListMtime, backlogMtime, ... }
 *   → 409 { error: 'mtime-mismatch' | 'duplicate-id' }
 *   → 404 { error: 'backlog-item-not-found' }
 *   → 422 { error: 'schema-error', issues } | { error: 'unknown-document-name' | ... }
 *   → 400 invalid body / mtime
 *   → 500 { error: 'no-sibling-ledger' | 'stage-failed' | 'commit-failed' }
 *
 * Atomicity: validate-everything → stage-both (fsync) → commit-last. See
 * ledger-transaction.ts for the full model + residual-window discussion.
 */
async function handlePostTransaction(
  ctx: RequestContext,
  request: Request,
): Promise<Response> {
  let body: {
    op?: unknown;
    sourceBacklogId?: unknown;
    taskRecord?: unknown;
    taskListBaseMtime?: unknown;
    backlogBaseMtime?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch (err) {
    return jsonResponse(
      { ok: false, error: "invalid-json", detail: (err as Error).message },
      { status: 400 },
    );
  }
  if (body.op !== "promote") {
    return jsonResponse(
      {
        ok: false,
        error: "unsupported-op",
        detail: `Only "promote" is supported; got ${String(body.op)}.`,
      },
      { status: 400 },
    );
  }
  if (typeof body.sourceBacklogId !== "string" || body.sourceBacklogId === "") {
    return jsonResponse(
      { ok: false, error: "missing-sourceBacklogId" },
      { status: 400 },
    );
  }
  if (body.taskRecord == null || typeof body.taskRecord !== "object") {
    return jsonResponse(
      { ok: false, error: "missing-taskRecord" },
      { status: 400 },
    );
  }
  if (
    typeof body.taskListBaseMtime !== "string" ||
    body.taskListBaseMtime === ""
  ) {
    return jsonResponse(
      { ok: false, error: "missing-taskListBaseMtime" },
      { status: 400 },
    );
  }
  if (
    typeof body.backlogBaseMtime !== "string" ||
    body.backlogBaseMtime === ""
  ) {
    return jsonResponse(
      { ok: false, error: "missing-backlogBaseMtime" },
      { status: 400 },
    );
  }

  const siblings = await resolveTransactionSiblings(ctx.ledgerPath);
  if (!siblings) {
    return jsonResponse(
      {
        ok: false,
        error: "no-sibling-ledger",
        detail:
          "Promote requires both a 'Knowledge Hub Task List' and a 'Product Backlog' " +
          "ledger in the launched ledger's directory.",
      },
      { status: 500 },
    );
  }

  const result = await promoteTransaction({
    taskListPath: siblings.taskListPath,
    backlogPath: siblings.backlogPath,
    taskListBaseMtime: body.taskListBaseMtime,
    backlogBaseMtime: body.backlogBaseMtime,
    sourceBacklogId: body.sourceBacklogId,
    taskRecord: body.taskRecord,
  });

  if (!result.ok) {
    return jsonResponse(
      {
        ok: false,
        error: result.error,
        detail: result.detail,
        issues: result.issues,
      },
      { status: result.status },
    );
  }

  return jsonResponse({
    ok: true,
    newTaskId: result.newTaskId,
    removedBacklogId: result.removedBacklogId,
    taskListMtime: result.taskListMtime,
    backlogMtime: result.backlogMtime,
    mirrorsWritten: result.mirrorsWritten,
    mirrorsDeleted: result.mirrorsDeleted,
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
      {
        ok: false,
        error: "ledger-read-failed",
        detail: (err as Error).message,
      },
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

    // GET / → SSR-rendered viewer (Subtask 20.17).
    if (path === "/" && request.method === "GET") {
      return handleGetRoot(ctx, url.searchParams, request.headers.get("cookie"));
    }

    // GET /client.js → progressive-enhancement client bundle, served as a
    // separate cacheable resource (referenced by the SSR HTML, not inlined).
    if (path === CLIENT_BUNDLE_ROUTE && request.method === "GET") {
      return handleGetClientBundle(request);
    }

    // GET /api/ledger
    if (path === "/api/ledger" && request.method === "GET") {
      return handleGetLedger(ctx);
    }

    // POST /api/ledger/record — record-level CREATE (ID-20.15). Exact path
    // (no recordId) — matched BEFORE the /:recordId regex below so the
    // collection-level POST is not swallowed by the per-record route.
    if (path === "/api/ledger/record" && request.method === "POST") {
      return handlePostRecord(ctx, request);
    }

    // POST /api/ledger/transaction — cross-ledger atomic Promote (ID-20.15).
    if (path === "/api/ledger/transaction" && request.method === "POST") {
      return handlePostTransaction(ctx, request);
    }

    // GET / PATCH / DELETE /api/ledger/record/:recordId
    const recordMatch = path.match(/^\/api\/ledger\/record\/(.+)$/);
    if (recordMatch) {
      const recordId = decodeURIComponent(recordMatch[1]);
      if (request.method === "GET") {
        return handleGetRecord(ctx, recordId);
      }
      if (request.method === "PATCH") {
        return handlePatchRecord(ctx, recordId, request);
      }
      if (request.method === "DELETE") {
        return handleDeleteRecord(ctx, recordId, request);
      }
      return jsonResponse(
        { ok: false, error: "method-not-allowed" },
        { status: 405, headers: { allow: "GET, PATCH, DELETE" } },
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
export function startPatchServer(opts: PatchServerOptions): PatchServerHandle {
  const hostname = resolveServerHostname(opts.hostname); // throws if non-loopback
  // Default to OS-assigned port (0) when caller doesn't specify. Port
  // retry policy (§6.6) lands in 20.11 — for 20.8 we expose the bare
  // Bun.serve behaviour.
  const port = opts.port ?? 0;

  const ctx: RequestContext = { ledgerPath: opts.ledgerPath };
  const fetchHandler = buildFetchHandler(ctx);

  const server = Bun.serve({
    port,
    hostname,
    fetch: fetchHandler,
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
