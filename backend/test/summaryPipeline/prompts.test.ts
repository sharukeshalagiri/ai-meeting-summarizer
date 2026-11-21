import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { MODE_PROMPTS, PROMPTS, promptKey, promptVersions, withMode } from "../../src/prompts";
import { summaryBodySchemaV1 } from "../../src/prompts/schemas.v1";
import { SUMMARY_MODES } from "../../src/types/summary";

const PROMPT_DIR = path.resolve(__dirname, "../../src/prompts");

describe("prompt registry", () => {
  const all = [
    ...Object.values(PROMPTS),
    ...Object.values(MODE_PROMPTS).filter((p) => p !== null),
  ];

  it("has unique id + version pairs", () => {
    const keys = all.map(promptKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps each prompt in its own versioned file", () => {
    for (const prompt of all) {
      const file = prompt.id.startsWith("mode.")
        ? path.join(PROMPT_DIR, "modes", `${prompt.id.slice(5)}.v${prompt.version}.ts`)
        : path.join(PROMPT_DIR, `${prompt.id}.v${prompt.version}.ts`);

      expect(fs.existsSync(file), file).toBe(true);
    }
  });

  it("names its pass in every pipeline prompt", () => {
    for (const [name, prompt] of Object.entries(PROMPTS)) {
      expect(prompt.system).toContain(`${name.toUpperCase()} pass`);
    }
  });

  it("forbids invented facts and resolved dates in the summarizing passes", () => {
    for (const prompt of [PROMPTS.extract, PROMPTS.reduce, PROMPTS.verify]) {
      expect(prompt.system).toMatch(/Never invent/);
      expect(prompt.system).toMatch(/Never convert a relative date/);
      expect(prompt.system).toMatch(/empty section is correct/i);
    }
  });

  it("runs CLEAN and CLASSIFY on the cheap model and the rest on the main one", () => {
    expect(PROMPTS.clean.model).toBe("clean");
    expect(PROMPTS.classify.model).toBe("clean");
    expect(PROMPTS.extract.model).toBe("main");
    expect(PROMPTS.verify.model).toBe("main");
    expect(PROMPTS.reduce.model).toBe("main");
  });

  it("has a section prompt for every mode except GENERAL", () => {
    for (const mode of SUMMARY_MODES) {
      if (mode === "GENERAL") expect(MODE_PROMPTS[mode]).toBeNull();
      else expect(MODE_PROMPTS[mode]?.schema).toBeTruthy();
    }
  });

  it("tells the lecture prompt to separate flagged from likely exam questions", () => {
    expect(MODE_PROMPTS.LECTURE?.system).toMatch(/flaggedByLecturer: ONLY/);
    expect(MODE_PROMPTS.LECTURE?.system).toMatch(/NOT on the exam/);
  });

  it("appends the mode's rules and lists the versions used", () => {
    expect(withMode(PROMPTS.extract, "GENERAL")).toBe(PROMPTS.extract.system);
    expect(withMode(PROMPTS.extract, "INTERVIEW")).toContain("This session is an INTERVIEW");

    expect(promptVersions("ONE_ON_ONE", ["clean", "extract"])).toEqual({
      clean: "clean.v1",
      extract: "extract.v1",
      mode: "mode.oneOnOne.v1",
    });
  });

  it("adds the mode section to the response schema", () => {
    const schema = summaryBodySchemaV1({ key: "lecture", schema: MODE_PROMPTS.LECTURE!.schema }) as {
      properties: { sections: { properties: Record<string, unknown> } };
      required: string[];
    };

    expect(Object.keys(schema.properties.sections.properties)).toEqual(["lecture"]);
    expect(schema.required).toContain("actionItems");
  });
});
