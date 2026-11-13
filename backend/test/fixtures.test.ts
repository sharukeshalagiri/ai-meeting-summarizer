import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * Guards the hand-written answer keys in fixtures/transcripts against
 * drift: if someone edits a transcript, these checks catch evidence that
 * now points nowhere or match terms the transcript no longer contains.
 */

const FIXTURE_DIR = path.resolve(__dirname, "../../fixtures/transcripts");

interface Segment {
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
}

interface ExpectedItem {
  id: string;
  kind: string;
  match: string[];
  owner?: string | null;
  dueDate?: string | null;
  evidenceStartMs: number[];
}

interface ForbiddenItem {
  id: string;
  kind: string;
  match: string[];
  reason: string;
}

interface AnswerKey {
  transcript: string;
  mode: string;
  mustAppear: ExpectedItem[];
  mustNotAppear: ForbiddenItem[];
}

const readJson = <T>(name: string): T =>
  JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8")) as T;

const keys = fs
  .readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith(".expected.json"));

const load = (keyName: string) => {
  const key = readJson<AnswerKey>(keyName);
  const segments = readJson<Segment[]>(key.transcript);
  return { key, segments };
};

const ofKind = (key: AnswerKey, kind: string) =>
  key.mustAppear.filter((item) => item.kind === kind);

describe.each(keys)("fixture %s", (keyName) => {
  const { key, segments } = load(keyName);
  const fullText = segments.map((s) => s.text).join("\n").toLowerCase();

  it("has well-formed, ordered, non-overlapping segments", () => {
    expect(segments.length).toBeGreaterThan(0);

    segments.forEach((segment, i) => {
      expect(typeof segment.speaker).toBe("string");
      expect(segment.speaker.trim()).not.toBe("");
      expect(segment.text.trim()).not.toBe("");
      expect(Number.isInteger(segment.startMs)).toBe(true);
      expect(segment.endMs).toBeGreaterThan(segment.startMs);

      if (i > 0) {
        expect(segment.startMs).toBeGreaterThanOrEqual(segments[i - 1].endMs);
      }
    });
  });

  it("uses unique ids", () => {
    const ids = [...key.mustAppear, ...key.mustNotAppear].map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(key.mustAppear.map((item) => [item.id, item] as const))(
    "expected item %s is backed by its evidence",
    (_id, item) => {
      expect(item.evidenceStartMs.length).toBeGreaterThan(0);

      const evidence = item.evidenceStartMs.map((ms) => {
        const segment = segments.find((s) => s.startMs === ms);
        expect(segment, `no segment starts at ${ms}`).toBeDefined();
        return segment!;
      });

      const evidenceText = evidence.map((s) => s.text).join(" ").toLowerCase();

      for (const term of item.match) {
        expect(evidenceText).toContain(term.toLowerCase());
      }

      if (item.owner) {
        expect(segments.map((s) => s.speaker)).toContain(item.owner);
      }

      if (item.dueDate) {
        expect(evidenceText).toContain(item.dueDate.toLowerCase());
      }
    }
  );

  it.each(key.mustNotAppear.map((item) => [item.id, item] as const))(
    "forbidden item %s is a real trap present in the transcript",
    (_id, item) => {
      for (const term of item.match) {
        expect(fullText).toContain(term.toLowerCase());
      }
      expect(item.reason.trim()).not.toBe("");
    }
  );
});

describe("project meeting fixture", () => {
  const { key, segments } = load("project-meeting.expected.json");

  it("has four speakers", () => {
    expect(new Set(segments.map((s) => s.speaker)).size).toBe(4);
  });

  it("has five tasks, three with relative deadlines, and one decision", () => {
    const tasks = ofKind(key, "actionItem");
    expect(tasks).toHaveLength(5);
    expect(tasks.filter((t) => t.dueDate)).toHaveLength(3);
    expect(ofKind(key, "decision")).toHaveLength(1);
  });
});

describe("lecture fixture", () => {
  const { key, segments } = load("lecture.expected.json");

  it('says "this will be on the exam" exactly twice', () => {
    const count = segments.filter((s) =>
      s.text.toLowerCase().includes("this will be on the exam")
    ).length;
    expect(count).toBe(2);
    expect(ofKind(key, "examTopic")).toHaveLength(2);
  });

  it("has one definition and one homework deadline", () => {
    expect(ofKind(key, "definition")).toHaveLength(1);

    const homework = ofKind(key, "homework");
    expect(homework).toHaveLength(1);
    expect(homework[0].dueDate).toBeTruthy();
  });
});
