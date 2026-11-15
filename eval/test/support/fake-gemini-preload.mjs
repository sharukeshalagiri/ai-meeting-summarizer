/**
 * Preloaded (node --import) into the real eval CLI by cli.test.ts.
 * Replaces the global fetch for the Gemini API host with a local fake,
 * so the CLI runs end to end without the network. Every request it
 * answers is counted into FAKE_GEMINI_COUNT_FILE at exit, so the test
 * can compare what really went out with what the meter counted.
 *
 * FAKE_GEMINI_MODE: "ok" (default) or "503" (EXTRACT always overloaded).
 */
import fs from "node:fs";

const mode = process.env.FAKE_GEMINI_MODE ?? "ok";
const countFile = process.env.FAKE_GEMINI_COUNT_FILE;
let count = 0;

const json = (status, payload) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

const body = {
  tldr: "A fake summary.",
  keyPoints: [],
  decisions: [],
  actionItems: [],
  dates: [],
  openQuestions: [],
  whoSaidWhat: [],
  glossary: [],
  nextSessionPrep: [],
  keywords: [],
  sentiment: { overall: "NEUTRAL", rationale: "" },
  sections: {},
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!url.hostname.endsWith("generativelanguage.googleapis.com")) return realFetch(input, init);

  count++;
  const request = JSON.parse(String(init?.body ?? "{}"));
  const text = request.contents?.[0]?.parts?.[0]?.text ?? "";
  const clean = text.startsWith("Label every segment");
  const extract = text.includes("Transcript:") && !text.startsWith("Draft summary");

  if (mode === "503" && extract) {
    return json(503, { error: { code: 503, message: "high demand", status: "UNAVAILABLE" } });
  }
  const value = clean ? { labels: [] } : body;
  return json(200, {
    candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(value) }] }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 50 },
  });
};

process.on("exit", () => {
  if (countFile) fs.writeFileSync(countFile, String(count));
});
