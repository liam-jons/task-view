# Record-view styling — design specification

<!-- Last verified: 26/05/2026 — §11 OQs resolved + implemented (this commit chain). -->

Status: **Proposed** (design only; no source changed by this document).
Owner: task-view UI.
Spec source convention: numbered **Behaviour invariants (SV-N)** + a
**TECH map (§N)**, mirroring the Knowledge Hub
`docs/specs/per-task-mirror/{PRODUCT,TECH}.md` house style. Implementation
subtask breakdown lives in the sibling `TASKS.md`.

---

## 0. Problem statement

The server-rendered **record-view** surface ships valid but **completely
unstyled** HTML. The React components under `packages/ui/record-view/*.tsx`
emit `className="record-view-*"` on every element, but **no `.css` file
defines a single `.record-view-*` rule** (verified: `grep -rn 'record-view'
packages/ui/*.css packages/ui/themes/*.css` returns zero matches), and the
SSR wrapper `wrapHtml` injects neither a `<style>` block nor a
`<link rel="stylesheet">` (`packages/server/render-viewer.tsx:215-242`).

Served evidence confirms the gap — `docs/test-plans/evidence/
s20-17-get-root-task20.html` is a bare `<head>` (charset + viewport + title
only) followed by `record-view-*`-classed markup with no style source. The
result on `GET /` (`packages/server/patch-server.ts:224-264`) is plain-text
headings and borderless tables.

The user's intent: *"One of the key reasons for adopting Plannotator was the
UI."* This spec targets a **polished, themed** surface on par with
Plannotator's existing viewer — not a minimal baseline — while honouring the
self-contained loopback-CLI distribution model.

---

## 1. Constraints (binding)

These come from the codebase + the ratified architecture and the
Knowledge Hub PRODUCT invariants. The design **must** satisfy all of them.

1. **C-SSR — Static-markup only.** Pages are produced by
   `renderToStaticMarkup` (`render-viewer.tsx:31,91-147`) and served by the
   patch server. There is no React hydration of the page tree; the only
   client JS is a **generic delegated event dispatcher** built at boot by
   `Bun.build` and inlined into `wrapHtml`'s `<script>`
   (`client-bundle.ts:80-100`, `render-viewer.tsx:221-226`). Styling cannot
   depend on a React `ThemeProvider` running on the page.
2. **C-NoDist — No committed build artifact, no second server.** Ratified
   decision "S265" (`client-bundle.ts:1-25`): the CLI runs TS source under
   Bun with no build step (`bin/task-view.js` → `bun apps/server/index.ts`).
   There is no Vite dev server and no `dist/`. Styling must not introduce
   either.
3. **C-Inv44 — Self-contained loopback distribution (PRODUCT inv 44).** The
   server binds loopback-only (`patch-server.ts:55-59,1134-1135`). All
   styling must be served **by the same process** — inline `<style>` or a
   same-origin route — never a CDN or external asset pipeline.
4. **C-Deterministic — Cross-platform deterministic output.** Same input →
   byte-identical HTML on macOS / Linux / Windows. No locale-, clock-, or
   filesystem-order-dependent style emission. Path resolution must use the
   `import.meta.dir` + `node:path` pattern already proven in
   `client-bundle.ts:34-41`.
5. **C-Links — Links are `/?record=<id>`; server runs until Ctrl-C.** A
   separate in-flight change removes the 30s idle-shutdown timer and
   repoints cross-record links from `{id}.md` to `/?record=<id>`. This spec
   neither depends on nor contradicts it; it assumes those forms.
6. **C-Tokens — Reuse the existing token system.** Plannotator already ships
   a full token + theme system (`packages/ui/theme.css`, 49 files under
   `packages/ui/themes/`). The record-view styling must consume **the same
   CSS custom properties**, not invent a parallel palette.

---

## 2. How Plannotator's theme system works today (study result)

### 2.1 Token vocabulary

Each theme file defines a `.theme-{name}` selector (dark) and a
`.theme-{name}.light` selector (light) that set a fixed set of CSS custom
properties. Confirmed across `themes/task-view.css`, `themes/github.css`,
and the registry. The full token set (from `themes/task-view.css:1-60` and
the Tailwind bridge in `theme.css:56-86`):

| Token | Role |
|---|---|
| `--background` / `--foreground` | page bg / body text |
| `--card` / `--card-foreground` | raised surface (frontmatter card) |
| `--popover` / `--popover-foreground` | overlays / dropdowns |
| `--primary` / `--primary-foreground` | links, focus accent, primary button |
| `--secondary` / `--secondary-foreground` | secondary button / chip |
| `--muted` / `--muted-foreground` | zebra rows, captions, placeholders |
| `--accent` / `--accent-foreground` | highlight accent |
| `--destructive` / `--destructive-foreground` | errors, blocked, broken-link |
| `--success` / `--success-foreground` | promotion-ready, done status |
| `--warning` / `--warning-foreground` | page-top warning, in-progress |
| `--border` | all hairlines / table borders / inputs |
| `--input` | form-control background |
| `--ring` | focus-visible outline |
| `--radius` | corner radius base (`calc()` derivatives in `theme.css:82-85`) |
| `--font-sans` / `--font-mono` | typography families |
| `--code-bg` | inline-code / pre background |

**SV-1.** The record-view stylesheet MUST express every colour, radius and
font through these tokens (or `color-mix()`/`oklch(from …)` derivations of
them, as `theme.css` already does at lines 119-123, 244-265). It MUST NOT
hardcode hex/oklch literals for themable surfaces. (Exception: the existing
GitHub-alert accent literals in `theme.css:345-368` and the inline
broken-link style already on the element — see §2.4 — are pre-existing and
out of scope.)

### 2.2 Theme application mechanism — and why it does not run on this surface

`packages/ui/components/ThemeProvider.tsx` is the canonical mechanism. It
applies a theme by toggling **classes on `document.documentElement`** (the
`<html>` element):

