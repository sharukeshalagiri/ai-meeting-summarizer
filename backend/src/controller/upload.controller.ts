import { Request, Response, NextFunction } from "express";
import * as meetingService from "../services/meeting.service";
import { sendSuccess } from "../types/api";
import { BadRequest } from "../types/errors";

/**
 * Saves the upload and runs the whole pipeline in one request.
 * Kept for clients that want a single call; the frontend uses the
 * staged transcribe/summarize routes for progress reporting.
 */
export const uploadMeetingAudio = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const meetingId = req.params.id as string | undefined;

    if (!meetingId) {
      throw BadRequest("Missing meeting id");
    }

    if (!req.file) {
      throw BadRequest("No audio uploaded");
    }

    const result = await meetingService.processMeeting(
      meetingId,
      req.file.path
    );

    return sendSuccess(res, result, "Meeting processed successfully");
  } catch (error) {
    return next(error);
  }
};

/** Saves the file only, so the client can drive each stage itself. */
export const saveMeetingAudio = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const meetingId = req.params.id as string | undefined;

    if (!meetingId) {
      throw BadRequest("Missing meeting id");
    }

    if (!req.file) {
      throw BadRequest("No audio uploaded");
    }

    const meeting = await meetingService.attachAudio(
      meetingId,
      req.file.path
    );

    return sendSuccess(res, meeting, "Audio uploaded");
  } catch (error) {
    return next(error);
  }
};
