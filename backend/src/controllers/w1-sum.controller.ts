import { Request, Response } from "express";
import { isValidTimezone } from "../lib/dates";
import * as w1SumService from "../services/w1-sum.service";
import { sendSuccess } from "../types/api";
import { BadRequest } from "../types/errors";
import { asyncHandler } from "../utils/asyncHandler";
import { optionalString, requireParam } from "../utils/validate";

/** An IANA zone from the client, or null; a bad one is a 400. */
const optionalTimezone = (value: unknown): string | null => {
  const zone = optionalString(value, { maxLength: 64 });

  if (zone && !isValidTimezone(zone)) {
    throw BadRequest("timezone must be an IANA zone such as Europe/Berlin");
  }

  return zone;
};

/** null clears a field, undefined leaves it alone. */
const optionalNullable = (value: unknown, field: string): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw BadRequest(`${field} must be a string`);
  return value.slice(0, 500);
};

export const getSummaryReview = asyncHandler(
  async (req: Request, res: Response) => {
    const review = await w1SumService.getSummaryReview(
      requireParam(req.params.id, "meeting id")
    );

    return sendSuccess(res, review, "Summary review fetched");
  }
);

export const updateMeetingMode = asyncHandler(
  async (req: Request, res: Response) => {
    const result = await w1SumService.setMode(
      requireParam(req.params.id, "meeting id"),
      req.body?.mode
    );

    return sendSuccess(res, result, "Meeting mode updated");
  }
);

export const resummarizeMeeting = asyncHandler(
  async (req: Request, res: Response) => {
    const result = await w1SumService.resummarize(
      requireParam(req.params.id, "meeting id"),
      {
        mode: req.body?.mode,
        timezone: optionalTimezone(req.body?.timezone),
      }
    );

    return sendSuccess(res, result, "Summary regenerated");
  }
);

export const reviewActionItem = asyncHandler(
  async (req: Request, res: Response) => {
    const body = req.body ?? {};

    const task = optionalNullable(body.task, "task");
    const priority = optionalNullable(body.priority, "priority");

    const result = await w1SumService.reviewActionItem(
      requireParam(req.params.id, "meeting id"),
      requireParam(req.params.itemId, "action item id"),
      body.action,
      {
        task: task ?? undefined,
        owner: optionalNullable(body.owner, "owner"),
        dueSpoken: optionalNullable(body.dueSpoken, "dueSpoken"),
        priority: priority ?? undefined,
      },
      optionalTimezone(body.timezone)
    );

    return sendSuccess(res, result, "Action item reviewed");
  }
);
