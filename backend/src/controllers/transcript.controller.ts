import { Request, Response } from "express";
import * as transcriptService from "../services/transcript.service";
import { sendSuccess } from "../types/api";
import { asyncHandler } from "../utils/asyncHandler";
import { requireString } from "../utils/validate";

export const createTranscript = asyncHandler(
  async (req: Request, res: Response) => {
    const transcript = await transcriptService.createTranscript({
      meetingId: requireString(req.body?.meetingId, "meetingId"),
      content: requireString(req.body?.content, "content", {
        maxLength: 1_000_000,
      }),
    });

    return sendSuccess(res, transcript, "Transcript created", 201);
  }
);

export const getTranscripts = asyncHandler(
  async (_req: Request, res: Response) => {
    const transcripts = await transcriptService.listTranscripts();

    return sendSuccess(res, transcripts, "Transcripts fetched");
  }
);
