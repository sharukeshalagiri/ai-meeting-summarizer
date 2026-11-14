import { describe, expect, it } from "vitest";
import { buildReference, parseMeetingChannels, parseWordsXml } from "../../scripts/fetch-ami.mjs";
import { computeWer, diarizationErrorRate, meAttribution, meVsOthers, werText, wordsToTurns, type Turn } from "../src/audio";

const turn = (speaker: string, startMs: number, endMs: number): Turn => ({ speaker, startMs, endMs });

describe("diarizationErrorRate", () => {
  const ref = [turn("A", 0, 10_000), turn("B", 10_000, 20_000)];

  it("is 0 for a perfect hypothesis, whatever the labels are called", () => {
    expect(diarizationErrorRate(ref, [turn("spk1", 0, 10_000), turn("spk2", 10_000, 20_000)]).der).toBe(0);
  });

  it("counts confusion when one label covers both speakers", () => {
    const result = diarizationErrorRate(ref, [turn("x", 0, 20_000)], 0);
    expect(result.der).toBeCloseTo(0.5, 2);
    expect(result.confusionMs).toBeCloseTo(10_000, -2);
  });

  it("counts missed speech and false alarms", () => {
    const missed = diarizationErrorRate(ref, [turn("a", 0, 10_000)], 0);
    expect(missed.missedMs).toBeCloseTo(10_000, -2);
    const fa = diarizationErrorRate([turn("A", 0, 10_000)], [turn("a", 0, 10_000), turn("b", 15_000, 20_000)], 0);
    expect(fa.falseAlarmMs).toBeCloseTo(5000, -2);
    expect(fa.der).toBeCloseTo(0.5, 2);
  });

  it("does not score the collar around reference boundaries", () => {
    // Hypothesis switches 200 ms late: inside a 250 ms collar, so no error.
    const late = [turn("a", 0, 10_200), turn("b", 10_200, 20_000)];
    expect(diarizationErrorRate(ref, late, 250).der).toBe(0);
    expect(diarizationErrorRate(ref, late, 0).der).toBeGreaterThan(0);
  });

  it("maps labels one-to-one to maximise overlap", () => {
    const result = diarizationErrorRate(ref, [turn("q", 0, 10_000), turn("p", 10_000, 20_000)]);
    expect(result.mapping).toEqual({ q: "A", p: "B" });
  });
});

describe("turns and attribution", () => {
  const words = [
    { speaker: "A", text: "hello", startMs: 0, endMs: 400 },
    { speaker: "A", text: "there", startMs: 500, endMs: 900 },
    { speaker: "B", text: "hi", startMs: 1500, endMs: 1800 },
    { speaker: "A", text: "again", startMs: 3000, endMs: 3400 },
  ];

  it("joins one speaker's words into turns across short gaps", () => {
    expect(wordsToTurns(words)).toEqual([turn("A", 0, 900), turn("B", 1500, 1800), turn("A", 3000, 3400)]);
    expect(meVsOthers(wordsToTurns(words), "A").map((t) => t.speaker)).toEqual(["me", "others", "me"]);
  });

  it("measures my words on the mic channel", () => {
    const result = meAttribution({ me: "A", words }, [
      { text: "hello there", startMs: 0, endMs: 1000, channel: "mic" },
      { text: "hi again", startMs: 1400, endMs: 3500, channel: "remote" },
    ]);
    expect(result.meWords).toBe(3);
    expect(result.recall).toBeCloseTo(2 / 3);
    expect(result.precision).toBe(1);
  });
});

describe("WER", () => {
  it("drops fillers on both sides before comparing", () => {
    expect(werText("Um, so uh we ship it")).toBe("so we ship it");
    const ref = { me: "A", words: [{ speaker: "A", text: "um", startMs: 0, endMs: 1 }, { speaker: "A", text: "ship it now", startMs: 1, endMs: 2 }] };
    expect(computeWer(ref, [{ text: "ship it", startMs: 0, endMs: 2 }])).toEqual({ wer: 1 / 3, refWords: 3, errors: 1 });
  });
});

describe("AMI parsers (scripts/fetch-ami.mjs)", () => {
  const wordsXml = `<?xml version="1.0"?>
<nite:root nite:id="ES2004a.A.words" xmlns:nite="http://nite.sourceforge.net/">
   <w nite:id="ES2004a.A.words0" starttime="12.5" endtime="12.84">Okay</w>
   <w nite:id="ES2004a.A.words1" starttime="12.84" endtime="12.84" punc="true">.</w>
   <vocalsound nite:id="ES2004a.A.words2" starttime="13.0" endtime="13.5" type="laugh"/>
   <w nite:id="ES2004a.A.words3" starttime="13.6" endtime="13.9">we&apos;re</w>
   <w nite:id="ES2004a.A.words4">untimed</w>
</nite:root>`;

  it("keeps timed, non-punctuation words", () => {
    expect(parseWordsXml(wordsXml, "A")).toEqual([
      { speaker: "A", text: "Okay", startMs: 12500, endMs: 12840 },
      { speaker: "A", text: "we're", startMs: 13600, endMs: 13900 },
    ]);
  });

  it("reads the agent-to-headset map and picks Headset-0 as me", () => {
    const meetings = `<meetings>
  <meeting observation="ES2004a" duration="1000">
    <speaker nxt_agent="A" channel="1" global_name="FEE"/>
    <speaker nxt_agent="B" channel="0" global_name="MEE"/>
  </meeting>
  <meeting observation="IS1009a"><speaker nxt_agent="A" channel="0"/></meeting>
</meetings>`;
    const channels = parseMeetingChannels(meetings, "ES2004a");
    expect(channels).toEqual({ A: 1, B: 0 });
    const reference = buildReference(
      "ES2004a",
      { A: [{ speaker: "A", text: "x", startMs: 5, endMs: 6 }], B: [{ speaker: "B", text: "y", startMs: 1, endMs: 2 }] },
      channels
    );
    expect(reference.me).toBe("B");
    expect(reference.words.map((w: { text: string }) => w.text)).toEqual(["y", "x"]);
  });
});