- `resolveThemeClasses` (`ThemeProvider.tsx:32-41`) builds the string
  `theme-${themeId}` plus ` light` when the resolved mode is light and the
  theme's `modeSupport` allows it.
- `applyThemeClasses` (`ThemeProvider.tsx:44-58`) removes any prior
  `theme-*` class + `light`, then adds the resolved pair to `<html>`.
- It reads/writes the choice via `storage` (cookie/localStorage) under keys
  `task-view-color-theme` and `task-view-theme`
  (`ThemeProvider.tsx:77-78,128-136`), defaulting to color theme
  **`task-view`** and mode **`dark`** (`ThemeProvider.tsx:26-28,73-79`).
- `transitions-ready` is added to `<html>` one frame after mount
  (`ThemeProvider.tsx:107-111`) to suppress the first-paint transition
  flash; `theme.css:199-201` keys on it.

**Critical finding.** `ThemeProvider` is a client React component using
`useState`/`useEffect`/`window.matchMedia`/`storage`. The record-view page
tree is rendered with `renderToStaticMarkup` (which strips effects) and the
`<html>` element is **hand-assembled as a string** in `wrapHtml`
(`render-viewer.tsx:228-241`) — it is never produced by React and
`ThemeProvider` is never mounted on this surface. Therefore:

**SV-2.** The theme class MUST be placed on the served `<html>` element by
`wrapHtml` itself (server-side string), reusing the **same class grammar**
`theme-{id}` / `light` that `ThemeProvider` and every theme file expect.
This guarantees the record-view and the (future) full SPA share one token
contract. The record-view does NOT mount `ThemeProvider`.

### 2.3 The theme registry

`packages/ui/utils/themeRegistry.ts` exports `BUILT_IN_THEMES: ThemeInfo[]`
(49 entries). Each carries `id`, `name`, `modeSupport`
(`'both' | 'dark-only' | 'light-only'`), and representative `colors`. This is
the authoritative list of valid theme ids and their mode capability. The
server-side theme resolver (SV-7) reuses this metadata so a `dark-only`
theme is never asked to render `light` (mirrors
`ThemeProvider.tsx:32-40`).

### 2.4 What already carries inline style (do not regress)

`broken-target.tsx:51` emits `style={{ textDecoration: "line-through",
opacity: 0.6 }}` directly on the broken-link `<span>`. This means broken
links degrade legibly even with zero CSS. The new stylesheet MAY add colour
(`--destructive`) and the `(missing)` suffix treatment, but MUST keep the
strikethrough working (the inline style wins regardless).

### 2.5 The Tailwind gap in markdown bodies (important)

`MarkdownBody` / `DetailsBodyWithJournal` (`markdown-renderer.tsx:149-238`)
render record prose through the upstream `BlockRenderer`. `BlockRenderer`
and its block components emit **Tailwind utility classes**, e.g.
`mb-4 leading-relaxed text-foreground/90 text-[15px]`,
`border-l-2 border-primary/50 pl-4 my-4`,
`min-w-full border-collapse text-sm` (sampled from
`components/BlockRenderer.tsx` and `components/blocks/*.tsx`). These utilities
produce visual styling **only when a Tailwind build generates them**.

There is **no Tailwind/PostCSS build** in the SSR path: no
`tailwind.config`, no `postcss.config`, no `vite.config` exist in the repo,
and `theme.css` uses the Tailwind v4 `@theme inline { … }` directive
(`theme.css:56-86`) which is itself only meaningful through the Tailwind
compiler. Additionally `components/blocks/CodeBlock.tsx:3` does
`import 'highlight.js/styles/github-dark.css'` at module scope and runs
`hljs.highlightElement` in a `useEffect` — both are client/bundler-only and
do not execute during `renderToStaticMarkup`.

Consequence: even after the `record-view-*` rules land, the **markdown body
spacing/typography would remain unstyled** because those nodes are
Tailwind-classed, not `record-view-*`-classed. The block utilities do
reference tokens (`text-foreground`, `bg-muted`, `border-border`,
`text-primary`), so colour is recoverable, but box-model utilities
(`mb-4`, `pl-4`, `leading-relaxed`, `border-collapse`, `text-[15px]`) are
not. This spec resolves it with a **scoped element-level stylesheet under
`.record-view-markdown-body` / `.record-view-details`** (SV-30) rather than
shipping a Tailwind build (which would violate C-NoDist). See §6.5 and
**OQ-1**.

---

## 3. Class / selector inventory

Enumerated from `grep -hoE 'className="[^"]*"' packages/ui/record-view/*.tsx`
plus the client-built nodes in `apps/server/web/index.tsx` and the
`record-view-not-found` node in `render-viewer.tsx:152`. **80 distinct
`record-view-*` tokens** + a shared `.sr-only` (already defined,
`theme.css:385-395`). Grouped by surface; file:line is the primary emit
site.

### 3.1 Page roots / containers (one per route)
| Class | Emitted by |
|---|---|
| `record-view-task-list-index` | `task-list-index-view.tsx:20` |
| `record-view-task-page` | `task-list-view.tsx:225` |
| `record-view-roadmap-index` | `roadmap-index-view.tsx:20` |
| `record-view-roadmap-theme` | `roadmap-theme-view.tsx:77` |
| `record-view-backlog-index` | `backlog-index-view.tsx:77` |
| `record-view-backlog-item` | `backlog-item-view.tsx:175` |
| `record-view-not-found` | `render-viewer.tsx:152` |

### 3.2 Index tables + counts
| Class | Emitted by |
|---|---|
| `record-view-task-list-table` | `task-list-index-view.tsx:44` |
| `record-view-task-list-index-count` | `task-list-index-view.tsx:26` |
| `record-view-roadmap-index-table` | `roadmap-index-view.tsx:43` |
| `record-view-roadmap-index-count` | `roadmap-index-view.tsx:26` |
| `record-view-backlog-table` | `backlog-index-view.tsx:136` |
| `record-view-backlog-index-count` | `backlog-index-view.tsx:83` |

The index tables also carry data hooks: `data-task-list-table`,
`data-roadmap-index-table`, `data-backlog-table data-supports-drag-reorder`.

