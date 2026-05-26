---
type: task
id: "7"
title: task-executor body rewrite + NEW task-planner agent
status: done
priority: must
effort_estimate: ~1.5h
owner: Engineering
updated: 2026-05-18T19:00:00.000Z
session_refs: [kh-prod-readiness-S51]
commit_refs: [960daf28]
dependencies: []
cross_doc_links: 
  - path: docs/plans/phase-0-investigation/kh-sdlc-workflow.md
    anchor: "#2-roles"
    raw: kh-sdlc-workflow.md §2
  - path: docs/plans/phase-0-investigation/s48-feedback.md
    anchor: "#b4-planner-role-scope-f2-2--f4-3"
    raw: s48-feedback.md B4
priority_note: null
status_note: null
---

# ID-7: task-executor body rewrite + NEW task-planner agent

Rewrite the renamed task-executor.md agent body (S50 WP6 renamed the file but deferred body rewrite — current body still used workflow-executor frontmatter + workpackage terminology). Author NEW task-planner.md agent per kh-sdlc-workflow.md §2 planner role definition.

## Acceptance criteria

- task-executor.md frontmatter name matches filename (task-executor).
- Body reflects §6.1 dispatch-brief contract: invokes implement-subtask skill (A1); reads from task-list.json details field; commits via commit-commands not git-workflow-and-versioning (B9); appends <info added on …> journal block; moves status pending→in_progress only (B12).
- task-planner.md exists; description + body align with §2 (opus-4-7 thinking:max, per-spec/per-task-breakdown, fresh per subtask Q-PLANNER-2).
- Both files authored via agent-development skill methodology.

## Subtasks

### ID-7.1: Rewrite task-executor.md body via agent-creator + agent-development

- **Status:** done
- **Dependencies:** _none_
- **Updated:** _unset_

Update the body of the renamed task-executor agent to reflect the §6.1 Subtask dispatch-brief contract.

**Test strategy:** Frontmatter name task-executor matches filename. Body invokes implement-subtask as entry point. Forbidden actions list present. State-machine pending → in_progress only. No reference to workflow-executor or workpackage remaining.

**Details:**

Invoke agent-development skill methodology + dispatch agent-creator.md agent to author the new body. File: .claude/agents/task-executor.md (EDIT — replace body, keep file location). Frontmatter: workflow-executor → task-executor; description with single-Subtask terminology + ID-N.M examples; model sonnet; color blue.

<info added on 2026-05-18T19:00:00.000Z>
Rewrote `.claude/agents/task-executor.md` body. Frontmatter renamed `workflow-executor` → `task-executor`. Body reflects §6.1 dispatch-brief contract: invokes `implement-subtask` as entry point (A1), uses `commit-commands` not `git-workflow-and-versioning` (B9), appends `<info added on …>` journal block to subtask details on completion, moves status `pending → in_progress` only (B12). Forbidden actions list explicit. KH-specific quality bars present. **Process deviation (transparency-flagged):** `agent-creator` sub-dispatch failed — sub-agent had no `Agent`/`Task` tool in its palette (verified via ToolSearch). Per CLAUDE.md gotcha added in Fix E, this is a sub-agent harness limitation, not a file-access issue. Applied `agent-development` skill methodology directly + used `agent-creator.md` as write-pattern reference. Checker accepted deliverable as spec-compliant (Checker JSON: PASS_WITH_NOTES with `fyi` on commit-message accuracy). Commit 960daf28.
</info added on 2026-05-18T19:00:00.000Z>

### ID-7.2: Author NEW task-planner.md via agent-creator + agent-development

- **Status:** done
- **Dependencies:** _none_
- **Updated:** _unset_

Create the new task-planner agent per §2 planner role definition.

**Test strategy:** File exists at .claude/agents/task-planner.md. Frontmatter valid. Body covers four subtask-kinds. Sibling-only dep forcing function explicit. Forbidden actions list present.

**Details:**

File: .claude/agents/task-planner.md (NEW). Frontmatter: name task-planner; description with 3 examples ({N.2}/{N.3}/{N.4}); model opus; color green. Body covers four subtask-kinds, sibling-only dep forcing function (§3.3 A6), forbidden actions, fresh-per-Subtask (Q-PLANNER-2).

<info added on 2026-05-18T19:00:00.000Z>
Created `.claude/agents/task-planner.md` (241 lines). Frontmatter: name task-planner, model opus, color green, description with 3 examples covering {N.2}/{N.3}/{N.4} authoring scenarios. Body covers four subtask-kinds, sibling-only dependency forcing function (§3.3 A6), forbidden actions list, fresh-per-Subtask discipline (Q-PLANNER-2). Same agent-creator dispatch deviation as Subtask 7.1. **CWD drift incident during execution:** Bash CWD shifted into production-readiness worktree after Read of a worktree file (per CLAUDE.md "Bash CWD drifts into worktree dirs after Read" gotcha); detected mid-flight; recovered cleanly by reverting stray production-readiness modification + relocating files to dispatched worktree (commits unwound + redone). Final state clean. Commit 960daf28.
</info added on 2026-05-18T19:00:00.000Z>
