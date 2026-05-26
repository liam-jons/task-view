---
type: task
id: "6"
title: workflow-orchestration skill body
status: done
priority: must
effort_estimate: ~2h
owner: Engineering
updated: 2026-05-18T19:00:00.000Z
session_refs: [kh-prod-readiness-S51]
commit_refs: [e989e36c]
dependencies: []
cross_doc_links: 
  - path: docs/plans/phase-0-investigation/kh-sdlc-workflow.md
    anchor: "#3-lifecycle"
    raw: kh-sdlc-workflow.md §3
  - path: docs/plans/phase-0-investigation/kh-sdlc-workflow.md
    anchor: "#94-deletions-from-the-s47-v1"
    raw: kh-sdlc-workflow.md §9.4
priority_note: null
status_note: null
---

# ID-6: workflow-orchestration skill body

Author the `workflow-orchestration` skill body that operationalises kh-sdlc-workflow.md §3+§4+§6+§9.4 against task-list.json. Replaces the workflow-orchestrator agent (§9.4: orchestrator becomes a skill loaded by main session). Encodes ID-N dispatch protocol, merge cadence, wave structure, worktree isolation, sequential merge, finding routing, state machine.

## Acceptance criteria

- `.claude/skills/workflow-orchestration/SKILL.md` exists with body coherent with kh-sdlc-workflow.md §3+§4+§6+§9.4.
- References `lib/validation/task-list-schema.ts` + `parseTaskListWithWarnings` for inv 20 25-Subtask soft-ceiling surfacing.
- Merge-cadence body section load-bearing (no link out to non-existent skill).
- References §5 dispatch primitives (using-git-worktrees + dispatching-parallel-agents + session-driver-cmux + git-workflow-and-versioning).
- `.claude/agents/workflow-orchestrator.md` DELETED in same commit.
- Authored via `create-skill` skill methodology.

## Subtasks

### ID-6.1: Author workflow-orchestration SKILL.md via create-skill

- **Status:** done
- **Dependencies:** _none_
- **Updated:** _unset_

Invoke the create-skill skill to scaffold + author the new skill body.

**Test strategy:** Skill body present at expected path; frontmatter parses; body covers all 10 sections; workflow-orchestrator.md agent file deleted; commit message references ID-6.1.

**Details:**

Worktree first action: git reset --hard production-readiness. Invoke create-skill skill to scaffold .claude/skills/workflow-orchestration/. Author SKILL.md per 10-section spec (Frontmatter, Overview, ID-N lifecycle, Dispatch protocol, Worktree isolation, Finding routing, State machine, Skill routing, Failure handling, Soft-ceiling surfacing).

<info added on 2026-05-18T19:00:00.000Z>
Shipped via worktree agent (sub-task-id a2fdfd7938b91a376). Cherry-picked onto production-readiness as e989e36c. Created `.claude/skills/workflow-orchestration/SKILL.md` (668 lines, 10 sections per spec) using `create-skill` skill methodology. Body covers ID-N lifecycle (§3), §6.4 merge cadence (load-bearing per N2), §5 dispatch primitives (using-git-worktrees + dispatching-parallel-agents + session-driver-cmux + git-workflow-and-versioning), §6.2 binary in-scope-ness rule, §6.3 state machine, §8 failure handling, parseTaskListWithWarnings ingress for inv 20 25-Subtask soft-ceiling. `.gitignore` allowlist line added for skill dir (subsequently superseded by S51 close-out gitignore flip per Fix E — all `.claude/skills/` now tracked by default).
</info added on 2026-05-18T19:00:00.000Z>

### ID-6.2: Delete workflow-orchestrator.md agent + verify coherence

- **Status:** done
- **Dependencies:** ID-6.1
- **Updated:** _unset_

Confirm the agent file is removed and the new skill body covers everything the agent previously did.

**Test strategy:** `grep -rn 'workflow-orchestrator' .claude/ docs/` returns only historical archive entries or deletion-comment references — no live references.

**Details:**

Verify .claude/agents/workflow-orchestrator.md no longer exists post-Subtask 6.1 commit. Cross-walk old agent body's Step 1-8 against new skill body — every phase must be present in skill + §3+§6 additions from canonical doc. Check stale refs in .claude/agents/, .claude/skills/, docs/plans/phase-0-investigation/.

<info added on 2026-05-18T19:00:00.000Z>
Deleted `.claude/agents/workflow-orchestrator.md` in same commit (e989e36c). Cross-walk vs old agent body confirmed coverage is strict superset: every Step 1-8 phase the agent covered is present in the new skill, plus §3 (subtask group dispatch, state machine boundaries) and §6 (binary in-scope-ness predicate, JSON Checker schema per §6.1, 25-Subtask soft ceiling via parseTaskListWithWarnings). Stale references flagged for Curator triage: task-executor.md:3,8 (auto-fixed by ID-7 cherry-pick); workflow-curator.md:3 (curated to backlog as ID-11); skill-interaction-matrix.md:80,102 (curated to backlog as ID-12).
</info added on 2026-05-18T19:00:00.000Z>
