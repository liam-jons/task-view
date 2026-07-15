/**
 * mirror-generator.ts — TECH §3.1, §3.2, §3.3, §3.4.
 *
 * Generates per-record `.md` mirrors from a parsed ledger into a sibling
 * directory of the canonical JSON file. Output is byte-identical across
 * regenerations from the same canonical input (PRODUCT inv 5: idempotent).
 * Orphan mirrors (records no longer in canonical) are deleted on each
 * regen.
 *
 * Layout (TECH §3.1; ID-148.10 repurposes the roadmap arm + adds retros):
 *   <dir>/task-list.json  → <dir>/tasks/ID-{id}.md
 *   <dir>/initiatives.json → <dir>/initiatives/{topLevelInitiativeId}.md
 *     ONE mirror per TOP-LEVEL initiative (INV-9) — the nested
 *     sub-initiative -> project -> linked-tasks/linked-backlog tree renders
 *     INLINE as a bullet list within that single file (arbitrary recursion
 *     depth via indentation, not per-node files).
 *   <dir>/product-backlog.json → <dir>/backlog/{id}.md
 *   <dir>/product-retros.json → <dir>/retros/{id}.md (ID-148.10, INV-9 — the
 *     retros arm was previously EXCLUDED from mirrors; this adds it)
 *
 * Filename rule (TECH §3.2 — Liam-ratified OQ-C):
 *   - Raw id with filesystem-unsafe characters substituted to '-'.
 *   - Task-list: 'ID-' prefix (because Task ids are bare integers).
 *   - Initiatives / Backlog / Retro records: raw id (already carry
 *     structural identity).
 *
 * Mirror shape (TECH §3.3):
 *   - YAML frontmatter (--- delimited) for structured fields.
 *   - Markdown body for descriptions, Subtasks, journal blocks (verbatim).
 *
 * Idempotency + orphan deletion (TECH §3.4):
 *   - Compute the full target set of mirrors first.
 *   - Read existing mirror dir, delete .md files NOT in the target set.
 *   - Write each target via atomic write-to-temp + rename (POSIX rename(2)
 *     is atomic on the same filesystem).
 *
 * Constraints worth surfacing for the Checker:
 *   - Frontmatter key ordering is fixed (deterministic). Field iteration
 *     uses literal arrays not `Object.keys(...)` — protects against
 *     interpreter ordering differences.
 *   - Strings containing reserved YAML characters get double-quoted; null
 *     emits as the bare literal `null`; arrays of strings emit as flow
 *     lists `[a, b]`; arrays of DocLinks emit as block lists per the
 *     §3.3 example.
 *   - cross_doc_links is emitted as a block list of objects (nested YAML).
 *     The existing Plannotator parser only reads flat key:value + array of
 *     strings — viewer-side support for nested objects is out of scope for
 *     20.7 (lands with ID-20.9 viewer work).
 */

