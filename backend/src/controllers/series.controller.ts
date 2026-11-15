import type { Request, Response } from "express";
import { currentUserId } from "../middleware/auth.middleware";
import * as seriesService from "../services/series/series.service";
import { sendSuccess } from "../types/api";
import { BadRequest } from "../types/errors";
import { asyncHandler } from "../utils/asyncHandler";
import { optionalString, requireParam, requireString } from "../utils/validate";

export const listSeries = asyncHandler(async (req: Request, res: Response) =>
  sendSuccess(res, await seriesService.listSeries(currentUserId(req)), "Series fetched")
);

export const createSeries = asyncHandler(async (req: Request, res: Response) =>
  sendSuccess(
    res,
    await seriesService.createSeries(currentUserId(req), requireString(req.body?.name, "name", { maxLength: 120 })),
    "Series created",
    201
  )
);

export const renameSeries = asyncHandler(async (req: Request, res: Response) =>
  sendSuccess(
    res,
    await seriesService.renameSeries(
      currentUserId(req),
      requireParam(req.params.id, "series id"),
      requireString(req.body?.name, "name", { maxLength: 120 })
    ),
    "Series renamed"
  )
);

export const getPrep = asyncHandler(async (req: Request, res: Response) =>
  sendSuccess(
    res,
    await seriesService.getPrep(currentUserId(req), requireParam(req.params.id, "series id")),
    "Prep fetched"
  )
);

/** PUT /meetings/:id/series { seriesId } | { name } | { seriesId: null } */
export const setMeetingSeries = asyncHandler(async (req: Request, res: Response) =>
  sendSuccess(
    res,
    await seriesService.setMeetingSeries(currentUserId(req), requireParam(req.params.id, "meeting id"), {
      seriesId: optionalString(req.body?.seriesId),
      name: optionalString(req.body?.name, { maxLength: 120 }),
    }),
    "Series updated"
  )
);

/** POST /meetings/:id/since-last-time/:itemId { action: apply | dismiss } */
export const resolveSinceLastTime = asyncHandler(async (req: Request, res: Response) => {
  const action = optionalString(req.body?.action);
  if (action !== "apply" && action !== "dismiss") {
    throw BadRequest("action must be apply or dismiss");
  }

  return sendSuccess(
    res,
    await seriesService.resolveSuggestion({
      userId: currentUserId(req),
      meetingId: requireParam(req.params.id, "meeting id"),
      actionItemId: requireParam(req.params.itemId, "action item id"),
      action,
    }),
    action === "apply" ? "Change applied" : "Suggestion dismissed"
  );
});
