import type { Request, Response } from "express";
import * as jobsHealth from "../services/w3-jobs.service";
import { sendSuccess } from "../types/api";
import { asyncHandler } from "../utils/asyncHandler";

/** GET /api/health: liveness (always 200) plus `queue: "up" | "down"`. */
export const getHealth = asyncHandler(async (_req: Request, res: Response) =>
  sendSuccess(res, jobsHealth.health(), "Healthy")
);

/** GET /api/health/ready: 200 when work can be queued, else 503. */
export const getReadiness = asyncHandler(
  async (_req: Request, res: Response) => {
    if (!jobsHealth.isReady()) {
      throw jobsHealth.unavailable();
    }

    return sendSuccess(res, jobsHealth.health(), "Ready");
  }
);