### 3.3 Per-record page sections
| Class | Surface |
|---|---|
| `record-view-task-description` | Task description (`task-list-view.tsx:251`) |
| `record-view-task-subtasks` | Task subtasks wrapper (`:278`) |
| `record-view-subtask-block` | one subtask (`:385`) |
| `record-view-subtask-description` | (`:405`) |
| `record-view-subtask-details` / `-details-label` | (`:443`,`:438`) |
| `record-view-test-strategy` | subtask test strategy (`:420`) |
| `record-view-priority-note` / `record-view-status-note` | (`:267`,`:272`) |
| `record-view-empty-subtasks` | "No subtasks." (`:287`) |
| `record-view-roadmap-theme-description` | (`roadmap-theme-view.tsx:103`) |
| `record-view-roadmap-theme-cross-doc-links` | (`:140`) |
| `record-view-roadmap-theme-notes` | (`:171`) |
| `record-view-roadmap-theme-linked-tasks` / `-linked-backlog` | (`:208`, dynamic) |
| `record-view-backlog-header` | (`backlog-item-view.tsx:199`) |
| `record-view-backlog-notes` / `-details` / `-test-strategy` | (`:227`,`:245`,`:266`) |
| `record-view-promotion-badge` | (`:212`) |
| `record-view-blocked-banner` | (`:185`) |

### 3.4 Frontmatter card
| Class | Emitted by (`record-frontmatter-card.tsx`) |
|---|---|
| `record-view-frontmatter-card` | `:63` (a `<table>`) |
| `record-view-frontmatter-row` | `:72` |
| `record-view-frontmatter-label` | `:76` (a `<th scope=row>`) |
| `record-view-frontmatter-value` | `:82` (a `<td>`) |
| `record-view-field-value` | `:89` (value span, also reused widely) |

`data-unset` marks em-dash placeholders (`:112-116`).

### 3.5 Nav strip
`record-view-nav-strip` (a `<nav>`), `record-view-nav-prev`,
`record-view-nav-index`, `record-view-nav-next` (`nav-strip.tsx:19-47`).
Edge cases carry `data-nav-prev-disabled` / `data-nav-next-disabled`.

### 3.6 Links + broken-target
`record-view-record-link`, `record-view-doc-link` (live links,
`broken-target.tsx:76,103`); `record-view-broken-link`,
`record-view-broken-suffix` (`:49,54`); `record-view-page-top-warning`
(`:127`). Data hooks: `data-record-link`, `data-doc-link`,
`data-broken-target="record|doc"`, `data-page-top-warning`.

### 3.7 Edit affordances + pencils + inline edit forms
| Class | Source |
|---|---|
| `record-view-pencil-button` | `field-pencil.tsx:93`; `backlog-index-view.tsx:236`; client `index.tsx:658,684` |
| `record-view-edit-form` | client `index.tsx:270` |
| `record-view-text-input` | client `index.tsx:369` |
| `record-view-textarea` | client `index.tsx:325` |
| `record-view-enum-dropdown` | client `index.tsx:342` |
| `record-view-array-comma-input` | (declared kind; input built generically) |
| `record-view-save-button` / `record-view-cancel-button` | client `index.tsx:378-381` |
| `record-view-save-cancel-controls` | reserved wrapper token |
| `record-view-inline-error` | client `index.tsx:728` (also `role="alert"`) |
| `record-view-doclink-table` / `-row` / `-path` / `-anchor` / `-raw` / `-add` / `-delete` / `-form` | client `index.tsx:283,400,411,423,311` |

The pencil glyph is `✎` in an `aria-hidden` span; the affordance carries
`data-edit-action="open"` + `data-edit-field` + `data-edit-kind` (+
`data-edit-options` / `data-edit-raw-value`) per `field-pencil.tsx:90-103`.

### 3.8 Backlog filters + drag gutter + rank cell
`record-view-backlog-filters` (a `<form>`), `record-view-filter-select` (a
`<label>`), `record-view-filter-label` (`backlog-index-view.tsx:91,270,273`);
`record-view-drag-cell` (`:201`) with the `data-drag-handle`
`role="button"` `tabindex=0` glyph `☰`; `record-view-rank-cell` /
`record-view-rank-value` (`:228,231`) with `data-rank-value`.

### 3.9 Empty / not-found states
`record-view-empty-ledger` (all three index views; `data-empty-ledger`),
`record-view-empty-filtered` (`backlog-index-view.tsx:129`),
`record-view-empty-subtasks` (`task-list-view.tsx:287`),
`record-view-not-found` (`render-viewer.tsx:152`).

### 3.10 Markdown body (Tailwind-classed children — see §2.5)
`record-view-markdown-body` (`markdown-renderer.tsx:154`),
`record-view-details`, `record-view-details-prose`,
`record-view-details-journal`, `record-view-details-journal-label`,
`record-view-details-journal-ts`, `record-view-details-journal-body`
(`:198-230`).

---

## 4. SSR injection mechanism (the core decision)

### 4.1 Options weighed

| Option | Inv 44 | C-NoDist | Determinism | FOUC | Verdict |
|---|---|---|---|---|---|
| **A. External CDN / asset URL** | ✗ violates | n/a | n/a | — | **Rejected** (C-Inv44). |
| **B. `<link rel=stylesheet href="/styles.css">` route served by the same process** | ✓ same origin | ✓ | ✓ if read deterministically | risk: extra round-trip → brief flash before CSS lands | Viable but inferior; second request, FOUC window, and the page is already a single self-contained doc. |
| **C. Inline `<style>` in `<head>`, built once at boot from the token/theme CSS** | ✓ in-document | ✓ | ✓ | none (styles arrive with markup) | **Recommended.** |
| **D. `Bun.build` CSS bundling at boot** | ✓ | ✓ but adds a CSS build surface incl. Tailwind `@theme`/`@import` semantics Bun does not fully resolve | partial | none | Rejected — re-introduces a build/drift surface and the Tailwind-directive problem (§2.5). |

