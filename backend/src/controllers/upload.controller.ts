import { Request, Response } from "express";
import * as meetingService from "../services/meeting.service";
import { sendSuccess } from "../types/api";
import { BadRequest } from "../types/errors";
import { asyncHandler } from "../utils/asyncHandler";
import { requireParam } from "../utils/validate";

/** Multer populates req.file; a missing file means the client erred. */
const requireFile = (req: Request): Express.Multer.File => {
  if (!req.file) {
    throw BadRequest("No audio uploaded");
  }

  return req.file;
};

/**
 * Saves the upload and runs the whole pipeline in one request. Kept
 * for clients that want a single call; the frontend uses the staged
 * routes so it can report progress.
 */
export const uploadMeetingAudio = asyncHandler(
  async (req: Request, res: Response) => {
    const result = await meetingService.processMeeting(
      requireParam(req.params.id, "meeting id"),
      requireFile(req).path
    );

    return sendSuccess(res, result, "Meeting processed successfully");
  }
);

/** Saves the file only, so the client can drive each stage itself. */
export const saveMeetingAudio = asyncHandler(
  async (req: Request, res: Response) => {
    const meeting = await meetingService.attachAudio(
      requireParam(req.params.id, "meeting id"),
      requireFile(req).path
    );

    return sendSuccess(res, meeting, "Audio uploaded");
  }
);
