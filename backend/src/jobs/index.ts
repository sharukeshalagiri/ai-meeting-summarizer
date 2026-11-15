import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { AppError } from "../types/errors";
import { PIPELINE_QUEUES, QUEUE_DEFINITIONS, Queues, type QueueName } from "./definitions";
import { MemoryQueue } from "./memoryQueue";
import {
  FINAL_STATES,
  type JobQueue,
  type JobState,
  type SendOptions,
} from "./queue";

const log = logger.child({ module: "jobs" });

/**
 * The job system's entry points.
 *
 * - server.ts calls startJobs() at boot and stopJobs() on shutdown.
 * - Services call enqueue() (and the helpers below); they never see
 *   pg-boss.
 * - With the memory driver (tests, JOBS_DRIVER=memory) the queue starts
 *   lazily on first use, so route tests need no setup.
 *
 * Handlers are registered from ./worker, imported dynamically: the
 * handlers import the services, and the services import this module.
 */

let queue: JobQueue | null = null;
let starting: Promise<JobQueue> | null = null;

const createQueue = async (): Promise<JobQueue> => {
  if (env.jobsDriver === "memory") return new MemoryQueue();

  const { PgBossQueue } = await import("./pgBossQueue");
  return new PgBossQueue(env.databaseUrl);
};

const boot = async (options: { schedules: boolean }): Promise<JobQueue> => {
  const instance = await createQueue();
  await instance.start();

  for (const definition of QUEUE_DEFINITIONS) {
    await instance.createQueue(definition);
  }

  const { registerWorkers } = await import("./worker");
  await registerWorkers(instance, options);

  log.info("Job queue started", { driver: instance.driver });

  return instance;
};

/** Starts the queue, its workers and the recurring jobs (server.ts). */
export const startJobs = async (): Promise<JobQueue> => {
  if (queue) return queue;

  starting ??= boot({ schedules: true })
    .then((instance) => {
      queue = instance;
      return instance;
    })
    .catch((error) => {
      starting = null;
      throw error;
    });

  return starting;
};

export const stopJobs = async (): Promise<void> => {
  const instance = queue ?? (starting ? await starting.catch(() => null) : null);
  queue = null;
  starting = null;
  await instance?.stop();
};

/**
 * The running queue. The memory driver starts on demand (without
 * schedules); pg-boss must have been started by server.ts.
 */
export const getQueue = async (): Promise<JobQueue> => {
  if (queue) return queue;
  if (starting) return starting;

  if (env.jobsDriver === "memory") {
    starting = boot({ schedules: false }).then((instance) => {
      queue = instance;
      return instance;
    });
    return starting;
  }

  throw new AppError(
    "Background processing is not running right now. Try again in a moment.",
    503
  );
};

export const enqueue = async (
  name: QueueName,
  data: object,
  options?: SendOptions
): Promise<string | null> => {
  const instance = await getQueue();
  const id = await instance.send(name, data, options);

  log.debug("Job queued", { queue: name, jobId: id, singletonKey: options?.singletonKey });

  return id;
};

/** True while any pipeline job for the meeting is waiting or running. */
export const isPipelineBusy = async (meetingId: string): Promise<boolean> => {
  const instance = await getQueue();

  for (const name of PIPELINE_QUEUES) {
    if ((await instance.pending(name, meetingId)).length > 0) return true;
  }

  return false;
};

/**
 * The in-flight promise of a meeting's job in the in-process queue, or
 * undefined (always undefined with pg-boss). Synchronous on purpose: a
 * caller can check it right after a request returns.
 */
export const memoryJobPromise = (
  name: QueueName,
  meetingId: string
): Promise<void> | undefined => {
  if (!(queue instanceof MemoryQueue)) return undefined;

  const job = queue.store.jobs.find(
    (candidate) =>
      candidate.name === name &&
      candidate.key === meetingId &&
      !FINAL_STATES.includes(candidate.state)
  );

  return job ? queue.whenSettled(job.id).then(() => undefined) : undefined;
};

/**
 * Waits for a job to finish, for endpoints that keep a synchronous
 * response (POST /transcribe, /resummarize) while the work runs as a
 * durable job. Resolves with the final state, or "timeout".
 */
export const waitForJob = async (
  name: QueueName,
  id: string,
  timeoutMs: number,
  pollMs = 1000
): Promise<JobState | "timeout"> => {
  const instance = await getQueue();

  if (instance instanceof MemoryQueue) {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      timer.unref?.();
    });

    try {
      return await Promise.race([instance.whenSettled(id), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state = await instance.state(name, id);
    if (state === null || FINAL_STATES.includes(state)) return state ?? "completed";
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return "timeout";
};

export { Queues };
