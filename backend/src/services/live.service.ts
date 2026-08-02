import fs from "fs/promises";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import * as liveRepo from "../repositories/liveSession.repository";
import * as meetingRepo from "../repositories/meeting.repository";
import * as segmentRepo from "../repositories/segment.repository";
import * as transcriptRepo from "../repositories/transcript.repository";
import { BadRequest, NotFound } from "../types/errors";
import { MeetingStatus } from "../types/meeting";
import { toSpeakerTranscript } from "../types/segment";
import { toRollingJsonValue } from "../types/summary";
import { diarizeSegments } from "./diarization.service";
import * as meetingService from "./meeting.service";
import { transcribeAudioDetailed } from "./speech.service";
import { generateRollingSummary } from "./summary.service";

const log = logger.child({ module: "live.service" });

/**
 * Live meeting capture.
 *
 * The browser records the selected tab in short chunks and posts them
 * here; each chunk is transcribed, diarized, and appended to the
 * meeting's segments, so the transcript grows while the meeting runs.
 *
 * Chunks are transcribed independently rather than streamed to a
 * websocket ASR: Whisper has no streaming mode, and the free browser
 * alternative (SpeechRecognition) is Chrome-only and sends audio to
 * Google. See docs/DECISIONS.md.
 */

/** Starts a live meeting and its capture session. */
export const startSession = async (input: {
  title: string;
  platform: string | null;
  userId?: string | null;
}) => {
  const created = await meetingService.createMeeting({
    title: input.title,
    description: null,
    userId: input.userId ?? null,
    source: "LIVE",
    platform: input.platform,
  });

  // Returned rather than the pre-update row, so the client sees the
  // LIVE status and startedAt it will render immediately.
  const meeting = await meetingRepo.markStarted(created.id);

  const session = await liveRepo.create({
    meetingId: meeting.id,
    platform: input.platform,
  });

  log.info("Live session started", {
    meetingId: meeting.id,
    sessionId: session.id,
    platform: input.platform,
  });

  return { meeting, session };
};

const getActiveSession = async (sessionId: string) => {
  const session = await liveRepo.findById(sessionId);

  if (!session) {
    throw NotFound("Live session not found");
  }

  return session;
};

/**
 * Generates a rolling summary if enough new audio has accumulated.
 *
 * Best effort by design: a failed or skipped update must never fail
 * the chunk upload that triggered it, because the client would then
 * treat the whole capture as broken.
 */
const maybeRollingSummary = async (
  session: { id: string; meetingId: string; lastRollingAtMs: number },
  elapsedMs: number
): Promise<boolean> => {
  if (elapsedMs - session.lastRollingAtMs < env.rollingSummaryEveryMs) {
    return false;
  }

  try {
    const segments = await segmentRepo.findByMeetingId(
      session.meetingId
    );

    if (segments.length === 0) return false;

    const data = await generateRollingSummary(
      toSpeakerTranscript(segments)
    );

    await liveRepo.addRollingSummary(
      session.id,
      elapsedMs,
      toRollingJsonValue(data)
    );

    await liveRepo.markRollingAt(session.id, elapsedMs);

    log.info("Rolling summary generated", {
      sessionId: session.id,
      atMs: elapsedMs,
    });

    return true;
  } catch (error) {
    log.warn("Rolling summary skipped", {
      sessionId: session.id,
      reason: error instanceof Error ? error.message : String(error),
    });

    return false;
  }
};

/**
 * Accepts one chunk of captured audio.
 *
 * The uploaded file is removed once transcribed: a long meeting would
 * otherwise leave hundreds of fragments on disk, and the transcript is
 * the artifact worth keeping.
 */
