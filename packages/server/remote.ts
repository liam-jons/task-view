/**
 * Remote session detection and port configuration.
 *
 * Environment variables:
 *   TASK_VIEW_REMOTE - Set to "1"/"true" to force remote, "0"/"false" to
 *                       force local. NOTE: per PRODUCT inv 44 task-view binds
 *                       loopback-only; this env-var is preserved from upstream
 *                       Plannotator for compatibility but has no effect on
 *                       task-view's server bind once ID-20.8 wires the
 *                       loopback-only enforcement.
 *   TASK_VIEW_PORT   - Fixed port to use (default: random locally, 19432
 *                       for remote — same behaviour as upstream).
 *
 * Legacy (still supported): SSH_TTY, SSH_CONNECTION.
 */

const DEFAULT_REMOTE_PORT = 19432;
const LOOPBACK_HOST = "127.0.0.1";

function getRemoteOverride(): boolean | null {
  const remote = process.env.TASK_VIEW_REMOTE;
  if (remote === undefined) {
    return null;
  }

  if (remote === "1" || remote?.toLowerCase() === "true") {
    return true;
  }

  if (remote === "0" || remote?.toLowerCase() === "false") {
    return false;
  }

  return null;
}

/**
 * Check if running in a remote session (SSH, devcontainer, etc.)
 *
 * task-view ships with loopback-only bind (PRODUCT inv 44 / TECH §5.8) so
 * the remote-vs-local distinction is informational only — the server
 * always binds to 127.0.0.1 in ID-20.8.
 */
export function isRemoteSession(): boolean {
  const remoteOverride = getRemoteOverride();
  if (remoteOverride !== null) {
    return remoteOverride;
  }

  // Legacy: SSH_TTY/SSH_CONNECTION (deprecated, silent)
  if (process.env.SSH_TTY || process.env.SSH_CONNECTION) {
    return true;
  }

  return false;
}

/**
 * Get the server port to use.
 *
 * Returns 0 (random) by default — the actual port retry policy is
 * implemented in ID-20.11 §6.6 (5 retries before "could not bind").
 */
export function getServerPort(): number {
  // Explicit port from environment takes precedence
  const envPort = process.env.TASK_VIEW_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed >= 0 && parsed < 65536) {
      return parsed;
    }
    console.error(
      `[task-view] Warning: Invalid TASK_VIEW_PORT "${envPort}", using default`
    );
  }

  // Remote sessions historically used fixed port for port forwarding; local
  // uses random. ID-20.8 enforces loopback-only, so the remote branch is
  // preserved as no-op alignment with upstream.
  return isRemoteSession() ? DEFAULT_REMOTE_PORT : 0;
}

/**
 * Bind hostname. PRODUCT inv 44 + TECH §5.8 mandates 127.0.0.1; the
 * upstream remote branch is preserved for compatibility but ID-20.8
 * collapses the bind to always-loopback regardless of session kind.
 */
export function getServerHostname(): string {
  return isRemoteSession() ? "0.0.0.0" : LOOPBACK_HOST;
}
