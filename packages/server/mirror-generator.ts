/**
 * mirror-generator.ts — TECH §3.1, §3.2, §3.3, §3.4.
 *
 * Generates per-record `.md` mirrors from a parsed ledger into a sibling
 * directory of the canonical JSON file. Output is byte-identical across
 * regenerations from the same canonical input (PRODUCT inv 5: idempotent).
 * Orphan mirrors (records no longer in canonical) are deleted on each
 * regen.
 *
 * Layout (TECH §3.1):
 *   <dir>/task-list.json       → <dir>/tasks/ID-{id}.md
 *   <dir>/product-roadmap.json → <dir>/roadmap/{id}.md (themes)
 *   <dir>/product-backlog.json → <dir>/backlog/{id}.md
 *
 * Roadmap shape note (ID-20.19): the Phase-B themes[] roadmap replaced the
 * retired sections[]/items[] model. One mirror is generated per theme,
 * keyed by the bare-digit theme id; there is no section/item nesting and
 * no `section-` prefix.
 *
 * Filename rule (TECH §3.2 — Liam-ratified OQ-C):
 *   - Raw id with filesystem-unsafe characters substituted to '-'.
 *   - Task-list: 'ID-' prefix (because Task ids are bare integers).
 *   - Roadmap themes / Backlog items: raw id (already carry structural identity).
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
import type {
  Roadmap,
  RoadmapTheme,
  DocLink,
} from "@task-view/schemas/roadmap";
import type { BacklogItem } from "@task-view/schemas/backlog";

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
 * Compute the record's mirror filename per the §3.2 prefix rules.
 *
 * @param kind - ledger kind (task-list | roadmap | backlog)
 * @param record - `{ id }`
 *
 * Roadmap shape note (ID-20.19): roadmap themes use the raw bare-digit id
 * (`{id}.md`). The old `section-` prefix (which disambiguated sections from
 * items) is gone — themes are the only roadmap record kind.
 */
export function computeRecordFilename(
  kind: Exclude<LedgerKind, "unknown">,
  record: { id: string },
): string {
  const stem = sanitiseFilenameStem(record.id);
  if (kind === "task-list") return `ID-${stem}.md`;
  // roadmap (themes) + backlog both use the raw id.
  return `${stem}.md`;
}

/**
 * Compute the mirror directory name (sibling dir basename) per §3.1.
 */
export function computeMirrorDirName(
  kind: Exclude<LedgerKind, "unknown">,
): string {
  if (kind === "task-list") return "tasks";
  if (kind === "roadmap") return "roadmap";
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

// ── §3.3 Roadmap mirror shape (ID-20.19 — themes[]) ───────────────────────────

function renderRoadmapThemeMirror(theme: RoadmapTheme): string {
  const frontmatter = [
    `type: roadmap-theme`,
    `id: ${formatIdScalar(theme.id)}`,
    `title: ${formatScalar(theme.title)}`,
    `time_horizon: ${formatScalar(theme.time_horizon)}`,
    `status: ${formatScalar(theme.status)}`,
    `linked_tasks: ${formatStringArray(theme.linked_tasks)}`,
    `linked_backlog: ${formatStringArray(theme.linked_backlog)}`,
    `session_refs: ${formatStringArray(theme.session_refs)}`,
    `commit_refs: ${formatStringArray(theme.commit_refs)}`,
    `cross_doc_links: ${formatDocLinkArrayBody(theme.cross_doc_links)}`,
    `notes: ${formatScalar(theme.notes)}`,
  ].join("\n");

  const body: string[] = [];
  body.push(`# ${theme.id}: ${theme.title}`);
  body.push("");
  body.push(theme.description);
  body.push("");
  if (theme.notes !== null) {
    body.push("## Notes");
    body.push("");
    body.push(theme.notes);
    body.push("");
  }

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

function planRoadmapMirrors(roadmap: Roadmap): PlannedMirror[] {
  return roadmap.themes.map((theme) => ({
    filename: computeRecordFilename("roadmap", { id: theme.id }),
    content: renderRoadmapThemeMirror(theme),
  }));
}

function planBacklogMirrors(items: readonly BacklogItem[]): PlannedMirror[] {
  return items.map((item) => ({
    filename: computeRecordFilename("backlog", { id: item.id }),
    content: renderBacklogItemMirror(item),
  }));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve the mirror directory for a canonical ledger path.
 * `<dir>/{task-list,product-roadmap,product-backlog}.json` → `<dir>/{tasks,roadmap,backlog}/`
 */
export function resolveMirrorDir(
  kind: Exclude<LedgerKind, "unknown">,
  canonicalPath: string,
): string {
  return join(dirname(canonicalPath), computeMirrorDirName(kind));
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
  } else if (kind === "roadmap") {
    planned = planRoadmapMirrors(detected.data);
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
