#!/usr/bin/env node
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(path.dirname(__filename), "..");
const sourceEntry = path.join(repoRoot, "apps", "server", "index.ts");

if (!fs.existsSync(sourceEntry)) {
  console.error(`Could not find task-view source entry at ${sourceEntry}`);
  process.exit(1);
}

// Launch the Bun server as an ASYNC child (not spawnSync). A synchronous
// spawn blocks the event loop, so this shim could never run a signal handler
// while the server is up — a SIGTERM/SIGINT to the shim (or the shim simply
// exiting) would kill the shim and leave the `bun index.ts` server reparented
// to PID 1, lingering forever (foreground mode has no idle-exit). With an
// async child we forward terminating signals and guarantee the server dies
// with the shim.
const child = childProcess.spawn("bun", [sourceEntry, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: "inherit",
});

let killed = false;
function killChild(signal) {
  if (killed) return;
  killed = true;
  try {
    child.kill(signal);
  } catch {
    // Child already gone — nothing to signal.
  }
}

// Forward terminating signals so the user's Ctrl-C, or a parent's SIGTERM,
// tears the server down instead of orphaning it. Registering these handlers
// also overrides Node's default "exit immediately" disposition, so the shim
// stays alive until the child has actually exited (mirrored below).
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => killChild(signal));
}
// Backstop: whatever else makes the shim exit, take the child with it.
process.on("exit", () => killChild("SIGTERM"));

child.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});

// Mirror the child's exit status. A child terminated by a signal (rather than
// a clean exit code) surfaces as a non-zero exit.
child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : typeof code === "number" ? code : 0);
});
