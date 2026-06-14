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
 *   POST /api/ledger/record/:taskId/subtask          (ID-90 U5)
 *     body: { subtasks: object[], baseMtime: string }
 *     → 201 { ok: true, newMtime, taskId, subtaskIds, warnings? }
 *   DELETE /api/ledger/record/:taskId/subtask/:subId (ID-90 U5)
 *     body: { baseMtime: string }
 *     → 200 { ok: true, newMtime, taskId, subtaskId, warnings? }
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
import { dirname, join, resolve } from "node:path";

// The canonical tool version for /api/health — the ROOT package.json
// `version` field (same source cli.ts uses; Bun's native JSON import).
import rootPkg from "../../package.json";

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
import {
  escapeSerialise,
  scopedSerialise,
  scopedSpliceSerialise,
} from "./scoped-serialise";
import {
  insertRecord,
  removeRecord,
  insertSubtasks,
  removeSubtask,
  withCreateDefaults,
  nextId,
} from "./record-mutate";
import {
  checkBudgetForPatches,
  checkBudgetForCreate,
  createRecordKindFor,
} from "./gates/budget-gate";
import {
  beforeCollectionIds,
  topLevelCollectionFor,
} from "./gates/record-set-gate";
import { buildPreWriteGates, runPreWriteGates } from "./gates/gate-chain";
import {
  parseMutationOptions,
  type MutationOptions,
} from "./mutation-options";
import {
  disciplineWarnings,
  disciplineWarningsForScopes,
  warningScopesForPatches,
} from "./discipline-warnings";
import { promoteTransaction } from "./ledger-transaction";
import { withPathLock, withPathLocks } from "./path-mutex";
import { scanForLedgers } from "./path-resolution";
import { LOOPBACK_HOSTNAME, resolveServerHostname } from "./loopback-bind";
import {
  renderViewer,
  renderSiblingNotAvailable,
  type SiblingLedgers,
} from "./render-viewer";
import {
  documentNameForSlug,
  LEDGER_SLUGS,
  resolveLedgerPathByName,
  slugForDocumentName,
  type LedgerSlug,
} from "./cross-ledger";
import { decodeLedgerParam } from "@task-view/ui/record-view/url-state";
import type { KnownDocumentName } from "./detect-schema";
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
  /**
   * ID-90 U9 `--require-denylist` (PRODUCT invariant 34): arm record 8's
   * client-name guard fail-loud posture — an UNSET `KH_CLIENT_NAME_DENYLIST`
   * env becomes the same loud 500 `client-name-guard-config` error an
   * invalid one already is, on EVERY mutating path. Default false (unset →
   * guard inactive locally).
   */
  requireDenylist?: boolean;
  /**
   * ID-90 U9 `--idle-exit` seam: invoked at the top of EVERY request so the
   * daemon's idle monitor can reset its window. Must be cheap + non-throwing.
   */
  onRequest?: () => void;
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
  /** ID-90 U9: invariant-34 arming, threaded into every pre-write gate
   * chain (and each transaction leg). */
  requireDenylist: boolean;
  /** ID-90 U9: per-request activity callback (idle-exit window reset). */
  onRequest?: () => void;
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
 * ID-90.12 U10: parse the per-request override body fields
 * {dryRun?, force?, allowClientName?, regenMirrors?} from a mutation body
 * (T-3 ratified — JSON body fields, never headers; defaults applied per
 * request, NOTHING stored server-side — PRODUCT invariants 16, 26, 33).
 * A present non-boolean value is a 400 `invalid-json` response (the
 * established body-malformation family — no separate vocabulary entry;
 * the detail string carries the field-specific message).
 */
