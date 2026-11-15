import { createApp } from "./app";
import { startJobs, stopJobs } from "./jobs/index";
import { env } from "./lib/env";
import { logger } from "./lib/logger";
import { prisma } from "./lib/prisma";
import { reapStaleSessions } from "./services/live.service";

const app = createApp();

const server = app.listen(env.port, () => {
  logger.info("Server started", {
    port: env.port,
    nodeEnv: env.nodeEnv,
  });
});

/**
 * A browser tab can close without reaching the stop endpoint, which
 * would leave a live session ACTIVE and its meeting without a summary.
 * This sweeps up anything that stopped sending audio.
 */
const REAP_INTERVAL_MS = 5 * 60 * 1000;

const reaper = setInterval(() => {
  void reapStaleSessions().catch((error) => {
    logger.error("Stale session sweep failed", error);
  });
}, REAP_INTERVAL_MS);

// Do not hold the event loop open on an otherwise idle process.
reaper.unref();

/**
 * The job queue and its workers run in this process (w3-jobs). A queue
 * that cannot start (database down, pg-boss schema locked) does not take
 * the API down with it: the HTTP server keeps serving reads, job routes
 * answer 503, GET /api/health/ready reports 503, and the start is retried
 * until it succeeds.
 */
const JOBS_RETRY_MS = 30 * 1000;
let jobsRetry: NodeJS.Timeout | null = null;
let shuttingDown = false;

const bootJobs = async (): Promise<void> => {
  jobsRetry = null;

  try {
    await startJobs();
  } catch (error) {
    logger.error("Job queue failed to start; retrying", error, {
      retryInSeconds: JOBS_RETRY_MS / 1000,
    });

    if (!shuttingDown) {
      jobsRetry = setTimeout(() => void bootJobs(), JOBS_RETRY_MS);
      jobsRetry.unref();
    }
  }
};

void bootJobs();

/**
 * Close the HTTP server, the job queue and the database pool before
 * exiting so in-flight requests and jobs finish and connections are not
 * left dangling. A job still running after pg-boss's graceful timeout is
 * picked up again by the next process once it expires.
 */
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info("Shutting down", { signal });

  clearInterval(reaper);
  if (jobsRetry) clearTimeout(jobsRetry);

  server.close(() => {
    logger.info("HTTP server closed");
  });

  try {
    await stopJobs();
  } catch (error) {
    logger.error("Error while stopping the job queue", error);
  }

  try {
    await prisma.$disconnect();
  } catch (error) {
    logger.error("Error during database disconnect", error);
  }

  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// A crash with an unlogged reason is far harder to diagnose than one
// with a final structured entry.
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", reason);
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", error);
  process.exit(1);
});
