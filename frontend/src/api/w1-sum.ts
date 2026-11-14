import { getData, patchData, postData } from "./api";
import type {
  ActionItemEdit,
  ActionItemRow,
  ModeSetting,
  ResummarizeResult,
  ReviewAction,
  SummaryReview,
} from "../types/w1-sum";

/** Summary intelligence endpoints (backend routes/w1-sum.routes.ts). */

/** The viewer's IANA zone, used to resolve spoken deadlines. */
export const browserTimezone = (): string | undefined => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};

export const getSummaryReview = (meetingId: string) =>
  getData<SummaryReview>(`/meetings/${meetingId}/summary-review`);

export const setMeetingMode = (meetingId: string, mode: ModeSetting) =>
  patchData<{ modeSetting: ModeSetting }>(`/meetings/${meetingId}/mode`, {
    mode,
  });

export const resummarize = (meetingId: string, mode?: ModeSetting) =>
  postData<ResummarizeResult>(
    `/meetings/${meetingId}/resummarize`,
    { mode, timezone: browserTimezone() },
    // Several model passes; a long meeting takes a while.
    { timeout: 10 * 60 * 1000 }
  );

export const reviewActionItem = (
  meetingId: string,
  itemId: string,
  action: ReviewAction,
  changes: ActionItemEdit = {}
) =>
  postData<ActionItemRow | { id: string; deleted: true }>(
    `/meetings/${meetingId}/action-items/${itemId}/review`,
    { action, ...changes, timezone: browserTimezone() }
  );
