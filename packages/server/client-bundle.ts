/**
 * client-bundle.ts — build + cache the progressive-enhancement client
 * bundle for inline injection into the SSR viewer HTML (ID-20.24).
 *
 * Build-bridge choice (ratified S265): `Bun.build()` the client entry
 * (`apps/server/web/index.tsx`) ONCE at server boot, cache the emitted
 * JS in-process, and inline it into `wrapHtml`'s `<script>` tag. There
 * is NO committed dist artifact (no drift) and NO separate long-running
 * dev server — `bun apps/server/index.ts` stays fully self-contained
 * (PRODUCT inv 44 loopback-only single-file CLI distribution preserved).
 *
 * Why Bun.build over `vite build web`:
 *   - The CLI install/run path runs TS source via Bun with NO build step
 *     (`bin/task-view.js` → `bun apps/server/index.ts`). Requiring a
 *     committed Vite artifact would re-introduce a build step + a drift
 *     surface. Bun.build at boot keeps the bundle in lock-step with the
 *     source that ships.
 *   - Bun is already the only supported runtime (apps/server/index.ts
 *     gates on `typeof Bun`), so Bun.build is always available.
 *
 * The bundle is a self-contained IIFE-style module (target browser): it
 * attaches the delegated edit listeners on load. It carries no record
 * data — progressive enhancement reads the SSR `data-*` hooks directly,
 * so there is no hydration-mismatch surface and no serialisation step.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the client entry point. `import.meta.dir` is the directory of
 * THIS module (packages/server); the entry lives at
 * `apps/server/web/index.tsx` relative to the repo root (two dirs up).
 */
function resolveClientEntry(): string {
  const here =
    typeof import.meta.dir === "string"
      ? import.meta.dir
      : dirname(fileURLToPath(import.meta.url));
  // packages/server → repo root → apps/server/web/index.tsx
  return join(here, "..", "..", "apps", "server", "web", "index.tsx");
}

/** In-process cache — built once per server process. */
let cachedBundle: string | null = null;
let buildInFlight: Promise<string> | null = null;

/**
 * Build the client bundle (once) and return its JS source as a string,
 * suitable for inlining inside a `<script>` tag. Subsequent calls return
 * the cached result without rebuilding.
 *
 * On build failure, returns a SMALL inert fallback script that logs the
 * failure to the browser console rather than throwing — a broken client
 * build must NOT take down the SSR viewer (which is fully usable
 * read-only + via the JSON API). The server-side build error is also
 * surfaced to stderr so the developer sees it.
 */
export async function getClientBundle(): Promise<string> {
  if (cachedBundle !== null) return cachedBundle;
  if (buildInFlight !== null) return buildInFlight;

  buildInFlight = buildClientBundle()
    .then((js) => {
      cachedBundle = js;
      buildInFlight = null;
      return js;
    })
    .catch((err) => {
      buildInFlight = null;
      const message = (err as Error).message ?? String(err);
      // Surface server-side so a broken build is visible to the developer.
      console.error(`task-view: client bundle build failed: ${message}`);
      const fallback = buildFallbackScript(message);
      cachedBundle = fallback;
      return fallback;
    });
  return buildInFlight;
}

async function buildClientBundle(): Promise<string> {
  const entry = resolveClientEntry();
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "iife",
    minify: true,
    // No splitting — a single inline string is what we inject.
    splitting: false,
  });
  if (!result.success) {
    const logs = result.logs.map((l) => String(l.message ?? l)).join("; ");
    throw new Error(logs || "unknown Bun.build failure");
  }
  if (result.outputs.length === 0) {
    throw new Error("Bun.build produced no outputs");
  }
  // Concatenate all JS outputs (there is exactly one with splitting off).
  const parts = await Promise.all(result.outputs.map((o) => o.text()));
  return parts.join("\n");
}

/**
 * A tiny inert fallback emitted when the build fails. It logs to the
 * console so a developer notices, but does nothing else — the viewer
 * stays usable read-only. The message is JSON-encoded to neutralise any
 * `</script>` / quote injection from the build-error text.
 */
function buildFallbackScript(message: string): string {
  return `console.error(${JSON.stringify(
    "task-view: edit hydration unavailable — client bundle failed to build: " +
      message,
  )});`;
}

/**
 * Test-only: reset the in-process cache so a test can force a rebuild.
 * NOT used by the server runtime.
 */
export function _resetClientBundleCacheForTests(): void {
  cachedBundle = null;
  buildInFlight = null;
}
