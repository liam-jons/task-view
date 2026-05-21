# task-view

A read + edit per-record viewer for Knowledge Hub workflow ledgers — renders
`task-list.json`, `product-roadmap.json`, and `product-backlog.json` as a
per-record browser UI with structured-field edit-back to the canonical JSON.

**Status:** fork-prep cut (`v0.1.0-task-view-prep`). The runtime behaviour —
schema detection, mirror generation, patch server, viewer rendering — lands
in subsequent Subtasks of Knowledge Hub Task ID-20.

## Upstream

task-view is a permanent fork of [Plannotator](https://github.com/backnotprop/plannotator)
v0.19.18, dual-licensed under MIT-OR-Apache-2.0. The fork strips the
annotation pipeline + 10 alt-host integrations and adds:

- `RecordFrontmatterCard` editable replacement for the read-only upstream
  `FrontmatterCard` (lands in ID-20.10).
- Per-record patch server (`PATCH /api/ledger/record/:recordId`) with atomic
  write + mtime collision detection (lands in ID-20.8).
- Schema detection + mirror generator + path resolution (lands in ID-20.7).
- CLI + plugin dual entry with `/task-view` slash command (lands in ID-20.11).

See `AUTHORS.md` for attribution and `CONTRIBUTING.md` for the re-vendoring
procedure for the four Zod schema files in `packages/schemas/`.

## Spec source

Behaviour invariants + implementation map live in the Knowledge Hub repo at
`docs/specs/per-task-mirror/PRODUCT.md` + `TECH.md` + `PLAN.md`.

## Licence

Dual MIT-OR-Apache-2.0 (retained from upstream). See `LICENSE-MIT` and
`LICENSE-APACHE`.
