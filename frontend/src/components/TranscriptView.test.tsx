import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { SpeakerSegment } from "../types/w2-spk";
import TranscriptView from "./TranscriptView";

/**
 * Server-rendered markup (no DOM needed): the seg-<idx> contract holds
 * with the noise filter on, and speakers render as rename buttons.
 */

const seg = (
  idx: number,
  speaker: string,
  text: string,
  extra: Partial<SpeakerSegment> = {}
): SpeakerSegment => ({
  id: `s${idx}`,
  idx,
  speaker,
  text,
  startMs: idx * 10,
  endMs: idx * 10 + 5,
  timestamp: "00:01",
  ...extra,
});

const render = (segments: SpeakerSegment[]) =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={["/meetings/m1"]}>
      <Routes>
        <Route path="/meetings/:id" element={<TranscriptView segments={segments} />} />
      </Routes>
    </MemoryRouter>
  );

const segments = [
  seg(0, "You", "Morning everyone", { speakerId: "me", channel: "mic", noiseLabel: "small_talk" }),
  seg(1000, "Priya", "The build is green", { speakerId: "p", noiseLabel: "substantive" }),
  seg(1001, "Priya", "how was the weekend", { speakerId: "p", noiseLabel: "small_talk" }),
  seg(2000, "You", "Ship it", { speakerId: "me", channel: "mic" }),
];

describe("TranscriptView", () => {
  it("renders every segment as seg-<idx> with data-start-ms, hidden noise included", () => {
    const html = render(segments);
    for (const s of segments) {
      expect(html).toContain(`id="seg-${s.idx}"`);
      expect(html).toContain(`data-start-ms="${s.startMs}"`);
    }
  });

  it("hides noise by default behind a fold, but keeps the text in the DOM", () => {
    const html = render(segments);
    expect(html).toMatch(/<input type="checkbox"[^>]*checked=""/);
    expect(html).toContain("1 line of small talk");
    expect(html).toMatch(/id="seg-1001"[^>]*hidden=""/);
    expect(html).not.toMatch(/id="seg-1000"[^>]*hidden=""/);
  });

  it("merges turns per speaker and makes speakers renameable", () => {
    const html = render(segments);
    expect(html).toContain("2 speakers");
    expect(html).toContain("3 turns");
    expect(html).toContain('aria-label="Priya. Rename this speaker"');
  });

  it("shows no noise toggle when nothing is labelled noise", () => {
    const html = render([seg(0, "Speaker 1", "hello")]);
    expect(html).not.toContain("Hide noise");
  });
});