### 4.2 Recommended: Option C — inline `<style>` assembled at boot

**TECH §1.** Add a server module `packages/server/viewer-styles.ts` that, at
**first call** (cached in-process exactly like `client-bundle.ts:43-78`),
assembles the record-view stylesheet string from CSS sources read off disk,
and exposes:

```
getViewerStyles(themeId: string, mode: 'dark' | 'light' | 'system'):
  { css: string; htmlClass: string }
```

- `css` is the full stylesheet text to inline.
- `htmlClass` is the `theme-{id}[ light]` string for the `<html>` element
  (SV-2), resolved through the registry's `modeSupport` (SV-7).

`wrapHtml` (`render-viewer.tsx:215-242`) is extended to (a) set
`class="${htmlClass}"` on `<html>` and (b) emit `<style>${css}</style>` in
`<head>`. `renderViewer` gains an optional `theme`/`mode` input threaded
from `handleGetRoot` (`patch-server.ts:224-264`); when absent it uses the
defaults in SV-6. The `<style>` content is sanitised the same defensive way
the script is (`render-viewer.tsx:223-225`): any literal `</style>` in the
assembled CSS is neutralised to `<\/style>` so authored CSS can never break
out of the element. (Authored CSS will contain none, but the guard is cheap
and matches the existing house pattern.)

**TECH §2 — what CSS the boot assembler concatenates, in order:**

1. **Token layer.** The `.theme-{id}` (+ `.theme-{id}.light`) blocks from
   the **selected** theme file under `packages/ui/themes/`, PLUS the
   `task-view` theme as a guaranteed fallback so an unknown/edge theme still
   has a full token set. (Reading one or two small files — each ~1-5 KB —
   keeps the inline payload small; we do NOT inline all 49.)
2. **Base layer (subset of `theme.css`).** The plain-CSS, browser-valid
   rules from `theme.css` that the record-view relies on: the `body { … }`
   block (`:95-100`), `:focus-visible` (`:213-216`), `::selection`
   (`:190-192`), scrollbar fallbacks (`:140-149`), the
   `prefers-reduced-motion` and transition rules (`:178-210`), and the
   `.sr-only` utility (`:385-395`). The Tailwind-only `@theme inline { … }`
   block (`:56-86`) and `@layer base { … }` (`:89-93`) are **excluded** —
   they are compiler directives, not browser CSS. (See **OQ-2** on whether to
   physically split `theme.css` into a `theme.base.css` for a clean import
   vs. string-slice at boot.)
3. **Record-view layer.** The new `packages/ui/record-view/record-view.css`
   (SV-3 … SV-30) — the bulk of this spec's visual design, authored as plain
   token-driven CSS.

**TECH §3 — cross-platform file resolution.** The assembler resolves CSS
paths from `import.meta.dir` (this module lives in `packages/server`) via
`node:path.join(here, "..", "ui", …)`, exactly as `client-bundle.ts:34-41`
resolves the client entry. Files are read with `Bun.file(path).text()`. No
`process.cwd()`, no glob ordering — the import list is explicit and fixed, so
output is deterministic (C-Deterministic).

**TECH §4 — failure isolation.** Like `getClientBundle`
(`client-bundle.ts:68-77`), a read failure must NOT take down the viewer:
catch, `console.error` to stderr, and fall back to a tiny built-in safety
stylesheet (string constant in the module) that at minimum sets
`--background`/`--foreground` for the `task-view` dark theme + a readable
`font-family` and table borders. The page renders themed-degraded, never
unstyled-broken.

**SV-3.** The complete record-view stylesheet MUST be present in the `GET /`
response `<head>` as a single inline `<style>` for every route (index,
per-record, 404). No record-view route may serve markup without it.

### 4.3 Payload note

Token file (≤5 KB) + base subset (~3 KB) + record-view rules (est. 8-14 KB
authored, more with comments) → on the order of 15-25 KB of inline CSS,
uncompressed, served once per navigation. Acceptable for a loopback tool;
no caching strategy is required (every page is a fresh same-process render).
If payload ever matters, Option B (`/styles.css` with a cache header) is the
documented fallback — but it is explicitly **not** recommended now.

---

## 5. Theme integration

**SV-6 — Default theme + mode.** The default colour theme is **`task-view`**
and the default mode is **dark**, matching `ThemeProvider`'s own defaults
(`ThemeProvider.tsx:26-28,73-79`) and the project's namesake theme
(`themes/task-view.css`). Rationale: zero-config parity with the full SPA and
the fork's identity.

**SV-7 — Server-side mode resolution.** The boot assembler resolves the
emitted `<html>` class using the registry's `modeSupport`
(`themeRegistry.ts:13`), reproducing `resolveThemeClasses`
(`ThemeProvider.tsx:32-40`): `dark-only` → never `light`; `light-only` →
always `light`; `both` → honour the requested mode. `system` resolves to
`dark` **server-side** (no `matchMedia` on the server; SV-9 lets the client
correct it).

**SV-8 — Theme selection on this surface.** v1 ships a **server-resolved**
theme with two override channels, in precedence order:

1. **Cookie `task-view-color-theme` / `task-view-theme`** sent by the
   browser (the SAME keys `ThemeProvider` writes,
   `ThemeProvider.tsx:77-78`). `handleGetRoot` reads `Cookie:` off the
   `Request` (`patch-server.ts:224`) and threads the parsed values into
   `renderViewer`. This means: if the user has ever used the full SPA (or a
   future in-page picker) in this browser, the record-view **inherits their
   chosen theme automatically**, with no UI of its own.
2. **Query override `?theme=<id>&mode=<dark|light|system>`** — convenience
   for testing/deep-linking; validated against `BUILT_IN_THEMES` ids and the
   mode enum, else ignored (falls through to cookie → default). Validation
   is mandatory: an unknown id MUST NOT reach the `<html>` class unescaped.
3. **Default** SV-6.

