import { jobsUnavailable, queueStatus } from "../jobs/index";
import { env } from "../lib/env";

/**
 * Health of the background-processing side.
 *
 * The root GET /health stays a pure liveness probe (the process
 * answers). These report whether work can actually be queued, so a
 * deployment can hold traffic (readiness) while pg-boss is down without
 * restarting a process that is otherwise fine.
 */
export const health = () => {
  const queue = queueStatus();

  return {
    status: queue === "up" ? ("ok" as const) : ("degraded" as const),
    queue,
    jobsDriver: env.jobsDriver,
    uptime: process.uptime(),
  };
};

/** Ready to take traffic: the queue is up. */
export const isReady = (): boolean => queueStatus() === "up";

/** The 503 every job route answers while the queue is down. */
export const unavailable = jobsUnavailable;
