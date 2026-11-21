import { api, getData, patchData, postData, putData } from "./api";
import type {
  Account,
  AuthUser,
  Device,
  DeviceKind,
  Prep,
  SeriesSummary,
  SinceLastTimeItem,
} from "../types/account";

/** Accounts, devices, series and exports. */

export const login = (email: string, password: string) =>
  postData<AuthUser>("/auth/login", { email, password });

export const signup = (name: string, email: string, password: string) =>
  postData<AuthUser>("/auth/signup", { name, email, password });

export const logout = () => postData<{ signedOut: boolean }>("/auth/logout");

/**
 * The signed-in account, or null when signed out. The 401 body says
 * whether sign-up is open.
 */
export const fetchMe = async (): Promise<{ account: Account | null; signupEnabled: boolean }> => {
  const res = await api.get("/auth/me", { validateStatus: (s) => s === 200 || s === 401 });
  if (res.status === 401) {
    return { account: null, signupEnabled: Boolean(res.data?.data?.signupEnabled) };
  }
  const account = res.data.data as Account;
  return { account, signupEnabled: account.options.signupEnabled };
};

export const changePassword = (currentPassword: string, newPassword: string) =>
  postData<{ changed: boolean }>("/auth/password", { currentPassword, newPassword });

export const saveSettings = (changes: Partial<Account>) =>
  patchData<Account>("/account/settings", changes);

export const listDevices = () => getData<Device[]>("/devices");

export const createDevice = (name: string, kind: DeviceKind) =>
  postData<{ device: Device; token: string }>("/devices", { name, kind });

export const revokeDevice = (id: string) => postData<Device>(`/devices/${id}/revoke`);

export const listSeries = () => getData<SeriesSummary[]>("/series");

export const createSeries = (name: string) => postData<{ id: string; name: string }>("/series", { name });

export const getPrep = (seriesId: string) => getData<Prep>(`/series/${seriesId}/prep`);

export const setMeetingSeries = (meetingId: string, body: { seriesId: string | null } | { name: string }) =>
  putData<{ meetingId: string; seriesId: string | null }>(`/meetings/${meetingId}/series`, body);

export const resolveSinceLastTime = (meetingId: string, actionItemId: string, action: "apply" | "dismiss") =>
  postData<{ item: SinceLastTimeItem }>(`/meetings/${meetingId}/since-last-time/${actionItemId}`, { action });

export const exportMarkdown = (meetingId: string, transcript: boolean) =>
  getData<{ markdown: string; fileName: string }>(`/meetings/${meetingId}/export`, {
    params: { format: "json", transcript: transcript ? 1 : 0 },
  });

/** Downloads md or pdf as a file (a Blob, so the session cookie is sent). */
export const downloadExport = async (meetingId: string, format: "md" | "pdf", transcript: boolean) => {
  const res = await api.get<Blob>(`/meetings/${meetingId}/export`, {
    params: { format, transcript: transcript ? 1 : 0 },
    responseType: "blob",
  });
  const disposition = String(res.headers["content-disposition"] ?? "");
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const fileName = encoded ? decodeURIComponent(encoded) : `meeting.${format}`;

  const url = URL.createObjectURL(res.data);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

export const emailExport = (meetingId: string, to: string, transcript: boolean) =>
  postData<{ sent: boolean; recipients: string[] }>(`/meetings/${meetingId}/export/email`, {
    to: to.trim() || undefined,
    transcript,
  });