An in-page `<select>` theme picker is **out of v1 scope** but enabled by the
design: because the chosen theme already lives on `<html>` and in the
cookie, a later subtask can add a small picker that writes the cookie and
toggles the `<html>` class with the exact `applyThemeClasses` logic
(`ThemeProvider.tsx:44-58`) — no re-architecture. Tracked as **OQ-3**.

**SV-9 — No-flash + client mode-correction (progressive).** Because the
theme class is baked into the served `<html>` (SV-2), first paint is themed
with **no FOUC**. For `system` mode, the inlined client dispatcher
(`apps/server/web/index.tsx`) MAY, as a tiny additive enhancement, read
`prefers-color-scheme` and toggle the `light` class on `<html>` to match —
reusing `applyThemeClasses` semantics. This is optional and additive; absent
it, `system` shows the dark default. (The page must not add
`transitions-ready` until after first paint to avoid a transition flash;
`theme.css:199-201` already gates on it — emit `<html class="theme-… ">`
WITHOUT `transitions-ready`, and let the client add it on load if the
mode-correction enhancement ships.)

**SV-10 — Persistence.** Persistence is the **cookie**, owned by the client
(SPA picker or the optional enhancement). The server only READS it. The
server writes no cookie of its own for theme (keeps `GET /` a pure read,
consistent with the patch-server's read/write split).

---

## 6. Visual design

All values are token-driven (SV-1). Numbers below are the **design intent**;
the implementer expresses them with the tokens/utilities named. Light + dark
are both covered automatically because every colour is a token that each
theme file defines for both modes (§2.1).

### 6.1 Page shell + typography scale
- **SV-11.** Each page root (`.record-view-task-page`, `…-backlog-item`,
  `…-roadmap-theme`, and the three `*-index` roots, plus
  `.record-view-not-found`) is centred in a **max-width container**:
  `max-width: 64rem; margin-inline: auto; padding: 1.5rem (clamp to 1rem on
  narrow viewports)`. Background `--background`, text `--foreground`, font
  `--font-sans`. `line-height: 1.6` for body copy.
- **SV-12.** Type scale (rem, fluid via `clamp` where noted): `h1` 1.75-2rem
  / 600; `h2` 1.35rem / 600 with a `--border` bottom hairline + small
  bottom margin; `h3` 1.1rem / 600 (subtask titles); body 0.95-1rem;
  captions/`-count`/`-journal-ts` 0.8rem `--muted-foreground`. Headings use
  `--foreground`; ID-prefixes in `h1`/`h3` (e.g. `ID-20: `) read in
  `--muted-foreground` so the editable title span (`.record-view-field-value`)
  is the visual emphasis.
- **SV-13.** `--font-mono` for `<code>`, commit-ref `<code>`
  (`task-list-view.tsx:59`), ids in index tables, and rank values.

### 6.2 Tables (index views + frontmatter card)
- **SV-14.** Index tables (`.record-view-task-list-table`,
  `.record-view-roadmap-index-table`, `.record-view-backlog-table`):
  `width: 100%; border-collapse: collapse`. `th` left-aligned, 600,
  `--muted-foreground`, `bg` = `color-mix(--muted 30%)`, bottom border
  `--border` (2px). `td` padding `0.5rem 0.75rem`, bottom border
  `color-mix(--border 50%)`.
- **SV-15. Zebra + hover.** `tbody tr:nth-child(even)` → `bg`
  `color-mix(--muted 18%)`; `tbody tr:hover` → `bg` `color-mix(--muted
  35%)`. Hover transition uses the existing global colour transition
  (`theme.css:206-210`).
- **SV-16. Sticky header.** `thead th { position: sticky; top: 0; z-index:
  1; background: <opaque-from --background/--muted> }` so long ledgers keep
  the header visible. Background MUST be opaque (not a translucent mix) to
  avoid rows bleeding through while scrolling.
- **SV-17. Frontmatter card.** `.record-view-frontmatter-card` is a 2-column
  key/value `<table>` rendered as a **raised card**: `background --card;
  color --card-foreground; border 1px --border; border-radius var(--radius);
  padding; box-shadow` (a subtle `--border`-derived shadow; MAY reuse
  `theme.css:122-123` `.glow-sm` intent at low intensity). `.…-label`
  (`<th scope=row>`): right-aligned-to-content, 600, `--muted-foreground`,
  `width: 1%` so the value column flexes. `.…-value` wraps; `data-unset`
  em-dash renders in `--muted-foreground`.

### 6.3 Nav strip
- **SV-18.** `.record-view-nav-strip` is a 3-segment flex row
  (`display:flex; justify-content:space-between; gap:1rem; align-items:
  center`) with a `--border` bottom hairline and bottom margin. `…-prev`
  left, `…-index` centre, `…-next` right. Disabled edges
  (`[data-nav-prev-disabled]`/`[data-nav-next-disabled]`) render in
  `--muted-foreground` with `cursor:default`. Long labels truncate with
  `text-overflow: ellipsis; overflow:hidden; white-space:nowrap; max-width`
  per segment so the strip geometry stays stable (the component already
  guarantees both segments render — `nav-strip.tsx:28-46`).

### 6.4 Links + broken-target + warnings
- **SV-19.** `.record-view-record-link`, `.record-view-doc-link`, and index
  table anchors: `color --primary; text-decoration: none; underline on
  hover/focus` (`text-underline-offset: 2px`). Visited does not change
  colour (internal navigation).
- **SV-20.** `.record-view-broken-link`: `color --destructive` +
  KEEP the inline strikethrough/opacity (§2.4). `.record-view-broken-suffix`:
  `--muted-foreground`, `font-size: 0.85em`. (Selectable via
  `[data-broken-target]` too, per `broken-target.tsx:8` consumer-override
  note.)
- **SV-21.** `.record-view-page-top-warning` (role=alert): a banner —
  `background color-mix(--warning 15%); border-left: 3px solid --warning;
  color --foreground; padding; border-radius`. Mirrors the GitHub-alert
  visual idiom already in `theme.css:345-368` but token-driven.
- **SV-22.** `.record-view-blocked-banner` (role=alert): same banner shape on
  `--destructive` (`color-mix(--destructive 15%)` + 3px `--destructive`
  left border).

### 6.5 Markdown body + journal blocks
- **SV-30 (resolves §2.5).** Author element-level rules **scoped under**
  `.record-view-markdown-body`, `.record-view-details`, and
  `.record-view-details-prose` so the Tailwind-classed children get a correct
  typographic floor without a Tailwind build: descendant `p`
  (`margin: 0.75rem 0`), `ul/ol` (`margin: 0.5rem 0; padding-left: 1.5rem;
  list-style`), `h1-h4`, `blockquote` (left border `--border`,
  `--muted-foreground`, italic), `table` (`border-collapse; width:auto; th/td
  borders + padding`), `code` (`--code-bg`, padding, radius), `pre`
  (`--code-bg`, border, radius, `overflow-x:auto`), `a` (`--primary`). These
  mirror the existing `.html-block …` rules in `theme.css:270-331` — reuse
  that idiom directly (it is already plain token-driven CSS). Colour tokens
  the utilities reference (`text-foreground/90` etc.) resolve once the theme
  class is on `<html>`.
- **SV-31. Journal blocks** (PRODUCT inv 8 last bullet, the *only* prose
  styling the spec text mandates explicitly): `.record-view-details-journal`
  (an `<aside>`) renders **subtly indented + visually distinct**:
  `border-left: 2px solid color-mix(--primary 50%); background:
  color-mix(--muted 30%); padding; margin; border-radius; margin-left:
  ~1rem`. `.record-view-details-journal-label` 600 `--foreground`;
  `.record-view-details-journal-ts` `--muted-foreground`, `0.8rem`,
  `--font-mono`. `.record-view-details-prose` carries no special chrome.
- **SV-32. Code-highlight note.** `highlight.js` does not run server-side
  (§2.5). `pre code` MUST be legible from SV-30 alone (token bg + mono +
  wrap). If client-side hljs ever runs on this surface it adds colour on top;
  the base style must not depend on it. (No `github-dark.css` is inlined —
  it would fight whatever theme is active. **OQ-1**.)

### 6.6 Status / priority badges
- **SV-23.** `.record-view-promotion-badge` (`backlog-item-view.tsx:212`):
  a pill — `display:inline-block; font-size:0.75rem; font-weight:600;
  text-transform:uppercase; letter-spacing:0.02em; padding:0.15rem 0.5rem;
  border-radius:999px; background color-mix(--success 20%); color
  --success-foreground or --foreground for contrast`.
- **SV-24. Status/priority value treatment.** Status/priority strings appear
  as plain `<td>`/value text today (no per-value class). v1 styling: render
  status values that the dispatcher exposes (`done`/`in_progress`/`pending`
  /`blocked`/`ready`) as **subtle text-colour cues** via attribute selectors
  on the existing data hooks where present, OR leave as plain text if no hook
  exists. Because index-table status cells carry **no** per-value hook
  (`task-list-index-view.tsx:69`), v1 keeps them plain to avoid inventing
  markup; a dedicated badge for status is **OQ-4** (needs a small component
  change to emit `data-status`). Do not gold-plate by editing components for
  this in the styling subtask.

### 6.7 Drag-handle gutter + rank cell
- **SV-25.** `.record-view-drag-cell`: a slim gutter — `width: 2.25rem;
  text-align:center; color --muted-foreground; cursor: grab`. The
  `[data-drag-handle]` glyph `☰` (`backlog-index-view.tsx:212`) gets
  `cursor:grab` and on `:focus-visible` the standard ring (SV-40). It is
  keyboard-operable (`role=button tabindex=0`,
  `backlog-index-view.tsx:204-207`) so it MUST show a visible focus ring.
  Actual drag motion is client behaviour, not styling.
- **SV-26.** `.record-view-rank-cell` is `white-space:nowrap`;
  `.record-view-rank-value` mono; the inline pencil (SV-27) sits beside it.

### 6.8 Empty / 404 states
- **SV-28.** `.record-view-empty-ledger`, `.record-view-empty-filtered`,
  `.record-view-empty-subtasks`: centred, `--muted-foreground`, italic
  (the components already wrap copy in `<em>`), generous vertical padding
  (`2-3rem`), no border. A muted illustration is out of scope.
- **SV-29.** `.record-view-not-found` (`render-viewer.tsx:152`): centred
  card-ish block; `h1` normal weight; the "Back to index" `<a>` styled as a
  link (SV-19). Served with HTTP 404 (already — `render-viewer.tsx:160`); the
  style must read as an error page, not a broken render.

---

## 7. Edit-affordance + interactivity styling

The client dispatcher builds form DOM with these classes but injects **no
CSS** (`apps/server/web/index.tsx` header comment; it is JS-only). All edit
styling therefore lives in `record-view.css` and applies the moment the
dispatcher swaps display → form.

- **SV-27. Pencil button.** `.record-view-pencil-button`: a small, low-chrome
  icon button — `background:transparent; border:0; padding:0 0.25rem;
  cursor:pointer; color --muted-foreground; line-height:1`. `:hover/:focus`
  → `color --primary`. The `✎` glyph inherits. By default the pencil is
  **subtle**; reveal-on-hover/focus of its container is a nicety
  (`opacity:0.5` rising to `1` on
  `td:hover`/`[data-edit-container]:hover`/`:focus-within`) but MUST stay
  fully visible on keyboard focus (no hover-only affordance — SV-41).
- **SV-33. Edit form.** `.record-view-edit-form` (a `<form>` swapped into the
  cell/section): `display:flex; flex-wrap:wrap; gap:0.5rem; align-items:
  flex-start`. Inputs/textarea/select:
  `.record-view-text-input`, `.record-view-textarea`,
  `.record-view-enum-dropdown`, `.record-view-array-comma-input` →
  `background --input; color --foreground; border:1px solid --border;
  border-radius: calc(var(--radius) - 2px); padding:0.35rem 0.5rem; font:
  inherit`. Textarea: `width:100%; min-height: 4lh; resize:vertical` (the
  dispatcher autosizes height, `index.tsx:520-523`). `:focus-visible` ring
  per SV-40.
- **SV-34. Save / cancel.** `.record-view-save-button`: primary —
  `background --primary; color --primary-foreground; border:0; radius;
  padding:0.35rem 0.75rem; font-weight:600; cursor:pointer`. `:hover` slight
  lightness shift via `oklch(from --primary …)` or `color-mix`.
  `.record-view-cancel-button`: secondary/ghost —
  `background:transparent; color --foreground; border:1px solid --border`.
  Optional `.record-view-save-cancel-controls` wrapper aligns them.
- **SV-35. Inline error.** `.record-view-inline-error` (role=alert,
  `index.tsx:728`): `color --destructive; font-size:0.85rem; margin-top:
  0.35rem; flex-basis:100%` so it drops to its own line under the form.
- **SV-36. Doc-link editor.** `.record-view-doclink-table`: compact table
  inside the form; `.record-view-doclink-path/-anchor/-raw` are
  text inputs styled like SV-33 at `width:100%`;
  `.record-view-doclink-add` styled as a small secondary button (SV-34
  ghost); `.record-view-doclink-delete` a small destructive-text button
  (`color --destructive; background:transparent; border:0`). Row spacing via
  `td` padding.
- **SV-37. Filter controls.** `.record-view-backlog-filters`:
  `display:flex; flex-wrap:wrap; gap:1rem; align-items:end; margin-block:
  1rem`. `.record-view-filter-select` (a `<label>`): stacked
  (`display:flex; flex-direction:column; gap:0.25rem`).
  `.record-view-filter-label`: `0.8rem`, `--muted-foreground`. The `<select>`
  styled like SV-33 inputs. `<noscript>` Apply button
  (`backlog-index-view.tsx:114-116`) inherits SV-34 secondary.

---

## 8. Accessibility

The components already target WCAG 2.1 AA (sr-only labels, `role=alert`,
`aria-label`, the axe-core `empty-table-header` accommodation at
`backlog-index-view.tsx:142-151`). Styling must not regress that.

- **SV-40. Focus ring.** Reuse the existing `:focus-visible { outline: 2px
  solid var(--ring); outline-offset: 2px }` (`theme.css:213-216`) — it is
  part of the base layer the assembler inlines (TECH §2.2), so every link,
  button, input, select, pencil, and the drag handle get a consistent,
  token-driven, visible focus ring automatically. The record-view CSS MUST
  NOT set `outline:none` anywhere.
- **SV-41. No hover-only affordances.** Any reveal-on-hover treatment
  (SV-27 pencil) MUST also reveal on `:focus-within`/keyboard focus so
  keyboard and AT users reach every control. The pencil's accessible name is
  already supplied (`aria-label`, glyph `aria-hidden`).
- **SV-42. Contrast.** Token pairs are designed as fg/bg duals
  (`--*-foreground`). Styling MUST pair text with its matching
  `*-foreground` (or `--foreground` on `--background`/`--card`/`--muted`) so
  AA (4.5:1 body, 3:1 large) holds across themes. `color-mix` tints used for
  zebra/hover/badges are background-only; text on them stays `--foreground`
  /`--muted-foreground`. Flag any specific theme that fails as a follow-up
  (the 49 themes are pre-existing; this spec does not re-audit each).
- **SV-43. Reduced motion.** The base layer already neutralises transitions
  under `prefers-reduced-motion` for the scroll components
  (`theme.css:178-187`); the record-view adds only **colour** transitions
  (inheriting `theme.css:206-210`). SV-43 requires: the record-view CSS adds
  a `@media (prefers-reduced-motion: reduce)` block that sets
  `transition-duration: 0` on any element it animates (pencil opacity, hover
  tints) so motion-sensitive users get instant state changes.
- **SV-44. Semantic colour is not the only signal.** Status/blocked/broken
  states convey meaning via text too (the `(missing)` suffix, "Blocked."
  word, strikethrough) — never colour alone. Preserve those textual cues.

---

## 9. Test strategy

The harness is `bun test` with `renderToStaticMarkup` + `expect(html)
.toContain(…)` (see `packages/ui/record-view/end-to-end-render.test.tsx`,
`render-viewer.test.tsx`). Styling is asserted **deterministically at the
HTML-string level** — no browser, no pixel snapshot — plus optional DOM
assertions via the already-present `@happy-dom/global-registrator`
(used in `tests/integration/dispatcher-enum-raw.test.tsx`).

- **SV-50. `<style>` presence + placement** (extend `render-viewer.test.tsx`).
  Assert the `GET /`-equivalent `renderViewer({…, theme})` output:
  - contains exactly one `<style>` in `<head>` (before the body markup),
  - the `<style>` contains a load-bearing sentinel from each layer:
    a token rule (`--background`), a base rule (`:focus-visible`), and a
    record-view rule (`.record-view-frontmatter-card`),
  - contains a `.record-view-*` selector for **every** page root (§3.1),
  - the only `</style>` present is the wrapper's (breakout-neutralisation
    test, mirroring the existing `</script>` test at
    `render-viewer.test.tsx:61-71`).
