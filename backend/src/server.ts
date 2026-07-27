import { createApp } from "./app";
import { env } from "./lib/env";
import { logger } from "./lib/logger";
import { prisma } from "./lib/prisma";

const app = createApp();

const server = app.listen(env.port, () => {
  logger.info("Server started", {
    port: env.port,
    nodeEnv: env.nodeEnv,
  });
});

/**
 * Close the HTTP server and database pool before exiting so in-flight
 * requests finish and connections are not left dangling.
 */
const shutdown = async (signal: string): Promise<void> => {
  logger.info("Shutting down", { signal });

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
