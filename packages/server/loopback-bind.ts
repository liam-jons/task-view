/**
 * loopback-bind.ts — TECH §5.8 loopback-only enforcement.
 *
 * PRODUCT inv 44: the server listens only on `127.0.0.1` (loopback).
 * No remote access path exists. Authentication is intentionally absent —
 * security model is "trusted local machine" because the tool ships as
 * a developer tool.
 *
 * The upstream remote.ts `getServerHostname()` returns `0.0.0.0` when an
 * SSH session is detected (Plannotator's remote-access affordance).
 * That branch is now dead code per inv 44 — the patch server MUST bind
 * loopback regardless of session kind. This module provides:
 *
 *   - `LOOPBACK_HOSTNAME` — the constant '127.0.0.1' value.
 *   - `resolveServerHostname(requested?)` — collapses any requested bind
 *     to LOOPBACK_HOSTNAME, with a thrown error if the caller explicitly
 *     passed a non-loopback hostname (security-relevant; never silently
 *     downgrade — surface the misuse).
 *   - `isLoopbackHostname(hostname)` — predicate for tests + audits.
 *
 * Why "throw on explicit non-loopback" instead of "silently rewrite":
 * Silent rewrite would let a caller think they got a remote bind. A
 * thrown error makes the security guarantee auditable by tooling.
 *
 * This module does NOT call Bun.serve itself; callers (the patch server
 * factory in ID-20.8d) call `Bun.serve({ port, hostname: LOOPBACK_HOSTNAME })`
 * directly. The hardening lives here so unit tests can verify the rule
 * without spinning a real server.
 */

/** The canonical loopback bind. Sole value the patch server may bind to. */
export const LOOPBACK_HOSTNAME = "127.0.0.1" as const;

/** IPv6 loopback alternate spelling. Accepted as a loopback variant. */
export const LOOPBACK_HOSTNAME_IPV6 = "::1" as const;

/**
 * Predicate: is the given hostname a loopback address?
 *
 * Accepts the four canonical loopback spellings:
 *   - `127.0.0.1` (IPv4 loopback — what we use)
 *   - `::1` (IPv6 loopback — sometimes set by Bun on dual-stack hosts)
 *   - `localhost` (host alias; resolves to one of the above on every
 *     UNIX system task-view runs on)
 *   - `127.x.y.z` for any x, y, z in 0-255 (IPv4 loopback range per
 *     RFC 5735 §3 — the whole 127.0.0.0/8 block is loopback).
 *
 * Anything else is non-loopback. We are conservative: an unrecognised
 * spelling is treated as non-loopback even if it might resolve to one
 * (e.g. a custom /etc/hosts entry). The patch server caller should
 * always pass the canonical `LOOPBACK_HOSTNAME` value to avoid edge
 * cases.
 */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === LOOPBACK_HOSTNAME) return true;
  if (hostname === LOOPBACK_HOSTNAME_IPV6) return true;
  if (hostname === "localhost") return true;
  // 127.0.0.0/8 loopback range (RFC 5735 §3)
  if (/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(hostname)) {
    const octets = hostname.split(".").map(Number);
    if (octets.every((o) => o >= 0 && o <= 255)) return true;
  }
  return false;
}

/**
 * Resolve a (possibly user-supplied) hostname into a safe loopback bind.
 *
 * - When no hostname is supplied: returns LOOPBACK_HOSTNAME.
 * - When a loopback hostname is supplied: returns LOOPBACK_HOSTNAME
 *   (canonicalises localhost / 127.x.x.x / ::1 to the canonical
 *   127.0.0.1 spelling for a single deterministic bind string).
 * - When a non-loopback hostname is supplied: THROWS — this is a
 *   security-relevant misuse and silent rewrite would mask the bug.
 *   PRODUCT inv 44 + TECH §5.8 are non-negotiable.
 *
 * @param requested - optional caller-supplied hostname.
 * @returns canonical LOOPBACK_HOSTNAME string for Bun.serve.
 * @throws Error when `requested` is supplied AND is not a loopback variant.
 */
export function resolveServerHostname(requested?: string): typeof LOOPBACK_HOSTNAME {
  if (requested === undefined || requested === "") return LOOPBACK_HOSTNAME;
  if (isLoopbackHostname(requested)) return LOOPBACK_HOSTNAME;
  throw new Error(
    `task-view server may only bind to the loopback interface (127.0.0.1). ` +
      `Requested hostname "${requested}" is non-loopback and rejected per ` +
      `PRODUCT inv 44 / TECH §5.8.`,
  );
}
