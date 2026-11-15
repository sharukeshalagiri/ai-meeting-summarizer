import { env } from "../lib/env";
import { Queues } from "./definitions";
import * as live from "./live";
import * as pipeline from "./pipeline";
import type { JobHandler, JobQueue } from "./queue";

/** live-reap schedule. */
export const LIVE_REAP_CRON = "*/5 * * * *";

/**
 * Binds every queue to its handler. Called once per process by
 * jobs/index.ts after the queue has started.
 */
export const registerWorkers = async (
  queue: JobQueue,
  options: { schedules: boolean }
): Promise<void> => {
  const handlers: [string, JobHandler<never>][] = [
    [Queues.TRANSCRIBE, pipeline.transcribe],
    [Queues.DIARIZE, pipeline.diarize],
    [Queues.CLEAN, pipeline.clean],
    [Queues.SUMMARIZE, pipeline.summarize],
    [Queues.INDEX, pipeline.index],
    [Queues.LIVE_ASSEMBLE, live.assemble],
    [Queues.LIVE_LATE, live.late],
    [Queues.LIVE_REAP, live.reap],
  ];

  for (const [name, handler] of handlers) {
    await queue.work(name, handler as JobHandler<unknown>);
  }

  // w4-acct: audio retention, a recurring job.
  await queue.work(Queues.AUDIO_RETENTION, async () => {
    const { sweepAudio } = await import("../services/retention/retention.service");
    await sweepAudio();
  });

  // Recurring jobs are registered by the server only (schedules: true),
  // never by tests that start the in-process queue on demand.
  if (options.schedules) {
    // The in-process queue only understands "*/N * * * *".
    const cron = queue.driver === "memory" ? "*/60 * * * *" : env.retentionCron;
    await queue.schedule(Queues.AUDIO_RETENTION, cron);

    // Ends live sessions whose recorder went away without /end. Every 5
    // minutes on both drivers (pg-boss runs it once per tick
    // cluster-wide); replaces the setInterval server.ts used to run.
    await queue.schedule(Queues.LIVE_REAP, LIVE_REAP_CRON);
  }
};
