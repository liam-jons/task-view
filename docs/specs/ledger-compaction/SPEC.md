# SPEC — Ledger compaction (archive done/cancelled journals)

Status: DESIGN. Replaces the manual "wait, then archive" workflow with a native,
programmatic capability inside task-view. Replicates the method a prior Knowledge
Hub session used to cut `task-list.json` from ~3.6 MB to ~1.4 MB
(`knowledge-hub/scripts/ledger-compact-done.ts`, WS-B3, ratified D2 2026-06-12).

## 0. Why

Measured in KH: **79% of `task-list.json` bytes are subtask journal `details`, and
78% of those sit in `done` tasks.** Every read, canonical re-serialise, schema
re-parse, and git blob pays for closed history. Compaction moves that closed
history out of the live JSON into per-task markdown archives, leaving a short
pointer stub inline — shrinking the ledger and the cognitive load of the viewer.

## 1. The method (verified from the KH script)

For each task with `status ∈ {done, cancelled}`, for each subtask whose
`details` length **> 400 chars** (`ARCHIVE_THRESHOLD`):

1. **Archive first (no data-loss window).** Append a section to
   `<ledgerDir>/archive/ID-<taskId>-journals.md`:
   ```
   ## <taskId>.<subId> — <subtask title>

   <full original details>
   ```
   with a file header naming the task, status, date, and provenance. **Refuse to
   overwrite** an existing archive file (idempotent re-runs rely on stubs being
   under threshold and skipped).
2. **Then truncate inline** to a pointer stub:
   ```
   Journal archived <date> (task-view compaction) -> ledgers/archive/ID-<taskId>-journals.md
   section <taskId>.<subId> (original <N> chars).
   ```
3. Abort the whole run on the first mutation failure (no continue-on-error mass
   mutation). Re-runs are safe and idempotent.

`<ledgerDir>/archive/` is a SIBLING of the mirror dirs (`tasks/` etc.), so
mirror-parity is untouched. This matches the existing
`knowledge-hub-docs-site/.../ledgers/archive/` layout exactly, so task-view
produces archives compatible with what KH already has on disk.

## 2. What changes vs. the KH script

The KH script is an **external** driver that shells out to task-view's
`ledger-cli.ts` (the patch-server transport) for every truncation. In task-view
the same work is **native + in-process**: the truncation reuses the existing
internal mutation path directly (`applyPatches` / `atomicWriteFile` / canonical
serialise / mirror regen) instead of spawning a subprocess per subtask.

Concretely the inline-truncate of a subtask `details` field is the **same field
mutation** the subtask pencil already performs — `fieldPath: ["tasks", taskId,
"subtasks", subId, "details"]` — so it goes through the proven `applyTaskPatch`
walker, the schema gate, the mtime/mutex, and one canonical write. Compaction is
therefore "build the change set, apply it atomically, regen mirrors once."

## 3. Surfaces

- **CLI subcommand (primary):**
  `task-view compact <ledger.json> [--dry-run] [--task <id>] [--threshold <n>] [--no-regen]`.
  `--dry-run` reports the plan (tasks, journal count, KB to archive) and exits
  without writing. Mirrors the KH script's flags so muscle-memory carries over.
- **Server endpoint (optional, for a UI trigger):**
  `POST /api/ledger/compact` (+ `/api/ledger/:slug/compact` via the existing
  slug seam) with `{ dryRun?, taskId?, baseMtime? }`, returning the plan/result
  envelope. Behind the same mtime optimistic-concurrency as other writes.
- **UI affordance (optional, last):** a "Archive completed journals" button on the
  task-list index that calls the endpoint and reports the bytes reclaimed. Gated
  to the editable (non-read-only) launch ledger.

Build order: CLI + core module first (fully testable headless), endpoint second,
UI button last.

## 4. Module shape

New pure-ish core `packages/server/compact-done.ts`:

```ts
interface CompactionPlan {
  tasks: { taskId: string; archivePath: string;
           subs: { subId: string; title: string; chars: number }[] }[];
  totalBeforeBytes: number;
  subtaskCount: number;
}
// Pure: enumerate targets from a parsed ledger (no I/O).
function planCompaction(ledger: TaskList, opts: { threshold: number; onlyTask?: string }): CompactionPlan;
// Render the archive markdown for one task (pure).
function renderArchive(task: Task, subs: Subtask[], date: string): string;
// Render the inline stub for one subtask (pure).
function renderStub(taskId: string, sub: Subtask, date: string): string;
// Orchestrator: write archives, build the field-patch set, apply atomically,
// regen mirrors. Reuses the existing mutation transport. (I/O lives here.)
async function runCompaction(ledgerPath: string, opts): Promise<CompactionResult>;
```

The pure functions (`planCompaction`, `renderArchive`, `renderStub`) carry the
logic and the unit tests; `runCompaction` is the thin I/O orchestrator.

## 5. Schema notes (verify before impl)

- Confirm the vendored `packages/schemas/src/task-list-schema.ts` subtask shape
  carries `details?: string`, `title?: string`, `status?`, and that a
  details-only mutation hits a known field (the patch-apply keyset guard).
- The stub is a plain string under the threshold, so a re-run skips it
  (idempotence). Truncation only ever shortens `details`; it never touches
  status/title/structure → `superRefine` unique-id and other doc-level checks are
  unaffected.
- Threshold default 400 (KH parity), overridable via `--threshold`.

## 6. Safety model (carry from KH, enforce in task-view)

- Archive-before-truncate ordering (no data-loss window).
- Refuse to overwrite an existing archive file.
- Atomic apply of the truncation set under the existing mtime + path-mutex.
- `--dry-run` is read-only.
- Abort on first failure; partial archives already written are safe (re-run is
  idempotent).
- Mirror regen runs once at the end (skippable with `--no-regen`).

## 7. TDD slices (`bun test`)

1. **`planCompaction` (pure).** done/cancelled only; threshold boundary
   (≤400 skipped, >400 targeted); `--task` scoping; empty plan when nothing
   qualifies; does not mutate input. New `packages/server/compact-done.test.ts`.
2. **`renderArchive` / `renderStub` (pure).** Section format, header provenance,
   stub names the archive path + section + original char count; stub length <
   threshold (idempotence canary).
3. **`runCompaction` orchestrator (I/O, temp dir).** Archive file written before
   truncation; canonical JSON shrinks; re-run is a no-op; refuses to overwrite;
   aborts on a forced apply failure leaving canonical unchanged for the failed
   item. Reuse the temp-ledger harness used by `record-mutate.test.ts` /
   `patch-apply.test.ts`.
4. **CLI wiring.** `compact --dry-run` prints the plan and writes nothing;
   `compact` performs it and regens mirrors. Extend the CLI test surface.
5. **(Optional) endpoint + UI** once 1-4 are green.

## 8. Open questions

- **OQ-1 scope:** compaction is task-list-specific (subtask journals). Backlog /
  roadmap have no equivalent journal bloat — out of scope. *Default: task-list only.*
- **OQ-2 provenance string:** KH stamps "WS-B3 compaction". task-view uses a
  neutral "task-view compaction" + ISO date. *Default: neutral string.*
- **OQ-3 threshold:** 400 default (KH parity), `--threshold` override. *Default: 400.*