- **SV-51. `<html>` theme class** (`render-viewer.test.tsx`). Default →
  `<html lang="en" class="theme-task-view">` (dark, no `light`). With
  `?theme=github&mode=light` → `class="theme-github light"`. With a
  `dark-only` theme + `mode=light` → no `light` (SV-7). With an **invalid**
  `?theme=` → falls back to `theme-task-view` and the invalid value never
  appears in the output (injection guard).
- **SV-52. Cookie precedence.** A unit test of the theme-resolution helper
  (pure function): `parseThemePreference(cookieHeader, query)` →
  cookie beats default, query beats cookie, invalid ignored. Keep the
  resolver pure + separately testable (do not bury it in `wrapHtml`).
- **SV-53. Boot assembler determinism + isolation** (new
  `viewer-styles.test.ts`). Two calls return byte-identical `css` (cache);
  the concatenation order is fixed; a forced read failure (point the
  resolver at a missing file via the test-only reset, mirroring
  `_resetClientBundleCacheForTests`, `client-bundle.ts:119-122`) returns the
  safety stylesheet AND logs to stderr, never throws.
- **SV-54. Selector coverage guard.** A test that reads
  `record-view.css` and asserts every `record-view-*` token enumerated in §3
  (maintain the list as a fixture array) has at least one matching rule —
  catches a renamed/added class that loses styling. (This is the regression
  net for the original bug.)
