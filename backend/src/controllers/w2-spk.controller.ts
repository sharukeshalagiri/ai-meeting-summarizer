import { Request, Response } from "express";
import * as speakersService from "../services/speakers/speakers.service";
import { sendSuccess } from "../types/api";
import { asyncHandler } from "../utils/asyncHandler";
import { requireParam, requireString } from "../utils/validate";

/**
 * Speaker endpoints (track w2-spk), under /api/meetings. A speaker is
 * addressed by its key: a SpeakerProfile id, or `label:<speaker>` for
 * segments without a profile yet (URL-encoded).
 */

export const getSpeakers = asyncHandler(async (req: Request, res: Response) => {
  const speakers = await speakersService.listSpeakers(
    requireParam(req.params.id, "meeting id")
  );

  return sendSuccess(res, speakers, "Speakers fetched");
});

export const renameSpeaker = asyncHandler(async (req: Request, res: Response) => {
  const result = await speakersService.renameSpeaker(
    requireParam(req.params.id, "meeting id"),
    requireParam(req.params.key, "speaker"),
    requireString(req.body?.displayName, "displayName", {
      maxLength: speakersService.MAX_NAME_LENGTH,
    })
  );

  return sendSuccess(res, result, "Speaker renamed");
});

export const acceptSpeakerSuggestion = asyncHandler(
  async (req: Request, res: Response) => {
    const result = await speakersService.acceptSuggestion(
      requireParam(req.params.id, "meeting id"),
      requireParam(req.params.key, "speaker")
    );

    return sendSuccess(res, result, "Speaker name accepted");
  }
);
