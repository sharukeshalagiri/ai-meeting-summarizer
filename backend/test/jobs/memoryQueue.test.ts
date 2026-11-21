import { describe, expect, it } from "vitest";
import { MemoryQueue, MemoryStore } from "../../src/jobs/memoryQueue";
import { retryDelayMs, type QueueDefinition } from "../../src/jobs/queue";

/**
 * The in-process queue follows pg-boss's "stately" semantics, so the
 * pipeline behaves the same in tests as in production. Two queues on one
 * MemoryStore stand in for two processes on one database.
 */

const definition = (overrides: Partial<QueueDefinition> = {}): QueueDefinition => ({
  name: "work",
  retryLimit: 2,
  retryDelaySeconds: 10,
  retryBackoff: true,
  expireInSeconds: 60,
  ...overrides,
});

/** A manual clock: jobs only run when the test calls runDue/drain. */
const manual = (store = new MemoryStore()) => {
  const clock = { now: 1_000_000 };
  const queue = new MemoryQueue({ store, now: () => clock.now, autoRun: false });
  return { queue, clock, store };
};

describe("MemoryQueue", () => {
  it("drops a second send for the same key while one is waiting, but not while one runs", async () => {
    const { queue } = manual();
    await queue.createQueue(definition());

    const first = await queue.send("work", { n: 1 }, { singletonKey: "m1" });
    expect(await queue.send("work", { n: 2 }, { singletonKey: "m1" })).toBeNull();
    expect(await queue.send("work", { n: 3 }, { singletonKey: "m2" })).not.toBeNull();

    let release!: () => void;
    const seen: number[] = [];
    await queue.work<{ n: number }>("work", async (job) => {
      seen.push(job.data.n);
      if (job.data.n === 1) await new Promise<void>((resolve) => (release = resolve));
    });

    queue.runDue();
    expect(queue.job(first!)?.state).toBe("active");

    // One may wait behind the running one (it would pick up newer data).
    const queued = await queue.send("work", { n: 4 }, { singletonKey: "m1" });
    expect(queued).not.toBeNull();
    // ...but it does not run alongside it.
    queue.runDue();
    expect(queue.job(queued!)?.state).toBe("created");

    release();
    await queue.drain();
    expect(seen).toEqual([1, 3, 4]);
  });

  it("retries a failing job with exponential backoff, then fails it", async () => {
    const { queue, clock } = manual();
    await queue.createQueue(definition());

    let attempts = 0;
    await queue.work("work", async () => {
      attempts++;
      throw new Error("still down");
    });

    const id = (await queue.send("work", {}))!;
    await queue.drain();
    expect(attempts).toBe(1);
    expect(queue.job(id)).toMatchObject({ state: "retry", retryCount: 1 });

    // First retry after 10 s, the second after 20 s more.
    clock.now += retryDelayMs(definition(), 0) - 1;
    await queue.drain();
    expect(attempts).toBe(1);
    clock.now += 1;
    await queue.drain();
    expect(attempts).toBe(2);

    clock.now += retryDelayMs(definition(), 1);
    await queue.drain();
    expect(attempts).toBe(3);
    expect(queue.job(id)?.state).toBe("failed");
    expect(await queue.whenSettled(id)).toBe("failed");
  });

  it("a killed worker's job is picked up by a new worker once it expires", async () => {
    const store = new MemoryStore();
    const clock = { now: 5_000_000 };
    const now = () => clock.now;

    // Process A starts the job and dies mid-way (handler never finishes).
    const a = new MemoryQueue({ store, now, autoRun: false });
    await a.createQueue(definition({ expireInSeconds: 60 }));
    const runs: string[] = [];
    await a.work("work", async () => {
      runs.push("a");
      await new Promise(() => undefined);
    });
    const id = (await a.send("work", { meetingId: "m1" }, { singletonKey: "m1" }))!;
    a.runDue();
    expect(store.jobs[0].state).toBe("active");
    await a.stop();

    // Process B boots with the same handlers on the same database.
    const b = new MemoryQueue({ store, now, autoRun: false });
    await b.work<{ meetingId: string }>("work", async (job) => {
      runs.push(`b:${job.data.meetingId}:${job.retryCount}`);
    });

    // Not expired yet: B leaves it alone (A might still be alive).
    clock.now += 59_000;
    await b.drain();
    expect(runs).toEqual(["a"]);

    // Expired: counted as a failed attempt, retried after the backoff.
    clock.now += 1_000;
    await b.drain();
    clock.now += retryDelayMs(definition(), 0);
    await b.drain();

    expect(runs).toEqual(["a", "b:m1:1"]);
    expect(b.job(id)?.state).toBe("completed");
  });

  it("a delayed job survives a restart and runs when due", async () => {
    const store = new MemoryStore();
    const clock = { now: 0 };
    const now = () => clock.now;

    const before = new MemoryQueue({ store, now, autoRun: false });
    await before.createQueue(definition({ name: "late" }));
    await before.send("late", { sessionId: "s1" }, { singletonKey: "s1", startAfterSeconds: 120 });
    await before.stop();

    const after = new MemoryQueue({ store, now, autoRun: false });
    const ran: string[] = [];
    await after.work<{ sessionId: string }>("late", async (job) => {
      ran.push(job.data.sessionId);
    });

    clock.now += 119_000;
    await after.drain();
    expect(ran).toEqual([]);

    clock.now += 1_000;
    await after.drain();
    expect(ran).toEqual(["s1"]);
  });

  it("reports pending jobs by key", async () => {
    const { queue } = manual();
    await queue.createQueue(definition());
    await queue.send("work", {}, { singletonKey: "m1" });

    expect(await queue.pending("work", "m1")).toHaveLength(1);
    expect(await queue.pending("work", "m2")).toHaveLength(0);
  });
});
