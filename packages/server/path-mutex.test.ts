/**
 * Tests for path-mutex — ID-90 U9 per-canonical-path mutation mutex.
 *
 * PRODUCT invariant 38 (mutex half) + 46: within ONE daemon process, every
 * mutating handler body runs under the per-canonical-path promise-queue, so
 * the mtime-check-to-rename TOCTOU window can never interleave two writers
 * on the same canonical file. Multi-path acquisition (the promote
 * transaction's two/three legs) takes its locks in FIXED lexicographic
 * order of the resolved paths — deadlock-free by construction.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  withPathLock,
  withPathLocks,
  pendingPathLockCount,
} from "./path-mutex";

/** A deferred the test resolves manually to hold a critical section open. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let queued microtasks drain so lock grants become observable. */
async function drainMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

describe("withPathLock — single-path serialisation", () => {
  test("two critical sections on the SAME path run strictly in order", async () => {
    const events: string[] = [];
    const gate = deferred();

    const first = withPathLock("/tmp/u9-mutex/a.json", async () => {
      events.push("first-start");
      await gate.promise;
      events.push("first-end");
      return "first";
    });
    const second = withPathLock("/tmp/u9-mutex/a.json", async () => {
      events.push("second-start");
      return "second";
    });

    await drainMicrotasks();
    // The second writer WAITS — it must not start while the first holds.
    expect(events).toEqual(["first-start"]);

    gate.resolve();
    expect(await first).toBe("first");
    expect(await second).toBe("second");
    expect(events).toEqual([
      "first-start",
      "first-end",
      "second-start",
    ]);
  });

  test("critical sections on DIFFERENT paths run concurrently", async () => {
    const events: string[] = [];
    const gate = deferred();

    const a = withPathLock("/tmp/u9-mutex/a.json", async () => {
      events.push("a-start");
      await gate.promise;
      events.push("a-end");
    });
    const b = withPathLock("/tmp/u9-mutex/b.json", async () => {
      events.push("b-start");
    });

    await drainMicrotasks();
    // b is NOT serialised behind a — different canonical paths.
    expect(events).toContain("b-start");
    expect(events).not.toContain("a-end");

    gate.resolve();
    await Promise.all([a, b]);
  });

  test("a rejection propagates to the caller and does NOT poison the queue", async () => {
    const path = "/tmp/u9-mutex/reject.json";
    const failing = withPathLock(path, async () => {
      throw new Error("handler exploded");
    });
    await expect(failing).rejects.toThrow("handler exploded");

    // The NEXT acquisition on the same path still runs.
    const next = await withPathLock(path, async () => "recovered");
    expect(next).toBe("recovered");
  });

  test("path spellings normalise to ONE lock (resolve())", async () => {
    const events: string[] = [];
    const gate = deferred();
    const abs = join(process.cwd(), "u9-ledger.json");

    const viaAbsolute = withPathLock(abs, async () => {
      events.push("abs-start");
      await gate.promise;
    });
    const viaRelative = withPathLock("u9-ledger.json", async () => {
      events.push("rel-start");
    });

    await drainMicrotasks();
    // Same canonical file → the relative spelling queues behind the
    // absolute one.
    expect(events).toEqual(["abs-start"]);

    gate.resolve();
    await Promise.all([viaAbsolute, viaRelative]);
    expect(events).toEqual(["abs-start", "rel-start"]);
  });

  test("the internal queue map drains once all sections settle", async () => {
    await withPathLock("/tmp/u9-mutex/drain.json", async () => "x");
    await drainMicrotasks();
    expect(pendingPathLockCount()).toBe(0);
  });
});

describe("withPathLocks — multi-path lexicographic acquisition (transaction)", () => {
  test("acquires in lexicographic order of resolved paths, NOT argument order", async () => {
    const events: string[] = [];
    const holdB = deferred();
    const pathA = "/tmp/u9-mutex/tx/a-task-list.json";
    const pathB = "/tmp/u9-mutex/tx/b-backlog.json";

    // Hold B so a transaction passed [B, A] must demonstrate it takes A
    // FIRST (sorted) while waiting on B.
    const bHolder = withPathLock(pathB, async () => {
      await holdB.promise;
    });

    const txDone = deferred();
    const tx = withPathLocks([pathB, pathA], async () => {
      events.push("tx-start");
      await txDone.promise;
    });

    await drainMicrotasks();
    expect(events).toEqual([]); // tx waits on B…

    // …but it has ALREADY taken A (lexicographically first): a probe on A
    // queues behind the transaction rather than running immediately.
    const probe = withPathLock(pathA, async () => {
      events.push("probe-a");
    });
    await drainMicrotasks();
    expect(events).toEqual([]);

    holdB.resolve();
    await drainMicrotasks();
    expect(events).toEqual(["tx-start"]);

    txDone.resolve();
    await Promise.all([bHolder, tx, probe]);
    expect(events).toEqual(["tx-start", "probe-a"]);
  });

  test("overlapping multi-path transactions never deadlock (reversed argument orders)", async () => {
    const paths = [
      "/tmp/u9-mutex/dl/task-list.json",
      "/tmp/u9-mutex/dl/product-backlog.json",
      "/tmp/u9-mutex/dl/initiatives.json",
    ];
    const completed: number[] = [];
    const txs = Array.from({ length: 12 }, (_, i) =>
      withPathLocks(i % 2 === 0 ? paths : [...paths].reverse(), async () => {
        // Yield inside the critical section to give a would-be deadlock
        // every chance to bite.
        await Promise.resolve();
        completed.push(i);
      }),
    );
    await Promise.all(txs);
    expect(completed).toHaveLength(12);
  });

  test("duplicate paths are de-duplicated (no self-deadlock)", async () => {
    const result = await withPathLocks(
      ["/tmp/u9-mutex/dup.json", "/tmp/u9-mutex/dup.json"],
      async () => "ran",
    );
    expect(result).toBe("ran");
  });

  test("a single-path lock serialises against an overlapping transaction", async () => {
    const events: string[] = [];
    const gate = deferred();
    // The shared path sorts FIRST so the transaction registers on it
    // synchronously at call time — making the queue order deterministic
    // for the assertion. (When the shared path sorts later, the
    // single-path lock may validly run first; what the mutex guarantees
    // is NO OVERLAP, not a global submission order.)
    const taskList = "/tmp/u9-mutex/mix/a-task-list.json";
    const backlog = "/tmp/u9-mutex/mix/b-backlog.json";

    const tx = withPathLocks([taskList, backlog], async () => {
      events.push("tx-start");
      await gate.promise;
      events.push("tx-end");
    });
    const patch = withPathLock(taskList, async () => {
      events.push("patch");
    });

    await drainMicrotasks();
    expect(events).toEqual(["tx-start"]);

    gate.resolve();
    await Promise.all([tx, patch]);
    expect(events).toEqual(["tx-start", "tx-end", "patch"]);
  });
});
