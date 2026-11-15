import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { afterAll, describe, expect, it } from "vitest";
import {
  classifyError,
  formatFailure,
  parseFailure,
} from "../../src/jobs/errors";
import { toPgConnectionString } from "../../src/jobs/pgBossQueue";
import { assertKey } from "../../src/lib/storage";
import { LocalStorage } from "../../src/lib/storage/local";
import { toGeminiError } from "../../src/lib/gemini";
import { AppError, BadRequest, UpstreamError } from "../../src/types/errors";

describe("failure reasons", () => {
  it("turns a Gemini 429 into a readable, retryable RATE_LIMITED reason", () => {
    const failure = classifyError(
      toGeminiError(new Error("429 RESOURCE_EXHAUSTED: quota exceeded"), "Summary failed"),
      "SUMMARIZING"
    );

    expect(failure).toMatchObject({ kind: "RATE_LIMITED", retryable: true });
    const reason = formatFailure("SUMMARIZING", failure);
    expect(reason).toMatch(/^\[SUMMARIZING\/RATE_LIMITED\] /);
    expect(reason).not.toMatch(/RESOURCE_EXHAUSTED/);
    expect(parseFailure(reason)).toEqual({
      stage: "SUMMARIZING",
      kind: "RATE_LIMITED",
      message: failure.message,
    });
  });

  it("does not retry a bad API key or a bad request", () => {
    expect(classifyError(toGeminiError(new Error("API key not valid"), "x"))).toMatchObject({
      kind: "AI_AUTH",
      retryable: false,
    });
    expect(classifyError(BadRequest("No audio uploaded for this meeting."))).toEqual({
      kind: "BAD_INPUT",
      retryable: false,
      message: "No audio uploaded for this meeting.",
    });
  });

  it("calls a 5xx during transcription the ASR, elsewhere the AI service", () => {
    const down = UpstreamError("Could not reach the transcription service.");
    expect(classifyError(down, "TRANSCRIBING")).toMatchObject({ kind: "ASR_UNREACHABLE", retryable: true });
    expect(classifyError(UpstreamError("Could not label the transcript right now."), "SUMMARIZING"))
      .toMatchObject({ kind: "AI_UNAVAILABLE", retryable: true });
  });

  it("never shows the text of an unexpected error", () => {
    const failure = classifyError(new Error("SELECT * FROM secrets failed at /srv/x.ts:12"));
    expect(failure.kind).toBe("INTERNAL");
    expect(failure.retryable).toBe(false);
    expect(failure.message).not.toMatch(/secrets|srv/);
  });

  it("retries when the database is unreachable", () => {
    const error = Object.assign(new Error("Can't reach database server"), {
      name: "PrismaClientInitializationError",
    });
    expect(classifyError(error)).toMatchObject({ kind: "DB_UNAVAILABLE", retryable: true });
  });

  it("leaves free text alone when parsing", () => {
    expect(parseFailure("The detailed summary could not be generated")).toBeNull();
    expect(parseFailure(null)).toBeNull();
    expect(new AppError("x", 502).status).toBe(502);
  });
});

describe("pg-boss connection string", () => {
  it("drops Prisma-only parameters", () => {
    expect(
      toPgConnectionString("postgresql://u:p@localhost:5433/db?schema=public&connection_limit=5&sslmode=disable")
    ).toBe("postgresql://u:p@localhost:5433/db?sslmode=disable");
  });
});

describe("LocalStorage", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ams-storage-"));
  const storage = new LocalStorage(root);

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("writes, reads, streams and removes keys under its root", async () => {
    await storage.put("artifacts/m1/asr.json", '{"text":"hi"}');
    expect((await storage.get("artifacts/m1/asr.json"))?.toString()).toBe('{"text":"hi"}');
    expect(storage.localPath("artifacts/m1/asr.json")).toBe(path.join(root, "artifacts", "m1", "asr.json"));

    await storage.putStream("recordings/m1/live.ogg", Readable.from([Buffer.from("ab"), Buffer.from("cd")]));
    expect(fs.readFileSync(storage.localPath("recordings/m1/live.ogg")).toString()).toBe("abcd");

    await storage.remove("artifacts/m1/asr.json");
    expect(await storage.exists("artifacts/m1/asr.json")).toBe(false);
    expect(await storage.get("artifacts/m1/asr.json")).toBeNull();
    // No temp files left behind.
    expect(fs.readdirSync(path.join(root, "recordings", "m1"))).toEqual(["live.ogg"]);
  });

  it("rejects keys that escape the root", () => {
    for (const key of ["../x", "/etc/passwd", "C:/x", "a//b", "a/../../b", ""]) {
      expect(() => assertKey(key)).toThrow(/Invalid storage key/);
    }
    expect(assertKey("a\\b.json")).toBe("a/b.json");
  });
});
