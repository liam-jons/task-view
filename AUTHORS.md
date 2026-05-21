# Authors

task-view is a permanent fork of [Plannotator](https://github.com/backnotprop/plannotator)
v0.19.18. It strips the annotation pipeline, replaces the read-only frontmatter
card with an editable record card, and adds a patch server for round-tripping
edits back to canonical JSON ledgers. See `docs/specs/per-task-mirror/PRODUCT.md`
in the Knowledge Hub repository for the full behaviour spec.

## Upstream attribution

- **Plannotator** (`backnotprop/plannotator`) — Michael Davis (@backnotprop).
  Permission flowed via dual MIT-OR-Apache-2.0 licence (see `LICENSE-MIT` and
  `LICENSE-APACHE`). The retained surface — `packages/ui` markdown rendering
  primitives, `Viewer.tsx` shell, `parser.ts` CommonMark/GFM parser,
  `BlockRenderer.tsx` block dispatch, `MermaidBlock` / `GraphvizBlock` /
  `CodeBlock` / `TableBlock` diagram and code rendering, `ThemeProvider`,
  `Tooltip` / `Popover` / `ConfirmDialog` primitives, `slugify.ts` anchor
  generation, `packages/server/browser.ts` cross-platform browser launch,
  `packages/server/repo.ts` GitHub repo info, port-retry scaffolding — are all
  upstream contributions retained intact under the dual licence.

## task-view fork

- **Knowledge Hub team** — Liam Jones (@liam-jons) and Claude Code as
  development partner. Fork prep + strip ledger + rename map + schema
  vendoring per TECH §1.1-§1.5 of the per-task-mirror spec
  (`docs/specs/per-task-mirror/TECH.md` in the Knowledge Hub repository).

## No upstream rebase commitment

task-view is permanently divergent from upstream Plannotator. Upstream changes
flow into task-view via manual cherry-pick where useful; there is no
auto-sync, no `upstream` git remote, and no expectation that the two
codebases will reconverge. See PRODUCT inv 1 for the fork-identity guarantee.
