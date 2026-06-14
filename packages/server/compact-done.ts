/**
 * compact-done.ts — native ledger compaction (docs/specs/ledger-compaction/SPEC.md).
 *
 * Archives the long `details` journals of DONE / CANCELLED tasks' subtasks out
 * of the live task-list.json into per-task markdown files under
 * `<ledgerDir>/archive/ID-<id>-journals.md`, replacing each inline `details`
 * with a short pointer stub. Replicates Knowledge Hub's
 * `scripts/ledger-compact-done.ts` (WS-B3) IN-PROCESS, reusing task-view's own
 * mutation transport so the canonical write is schema-validated + byte-faithful:
 *
 *   applyTaskListPatches (validation oracle)
 *     → scopedSerialise fold (canonical bytes, untouched records preserved)
 *       → atomicWriteFile (atomic temp+rename)
 *         → generateMirrors (soft on-disk .md refresh)
 *
 * Safety model (carried from KH): archive files are written BEFORE the
 * corresponding truncation (no data-loss window); an existing archive is never
 * overwritten; the whole run aborts on the first failure; re-runs are
 * idempotent (stubs fall below the threshold and are skipped).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Subtask, Task, TaskList } from "@task-view/schemas/task-list";
import { applyTaskListPatches, type FieldPatch } from "./patch-apply";
import { detectSchema } from "./detect-schema";
import { scopedSerialise } from "./scoped-serialise";
import { atomicWriteFile } from "./atomic-write";
import { generateMirrors } from "./mirror-generator";

/** Details shorter than this stay inline (KH parity). */
export const DEFAULT_COMPACTION_THRESHOLD = 400;

/** Only these task statuses are eligible for journal archival. */
const ARCHIVABLE_STATUSES = new Set<string>(["done", "cancelled"]);

export interface CompactionPlanItem {
  /** The parent (done/cancelled) task. */
  task: Task;
  /** Destination archive markdown path (`<archiveDir>/ID-<id>-journals.md`). */
  archivePath: string;
  /** Subtasks whose `details` exceed the threshold (the archive targets). */
  subs: Subtask[];
}

export interface CompactionPlan {
  items: CompactionPlanItem[];
  subtaskCount: number;
  totalBeforeBytes: number;
}

export interface PlanOptions {
  archiveDir: string;
  threshold?: number;
  /** Restrict to a single task id (pilot run). */
  onlyTask?: string | null;
}

/**
 * Pure: enumerate done/cancelled tasks whose subtasks carry over-threshold
 * `details`. No I/O, no mutation of the input.
 */
export function planCompaction(
  tasks: readonly Task[],
  opts: PlanOptions,
): CompactionPlan {
  const threshold = opts.threshold ?? DEFAULT_COMPACTION_THRESHOLD;
  const items: CompactionPlanItem[] = [];
  let subtaskCount = 0;
  let totalBeforeBytes = 0;
  for (const task of tasks) {
    if (!ARCHIVABLE_STATUSES.has(task.status)) continue;
    if (opts.onlyTask != null && String(task.id) !== String(opts.onlyTask)) {
      continue;
    }
    const subs = (task.subtasks ?? []).filter(
      (s) => (s.details ?? "").length > threshold,
    );
    if (subs.length === 0) continue;
    items.push({
      task,
      archivePath: join(opts.archiveDir, `ID-${task.id}-journals.md`),
      subs,
    });
    for (const s of subs) {
      subtaskCount += 1;
      totalBeforeBytes += (s.details ?? "").length;
    }
  }
  return { items, subtaskCount, totalBeforeBytes };
}

/** Pure: the inline pointer stub that replaces an archived `details`. */
export function renderStub(taskId: string, sub: Subtask, date: string): string {
  const original = (sub.details ?? "").length;
  return (
    `Journal archived ${date} (task-view compaction) -> ` +
    `ledgers/archive/ID-${taskId}-journals.md section ${taskId}.${sub.id} ` +
    `(original ${original} chars).`
  );
}

/** Pure: the per-task archive markdown (header + one section per subtask). */
export function renderArchive(item: CompactionPlanItem, date: string): string {
  const t = item.task;
  const header =
    `# ID-${t.id} — archived subtask journals\n\n` +
    `Task: ${t.title} (status: ${t.status})\n` +
    `Archived ${date} by task-view ledger compaction.\n` +
    `Live records carry pointer stubs; this file is the journal of record.\n\n`;
  const sections = item.subs.map(
    (s) => `## ${t.id}.${s.id} — ${s.title}\n\n${s.details ?? ""}\n`,
  );
  return header + sections.join("\n");
}

/** Pure: the FieldPatch set that truncates each archived `details` to its stub. */
export function buildTruncationPatches(
  plan: CompactionPlan,
  date: string,
): FieldPatch[] {
  const patches: FieldPatch[] = [];
  for (const item of plan.items) {
    for (const sub of item.subs) {
      patches.push({
        fieldPath: [
          "tasks",
          String(item.task.id),
          "subtasks",
          String(sub.id),
          "details",
        ],
        newValue: renderStub(String(item.task.id), sub, date),
      });
    }
  }
  return patches;
}

