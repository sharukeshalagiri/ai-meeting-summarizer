import { Request, Response, NextFunction } from "express";
import * as meetingService from "../services/meeting.service";
import { sendSuccess } from "../types/api";

export const summarizeMeeting = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const summary = await meetingService.summarizeMeeting(
      req.params.id as string
    );

    return sendSuccess(res, summary, "Summary generated");
  } catch (error) {
    return next(error);
  }
};
