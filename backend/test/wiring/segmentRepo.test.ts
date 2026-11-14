import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as segmentRepo from "../../src/repositories/segment.repository";

/**
 * segment.repository writers with lib/prisma replaced by a recorder, so
 * the column mapping and transaction shape are checked without a
 * database (the smoke run covers real Postgres).
 */

const calls = vi.hoisted(() => ({
  createMany: [] as { data: Record<string, unknown>[]; skipDuplicates?: boolean }[],
  updateMany: [] as { where: unknown; data: unknown }[],
  transactions: [] as unknown[][],
}));

vi.mock("../../src/lib/prisma", () => ({
  prisma: {
    $transaction: async (ops: unknown[]) => {
      calls.transactions.push(ops);
      return Promise.all(ops);
    },
    transcriptSegment: {
      deleteMany: async () => ({ count: 0 }),
      count: async () => 4,
      createMany: async (args: { data: Record<string, unknown>[]; skipDuplicates?: boolean }) => {
        calls.createMany.push(args);
        return { count: args.data.length };
      },
      updateMany: async (args: { where: unknown; data: unknown }) => {
        calls.updateMany.push(args);
        return { count: 1 };
      },
    },
  },
}));

const withAsr = {
  speaker: "Ana",
  text: "Hello there",
  startMs: 0,
  endMs: 900,
  channel: "mic" as const,
  words: [
    { w: "Hello", startMs: 0, endMs: 400, p: 0.9 },
    { w: "there", startMs: 450, endMs: 900 },
  ],
};

const plain = { speaker: "Bo", text: "Hi", startMs: 1000, endMs: 1500 };

beforeEach(() => {
  calls.createMany = [];
  calls.updateMany = [];
  calls.transactions = [];
});

describe("segment writers store channel and words", () => {
  it("replaceForMeeting", async () => {
    await segmentRepo.replaceForMeeting("m1", [withAsr, plain]);

    const [first, second] = calls.createMany[0].data;
    expect(first).toMatchObject({ meetingId: "m1", idx: 0, channel: "mic", words: withAsr.words });
    expect(second).toMatchObject({ idx: 1, channel: null });
    expect(second.words).toBe(Prisma.DbNull);
  });

  it("appendForMeeting continues the index", async () => {
    await segmentRepo.appendForMeeting("m1", [withAsr]);

    expect(calls.createMany[0].data[0]).toMatchObject({ idx: 4, channel: "mic", words: withAsr.words });
  });

  it("insertAtIdx keeps explicit idx and skips duplicates", async () => {
    await segmentRepo.insertAtIdx("m1", [{ ...withAsr, idx: 3001 }]);

    expect(calls.createMany[0].skipDuplicates).toBe(true);
    expect(calls.createMany[0].data[0]).toMatchObject({ idx: 3001, channel: "mic" });
    expect(calls.createMany[0].data[0]).not.toHaveProperty("idx", 0);
  });
});

describe("setNoiseLabels", () => {
  it("updates every label by (meetingId, idx) in one transaction", async () => {
    const count = await segmentRepo.setNoiseLabels("m1", [
      { idx: 3000, label: "SUBSTANTIVE" },
      { idx: 3001, label: "SMALL_TALK" },
    ]);

    expect(count).toBe(2);
    expect(calls.transactions).toHaveLength(1);
    expect(calls.transactions[0]).toHaveLength(2);
    expect(calls.updateMany).toEqual([
      { where: { meetingId: "m1", idx: 3000 }, data: { noiseLabel: "SUBSTANTIVE" } },
      { where: { meetingId: "m1", idx: 3001 }, data: { noiseLabel: "SMALL_TALK" } },
    ]);
  });

  it("does nothing for an empty list", async () => {
    expect(await segmentRepo.setNoiseLabels("m1", [])).toBe(0);
    expect(calls.transactions).toHaveLength(0);
  });
});
