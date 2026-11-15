import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildDemoMeeting, buildDemoMeetings, DEMO_SPECS, estimateTimings } from "../../src/demo/build";
import { isNoiseLabel, isSummaryV2, type Evidence } from "../../src/types/summary";

/**
 * The demo seed is consistent by construction; these tests keep it so:
 * every chip points at a real segment with the right speaker and time,
 * the transcripts are the repo's synthetic fixtures, and the summaries
 * respect those fixtures' answer keys (nothing the key forbids).
 */

const NOW = new Date("2026-11-15T12:00:00Z");
const FIXTURES = path.resolve(__dirname, "../../../fixtures/transcripts");
const FIXTURE_OF = { lecture: "lecture", interview: "interview-interviewer", project: "project-meeting" } as const;

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(path.join(FIXTURES, file), "utf8")) as T;

/** Every object in the summary that carries evidence, with its path. */
const sourcedItems = (value: unknown, where = "summary"): { where: string; evidence: Evidence[]; text: string }[] => {
  if (Array.isArray(value)) return value.flatMap((entry, i) => sourcedItems(entry, `${where}[${i}]`));
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const own = Array.isArray(record.evidence)
    ? [{ where, evidence: record.evidence as Evidence[], text: JSON.stringify({ ...record, evidence: undefined }) }]
    : [];
  return [
    ...own,
    ...Object.entries(record)
      .filter(([key]) => key !== "evidence")
      .flatMap(([key, child]) => sourcedItems(child, `${where}.${key}`)),
  ];
};

