import fs from "fs/promises";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { Prisma } from "@prisma/client";
import * as chunkRepo from "../repositories/liveChunk.repository";
import * as liveRepo from "../repositories/liveSession.repository";
import * as meetingRepo from "../repositories/meeting.repository";
import * as segmentRepo from "../repositories/segment.repository";
import * as transcriptRepo from "../repositories/transcript.repository";
import {
  SEGMENTS_PER_CHUNK,
  segmentIdxFor,
  type CaptureSource,
  type ChannelLayout,
  type MeetingMode,
} from "../types/capture";
import { AppError, BadRequest, NotFound } from "../types/errors";
import { MeetingStatus, ProcessingStage } from "../types/meeting";
import { toSpeakerTranscript } from "../types/segment";
import { toRollingJsonValue } from "../types/summary";
import { diarizeSegments } from "./diarization.service";
import * as meetingService from "./meeting.service";
import {
  transcribeAudioDetailed,
  type TranscribeOptions,
} from "./speech.service";
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
  /** Capture-contract fields; absent for the legacy web page. */
  source?: CaptureSource | null;
  mode?: MeetingMode | null;
  hints?: string[];
}) => {
  const created = await meetingService.createMeeting({
    title: input.title,
    description: null,
    userId: input.userId ?? null,
    source: "LIVE",
    platform: input.platform,
    mode: input.mode ?? undefined,
  });

  // Returned rather than the pre-update row, so the client sees the
  // LIVE status and startedAt it will render immediately.
  const meeting = await meetingRepo.markStarted(created.id);

  const session = await liveRepo.create({
    meetingId: meeting.id,
    platform: input.platform,
    source: input.source ?? null,
    hints: input.hints ?? [],
  });

  log.info("Live session started", {
    meetingId: meeting.id,
    sessionId: session.id,
    platform: input.platform,
  });

  // sessionId/meetingId are the capture contract's response; meeting
  // and session stay for the existing web page.
  return { sessionId: session.id, meetingId: meeting.id, meeting, session };
};

const getActiveSession = async (sessionId: string) => {
  const session = await liveRepo.findById(sessionId);

  if (!session) {
    throw NotFound("Live session not found");
  }

  return session;
};

/**
 * Words kept per channel from the previous chunk's tail. The ASR edge
 * de-dup (docs/decisions/w1-asr.md, D1) removes a repeated run of at
 * most 6 words, so more would only grow the request.
 */
export const PREVIOUS_WORDS_PER_CHANNEL = 6;

type PreviousWords = NonNullable<TranscribeOptions["previousWords"]>;

/**
 * The trailing words of the given segments, per channel, oldest first,
 * each tagged with its segment's channel. Segments stored before word
 * timings existed (words null) contribute nothing.
 */
export const tailWords = (
  segments: { channel?: string | null; words?: unknown }[],
  perChannel = PREVIOUS_WORDS_PER_CHANNEL
): PreviousWords => {
  const byChannel = new Map<string, PreviousWords>();

  for (const segment of segments) {
    if (!Array.isArray(segment.words)) continue;

    const key = segment.channel ?? "";
    const list = byChannel.get(key) ?? [];

    for (const raw of segment.words as unknown[]) {
      const word = raw as Record<string, unknown>;
      if (
        typeof word?.w !== "string" ||
        typeof word.startMs !== "number" ||
        typeof word.endMs !== "number"
      ) {
        continue;
      }

      list.push({
        w: word.w,
        startMs: word.startMs,
        endMs: word.endMs,
        ...(typeof word.p === "number" ? { p: word.p } : {}),
        channel: segment.channel ?? null,
      });
    }

    byChannel.set(key, list);
  }

  return [...byChannel.values()]
    .flatMap((list) => list.slice(-perChannel))
    .sort((a, b) => a.startMs - b.startMs);
};

/**
 * Session context every chunk transcription gets: the layout, the
 * recorder's hints and roster (vocabulary bias), and the previous
 * chunk's tail words for edge de-dup.
 */
