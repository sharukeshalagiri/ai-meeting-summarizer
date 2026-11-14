import { Request, Response } from "express";
import * as meetingService from "../services/meeting.service";
import { sendSuccess } from "../types/api";
import { asyncHandler } from "../utils/asyncHandler";
import { requireParam } from "../utils/validate";

export const transcribeMeeting = asyncHandler(
  async (req: Request, res: Response) => {
    const transcript = await meetingService.transcribeMeeting(
      requireParam(req.params.id, "meeting id")
    );

    return sendSuccess(res, transcript, "Transcription completed");
  }
);

export const summarizeMeeting = asyncHandler(
  async (req: Request, res: Response) => {
    // 202: the summary runs in the background; poll GET /meetings/:id
    // until processingStage leaves SUMMARIZING.
    const state = await meetingService.startSummary(
      requireParam(req.params.id, "meeting id")
    );

    return sendSuccess(res, state, "Summary started", 202);
  }
);