- **SV-55. No `outline:none`.** Assert `record-view.css` contains no
  `outline:none`/`outline: 0` (SV-40 guard).
- **SV-56. Reduced-motion block present.** Assert the CSS contains a
  `prefers-reduced-motion: reduce` block (SV-43 guard).
- **SV-57. happy-dom smoke (optional but recommended).** Inject the assembled
  `css` into a happy-dom `<style>`, render a page into the document, and
  assert `getComputedStyle` on the page root yields a non-empty
  `background` once `<html class="theme-task-view">` is set — proving the
  token cascade reaches the record-view nodes end-to-end. (happy-dom's
  CSS-cascade support is partial; if a given computed value is unreliable,
  fall back to asserting the class + rule presence per SV-50/51.)

Existing tests (`end-to-end-render.test.tsx`, the per-view `*.test.tsx`)
assert markup/`data-*` and MUST keep passing unchanged — styling adds a
`<style>` and an `<html>` class only; it does not alter component markup.
`bun test` baseline (currently green) is the gate.

---

## 10. Out of scope (v1)

- An in-page theme/mode **picker UI** (design supports it — OQ-3).
- Per-status **badge components** requiring new `data-status` markup (OQ-4).
- Server-side **syntax highlighting** of code blocks (OQ-1).
- Re-auditing all 49 themes for AA on this specific surface (SV-42 pairs
  tokens correctly; per-theme audits are a separate hardening pass).
