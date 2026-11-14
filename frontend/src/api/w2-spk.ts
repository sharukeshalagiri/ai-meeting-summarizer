import { getData, patchData, postData } from "./api";
import type { RenameResult, SpeakerView } from "../types/w2-spk";

/** Speaker endpoints (backend routes/w2-spk.routes.ts). */

const speakerUrl = (meetingId: string, key: string) =>
  `/meetings/${meetingId}/speakers/${encodeURIComponent(key)}`;

export const getSpeakers = (meetingId: string) =>
  getData<SpeakerView[]>(`/meetings/${meetingId}/speakers`);

export const renameSpeaker = (meetingId: string, key: string, displayName: string) =>
  patchData<RenameResult>(speakerUrl(meetingId, key), { displayName });

export const acceptSpeakerName = (meetingId: string, key: string) =>
  postData<RenameResult>(`${speakerUrl(meetingId, key)}/accept`);
