/**
 * initiatives-tree.ts — shared tree-walk primitives for the nested
 * initiatives ledger shape (ID-148.10, TECH §3.1(b), INV-13).
 *
 * The initiatives document is a TREE, not a flat top-level collection like
 * every other ledger this server handles: `initiatives[]` -> `projects[]` +
 * recursive `sub-initiatives[]` (which themselves carry `projects[]` + more
 * `sub-initiatives[]`, to arbitrary depth). Two addressable node shapes:
 *
 *   - a **project**, addressed by its GLOBALLY-UNIQUE slug `id` (audit A9) —
 *     the server tree-walks the whole document to find it regardless of
 *     which initiative/sub-initiative currently owns it;
 *   - an **initiative or sub-initiative**, addressed by a DOTTED PATH of ids
 *     from the top-level initiative down (e.g. `"4"`, `"4.2"`, `"4.2.1"`).
 *
 * This module is used by BOTH the typed callers (`record-mutate.ts`,
 * `patch-apply.ts`, `gates/*.ts`, `mirror-generator.ts` — operate on the
 * Zod-parsed `InitiativesDocument`) and the untyped `scoped-serialise.ts`
 * (operates on `JSON.parse(originalText)` plain objects, to preserve
 * on-disk key order — ID-90 U1). A tree node only needs `id`, `projects`,
 * and `'sub-initiatives'` to be walkable, so one structurally-typed
 * implementation serves both — the typed callers pass an
 * `InitiativesDocument`/`Initiative`/`Project`, which structurally satisfies
 * `TreeDoc`/`TreeNode`/`Record<string, unknown>`; the untyped caller passes
 * plain objects directly. Neither path re-implements the walk, so the two
 * can never drift (the same discipline `applyValueToLeaf` in
 * `patch-apply.ts` already applies to leaf mutation).
 */

// ── structural types (duck-typed — satisfied by both typed and plain data) ──

/** A tree node — an Initiative or SubInitiative. Only the three walkable
 * fields are declared; everything else passes through untouched. */
export interface TreeNode {
  id: string;
  projects?: unknown;
  "sub-initiatives"?: unknown;
  [key: string]: unknown;
}

/** The root document — only the one walkable field is declared. */
export interface TreeDoc {
  initiatives?: unknown;
  [key: string]: unknown;
}

