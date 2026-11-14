/**
 * Per-meeting serialisation for speaker matching.
 *
 * Contract chunks of one meeting can be processed concurrently (the
 * recorder retries, chunks arrive out of order). Matching reads the
 * meeting's profiles, then creates or updates them; two chunks doing
 * that at once could both create "Speaker 2" (unique per meeting) or
 * both create a profile for the same new voice. Only the matching step
 * is serialised; transcription still runs in parallel.
 *
 * In memory, like the background summary: one backend process.
 */
const tails = new Map<string, Promise<unknown>>();

export const withMeetingLock = async <T>(
  meetingId: string,
  task: () => Promise<T>
): Promise<T> => {
  const previous = tails.get(meetingId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const tail = run.catch(() => undefined);
  tails.set(meetingId, tail);

  try {
    return await run;
  } finally {
    // Drop the entry once nothing is queued behind this task.
    if (tails.get(meetingId) === tail) tails.delete(meetingId);
  }
};
