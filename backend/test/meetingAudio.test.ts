import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";

/**
 * GET /api/meetings/:id/audio streams the stored recording with HTTP
 * Range support, which <audio> needs to seek.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ams-audio-"));
const audioPath = path.join(dir, "recording.webm");
const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
fs.writeFileSync(audioPath, bytes);

const meetings: Record<string, { id: string; audioPath: string | null }> = {
  withAudio: { id: "withAudio", audioPath },
  noAudio: { id: "noAudio", audioPath: null },
  missingFile: { id: "missingFile", audioPath: path.join(dir, "gone.webm") },
};

vi.mock("../src/repositories/meeting.repository", () => ({
  findById: async (id: string) => meetings[id] ?? null,
}));

const app = createApp();

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("GET /api/meetings/:id/audio", () => {
  it("streams the whole file with Accept-Ranges", async () => {
    const res = await request(app)
      .get("/api/meetings/withAudio/audio")
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect((res.body as Buffer).length).toBe(1000);
  });

  it("serves a byte range as 206 partial content", async () => {
    const res = await request(app)
      .get("/api/meetings/withAudio/audio")
      .set("Range", "bytes=100-199")
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 100-199/1000");
    expect(Buffer.compare(res.body as Buffer, bytes.subarray(100, 200))).toBe(0);
  });

  it("404s for an unknown meeting, no recording, or a missing file", async () => {
    for (const id of ["nope", "noAudio", "missingFile"]) {
      const res = await request(app).get(`/api/meetings/${id}/audio`);
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    }
  });
});
