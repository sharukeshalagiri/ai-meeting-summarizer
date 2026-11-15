import { logger } from "../lib/logger";
import { getStorage, storageKeys } from "../lib/storage";
import * as actionItemRepo from "../repositories/actionItem.repository";
import * as meetingRepo from "../repositories/meeting.repository";
import * as segmentRepo from "../repositories/segment.repository";
import * as summaryRepo from "../repositories/summary.repository";
import * as transcriptRepo from "../repositories/transcript.repository";
import { BadRequest } from "../types/errors";
import { MeetingStatus, ProcessingStage } from "../types/meeting";
import { toSpeakerTranscript, type RawSegment } from "../types/segment";
import { toJsonValue } from "../types/summary";
import { diarizeSegments } from "../services/diarization.service";
import { indexMeeting } from "../services/embedding.service";
import { transcribeAudioDetailed } from "../services/speech.service";
import { cleanSegments, generateSummary } from "../services/summary.service";
import { resummarize } from "../services/w1-sum.service";
import { Queues, type PipelineJob } from "./definitions";
import { classifyError, formatFailure, PROCESSING_NOTES, SUMMARY_FAILED } from "./errors";
import { enqueue } from "./index";
import { setProgress, trySetProgress } from "./progress";
import type { JobContext } from "./queue";

const log = logger.child({ module: "jobs.pipeline" });

/**
 * The per-meeting pipeline: transcribe -> diarize -> clean -> summarize
 * -> index. Each handler commits its own writes, then queues the next
 * step and writes that step's stage (so the stage means "waiting for or
 * running this step"). Every write replaces rather than appends, so a
 * handler that runs twice (a retry, or a crash between its commit and
 * its completion) produces the same result.
 */

/** Queues the next step for a meeting and moves its stage there. */
export const advance = async (
  job: PipelineJob,
  next: (typeof Queues)[keyof typeof Queues],
  stage: string | null,
  extra: { status?: string } = {}
): Promise<void> => {
  if (stage) await setProgress(job.meetingId, { stage, progress: 0, ...extra });
  await enqueue(next, job, { singletonKey: job.meetingId });
};

/**
 * Runs one stage and turns its failure into meeting state:
 * - transient (retryable) with attempts left: a note on the meeting,
 *   then rethrow so the queue retries with backoff;
 * - transient with no attempts left: FAILED with the reason, rethrow so
 *   the queue records the job failed;
 * - permanent: FAILED with the reason, and the job completes (a retry
 *   cannot help). The user retries from the page once the cause is fixed.
 */
export const runStage = async (
  stage: string,
  job: JobContext<PipelineJob>,
  work: () => Promise<void>
): Promise<void> => {
  const { meetingId, origin } = job.data;

  try {
    await work();
  } catch (error) {
    const failure = classifyError(error, stage);
    const reason =
      stage === ProcessingStage.SUMMARIZING && failure.kind === "INTERNAL"
        ? SUMMARY_FAILED
        : formatFailure(stage, failure);

    log.error("Pipeline stage failed", error, {
      meetingId,
      stage,
      kind: failure.kind,
      attempt: job.retryCount + 1,
    });

    if (failure.retryable && job.retryCount < job.retryLimit) {
      await trySetProgress(meetingId, {
        error: `${reason} Retrying automatically (attempt ${job.retryCount + 2} of ${job.retryLimit + 1}).`,
      });
      throw error;
    }

    await trySetProgress(meetingId, {
      stage: ProcessingStage.FAILED,
      error: reason,
      // A re-summary of a finished meeting keeps its old summary and
      // status; anything else did not produce a usable meeting.
      ...(origin === "resummarize" ? {} : { status: MeetingStatus.FAILED }),
    });

    if (failure.retryable) throw error;
  }
};

interface AsrArtifact {
  text: string;
  segments: RawSegment[];
  durationMs: number;
}

/** TRANSCRIBING: Whisper over the stored recording, into a storage artifact. */
export const transcribe = async (job: JobContext<PipelineJob>) =>
  runStage(ProcessingStage.TRANSCRIBING, job, async () => {
    const { meetingId } = job.data;
    const meeting = await meetingRepo.findById(meetingId);

    if (!meeting) return; // deleted meanwhile: nothing to do
    if (!meeting.audioPath) throw BadRequest("No audio uploaded for this meeting.");

    const startedAt = Date.now();
    const result = await transcribeAudioDetailed(meeting.audioPath);

    const artifact: AsrArtifact = {
      text: result.text,
      segments: result.segments,
      durationMs: result.durationMs,
    };

    // The live draft (or a previous transcript) stays untouched until
    // the diarize step commits, so a failure here loses nothing.
    await getStorage().put(storageKeys.asr(meetingId), JSON.stringify(artifact));

    log.info("Transcription complete", {
      meetingId,
      durationMs: Date.now() - startedAt,
      segments: result.segments.length,
    });

    await advance(job.data, Queues.DIARIZE, ProcessingStage.DIARIZING);
  });

const readAsr = async (meetingId: string): Promise<AsrArtifact | null> => {
  const raw = await getStorage().get(storageKeys.asr(meetingId));
  if (!raw) return null;

  const parsed = JSON.parse(raw.toString("utf8")) as Partial<AsrArtifact>;

  return {
    text: typeof parsed.text === "string" ? parsed.text : "",
    segments: Array.isArray(parsed.segments) ? parsed.segments : [],
    durationMs: typeof parsed.durationMs === "number" ? parsed.durationMs : 0,
  };
};

