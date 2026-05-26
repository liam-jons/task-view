/**
 * record-view/hljs.ts — highlight.js re-export shim (OQ-1).
 *
 * Two runner contexts must resolve `highlight.js`, which is reachable ONLY
 * under packages/ui/node_modules (Bun's isolated install layout; no root
 * hoist):
 *   1. `bun test` loads the client dispatcher directly via `import()`. The
 *      dispatcher imports THIS shim by relative path; the shim's own
 *      `import "highlight.js"` resolves because the shim lives inside
 *      packages/ui.
 *   2. `Bun.build` (client-bundle.ts) bundles the dispatcher at boot — its
 *      onResolve plugin anchors `highlight.js` resolution at packages/ui.
 * The shim makes (1) work; the plugin makes (2) work. Together they keep the
 * highlight pass resolvable everywhere.
 */
import hljs from "highlight.js";
export default hljs;
