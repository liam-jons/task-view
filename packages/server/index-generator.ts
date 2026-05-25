/**
 * index-generator.ts — index.md generators alongside per-record mirrors
 * (TECH §4.3 — index page implementation, generator side).
 *
 * Extension to `mirror-generator.ts` (no modification to its existing
 * behaviour per the 20.9 brief's "extending exports OK, no behaviour
 * change to existing" rule). The Read-side rendering of these index
 * `.md` files happens in `@task-view/ui` record-view components; this
 * module just emits the deterministic text mirror.
 *
 * Layout (mirrors `mirror-generator.ts` §3.1):
 *   <dir>/task-list.json       → <dir>/tasks/index.md
 *   <dir>/product-roadmap.json → <dir>/roadmap/index.md
 *   <dir>/product-backlog.json → <dir>/backlog/index.md
 *
 * Idempotency: same canonical input → byte-identical index.md output.
 * Cross-platform: file path uses OS-native separators via `node:path`;
 * link content inside the rendered .md uses forward slashes per
 * PRODUCT inv 52.
 */
import { join } from "node:path";

import type { DetectSchemaResult } from "./detect-schema";
import { resolveMirrorDir } from "./mirror-generator";
import type {
  BacklogItem,
} from "@task-view/schemas/backlog";
import type { Roadmap } from "@task-view/schemas/roadmap";
import type { Task } from "@task-view/schemas/task-list";

export type LedgerKindExceptUnknown = Exclude<
  DetectSchemaResult["kind"],
  "unknown"
>;

/**
 * Produce the index.md text body for a parsed ledger. Pure function;
 * caller is responsible for writing it to disk (typically alongside the
 * per-record mirrors via the mirror-generator's atomic write).
 *
 * The body is a Markdown table the read-mode viewer (or any human
 * reading the file directly on GitHub) can browse. Empty ledgers emit
 * the empty-state placeholder phrase per PRODUCT inv 47.
 */
export function renderIndexMd(detected: DetectSchemaResult): string {
  if (detected.kind === "unknown") {
    throw new Error("Cannot render index.md for unknown ledger kind.");
  }
  if (detected.kind === "task-list") {
    return renderTaskListIndex(detected.data.tasks);
  }
  if (detected.kind === "roadmap") {
    return renderRoadmapIndex(detected.data);
  }
  // backlog
  return renderBacklogIndex(detected.data.items);
}

/**
 * Compute the index.md file path for a canonical ledger JSON path.
 * Sibling-directory layout matches `mirror-generator.resolveMirrorDir`.
 */
export function indexMdPath(
  kind: LedgerKindExceptUnknown,
  canonicalPath: string,
): string {
  return join(resolveMirrorDir(kind, canonicalPath), "index.md");
}

// ── Per-mode index renderers ──────────────────────────────────────────────────

function renderTaskListIndex(tasks: readonly Task[]): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push("type: task-list-index");
  lines.push(`item_count: ${tasks.length}`);
  lines.push("---");
  lines.push("");
  lines.push("# Task list");
  lines.push("");
  if (tasks.length === 0) {
    lines.push("_The Task list ledger is empty._");
    lines.push("");
    return lines.join("\n");
  }
  lines.push("| ID | Title | Status | Priority | Subtasks |");
  lines.push("|----|-------|--------|----------|----------|");
  for (const task of tasks) {
    const safeTitle = escapePipe(task.title);
    lines.push(
      `| [ID-${task.id}](ID-${task.id}.md) | ${safeTitle} | ${task.status} | ${task.priority} | ${task.subtasks.length} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function renderRoadmapIndex(roadmap: Roadmap): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push("type: roadmap-index");
  lines.push(`theme_count: ${roadmap.themes.length}`);
  lines.push("---");
  lines.push("");
  lines.push("# Roadmap");
  lines.push("");
  if (roadmap.themes.length === 0) {
    lines.push("_The Roadmap ledger has no themes._");
    lines.push("");
    return lines.join("\n");
  }
  lines.push("| ID | Title | Time horizon | Status | Linked tasks |");
  lines.push("|----|-------|--------------|--------|--------------|");
  for (const theme of roadmap.themes) {
    const title = escapePipe(theme.title);
    lines.push(
      `| [${theme.id}](${theme.id}.md) | ${title} | ${theme.time_horizon} | ${theme.status} | ${theme.linked_tasks.length} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function renderBacklogIndex(items: readonly BacklogItem[]): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push("type: backlog-index");
  lines.push(`item_count: ${items.length}`);
  lines.push("---");
  lines.push("");
  lines.push("# Backlog");
  lines.push("");
  if (items.length === 0) {
    lines.push("_The Backlog ledger is empty._");
    lines.push("");
    return lines.join("\n");
  }
  // Sort by track, status, then numeric id (mirrors the rendered view).
  const sorted = [...items].sort((a, b) => {
    if (a.track !== b.track) return a.track < b.track ? -1 : 1;
    if (a.status !== b.status) return a.status < b.status ? -1 : 1;
    const an = Number.parseInt(a.id, 10);
    const bn = Number.parseInt(b.id, 10);
    if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn;
    return a.id < b.id ? -1 : 1;
  });
  lines.push("| ID | Description | Type | Status | Priority | Track | Effort |");
  lines.push("|----|-------------|------|--------|----------|-------|--------|");
  for (const item of sorted) {
    const desc = escapePipe(item.description);
    const effort = item.effort_estimate === null ? "—" : escapePipe(item.effort_estimate);
    lines.push(
      `| [${item.id}](${item.id}.md) | ${desc} | ${item.type} | ${item.status} | ${item.priority} | ${escapePipe(item.track)} | ${effort} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Escape pipe characters in cell content so the Markdown table doesn't
 * break. Standard GFM escape: `|` → `\|`.
 */
function escapePipe(s: string): string {
  return s.replace(/\|/g, "\\|");
}

