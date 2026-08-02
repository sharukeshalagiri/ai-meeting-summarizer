import { Request, Response } from "express";
import * as analyticsService from "../services/analytics.service";
import { sendSuccess } from "../types/api";
import { asyncHandler } from "../utils/asyncHandler";

/** Bounded so a hand-edited query string cannot ask for years of data. */
const MAX_DAYS = 365;
const DEFAULT_DAYS = 30;

export const getOverview = asyncHandler(
  async (req: Request, res: Response) => {
    const requested = Number(req.query.days);

    const days =
      Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), MAX_DAYS)
        : DEFAULT_DAYS;

    const overview = await analyticsService.getOverview(days);

    return sendSuccess(res, overview, "Analytics fetched");
  }
);
