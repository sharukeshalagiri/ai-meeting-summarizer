import { afterEach, describe, expect, it, vi } from "vitest";
import { SILENCE_WARN_MS, SilenceTracker, meterLevel, monitorLevels, rms } from "./levels.ts";

describe("levels", () => {
  afterEach(() => vi.useRealTimers());

  it("computes RMS and a 0..1 meter level", () => {
    expect(rms([])).toBe(0);
    expect(rms([0.5, -0.5])).toBeCloseTo(0.5);
    expect(meterLevel(0)).toBe(0);
    expect(meterLevel(1)).toBe(1);
    expect(meterLevel(0.001)).toBeCloseTo(0);
  });

  it("warns only after 30 s of continuous silence", () => {
    const tracker = new SilenceTracker();

    expect(tracker.update(0, 0)).toBe(false);
    expect(tracker.update(0, SILENCE_WARN_MS - 1)).toBe(false);
    expect(tracker.update(0, SILENCE_WARN_MS)).toBe(true);
    expect(tracker.update(0.1, SILENCE_WARN_MS + 1)).toBe(false);
    expect(tracker.update(0, SILENCE_WARN_MS + 2)).toBe(false);
  });

  it("never flags a mic the user switched off", () => {
    vi.useFakeTimers();
    let t = 0;
    let micOn = true;
    const silent = { fftSize: 4, getFloatTimeDomainData: (b: Float32Array) => b.fill(0) };
    const seen: { mic: boolean; tab: boolean }[] = [];

    const stop = monitorLevels(
      { left: silent, right: silent, isMicEnabled: () => micOn },
      (levels) => seen.push({ mic: levels.mic.silent, tab: levels.tab.silent }),
      1_000,
      () => t
    );

    for (let i = 0; i < 31; i++) {
      t += 1_000;
      vi.advanceTimersByTime(1_000);
    }
    expect(seen.at(-1)).toEqual({ mic: true, tab: true });

    micOn = false;
    t += 1_000;
    vi.advanceTimersByTime(1_000);
    expect(seen.at(-1)).toEqual({ mic: false, tab: true });

    stop();
  });
});
