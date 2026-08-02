import { Request, Response } from "express";
import * as liveService from "../services/live.service";
import { sendSuccess } from "../types/api";
import { BadRequest } from "../types/errors";
import { asyncHandler } from "../utils/asyncHandler";
import {
  optionalString,
  requireParam,
  requireString,
} from "../utils/validate";

/** Platforms the capture UI and extension can report. */
const PLATFORMS = new Set([
  "GOOGLE_MEET",
  "ZOOM",
  "MICROSOFT_TEAMS",
  "OTHER",
]);

const readPlatform = (value: unknown): string | null => {
  const platform = optionalString(value);

  if (!platform) return null;

  const normalized = platform.toUpperCase();

  // An unrecognized platform is recorded as OTHER rather than
  // rejected: a new conferencing tool should not block a capture.
  return PLATFORMS.has(normalized) ? normalized : "OTHER";
};

export const startLiveSession = asyncHandler(
  async (req: Request, res: Response) => {
    const result = await liveService.startSession({
      title: requireString(req.body?.title, "title", {
        maxLength: 200,
      }),
      platform: readPlatform(req.body?.platform),
      userId: optionalString(req.body?.userId),
    });

    return sendSuccess(res, result, "Live session started", 201);
  }
);

export const ingestChunk = asyncHandler(
  async (req: Request, res: Response) => {
    if (!req.file) {
      throw BadRequest("No audio chunk uploaded");
    }

    const durationMs = Number(req.body?.durationMs);

    const result = await liveService.ingestChunk({
      sessionId: requireParam(req.params.id, "session id"),
      filePath: req.file.path,
      durationMs: Number.isFinite(durationMs) ? durationMs : 0,
    });

    return sendSuccess(res, result, "Chunk processed");
  }
);

export const endLiveSession = asyncHandler(
  async (req: Request, res: Response) => {
    const result = await liveService.endSession(
      requireParam(req.params.id, "session id")
    );

    return sendSuccess(res, result, "Live session ended");
  }
);

export const getLiveState = asyncHandler(
  async (req: Request, res: Response) => {
    const state = await liveService.getSessionState(
      requireParam(req.params.id, "meeting id")
    );

    return sendSuccess(res, state, "Live state fetched");
  }
);