describe("demo meetings", () => {
  const meetings = buildDemoMeetings({ now: NOW });

  it("has the three modes the brief asks for", () => {
    expect(meetings.map((m) => m.mode)).toEqual(["LECTURE", "INTERVIEW", "PROJECT"]);
    // Newest first, so the dashboard opens on the lecture.
    const times = meetings.map((m) => m.createdAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  for (const meeting of meetings) {
    describe(meeting.key, () => {
      const byIdx = new Map(meeting.segments.map((s) => [s.idx, s]));

      it("uses the synthetic fixture transcript, line for line", () => {
        const fixture = readJson<{ speaker: string; text: string }[]>(`${FIXTURE_OF[meeting.key]}.json`);
        expect(meeting.segments.map((s) => [s.speaker, s.text])).toEqual(fixture.map((f) => [f.speaker, f.text]));
      });

      it("has dense idx values, ordered non-overlapping times, valid labels", () => {
        meeting.segments.forEach((s, i) => {
          expect(s.idx).toBe(i);
          expect(s.endMs).toBeGreaterThan(s.startMs);
          if (i > 0) expect(s.startMs).toBeGreaterThanOrEqual(meeting.segments[i - 1].endMs);
          expect(isNoiseLabel(s.noiseLabel)).toBe(true);
        });
        expect(meeting.durationSec).toBe(Math.ceil(meeting.segments[meeting.segments.length - 1].endMs / 1000));
      });

      it("puts the recording user on the mic channel and everyone else on the remote one", () => {
        const me = meeting.speakers.find((s) => s.isMe)!;
        expect(me.label).toBe("mic");
        for (const s of meeting.segments) {
          expect(s.channel).toBe(s.speaker === me.displayName ? "mic" : "remote");
          expect(meeting.speakers.some((p) => p.label === s.speakerLabel && p.displayName === s.speaker)).toBe(true);
        }
        expect(new Set(meeting.speakers.map((s) => s.label)).size).toBe(meeting.speakers.length);
      });

      it("is a schemaVersion 2 summary in the meeting's mode", () => {
        expect(isSummaryV2(meeting.summary)).toBe(true);
        expect(meeting.summary.mode).toBe(meeting.mode);
        const section = { LECTURE: "lecture", INTERVIEW: "interview", PROJECT: "project" }[meeting.mode as "LECTURE"];
        expect(meeting.summary.sections).toHaveProperty(section);
      });

      it("every chip points at a real segment, with its speaker and start time", () => {
        const items = sourcedItems(meeting.summary);
        expect(items.length).toBeGreaterThan(5);
        for (const item of items) {
          expect(item.evidence.length, item.where).toBeGreaterThan(0);
          for (const e of item.evidence) {
            const segment = byIdx.get(e.idx);
            expect(segment, `${item.where} -> idx ${e.idx}`).toBeDefined();
            expect(e.speaker).toBe(segment!.speaker);
            expect(e.startMs).toBe(segment!.startMs);
          }
        }
        for (const task of meeting.actionItems) {
          for (const e of task.evidence) expect(byIdx.get(e.idx)?.startMs).toBe(e.startMs);
        }
      });

      it("never cites noise as evidence", () => {
        for (const item of sourcedItems(meeting.summary)) {
          for (const e of item.evidence) expect(byIdx.get(e.idx)!.noiseLabel, item.where).not.toBe("small_talk");
        }
      });

      it("respects the fixture's answer key", () => {
        const key = readJson<{
          me?: string;
          mustAppear: { kind: string; match: string[]; owner?: string | null; evidenceStartMs: number[] }[];
          mustNotAppear: { kind: string; match: string[] }[];
        }>(`${FIXTURE_OF[meeting.key]}.expected.json`);
        const fixture = readJson<{ startMs: number }[]>(`${FIXTURE_OF[meeting.key]}.json`);
        const idxOfFixtureStart = (ms: number) => fixture.findIndex((f) => f.startMs === ms);

        const all = JSON.stringify(meeting.summary).toLowerCase();
        for (const trap of key.mustNotAppear.filter((t) => t.kind === "any")) {
          expect(trap.match.every((term) => all.includes(term.toLowerCase())), `trap ${trap.match.join("/")}`).toBe(false);
        }

        const items = sourcedItems(meeting.summary);
        for (const expected of key.mustAppear) {
          // Some item says it and cites a segment the key accepts.
          const saying = items.filter((item) => expected.match.every((term) => item.text.toLowerCase().includes(term.toLowerCase())));
          const citesIt = saying.some((item) =>
            item.evidence.some((e) => expected.evidenceStartMs.map(idxOfFixtureStart).includes(e.idx))
          );
          expect(citesIt, `${expected.kind} ${expected.match.join("/")}`).toBe(true);
        }

        for (const task of key.mustAppear.filter((m) => m.kind === "actionItem")) {
          const row = meeting.actionItems.find((a) => task.match.every((t) => a.task.toLowerCase().includes(t.toLowerCase())));
          expect(row?.owner ?? null).toBe(task.owner ?? null);
        }
      });
    });
  }

  it("resolves spoken deadlines against the meeting start", () => {
    const project = meetings.find((m) => m.key === "project")!;
    const endpoint = project.actionItems.find((a) => a.task.includes("endpoint"))!;
    expect(endpoint.dueSpoken).toBe("by Friday");
    // Meeting start 2026-11-10 (Tuesday, 5 days before NOW): next Friday is the 13th.
    expect(endpoint.dueDate).toBe("2026-11-13");
    expect(project.actionItems.filter((a) => a.status === "COMPLETED")).toHaveLength(1);
  });

  it("takes segment times from the generated audio", () => {
    const spec = DEMO_SPECS[0];
    const timings = spec.lines.map((_, i) => ({ startMs: i * 10_000, endMs: i * 10_000 + 4_000 }));
    const meeting = buildDemoMeeting(spec, { now: NOW, timings });
    expect(meeting.segments[5].startMs).toBe(50_000);
    const examFlag = meeting.summary.sections.lecture!.examQuestions.flaggedByLecturer[0];
    expect(examFlag.evidence[0]).toEqual({ idx: 8, speaker: "Professor", startMs: 80_000 });
  });

  it("refuses evidence that points nowhere", () => {
    const spec = DEMO_SPECS[2];
    const broken = { ...spec, summary: { ...spec.summary, keyPoints: [{ text: "x", evidence: [99], confidence: 1, needsReview: false }] } };
    expect(() => buildDemoMeeting(broken, { now: NOW })).toThrow(/idx 99/);
  });

  it("estimates timings when there is no audio", () => {
    const timings = estimateTimings([
      ["A", "one two three"],
      ["B", "a much longer line with quite a few more words in it than the first"],
    ]);
    expect(timings[0]).toEqual({ startMs: 0, endMs: 1500 });
    expect(timings[1].startMs).toBeGreaterThan(timings[0].endMs);
    expect(timings[1].endMs - timings[1].startMs).toBeGreaterThan(1500);
  });
});
