import cors from "cors";
import express from "express";
import { env } from "./lib/env";
import {
  errorHandler,
  notFoundHandler,
} from "./middleware/error.middleware";
import { requestLogger } from "./middleware/requestLogger.middleware";
import apiRoutes from "./routes";
import { sendSuccess } from "./types/api";

/**
 * Builds the Express app without binding a port, so tests can drive it
 * in-process (e.g. via supertest) without starting a real server.
 */
export const createApp = () => {
  const app = express();

  app.use(cors({ origin: env.corsOrigin }));
  app.use(express.json({ limit: "1mb" }));

  app.use(requestLogger);

  app.get("/", (_req, res) =>
    sendSuccess(res, null, "AI Meeting Summarizer API Running")
  );

  // Liveness probe for deployment platforms.
  app.get("/health", (_req, res) =>
    sendSuccess(res, { status: "ok", uptime: process.uptime() }, "Healthy")
  );

  app.use("/api", apiRoutes);

  // Order matters: unmatched /api paths 404 as JSON, then anything
  // that threw reaches the single error handler.
  app.use("/api", notFoundHandler);
  app.use(errorHandler);

  return app;
};