export const ingestChunk = async (input: {
  sessionId: string;
  filePath: string;
  /** Client-reported chunk length; the transcript's own timings win. */
  durationMs: number;
}) => {
  const session = await getActiveSession(input.sessionId);

  if (session.status !== "ACTIVE") {
    throw BadRequest("This live session has already ended.");
  }

  const offsetMs = session.elapsedMs;

  try {
    const result = await transcribeAudioDetailed(
      input.filePath,
      offsetMs
    );

    // Prefer the transcript's own span; fall back to what the client
    // reported when the chunk was silence and produced no segments.
    const chunkMs = result.durationMs || Math.max(0, input.durationMs);

    const diarized = result.segments.length
      ? await diarizeSegments(result.segments)
      : [];

    if (diarized.length) {
      await segmentRepo.appendForMeeting(session.meetingId, diarized);
    }

    const updated = await liveRepo.recordChunk(session.id, chunkMs);

    const summarized = await maybeRollingSummary(
      {
        id: session.id,
        meetingId: session.meetingId,
        lastRollingAtMs: session.lastRollingAtMs,
      },
      updated.elapsedMs
    );

    log.debug("Chunk ingested", {
      sessionId: session.id,
      segments: diarized.length,
      elapsedMs: updated.elapsedMs,
    });

    return {
      sessionId: session.id,
      meetingId: session.meetingId,
      elapsedMs: updated.elapsedMs,
      chunkCount: updated.chunkCount,
      segments: diarized,
      rollingSummaryGenerated: summarized,
    };
  } finally {
    await fs.rm(input.filePath, { force: true }).catch(() => {
      // A leftover temp file is not worth failing the request over.
    });
  }
};

/** Live transcript and the rolling summaries produced so far. */
export const getSessionState = async (meetingId: string) => {
  const session = await liveRepo.findByMeetingId(meetingId);

  if (!session) {
    throw NotFound("No live session for this meeting");
  }

  const segments = await segmentRepo.findByMeetingId(meetingId);

  return { session, segments };
};

/**
 * Ends a capture and produces the final meeting report.
 *
 * The accumulated segments become the meeting's transcript, which then
 * flows through the same summarization path as an uploaded recording,
 * so live and uploaded meetings end up identical in the database.
 */
export const endSession = async (sessionId: string) => {
  const session = await getActiveSession(sessionId);

  if (session.status === "ENDED") {
    // Ending twice is a normal race: the tab can close just as the
    // user clicks stop. Return what already exists.
    return {
      meetingId: session.meetingId,
      alreadyEnded: true,
      summary: null,
    };
  }

  await liveRepo.end(session.id);

  const segments = await segmentRepo.findByMeetingId(session.meetingId);

  const durationSec = Math.round(session.elapsedMs / 1000);

  await meetingRepo.markEnded(session.meetingId, durationSec);

  if (segments.length === 0) {
    // Nothing was captured -- usually the wrong tab was shared, or it
    // was silent throughout.
    await meetingRepo.updateStatus(
      session.meetingId,
      MeetingStatus.FAILED
    );

    log.warn("Live session ended with no transcript", {
      sessionId: session.id,
    });

    return {
      meetingId: session.meetingId,
      alreadyEnded: false,
      summary: null,
    };
  }

  await transcriptRepo.upsert(
    session.meetingId,
    segments.map((segment) => segment.text).join(" ")
  );

  await meetingRepo.updateStatus(
    session.meetingId,
    MeetingStatus.TRANSCRIBED
  );

  log.info("Live session ended", {
    sessionId: session.id,
    meetingId: session.meetingId,
    segments: segments.length,
    durationSec,
  });

  // Reuses the upload pipeline's summarization, so the final report is
  // generated exactly one way.
  const summary = await meetingService.summarizeMeeting(
    session.meetingId
  );

  return {
    meetingId: session.meetingId,
    alreadyEnded: false,
    summary,
  };
};

/**
 * Closes sessions whose browser tab went away without stopping.
 *
 * Without this an abandoned capture stays ACTIVE forever and its
 * meeting never gets a summary.
 */
export const reapStaleSessions = async (): Promise<number> => {
  const cutoff = new Date(Date.now() - env.liveSessionIdleMs);

  const stale = await liveRepo.findStale(cutoff);

  for (const session of stale) {
    try {
      log.warn("Finalizing abandoned live session", {
        sessionId: session.id,
        meetingId: session.meetingId,
      });

      await endSession(session.id);
    } catch (error) {
      log.error("Could not finalize stale session", error, {
        sessionId: session.id,
      });
    }
  }

  return stale.length;
};
