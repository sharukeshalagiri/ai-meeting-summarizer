import { getData, postData } from "./api";

/** Demo mode (backend w5-demo). */

export interface DemoStatus {
  enabled: boolean;
  readOnly: boolean;
}

export interface DemoLogin {
  user: { id: string; name: string; email: string };
  /** The meeting the demo opens on (the newest), or null. */
  meetingId: string | null;
}

/** The demo account's address; the server enforces read-only for it. */
export const DEMO_EMAIL = "demo@example.com";

export const getDemoStatus = () => getData<DemoStatus>("/demo");

export const startDemo = () => postData<DemoLogin>("/demo/login");
