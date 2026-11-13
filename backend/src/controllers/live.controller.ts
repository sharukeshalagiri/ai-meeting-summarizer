import { Request, Response } from "express";
import * as liveService from "../services/live.service";
import { sendSuccess } from "../types/api";
import {
  CAPTURE_SOURCES,
  CHANNEL_LAYOUTS,
  LIMITS,
  MAX_SEQ,
  MEETING_MODES,
  PLATFORM_ALIASES,
  type CaptureSource,
  type ChannelLayout,
  type MeetingMode,
} from "../types/capture";
import { BadRequest } from "../types/errors";
import { asyncHandler } from "../utils/asyncHandler";
import {
  optionalString,
  requireParam,
  requireString,
} from "../utils/validate";

/**
 * Accepts contract names (MEET, TEAMS) and the legacy stored names
 * (GOOGLE_MEET, MICROSOFT_TEAMS); stores the legacy names.
 */
const readPlatform = (value: unknown): string | null => {
  const platform = optionalString(value);

  if (!platform) return null;

  // An unrecognized platform is recorded as OTHER rather than
  // rejected: a new conferencing tool should not block a capture.
  return PLATFORM_ALIASES[platform.toUpperCase()] ?? "OTHER";
};

const readEnum = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string
): T | null => {
  const raw = optionalString(value);

  if (!raw) return null;

  const match = allowed.find(
    (option) => option.toLowerCase() === raw.toLowerCase()
  );

  if (!match) {
    throw BadRequest(`${field} must be one of: ${allowed.join(", ")}`);
  }

  return match;
};

const readStringList = (
  value: unknown,
  field: string,
  max: number,
  maxLength: number
): string[] => {
  if (value === undefined || value === null) return [];

  if (!Array.isArray(value)) {
    throw BadRequest(`${field} must be an array`);
  }

  if (value.length > max) {
    throw BadRequest(`${field} may contain at most ${max} entries`);
  }

  const items = value.map((item) => {
    // Participants may arrive as { name } objects from roster scrapers.
    const text =
      typeof item === "object" && item !== null && "name" in item
        ? (item as { name: unknown }).name
        : item;

    if (typeof text !== "string") {
      throw BadRequest(`${field} must contain strings`);
    }

    return text.trim().slice(0, maxLength);
  });

  return [...new Set(items.filter(Boolean))];
};

/** Multipart fields arrive as strings; returns null when absent. */
const readInt = (
  value: unknown,
  field: string,
  { min = 0, max = Number.MAX_SAFE_INTEGER } = {}
): number | null => {
  if (value === undefined || value === null || value === "") return null;

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw BadRequest(
      `${field} must be an integer between ${min} and ${max}`
    );
  }

  return parsed;
};

/** The audio file arrives as "audio" (contract) or "chunk" (legacy). */
const uploadedChunk = (req: Request): Express.Multer.File | undefined => {
  const files = req.files as
    | Record<string, Express.Multer.File[]>
    | undefined;

  return files?.audio?.[0] ?? files?.chunk?.[0] ?? req.file;
};

export const startLiveSession = asyncHandler(
  async (req: Request, res: Response) => {
    const result = await liveService.startSession({
      title: requireString(req.body?.title, "title", {
        maxLength: 200,
      }),
      platform: readPlatform(req.body?.platform),
      userId: optionalString(req.body?.userId),
      source: readEnum<CaptureSource>(
        req.body?.source,
        CAPTURE_SOURCES,
        "source"
      ),
      mode: readEnum<MeetingMode>(req.body?.mode, MEETING_MODES, "mode"),
      hints: readStringList(
        req.body?.hints,
        "hints",
        LIMITS.hints,
        LIMITS.hintLength
      ),
    });

    return sendSuccess(res, result, "Live session started", 201);
  }
);

/**
 * With `seq` the request follows the capture contract (idempotent,
 * ordered by seq); without it, the legacy web-page path is used.
 */
export const ingestChunk = asyncHandler(
  async (req: Request, res: Response) => {
    const file = uploadedChunk(req);

    if (!file) {
      throw BadRequest("No audio chunk uploaded");
    }

    const sessionId = requireParam(req.params.id, "session id");
    const seq = readInt(req.body?.seq, "seq", { max: MAX_SEQ });

    if (seq === null) {
      const durationMs = Number(req.body?.durationMs);

      const result = await liveService.ingestChunk({
        sessionId,
        filePath: file.path,
        durationMs: Number.isFinite(durationMs) ? durationMs : 0,
      });

      return sendSuccess(res, result, "Chunk processed");
    }

    const startOffsetMs = readInt(req.body?.startOffsetMs, "startOffsetMs");
    const durationMs = readInt(req.body?.durationMs, "durationMs", {
      max: 10 * 60 * 1000,
    });

    if (startOffsetMs === null || durationMs === null) {
      throw BadRequest(
        "startOffsetMs and durationMs are required when seq is sent"
      );
    }

    const result = await liveService.ingestContractChunk({
      sessionId,
      filePath: file.path,
      seq,
      startOffsetMs,
      durationMs,
      channelLayout:
        readEnum<ChannelLayout>(
          req.body?.channelLayout,
          CHANNEL_LAYOUTS,
          "channelLayout"
        ) ?? "mono",
    });

    return sendSuccess(
      res,
      result,
      result.duplicate ? "Chunk already processed" : "Chunk processed"
    );
  }
);

export const setRoster = asyncHandler(
  async (req: Request, res: Response) => {
    const result = await liveService.setRoster(
      requireParam(req.params.id, "session id"),
      readStringList(
        req.body?.participants,
        "participants",
        LIMITS.participants,
        LIMITS.participantLength
      )
    );

    return sendSuccess(res, result, "Roster updated");
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