function mutationOptionsOrError(
  body: Record<string, unknown>,
):
  | { ok: true; options: MutationOptions }
  | { ok: false; response: Response } {
  const parsed = parseMutationOptions(body);
  if (parsed.ok) return parsed;
  return {
    ok: false,
    response: jsonResponse(
      { ok: false, error: "invalid-json", detail: parsed.detail },
      { status: 400 },
    ),
  };
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
  // ID-90 U8: umbrellas — fourth known kind. Records are umbrella entries
  // keyed by their kebab-case id.
  if (detected.kind === "umbrellas") {
    const umbrella = detected.data.umbrellas.find((u) => u.id === recordId);
    if (!umbrella) return null;
    return { kind: "umbrella", record: umbrella };
  }
  // WS-C C2: retros — fifth known kind. Records are session retros keyed by
  // their session id (`S<n>`).
  if (detected.kind === "retro") {
    const retro = detected.data.retros.find((r) => r.id === recordId);
    if (!retro) return null;
    return { kind: "retro", record: retro };
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
  // ID-90 U8: umbrellas carry no mirror obligation (PRODUCT invariant 53) —
  // there is no mirror filename for an umbrella record. WS-C C2: retros carry
  // no .md mirror yet either — same empty-filename treatment.
  if (recordKind === "umbrella" || recordKind === "retro") {
    return "";
  }
  // backlog-item
  return computeRecordFilename("backlog", { id: recordId });
}

// ID-90 U1: the former `serialiseLedger` (`JSON.stringify(detected.data,
// null, 2)`) is DELETED. It re-emitted the Zod-reparsed document — key-order
// normalisation + raw UTF-8 — which turned a single-field edit into a
// whole-file diff (PRODUCT invariant 19 / RESEARCH §1.3). Written bytes now
// come from the conforming serialisers in scoped-serialise.ts:
//   - PATCH  → scopedSerialise folded left over the parsed-ORIGINAL rawText
//   - POST   → scopedSpliceSerialise (record splice on the parsed-original)
//   - DELETE → escapeSerialise(result.detected.data) (whole-file conforming,
//              byte-compatible post-OQ-LS-2)

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
  // ID-90 U8: umbrellas documents have no record-view surface — no mirrors
  // (PRODUCT invariant 53) and no viewer pages; membership edits go through
  // the field-PATCH API. Render a plain explanatory page rather than a 500.
  if (canonical.detected.kind === "umbrellas") {
    return new Response(
      "<!doctype html><html><body><main><h1>umbrellas</h1>" +
        "<p>Umbrella documents have no record-view surface. Membership edits " +
        "are field PATCHes on ['umbrellas', id, 'task_ids'] via the ledger " +
        "API (ID-90 U8; PRODUCT invariants 49–50, 53).</p></main></body></html>",
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
  // WS-C C2: retros have no record-view surface yet — render a plain
  // explanatory page (same treatment as umbrellas) rather than a 500. The
  // retro write path is the ledger-CLI `create-retro` → POST /api/ledger/retro.
  if (canonical.detected.kind === "retro") {
    return new Response(
      "<!doctype html><html><body><main><h1>retros</h1>" +
        "<p>Retro documents have no record-view surface yet. Records are " +
        "authored via the ledger CLI (`create-retro`) → POST " +
        "/api/ledger/retro/record (WS-C C2).</p></main></body></html>",
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
  // Resolve the theme preference (record-view-styling SPEC SV-8): query
  // override > cookie (the SAME keys ThemeProvider writes) > default
  // task-view/dark. Then assemble the inline stylesheet + <html> class
  // (cached at boot; safety-stylesheet fallback on a read failure — never
  // throws). The server READS the cookie but writes none (SV-10).
  const pref = resolveThemePreference({ cookieHeader, query: search });
  const styles = await getViewerStyles(pref.themeId, pref.mode);

  // {20.29} cross-ledger nav (SPEC §5 slice 6). Parse the `ledger` slug.
  // Absent / equal-to-launched → render the LAUNCHED ledger editable
  // (unchanged path). A sibling slug → resolve + read the sibling ledger
  // and render it READ-ONLY.
  const launchedSlug = slugForDocumentName(
    canonical.detected.kind === "task-list"
      ? "Knowledge Hub Task List"
      : canonical.detected.kind === "roadmap"
        ? "Knowledge Hub Roadmap"
        : "Product Backlog",
  );
  const requestedSlug = decodeLedgerParam(search);

  // editable-ledger-switch §2: the editable ledger switcher lists every
  // viewer-renderable sibling in the launch directory; both the launched and
  // the switched-to renders mount it.
  const availableLedgers = await scanViewerLedgers(ctx.ledgerPath);

  if (requestedSlug !== null && requestedSlug !== launchedSlug) {
    return renderSiblingLedger(
      ctx,
      requestedSlug,
      search,
      styles,
      availableLedgers,
    );
  }

  // Launched ledger (or explicit self-slug): editable, with siblings threaded
  // so the launched ledger's own outbound cross-ledger links resolve `exists`.
  const siblings = await readSiblingLedgers(ctx.ledgerPath, canonical.detected.kind);
  const result = renderViewer({
    detected: canonical.detected,
    search,
    clientScriptSrc: CLIENT_BUNDLE_ROUTE,
    styles,
    siblings,
    availableLedgers,
    activeSlug: canonical.detected.kind,
  });
  return new Response(result.html, {
    status: result.status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * {20.29}: read the launched ledger's SIBLING ledgers (the ones it does NOT
 * own) and return their parsed records so the CURRENT page's outbound
 * cross-ledger links can compute `exists` (SPEC §4 approach A). A sibling
 * that is absent or fails to read/parse is simply omitted — its links then
 * render as broken-target, which is the correct dead-end signal.
 */
async function readSiblingLedgers(
  ledgerPath: string,
  currentKind: "task-list" | "roadmap" | "backlog",
): Promise<SiblingLedgers> {
  const siblings: SiblingLedgers = {};
  // A roadmap page links out to task-list + backlog; a task page links out
  // to the roadmap (capability_theme chip). We read whatever is useful for
  // the current kind's outbound edges.
  // {20.30}: a backlog page now also reads the roadmap sibling so its REVERSE
  // "Appears in themes" backlinks resolve (the inverse index is built from the
  // roadmap's linked_backlog). Backlog has no FORWARD cross-ledger edge, but
  // the roadmap is what carries the reverse pointer to it.
  const wanted: KnownDocumentName[] =
    currentKind === "roadmap"
      ? ["Knowledge Hub Task List", "Product Backlog"]
      : currentKind === "task-list"
        ? ["Knowledge Hub Roadmap"]
        : ["Knowledge Hub Roadmap"]; // backlog → roadmap (reverse index, {20.30})
  for (const name of wanted) {
    const path = await resolveLedgerPathByName(ledgerPath, name);
    if (path === null) continue;
    let detected: DetectSchemaResult;
    try {
      detected = (await readCanonical(path)).detected;
    } catch {
      continue;
    }
    if (detected.kind === "task-list") siblings.tasks = detected.data.tasks;
    else if (detected.kind === "roadmap") siblings.roadmap = detected.data;
    else if (detected.kind === "backlog") siblings.backlogItems = detected.data.items;
  }
  return siblings;
}

/**
 * editable-ledger-switch §2: the viewer-renderable ledger slugs present in the
 * launch directory, for the editable ledger switcher. Mirrors
 * `handleGetHealth`'s scan but narrows to the THREE slugs with a viewer surface
 * — umbrellas/retro are routed-but-not-navigable (SPEC OQ-4), so they never
 * appear in the switcher.
 */
async function scanViewerLedgers(
  ledgerPath: string,
): Promise<("task-list" | "roadmap" | "backlog")[]> {
  const dir = resolve(dirname(ledgerPath));
  const scan = await scanForLedgers(dir);
  const names =
    scan.kind === "one"
      ? [scan.documentName]
      : scan.kind === "multiple"
        ? scan.paths.map((p) => scan.perPathName[p])
        : [];
  const slugs = new Set<"task-list" | "roadmap" | "backlog">();
  for (const name of names) {
    const slug = slugForDocumentName(name);
    if (slug === "task-list" || slug === "roadmap" || slug === "backlog") {
      slugs.add(slug);
    }
  }
  return [...slugs];
}

/**
 * editable-ledger-switch: render a switched-to SIBLING ledger EDITABLE — the
 * slug write seam routes its writes. Resolves the sibling path by name in the
 * launch dir; a missing sibling FILE or a read/parse failure is a navigation
 * dead-end → 404 HTML (NOT 500 — the launched server is healthy). A missing
 * RECORD id inside a resolved sibling falls through to renderViewer's
 * existing renderNotFound (404).
 */
async function renderSiblingLedger(
  ctx: RequestContext,
  slug: NonNullable<ReturnType<typeof decodeLedgerParam>>,
  search: URLSearchParams,
  styles: Awaited<ReturnType<typeof getViewerStyles>>,
  availableLedgers: readonly ("task-list" | "roadmap" | "backlog")[],
): Promise<Response> {
  const documentName = documentNameForSlug(slug);
  if (documentName === null) {
    // Defensive: decodeLedgerParam already validated the slug, so this is
    // unreachable in practice. Treat as a dead-end 404 to be safe.
    return siblingNotAvailableResponse(slug, styles);
  }
  const siblingPath = await resolveLedgerPathByName(ctx.ledgerPath, documentName);
  if (siblingPath === null) {
    return siblingNotAvailableResponse(slug, styles);
  }
  let canonical;
  try {
    canonical = await readCanonical(siblingPath);
  } catch {
    return siblingNotAvailableResponse(slug, styles);
  }
  if (canonical.detected.kind === "unknown") {
    return siblingNotAvailableResponse(slug, styles);
  }
  // ID-90 U8: umbrellas documents have no viewer surface (PRODUCT inv 53) —
  // a nav to them is a dead-end, same treatment as a missing sibling. WS-C C2:
  // retros likewise have no viewer surface yet — same dead-end treatment.
  if (
    canonical.detected.kind === "umbrellas" ||
    canonical.detected.kind === "retro"
  ) {
    return siblingNotAvailableResponse(slug, styles);
  }
  const siblings = await readSiblingLedgers(siblingPath, canonical.detected.kind);
  const result = renderViewer({
    detected: canonical.detected,
    search,
    clientScriptSrc: CLIENT_BUNDLE_ROUTE,
    styles,
    siblings,
    availableLedgers,
    activeSlug: canonical.detected.kind,
  });
  return new Response(result.html, {
    status: result.status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * 404 HTML for an absent / broken sibling ledger ({20.29}, SPEC §5 step 2/3).
 * A linked ledger that is not present in the launch directory is a
 * navigation dead-end, not a server fault — surface a styled 404 with a
 * back-to-launched link rather than a 500.
 */
function siblingNotAvailableResponse(
  slug: string,
  styles: Awaited<ReturnType<typeof getViewerStyles>>,
): Response {
  const result = renderSiblingNotAvailable(slug, styles);
  return new Response(result.html, {
    status: 404,
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
  // ID-90 U8: umbrellas carry no mirror obligation (PRODUCT invariant 53) —
  // the mirror fields are empty for the fourth kind. WS-C C2: retros carry no
  // mirror dir yet either — same empty-mirror treatment. The inline kind checks
  // are kept (rather than a hoisted boolean) so TS narrows `detected.kind` to a
  // MirroredLedgerKind in the else-arm.
  const mirrorDir =
    canonical.detected.kind === "umbrellas" ||
    canonical.detected.kind === "retro"
      ? ""
      : resolveMirrorDir(canonical.detected.kind, ctx.ledgerPath);
  return jsonResponse({
    ok: true,
    kind: canonical.detected.kind,
    data: canonical.detected.data,
    mirrorDir,
    mirrorDirName:
      canonical.detected.kind === "umbrellas" ||
      canonical.detected.kind === "retro"
        ? ""
        : computeMirrorDirName(canonical.detected.kind),
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

  // ID-90.12 U10: per-request overrides ride as body fields (T-3).
  const opt = mutationOptionsOrError(body as Record<string, unknown>);
  if (!opt.ok) return opt.response;
  const options = opt.options;

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

  // ID-90 U2 budget gate — post-mutation / pre-serialisation. Each patched
  // field is a mutated field (can hard-reject); untouched over-budget fields
  // soft-warn (PRODUCT invariants 25–27). U10: `force` arrives as a body
  // field and downgrades a rejection per request (invariant 26).
  const budget = checkBudgetForPatches(
    canonical.detected.kind,
    applyResult.parsed,
    patches,
    { force: options.force },
  );
  if (!budget.ok) {
    return jsonResponse(
      {
        ok: false,
        error: budget.error,
        detail: budget.detail,
        ...(budget.warnings.length > 0 ? { warnings: budget.warnings } : {}),
      },
      { status: 422 },
    );
  }

  // ID-90 U3: capture the pre-write id-set from the typed pre-mutation
  // document — a field PATCH must preserve the record set exactly
  // (expectedDelta `none`, invariant 22).
  const recordSetDescriptor = topLevelCollectionFor(canonical.detected.kind);
  const beforeIds = beforeCollectionIds(canonical.detected, recordSetDescriptor);

  // ID-90 U1: written bytes come from the parsed-ORIGINAL, not the
  // Zod-reparsed snapshot. `applyPatches` above stays the validation oracle;
  // here we fold `scopedSerialise` left over the original rawText so every
  // untouched record keeps its exact on-disk bytes (invariants 18-19). A fold
  // failure after the oracle passed is an internal inconsistency → 500.
  let serialised = canonical.rawText;
  for (const patch of patches) {
    const scoped = scopedSerialise(serialised, patch);
    if (!scoped.ok) {
      return jsonResponse(
        {
          ok: false,
          error: "serialise-failed",
          detail: `scoped serialisation ${scoped.kind}${
            "detail" in scoped && scoped.detail ? `: ${scoped.detail}` : ""
          }`,
        },
        { status: 500 },
      );
    }
    serialised = scoped.text;
  }

  // Reconstruct a typed `detected` so generateRecordMirror sees the right
  // discriminant + parsed shape (mirrors are markdown — derived from the
  // parsed snapshot, not the canonical bytes).
  const serialisedDetected = {
    kind: canonical.detected.kind,
    data: applyResult.parsed,
  } as Exclude<DetectSchemaResult, { kind: "unknown" }>;

  // ID-90 U3 pre-write gate chain — post-serialisation / pre-atomicWriteFile,
  // asserting on the EXACT bytes about to land (invariant 22). Record 8's
  // client-name guard joins this chain via buildPreWriteGates.
  const gateVerdict = runPreWriteGates(
    buildPreWriteGates({
      recordSet: {
        ledgerLabel: canonical.detected.kind,
        beforeIds,
        descriptor: recordSetDescriptor,
        expectedDelta: { kind: "none" },
      },
      // U4: prior on-disk bytes — the BEFORE side of the net-new delta.
      clientName: {
        priorContent: canonical.rawText,
        requireDenylist: ctx.requireDenylist,
      },
    }),
    // U10: the guard-side override arrives per request (invariant 33).
    { content: serialised, options: { allowClientName: options.allowClientName } },
  );
  if (!gateVerdict.ok) {
    return jsonResponse(
      {
        ok: false,
        error: gateVerdict.error,
        detail: gateVerdict.detail,
        ...(gateVerdict.warnings.length > 0
          ? { warnings: gateVerdict.warnings }
          : {}),
      },
      { status: gateVerdict.status },
    );
  }
  // ID-90.12 U10 (invariant 41): ported disciplineWarnings, {35.30}-scoped
  // to the records this PATCH batch touched, lead the warnings envelope
  // (KH commitMutation order: discipline first, then gate warnings).
  const responseWarnings = [
    ...disciplineWarningsForScopes(
      serialisedDetected,
      warningScopesForPatches(patches),
    ),
    ...budget.warnings,
    ...gateVerdict.warnings,
  ];

  // ID-90.12 U10 dryRun (invariant 16): the FULL gate chain ran above on
  // the exact would-be bytes; return the would-be payload with NO write,
  // NO mirror regen, NO mtime change.
  if (options.dryRun) {
    return jsonResponse({
      ok: true,
      dryRun: true,
      recordId,
      mtime: canonical.mtimeIso,
      ...(responseWarnings.length > 0 ? { warnings: responseWarnings } : {}),
    });
  }

  try {
    await atomicWriteFile(ctx.ledgerPath, serialised);
  } catch (err) {
    return jsonResponse(
      { ok: false, error: "write-failed", detail: (err as Error).message },
      { status: 500 },
    );
  }

  // ID-90.12 U10 regenMirrors:false — skip the regen and REPORT it; the K2
  // mapping surfaces `mirrorStaleReason: 'suppressed'` ({35.32} parity).
  if (!options.regenMirrors) {
    const newMtime = (await stat(ctx.ledgerPath)).mtime.toISOString();
    return jsonResponse({
      ok: true,
      newMtime,
      recordId,
      mirrorRegen: "suppressed",
      ...(responseWarnings.length > 0 ? { warnings: responseWarnings } : {}),
    });
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
    // U10 warnings envelope: discipline + budget soft-warns + forced
    // downgrades + guard-override warnings (invariant 41).
    ...(responseWarnings.length > 0 ? { warnings: responseWarnings } : {}),
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

  // ID-90.12 U10: per-request overrides ride as body fields (T-3).
  const opt = mutationOptionsOrError(body as Record<string, unknown>);
  if (!opt.ok) return opt.response;
  const options = opt.options;

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

  // ID-90 U8: record creates do not apply to umbrellas — the umbrella id-set
  // is never mutated through record splices; membership edits are field
  // PATCHes on ['umbrellas', id, 'task_ids'] (PRODUCT invariants 49-50).
  if (canonical.detected.kind === "umbrellas") {
    return jsonResponse(
      {
        ok: false,
        error: "unsupported-op",
        detail:
          "umbrellas documents do not support record creates; membership " +
          "edits are field PATCHes on ['umbrellas', id, 'task_ids'].",
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

  // ID-90 U5: server-side create defaults (ported withCreateDefaults
  // semantics — structural defaults merged UNDER the supplied body, supplied
  // fields win) + auto-id allocation when `record.id` is absent (per-record
  // nextId max+1, PRODUCT invariant 37). The defaulted record is what flows
  // through the oracle, the budget gate AND the scoped splice, so the
  // written bytes carry the defaults.
  const createKind = createRecordKindFor(canonical.detected.kind);
  let record = withCreateDefaults(
    createKind,
    body.record as Record<string, unknown>,
  );
  // WS-C C2: retro ids are caller-supplied session ids (`S<n>`) — there is NO
  // auto-allocation / nextId / high-water mark for retros. A retro create that
  // omits `id` is a client error, not an auto-id opportunity.
  if (canonical.detected.kind === "retro") {
    if (record.id === undefined) {
      return jsonResponse(
        {
          ok: false,
          error: "invalid-body",
          detail:
            "retro records require a caller-supplied session id of the form S<digits> (e.g. \"S264\"); retros are not auto-allocated.",
        },
        { status: 422 },
      );
    }
  } else if (record.id === undefined) {
    const collectionKey =
      canonical.detected.kind === "task-list"
        ? ("tasks" as const)
        : canonical.detected.kind === "roadmap"
          ? ("themes" as const)
          : ("items" as const);
    record = { ...record, id: nextId(canonical.detected, collectionKey) };
  }

  const result = insertRecord(canonical.detected, record);
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

  // ID-90 U2 budget gate — create mode (every budgeted field is freshly
  // authored): first over-budget field is fatal (invariant 25). U10:
  // `force` arrives as a body field and downgrades per request (inv 26).
  const budget = checkBudgetForCreate(createKind, record, {
    force: options.force,
  });
  if (!budget.ok) {
    return jsonResponse(
      {
        ok: false,
        error: budget.error,
        detail: budget.detail,
        ...(budget.warnings.length > 0 ? { warnings: budget.warnings } : {}),
      },
      { status: 422 },
    );
  }

  // ID-90 U3: capture the pre-write id-set from the typed PRE-mutation
  // document (insertRecord clones — `canonical.detected` is untouched). A
  // record CREATE is an `add` delta on the top-level collection.
  const recordSetDescriptor = topLevelCollectionFor(canonical.detected.kind);
  const beforeIds = beforeCollectionIds(canonical.detected, recordSetDescriptor);

  // ID-90 U1: splice the new record into the parsed-ORIGINAL rawText so every
  // existing record keeps its exact on-disk bytes (invariants 18-19).
  // `insertRecord` above stays the validation oracle (duplicate-id +
  // document-level schema invariants); a splice failure after the oracle
  // passed is an internal inconsistency → 500.
  const spliced = scopedSpliceSerialise(canonical.rawText, {
    kind: "insert",
    collection:
      canonical.detected.kind === "task-list"
        ? "tasks"
        : canonical.detected.kind === "roadmap"
          ? "themes"
          : canonical.detected.kind === "retro"
            ? "retros"
            : "items",
    record,
  });
  if (!spliced.ok) {
    return jsonResponse(
      {
        ok: false,
        error: "serialise-failed",
        detail: `scoped splice ${spliced.kind}${
          "detail" in spliced && spliced.detail ? `: ${spliced.detail}` : ""
        }`,
      },
      { status: 500 },
    );
  }

  // ID-90 U3 pre-write gate chain on the EXACT spliced bytes (invariant 22).
  const gateVerdict = runPreWriteGates(
    buildPreWriteGates({
      recordSet: {
        ledgerLabel: canonical.detected.kind,
        beforeIds,
        descriptor: recordSetDescriptor,
        expectedDelta: { kind: "add", id: result.recordId },
      },
      // U4: prior on-disk bytes — the BEFORE side of the net-new delta.
      clientName: {
        priorContent: canonical.rawText,
        requireDenylist: ctx.requireDenylist,
      },
    }),
    // U10: the guard-side override arrives per request (invariant 33).
    { content: spliced.text, options: { allowClientName: options.allowClientName } },
  );
  if (!gateVerdict.ok) {
    return jsonResponse(
      {
        ok: false,
        error: gateVerdict.error,
        detail: gateVerdict.detail,
        ...(gateVerdict.warnings.length > 0
          ? { warnings: gateVerdict.warnings }
          : {}),
      },
      { status: gateVerdict.status },
    );
  }
  // ID-90.12 U10 (invariant 41): discipline warnings scoped to the created
  // record ({35.30} — KH create-task parity); [] for roadmap/backlog kinds.
  const responseWarnings = [
    ...disciplineWarnings(result.detected, {
      taskId: String(result.recordId),
    }),
    ...budget.warnings,
    ...gateVerdict.warnings,
  ];

  // ID-90.12 U10 dryRun (invariant 16): full gate chain ran; report the
  // would-be id with NO write, NO mirror regen, NO mtime change.
  if (options.dryRun) {
    return jsonResponse({
      ok: true,
      dryRun: true,
      recordId: result.recordId,
      mtime: canonical.mtimeIso,
      ...(responseWarnings.length > 0 ? { warnings: responseWarnings } : {}),
    });
  }

  try {
    await atomicWriteFile(ctx.ledgerPath, spliced.text);
  } catch (err) {
    return jsonResponse(
      { ok: false, error: "write-failed", detail: (err as Error).message },
      { status: 500 },
    );
  }

  // ID-90.12 U10 regenMirrors:false — skip the regen and REPORT it.
  if (!options.regenMirrors) {
    const newMtime = (await stat(ctx.ledgerPath)).mtime.toISOString();
    return jsonResponse(
      {
        ok: true,
        newMtime,
        recordId: result.recordId,
        mirrorRegen: "suppressed",
        ...(responseWarnings.length > 0 ? { warnings: responseWarnings } : {}),
      },
      { status: 201 },
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
      ...(responseWarnings.length > 0 ? { warnings: responseWarnings } : {}),
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

  // ID-90.12 U10: per-request overrides ride as body fields (T-3).
  const opt = mutationOptionsOrError(body as Record<string, unknown>);
  if (!opt.ok) return opt.response;
  const options = opt.options;

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

  // ID-90 U8: record deletes do not apply to umbrellas — the umbrella id-set
  // is never mutated through record splices; membership edits are field
  // PATCHes on ['umbrellas', id, 'task_ids'] (PRODUCT invariants 49-50).
  if (canonical.detected.kind === "umbrellas") {
    return jsonResponse(
      {
        ok: false,
        error: "unsupported-op",
        detail:
          "umbrellas documents do not support record deletes; membership " +
          "edits are field PATCHes on ['umbrellas', id, 'task_ids'].",
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

  // ID-90 U3: a DELETE is a `remove` delta on the top-level collection. No
  // budget gate — a deletion authors no content. beforeIds come from the
  // typed PRE-mutation document (removeRecord clones).
  const recordSetDescriptor = topLevelCollectionFor(canonical.detected.kind);
  const beforeIds = beforeCollectionIds(canonical.detected, recordSetDescriptor);

  // ID-90 U1: DELETE is a whole-file conforming re-emit of the Zod-parsed
  // post-removal document — matches the CLI's whole-file deletes and is
  // byte-compatible with the scoped path post-OQ-LS-2 (invariant 20).
  const serialised = escapeSerialise(result.detected.data);

  // ID-90 U3 pre-write gate chain on the EXACT re-emitted bytes (invariant 22).
  const gateVerdict = runPreWriteGates(
    buildPreWriteGates({
      recordSet: {
        ledgerLabel: canonical.detected.kind,
        beforeIds,
        descriptor: recordSetDescriptor,
        expectedDelta: { kind: "remove", id: recordId },
      },
      // U4: prior on-disk bytes — the BEFORE side of the net-new delta.
      clientName: {
        priorContent: canonical.rawText,
        requireDenylist: ctx.requireDenylist,
      },
    }),
    // U10: the guard-side override arrives per request (invariant 33).
    { content: serialised, options: { allowClientName: options.allowClientName } },
  );
  if (!gateVerdict.ok) {
    return jsonResponse(
      {
        ok: false,
        error: gateVerdict.error,
        detail: gateVerdict.detail,
        ...(gateVerdict.warnings.length > 0
          ? { warnings: gateVerdict.warnings }
          : {}),
      },
      { status: gateVerdict.status },
    );
  }
  // ID-90.12 U10: no discipline scope survives a record DELETE (the record's
  // own lines vanish with it) — the envelope carries gate warnings only.
  const responseWarnings = [...gateVerdict.warnings];

  // ID-90.12 U10 dryRun (invariant 16): full gate chain ran; nothing written.
  if (options.dryRun) {
    return jsonResponse({
      ok: true,
      dryRun: true,
      recordId,
      mtime: canonical.mtimeIso,
      ...(responseWarnings.length > 0 ? { warnings: responseWarnings } : {}),
    });
  }

  try {
    await atomicWriteFile(ctx.ledgerPath, serialised);
  } catch (err) {
    return jsonResponse(
      { ok: false, error: "write-failed", detail: (err as Error).message },
      { status: 500 },
    );
  }

  // ID-90.12 U10 regenMirrors:false — skip the regen and REPORT it. NOTE:
  // a DELETE's suppressed regen leaves the removed record's mirror ORPHANED
  // until the next regen — exactly the staleness `suppressed` signals.
  if (!options.regenMirrors) {
    const newMtime = (await stat(ctx.ledgerPath)).mtime.toISOString();
    return jsonResponse({
      ok: true,
      newMtime,
      recordId,
      mirrorRegen: "suppressed",
      ...(responseWarnings.length > 0 ? { warnings: responseWarnings } : {}),
    });
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
    ...(responseWarnings.length > 0 ? { warnings: responseWarnings } : {}),
  });
}

/**
 * POST /api/ledger/record/:taskId/subtask — bulk subtask CREATE (ID-90 U5).
 *
 * Body: { baseMtime: string, subtasks: <subtask record objects>[] }
 *   → 201 { ok: true, newMtime, taskId, subtaskIds, warnings? }
 *   → 409 { error: 'mtime-mismatch' | 'duplicate-id' }
 *   → 404 { error: 'record-not-found' }  parent task absent
 *   → 422 { error: 'schema-error' | 'budget-exceeded' | ... }
 *   → 400 invalid body / mtime / empty batch
 *
 * Serves add-subtask (a batch of one) and add-subtasks (bulk). Fold-left
 * auto-id allocation + create defaults live in insertSubtasks (PRODUCT
 * invariant 37); per-record budget checks run in create mode with the
 * `subtask <parent>.<id>` label, atomically — any over-budget record
 * rejects the WHOLE batch with nothing written (invariant 25). Lands on
 * the bare /api/ledger/... form; record 11 adds the :slug segment.
 *
 * The written bytes come from N scoped insert splices folded over the
 * parsed-ORIGINAL rawText (ONE write), and the pre-write gate chain
 * asserts the `add-many` id-delta on the exact bytes about to land
 * (invariants 22 + 28).
 */
async function handlePostSubtasks(
  ctx: RequestContext,
  taskId: string,
  request: Request,
): Promise<Response> {
  let body: { baseMtime?: unknown; subtasks?: unknown };
  try {
    body = (await request.json()) as { baseMtime?: unknown; subtasks?: unknown };
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
  if (!Array.isArray(body.subtasks)) {
    return jsonResponse(
      { ok: false, error: "missing-subtasks" },
      { status: 400 },
    );
  }

  // ID-90.12 U10: per-request overrides ride as body fields (T-3).
  const opt = mutationOptionsOrError(body as Record<string, unknown>);
  if (!opt.ok) return opt.response;
  const options = opt.options;

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

  // ID-90 U5 oracle: fold-left create defaults + per-record max+1 auto-id +
  // duplicate-id pre-check + ONE whole-doc Zod re-parse (invariant 37).
  const result = insertSubtasks(canonical.detected, taskId, body.subtasks);
  if (!result.ok) {
    if (result.kind === "task-not-found") {
      return jsonResponse(
        { ok: false, error: "record-not-found", recordId: result.taskId },
        { status: 404 },
      );
    }
    if (result.kind === "duplicate-id") {
      return jsonResponse(
        { ok: false, error: "duplicate-id", subtaskId: result.subtaskId },
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
      { ok: false, error: result.kind, detail: result.detail },
      { status: 400 },
    );
  }

  // ID-90 U2 budget gate — create mode per record, ATOMIC across the batch
  // (invariant 25 bulk mode): the first over-budget record rejects the whole
  // batch with nothing written. `parentId` labels the detail line
  // `subtask <taskId>.<subId>` (ID-35.27).
  const budgetWarnings: string[] = [];
  for (const record of result.records) {
    // U10: `force` downgrades per record, per request (invariant 26).
    const budget = checkBudgetForCreate(
      "subtask",
      record,
      { force: options.force },
      taskId,
    );
    budgetWarnings.push(...budget.warnings);
    if (!budget.ok) {
      return jsonResponse(
        {
          ok: false,
          error: budget.error,
          detail: budget.detail,
          ...(budgetWarnings.length > 0 ? { warnings: budgetWarnings } : {}),
        },
        { status: 422 },
      );
    }
  }

  // ID-90 U3: pre-write id-set of the parent task's subtasks[] — a bulk
  // subtask CREATE is an `add-many` delta (the U5 seam record 7 prepared).
  const recordSetDescriptor = {
    collection: "subtasks" as const,
    taskId,
  };
  const beforeIds = beforeCollectionIds(canonical.detected, recordSetDescriptor);

  // ID-90 U1: N insert ops folded over the parsed-ORIGINAL rawText → ONE
  // final text written ONCE; every untouched record keeps its exact bytes.
  // insertSubtasks above stays the validation oracle; a splice failure after
  // the oracle passed is an internal inconsistency → 500.
  let serialised = canonical.rawText;
  for (const record of result.records) {
    const spliced = scopedSpliceSerialise(serialised, {
      kind: "insert",
      collection: "subtasks",
      taskId,
      record,
    });
    if (!spliced.ok) {
      return jsonResponse(
        {
          ok: false,
          error: "serialise-failed",
          detail: `scoped splice ${spliced.kind}${
            "detail" in spliced && spliced.detail ? `: ${spliced.detail}` : ""
          }`,
        },
        { status: 500 },
      );
    }
    serialised = spliced.text;
  }

  // ID-90 U3 pre-write gate chain on the EXACT bytes about to land
  // (invariants 22 + 28): ONE add-many check covering all +N ids.
  const gateVerdict = runPreWriteGates(
    buildPreWriteGates({
      recordSet: {
        ledgerLabel: canonical.detected.kind,
        beforeIds,
        descriptor: recordSetDescriptor,
        expectedDelta: { kind: "add-many", ids: result.subtaskIds },
      },
      // U4: prior on-disk bytes — the BEFORE side of the net-new delta.
      clientName: {
        priorContent: canonical.rawText,
        requireDenylist: ctx.requireDenylist,
      },
    }),
    // U10: the guard-side override arrives per request (invariant 33).
    { content: serialised, options: { allowClientName: options.allowClientName } },
  );
  if (!gateVerdict.ok) {
    return jsonResponse(
      {
        ok: false,
        error: gateVerdict.error,
        detail: gateVerdict.detail,
        ...(gateVerdict.warnings.length > 0
          ? { warnings: gateVerdict.warnings }
          : {}),
      },
      { status: gateVerdict.status },
    );
  }
  // ID-90.12 U10 (invariant 41): discipline warnings {35.30}-scoped to each
  // created subtask (KH add-subtask `{taskId, subId: newSubId}` parity).
  const responseWarnings = [
    ...disciplineWarningsForScopes(
      result.detected,
      result.subtaskIds.map((subId) => ({ taskId, subId })),
    ),
    ...budgetWarnings,
    ...gateVerdict.warnings,
  ];

  // ID-90.12 U10 dryRun (invariant 16): full gate chain ran; report the
  // would-be subtask ids with NO write, NO mirror regen, NO mtime change.
  if (options.dryRun) {
    return jsonResponse({
      ok: true,
      dryRun: true,
      taskId,
      subtaskIds: result.subtaskIds,
      mtime: canonical.mtimeIso,
      ...(responseWarnings.length > 0 ? { warnings: responseWarnings } : {}),
    });
  }

  try {
    await atomicWriteFile(ctx.ledgerPath, serialised);
  } catch (err) {
    return jsonResponse(
      { ok: false, error: "write-failed", detail: (err as Error).message },
      { status: 500 },
    );
  }

  // ID-90.12 U10 regenMirrors:false — skip the regen and REPORT it.
  if (!options.regenMirrors) {
    const newMtime = (await stat(ctx.ledgerPath)).mtime.toISOString();
    return jsonResponse(
      {
        ok: true,
        newMtime,
        taskId,
        subtaskIds: result.subtaskIds,
        mirrorRegen: "suppressed",
        ...(responseWarnings.length > 0 ? { warnings: responseWarnings } : {}),
      },
      { status: 201 },
    );
  }

  // Subtasks render inside the parent Task's mirror — a scoped regen of that
  // one record is correct + cheap (the 20.23 discipline).
  let regen;
  try {
    regen = await generateRecordMirror(result.detected, ctx.ledgerPath, taskId);
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
      taskId,
      subtaskIds: result.subtaskIds,
      mirrorDir: regen.mirrorDir,
      mirrorsWritten: regen.written,
      mirrorsDeleted: regen.deleted,
      ...(responseWarnings.length > 0 ? { warnings: responseWarnings } : {}),
    },
    { status: 201 },
  );
}

/**
 * DELETE /api/ledger/record/:taskId/subtask/:subId — subtask DELETE
 * (ID-90 U5).
 *
 * Body: { baseMtime: string }
 *   → 200 { ok: true, newMtime, taskId, subtaskId, warnings? }
 *   → 404 { error: 'record-not-found' }  parent task or subtask absent
 *   → 409 { error: 'mtime-mismatch' }
 *   → 422 { error: 'schema-error' }      e.g. removal strands a sibling dep
 *   → 400 invalid body / mtime / non-integer subId
 *
 * The written bytes come from a scoped `remove` splice on the
 * parsed-ORIGINAL (untouched records keep their exact bytes); the gate
 * chain asserts the single-id `remove` delta on the exact bytes about to
 * land. Subtask removal never orphans a mirror file (subtasks render
 * inside the parent Task's mirror), so a scoped regen of that one record
 * suffices.
 */
async function handleDeleteSubtask(
  ctx: RequestContext,
  taskId: string,
  subIdRaw: string,
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
  // ID-90.12 U10: per-request overrides ride as body fields (T-3).
  const opt = mutationOptionsOrError(body as Record<string, unknown>);
  if (!opt.ok) return opt.response;
  const options = opt.options;

  // ID-102.7 subId validation (CLI parity): the path segment arrives as a
  // string and `SubtaskSchema.id` is now a digit-string — validate it is a
  // positive-integer digit-string and carry the STRING forward unchanged;
  // anything else is a structured `invalid-id` rather than a confusing 404.
  const subtaskId = subIdRaw;
  if (!/^\d+$/.test(subtaskId) || Number(subtaskId) <= 0) {
    return jsonResponse(
      {
        ok: false,
        error: "invalid-id",
        detail: `subId ${JSON.stringify(subIdRaw)} is not a positive integer; subtask.id must be a string of digits`,
      },
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

  const result = removeSubtask(canonical.detected, taskId, subtaskId);
  if (!result.ok) {
    if (result.kind === "task-not-found") {
      return jsonResponse(
        { ok: false, error: "record-not-found", recordId: result.taskId },
        { status: 404 },
      );
    }
    if (result.kind === "subtask-not-found") {
      return jsonResponse(
        {
          ok: false,
          error: "record-not-found",
          recordId: `${result.taskId}.${result.subtaskId}`,
        },
        { status: 404 },
      );
    }
    return jsonResponse(
      { ok: false, error: "schema-error", issues: result.zodError.issues },
      { status: 422 },
    );
  }

  // ID-90 U3: a subtask DELETE is a `remove` delta on the parent task's
  // subtasks[] id-set. No budget gate — a deletion authors no content.
  const recordSetDescriptor = {
    collection: "subtasks" as const,
    taskId,
  };
  const beforeIds = beforeCollectionIds(canonical.detected, recordSetDescriptor);

  // ID-90 U1: scoped remove splice on the parsed-ORIGINAL — untouched
  // records keep their exact bytes. removeSubtask above is the presence +
  // schema oracle; a splice failure after it passed is internal → 500.
  const spliced = scopedSpliceSerialise(canonical.rawText, {
    kind: "remove",
    collection: "subtasks",
    taskId,
    recordId: subtaskId,
  });
  if (!spliced.ok) {
    return jsonResponse(
      {
        ok: false,
        error: "serialise-failed",
        detail: `scoped splice ${spliced.kind}${
          "detail" in spliced && spliced.detail ? `: ${spliced.detail}` : ""
        }`,
      },
      { status: 500 },
    );
  }

  // ID-90 U3 pre-write gate chain on the EXACT bytes about to land.
  const gateVerdict = runPreWriteGates(
    buildPreWriteGates({
      recordSet: {
        ledgerLabel: canonical.detected.kind,
        beforeIds,
        descriptor: recordSetDescriptor,
        expectedDelta: { kind: "remove", id: subtaskId },
      },
      clientName: {
        priorContent: canonical.rawText,
        requireDenylist: ctx.requireDenylist,
      },
    }),
    // U10: the guard-side override arrives per request (invariant 33).
    { content: spliced.text, options: { allowClientName: options.allowClientName } },
  );
  if (!gateVerdict.ok) {
    return jsonResponse(
      {
        ok: false,
        error: gateVerdict.error,
        detail: gateVerdict.detail,
        ...(gateVerdict.warnings.length > 0
          ? { warnings: gateVerdict.warnings }
          : {}),
      },
      { status: gateVerdict.status },
    );
  }
  // ID-90.12 U10 (invariant 41): discipline warnings {35.30}-scoped to the
  // PARENT task (KH remove-subtask `{taskId}` parity — the removed
  // subtask's own lines vanish with it).
  const responseWarnings = [
    ...disciplineWarnings(result.detected, { taskId }),
    ...gateVerdict.warnings,
  ];

  // ID-90.12 U10 dryRun (invariant 16): full gate chain ran; nothing written.
  if (options.dryRun) {
    return jsonResponse({
      ok: true,
      dryRun: true,
      taskId,
      subtaskId,
      mtime: canonical.mtimeIso,
      ...(responseWarnings.length > 0 ? { warnings: responseWarnings } : {}),
    });
  }

  try {
    await atomicWriteFile(ctx.ledgerPath, spliced.text);
  } catch (err) {
    return jsonResponse(
      { ok: false, error: "write-failed", detail: (err as Error).message },
      { status: 500 },
    );
  }

  // ID-90.12 U10 regenMirrors:false — skip the regen and REPORT it.
  if (!options.regenMirrors) {
    const newMtime = (await stat(ctx.ledgerPath)).mtime.toISOString();
    return jsonResponse({
      ok: true,
      newMtime,
      taskId,
      subtaskId,
      mirrorRegen: "suppressed",
      ...(responseWarnings.length > 0 ? { warnings: responseWarnings } : {}),
    });
  }

  let regen;
  try {
    regen = await generateRecordMirror(result.detected, ctx.ledgerPath, taskId);
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
    taskId,
    subtaskId,
    mirrorDir: regen.mirrorDir,
    mirrorsWritten: regen.written,
    mirrorsDeleted: regen.deleted,
    ...(responseWarnings.length > 0 ? { warnings: responseWarnings } : {}),
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
): Promise<{
  taskListPath: string;
  backlogPath: string;
  /** ID-90 U7: roadmap sibling path when present in the dir — required only
   * when the capability-theme third leg is requested. */
  roadmapPath: string | null;
} | null> {
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
  return {
    taskListPath,
    backlogPath,
    roadmapPath: byName["Knowledge Hub Roadmap"] ?? null,
  };
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
 *     capabilityThemeId?: string,     // ID-90 U7: bind to a roadmap theme
 *     roadmapBaseMtime?: string,      // ID-90 U7: required with capabilityThemeId
 *   }
 *
 * Responses:
 *   → 200 { ok: true, newTaskId, removedBacklogId, taskListMtime, backlogMtime, ... }
 *   → 409 { error: 'mtime-mismatch' | 'duplicate-id' }
 *   → 404 { error: 'backlog-item-not-found' }
 *   → 422 { error: 'schema-error', issues } | { error: 'unknown-document-name' | 'unknown-theme' | ... }
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
    /** ID-90 U7: optional capability-theme third leg. */
    capabilityThemeId?: unknown;
    roadmapBaseMtime?: unknown;
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
  // ID-90.12 U10: per-request overrides ride as body fields (T-3).
  const opt = mutationOptionsOrError(body as Record<string, unknown>);
  if (!opt.ok) return opt.response;
  const options = opt.options;

  // ID-90 U7: optional capability-theme third leg — when bound, the client
  // must also supply its last-seen roadmap mtime (the same per-document
  // collision contract the other two legs carry).
  if (body.capabilityThemeId !== undefined) {
    if (
      typeof body.capabilityThemeId !== "string" ||
      body.capabilityThemeId === ""
    ) {
      return jsonResponse(
        { ok: false, error: "invalid-capabilityThemeId" },
        { status: 400 },
      );
    }
    if (
      typeof body.roadmapBaseMtime !== "string" ||
      body.roadmapBaseMtime === ""
    ) {
      return jsonResponse(
        { ok: false, error: "missing-roadmapBaseMtime" },
        { status: 400 },
      );
    }
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

  // ID-90 U7: the third leg additionally needs the roadmap sibling.
  if (body.capabilityThemeId !== undefined && siblings.roadmapPath === null) {
    return jsonResponse(
      {
        ok: false,
        error: "no-sibling-ledger",
        detail:
          "Promote with capabilityThemeId requires a 'Knowledge Hub Roadmap' " +
          "ledger in the launched ledger's directory.",
      },
      { status: 500 },
    );
  }

  // ID-90 U9: the transaction holds the mutation mutex for EVERY canonical
  // path it touches (two legs, or three with the capability-theme leg).
  // withPathLocks acquires in fixed lexicographic order of the resolved
  // paths (deadlock-free by construction — see path-mutex.ts), so a
  // concurrent single-document writer on any leg serialises against the
  // whole transaction (PRODUCT invariants 38, 46, 56).
  const lockPaths = [siblings.taskListPath, siblings.backlogPath];
  if (body.capabilityThemeId !== undefined && siblings.roadmapPath !== null) {
    lockPaths.push(siblings.roadmapPath);
  }
  const result = await withPathLocks(lockPaths, () =>
    promoteTransaction({
      taskListPath: siblings.taskListPath,
      backlogPath: siblings.backlogPath,
      taskListBaseMtime: body.taskListBaseMtime as string,
      backlogBaseMtime: body.backlogBaseMtime as string,
      sourceBacklogId: body.sourceBacklogId as string,
      taskRecord: body.taskRecord,
      // ID-90.12 U10: the per-request override fields (T-3 — invariants
      // 16, 26, 33; nothing stored between requests).
      dryRun: options.dryRun,
      force: options.force,
      allowClientName: options.allowClientName,
      regenMirrors: options.regenMirrors,
      // ID-90 U9: invariant-34 arming rides every transaction leg too.
      requireDenylist: ctx.requireDenylist,
      ...(body.capabilityThemeId !== undefined && siblings.roadmapPath !== null
        ? {
            capabilityTheme: {
              roadmapPath: siblings.roadmapPath,
              roadmapBaseMtime: body.roadmapBaseMtime as string,
              themeId: body.capabilityThemeId as string,
            },
          }
        : {}),
    }),
  );

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
    // ID-90.12 U10: dry-run marker (invariant 16) + suppressed-regen report.
    ...(result.dryRun === true ? { dryRun: true } : {}),
    ...(result.mirrorRegen !== undefined
      ? { mirrorRegen: result.mirrorRegen }
      : {}),
    // ID-90 U7: present when the capability-theme leg was bound.
    ...(result.boundCapabilityTheme !== undefined
      ? {
          boundCapabilityTheme: result.boundCapabilityTheme,
          roadmapMtime: result.roadmapMtime,
        }
      : {}),
    // U10 warnings envelope: discipline + budget + guard-override
    // warnings (invariant 41).
    ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
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
 * GET /api/health — ID-90 U9 daemon identity + document registry (TECH
 * §Proposed changes U9; the façade's `ensureServer` validates a cached
 * handle against this endpoint). Scans the launch directory PER REQUEST —
 * the same per-request discipline `resolveTransactionSiblings` and the
 * sibling viewer use — so a document added to the directory after boot is
 * reported without a restart.
 */
async function handleGetHealth(ctx: RequestContext): Promise<Response> {
  const ledgerDir = resolve(dirname(ctx.ledgerPath));
  const scan = await scanForLedgers(ledgerDir);
  const entries: Array<{ name: string; path: string }> =
    scan.kind === "one"
      ? [{ name: scan.documentName, path: scan.path }]
      : scan.kind === "multiple"
        ? scan.paths.map((p) => ({ name: scan.perPathName[p], path: p }))
        : [];
  const documents: Array<{
    slug: LedgerSlug;
    document_name: string;
    path: string;
  }> = [];
  for (const { name, path } of entries) {
    const slug = slugForDocumentName(name);
    if (slug === null) continue; // unknown names never reach here (scan filters)
    documents.push({ slug, document_name: name, path: resolve(path) });
  }
  return jsonResponse({
    ok: true,
    version: rootPkg.version,
    ledgerDir,
    documents,
  });
}

// ── Shutdown SSE channel (close-tab-on-exit) ──────────────────────────────────
//
// Clients open an EventSource to GET /api/shutdown-events. On server stop we
// emit a `shutdown` event and close every open stream so the page can render a
// "server stopped" overlay (and best-effort window.close()). The connection
// simply dropping on an ungraceful exit is the fallback signal. window.close()
// is blocked for OS-opened tabs, so the overlay — not auto-close — is the
// reliable UX (see apps/server/web/index.tsx).
const shutdownSubscribers = new Set<
  ReadableStreamDefaultController<Uint8Array>
>();
const SSE_ENCODER = new TextEncoder();

function handleShutdownEvents(): Response {
  let registered: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      registered = controller;
      shutdownSubscribers.add(controller);
      // Establish the stream immediately (a `:` comment line is SSE-ignored).
      controller.enqueue(SSE_ENCODER.encode(": connected\n\n"));
    },
    cancel() {
      if (registered) shutdownSubscribers.delete(registered);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
    },
  });
}

/**
 * Emit a `shutdown` SSE event to every open subscriber and close their
 * streams. Called from the server `stop` path so a clean Ctrl-C tells the
 * browser tab the server is gone. Exported for the shutdown-events test.
 */
export function broadcastShutdown(): void {
  const payload = SSE_ENCODER.encode("event: shutdown\ndata: bye\n\n");
  for (const controller of shutdownSubscribers) {
    try {
      controller.enqueue(payload);
      controller.close();
    } catch {
      // stream already closed/errored — nothing to do.
    }
  }
  shutdownSubscribers.clear();
}

/**
 * Build the per-request dispatcher. Pure function — no closure state
 * other than `ctx`.
 */
function buildFetchHandler(ctx: RequestContext) {
  return async function fetchHandler(request: Request): Promise<Response> {
    // ID-90 U9: every request counts as activity for the idle-exit window.
    ctx.onRequest?.();

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

    // GET /api/health — ID-90 U9 daemon identity + document registry.
    if (path === "/api/health" && request.method === "GET") {
      return handleGetHealth(ctx);
    }

    // GET /api/shutdown-events — SSE channel for close-tab-on-exit.
    if (path === "/api/shutdown-events" && request.method === "GET") {
      return handleShutdownEvents();
    }

    // ID-90 U9 slug routing (TECH §Proposed changes U9 / PRODUCT inv 56):
    // `/api/ledger/:slug/…` routes the request to the NAMED document in
    // the launch directory; the slug segment is stripped and the rest of
    // the dispatcher runs against a context whose ledgerPath is the
    // resolved sibling. Bare `/api/ledger/*` (no slug segment — the next
    // segment is `record` / `regen` / `transaction` or nothing) keeps
    // routing to the LAUNCH document for viewer back-compat. Resolution
    // scans the directory by canonical document_name per request — same
    // discipline as resolveTransactionSiblings.
    let apiPath = path;
    let effCtx = ctx;
    const slugMatch = path.match(/^\/api\/ledger\/([^/]+)(\/.*)?$/);
    if (
      slugMatch &&
      (LEDGER_SLUGS as readonly string[]).includes(slugMatch[1])
    ) {
      const slug = slugMatch[1] as LedgerSlug;
      const documentName = documentNameForSlug(slug);
      const resolvedPath =
        documentName === null
          ? null
          : await resolveLedgerPathByName(ctx.ledgerPath, documentName);
      if (resolvedPath === null) {
        return jsonResponse(
          { ok: false, error: "document-not-found", slug },
          { status: 404 },
        );
      }
      effCtx = { ...ctx, ledgerPath: resolvedPath };
      apiPath = `/api/ledger${slugMatch[2] ?? ""}`;
    }

    // GET /api/ledger
    if (apiPath === "/api/ledger" && request.method === "GET") {
      return handleGetLedger(effCtx);
    }

    // ID-90 U9: every CANONICAL-mutating handler body runs under the
    // per-canonical-path mutation mutex (PRODUCT invariants 38 + 46) —
    // closing the intra-daemon TOCTOU window between the §5.4 mtime check
    // and the atomic-write rename. The transaction acquires its two/three
    // paths inside handlePostTransaction (withPathLocks — fixed
    // lexicographic order) because the sibling paths are only known after
    // body validation. Regen rides the lock too so a mirror regen can
    // never read the canonical mid-write.

    // POST /api/ledger/record — record-level CREATE (ID-20.15). Exact path
    // (no recordId) — matched BEFORE the /:recordId regex below so the
    // collection-level POST is not swallowed by the per-record route.
    if (apiPath === "/api/ledger/record" && request.method === "POST") {
      return withPathLock(effCtx.ledgerPath, () =>
        handlePostRecord(effCtx, request),
      );
    }

    // POST /api/ledger/transaction — cross-ledger atomic Promote (ID-20.15).
    if (apiPath === "/api/ledger/transaction" && request.method === "POST") {
      return handlePostTransaction(effCtx, request);
    }

    // ID-90 U5 subtask routes — matched BEFORE the generic /:recordId route
    // below, whose greedy (.+) would otherwise swallow the nested subtask
    // segments as a record id. U9: both the bare and the slug-routed form
    // arrive here (the slug segment is already stripped into apiPath).
    // POST /api/ledger/record/:taskId/subtask — bulk subtask CREATE.
    const subtaskCollectionMatch = apiPath.match(
      /^\/api\/ledger\/record\/([^/]+)\/subtask$/,
    );
    if (subtaskCollectionMatch) {
      const taskId = decodeURIComponent(subtaskCollectionMatch[1]);
      if (request.method === "POST") {
        return withPathLock(effCtx.ledgerPath, () =>
          handlePostSubtasks(effCtx, taskId, request),
        );
      }
      return jsonResponse(
        { ok: false, error: "method-not-allowed" },
        { status: 405, headers: { allow: "POST" } },
      );
    }
    // DELETE /api/ledger/record/:taskId/subtask/:subId — subtask DELETE.
    const subtaskItemMatch = apiPath.match(
      /^\/api\/ledger\/record\/([^/]+)\/subtask\/([^/]+)$/,
    );
    if (subtaskItemMatch) {
      const taskId = decodeURIComponent(subtaskItemMatch[1]);
      const subId = decodeURIComponent(subtaskItemMatch[2]);
      if (request.method === "DELETE") {
        return withPathLock(effCtx.ledgerPath, () =>
          handleDeleteSubtask(effCtx, taskId, subId, request),
        );
      }
      return jsonResponse(
        { ok: false, error: "method-not-allowed" },
        { status: 405, headers: { allow: "DELETE" } },
      );
    }

    // GET / PATCH / DELETE /api/ledger/record/:recordId
    const recordMatch = apiPath.match(/^\/api\/ledger\/record\/(.+)$/);
    if (recordMatch) {
      const recordId = decodeURIComponent(recordMatch[1]);
      if (request.method === "GET") {
        return handleGetRecord(effCtx, recordId);
      }
      if (request.method === "PATCH") {
        return withPathLock(effCtx.ledgerPath, () =>
          handlePatchRecord(effCtx, recordId, request),
        );
      }
      if (request.method === "DELETE") {
        return withPathLock(effCtx.ledgerPath, () =>
          handleDeleteRecord(effCtx, recordId, request),
        );
      }
      return jsonResponse(
        { ok: false, error: "method-not-allowed" },
        { status: 405, headers: { allow: "GET, PATCH, DELETE" } },
      );
    }

    // POST /api/ledger/regen
    if (apiPath === "/api/ledger/regen" && request.method === "POST") {
      return withPathLock(effCtx.ledgerPath, () =>
        handlePostRegen(effCtx, request),
      );
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

  const ctx: RequestContext = {
    ledgerPath: opts.ledgerPath,
    requireDenylist: opts.requireDenylist === true,
    onRequest: opts.onRequest,
  };
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
      // Tell any open viewer tabs the server is going away before we drop
      // their connections (close-tab-on-exit).
      broadcastShutdown();
      server.stop(force);
    },
  };
}

// Re-export so callers can import the bind constant from this module
// surface without reaching into loopback-bind.ts directly.
export { LOOPBACK_HOSTNAME };
