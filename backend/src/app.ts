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

  // w4-acct: credentials so the session cookie crosses from the dev
  // frontend's port. A credentialed response may not say "*", so "*"
  // reflects the caller's origin (development; the cookie is
  // SameSite=Lax, so other sites still cannot use it) and anything else
  // is a comma-separated allow-list.
  app.use(
    cors({
      origin: env.corsOrigin === "*" ? true : env.corsOrigin.split(",").map((o) => o.trim()),
      credentials: true,
      // Export downloads read the file name from it.
      exposedHeaders: ["Content-Disposition"],
    })
  );
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
