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
import { Queues, type LateJob } from "../jobs/definitions";
import { assertJobsAvailable, enqueue } from "../jobs/index";
import { diarizeSegments } from "./diarization.service";
import { linkSegmentSpeakers } from "./speakers/attribute";
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
  /** The signed-in user or the device token's account. */
  userId: string;
  /** Capture-contract fields; absent for the legacy web page. */
  source?: CaptureSource | null;
  mode?: MeetingMode | null;
  hints?: string[];
}) => {
  const created = await meetingService.createMeeting({
    title: input.title,
    description: null,
    userId: input.userId,
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
  session: { hints?: string[] | null; roster?: string[] | null; meetingId?: string },
  channelLayout: ChannelLayout,
  previousWords: PreviousWords
): TranscribeOptions => ({
  // The owner's provider and glossary apply to every chunk.
  ...(session.meetingId ? { meetingId: session.meetingId } : {}),
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

    // Speakers are matched to the meeting's profiles (stable labels
    // across chunks); "previous" gives the boundary its continuity.
    const diarized = result.segments.length
      ? await diarizeSegments(result.segments, {
          meetingId: session.meetingId,
          filePath: input.filePath,
          channelLayout: "mono",
          offsetMs,
          roster: session.roster ?? [],
          previous: recent,
        })
      : [];

    if (diarized.length) {
      await segmentRepo.appendForMeeting(session.meetingId, diarized);

      // appendForMeeting numbers the rows itself; read their idx back
      // to store the speaker links.
      if (diarized.some((segment) => segment.speakerId)) {
        const written = await segmentRepo.findRecentByMeetingId(
          session.meetingId,
          diarized.length
        );
        await linkSegmentSpeakers(
          session.meetingId,
          written.map((row, i) => ({
            idx: row.idx,
            text: row.text,
            speakerId: diarized[i]?.speakerId,
          })),
          { roster: session.roster ?? [] }
        );
      }
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
 * Quiet time before re-running the final pass after late chunks. A
 * backlog arrives as a burst, and every chunk pushes the run back, so a
 * burst costs one pass rather than one per chunk.
 */
export const LATE_RESUMMARY_DELAY_MS = 2 * 60 * 1000;

const acceptsLateChunks = (endedAt: Date | null | undefined): boolean =>
  endedAt != null &&
  Date.now() - new Date(endedAt).getTime() <= LATE_CHUNK_WINDOW_MS;

/**
 * Queues the delayed late-chunk pass (live-late, keyed by session). It is
 * a pg-boss job, so a restart during the wait no longer loses it. While
 * one is waiting, another send is dropped (singleton); the job itself
 * pushes the run back until the session has been quiet for the delay.
 */
export const scheduleLatePass = async (
  sessionId: string,
  meetingId: string,
  delayMs = LATE_RESUMMARY_DELAY_MS
): Promise<void> => {
  await enqueue(
    Queues.LIVE_LATE,
    { sessionId, meetingId } satisfies LateJob,
    {
      singletonKey: sessionId,
      startAfterSeconds: Math.max(1, Math.ceil(delayMs / 1000)),
    }
  );
};

/**
 * Kept for older tests: late re-summaries are jobs now, so there is no
 * in-process timer left to cancel.
 */
export const cancelScheduledResummaries = (): void => undefined;

/**
 * Writes the meeting's flat transcript from its segments and marks it
 * TRANSCRIBED. Shared by /end and the late-chunk pass, so both build the
 * transcript the same way.
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
 * The live-late job: runs once the session has had no chunk for
 * LATE_RESUMMARY_DELAY_MS and no pipeline step is running for the
 * meeting; otherwise it queues itself again for the remaining time.
 * Then the draft transcript is rebuilt from all segments (late ones
 * included) and the final pass runs again, so the late audio is in the
 * recording, the transcript and the summary.
 */
export const lateFinalPass = async (
  sessionId: string,
  now = Date.now()
): Promise<"postponed" | "started" | "skipped"> => {
  const session = await liveRepo.findById(sessionId);
  if (!session) return "skipped";

  const lastChunkAt = session.lastChunkAt ? new Date(session.lastChunkAt).getTime() : null;
  const quietFor = lastChunkAt === null ? Infinity : now - lastChunkAt;

  if (quietFor < LATE_RESUMMARY_DELAY_MS) {
    await scheduleLatePass(sessionId, session.meetingId, LATE_RESUMMARY_DELAY_MS - quietFor);
    return "postponed";
  }

  // A running pass would not pick the new segments up.
  if (await meetingService.isProcessing(session.meetingId)) {
    log.info("Pipeline still running; late pass postponed", { sessionId });
    await scheduleLatePass(sessionId, session.meetingId);
    return "postponed";
  }

  const segments = await segmentRepo.findByMeetingId(session.meetingId);
  if (segments.length === 0) return "skipped";

  await meetingRepo.updateDuration(
    session.meetingId,
    Math.round(session.elapsedMs / 1000)
  );

  // Also recovers a meeting that ended with no speech (NO_SPEECH).
  await writeTranscript(session.meetingId, segments);

  log.info("Final pass again after late chunks", {
    sessionId,
    meetingId: session.meetingId,
    segments: segments.length,
  });

  await queueFinalPass(session, "late");
  return "started";
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

  // A late chunk must be able to queue its re-run. Checked before any
  // work, so the recorder's retry (it retries 5xx) finds nothing half
  // done; an ACTIVE session's chunk does not need the queue.
  if (session.status !== "ACTIVE") {
    try {
      assertJobsAvailable();
    } catch (error) {
      await removeFile(input.filePath);
      throw error;
    }
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

    // Voice diarization of the remote channel, matched to the
    // meeting's SpeakerProfiles, so a speaker keeps one label across
    // chunk boundaries (docs/decisions/w2-spk.md).
    let diarized = result.segments.length
      ? await diarizeSegments(result.segments, {
          meetingId: session.meetingId,
          filePath: input.filePath,
          channelLayout: input.channelLayout,
          offsetMs: input.startOffsetMs,
          roster: session.roster ?? [],
          previous,
        })
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

    // Stores speakerId by idx (segment rows only carry the label) and
    // applies a speaker name once two signals agree. Best effort.
    await linkSegmentSpeakers(session.meetingId, segments, {
      roster: session.roster ?? [],
    });

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

    // Silent chunks add nothing to summarize, so they never schedule.
    // Queued before the chunk counts as done: if queuing fails the
    // chunk is FAILED, and the recorder's retry schedules it again.
    if (ended && segments.length > 0) {
      await scheduleLatePass(session.id, session.meetingId);
    }

    await chunkRepo.markTranscribed(
      chunkId,
      segments.length,
      response as unknown as Prisma.InputJsonObject
    );

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
 * Queues what turns an ended session into the final meeting:
 * - contract chunks on record: the live final pass (live-assemble: one
 *   recording from the chunks, then the full pipeline on it);
 * - legacy web-page sessions (no LiveChunk rows, files deleted): the
 *   summary of the draft, as before.
 */
const queueFinalPass = async (
  session: { id: string; meetingId: string },
  origin: "live-final" | "late"
): Promise<void> => {
  const chunks = await chunkRepo.findBySession(session.id);

  if (chunks.length > 0) {
    await meetingService.startLiveFinal(session.meetingId, session.id, origin);
  } else {
    await meetingService.startSummary(session.meetingId);
  }
};

/**
 * Writes the draft transcript (or NO_SPEECH) for an ended session and
 * queues its final pass. Shared by /end and a repeated /end that finds
 * the pass never queued.
 */
const finalizeEnded = async (session: {
  id: string;
  meetingId: string;
}): Promise<{ summarizing: boolean; segments: number }> => {
  const segments = await segmentRepo.findByMeetingId(session.meetingId);

  // A FAILED chunk (Whisper was down during the meeting, say) still has
  // its audio, which the final pass transcribes from the recording.
  const recoverable =
    segments.length === 0 &&
    (await chunkRepo.findBySession(session.id)).some((chunk) => chunk.status === "FAILED");

  if (segments.length === 0 && !recoverable) {
    // Nothing was captured: usually the wrong tab was shared, or it was
    // silent throughout. That is not a processing failure, so the
    // meeting is COMPLETED with stage NO_SPEECH (no retry offered). A
    // late chunk with speech re-summarizes it.
    await meetingRepo.updateProcessing(session.meetingId, {
      stage: ProcessingStage.NO_SPEECH,
      error: null,
      status: MeetingStatus.COMPLETED,
    });

    log.warn("Live session ended with no speech", { sessionId: session.id });

    return { summarizing: false, segments: 0 };
  }

  if (segments.length > 0) await writeTranscript(session.meetingId, segments);

  await queueFinalPass(session, "live-final");

  return { summarizing: true, segments: segments.length };
};

/**
 * Ends a capture and queues the final meeting report (the response does
 * not wait for it).
 *
 * The live draft (the chunks' segments) becomes the transcript at once.
 * Then the chunks are assembled into one stereo recording and the full
 * upload pipeline runs on it; its transcript replaces the draft with
 * speakers (and the user's renames) carried over. The meeting page
 * follows the stages over GET /meetings/:id/events.
 *
 * While the queue is down this answers 503 **before writing anything**:
 * the session stays ACTIVE and the recorder's retry of /end (both
 * recorders retry 5xx) is a fresh, complete /end. A repeated /end on an
 * ENDED session whose final pass was never queued (processingStage
 * still null: the queue failed between the writes and the enqueue)
 * queues it then.
 */
export const endSession = async (sessionId: string) => {
  const session = await getActiveSession(sessionId);

  if (session.status === "ENDED") {
    // Ending twice is a normal race: the tab can close just as the
    // user clicks stop. Return what already exists.
    const progress = await meetingRepo.findProgress(session.meetingId);

    if (
      progress &&
      progress.processingStage == null &&
      !(await meetingService.isProcessing(session.meetingId))
    ) {
      log.warn("Ended session without a final pass; queuing it now", {
        sessionId: session.id,
      });
      const { summarizing } = await finalizeEnded(session);
      return {
        meetingId: session.meetingId,
        alreadyEnded: true,
        summary: null,
        summarizing,
      };
    }

    return {
      meetingId: session.meetingId,
      alreadyEnded: true,
      summary: null,
    };
  }

  assertJobsAvailable();

  await liveRepo.end(session.id);

  const durationSec = Math.round(session.elapsedMs / 1000);

  await meetingRepo.markEnded(session.meetingId, durationSec);

  const { summarizing, segments } = await finalizeEnded(session);

  log.info("Live session ended", {
    sessionId: session.id,
    meetingId: session.meetingId,
    segments,
    durationSec,
  });

  return {
    meetingId: session.meetingId,
    alreadyEnded: false,
    summary: null,
    ...(summarizing ? { summarizing: true } : {}),
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
