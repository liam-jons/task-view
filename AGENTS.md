# task-view

Browser viewer + editor for Knowledge Hub-style workflow ledgers
(`task-list.json`, `product-roadmap.json`, `product-backlog.json`). Forked
from [Plannotator](https://github.com/backnotprop/plannotator) v0.19.18 —
permanent divergence per PRODUCT inv 1 (`docs/specs/per-task-mirror/PRODUCT.md`
in the Knowledge Hub repository).

## Status (fork-prep cut)

This commit chain represents the fork-prep tag `v0.1.0-task-view-prep` — the
Plannotator monorepo stripped to its rendering primitives + cross-platform
helpers, renamed to the task-view namespace, with the Zod schema bundle
vendoring scaffolded. Runtime behaviour (schema detection, mirror generation,
patch server, viewer) ships in subsequent Subtasks of Knowledge Hub Task
ID-20.

## Project structure

```
task-view/
├── apps/
│   └── server/                   # Bun CLI server + web SPA host
│       ├── index.ts              # CLI entrypoint (placeholder; ID-20.7/8/11)
│       ├── cli.ts                # version + help helpers
│       └── web/                  # Vite-built React SPA (placeholder; ID-20.9/10)
├── bin/
│   └── task-view.js              # Node-shim CLI dispatcher
├── packages/
│   ├── schemas/                  # Vendored Knowledge Hub Zod schemas (ID-20.6 vendor commit)
│   ├── server/                   # Bun server primitives (browser launch, repo info, port retry)
│   ├── shared/                   # Cross-cut helpers (draft, config, code-nav, code-file)
│   └── ui/                       # Markdown renderer + diagram primitives
└── tests/
    └── test-fixtures/            # Markdown test fixtures inherited from upstream
```

## Spec source

Implementation invariants live in the Knowledge Hub repository at
`docs/specs/per-task-mirror/PRODUCT.md` (55 numbered Behaviour invariants)
and `docs/specs/per-task-mirror/TECH.md` (§1-§7 implementation map).
`PLAN.md` carries the Subtask decomposition for ID-20.6 through ID-20.13.

## Licence

Dual MIT-OR-Apache-2.0 (retained from upstream Plannotator under
backnotprop's permission). See `LICENSE-MIT` and `LICENSE-APACHE`.
