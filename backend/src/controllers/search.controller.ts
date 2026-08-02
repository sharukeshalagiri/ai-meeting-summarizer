import { randomUUID } from "crypto";
import { Request, Response } from "express";
import * as embeddingService from "../services/embedding.service";
import * as searchService from "../services/search.service";
import { sendSuccess } from "../types/api";
import { asyncHandler } from "../utils/asyncHandler";
import {
  optionalString,
  requireParam,
  requireString,
} from "../utils/validate";

export const searchSegments = asyncHandler(
  async (req: Request, res: Response) => {
    const limit = Number(req.query.limit);

    const results = await searchService.search({
      query: requireString(req.query.q, "q", { maxLength: 500 }),
      meetingId: optionalString(req.query.meetingId),
      limit: Number.isFinite(limit) ? limit : undefined,
    });

    return sendSuccess(res, results, "Search complete");
  }
);

export const askQuestion = asyncHandler(
  async (req: Request, res: Response) => {
    // A missing id starts a new thread rather than erroring, so the
    // client can send its first question without a round trip.
    const conversationId =
      optionalString(req.body?.conversationId) ?? randomUUID();

    const answer = await searchService.ask({
      question: requireString(req.body?.question, "question", {
        maxLength: 1000,
      }),
      conversationId,
      meetingId: optionalString(req.body?.meetingId),
    });

    return sendSuccess(
      res,
      { ...answer, conversationId },
      "Answer generated"
    );
  }
);

export const getConversation = asyncHandler(
  async (req: Request, res: Response) => {
    const messages = await searchService.getConversation(
      requireParam(req.params.id, "conversation id")
    );

    return sendSuccess(res, messages, "Conversation fetched");
  }
);

/** Lets the UI trigger indexing for a meeting that has none yet. */
export const indexMeeting = asyncHandler(
  async (req: Request, res: Response) => {
    const indexed = await embeddingService.indexMeeting(
      requireParam(req.params.id, "meeting id")
    );

    return sendSuccess(res, { indexed }, "Meeting indexed");
  }
);
