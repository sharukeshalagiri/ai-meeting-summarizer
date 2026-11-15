import { env } from "../lib/env";
import { Queues } from "./definitions";
import * as pipeline from "./pipeline";
import type { JobHandler, JobQueue } from "./queue";

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
  }
};
