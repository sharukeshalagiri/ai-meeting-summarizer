import { useCallback, useEffect, useState } from "react";
import { getErrorMessage } from "../../api/api";
import { acceptSpeakerName, getSpeakers, renameSpeaker } from "../../api/w2-spk";
import type { SpeakerView } from "../../types/w2-spk";

/**
 * Speakers of the open meeting: suggestions from the server, and renames
 * made on this page. Renames are shown at once through `names` (by
 * speaker key) without refetching the transcript, since the segments
 * come from MeetingDetails.
 */
export const useSpeakers = (meetingId: string | undefined, segmentCount: number) => {
  const [speakers, setSpeakers] = useState<Map<string, SpeakerView>>(new Map());
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const fetchSpeakers = useCallback(
    () =>
      meetingId
        ? getSpeakers(meetingId).then(
            (list) => new Map(list.map((s) => [s.key, s] as const)),
            // Suggestions are optional; the transcript still renders.
            () => null
          )
        : Promise.resolve(null),
    [meetingId]
  );

  const load = useCallback(async () => {
    const next = await fetchSpeakers();
    if (next) setSpeakers(next);
  }, [fetchSpeakers]);

  // Live transcripts grow; new lines can bring new suggestions.
  useEffect(() => {
    let cancelled = false;
    void fetchSpeakers().then((next) => {
      if (next && !cancelled) setSpeakers(next);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchSpeakers, segmentCount]);

  const apply = useCallback(
    async (key: string, run: () => Promise<{ key: string; name: string }>) => {
      setBusyKey(key);
      setError(null);
      try {
        const result = await run();
        setNames((current) => {
          const next = new Map(current);
          next.set(key, result.name);
          next.set(result.key, result.name);
          return next;
        });
        setNotice(
          `Renamed to ${result.name}. The summary and tasks show it after a refresh.`
        );
        await load();
        return true;
      } catch (err) {
        setError(getErrorMessage(err));
        return false;
      } finally {
        setBusyKey(null);
      }
    },
    [load]
  );

  const rename = useCallback(
    (key: string, name: string) =>
      meetingId
        ? apply(key, () => renameSpeaker(meetingId, key, name))
        : Promise.resolve(false),
    [apply, meetingId]
  );

  const accept = useCallback(
    (key: string) =>
      meetingId
        ? apply(key, () => acceptSpeakerName(meetingId, key))
        : Promise.resolve(false),
    [apply, meetingId]
  );

  return { speakers, names, rename, accept, busyKey, error, notice };
};