const transcribeOptionsFor = (
  session: { hints?: string[] | null; roster?: string[] | null },
  channelLayout: ChannelLayout,
  previousWords: PreviousWords
): TranscribeOptions => ({
  channelLayout,
  hints: session.hints ?? [],
  roster: session.roster ?? [],
  previousWords,
});

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
    // Legacy chunks arrive in order, so the previous chunk's tail is
    // the meeting's most recent segments.
    const recent = await segmentRepo.findRecentByMeetingId(
      session.meetingId,
      PREVIOUS_WORDS_PER_CHANNEL
    );

    const result = await transcribeAudioDetailed(
      input.filePath,
      offsetMs,
      transcribeOptionsFor(session, "mono", tailWords(recent))
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

const removeFile = (filePath: string) =>
  fs.rm(filePath, { force: true }).catch(() => {
    // A leftover file is not worth failing the request over.
  });

/**
 * How long after a session ends it still accepts new chunks.
 *
 * Recorders keep a durable queue and drain it before /end, but a
 * network drop, a laptop sleep or the idle reaper can still end a
 * session while chunks are waiting. Within this window they are
 * transcribed and the meeting is re-summarized; after it, 410.
 */
export const LATE_CHUNK_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Debounce before re-summarizing after a late chunk. A backlog arrives
 * as a burst, and each chunk resets the timer, so the burst costs one
 * summary rather than one per chunk.
 */
export const LATE_RESUMMARY_DELAY_MS = 2 * 60 * 1000;

const acceptsLateChunks = (endedAt: Date | null | undefined): boolean =>
  endedAt != null &&
  Date.now() - new Date(endedAt).getTime() <= LATE_CHUNK_WINDOW_MS;

/**
 * Pending re-summaries, by session id. In memory on purpose (like the
 * background summary itself): a restart during the debounce loses the
 * timer and the summary stays stale until another chunk arrives.
 * w3-jobs (pg-boss) makes this durable; see docs/decisions/chore-pair-2.md.
 */
const resummaryTimers = new Map<string, NodeJS.Timeout>();

/**
 * (Re)starts the debounce for re-summarizing an ended session's meeting.
 * Each call resets the timer, so it fires once, after the last chunk.
 */
export const scheduleResummary = (sessionId: string): void => {
  const pending = resummaryTimers.get(sessionId);
  if (pending) clearTimeout(pending);

  const timer = setTimeout(() => {
    resummaryTimers.delete(sessionId);
    void resummarizeEnded(sessionId).catch((error) =>
      log.error("Late re-summary failed", error, { sessionId })
    );
  }, LATE_RESUMMARY_DELAY_MS);

  // A pending re-summary must not keep the process (or a test) alive.
  timer.unref?.();

  resummaryTimers.set(sessionId, timer);
};

/** Drops every pending re-summary (tests and shutdown). */
export const cancelScheduledResummaries = (): void => {
  for (const timer of resummaryTimers.values()) clearTimeout(timer);
  resummaryTimers.clear();
};

/**
 * Writes the meeting's flat transcript from its segments and marks it
 * TRANSCRIBED. Shared by /end and the late-chunk re-summary, so both
 * build the transcript the same way.
 */
const writeTranscript = async (
  meetingId: string,
  segments: { text: string }[]
): Promise<void> => {
  await transcriptRepo.upsert(
    meetingId,
    segments.map((segment) => segment.text).join(" ")
  );

  // Clearing the stage takes a NO_SPEECH meeting out of that state.
  await meetingRepo.updateProcessing(meetingId, {
    stage: null,
    error: null,
    status: MeetingStatus.TRANSCRIBED,
  });
};

/**
 * Rebuilds an ended session's transcript and duration from its segments
 * (late chunks included) and starts the summary again. A summary that is
 * still running would not pick the new segments up, so it waits another
 * debounce period instead.
 */
const resummarizeEnded = async (sessionId: string): Promise<void> => {
  const session = await liveRepo.findById(sessionId);
  if (!session) return;

  if (meetingService.summaryJob(session.meetingId)) {
    log.info("Summary still running; late re-summary postponed", {
      sessionId,
    });
    scheduleResummary(sessionId);
    return;
  }

  const segments = await segmentRepo.findByMeetingId(session.meetingId);
  if (segments.length === 0) return;

  await meetingRepo.updateDuration(
    session.meetingId,
    Math.round(session.elapsedMs / 1000)
  );

  // Also recovers a meeting that ended with no speech (NO_SPEECH).
  await writeTranscript(session.meetingId, segments);

  log.info("Re-summarizing after late chunks", {
    sessionId,
    meetingId: session.meetingId,
    segments: segments.length,
  });

  await meetingService.startSummary(session.meetingId);
};

/** Thrown while another upload of the same chunk is being processed. */
const stillProcessing = () =>
  new AppError(
    "This chunk is still being processed. Retry later with backoff.",
    409
  );

/**
 * Accepts one chunk under the capture contract (docs/CAPTURE_CONTRACT.md).
 *
 * Idempotent on (sessionId, seq): a repeat of a transcribed chunk
 * replays the stored response with `duplicate: true`; a repeat while
 * the first upload is still processing gets 409; a repeat of a failed
 * chunk retries it. Timestamps come from the client's startOffsetMs and
 * segment idx from seq, so chunks may arrive in any order.
 *
 * The chunk file is kept (LiveChunk.path) for later re-processing,
 * unlike the legacy path, which deletes it.
 *
 * Late chunks: an ENDED session still accepts new seqs for
 * LATE_CHUNK_WINDOW_MS (410 after that; a transcribed seq always
 * replays). The session stays ENDED, no rolling summary runs, and a
 * chunk that adds speech schedules a debounced re-summary.
 */
export const ingestContractChunk = async (input: {
  sessionId: string;
  filePath: string;
  seq: number;
  startOffsetMs: number;
  durationMs: number;
  channelLayout: ChannelLayout;
}) => {
  const session = await getActiveSession(input.sessionId);

  const existing = await chunkRepo.findBySeq(session.id, input.seq);

  if (existing?.status === "TRANSCRIBED") {
    await removeFile(input.filePath);
    return replay(existing.result);
  }

  // An ended session still takes chunks for LATE_CHUNK_WINDOW_MS (they
  // trigger a re-summary below); only after that is it gone for good.
  if (session.status !== "ACTIVE" && !acceptsLateChunks(session.endedAt)) {
    await removeFile(input.filePath);
    throw new AppError("This live session has already ended.", 410);
  }

  const fields = {
    path: input.filePath,
    startOffsetMs: input.startOffsetMs,
    durationMs: input.durationMs,
    channelLayout: input.channelLayout,
  };

  let chunkId: string;

  if (!existing) {
    const claimed = await chunkRepo.claim({
      sessionId: session.id,
      seq: input.seq,
      ...fields,
    });

    if (!claimed) {
      // Lost a race with a concurrent upload of the same seq.
      await removeFile(input.filePath);
      throw stillProcessing();
    }

    chunkId = claimed.id;
  } else if (
    existing.status === "FAILED" &&
    (await chunkRepo.reclaimFailed(existing.id, fields))
  ) {
    chunkId = existing.id;
    if (existing.path !== input.filePath) await removeFile(existing.path);
  } else {
    await removeFile(input.filePath);
    throw stillProcessing();
  }

  try {
    // The previous chunk is seq - 1 by idx range, not "the latest
    // segments": contract chunks may arrive out of order. If it has not
    // arrived yet there is simply nothing to de-dup against.
    const previous =
      input.seq > 0
        ? await segmentRepo.findByIdxRange(
            session.meetingId,
            segmentIdxFor(input.seq - 1, 0),
            segmentIdxFor(input.seq, 0)
          )
        : [];

    const result = await transcribeAudioDetailed(
      input.filePath,
      input.startOffsetMs,
      transcribeOptionsFor(session, input.channelLayout, tailWords(previous))
    );

    let diarized = result.segments.length
      ? await diarizeSegments(result.segments)
      : [];

    if (diarized.length > SEGMENTS_PER_CHUNK) {
      log.warn("Chunk produced too many segments; truncating", {
        sessionId: session.id,
        seq: input.seq,
        segments: diarized.length,
      });
      diarized = diarized.slice(0, SEGMENTS_PER_CHUNK);
    }

    const segments = diarized.map((segment, position) => ({
      ...segment,
      idx: segmentIdxFor(input.seq, position),
    }));

    await segmentRepo.insertAtIdx(session.meetingId, segments);

    const updated = await liveRepo.recordContractChunk(
      session.id,
      input.startOffsetMs + input.durationMs
    );

    // Read after the segments are written: a chunk claimed before /end
    // that finishes after it sees ENDED here, so its segments are either
    // in the /end transcript or picked up by the re-summary.
    const ended = updated.status !== "ACTIVE";

    // Rolling summaries are for a meeting in progress; an ended one gets
    // its final summary re-run instead.
    const summarized = ended
      ? false
      : await maybeRollingSummary(
          {
            id: session.id,
            meetingId: session.meetingId,
            lastRollingAtMs: session.lastRollingAtMs,
          },
          updated.elapsedMs
        );

    const response = {
      sessionId: session.id,
      meetingId: session.meetingId,
      seq: input.seq,
      elapsedMs: updated.elapsedMs,
      chunkCount: updated.chunkCount,
      segments,
      rollingSummaryGenerated: summarized,
      duplicate: false,
    };

    await chunkRepo.markTranscribed(
      chunkId,
      segments.length,
      response as unknown as Prisma.InputJsonObject
    );

    // Silent chunks add nothing to summarize, so they never schedule.
    if (ended && segments.length > 0) {
      scheduleResummary(session.id);
    }

    log.debug("Contract chunk ingested", {
      sessionId: session.id,
      seq: input.seq,
      segments: segments.length,
    });

    return response;
  } catch (error) {
    await chunkRepo
      .markFailed(
        chunkId,
        error instanceof Error ? error.message : String(error)
      )
      .catch((markError) =>
        log.error("Could not mark chunk failed", markError, {
          chunkId,
        })
      );

    throw error;
  }
};

const replay = (stored: Prisma.JsonValue | null) => ({
  ...((stored as Record<string, unknown> | null) ?? {}),
  duplicate: true,
});

/**
 * Stores the participant names a recorder sees (e.g. the Meet roster).
 * They are name hints for diarization, not speaker rows.
 */
export const setRoster = async (sessionId: string, participants: string[]) => {
  const session = await getActiveSession(sessionId);

  const updated = await liveRepo.setRoster(session.id, participants);

  return { sessionId: updated.id, roster: updated.roster };
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
 * Ends a capture and starts the final meeting report (in the background;
 * the response does not wait for it).
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
    // Nothing was captured: usually the wrong tab was shared, or it was
    // silent throughout. That is not a processing failure, so the
    // meeting is COMPLETED with stage NO_SPEECH (no retry offered). A
    // late chunk with speech re-summarizes it.
    await meetingRepo.updateProcessing(session.meetingId, {
      stage: ProcessingStage.NO_SPEECH,
      error: null,
      status: MeetingStatus.COMPLETED,
    });

    log.warn("Live session ended with no speech", {
      sessionId: session.id,
    });

    return {
      meetingId: session.meetingId,
      alreadyEnded: false,
      summary: null,
    };
  }

  await writeTranscript(session.meetingId, segments);

  log.info("Live session ended", {
    sessionId: session.id,
    meetingId: session.meetingId,
    segments: segments.length,
    durationSec,
  });

  // Reuses the upload pipeline's summarization, so the final report is
  // generated exactly one way. It runs in the background (it can take
  // minutes); the meeting page polls GET /meetings/:id for the result.
  await meetingService.startSummary(session.meetingId);

  return {
    meetingId: session.meetingId,
    alreadyEnded: false,
    summary: null,
    summarizing: true,
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
