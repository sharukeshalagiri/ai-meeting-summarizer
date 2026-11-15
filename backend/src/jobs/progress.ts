import { EventEmitter } from "events";
import { logger } from "../lib/logger";
import * as meetingRepo from "../repositories/meeting.repository";

const log = logger.child({ module: "jobs.progress" });

/**
 * Meeting.processing* writes, plus an in-process event for each one so
 * GET /meetings/:id/events can push it at once. The SSE stream also
 * re-reads the row every few seconds, so a write made elsewhere (another
 * process, or code that calls the repository directly) still arrives,
 * just later.
 */

export interface ProgressUpdate {
  stage?: string | null;
  progress?: number | null;
  error?: string | null;
  status?: string;
}

export interface ProgressEvent extends ProgressUpdate {
  meetingId: string;
}

export const progressBus = new EventEmitter();
// One listener per open meeting page; there is no meaningful cap.
progressBus.setMaxListeners(0);

export const PROGRESS_EVENT = "progress";

export const emitProgress = (meetingId: string, update: ProgressUpdate): void => {
  progressBus.emit(PROGRESS_EVENT, { meetingId, ...update } satisfies ProgressEvent);
};

export const setProgress = async (
  meetingId: string,
  update: ProgressUpdate
): Promise<void> => {
  await meetingRepo.updateProcessing(meetingId, update);
  emitProgress(meetingId, update);
};

/** Best effort: bookkeeping must never mask the error being handled. */
export const trySetProgress = async (
  meetingId: string,
  update: ProgressUpdate
): Promise<void> => {
  try {
    await setProgress(meetingId, update);
  } catch (error) {
    log.warn("Could not record processing state", {
      meetingId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * Waits until a meeting's progress satisfies `done`, re-reading the row
 * on every progress event and every `pollMs`. Resolves with the last
 * row read, or null on timeout. Used by endpoints that keep a
 * synchronous response while the work runs as jobs.
 */
export const waitForMeeting = (
  meetingId: string,
  done: (row: meetingRepo.MeetingProgress) => boolean,
  timeoutMs: number,
  pollMs = 2000
): Promise<meetingRepo.MeetingProgress | null> =>
  new Promise((resolve) => {
    let finished = false;
    let checking = false;

    const finish = (row: meetingRepo.MeetingProgress | null) => {
      if (finished) return;
      finished = true;
      clearInterval(poll);
      clearTimeout(deadline);
      progressBus.off(PROGRESS_EVENT, onEvent);
      resolve(row);
    };

    const check = async () => {
      if (finished || checking) return;
      checking = true;
      try {
        const row = await meetingRepo.findProgress(meetingId);
        if (row && done(row)) finish(row);
      } catch (error) {
        log.warn("Progress check failed", {
          meetingId,
          reason: error instanceof Error ? error.message : String(error),
        });
      } finally {
        checking = false;
      }
    };

    const onEvent = (event: ProgressEvent) => {
      if (event.meetingId === meetingId) void check();
    };

    progressBus.on(PROGRESS_EVENT, onEvent);
    const poll = setInterval(() => void check(), pollMs);
    const deadline = setTimeout(() => finish(null), timeoutMs);
    poll.unref?.();
    deadline.unref?.();

    void check();
  });