import { rename, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { DetectSchemaResult } from "./detect-schema";
import type { Task, Subtask } from "@task-view/schemas/task-list";
import type { DocLink } from "@task-view/schemas/doc-link";
import type {
  InitiativesDocument,
  Initiative,
  SubInitiative,
  Project,
} from "@task-view/schemas/initiatives";
import type { BacklogItem } from "@task-view/schemas/backlog";
import type { RetrosDocument } from "@task-view/schemas/retro";
import {
  resolveInitiativeNode,
  findProjectBySlug,
  type TreeDoc,
} from "./initiatives-tree";

type RetroRecord = RetrosDocument["retros"][number];
type RetroFinding = RetroRecord["bugs_discovered"][number];

// ── §3.2 Filename helpers ─────────────────────────────────────────────────────

/**
 * Substitute filesystem-unsafe characters in an id with '-'.
 * Per TECH §3.2: unsafe set = `/ \ : * ? " < > |` + control chars 0x00-0x1F + 0x7F.
 */
export function sanitiseFilenameStem(id: string): string {
  let out = "";
  for (let i = 0; i < id.length; i++) {
    const code = id.charCodeAt(i);
    const ch = id[i];
    const isControl = code <= 0x1f || code === 0x7f;
    const isUnsafe = ch === "/" || ch === "\\" || ch === ":" || ch === "*" ||
                     ch === "?" || ch === '"' || ch === "<" || ch === ">" ||
                     ch === "|";
    out += isControl || isUnsafe ? "-" : ch;
  }
  return out;
}

export type LedgerKind = DetectSchemaResult["kind"];

/**
 * The kinds that carry a mirror obligation. ID-148.10 (INV-9): `retro` is
 * NO LONGER excluded — the retros arm was previously excluded from mirrors;
 * this adds it (one mirror per retro record). `umbrellas` no longer exists
 * as a kind at all (fully retired, INV-12(b)), so there is nothing left to
 * exclude beyond `unknown`.
 */
export type MirroredLedgerKind = Exclude<LedgerKind, "unknown">;

/**
 * Compute the record's mirror filename per the §3.2 prefix rules.
 *
 * @param kind - ledger kind (task-list | initiatives | backlog | retro)
 * @param record - `{ id }` — for `initiatives`, the TOP-LEVEL initiative id
 *   (INV-9 — one mirror per top-level initiative, not per project).
 */
export function computeRecordFilename(
  kind: MirroredLedgerKind,
  record: { id: string },
): string {
  const stem = sanitiseFilenameStem(record.id);
  if (kind === "task-list") return `ID-${stem}.md`;
  // initiatives / backlog / retro all use the raw id.
  return `${stem}.md`;
}

/**
 * Compute the mirror directory name (sibling dir basename) per §3.1.
 */
export function computeMirrorDirName(kind: MirroredLedgerKind): string {
  if (kind === "task-list") return "tasks";
  // ID-148.10: repurposed roadmap arm — the literal dir name changes from
  // "roadmap" to "initiatives" (the mirror dir name and the JSON collection
  // key have always been independently chosen strings — see the roadmap-era
  // precedent of "roadmap" dir vs "themes" key).
  if (kind === "initiatives") return "initiatives";
  if (kind === "retro") return "retros";
  return "backlog";
}

// ── YAML emission helpers (deterministic) ─────────────────────────────────────

/**
 * Determine whether a YAML scalar string MUST be quoted.
 * Conservative: quote anything that contains a colon (would parse as
 * key:value), a leading '-' (parses as list marker), wraps to multiple
 * lines, starts with a YAML indicator character, or is a YAML reserved
 * literal (null / true / false / numeric).
 */
function needsQuoting(s: string): boolean {
  if (s === "") return true;
  if (s === "null" || s === "true" || s === "false") return true;
  if (/^-?\d+(\.\d+)?$/.test(s)) return true; // numeric literal
  if (s.includes("\n")) return true;
  if (s.includes(": ")) return true; // YAML key separator
  if (s.includes(" #")) return true; // YAML comment
  // Leading indicator characters
  if (/^[\s\-?:,[\]{}#&*!|>'%@`]/.test(s)) return true;
  // Trailing whitespace
  if (s !== s.trim()) return true;
  return false;
}

/** Quote a YAML scalar string by escaping double-quote + backslash. */
function quoteYamlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Format a YAML scalar value of mixed type (string | number | boolean | null). */
function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  const s = String(value);
  return needsQuoting(s) ? quoteYamlString(s) : s;
}

/** Format an array of strings as a YAML flow list: `[a, "b: c", d]`. */
function formatStringArray(arr: readonly string[]): string {
  if (arr.length === 0) return "[]";
  return `[${arr.map((s) => (needsQuoting(s) ? quoteYamlString(s) : s)).join(", ")}]`;
}

/**
 * Format an array of DocLink objects as block-list YAML:
 *
 *   key:
 *     - path: foo
 *       anchor: null
 *       raw: "raw text"
 *
 * Returns the multi-line block (without the leading `key:` line; caller
 * prepends it). Empty arrays return `[]`.
 */
function formatDocLinkArrayBody(arr: readonly DocLink[]): string {
  if (arr.length === 0) return "[]";
  const lines: string[] = [];
  for (const link of arr) {
    lines.push(`  - path: ${formatScalar(link.path)}`);
    lines.push(`    anchor: ${formatScalar(link.anchor)}`);
    lines.push(`    raw: ${formatScalar(link.raw)}`);
  }
  return "\n" + lines.join("\n");
}

/** Quote even non-reserved id strings — id values are always quoted for stability. */
function formatIdScalar(s: string): string {
  return quoteYamlString(s);
}

// ── §3.3 Task-list mirror shape ───────────────────────────────────────────────

function renderTaskListMirror(task: Task): string {
  const frontmatter = [
    `type: task`,
    `id: ${formatIdScalar(task.id)}`,
    `title: ${formatScalar(task.title)}`,
    `status: ${formatScalar(task.status)}`,
    `priority: ${formatScalar(task.priority)}`,
    `effort_estimate: ${formatScalar(task.effort_estimate)}`,
    `owner: ${formatScalar(task.owner)}`,
    `updated: ${formatScalar(task.updatedAt)}`,
    `session_refs: ${formatStringArray(task.session_refs)}`,
    `commit_refs: ${formatStringArray(task.commit_refs)}`,
    `dependencies: ${formatStringArray(task.dependencies)}`,
    `cross_doc_links: ${formatDocLinkArrayBody(task.cross_doc_links)}`,
    `priority_note: ${formatScalar(task.priority_note)}`,
    `status_note: ${formatScalar(task.status_note)}`,
  ].join("\n");

  const body: string[] = [];
  body.push(`# ID-${task.id}: ${task.title}`);
  body.push("");
  body.push(task.description);
  body.push("");
  body.push("## Subtasks");
  body.push("");
  if (task.subtasks.length === 0) {
    body.push("_No subtasks._");
    body.push("");
  } else {
    for (const subtask of task.subtasks) {
      body.push(renderSubtaskBlock(task.id, subtask));
    }
  }

  return `---\n${frontmatter}\n---\n\n${body.join("\n").trimEnd()}\n`;
}

function renderSubtaskBlock(taskId: string, subtask: Subtask): string {
  const lines: string[] = [];
  lines.push(`### ID-${taskId}.${subtask.id}: ${subtask.title}`);
  lines.push("");
  lines.push(`- **Status:** ${subtask.status}`);
  const depsLine = subtask.dependencies.length === 0
    ? "_none_"
    : subtask.dependencies.map((d) => `ID-${taskId}.${d}`).join(", ");
  lines.push(`- **Dependencies:** ${depsLine}`);
  lines.push(`- **Updated:** ${subtask.updatedAt ?? "_unset_"}`);
  lines.push("");
  lines.push(subtask.description);
  lines.push("");
  if (subtask.testStrategy !== null) {
    lines.push(`**Test strategy:** ${subtask.testStrategy}`);
    lines.push("");
  }
  lines.push(`**Details:**`);
  lines.push("");
  lines.push(subtask.details);
  lines.push("");
  return lines.join("\n");
}

// ── §3.3 Initiatives mirror shape (ID-148.10 — repurposed roadmap arm) ───────
//
// One mirror per TOP-LEVEL initiative (INV-9). The body renders the nested
// sub-initiative -> project -> linked-tasks/linked-backlog tree as an
// indented bullet list (arbitrary recursion depth via indentation, not
// markdown heading levels — headings cap at h6; bullets do not). Ported
// from the KH-native `scripts/generate-initiatives-mirror.ts` (ID-148.9,
// SUPERSEDED by this server-side arm per TECH §8) and adapted to this
// file's YAML-emission helpers for frontmatter consistency with the other
// mirror kinds.

function renderIdList(ids: readonly string[]): string {
  return ids.length > 0 ? ids.join(", ") : "_none_";
}

function renderProjectBullet(project: Project, indent: string): string[] {
  const lines: string[] = [];
  lines.push(`${indent}- **${project.id}** — ${project.title} [${project.status}]`);
  if (project.summary) lines.push(`${indent}  - Summary: ${project.summary}`);
  lines.push(`${indent}  - Linked tasks: ${renderIdList(project.linked_tasks)}`);
  lines.push(`${indent}  - Linked backlog: ${renderIdList(project.linked_backlog)}`);
  if (project.blocked_by.length > 0) {
    lines.push(`${indent}  - Blocked by: ${renderIdList(project.blocked_by)}`);
  }
  if (project.blocking.length > 0) {
    lines.push(`${indent}  - Blocking: ${renderIdList(project.blocking)}`);
  }
  if (project.substrate_doc) {
    lines.push(`${indent}  - Substrate doc: ${project.substrate_doc}`);
  }
  return lines;
}

function renderSubInitiativeBullet(node: SubInitiative, indent: string): string[] {
  const lines: string[] = [];
  lines.push(`${indent}- **${node.id}: ${node.title}** [${node.status}]`);
  if (node.description) lines.push(`${indent}  ${node.description}`);
  if (node.substrate_doc) {
    lines.push(`${indent}  - Substrate doc: ${node.substrate_doc}`);
  }
  const projects = node.projects;
  lines.push(`${indent}  - Projects:${projects.length === 0 ? " _none_" : ""}`);
  for (const project of projects) {
    lines.push(...renderProjectBullet(project, `${indent}    `));
  }
  const subs = node["sub-initiatives"];
  lines.push(`${indent}  - Sub-initiatives:${subs.length === 0 ? " _none_" : ""}`);
  for (const sub of subs) {
    lines.push(...renderSubInitiativeBullet(sub, `${indent}    `));
  }
  return lines;
}

function renderInitiativeMirror(initiative: Initiative): string {
  const frontmatter = [
    `type: initiative`,
    `id: ${formatIdScalar(initiative.id)}`,
    `title: ${formatScalar(initiative.title)}`,
    `status: ${formatScalar(initiative.status)}`,
    `originating_session: ${formatStringArray(initiative.originating_session)}`,
    `substrate_doc: ${formatScalar(initiative.substrate_doc ?? null)}`,
  ].join("\n");

  const body: string[] = [];
  body.push(`# ${initiative.id}: ${initiative.title}`);
  body.push("");
  if (initiative.description) {
    body.push(initiative.description);
    body.push("");
  }

  // Transitional initiative-level off-project links (audit A3 tolerance).
  if (
    (initiative.linked_tasks && initiative.linked_tasks.length > 0) ||
    (initiative.linked_backlog && initiative.linked_backlog.length > 0)
  ) {
    body.push("## Linked tasks / backlog (initiative-level)");
    body.push("");
    body.push(`- Linked tasks: ${renderIdList(initiative.linked_tasks ?? [])}`);
    body.push(`- Linked backlog: ${renderIdList(initiative.linked_backlog ?? [])}`);
    body.push("");
  }

  body.push("## Projects");
  body.push("");
  if (initiative.projects.length === 0) {
    body.push("_none_");
  } else {
    for (const project of initiative.projects) {
      body.push(...renderProjectBullet(project, ""));
    }
  }
  body.push("");

  body.push("## Sub-initiatives");
  body.push("");
  const subs = initiative["sub-initiatives"];
  if (subs.length === 0) {
    body.push("_none_");
  } else {
    for (const sub of subs) {
      body.push(...renderSubInitiativeBullet(sub, ""));
    }
  }
  body.push("");

  return `---\n${frontmatter}\n---\n\n${body.join("\n").trimEnd()}\n`;
}

// ── §3.3 Backlog mirror shape ─────────────────────────────────────────────────

function renderBacklogItemMirror(item: BacklogItem): string {
  // 'type_field' is the renamed surface for BacklogItem.type (TECH §3.3
  // notes the rename: frontmatter 'type' reserved as document-class
  // discriminator).
  const frontmatter: string[] = [
    `type: backlog-item`,
    `id: ${formatIdScalar(item.id)}`,
    `type_field: ${formatScalar(item.type)}`,
    `status: ${formatScalar(item.status)}`,
    `priority: ${formatScalar(item.priority)}`,
    `track: ${formatScalar(item.track)}`,
    `effort_estimate: ${formatScalar(item.effort_estimate)}`,
    `dependencies: ${formatStringArray(item.dependencies)}`,
    `session_refs: ${formatStringArray(item.session_refs)}`,
    `commit_refs: ${formatStringArray(item.commit_refs)}`,
    `cross_doc_links: ${formatDocLinkArrayBody(item.cross_doc_links)}`,
  ];
  // Optional details / testStrategy fields only emitted when present;
  // their presence drives the "promotion-ready" badge (PRODUCT inv 24)
  // in the viewer (ID-20.9). Omission keeps the frontmatter byte-stable
  // for items without those fields.
  if (item.details != null) {
    frontmatter.push(`details: ${formatScalar(item.details)}`);
  }
  if (item.testStrategy != null) {
    frontmatter.push(`testStrategy: ${formatScalar(item.testStrategy)}`);
  }

  const body: string[] = [];
  body.push(`# ${item.id}: ${item.description}`);
  body.push("");
  if (item.notes !== null) {
    body.push(item.notes);
    body.push("");
  }
  if (item.details != null) {
    body.push("**Details:**");
    body.push("");
    body.push(item.details);
    body.push("");
  }
  if (item.testStrategy != null) {
    body.push(`**Test strategy:** ${item.testStrategy}`);
    body.push("");
  }

  return `---\n${frontmatter.join("\n")}\n---\n\n${body.join("\n").trimEnd()}\n`;
}

// ── §3.3 Retro mirror shape (ID-148.10, INV-9 — newly added mirror arm) ──────
//
// Ported from the KH-native `scripts/generate-retros-mirror.ts` (ID-148.9,
// SUPERSEDED by this server-side arm per TECH §8) and adapted to this
// file's YAML-emission helpers.

const RETRO_CATEGORIES: { key: keyof RetroRecord & string; heading: string }[] = [
  { key: "bugs_discovered", heading: "Bugs discovered" },
  { key: "failed_assumptions", heading: "Failed assumptions" },
  { key: "architecture_decisions", heading: "Architecture decisions" },
  { key: "rejected_approaches", heading: "Rejected approaches" },
  { key: "workflow_improvements", heading: "Workflow improvements" },
  { key: "unresolved_questions", heading: "Unresolved questions" },
];

function renderFinding(finding: RetroFinding): string {
  const link =
    finding.cross_doc_links.length > 0
      ? ` (${finding.cross_doc_links.map((l) => l.raw).join("; ")})`
      : "";
  return `- ${finding.text}${link}`;
}

function renderRetroMirror(retro: RetroRecord): string {
  const frontmatter = [
    `type: retro`,
    `id: ${formatIdScalar(retro.id)}`,
    `session_id: ${formatScalar(retro.session_id)}`,
    `date: ${formatScalar(retro.date)}`,
    `track: ${formatScalar(retro.track)}`,
    `session_refs: ${formatStringArray(retro.session_refs)}`,
    `commit_refs: ${formatStringArray(retro.commit_refs)}`,
    `cross_doc_links: ${formatDocLinkArrayBody(retro.cross_doc_links)}`,
    `deprecated: ${formatScalar(retro.deprecated)}`,
    `deprecation_reason: ${formatScalar(retro.deprecation_reason)}`,
    `superseding_record_id: ${formatScalar(retro.superseding_record_id)}`,
    `last_conflict_check: ${formatScalar(retro.last_conflict_check)}`,
  ].join("\n");

  const body: string[] = [];
  body.push(`# ${retro.id}: ${retro.session_id} (${retro.track}) — ${retro.date}`);
  body.push("");
  if (retro.deprecated) {
    const supersededBy = retro.superseding_record_id
      ? ` — superseded by ${retro.superseding_record_id}`
      : "";
    const reason = retro.deprecation_reason ? `: ${retro.deprecation_reason}` : "";
    body.push(`> **Deprecated**${supersededBy}${reason}`);
    body.push("");
  }
  for (const category of RETRO_CATEGORIES) {
    const findings = retro[category.key] as unknown as RetroFinding[];
    body.push(`## ${category.heading}`);
    body.push("");
    if (findings.length === 0) {
      body.push("_none_");
    } else {
      for (const finding of findings) body.push(renderFinding(finding));
    }
    body.push("");
  }

  return `---\n${frontmatter}\n---\n\n${body.join("\n").trimEnd()}\n`;
}

// ── §3.4 Atomic write-to-temp + rename ────────────────────────────────────────

/**
 * Write a file atomically by writing to a temp file in the same directory
 * then renaming. POSIX `rename(2)` is atomic on the same filesystem.
 * Bun's `fs.promises.rename` polyfills cross-platform.
 */
async function atomicWrite(targetPath: string, content: string): Promise<void> {
  const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, targetPath);
  } catch (err) {
    // Best-effort cleanup of the temp file on failure.
    try {
      await rm(tmp, { force: true });
    } catch {
      // Suppress: the original error is what callers should surface.
    }
    throw err;
  }
}

