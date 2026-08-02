import { Request, Response } from "express";
import * as actionItemService from "../services/actionItem.service";
import * as meetingService from "../services/meeting.service";
import * as summaryLookup from "../services/summaryLookup.service";
import * as transcriptService from "../services/transcript.service";
import { sendSuccess } from "../types/api";
import { asyncHandler } from "../utils/asyncHandler";
import {
  optionalString,
  requireParam,
  requireString,
} from "../utils/validate";

/**
 * Controllers only parse input, call a service, and shape the
 * response. Errors propagate to the central handler via asyncHandler.
 */

export const createMeeting = asyncHandler(
  async (req: Request, res: Response) => {
    const meeting = await meetingService.createMeeting({
      title: requireString(req.body?.title, "title", { maxLength: 200 }),
      description: optionalString(req.body?.description),
      userId: optionalString(req.body?.userId),
    });

    return sendSuccess(res, meeting, "Meeting created", 201);
  }
);

export const getMeetings = asyncHandler(
  async (_req: Request, res: Response) => {
    const meetings = await meetingService.listMeetings();

    return sendSuccess(res, meetings, "Meetings fetched");
  }
);

export const getMeetingById = asyncHandler(
  async (req: Request, res: Response) => {
    const meeting = await meetingService.getMeeting(
      requireParam(req.params.id, "meeting id")
    );

    return sendSuccess(res, meeting, "Meeting fetched");
  }
);

export const getMeetingTranscript = asyncHandler(
  async (req: Request, res: Response) => {
    const transcript = await transcriptService.getTranscriptByMeeting(
      requireParam(req.params.id, "meeting id")
    );

    return sendSuccess(res, transcript, "Transcript fetched");
  }
);

export const getMeetingSummary = asyncHandler(
  async (req: Request, res: Response) => {
    const summary = await summaryLookup.getSummaryByMeeting(
      requireParam(req.params.id, "meeting id")
    );

    return sendSuccess(res, summary, "Summary fetched");
  }
);

export const getMeetingSegments = asyncHandler(
  async (req: Request, res: Response) => {
    const segments = await transcriptService.getSegmentsByMeeting(
      requireParam(req.params.id, "meeting id")
    );

    return sendSuccess(res, segments, "Segments fetched");
  }
);

export const getMeetingActionItems = asyncHandler(
  async (req: Request, res: Response) => {
    const items = await actionItemService.listByMeeting(
      requireParam(req.params.id, "meeting id")
    );

    return sendSuccess(res, items, "Action items fetched");
  }
);

export const deleteMeeting = asyncHandler(
  async (req: Request, res: Response) => {
    await meetingService.deleteMeeting(
      requireParam(req.params.id, "meeting id")
    );

    return sendSuccess(res, { deleted: true }, "Meeting deleted");
  }
);
