/**
 * shutdown-events.test.ts — the SSE close-tab-on-exit channel
 * (docs/specs/qol-improvements/PLAN.md Task 7). A real loopback server is
 * started; we assert GET /api/shutdown-events streams text/event-stream, that
 * `broadcastShutdown()` pushes a `shutdown` event then closes the stream, and
 * that `handle.stop()` closes open subscriber streams.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { broadcastShutdown, startPatchServer } from "./patch-server";

const LEDGER = join(
  process.cwd(),
  "tests/fixtures/live-ledgers/task-list.json",
);

let stopFns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stopFns.splice(0)) {
    try {
      await stop();
    } catch {
      /* already stopped */
    }
  }
});

function start() {
  const handle = startPatchServer({ ledgerPath: LEDGER, hostname: "127.0.0.1" });
  stopFns.push(() => handle.stop());
  return handle;
}

describe("shutdown SSE channel (close-tab-on-exit)", () => {
  test("GET /api/shutdown-events streams text/event-stream and emits `shutdown` on broadcast", async () => {
    const handle = start();
    const res = await fetch(`${handle.url}/api/shutdown-events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain("connected");

    // A broadcast pushes a `shutdown` event then closes the stream.
    broadcastShutdown();
    const second = await reader.read();
    expect(decoder.decode(second.value ?? new Uint8Array())).toContain(
      "event: shutdown",
    );
    const third = await reader.read();
    expect(third.done).toBe(true);
  });

  test("handle.stop() closes open subscriber streams (Ctrl-C tells the tab)", async () => {
    const handle = start();
    const res = await fetch(`${handle.url}/api/shutdown-events`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // ": connected"

    await handle.stop(); // broadcasts shutdown, then stops the server

    // The stream must end (either after delivering the shutdown event or via
    // the connection closing) within a few reads.
    let ended = false;
    let sawShutdown = false;
    for (let i = 0; i < 4; i += 1) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        ended = true; // connection reset counts as ended
        break;
      }
      if (chunk.value && decoder.decode(chunk.value).includes("shutdown")) {
        sawShutdown = true;
      }
      if (chunk.done) {
        ended = true;
        break;
      }
    }
    expect(ended || sawShutdown).toBe(true);
  });
});
