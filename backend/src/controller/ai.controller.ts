import { Request, Response, NextFunction } from "express";
import * as meetingService from "../services/meeting.service";
import { sendSuccess } from "../types/api";

export const transcribeMeeting = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const transcript = await meetingService.transcribeMeeting(
      req.params.id as string
    );

    return sendSuccess(res, transcript, "Transcription completed");
  } catch (error) {
    return next(error);
  }
};
