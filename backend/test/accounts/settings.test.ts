import { beforeEach, describe, expect, it, vi } from "vitest";
import * as userRepo from "../../src/repositories/user.repository";
import { normalizeGlossary, updateSettings } from "../../src/services/account/account.service";
import { cutoffFor, sweepAudio, type RetentionDeps } from "../../src/services/retention/retention.service";
import { createThrottle } from "../../src/services/auth/throttle";

vi.mock("../../src/repositories/user.repository", () => ({
  findById: vi.fn(async (id: string) => ({ id, name: "A", email: "a@example.com", audioRetentionDays: null, displayName: null })),
  updateSettings: vi.fn(async () => ({})),
}));

beforeEach(() => vi.clearAllMocks());

describe("settings validation", () => {
  it("accepts and normalizes every field", async () => {
    await updateSettings("alice", {
      displayName: "  Alice  ",
      timezone: "Asia/Kolkata",
      defaultMode: "lecture",
      transcriptionProvider: "local",
      glossary: "Kubernetes, kubernetes\nPgBoss",
      audioRetention: "AFTER_DAYS",
      audioRetentionDays: 30,
    });

    expect(userRepo.updateSettings).toHaveBeenCalledWith("alice", {
      displayName: "Alice",
      timezone: "Asia/Kolkata",
      defaultMode: "LECTURE",
      transcriptionProvider: "local",
      glossary: ["Kubernetes", "PgBoss"],
      audioRetention: "AFTER_DAYS",
      audioRetentionDays: 30,
    });
  });

  it.each([
    [{ timezone: "Mars/Olympus" }, /IANA/],
    [{ defaultMode: "PARTY" }, /defaultMode/],
    [{ transcriptionProvider: "deepgram" }, /not configured/],
    [{ audioRetention: "AFTER_DAYS" }, /audioRetentionDays/],
    [{ audioRetentionDays: 0 }, /whole number/],
    [{ name: "" }, /name is required/],
    [{ glossary: [1, 2] }, /strings/],
  ])("rejects %o", async (body, message) => {
    await expect(updateSettings("alice", body)).rejects.toThrow(message);
    expect(userRepo.updateSettings).not.toHaveBeenCalled();
  });

  it("caps the glossary", () => {
    expect(() => normalizeGlossary(Array.from({ length: 201 }, (_, i) => `t${i}`))).toThrow(/at most 200/);
  });
});

describe("audio retention", () => {
  const now = new Date("2026-11-15T12:00:00Z");

  it("cutoffFor follows the policy", () => {
    expect(cutoffFor({ audioRetention: "KEEP", audioRetentionDays: null }, now)).toBeNull();
    expect(cutoffFor({ audioRetention: "AFTER_PROCESSING", audioRetentionDays: null }, now)).toBeUndefined();
    expect(cutoffFor({ audioRetention: "AFTER_DAYS", audioRetentionDays: 7 }, now)).toEqual(new Date("2026-11-08T12:00:00Z"));
    expect(cutoffFor({ audioRetention: "AFTER_DAYS", audioRetentionDays: null }, now)).toBeNull();
  });

  it("deletes the recording and chunk files, then marks the meeting; a failure is retried next run", async () => {
    const removed: string[] = [];
    const marked: string[] = [];
    const deps: RetentionDeps = {
      users: {
        findWithRetention: async () => [
          { id: "alice", audioRetention: "AFTER_PROCESSING", audioRetentionDays: null },
          { id: "bob", audioRetention: "AFTER_DAYS", audioRetentionDays: 30 },
        ],
      },
      meetings: {
        findAudioToDelete: vi.fn(async ({ userId }: { userId: string }) =>
          userId === "alice"
            ? [
                { id: "m-upload", audioPath: "uploads/meetings/a.webm", liveSession: null },
                { id: "m-live", audioPath: null, liveSession: { chunks: [{ path: "uploads/live/1.webm" }, { path: "uploads/live/2.webm" }] } },
                { id: "m-locked", audioPath: "uploads/meetings/locked.webm", liveSession: null },
              ]
            : []
        ) as unknown as RetentionDeps["meetings"]["findAudioToDelete"],
        markAudioDeleted: vi.fn(async (id: string) => {
          marked.push(id);
          return { id };
        }) as unknown as RetentionDeps["meetings"]["markAudioDeleted"],
      },
      removeFile: async (file: string) => {
        if (file.includes("locked")) throw new Error("EBUSY");
        removed.push(file.replace(/\\/g, "/"));
      },
    };

    const result = await sweepAudio(now, deps);

    expect(result).toEqual({ meetings: 2, files: 3, failed: 1 });
    expect(marked).toEqual(["m-upload", "m-live"]);
    expect(removed.every((f) => /uploads\/(meetings|live)\//.test(f))).toBe(true);
    expect(deps.meetings.findAudioToDelete).toHaveBeenCalledWith({ userId: "alice", olderThan: undefined, limit: 200 });
    expect(deps.meetings.findAudioToDelete).toHaveBeenCalledWith({
      userId: "bob",
      olderThan: new Date("2026-10-16T12:00:00Z"),
      limit: 200,
    });
  });
});

describe("login throttle", () => {
  it("blocks after the limit and frees up after the window", () => {
    const throttle = createThrottle({ limit: 3, windowMs: 1000 });
    for (let i = 0; i < 3; i++) throttle.fail("k", 0);
    expect(throttle.retryAfter("k", 10)).toBeGreaterThan(0);
    expect(throttle.retryAfter("k", 1001)).toBe(0);
    throttle.fail("j", 0);
    throttle.clear("j");
    expect(throttle.retryAfter("j", 0)).toBe(0);
  });
});
