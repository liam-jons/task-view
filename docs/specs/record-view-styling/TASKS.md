# Implementation plan: record-view styling

<!-- Last verified: 26/05/2026 — OQs resolved; OQ-1 Option B, OQ-2 split, OQ-3 picker shipped, OQ-4 badges, OQ-5 dark, +print.css. -->
<!-- NOTE: OQ-4 ratified YES — the badge/status work edits component files + tests
     (overrides T7's "status/priority left as plain text in v1 — no component edits"). -->
<!-- NOTE: OQ-1 ratified Option B — client-side highlight.js + theme-neutral hljs CSS
     (overrides T10/SV-32's "ship option (a) … no hljs"). -->
<!-- NOTE: print.css integration ADDED to scope (was §10 "later nicety"). -->
<!-- NOTE: OQ-3 picker SHIPPED in v1 (overrides "out of v1 scope"). -->


Companion to `SPEC.md`. Ordered, reviewable subtasks for a follow-up
implementation agent, in the Knowledge Hub ID-20 small-numbered-subtask
style. SV-N / TECH §N / OQ-N refer to `SPEC.md`. **This plan is design
output; do not start coding until the SPEC's open questions (esp. OQ-2,
OQ-5) are resolved by the user.**

## Architecture decisions (carried from SPEC)

- Inline `<style>` in `<head>`, assembled once at boot from on-disk CSS,
  cached in-process (SPEC §4.2, Option C). No `dist`, no second server, no
  CDN (C-NoDist, C-Inv44).
- Theme class baked onto the served `<html>` by `wrapHtml`, reusing the
  `theme-{id}[ light]` grammar (SV-2); no `ThemeProvider` on this surface.
- All colour/radius/font via existing tokens (SV-1). New rules live in
  `packages/ui/record-view/record-view.css`.
- Pure, separately-tested theme-preference resolver (SV-52).

## Dependency graph

```
T1 theme-base CSS split (OQ-2)        T2 theme resolver (pure)
        │                                     │
        └──────────────┬──────────────────────┘
                       ▼
            T3 viewer-styles.ts (boot assembler + cache + fallback)
                       │
                       ▼
            T4 wrapHtml: <html class> + inline <style>   ← + T2 wiring in T8
                       │
        ┌──────────────┼───────────────┬───────────────┬───────────────┐
        ▼              ▼               ▼               ▼               ▼
  T5 css: shell   T6 css: tables  T7 css: nav/   T9 css: edit/   T10 css: md
   + frontmatter   + index views   links/badges   forms/filters   body/journal
                                   /empty/404
                       │
                       ▼
            T8 patch-server: read cookie + ?theme, thread into renderViewer
                       │
                       ▼
            T11 a11y pass (focus/reduced-motion/contrast guards)
                       │
                       ▼
            T12 tests: style presence, theme class, resolver, coverage guard
                       │
                       ▼
            T13 docs + manual smoke evidence refresh
```

Foundation (T1-T4, T8) is sequential. The CSS-authoring tasks (T5-T7, T9,
T10) are **parallelizable** once T4 lands the injection seam — they only add
rules to one new file and never touch each other's selectors.

---

## Phase 1 — Foundation (injection seam)

### T1: Extract browser-valid base CSS from `theme.css` (OQ-2)
**Description:** Resolve OQ-2 by physically splitting the browser-valid base
rules out of `theme.css` into `packages/ui/theme.base.css` so the boot
assembler can read one file instead of slicing line ranges. Move: `body{}`
(`theme.css:95-100`), scrollbar fallbacks (`:140-149`), `::selection`
(`:190-192`), transition + `transitions-ready` rules (`:199-210`),
`:focus-visible` (`:213-216`), reduced-motion scroll block (`:178-187`),
`.sr-only` (`:385-395`), and the `.html-block …` prose rules (`:270-331`).
Leave the Tailwind `@theme inline` (`:56-86`) and `@layer base` (`:89-93`)
and theme `@import`s in `theme.css`; have `theme.css` `@import
"./theme.base.css"` so the SPA's Tailwind pipeline is unchanged.

**Acceptance criteria:**
- [ ] `theme.base.css` contains only plain, browser-valid CSS (no `@theme`,
  no `@layer`, no `@import`).
- [ ] `theme.css` still resolves the same effective CSS for the SPA (imports
  `theme.base.css`); SPA behaviour unchanged.
- [ ] No `.theme-*` token blocks were moved (those stay in `themes/*.css`).

**Verification:**
- [ ] `bun test` green; `bun run typecheck` clean.
- [ ] Manual diff review: every moved rule is byte-equal to its origin.

**Dependencies:** None. **Files:** `packages/ui/theme.base.css` (new),
`packages/ui/theme.css`. **Scope:** S. **Risk:** touches a shared file —
get OQ-2 confirmed first.

### T2: Pure theme-preference resolver (SV-52, SV-7, SV-8)
**Description:** New `packages/ui/record-view/theme-preference.ts` exporting
a pure `resolveThemePreference({ cookieHeader?, query? })` →
`{ themeId, mode, htmlClass }`. Implements precedence query > cookie >
default (SV-8), validates `themeId` against `BUILT_IN_THEMES`
(`utils/themeRegistry.ts`) and `mode` against `dark|light|system`, and
reproduces `resolveThemeClasses` mode-support logic
(`ThemeProvider.tsx:32-40`) for `htmlClass` (SV-7). Defaults: `task-view` /
`dark` (SV-6). Reads cookie keys `task-view-color-theme` /
`task-view-theme` (SV-8). Invalid input is ignored, never echoed.

**Acceptance criteria:**
- [ ] Default → `{ themeId:'task-view', mode:'dark', htmlClass:'theme-task-view' }`.
- [ ] `dark-only` theme + requested `light` → `htmlClass` has no ` light`.
- [ ] Unknown `themeId` (from query or cookie) → falls back; value absent
  from output.

**Verification:**
- [ ] New unit test covers precedence, validation, mode-support, injection
  safety (SV-52).

**Dependencies:** None. **Files:** `theme-preference.ts` (+ test). **Scope:** S.

### T3: Boot style assembler `viewer-styles.ts` (TECH §1-§4, SV-3)
**Description:** New `packages/server/viewer-styles.ts`. `getViewerStyles
(themeId, mode)` returns `{ css, htmlClass }`, building `css` once and
caching in-process (mirror `client-bundle.ts:43-78`). Concatenation order
(TECH §2): selected theme token file (+ `task-view` token fallback) →
`theme.base.css` → `record-view.css`. Resolve paths via `import.meta.dir` +
`node:path` (TECH §3, like `client-bundle.ts:34-41`); read with `Bun.file`.
On read failure: `console.error` + return a small inline safety stylesheet,
never throw (TECH §4). Export `_resetViewerStylesCacheForTests()`
(`client-bundle.ts:119-122` pattern). `htmlClass` comes from T2's resolver.

**Acceptance criteria:**
- [ ] Two calls return byte-identical `css` (cached, deterministic).
- [ ] Forced missing-file read → safety stylesheet + stderr log, no throw.
- [ ] `css` includes a token rule, a base rule, and (once T5+ land) the
  record-view rules.

**Verification:**
- [ ] `viewer-styles.test.ts` covers cache identity, order, failure path
  (SV-53).

**Dependencies:** T1, T2 (and the empty/early `record-view.css` from T5).
**Files:** `viewer-styles.ts` (+ test). **Scope:** M.

### T4: `wrapHtml` injects `<html>` class + inline `<style>` (TECH §1, SV-3)
**Description:** Extend `render-viewer.tsx` `wrapHtml(body, clientScript,
styles?)` where `styles = { css, htmlClass }`. Emit `<html lang="en"
class="${htmlClass}">` and `<style>${css.replace(/<\/style>/gi,'<\\/style>')}
</style>` in `<head>` (neutralisation mirrors the `</script>` guard at
`:223-225`). Thread an optional `theme`/`mode` (or pre-resolved `styles`)
through `RenderViewerInput` → `renderViewer`. When no styles provided
(pure-SSR unit tests), default to `getViewerStyles` defaults so every route
is styled (SV-3); keep a path where tests can pass an explicit tiny stylesheet
to stay hermetic.

**Acceptance criteria:**
- [ ] Output has exactly one `<style>` in `<head>`, before body markup.
- [ ] `<html>` carries the resolved theme class.
- [ ] Only one `</style>` in the document (breakout neutralised).
- [ ] Existing `render-viewer.test.tsx` script-injection tests still pass.

**Verification:**
- [ ] Extend `render-viewer.test.tsx` (SV-50, SV-51).

**Dependencies:** T2, T3. **Files:** `render-viewer.tsx`,
`render-viewer.test.tsx`. **Scope:** M.

### Checkpoint A (after T1-T4)
- [ ] `bun test` + `typecheck` green.
- [ ] `renderViewer(...)` output contains a themed `<html>` + an inline
  `<style>` carrying the token + base layers (record-view layer may still be
  near-empty).
- [ ] Manual: `bun apps/server/index.ts <ledger>` → `GET /` shows tokenised
  colours/fonts even before the record-view rules are fleshed out.
- [ ] **Review with user**; confirm OQ-2/OQ-5 before proceeding.

---

## Phase 2 — Record-view stylesheet (parallelizable)

> All Phase-2 tasks add rules to the single new file
> `packages/ui/record-view/record-view.css`. Create it (empty, with a header
> comment) as the first step of whichever task runs first. They are
> independent because they style disjoint selector groups.

### T5: Shell + typography + frontmatter card (SV-11-13, SV-17)
**Acceptance criteria:**
- [ ] Each §3.1 page root: max-width container, centred, token bg/fg/font,
  line-height (SV-11).
- [ ] Heading scale + ID-prefix muting (SV-12); mono for code/ids (SV-13).
- [ ] `.record-view-frontmatter-card` raised card; `-label`/`-value`/
  `data-unset` per SV-17.

**Verification:** [ ] Visual check across all three modes; [ ] no
`outline:none`. **Files:** `record-view.css`. **Scope:** M.

### T6: Index tables (SV-14-16)
**Acceptance criteria:**
- [ ] The three index tables: full-width, collapsed borders, themed `th`/`td`
  (SV-14).
- [ ] Zebra + hover via `color-mix` background-only (SV-15).
- [ ] Sticky opaque header (SV-16).

**Verification:** [ ] Scroll a long ledger — header stays, rows don't bleed
through. **Files:** `record-view.css`. **Scope:** S-M.

### T7: Nav strip, links, broken-target, warnings, badges, empty/404 (SV-18-24, SV-28-29)
**Acceptance criteria:**
- [ ] Nav strip 3-segment layout + truncation + disabled-edge styling (SV-18).
- [ ] Live link colour/underline (SV-19); broken-link keeps strikethrough +
  `--destructive`, suffix muted (SV-20).
- [ ] Page-top warning + blocked banner as token banners (SV-21, SV-22).
- [ ] Promotion-ready pill (SV-23); status/priority left as plain text in v1
  (SV-24 — no component edits).
- [ ] Empty-ledger/filtered/subtasks + not-found styling (SV-28, SV-29).

**Verification:** [ ] Render a blocked + missing-dep backlog item and an
empty ledger; [ ] hit `/?record=does-not-exist` → styled 404.
**Files:** `record-view.css`. **Scope:** M.

### T9: Edit affordances, forms, save/cancel, doc-link editor, filters (SV-27, SV-33-37)
**Description:** Style the dispatcher-built DOM (it injects no CSS). Drive
the open→edit→save loop in a browser to confirm the swapped form is styled.
**Acceptance criteria:**
- [ ] Pencil button subtle, reveals on hover AND focus-within, themed on
  hover/focus (SV-27, SV-41).
- [ ] Inputs/textarea/select/array-comma input themed; textarea full-width +
  resize (SV-33).
- [ ] Save (primary) / cancel (ghost) styling; inline error on its own line
  in `--destructive` (SV-34, SV-35).
- [ ] Doc-link editor table + add/delete buttons (SV-36).
- [ ] Backlog filter form + labelled selects + drag gutter/rank cell
  (SV-37, SV-25, SV-26).

**Verification:** [ ] In a browser: click a pencil → styled form appears;
Save/Cancel/Esc/Cmd-Enter all reachable + visibly styled; tab to the drag
handle → visible focus ring. **Files:** `record-view.css`. **Scope:** M.

### T10: Markdown body + journal blocks (SV-30-32)
**Description:** Resolve the Tailwind gap (SPEC §2.5) by scoping
element-level prose rules under `.record-view-markdown-body` /
`.record-view-details` / `-prose`, reusing the `.html-block …` idiom now in
`theme.base.css`. Style journal `<aside>` distinctly (SV-31). `pre code`
legible without hljs (SV-32 / OQ-1 → ship option (a) unless user picks
otherwise).
**Acceptance criteria:**
- [ ] Description/notes/details prose has correct paragraph/list/heading/
  blockquote/table/code spacing (SV-30).
- [ ] Journal block indented + labelled + token-tinted (SV-31).
- [ ] Code blocks readable (mono on `--code-bg`); no inlined `github-dark.css`
  (SV-32).

**Verification:** [ ] Render a Task whose subtask `details` contains an
`<info added on …>` journal block; confirm prose + journal look right in
light AND dark. **Files:** `record-view.css`. **Scope:** M.

### Checkpoint B (after T5-T10)
- [ ] `GET /` for all three ledger kinds (index + per-record) is visibly
  polished in dark AND light (`?mode=light`), parity-level with the SPA.
- [ ] `bun test` green. [ ] Screenshot evidence captured for the user.

---

## Phase 3 — Wiring, a11y, tests, docs

### T8: Patch-server reads theme cookie + `?theme`/`?mode` (SV-8)
**Description:** In `handleGetRoot` (`patch-server.ts:224-264`) read the
`Cookie` header + query off the `Request`/`URL`, call T2's resolver, and
pass `{ themeId, mode }` (or pre-resolved `styles`) into `renderViewer`.
Validation lives in the resolver (T2). No new cookie is written server-side
(SV-10).
**Acceptance criteria:**
- [ ] Cookie-set theme is honoured on `GET /`; `?theme=github&mode=light`
  overrides; invalid ignored.
- [ ] `GET /api/*` JSON endpoints unaffected.

**Verification:** [ ] `curl -H 'Cookie: task-view-color-theme=github' /` →
`<html class="theme-github">`; [ ] `curl '/?theme=nope'` →
`theme-task-view`. **Files:** `patch-server.ts` (+ test). **Scope:** S.

### T11: Accessibility pass (SV-40-44)
**Description:** Audit the authored CSS: confirm no `outline:none`; rely on
the base `:focus-visible` ring everywhere; ensure every hover-reveal also
fires on focus-within (SV-41); add the `@media (prefers-reduced-motion:
reduce)` block zeroing record-view transition durations (SV-43); spot-check
contrast on `task-view`, `github`, and one `dark-only` theme (SV-42).
**Acceptance criteria:**
- [ ] No `outline:none`/`outline:0` in `record-view.css` (SV-55).
- [ ] Reduced-motion block present (SV-56).
- [ ] Keyboard-only walkthrough reaches every control with a visible ring.

**Verification:** [ ] Optional axe-core / Lighthouse a11y run on a rendered
page (the components already pass axe rules; styling must not regress).
**Files:** `record-view.css`. **Scope:** S.

### T12: Test suite (SV-50-57)
**Description:** Land the deterministic style tests: `<style>` presence +
sentinels + per-root selector coverage (SV-50); `<html>` class matrix incl.
invalid-theme guard (SV-51); resolver unit tests (SV-52, may already exist
from T2); assembler determinism/isolation (SV-53); **selector coverage
guard** reading `record-view.css` against the §3 fixture list (SV-54);
`outline:none` + reduced-motion guards (SV-55, SV-56); optional happy-dom
cascade smoke (SV-57).
**Acceptance criteria:**
- [ ] All SV-50…SV-56 assertions present and passing.
- [ ] Coverage guard fails if a `record-view-*` class from §3 has no rule.

**Verification:** [ ] `bun test` green incl. new files; deliberately rename a
class in the fixture → guard fails (then revert).
**Files:** `render-viewer.test.tsx`, `viewer-styles.test.ts`,
`theme-preference.test.ts`, new `record-view-css.test.ts`. **Scope:** M.

### T13: Docs + smoke-evidence refresh
**Description:** Note the styling surface in `CLAUDE.md` project structure;
add a styling row to `docs/test-plans/task-view-manual-smoke.md`; refresh the
`s20-17-*` evidence HTML so it now shows the `<style>` + `<html>` class
(documents the fix). Flip `SPEC.md`/`TASKS.md` `Last verified` headers.
**Acceptance criteria:**
- [ ] Smoke plan has a "record-view is themed" scenario.
- [ ] Evidence HTML regenerated.

**Verification:** [ ] `grep '<style' evidence/*.html` now matches.
**Files:** docs only. **Scope:** S.

### Checkpoint C (complete)
- [ ] All SV invariants met; `bun test` + `typecheck` green.
- [ ] Dark + light screenshots for all three ledger kinds attached.
- [ ] OQ decisions recorded (OQ-1 code colour, OQ-2 split, OQ-3 picker,
  OQ-4 status badge, OQ-5 default mode).
- [ ] Ready for review.

---

## Risks and mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| `theme.css` split breaks SPA Tailwind pipeline (T1) | High | OQ-2 sign-off first; keep `theme.css` importing `theme.base.css`; SPA build untested in this repo — verify against the SPA before merge. |
| happy-dom CSS cascade too weak for SV-57 | Low | SV-57 is optional; fall back to class+rule presence (SV-50/51) which need no cascade. |
| Inline payload size on huge ledgers | Low | Per-page ~15-25 KB once; documented `/styles.css` route fallback (Option B) if it ever matters. |
| Token gaps in a few themes (e.g. missing `--code-bg`) | Low | `task-view` token fallback is always concatenated (TECH §2.1); `color-mix` derivations degrade gracefully. |
| Styling drifts from new components later | Med | SV-54 selector-coverage guard fails CI when a class loses its rule. |

## Open questions
See `SPEC.md` §11 (OQ-1 code colour, OQ-2 theme.css split, OQ-3 picker,
OQ-4 status badge markup, OQ-5 default mode). OQ-2 and OQ-5 should be
answered before T1/T3; the rest can be decided during Phase 2.
