/**
 * record-view/anchors.ts — in-page anchor builders for sibling-Subtask
 * deps (PRODUCT inv 13, TECH §4.4).
 *
 * "Within a Task page, sibling Subtask links resolve to in-page anchors
 *  (`#subtask-${subtaskId}`) generated via Plannotator's `slugify.ts`."
 *
 * The id is the Subtask integer id (1..N within the parent Task). We use
 * the deterministic `subtask-${id}` form (no slugify needed because the
 * id is already a bare integer); the slugify helper from the upstream
 * parser is reserved for heading-derived anchors per its own contract.
 *
 * The live-server cross-record href builder (`recordRouteHref`) also
 * lives here so the per-mode renderers don't duplicate route logic.
 */

const TASK_MIRROR_PREFIX = "ID-";

/**
 * The three cross-ledger nav slugs ({20.29}, SPEC §2). Declared in the UI
 * layer (and mirrored server-side in `packages/server/cross-ledger.ts`)
 * because `packages/ui` must not import from `packages/server` — the slug
 * string set is a tiny, stable contract shared by both. Keep the two in
 * sync (both derive from the same SPEC §2 table). ID-148.10: `roadmap` is
 * repurposed to `initiatives` (viewer-navigable WITH editing, OQ2);
 * `umbrellas` was never a viewer-navigable slug and is now fully retired.
 */
export type LedgerSlug = "task-list" | "initiatives" | "backlog";

/**
 * In-page anchor id for a sibling Subtask (`subtask-3`). Used as the
 * fragment in href (`#subtask-3`) AND as the `id` attribute of the
 * Subtask block heading.
 */
export function subtaskAnchorId(subtaskId: string): string {
  return `subtask-${subtaskId}`;
}

/**
 * Href to a sibling Subtask's anchor within the same Task page.
 */
export function subtaskHref(subtaskId: string): string {
  return `#${subtaskAnchorId(subtaskId)}`;
}

/**
 * Href to another record's page on the live loopback server, from any
 * record or index page.
 *
 * The server routes every record kind (Task / Initiative / Project /
 * Backlog item) purely on the `?record=<id>` query param — see
 * `packages/server/render-viewer.tsx`. The record id is unique within a
 * ledger and the server already knows the ledger kind, so one builder
 * serves all three kinds. There is no per-kind `.md` route on the live
 * surface: the `ID-{id}.md` / `{id}.md` filenames exist only as on-disk
 * mirrors, emitted independently by `mirror-generator.ts` /
 * `index-generator.ts`.
 */
export function recordRouteHref(recordId: string): string {
  return `/?record=${encodeURIComponent(recordId)}`;
}

/**
 * Href to a record in a SIBLING ledger ({20.29}, SPEC §5 slice 2).
 *
 * Form: `/?ledger=<slug>&record=<id>`. The server (handleGetRoot) parses
 * the `ledger` slug, resolves the sibling ledger's path in the launched
 * ledger's directory, and renders that sibling's record READ-ONLY.
 *
 * The slug is a server-controlled literal (never user input here) so it is
 * emitted verbatim; only the record id is URL-encoded. Distinct from
 * `recordRouteHref`, which stays the intra-ledger (launched-ledger) form
 * and must remain byte-for-byte back-compatible (`/?record=<id>`).
 */
export function crossLedgerRecordHref(
  slug: LedgerSlug,
  recordId: string,
): string {
  return `/?ledger=${slug}&record=${encodeURIComponent(recordId)}`;
}

/**
 * Intra-ledger record href that PRESERVES the active sibling selection.
 *
 * Record / index-row / nav-strip links are static SSR anchors with no
 * client-side click interception, so a bare `/?record=<id>` drops the page's
 * `?ledger=<slug>` and the server falls back to the LAUNCHED ledger (opening
 * the wrong record). When a sibling is the active editable target
 * (`activeSlug` set — i.e. the page URL carries `?ledger=<slug>`), emit the
 * slug-qualified form so the link resolves within that sibling. With no active
 * slug (launched ledger / no `?ledger=`), it stays byte-for-byte the bare
 * back-compat form (`/?record=<id>`).
 */
export function activeRecordHref(
  recordId: string,
  activeSlug?: LedgerSlug | null,
): string {
  return activeSlug
    ? crossLedgerRecordHref(activeSlug, recordId)
    : recordRouteHref(recordId);
}

/**
 * In-page anchor id for an index row (`record-20`). Emitted as the `id`
 * attribute of each index `<tr>` AND used as the fragment of the record's
 * "Back to …" link, so returning from a record scrolls the index back to the
 * row the user came from instead of the top of the page.
 *
 * Record ids are anchor-safe (bare-digit or `ID-`-prefixed), so the same
 * string serves as both the `id` attribute and the URL fragment without
 * encoding (encoding would desync the two).
 */
export function indexRowAnchorId(recordId: string): string {
  return `record-${recordId}`;
}

/**
 * "Back to index" href that returns to the row the user just viewed:
 * `/[?<query>]#record-<id>`. The optional `query` (no leading `?`) lets a
 * filtered/sorted index round-trip its state alongside the scroll anchor; an
 * empty/absent query yields the bare `/#record-<id>` form.
 */
export function indexHrefWithAnchor(recordId: string, query?: string): string {
  const q = query ? `?${query}` : "";
  return `/${q}#${indexRowAnchorId(recordId)}`;
}

/**
 * Label for a sibling-Subtask dep link (used inline in the Dependencies
 * row of the Subtask block frontmatter).
 */
export function subtaskDepLabel(
  parentTaskId: string,
  subtaskId: string,
): string {
  return `${TASK_MIRROR_PREFIX}${parentTaskId}.${subtaskId}`;
}

/**
 * Label for a Task-level dep link.
 */
export function taskDepLabel(taskId: string): string {
  return `${TASK_MIRROR_PREFIX}${taskId}`;
}
