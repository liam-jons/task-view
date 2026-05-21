/**
 * Tests for loopback-bind — TECH §5.8 loopback-only enforcement.
 *
 * Acceptance gate (per ID-20.8 PLAN):
 *   "tests/unit/loopback-bind.test.ts asserts bind to 127.0.0.1
 *    (remote bind fails)."
 *
 * The assertion has two halves:
 *   1. Default + canonical inputs resolve to 127.0.0.1.
 *   2. Non-loopback hostnames are REJECTED at resolve time (a thrown
 *      error). Silent rewrite would mask the security misuse.
 *
 * Loopback variants accepted (canonicalised): localhost, ::1, 127.x.y.z.
 * Non-loopback REJECTED: 0.0.0.0, public IPs, custom DNS names.
 */
import { describe, expect, test } from "bun:test";
import {
  LOOPBACK_HOSTNAME,
  isLoopbackHostname,
  resolveServerHostname,
} from "./loopback-bind";

describe("LOOPBACK_HOSTNAME constant", () => {
  test("is exactly the canonical 127.0.0.1 string", () => {
    expect(LOOPBACK_HOSTNAME).toBe("127.0.0.1");
  });
});

describe("isLoopbackHostname — predicate", () => {
  test("recognises canonical 127.0.0.1", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
  });

  test("recognises IPv6 ::1", () => {
    expect(isLoopbackHostname("::1")).toBe(true);
  });

  test("recognises 'localhost' alias", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
  });

  test("recognises other addresses in 127.0.0.0/8 range", () => {
    expect(isLoopbackHostname("127.0.0.2")).toBe(true);
    expect(isLoopbackHostname("127.255.255.254")).toBe(true);
    expect(isLoopbackHostname("127.1.2.3")).toBe(true);
  });

  test("rejects the unspecified-bind 0.0.0.0", () => {
    expect(isLoopbackHostname("0.0.0.0")).toBe(false);
  });

  test("rejects public IPs", () => {
    expect(isLoopbackHostname("8.8.8.8")).toBe(false);
    expect(isLoopbackHostname("192.168.1.1")).toBe(false);
    expect(isLoopbackHostname("10.0.0.1")).toBe(false);
  });

  test("rejects custom DNS names that might /etc/hosts-resolve to loopback", () => {
    // Conservative: we accept only canonical spellings. A user with an
    // /etc/hosts entry for `mybox` pointing at 127.0.0.1 would still see
    // this rejected; they should pass 'localhost' instead.
    expect(isLoopbackHostname("mybox")).toBe(false);
    expect(isLoopbackHostname("my.tunnel.dev")).toBe(false);
  });

  test("rejects malformed 127.x addresses (out-of-range octets)", () => {
    expect(isLoopbackHostname("127.0.0.300")).toBe(false);
    expect(isLoopbackHostname("127.x.0.1")).toBe(false);
  });
});

describe("resolveServerHostname — security gate", () => {
  test("returns 127.0.0.1 when no hostname is supplied", () => {
    expect(resolveServerHostname()).toBe(LOOPBACK_HOSTNAME);
  });

  test("returns 127.0.0.1 when empty string is supplied", () => {
    expect(resolveServerHostname("")).toBe(LOOPBACK_HOSTNAME);
  });

  test("canonicalises localhost to 127.0.0.1", () => {
    expect(resolveServerHostname("localhost")).toBe(LOOPBACK_HOSTNAME);
  });

  test("canonicalises ::1 to 127.0.0.1", () => {
    expect(resolveServerHostname("::1")).toBe(LOOPBACK_HOSTNAME);
  });

  test("canonicalises 127.x.x.x variants to 127.0.0.1", () => {
    expect(resolveServerHostname("127.0.0.2")).toBe(LOOPBACK_HOSTNAME);
    expect(resolveServerHostname("127.1.2.3")).toBe(LOOPBACK_HOSTNAME);
  });

  test("THROWS when a non-loopback hostname like 0.0.0.0 is supplied", () => {
    // 0.0.0.0 binds to ALL interfaces — the exact misuse PRODUCT inv 44
    // forbids. The error message must mention the rejected hostname so
    // operators can trace the misuse.
    expect(() => resolveServerHostname("0.0.0.0")).toThrow(/0\.0\.0\.0/);
    expect(() => resolveServerHostname("0.0.0.0")).toThrow(/loopback/i);
  });

  test("THROWS when a public IP is supplied", () => {
    expect(() => resolveServerHostname("8.8.8.8")).toThrow(/8\.8\.8\.8/);
  });

  test("THROWS when a private-network IP outside 127/8 is supplied", () => {
    expect(() => resolveServerHostname("192.168.1.50")).toThrow();
    expect(() => resolveServerHostname("10.0.0.1")).toThrow();
    expect(() => resolveServerHostname("172.16.1.1")).toThrow();
  });

  test("error message references PRODUCT inv 44 / TECH §5.8 so operators can find the rule", () => {
    try {
      resolveServerHostname("0.0.0.0");
      throw new Error("expected throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("inv 44");
      expect(msg).toContain("§5.8");
    }
  });
});

describe("Bun.serve integration — loopback-only bind smoke test", () => {
  test("Bun.serve with hostname: LOOPBACK_HOSTNAME actually binds and serves", async () => {
    // This is the behavioural assertion that closes the loop: the value
    // we hand to Bun.serve does in fact start a server. We can also
    // observe that the requested hostname stays loopback after Bun
    // resolves it.
    const server = Bun.serve({
      port: 0, // OS-assigned port
      hostname: LOOPBACK_HOSTNAME,
      fetch() {
        return new Response("ok");
      },
    });
    try {
      expect(server.hostname).toBe(LOOPBACK_HOSTNAME);
      expect(server.port).toBeGreaterThan(0);

      // Sanity-fetch confirms the server is reachable on loopback.
      const res = await fetch(`http://${server.hostname}:${server.port}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    } finally {
      server.stop(true);
    }
  });
});
