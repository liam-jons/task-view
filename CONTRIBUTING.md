# Contributing to task-view

task-view is a permanent fork of
[Plannotator](https://github.com/backnotprop/plannotator) v0.19.18,
dual-licensed under MIT-OR-Apache-2.0. The fork strips the annotation pipeline
and adds a per-record patch server for round-tripping edits back to canonical
JSON ledgers. See `docs/specs/per-task-mirror/PRODUCT.md` in the Knowledge Hub
repository for the full behaviour specification.

We welcome contributions.

## License

This project is licensed under either of

- [Apache License, Version 2.0](LICENSE-APACHE)
  ([http://www.apache.org/licenses/LICENSE-2.0](http://www.apache.org/licenses/LICENSE-2.0))
- [MIT license](LICENSE-MIT)
  ([http://opensource.org/licenses/MIT](http://opensource.org/licenses/MIT))

at your option.

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in this project by you, as defined in the Apache-2.0 license,
shall be dual licensed as above, without any additional terms or conditions.

## How to submit a change

1. Fork the repository.
2. Make your changes on a feature branch.
3. Ensure `bun test` passes locally.
4. Submit a Pull Request against `main`.

## Re-vendoring the Knowledge Hub Zod schemas (OQ-T2 ratified default)

The `packages/schemas/src/` directory carries vendored copies of the four
Knowledge Hub Zod validation files:

- `packages/schemas/src/task-list-schema.ts`
  (← KH `lib/validation/task-list-schema.ts`)
- `packages/schemas/src/roadmap-schema.ts`
  (← KH `lib/validation/roadmap-schema.ts`)
- `packages/schemas/src/backlog-schema.ts`
  (← KH `lib/validation/backlog-schema.ts`)
- `packages/schemas/src/work-status.ts`
  (← KH `lib/validation/work-status.ts`)

These are **frozen copies**. task-view does not import from KH `lib/validation/`
at runtime; per PRODUCT inv 3, task-view has zero KH runtime dependencies.

When KH evolves any of the four schemas (a new status enum value, an additional
required field, a renamed property), the changes flow into task-view via an
explicit **manual annotated re-vendor**:

### Procedure

1. **Compare the four files between repositories.** Use `diff` (or a side-by-
   side review tool) to identify the changes that arrived in KH since the last
   re-vendor:

   ```sh
   diff -u \
     /path/to/knowledge-hub/lib/validation/task-list-schema.ts \
     packages/schemas/src/task-list-schema.ts
   ```

   Repeat for `roadmap-schema.ts`, `backlog-schema.ts`, `work-status.ts`.

2. **Copy the new file contents over.** The bundle is four files, not a
   directory tree, so a single `cp` per file is sufficient:

   ```sh
   cp /path/to/knowledge-hub/lib/validation/task-list-schema.ts \
      packages/schemas/src/task-list-schema.ts
   ```

3. **Re-apply the import-path adaptations.** The vendored copies use
   relative imports between sibling files (`./work-status`, `./roadmap-schema`)
   rather than the KH absolute alias (`@/lib/validation/...`). If a re-vendor
   introduces a new cross-schema import, rewrite it to the relative form
   before committing. The vendored files do NOT include the KH master
   `BARE_ID_REGEX` constant from `lib/validation/schemas.ts` — that regex is
   inlined at the top of `task-list-schema.ts` and `backlog-schema.ts` and
   must be kept in sync manually.

4. **Run the schema parse acceptance test.**

   ```sh
   bun test packages/schemas/src/schemas.test.ts
   ```

   This test parses a representative ledger sample for each surface to catch
   the most common breakage (missing fields, renamed enum values). If the
   sample fixtures need updating to match a new field shape, update them in
   the same commit as the re-vendor.

5. **Land the re-vendor as a SINGLE annotated commit.** The commit message
   should name the KH source commit (or session) the bundle was re-vendored
   against:

   ```
   chore(schemas): re-vendor from KH lib/validation @ <kh-commit-sha>

   Notable changes:
   - <field A added to BacklogItemSchema>
   - <enum value foo added to WorkStatus>
   ```

### CI guard

Knowledge Hub's CI runs a `task-view-vendor-drift` workflow that fetches the
tagged task-view release's vendor bundle and diffs against the live
`lib/validation/*.ts` files in the KH repository. The job emits a **warning**
(does not block merge) when drift is detected. See OQ-T2 in
`docs/specs/per-task-mirror/TECH.md` for the ratified policy. The warning is
the signal to start a re-vendor on the task-view side.

### Why not auto-sync?

Per TECH §1.5, vendoring is the same strategy upstream Plannotator uses for
its workspace-local `@plannotator/shared` package. An auto-sync (e.g. a git
submodule or a published npm package) would introduce either a release-cycle
coupling (KH releases bump task-view) or a build-time fetch (task-view CI
depends on KH being reachable at build time). The manual annotated re-vendor
keeps the schema set frozen at the moment of release, with explicit operator
intent captured in the commit message; the CI guard ensures drift never goes
unnoticed.
