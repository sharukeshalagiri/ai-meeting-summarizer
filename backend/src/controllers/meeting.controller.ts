import { Request, Response } from "express";
import * as actionItemService from "../services/actionItem.service";
import * as meetingService from "../services/meeting.service";
import * as summaryLookup from "../services/summaryLookup.service";
import * as transcriptService from "../services/transcript.service";
import { sendSuccess } from "../types/api";
import { isActiveStage, MeetingStatus } from "../types/meeting";
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

/**
 * Streams the stored recording. res.sendFile handles HTTP Range (206
 * partial content), which the <audio> element needs to seek.
 * TODO(auth): check the meeting belongs to the requester.
 */
export const getMeetingAudio = asyncHandler(
  async (req: Request, res: Response) => {
    const filePath = await meetingService.getAudioFile(
      requireParam(req.params.id, "meeting id")
    );

    await new Promise<void>((resolve, reject) => {
      res.sendFile(
        filePath,
        { acceptRanges: true, cacheControl: false },
        (error) => {
          // A client aborting mid-stream (seeking) is normal.
          if (error && !res.headersSent) reject(error);
          else resolve();
        }
      );
    });
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

/** POST /:id/process: queue the whole pipeline for an uploaded recording (202). */
export const startMeetingProcessing = asyncHandler(
  async (req: Request, res: Response) => {
    const state = await meetingService.startProcessing(
      requireParam(req.params.id, "meeting id")
    );

    return sendSuccess(res, state, "Processing started", 202);
  }
);

/** POST /:id/retry: resume a failed or stalled pipeline (202). */
export const retryMeetingProcessing = asyncHandler(
  async (req: Request, res: Response) => {
    const state = await meetingService.retryProcessing(
      requireParam(req.params.id, "meeting id")
    );

    return sendSuccess(res, state, "Processing restarted", 202);
  }
);

/** Seconds between SSE comments that keep proxies from closing the stream. */
const SSE_HEARTBEAT_MS = 25_000;
/** EventSource reconnect delay the client is told to use. */
const SSE_RETRY_MS = 3_000;

/** Nothing more will happen without a new request. */
const isSettled = (row: { status: string; processingStage: string | null }) =>
  !isActiveStage(row.processingStage) && row.status !== MeetingStatus.PROCESSING;

/**
 * GET /:id/events: Server-Sent Events with the meeting's progress
 * ({ status, processingStage, processingProgress, processingError }).
 * Sends the current state at once, then every change; once the meeting
 * is settled it sends `event: end` and closes, so the browser's
 * EventSource does not reconnect. Replaces the page's 5 s polling.
 * TODO(auth): EventSource cannot send headers; w4-acct scopes this by
 * cookie or a short-lived token in the query string.
 */
export const getMeetingEvents = asyncHandler(
  async (req: Request, res: Response) => {
    const meetingId = requireParam(req.params.id, "meeting id");
    const initial = await meetingService.getProgress(meetingId);

    res.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // nginx and similar proxies would otherwise buffer the stream.
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.write(`retry: ${SSE_RETRY_MS}\n\n`);

    let closed = false;
    let unsubscribe: () => void = () => undefined;

    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    };

    const send = (row: typeof initial) => {
      if (closed) return;
      res.write(`event: progress\ndata: ${JSON.stringify(row)}\n\n`);

      if (isSettled(row)) {
        res.write("event: end\ndata: {}\n\n");
        close();
      }
    };

    const heartbeat = setInterval(() => {
      if (!closed) res.write(": ping\n\n");
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();

    req.on("close", close);

    send(initial);
    if (!closed) unsubscribe = meetingService.watchProgress(meetingId, send, { initial });
  }
);