function asNodeArray(value: unknown): TreeNode[] {
  return Array.isArray(value) ? (value as TreeNode[]) : [];
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

// ── initiative/sub-initiative path resolution ────────────────────────────

/**
 * Resolve a dotted initiative path (e.g. `"4"`, `"4.2"`) to the node itself.
 * The first segment matches a top-level `initiatives[].id`; each subsequent
 * segment matches a `'sub-initiatives'[].id` one level deeper. Returns
 * `null` when any segment fails to resolve (missing initiative, path runs
 * past a leaf with no further sub-initiatives, etc).
 */
export function resolveInitiativeNode(
  doc: TreeDoc,
  path: string,
): TreeNode | null {
  const segments = path.split(".").filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  let level = asNodeArray(doc.initiatives);
  let node: TreeNode | null = null;
  for (const segment of segments) {
    node = level.find((n) => n.id === segment) ?? null;
    if (!node) return null;
    level = asNodeArray(node["sub-initiatives"]);
  }
  return node;
}

/**
 * Every valid dotted initiative/sub-initiative path in the document
 * (depth-first, top-level first). Used by the record-set gate + any
 * discoverability surface.
 */
export function allInitiativePaths(doc: TreeDoc): string[] {
  const paths: string[] = [];
  function walk(nodes: TreeNode[], prefix: string): void {
    for (const node of nodes) {
      const path = prefix === "" ? node.id : `${prefix}.${node.id}`;
      paths.push(path);
      walk(asNodeArray(node["sub-initiatives"]), path);
    }
  }
  walk(asNodeArray(doc.initiatives), "");
  return paths;
}

// ── project location (tree-walk-find-by-slug) ────────────────────────────

/** Where a project lives in the tree — its owning node's `projects[]`
 * array (for in-place mutation/splice) plus the TOP-LEVEL initiative id
 * that owns it (for mirror-regen scoping — INV-9 renders one mirror per
 * top-level initiative). */
export interface ProjectLocation {
  project: Record<string, unknown>;
  ownerProjects: Record<string, unknown>[];
  topLevelInitiativeId: string;
}

function findInNode(
  node: TreeNode,
  topLevelInitiativeId: string,
  slug: string,
): ProjectLocation | null {
  const projects = asRecordArray(node.projects);
  const hit = projects.find((p) => p.id === slug);
  if (hit) {
    return { project: hit, ownerProjects: projects, topLevelInitiativeId };
  }
  for (const sub of asNodeArray(node["sub-initiatives"])) {
    const found = findInNode(sub, topLevelInitiativeId, slug);
    if (found) return found;
  }
  return null;
}

/**
 * Tree-walk-find a project by its globally-unique slug anywhere under
 * `doc.initiatives` (regardless of nesting depth). Returns `null` when no
 * project carries that slug.
 */
export function findProjectBySlug(
  doc: TreeDoc,
  slug: string,
): ProjectLocation | null {
  for (const top of asNodeArray(doc.initiatives)) {
    const found = findInNode(top, top.id, slug);
    if (found) return found;
  }
  return null;
}

/**
 * Every project slug anywhere in the tree (flattened). This is the
 * globally-unique id-set the record-set gate + duplicate-slug create-check
 * operate against (INV-13 — "the record-set gate and id-minting walk the
 * whole tree, not a flat array").
 */
export function allProjectSlugs(doc: TreeDoc): string[] {
  const slugs: string[] = [];
  function walk(node: TreeNode): void {
    for (const p of asRecordArray(node.projects)) {
      if (typeof p.id === "string") slugs.push(p.id);
    }
    for (const sub of asNodeArray(node["sub-initiatives"])) walk(sub);
  }
  for (const top of asNodeArray(doc.initiatives)) walk(top);
  return slugs;
}

// ── insertion ──────────────────────────────────────────────────────────────

export type InsertProjectResult =
  | { ok: true }
  | { ok: false; detail: string };

/**
 * Insert `record` into the `projects[]` array of the node addressed by
 * `initiativePath` (dotted — may be a top-level initiative or any depth of
 * sub-initiative). Mutates the resolved node's `projects` array in place
 * (pushes; creates the array if the node structurally lacks one — defensive,
 * a validated document always carries it). Returns a `detail` error when
 * the path does not resolve.
 */
export function insertProjectAt(
  doc: TreeDoc,
  initiativePath: string,
  record: unknown,
): InsertProjectResult {
  const node = resolveInitiativeNode(doc, initiativePath);
  if (!node) {
    return {
      ok: false,
      detail: `Initiative path "${initiativePath}" not found in canonical initiatives[]/sub-initiatives[] tree.`,
    };
  }
  if (!Array.isArray(node.projects)) {
    node.projects = [];
  }
  (node.projects as unknown[]).push(record);
  return { ok: true };
}

// ── removal ────────────────────────────────────────────────────────────────

export type RemoveProjectResult =
  | { ok: true; topLevelInitiativeId: string }
  | { ok: false };

/**
 * Remove a project by slug from wherever it lives in the tree. Splices the
 * owning node's `projects[]` array in place. Returns the removed project's
 * top-level initiative id (for scoped mirror regen) on success.
 */
export function removeProjectBySlug(
  doc: TreeDoc,
  slug: string,
): RemoveProjectResult {
  const located = findProjectBySlug(doc, slug);
  if (!located) return { ok: false };
  const idx = located.ownerProjects.findIndex((p) => p.id === slug);
  if (idx === -1) return { ok: false };
  located.ownerProjects.splice(idx, 1);
  return { ok: true, topLevelInitiativeId: located.topLevelInitiativeId };
}

// ── recordId disambiguation (project slug vs initiative path) ────────────

export type ResolvedRecordId =
  | { kind: "project"; location: ProjectLocation }
  | { kind: "initiative"; path: string; node: TreeNode }
  | { kind: "not-found" };

/**
 * Disambiguate a bare `recordId` (as arrives via the generic
 * `GET|PATCH|DELETE /api/ledger/record/:recordId` routes) into either a
 * project (tree-walk-by-slug) or an initiative/sub-initiative
 * (path-resolve). Tries the initiative-path interpretation FIRST — initiative
 * paths are bare-digit-dotted (`"4"`, `"4.2"`) and project slugs are
 * kebab-case, so the two vocabularies do not collide in practice; trying
 * path-resolution first is a deterministic, order-independent choice.
 */
export function resolveRecordId(
  doc: TreeDoc,
  recordId: string,
): ResolvedRecordId {
  const node = resolveInitiativeNode(doc, recordId);
  if (node) return { kind: "initiative", path: recordId, node };
  const location = findProjectBySlug(doc, recordId);
  if (location) return { kind: "project", location };
  return { kind: "not-found" };
}

/**
 * Resolve the TOP-LEVEL initiative id that owns a given `recordId` — a
 * project slug OR an initiative/sub-initiative dotted path. Shared by
 * `mirror-generator.ts`-scoping callers (`patch-server.ts`'s mirror-filename
 * resolution) and `render-viewer.tsx`'s SSR `?record=` dispatch (INV-9: one
 * page/mirror per top-level initiative, not per project or per
 * sub-initiative) — a single implementation so the two paths can never
 * drift on which top-level initiative a nested node belongs to.
 */
export function resolveTopLevelInitiativeIdForRecordId(
  doc: TreeDoc,
  recordId: string,
): string | null {
  const asPath = recordId.split(".")[0];
  if (resolveInitiativeNode(doc, asPath)) return asPath;
  const located = findProjectBySlug(doc, recordId);
  return located ? located.topLevelInitiativeId : null;
}
