import { describe, expect, it } from "vitest";
import {
  addressedNames,
  selfIntroductions,
  suggestNames,
  type NameTurn,
} from "../../src/services/speakers/names";

describe("selfIntroductions", () => {
  it.each([
    ["Hi everyone, I'm Priya.", "Priya"],
    ["I'm Priya and I run the platform team", "Priya"],
    ["My name is Ana Lucia, nice to meet you", "Ana Lucia"],
    ["Hi, this is Tom from design.", "Tom"],
    ["Okay. Raj here, sorry I'm late", "Raj"],
    ["I am Bob", "Bob"],
  ])("finds the name in %j", (text, name) => {
    expect(selfIntroductions(text)).toEqual([name]);
  });

  it.each([
    "I'm Frank about this, it will slip.",
    "I'm Sam's manager, so loop me in.",
    "I'm sorry, can you repeat that?",
    "I'm Sorry about the delay.",
    "I'm Sure we can do it.",
    "I'm happy with that",
    "I'm Really not sure",
    "I'm Monday's on-call person",
    "I'm Going to share my screen",
    "This is Monday's agenda.",
    "this is great",
    "I'm late",
  ])("finds no name in %j", (text) => {
    expect(selfIntroductions(text)).toEqual([]);
  });
});

describe("addressedNames", () => {
  it.each([
    ["Thanks, Priya.", "Priya"],
    ["Priya, can you take the migration?", "Priya"],
    ["What do you think, Raj?", "Raj"],
    ["Over to you Tom", "Tom"],
  ])("finds the address in %j", (text, name) => {
    expect(addressedNames(text)).toEqual([name]);
  });

  it("ignores possessives and plain words", () => {
    expect(addressedNames("Thanks, Sam's team did it.")).toEqual([]);
    expect(addressedNames("So, can we move on?")).toEqual([]);
  });
});

const turn = (
  idx: number,
  speakerId: string | null,
  text: string,
  channel: string | null = "remote"
): NameTurn => ({ idx, speakerId, text, channel });

describe("suggestNames", () => {
  it("auto-applies self-introduction + roster", () => {
    const result = suggestNames(
      [turn(1, "p1", "Hi, I'm Priya.")],
      ["Priya Sharma", "Me Myself"]
    );
    expect(result).toEqual([
      expect.objectContaining({
        speakerId: "p1",
        name: "Priya Sharma",
        autoApply: true,
        signals: ["self_intro", "roster"],
      }),
    ]);
  });

  it("auto-applies self-introduction + being addressed, with no roster", () => {
    const result = suggestNames([
      turn(1, "p1", "I'm Priya, I lead platform."),
      turn(2, "mic", "Thanks, Priya. Can you start?", "mic"),
      turn(3, "p1", "Sure."),
    ]);
    expect(result[0]).toMatchObject({
      speakerId: "p1",
      name: "Priya",
      autoApply: true,
      signals: ["self_intro", "addressed"],
    });
  });

  it("one signal is only a suggestion", () => {
    const [intro] = suggestNames([turn(1, "p1", "I'm Priya.")]);
    expect(intro).toMatchObject({ name: "Priya", autoApply: false });
    expect(intro.confidence).toBeLessThan(0.9);

    const [answered] = suggestNames([
      turn(1, "mic", "Raj, can you give an update?", "mic"),
      turn(2, "p2", "Yes, the build is green."),
    ]);
    expect(answered).toMatchObject({
      speakerId: "p2",
      name: "Raj",
      signals: ["addressed"],
      autoApply: false,
    });
  });

  it("a speaker naming themself in an address does not count as addressed", () => {
    const [result] = suggestNames([turn(1, "p1", "I'm Priya. Thanks, Priya?")]);
    expect(result.autoApply).toBe(false);
  });

  it("never names a remote speaker with the user's own name", () => {
    const result = suggestNames(
      [
        turn(1, "mic", "Hi, I'm Sam.", "mic"),
        turn(2, "p1", "I'm Sam."),
      ],
      ["Sam"]
    );
    expect(result).toEqual([]);
  });

  it("drops a name claimed by two speakers", () => {
    const result = suggestNames(
      [turn(1, "p1", "I'm Alex."), turn(2, "p2", "I'm Alex.")],
      ["Alex"]
    );
    expect(result).toEqual([]);
  });

  it("false positives never produce a name", () => {
    const result = suggestNames(
      [
        turn(1, "p1", "I'm Frank about this."),
        turn(2, "p2", "I'm Sam's manager."),
        turn(3, "p3", "I'm sorry."),
      ],
      ["Frank", "Sam"]
    );
    expect(result).toEqual([]);
  });
});