/** DIARIZING: speakers, then the transcript and segments are written. */
export const diarize = async (job: JobContext<PipelineJob>) =>
  runStage(ProcessingStage.DIARIZING, job, async () => {
    const { meetingId } = job.data;
    const asr = await readAsr(meetingId);

    if (!asr) {
      // The artifact is gone (cleaned up, or another disk): redo ASR.
      log.warn("ASR artifact missing; transcribing again", { meetingId });
      await advance(job.data, Queues.TRANSCRIBE, ProcessingStage.TRANSCRIBING);
      return;
    }

    const diarized = asr.segments.length ? await diarizeSegments(asr.segments) : [];

    await transcriptRepo.upsert(meetingId, asr.text);
    await segmentRepo.replaceForMeeting(meetingId, diarized);

    if (asr.durationMs > 0) {
      await meetingRepo.updateDuration(meetingId, Math.round(asr.durationMs / 1000));
    }

    if (diarized.length === 0) {
      // Silence or the wrong file: nothing failed, there is just
      // nothing to summarize (same as an empty live capture).
      await setProgress(meetingId, {
        stage: ProcessingStage.NO_SPEECH,
        error: null,
        status: MeetingStatus.COMPLETED,
      });
      return;
    }

    await advance(job.data, Queues.CLEAN, ProcessingStage.CLEANING, {
      status: MeetingStatus.TRANSCRIBED,
    });
  });

/** CLEANING: noise labels (CLEAN pass) stored per segment. */
export const clean = async (job: JobContext<PipelineJob>) =>
  runStage(ProcessingStage.CLEANING, job, async () => {
    const { meetingId } = job.data;
    const segments = await segmentRepo.findByMeetingId(meetingId);

    if (segments.length === 0) {
      throw BadRequest("This meeting has no transcript segments yet. Transcribe it first.");
    }

    // cleanSegments never throws for a Gemini failure: unlabelled
    // segments count as substantive for this run and stay unlabelled,
    // so the summary step (or a later run) can label them.
    await cleanSegments(
      segments.map((segment) => ({
        idx: segment.idx,
        speaker: segment.speaker,
        text: segment.text,
        startMs: segment.startMs,
        endMs: segment.endMs,
        noiseLabel: segment.noiseLabel,
      })),
      {
        writeNoiseLabels: async (labels) => {
          await segmentRepo.setNoiseLabels(meetingId, labels);
        },
      }
    );

    await advance(job.data, Queues.SUMMARIZE, ProcessingStage.SUMMARIZING, {
      status: MeetingStatus.PROCESSING,
    });
  });

/** The legacy single-prompt summary, kept as the v2 pipeline's fallback. */
const legacySummary = async (meetingId: string) => {
  const segments = await segmentRepo.findByMeetingId(meetingId);
  const transcript = await transcriptRepo.findByMeetingId(meetingId);
  const input = segments.length ? toSpeakerTranscript(segments) : transcript?.content ?? "";

  const { structured, markdown } = await generateSummary(input);

  await summaryRepo.upsert(
    meetingId,
    markdown,
    { ...toJsonValue(structured), pipeline: "legacy" },
    structured.sentiment.overall
  );

  await actionItemRepo.replaceForMeeting(meetingId, structured.actionItems);
};

/**
 * SUMMARIZING: the w1-sum v2 pipeline (which keeps human-reviewed action
 * items), falling back to the legacy summary when v2 throws. A user's
 * re-summarize has no fallback: they asked for the v2 summary in a mode.
 */
export const summarize = async (job: JobContext<PipelineJob>) =>
  runStage(ProcessingStage.SUMMARIZING, job, async () => {
    const { meetingId, origin, timezone } = job.data;
    const startedAt = Date.now();
    let pipeline: "v2" | "legacy" = "v2";

    if (origin === "resummarize") {
      await resummarize(meetingId, { runNow: true, timezone: timezone ?? null });
    } else {
      try {
        await resummarize(meetingId, { runNow: true });
      } catch (error) {
        log.error("Summary pipeline v2 failed; using the legacy summary", error, {
          meetingId,
        });

        pipeline = "legacy";

        await setProgress(meetingId, {
          error: PROCESSING_NOTES.V2_FALLBACK,
          progress: 50,
        });

        await legacySummary(meetingId);
      }
    }

    await setProgress(meetingId, {
      stage: ProcessingStage.DONE,
      progress: 100,
      status: MeetingStatus.COMPLETED,
    });

    log.info("Summary complete", { meetingId, pipeline, durationMs: Date.now() - startedAt });

    await getStorage()
      .remove(storageKeys.asr(meetingId))
      .catch(() => undefined);

    // Search and chat need the index, but a meeting is complete without
    // it, so it runs after DONE and has no stage of its own.
    await enqueue(Queues.INDEX, job.data, { singletonKey: meetingId });
  });

/** Search index: retried on transient errors, otherwise only logged. */
export const index = async (job: JobContext<PipelineJob>) => {
  const { meetingId } = job.data;

  try {
    const indexed = await indexMeeting(meetingId);
    log.info("Meeting indexed", { meetingId, indexed });
  } catch (error) {
    const failure = classifyError(error);

    log.warn("Indexing failed", {
      meetingId,
      kind: failure.kind,
      attempt: job.retryCount + 1,
      reason: error instanceof Error ? error.message : String(error),
    });

    if (failure.retryable && job.retryCount < job.retryLimit) throw error;
  }
};
