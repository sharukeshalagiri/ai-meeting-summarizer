import { Request, Response } from "express";
import * as actionItemService from "../services/actionItem.service";
import * as meetingService from "../services/meeting.service";
import { withSpeakerNames } from "../services/speakers/speakers.service";
import * as summaryLookup from "../services/summaryLookup.service";
import * as transcriptService from "../services/transcript.service";
import { sendSuccess } from "../types/api";
import { isActiveStage, MeetingStatus } from "../types/meeting";
import { asyncHandler } from "../utils/asyncHandler";
import { currentUserId } from "../middleware/auth.middleware";
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
      // Always the signed-in user; a userId in the body is ignored.
      userId: currentUserId(req),
    });

    return sendSuccess(res, meeting, "Meeting created", 201);
  }
);

export const getMeetings = asyncHandler(
  async (req: Request, res: Response) => {
    const meetings = await meetingService.listMeetings(currentUserId(req));

    return sendSuccess(res, meetings, "Meetings fetched");
  }
);

export const getMeetingById = asyncHandler(
  async (req: Request, res: Response) => {
    const meeting = await meetingService.getMeeting(
      requireParam(req.params.id, "meeting id")
    );

    // Speaker renames are projected at read time (w2-spk D5).
    return sendSuccess(res, await withSpeakerNames(meeting), "Meeting fetched");
  }
);

/**
 * Streams the stored recording. res.sendFile handles HTTP Range (206
 * partial content), which the <audio> element needs to seek. The
 * /meetings/:id guard has checked the owner; <audio> sends the session
 * cookie by itself.
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
    const id = requireParam(req.params.id, "meeting id");
    const summary = await summaryLookup.getSummaryByMeeting(id);
    const named = await withSpeakerNames({ id, summary });

    return sendSuccess(res, named.summary, "Summary fetched");
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
    const id = requireParam(req.params.id, "meeting id");
    const items = await actionItemService.listByMeeting(id);
    const named = await withSpeakerNames({ id, actionItems: items });

    return sendSuccess(res, named.actionItems, "Action items fetched");
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
 * EventSource cannot send headers, so this is authenticated by the
 * session cookie (EventSource withCredentials) and owner-checked by the
 * /meetings/:id guard like every other meeting route.
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
