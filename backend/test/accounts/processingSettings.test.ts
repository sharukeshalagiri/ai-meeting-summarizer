import { beforeEach, describe, expect, it, vi } from "vitest";
import * as context from "../../src/services/account/context";
import * as provider from "../../src/providers/transcription";
import { transcribeAudioDetailed } from "../../src/services/speech.service";
import { shownName } from "../../src/services/speakers/attribute";

/**
 * Settings that shape processing: the glossary reaches the ASR hints,
 * the chosen provider is used, and the display name labels mic segments.
 */

const transcribe = vi.fn(async () => ({ text: "", segments: [], durationMs: 0, language: null }));

vi.mock("../../src/providers/transcription", () => ({
  getTranscriptionProvider: vi.fn(() => ({ name: "local", transcribe })),
  createTranscriptionProvider: vi.fn(() => ({ name: "other", transcribe })),
}));

beforeEach(() => vi.clearAllMocks());

describe("speech.service with account settings", () => {
  it("adds the owner's glossary after the session hints", async () => {
    vi.mocked(context.settingsForMeeting).mockResolvedValueOnce({
      userId: "alice",
      meLabel: "Alice",
      timezone: null,
      transcriptionProvider: null,
      glossary: ["Kubernetes", "pg-boss"],
    });

    await transcribeAudioDetailed("chunk.webm", 0, { meetingId: "m1", hints: ["agenda", "kubernetes"], roster: ["Priya"] });

    expect(context.settingsForMeeting).toHaveBeenCalledWith("m1");
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({ hints: ["Priya", "agenda", "kubernetes", "pg-boss"] }));
  });

  it("looks an upload up by its recording path", async () => {
    await transcribeAudioDetailed("uploads/meetings/x.webm");
    expect(context.settingsForAudioPath).toHaveBeenCalledWith("uploads/meetings/x.webm");
    expect(provider.getTranscriptionProvider).toHaveBeenCalled();
  });

  it("ignores a Deepgram choice when the server has no key", async () => {
    vi.mocked(context.settingsForAudioPath).mockResolvedValueOnce({
      userId: "alice",
      meLabel: "You",
      timezone: null,
      transcriptionProvider: "deepgram",
      glossary: [],
    });
    await transcribeAudioDetailed("a.webm");
    expect(provider.createTranscriptionProvider).not.toHaveBeenCalled();
    expect(provider.getTranscriptionProvider).toHaveBeenCalled();
  });
});

describe("the You label", () => {
  const mic = { id: "p1", label: "mic", displayName: null } as Parameters<typeof shownName>[0];

  it("uses the owner's display name for an unnamed mic profile", () => {
    expect(shownName(mic, "Alice")).toBe("Alice");
    expect(shownName(mic)).toBe("You");
    expect(shownName({ ...mic, displayName: "Renamed" }, "Alice")).toBe("Renamed");
    expect(shownName({ ...mic, label: "Speaker 2" }, "Alice")).toBe("Speaker 2");
  });
});