export interface CompactionOptions {
  /** ISO date stamp for archive provenance + stubs (caller supplies — testable). */
  date: string;
  threshold?: number;
  onlyTask?: string | null;
  /** Report-only — write nothing. */
  dryRun?: boolean;
  /** Skip the follow-up full mirror regen (default: regen). */
  regenMirrors?: boolean;
}

export interface CompactionResult {
  ok: boolean;
  dryRun: boolean;
  /** Serialisable per-task summary (taskId, journals archived, bytes). */
  plan: { taskId: string; subs: number; bytes: number }[];
  taskCount: number;
  subtaskCount: number;
  bytesArchived: number;
  bytesAfterInline: number;
  archivesWritten: string[];
  error?: string;
}

function summarise(plan: CompactionPlan): CompactionResult["plan"] {
  return plan.items.map((it) => ({
    taskId: String(it.task.id),
    subs: it.subs.length,
    bytes: it.subs.reduce((a, s) => a + (s.details ?? "").length, 0),
  }));
}

function emptyResult(
  dryRun: boolean,
  overrides: Partial<CompactionResult> = {},
): CompactionResult {
  return {
    ok: true,
    dryRun,
    plan: [],
    taskCount: 0,
    subtaskCount: 0,
    bytesArchived: 0,
    bytesAfterInline: 0,
    archivesWritten: [],
    ...overrides,
  };
}

/**
 * Orchestrate a compaction run against the ledger at `ledgerPath`. Reads the
 * canonical, plans, (dry-run → returns the plan), writes archives, truncates
 * via the validated transport, atomic-writes, and (soft) regenerates mirrors.
 */
export async function runCompaction(
  ledgerPath: string,
  opts: CompactionOptions,
): Promise<CompactionResult> {
  const dryRun = opts.dryRun === true;
  const raw = readFileSync(ledgerPath, "utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return emptyResult(dryRun, {
      ok: false,
      error: `ledger is not valid JSON: ${(err as Error).message}`,
    });
  }

  let detected: ReturnType<typeof detectSchema>;
  try {
    detected = detectSchema(parsed);
  } catch (err) {
    // detectSchema runs the matching Zod `.parse()` and throws on a malformed
    // ledger — a broken file is a compaction no-op, not a crash.
    return emptyResult(dryRun, {
      ok: false,
      error: `ledger failed schema validation: ${(err as Error).message}`,
    });
  }
  if (detected.kind !== "task-list") {
    return emptyResult(dryRun, {
      ok: false,
      error: `compaction targets the task-list ledger only (got ${detected.kind}).`,
    });
  }
  const data = detected.data as TaskList;

  const archiveDir = join(dirname(ledgerPath), "archive");
  const plan = planCompaction(data.tasks, {
    archiveDir,
    threshold: opts.threshold,
    onlyTask: opts.onlyTask,
  });
  const summary = summarise(plan);

  if (dryRun || plan.items.length === 0) {
    return {
      ok: true,
      dryRun,
      plan: summary,
      taskCount: plan.items.length,
      subtaskCount: plan.subtaskCount,
      bytesArchived: plan.totalBeforeBytes,
      bytesAfterInline: 0,
      archivesWritten: [],
    };
  }

  // 1. Archive files FIRST — no data-loss window. Refuse to overwrite.
  mkdirSync(archiveDir, { recursive: true });
  const archivesWritten: string[] = [];
  for (const item of plan.items) {
    if (existsSync(item.archivePath)) {
      return emptyResult(false, {
        ok: false,
        plan: summary,
        archivesWritten,
        error: `refusing to overwrite existing archive: ${item.archivePath}`,
      });
    }
    writeFileSync(item.archivePath, renderArchive(item, opts.date));
    archivesWritten.push(item.archivePath);
  }

  // 2. Build the truncation patches + validate via the oracle (single pass).
  const patches = buildTruncationPatches(plan, opts.date);
  const oracle = applyTaskListPatches(structuredClone(data), patches);
  if (!oracle.ok) {
    return emptyResult(false, {
      ok: false,
      plan: summary,
      archivesWritten,
      error: `compaction validation failed (${oracle.kind}).`,
    });
  }

  // 3. Fold scopedSerialise over the raw bytes so untouched records keep their
  //    exact on-disk form (the same fold handlePatchRecord uses).
  let serialised = raw;
  for (const patch of patches) {
    const scoped = scopedSerialise(serialised, patch);
    if (!scoped.ok) {
      return emptyResult(false, {
        ok: false,
        plan: summary,
        archivesWritten,
        error: `scoped serialisation failed (${scoped.kind}).`,
      });
    }
    serialised = scoped.text;
  }

  // 4. Atomic canonical write.
  await atomicWriteFile(ledgerPath, serialised);

  // 5. Soft follow-up: regenerate mirrors so on-disk .md stays consistent.
  if (opts.regenMirrors !== false) {
    await generateMirrors({ kind: "task-list", data: oracle.parsed }, ledgerPath);
  }

  const bytesAfterInline = patches.reduce(
    (a, p) => a + ("newValue" in p ? String(p.newValue).length : 0),
    0,
  );
  return {
    ok: true,
    dryRun: false,
    plan: summary,
    taskCount: plan.items.length,
    subtaskCount: plan.subtaskCount,
    bytesArchived: plan.totalBeforeBytes,
    bytesAfterInline,
    archivesWritten,
  };
}
