import { createApp } from "./app";
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
 * Close the HTTP server and database pool before exiting so in-flight
 * requests finish and connections are not left dangling.
 */
const shutdown = async (signal: string): Promise<void> => {
  logger.info("Shutting down", { signal });

  clearInterval(reaper);

  server.close(() => {
    logger.info("HTTP server closed");
  });

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
