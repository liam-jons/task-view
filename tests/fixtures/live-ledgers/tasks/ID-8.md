---
type: task
id: "8"
title: implement-subtask skill NEW + spec-driven-implementation EDIT
status: done
priority: must
effort_estimate: ~1.5h
owner: Engineering
updated: 2026-05-18T19:00:00.000Z
session_refs: [kh-prod-readiness-S51]
commit_refs: [ac51ae61, 816e46e5]
dependencies: []
cross_doc_links: 
  - path: docs/plans/phase-0-investigation/s49-open-resolutions.md
    anchor: "#a1-new-implement-subtask-skill"
    raw: s49-open-resolutions.md A1
  - path: docs/plans/phase-0-investigation/kh-sdlc-workflow.md
    anchor: "#34-implement"
    raw: kh-sdlc-workflow.md §3.4
priority_note: null
status_note: null
---

# ID-8: implement-subtask skill NEW + spec-driven-implementation EDIT

NEW .claude/skills/implement-subtask/SKILL.md per A1 — the Executor's entry point. Reads Subtask details; runs TDD; commits per commit-commands; appends <info added on …> per PRODUCT inv 13. EDIT .claude/skills/spec-driven-implementation/SKILL.md per A2 — clarify FULL spec authoring scope vs per-Subtask scope.

## Acceptance criteria

- implement-subtask SKILL.md exists; body explicit about <info added on …> append-extensibility (inv 13).
- spec-driven-implementation SKILL.md updated with targeted delta clarifying FULL-spec vs Subtask scope — NOT a full rewrite.
- NEW authored via create-skill skill; EDIT via update-skill skill.

## Subtasks

### ID-8.1: Author implement-subtask SKILL.md via create-skill

- **Status:** done
- **Dependencies:** _none_
- **Updated:** _unset_

Invoke create-skill skill to scaffold + author the new skill body.

**Test strategy:** File exists. Frontmatter parses. Body covers Steps 1-6 + state machine + escalation + forbidden + KH-specific quality bars. <info added on …> convention explicit. References commit-commands not git-workflow-and-versioning.

**Details:**

File: .claude/skills/implement-subtask/SKILL.md (NEW). 8 sections: Overview, Input, Process Steps 1-6, State machine, Escalation, Forbidden, KH-specific quality bars. References commit-commands NOT git-workflow-and-versioning. References test-driven-development + incremental-implementation as support skills.

<info added on 2026-05-18T19:00:00.000Z>
Created `.claude/skills/implement-subtask/SKILL.md` (272 lines, 8 sections) via `create-skill` skill methodology. Covers: Overview (one Subtask at a time; entry point for spec-anchored Executor work), Input (dispatch brief from Orchestrator with subtask id + spec-slice path + testStrategy), Process Steps 1-6 (Read brief → Test-first via TDD → Slice loop via incremental-implementation → Commit via commit-commands → Journal append → Report), State machine (Executor moves Subtask pending → in_progress at Step 1; NEVER sets done per §6.3 + B12), Escalation rule (STOP if production behaviour contradicts brief), Forbidden actions (in-flight planning-and-task-breakdown, reading full PRODUCT.md/TECH.md, editing roadmap/backlog), KH-specific quality bars (semantic tokens, UK English, auth helper shape, Supabase safety, etc.). `<info added on YYYY-MM-DDTHH:MM:SS.sssZ>` block convention explicit (PRODUCT inv 13). `.gitignore` allowlist line added (subsequently superseded by Fix E gitignore flip). Commit ac51ae61.
</info added on 2026-05-18T19:00:00.000Z>

### ID-8.2: Update spec-driven-implementation SKILL.md via update-skill

- **Status:** done
- **Dependencies:** ID-8.1
- **Updated:** _unset_

Invoke update-skill skill for targeted 5-15 line delta clarifying scope distinction.

**Test strategy:** Delta applied < 20 lines net. Scope distinction explicit in Overview. implement-subtask cross-reference present. Existing structure preserved.

**Details:**

File: .claude/skills/spec-driven-implementation/SKILL.md (EDIT). NOT a full rewrite — 5-15 line delta. Overview / When-to-use section adds explicit line distinguishing FULL spec authoring from per-Subtask implementation (implement-subtask). Trigger conditions updated. Cross-reference line added.

<info added on 2026-05-18T19:00:00.000Z>
Updated `.claude/skills/spec-driven-implementation/SKILL.md` via `update-skill` skill methodology — 16-line net delta vs main-branch baseline. **File state on production-readiness was UNTRACKED** — the agent sourced canonical content from main + applied targeted delta + added gitignore allowlist (subsequently superseded by Fix E gitignore flip). Scope-distinction added: FULL spec authoring chain ({N.1}/{N.2}/{N.3}/{N.4}) vs per-Subtask implementation. Cross-reference to implement-subtask present (5 occurrences across Overview, Step 4, Related Skills). Initial Checker flagged in-scope `nit`: frontmatter description missing A2 trigger phrase ("Use when authoring a NEW Task ID-N with the spec chain ..."); fixed in reconciliation commit 816e46e5. Final Checker verdict: PASS_WITH_NOTES with one out-of-scope `nit` (pre-existing stale `Taskmaster installed (S232 WP4+)` reference at :41 — curated to backlog as ID-13). Commit ac51ae61.
</info added on 2026-05-18T19:00:00.000Z>
