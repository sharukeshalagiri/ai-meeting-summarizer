import { describe, expect, it, vi } from "vitest";

/** The stale-session reaper is a scheduled job now, not a setInterval. */

const reaped = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../../src/services/live.service", () => ({
  reapStaleSessions: async () => {
    reaped.calls++;
    return 1;
  },
  lateFinalPass: async () => "skipped",
}));

import { Queues } from "../../src/jobs/definitions";
import type { JobHandler, JobQueue } from "../../src/jobs/queue";
import { LIVE_REAP_CRON, registerWorkers } from "../../src/jobs/worker";

const fakeQueue = () => {
  const handlers = new Map<string, JobHandler<unknown>>();
  const schedules: [string, string][] = [];
  const queue = {
    driver: "pgboss",
    work: async (name: string, handler: JobHandler<unknown>) => {
      handlers.set(name, handler);
    },
    schedule: async (name: string, cron: string) => {
      schedules.push([name, cron]);
    },
  } as unknown as JobQueue;
  return { queue, handlers, schedules };
};

describe("live-reap", () => {
  it("is scheduled every 5 minutes and its handler ends stale sessions", async () => {
    const { queue, handlers, schedules } = fakeQueue();
    await registerWorkers(queue, { schedules: true });

    expect(schedules).toContainEqual([Queues.LIVE_REAP, LIVE_REAP_CRON]);
    expect(LIVE_REAP_CRON).toBe("*/5 * * * *");
    expect([...handlers.keys()]).toEqual(
      expect.arrayContaining([Queues.LIVE_ASSEMBLE, Queues.LIVE_LATE, Queues.LIVE_REAP])
    );

    await handlers.get(Queues.LIVE_REAP)!({
      id: "j",
      name: Queues.LIVE_REAP,
      data: {},
      retryCount: 0,
      retryLimit: 0,
    });
    expect(reaped.calls).toBe(1);
  });

  it("tests (schedules: false) register no recurring job", async () => {
    const { queue, schedules } = fakeQueue();
    await registerWorkers(queue, { schedules: false });
    expect(schedules).toEqual([]);
  });
});
