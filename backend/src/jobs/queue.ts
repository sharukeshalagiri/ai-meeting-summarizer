/**
 * The job queue the pipeline runs on.
 *
 * Production uses pg-boss (jobs in Postgres, in its own `pgboss` schema,
 * so they survive a restart). Tests and JOBS_DRIVER=memory use the
 * in-process MemoryQueue, which has the same semantics minus durability
 * across processes. Nothing outside src/jobs imports pg-boss, so its API
 * can change without touching the services.
 *
 * Semantics both implementations follow (pg-boss "stately" policy):
 * - a send with a singletonKey is dropped (returns null) while another
 *   job of that queue and key is still waiting (created or retry);
 * - at most one job per queue and key runs at a time;
 * - a handler that throws is retried up to retryLimit times, with
 *   exponential backoff when retryBackoff is set;
 * - a running job whose worker died (no completion and, where the driver
 *   supports it, no heartbeat) is retried once it expires.
 */

export interface QueueDefinition {
  name: string;
  retryLimit: number;
  retryDelaySeconds: number;
  retryBackoff: boolean;
  /** How long one attempt may run before it counts as dead. */
  expireInSeconds: number;
  /**
   * pg-boss only: a worker that stops heart-beating for this long is
   * treated as dead, so a killed process's job is retried long before
   * expireInSeconds.
   */
  heartbeatSeconds?: number;
}

export interface SendOptions {
  singletonKey?: string;
  /** Delay before the job may start. */
  startAfterSeconds?: number;
}

export interface JobContext<T> {
  id: string;
  name: string;
  data: T;
  /** 0 on the first attempt. */
  retryCount: number;
  retryLimit: number;
}

export type JobHandler<T> = (job: JobContext<T>) => Promise<void>;

export type JobState =
  | "created"
  | "retry"
  | "active"
  | "completed"
  | "failed"
  | "cancelled";

export const WAITING_STATES: readonly JobState[] = ["created", "retry"];
export const PENDING_STATES: readonly JobState[] = ["created", "retry", "active"];
export const FINAL_STATES: readonly JobState[] = ["completed", "failed", "cancelled"];

export interface JobQueue {
  readonly driver: "pgboss" | "memory";
  start(): Promise<void>;
  stop(): Promise<void>;
  createQueue(definition: QueueDefinition): Promise<void>;
  send<T extends object>(
    name: string,
    data: T,
    options?: SendOptions
  ): Promise<string | null>;
  work<T>(name: string, handler: JobHandler<T>): Promise<void>;
  /** Recurring job on a cron expression (pg-boss runs it once per tick cluster-wide). */
  schedule(name: string, cron: string, data?: object): Promise<void>;
  /** Jobs of this queue and key that are waiting or running. */
  pending(name: string, singletonKey: string): Promise<{ id: string; state: JobState }[]>;
  /** A job's state, or null if it is unknown (deleted or never existed). */
  state(name: string, id: string): Promise<JobState | null>;
}

/** Retry delay before attempt `retryCount + 1` (pg-boss's formula). */
export const retryDelayMs = (
  definition: Pick<QueueDefinition, "retryDelaySeconds" | "retryBackoff">,
  retryCount: number
): number =>
  definition.retryBackoff
    ? definition.retryDelaySeconds * 1000 * 2 ** retryCount
    : definition.retryDelaySeconds * 1000;