// ── Mirror set planning ───────────────────────────────────────────────────────

interface PlannedMirror {
  filename: string;
  content: string;
}

function planTaskListMirrors(tasks: readonly Task[]): PlannedMirror[] {
  return tasks.map((task) => ({
    filename: computeRecordFilename("task-list", { id: task.id }),
    content: renderTaskListMirror(task),
  }));
}

/** ID-148.10: one planned mirror per TOP-LEVEL initiative (INV-9). */
function planInitiativesMirrors(doc: InitiativesDocument): PlannedMirror[] {
  return doc.initiatives.map((initiative) => ({
    filename: computeRecordFilename("initiatives", { id: initiative.id }),
    content: renderInitiativeMirror(initiative),
  }));
}

function planBacklogMirrors(items: readonly BacklogItem[]): PlannedMirror[] {
  return items.map((item) => ({
    filename: computeRecordFilename("backlog", { id: item.id }),
    content: renderBacklogItemMirror(item),
  }));
}

/** ID-148.10: one planned mirror per retro record (INV-9 — newly added). */
function planRetroMirrors(retros: readonly RetroRecord[]): PlannedMirror[] {
  return retros.map((retro) => ({
    filename: computeRecordFilename("retro", { id: retro.id }),
    content: renderRetroMirror(retro),
  }));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve the mirror directory for a canonical ledger path.
 * `<dir>/{task-list,initiatives,product-backlog,product-retros}.json` →
 * `<dir>/{tasks,initiatives,backlog,retros}/`
 */
export function resolveMirrorDir(
  kind: MirroredLedgerKind,
  canonicalPath: string,
): string {
  return join(dirname(canonicalPath), computeMirrorDirName(kind));
}

/**
 * Given a bare `recordId` as it arrives at the scoped single-record regen
 * path, resolve which TOP-LEVEL initiative's mirror needs regenerating
 * (ID-148.10, INV-9 — mirrors are per-top-level-initiative, not per-project
 * or per-sub-initiative). Tries the initiative-PATH interpretation first
 * (bare-digit-dotted, e.g. `"4"`/`"4.2"`), then falls back to a project-SLUG
 * tree-search — the same disambiguation order `initiatives-tree.ts`'s
 * `resolveRecordId` uses. Returns `null` when neither resolves.
 */
function resolveTopLevelInitiativeId(
  doc: TreeDoc,
  recordId: string,
): string | null {
  const asPath = recordId.split(".")[0];
  if (resolveInitiativeNode(doc, asPath)) return asPath;
  const located = findProjectBySlug(doc, recordId);
  return located ? located.topLevelInitiativeId : null;
}

/**
 * Render the mirror content for a single record by id, or return `null`
 * when no record with that id exists in the ledger.
 *
 * Used by the scoped single-record regen path (Subtask 20.23) — shares the
 * exact rendering helpers `generateMirrors` uses so a scoped write is
 * byte-identical to the same record's slot in a full regen.
 */
function renderRecordMirror(
  detected: Extract<DetectSchemaResult, { kind: MirroredLedgerKind }>,
  recordId: string,
): { filename: string; content: string } | null {
  if (detected.kind === "task-list") {
    const task = detected.data.tasks.find((t) => t.id === recordId);
    if (!task) return null;
    return {
      filename: computeRecordFilename("task-list", { id: task.id }),
      content: renderTaskListMirror(task),
    };
  }
  // ID-148.10: repurposed roadmap arm — scoped regen resolves the TOP-LEVEL
  // initiative that owns the addressed project/initiative/sub-initiative.
  if (detected.kind === "initiatives") {
    const topLevelId = resolveTopLevelInitiativeId(
      detected.data as unknown as TreeDoc,
      recordId,
    );
    if (!topLevelId) return null;
    const initiative = detected.data.initiatives.find(
      (i) => i.id === topLevelId,
    );
    if (!initiative) return null;
    return {
      filename: computeRecordFilename("initiatives", { id: initiative.id }),
      content: renderInitiativeMirror(initiative),
    };
  }
  // ID-148.10: retros arm — flat by id (INV-9 addition).
  if (detected.kind === "retro") {
    const retro = detected.data.retros.find((r) => r.id === recordId);
    if (!retro) return null;
    return {
      filename: computeRecordFilename("retro", { id: retro.id }),
      content: renderRetroMirror(retro),
    };
  }
  const item = detected.data.items.find((it) => it.id === recordId);
  if (!item) return null;
  return {
    filename: computeRecordFilename("backlog", { id: item.id }),
    content: renderBacklogItemMirror(item),
  };
}

/**
 * Regenerate ONLY the named record's mirror (Subtask 20.23 / PRODUCT inv
 * 38).
 *
 * 20.16 smoke-test S10 + Side-observation 5: a multi-field PATCH touches a
 * single record but the prior implementation regenerated the WHOLE ledger,
 * rewriting every mirror (advancing every mtime) — wasteful and surprising
 * at scale. A field PATCH can only mutate fields WITHIN an existing record;
 * it can never add or remove records, so there is no orphan-deletion
 * concern — scoping to the touched record's mirror is safe + correct.
 * ID-148.10: for `initiatives`, "the touched record's mirror" means the
 * OWNING top-level initiative's single mirror file, even when the patch
 * addressed a nested project or sub-initiative (INV-9).
 *
 * Writes the single mirror via the same atomic write-to-temp + rename used
 * by the full generator, so unaffected mirrors keep a stable mtime.
 *
 * Throws if the input is `{ kind: 'unknown' }`; returns `written: []` when
 * the record id is not found (caller has already validated the record
 * exists via the PATCH walk, so this is defensive).
 */
export async function generateRecordMirror(
  detected: DetectSchemaResult,
  canonicalPath: string,
  recordId: string,
): Promise<{ mirrorDir: string; written: string[]; deleted: string[] }> {
  if (detected.kind === "unknown") {
    throw new Error(
      `Cannot generate mirror for unknown ledger kind (document_name: ${detected.documentName ?? "null"}).`,
    );
  }
  const mirrorDir = resolveMirrorDir(detected.kind, canonicalPath);
  const planned = renderRecordMirror(detected, recordId);
  if (!planned) {
    return { mirrorDir, written: [], deleted: [] };
  }
  // Ensure the mirror directory exists (inv 40 first-run tolerance).
  await mkdir(mirrorDir, { recursive: true });
  await atomicWrite(join(mirrorDir, planned.filename), planned.content);
  return { mirrorDir, written: [planned.filename], deleted: [] };
}

/**
 * Generate per-record mirrors for the parsed ledger. Idempotent. Orphan
 * mirrors are deleted on each run.
 *
 * Throws if the input is `{ kind: 'unknown' }` — caller (CLI) should have
 * already exited with a friendly error before reaching here.
 */
export async function generateMirrors(
  detected: DetectSchemaResult,
  canonicalPath: string,
): Promise<{ mirrorDir: string; written: string[]; deleted: string[] }> {
  if (detected.kind === "unknown") {
    throw new Error(
      `Cannot generate mirrors for unknown ledger kind (document_name: ${detected.documentName ?? "null"}).`,
    );
  }

  const kind = detected.kind;
  const mirrorDir = resolveMirrorDir(kind, canonicalPath);

  // Plan the full target set first (deterministic order, but writes are
  // independent so order is purely for predictability).
  let planned: PlannedMirror[];
  if (kind === "task-list") {
    planned = planTaskListMirrors(detected.data.tasks);
  } else if (kind === "initiatives") {
    // ID-148.10: repurposed roadmap arm — one mirror per top-level initiative.
    planned = planInitiativesMirrors(detected.data);
  } else if (kind === "retro") {
    // ID-148.10 (INV-9): the retros arm, newly added.
    planned = planRetroMirrors(detected.data.retros);
  } else {
    planned = planBacklogMirrors(detected.data.items);
  }

  // Ensure the mirror directory exists (PRODUCT inv 40 first-run tolerance).
  await mkdir(mirrorDir, { recursive: true });

  // Orphan deletion: any existing .md file NOT in the planned target set
  // is removed (§3.4). Non-.md files are left alone (e.g. .gitkeep).
  const plannedNames = new Set(planned.map((p) => p.filename));
  const existing = await readdir(mirrorDir);
  const deleted: string[] = [];
  for (const name of existing) {
    if (!name.endsWith(".md")) continue;
    if (!plannedNames.has(name)) {
      await rm(join(mirrorDir, name), { force: true });
      deleted.push(name);
    }
  }

  // Write each planned mirror via atomic write-to-temp + rename.
  const written: string[] = [];
  for (const p of planned) {
    await atomicWrite(join(mirrorDir, p.filename), p.content);
    written.push(p.filename);
  }

  return { mirrorDir, written, deleted };
}