- `print.css` integration for the record-view (it exists for the SPA;
  wiring `.task-view-print` here is a later nicety).
- Any change to the patch server's write paths, schemas, or the edit
  dispatcher's behaviour.

---

## 11. Open questions — RESOLVED

All five OQs (plus two additional asks) were ratified by the user before
implementation. Recorded here as the authoritative resolution; the bodies
above are superseded where they differ.

- **OQ-1 — Code-block colour → Option (b): client-side highlight.js.**
  Real syntax highlighting via the client bundle, not server-side
  token-only. Verified feasible: `highlight.js@11.11.1` is installed under
  Bun's isolated layout (`node_modules/.bun/highlight.js@11.11.1/`) and
  `Bun.build` of the client entry resolves it (the same mechanism that
  already bundles the dispatcher). Implementation: the inlined client
  dispatcher runs `hljs.highlightElement` over `pre code.hljs` nodes after
  DOM parse, and the boot assembler inlines a **theme-neutral, token-driven**
  hljs stylesheet (`record-view/hljs-tokens.css`) so highlight colours track
  the active theme rather than fighting it. The SSR `<pre><code
  class="hljs font-mono language-…">` markup (confirmed emit) is already the
  attach point; base legibility (SV-32) still holds with JS off.
- **OQ-2 — Split `theme.css` → physically split into `theme.base.css` +
  `theme.css`. Pipeline-impact check PASSED (no STOP).**
  - `theme.css` is imported by **nothing** in the committed runtime: not by
    the SPA/dispatcher entry `apps/server/web/index.tsx`, not by
    `apps/server/web/index.html` (which loads only Google Fonts), and not by
    any `.ts`/`.tsx`. The sole reference is the `packages/ui/package.json`
    export-map alias `"./theme": "./theme.css"` — an export, not an import.
  - `apps/server/web/vite.config.ts` exists (with `@tailwindcss/vite`) but is
    **not** in the running CLI path (C-NoDist: `bin/task-view.js` →
    `bun apps/server/index.ts`; no Vite, no dist). If the SPA is ever built
    with Vite, `@tailwindcss/vite` resolves `@import` chains + `@theme`
    natively, so `theme.css` `@import "./theme.base.css"` is transparent.
  - **Therefore the split breaks no SPA import / Vite config / `@import`.**
    `theme.css` retains `@import "./theme.base.css"` at the top so any future
    Tailwind build still sees the full effective CSS. Proceeding with the
    physical split per T1.
- **OQ-3 — Theme picker → ship IF ≤ ~20 lines.** Implemented as a
  server-rendered `<select>` in the nav strip wired to the existing cookie
  keys (`task-view-color-theme` / `task-view-theme`) + a tiny client handler
  in the dispatcher that writes the cookie and re-classes `<html>` via the
  `applyThemeClasses` grammar. Final size is reported in the implementation
  summary; if it had materially exceeded the budget it would have been
  deferred to v2.
- **OQ-4 — Status/priority badges → YES.** Appetite confirmed. Add
  `data-status` / `data-priority` hooks to the relevant components
  (index tables + frontmatter rows) and render status/priority as themed
  badges per §6.6, with attribute-selector colour cues per value
  (done/in_progress/pending/blocked/ready + priority tiers). Components +
  their tests are updated accordingly (this overrides SV-24's "leave plain /
  do not edit components" guidance).
- **OQ-5 — Default mode → dark.** SV-6 stands (dark + `task-view`).
- **ADDITIONAL — print.css integration.** Wire the record-view surface into
  the existing `print.css` mechanism: the boot assembler inlines `print.css`,
  and the client dispatcher toggles the `.task-view-print` class on `<html>`
  on `beforeprint`/`afterprint` (the same two-pronged mechanism Plannotator
  uses — `@media print` + the JS-added class for overrides that beat the
  hljs theme). This supersedes §10's "print.css … is a later nicety".
- **ADDITIONAL — no-dist constraint (C-NoDist / inv 44).** Confirmed NOT a
  deal-breaker, but the inline-`<style>`-at-boot approach (Option C) was
  followed with no concrete blocker encountered, so no Vite/dist pivot was
  needed and none was made.
