import { logger } from "../lib/logger";
import { getStorage, storageKeys } from "../lib/storage";
import * as chunkRepo from "../repositories/liveChunk.repository";
import * as meetingRepo from "../repositories/meeting.repository";
import { lateFinalPass, reapStaleSessions } from "../services/live.service";
import { BadRequest } from "../types/errors";
import { ProcessingStage } from "../types/meeting";
import { assembleRecording, defaultAssembleDeps, type AssembleDeps } from "./assemble";
import { isLiveFinal, Queues, type LateJob, type PipelineJob } from "./definitions";
import { advance, keepLiveDraft, liveFallback, runStage } from "./pipeline";
import type { JobContext } from "./queue";

const log = logger.child({ module: "jobs.live" });

/**
 * The live flow's jobs:
 * - live-assemble (ASSEMBLING): a session's chunks -> one stereo
 *   recording, then the normal pipeline on it (the final pass);
 * - live-late: the delayed, restart-safe re-run after late chunks;
 * - live-reap: the scheduled sweep that ends abandoned sessions.
 */

let assembleDeps: AssembleDeps = defaultAssembleDeps;

/** Tests swap ffmpeg out. */
export const setAssembleDeps = (deps: AssembleDeps | null): void => {
  assembleDeps = deps ?? defaultAssembleDeps;
};

/**
 * ASSEMBLING: writes recordings/<meetingId>/live.ogg and its manifest,
 * points Meeting.audioPath at it (so GET /meetings/:id/audio plays it),
 * then queues TRANSCRIBING on it. No usable chunk audio, or an assembly
 * that keeps failing (no ffmpeg), keeps the live draft instead.
 */
export const assemble = async (job: JobContext<PipelineJob>) =>
  runStage(
    ProcessingStage.ASSEMBLING,
    job,
    async () => {
      if (!isLiveFinal(job.data)) {
        throw BadRequest("This meeting has no live session to assemble.");
      }

      const { meetingId, sessionId } = job.data;
      const chunks = await chunkRepo.findBySession(sessionId);
      const storage = getStorage();
      const key = storageKeys.liveRecording(meetingId);

      const manifest = await assembleRecording(chunks, storage, key, assembleDeps);

      if (!manifest) {
        log.warn("No chunk audio to assemble; keeping the live draft", {
          meetingId,
          chunks: chunks.length,
        });
        await keepLiveDraft(job.data);
        return;
      }

      await storage.put(
        storageKeys.liveManifest(meetingId),
        JSON.stringify({ ...manifest, sessionId, assembledAt: new Date().toISOString() }, null, 2)
      );
      await meetingRepo.setAudioPath(meetingId, storage.relativePath(key));

      log.info("Live recording assembled", {
        meetingId,
        included: manifest.included.length,
        skipped: manifest.skipped.length,
        missingSeqs: manifest.missingSeqs.length,
        durationMs: manifest.durationMs,
        channelLayout: manifest.channelLayout,
      });

      await advance(
        { ...job.data, channelLayout: manifest.channelLayout },
        Queues.TRANSCRIBE,
        ProcessingStage.TRANSCRIBING
      );
    },
    liveFallback(job.data)
  );

/** live-late: see live.service lateFinalPass. */
export const late = async (job: JobContext<LateJob>) => {
  const outcome = await lateFinalPass(job.data.sessionId);
  log.info("Late-chunk pass", { sessionId: job.data.sessionId, outcome });
};

/** live-reap: ends sessions that stopped sending audio. */
export const reap = async () => {
  const reaped = await reapStaleSessions();
  if (reaped > 0) log.info("Stale live sessions ended", { reaped });
};
