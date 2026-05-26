/**
 * task-view CLI helpers (placeholder).
 *
 * The full CLI surface — positional path argument, `--no-browser`,
 * `--port <N>`, `--check`, CWD inference scan, port retry, browser-close
 * detection — is implemented in ID-20.11 (§6.1-§6.7). For Subtask 20.6
 * (fork prep) this file retains only the version-formatting helper and
 * the help/version invocation detectors, all rewritten for task-view's
 * own flag set.
 */

// The canonical tool version is the ROOT package.json `version` field
// (`0.2.0`). The bin shim (`bin/task-view.js`) runs `bun apps/server/
// index.ts` directly from source with NO bundler step, so there is no
// `define` to bake a `__CLI_VERSION__` constant — Bun's native JSON
// import is the reliable source. `../../package.json` from this file
// (`apps/server/cli.ts`) resolves to the repo-root package.json, not a
// per-package one.
import rootPkg from "../../package.json";

export function isTopLevelHelpInvocation(args: string[]): boolean {
  return args[0] === "--help";
}

export function isVersionInvocation(args: string[]): boolean {
  return args[0] === "--version" || args[0] === "-v";
}

export function formatVersion(): string {
  return `task-view ${rootPkg.version}`;
}

export function formatTopLevelHelp(): string {
  return [
    "Usage:",
    "  task-view [<path-to-ledger.json | path-to-mirror.md>] [--no-browser] [--port <N>] [--check]",
    "  task-view --help",
    "  task-view --version, -v",
    "",
    "Without a path argument, task-view scans the current working directory",
    "for `document_name`-bearing JSON files (task-list.json, product-roadmap.json,",
    "product-backlog.json).",
    "",
    "Note: full CLI flag handling lands in ID-20.11.",
  ].join("\n");
}
