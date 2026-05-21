/**
 * task-view CLI server entrypoint (placeholder).
 *
 * The runtime behaviour — schema detection, ledger routing, record-level
 * path resolution, CWD inference, mirror generation, and the patch
 * server — is implemented in subsequent ID-20 Subtasks:
 *
 *   - ID-20.7: schema detection (`detectSchema`), path/CWD resolution,
 *              mirror generator (§2.1, §2.2, §2.3, §3.1-§3.4).
 *   - ID-20.8: patch server endpoints (GET `/api/ledger`, PATCH
 *              `/api/ledger/record/:recordId`), atomic write, mtime
 *              collision detection, multi-field save, loopback bind
 *              (§5.1-§5.8).
 *   - ID-20.11: CLI flag parsing (`parseArgs`), `--no-browser`,
 *               `--port`, `--check`; plugin manifest; browser-close
 *               detection; port retry (§6.1-§6.7).
 *
 * This placeholder exists so the workspace structure is valid for
 * Subtask 20.6's fork-prep acceptance — it intentionally has no
 * runtime side effects.
 */

if (typeof Bun === 'undefined') {
  console.error('task-view requires the Bun runtime to launch its CLI server.');
  process.exit(1);
}

console.error(
  'task-view CLI scaffolding present; runtime behaviour ships in ID-20.7 / 20.8 / 20.11.'
);
process.exit(0);
