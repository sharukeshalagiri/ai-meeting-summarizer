import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  allowedReason,
  checkPaths,
  databaseNameFor,
  globToRegExp,
  loadOwnership,
  ownsAiService,
  parseOwnership,
  portsForSlot,
  testSubject,
  trackForBranch,
} from "./ownership.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ownership = loadOwnership(path.join(root, "docs/OWNERSHIP.md"));
const { tracks, shared } = ownership;

const matches = (glob, p) => globToRegExp(glob).test(p);

describe("globToRegExp", () => {
  it("'**' at the end matches anything below, not the directory itself", () => {
    assert.ok(matches("extension/**", "extension/background.js"));
    assert.ok(matches("extension/**", "extension/icons/a/b.png"));
    assert.ok(!matches("extension/**", "extension"));
    assert.ok(!matches("extension/**", "extensions/x.js"));
  });

  it("'**/' matches zero or more directories", () => {
    assert.ok(matches("**/Dockerfile*", "Dockerfile"));
    assert.ok(matches("**/Dockerfile*", "backend/Dockerfile.prod"));
    assert.ok(matches("**/package.json", "package.json"));
    assert.ok(matches("**/package.json", "frontend/package.json"));
    assert.ok(!matches("**/package.json", "frontend/package.json.bak"));
  });

  it("'*' stays within one path segment", () => {
    assert.ok(matches("scripts/eval*", "scripts/eval-run.mjs"));
    assert.ok(!matches("scripts/eval*", "scripts/eval/run.mjs"));
    assert.ok(matches(".github/workflows/eval*.yml", ".github/workflows/eval-nightly.yml"));
  });

  it("escapes regex characters", () => {
    assert.ok(matches("docs/a.md", "docs/a.md"));
    assert.ok(!matches("docs/a.md", "docs/aXmd"));
    assert.ok(matches("a+b/(c)", "a+b/(c)"));
  });

  it("'?' matches one non-slash character", () => {
    assert.ok(matches("v?.txt", "v1.txt"));
    assert.ok(!matches("v?.txt", "v12.txt"));
  });
});

describe("parseOwnership", () => {
  it("reads every track from docs/OWNERSHIP.md with unique slots", () => {
    assert.deepEqual([...tracks.keys()], [
      "w1-ext", "w1-desk", "w1-asr", "w1-sum",
      "w2-spk", "w2-eval", "w2-bot", "w3-jobs", "w3-infra",
      "w4-acct", "w5-demo", "w5-acc",
    ]);
    assert.equal(tracks.get("w1-asr").slot, 3);
    assert.deepEqual(tracks.get("w1-asr").excludes, ["ai-service/diarization/**"]);
    assert.ok(shared.includes("backend/src/app.ts"));
  });

  it("rejects duplicate slots and malformed headers", () => {
    assert.throws(
      () => parseOwnership("```ownership\na slot=1\n  x\nb slot=1\n  y\n```"),
      /share a port slot/
    );
    assert.throws(() => parseOwnership("```ownership\nNot A Header\n```"), /Bad ownership header/);
    assert.throws(() => parseOwnership("no block"), /no ```ownership block/);
  });
});

describe("trackForBranch", () => {
  it("maps worktree, plain, prefixed and nested branch names", () => {
    assert.equal(trackForBranch("worktree-w1-ext", tracks), "w1-ext");
    assert.equal(trackForBranch("w1-sum", tracks), "w1-sum");
    assert.equal(trackForBranch("w1-sum/dates", tracks), "w1-sum");
    assert.equal(trackForBranch("track/w2-spk", tracks), "w2-spk");
    assert.equal(trackForBranch("chore/parallel-foundation", tracks), null);
    assert.equal(trackForBranch("worktree-unknown", tracks), null);
  });

  it("maps every track's lead+subagent branch <track>/impl", () => {
    for (const name of tracks.keys()) {
      assert.equal(trackForBranch(`${name}/impl`, tracks), name);
    }
  });

  it("enforces ownership on a <track>/impl branch", () => {
    const r = checkPaths({
      branch: "w1-asr/impl",
      paths: ["ai-service/main.py", "ai-service/diarization/x.py"],
      ownership,
    });
    assert.equal(r.mode, "track");
    assert.equal(r.track, "w1-asr");
    assert.deepEqual(r.violations.map((v) => v.path), ["ai-service/diarization/x.py"]);
  });
});

describe("testSubject", () => {
  it("strips test markers", () => {
    assert.equal(testSubject("a/b/foo.test.ts"), "a/b/foo.ts");
    assert.equal(testSubject("a/Foo.spec.tsx"), "a/Foo.tsx");
    assert.equal(testSubject("x/test_main.py"), "x/main.py");
    assert.equal(testSubject("x/main_test.py"), "x/main.py");
    assert.equal(testSubject("x/main.py"), null);
  });
});

describe("allowedReason", () => {
  const sum = tracks.get("w1-sum");
  const asr = tracks.get("w1-asr");

  it("allows owned paths and respects exclusions", () => {
    assert.equal(allowedReason("backend/src/prompts/lecture.ts", sum, shared), "owned");
    assert.equal(allowedReason("ai-service/whisper_runner.py", asr, shared), "owned");
    assert.equal(allowedReason("ai-service/diarization/pyannote.py", asr, shared), null);
  });

  it("allows shared registration files and the decision log", () => {
    assert.equal(allowedReason("backend/src/routes/index.ts", sum, shared), "shared registration file");
    assert.equal(allowedReason("frontend/package.json", sum, shared), "shared registration file");
    assert.equal(allowedReason(".env.example", sum, shared), "shared registration file");
    assert.equal(allowedReason("docs/decisions/w1-sum.md", sum, shared), "decision log");
    assert.equal(allowedReason("docs/decisions/w1-asr.md", sum, shared), null);
  });

  it("allows new files named after the track in the shared folders", () => {
    for (const p of [
      "backend/src/routes/w1-sum.routes.ts",
      "backend/src/controllers/w1-sum.controller.ts",
      "backend/src/services/w1-sum/modes.ts",
      "frontend/src/api/w1-sum.ts",
      "frontend/src/types/w1-sum.ts",
    ]) {
      assert.equal(allowedReason(p, sum, shared), "track-named file", p);
    }
  });

  it("rejects other tracks' names, unnamed files, and other folders", () => {
    assert.equal(allowedReason("backend/src/routes/w1-asr.routes.ts", sum, shared), null);
    assert.equal(allowedReason("backend/src/routes/summary.routes.ts", sum, shared), null);
    assert.equal(allowedReason("backend/src/repositories/w1-sum.repository.ts", sum, shared), null);
    assert.equal(allowedReason("frontend/src/components/w1-sum.tsx", sum, shared), null);
  });

  it("allows tests next to owned code and in the track test dir", () => {
    assert.equal(
      allowedReason("backend/src/services/summary.service.test.ts", sum, shared),
      "test next to owned code"
    );
    assert.equal(allowedReason("backend/test/w1-sum/modes.test.ts", sum, shared), "track test directory");
    assert.equal(allowedReason("backend/src/services/live.service.test.ts", sum, shared), null);
  });

  it("never allows prisma paths on a track", () => {
    assert.equal(allowedReason("backend/prisma/schema.prisma", sum, shared), null);
  });
});

describe("checkPaths", () => {
  it("passes a clean track branch", () => {
    const r = checkPaths({
      branch: "worktree-w1-ext",
      paths: ["extension/popup.html", "frontend/src/lib/capture/stereo.ts", "backend/src/app.ts"],
      ownership,
    });
    assert.equal(r.mode, "track");
    assert.deepEqual(r.violations, []);
  });

  it("flags unowned files and schema changes on a track branch", () => {
    const r = checkPaths({
      branch: "worktree-w1-ext",
      paths: ["frontend/src/api/api.ts", "backend/prisma/migrations/x/migration.sql"],
      ownership,
    });
    assert.deepEqual(r.violations.map((v) => v.path), [
      "frontend/src/api/api.ts",
      "backend/prisma/migrations/x/migration.sql",
    ]);
    assert.match(r.violations[1].reason, /schema/);
  });

  it("lets schema/ branches change prisma files only", () => {
    const ok = checkPaths({
      branch: "schema/speaker-enrollment",
      paths: ["backend/prisma/schema.prisma", "backend/prisma/migrations/1/migration.sql", "docs/SCHEMA_NOTES.md"],
      ownership,
    });
    assert.deepEqual(ok.violations, []);

    const bad = checkPaths({
      branch: "schema/x",
      paths: ["backend/src/services/live.service.ts"],
      ownership,
    });
    assert.equal(bad.violations.length, 1);
  });

  it("skips non-track branches", () => {
    const r = checkPaths({ branch: "chore/parallel-foundation", paths: ["anything"], ownership });
    assert.equal(r.mode, "skipped");
  });
});

describe("ports and names", () => {
  it("computes blocks arithmetically, including two-digit slots", () => {
    assert.deepEqual(portsForSlot(1), { backend: 5110, frontend: 5111, aiService: 5112 });
    assert.deepEqual(portsForSlot(9), { backend: 5190, frontend: 5191, aiService: 5192 });
    assert.deepEqual(portsForSlot(10), { backend: 5200, frontend: 5201, aiService: 5202 });
    assert.deepEqual(portsForSlot(89), { backend: 5990, frontend: 5991, aiService: 5992 });
  });

  it("fails clearly past port 6000 or on a bad slot", () => {
    assert.throws(() => portsForSlot(90), /past 6000/);
    assert.throws(() => portsForSlot(0), /Invalid port slot/);
    assert.throws(() => portsForSlot(1.5), /Invalid port slot/);
  });

  it("every configured slot yields valid, non-overlapping ports", () => {
    const all = [...tracks.values()].flatMap((t) => Object.values(portsForSlot(t.slot)));
    assert.equal(new Set(all).size, all.length);
    for (const p of all) assert.ok(![5000, 5173, 5432, 5433, 8000].includes(p));
  });

  it("knows which tracks run their own ai-service", () => {
    const own = [...tracks.values()].filter(ownsAiService).map((t) => t.name);
    assert.deepEqual(own, ["w1-asr", "w2-spk"]);
  });

  it("derives a safe database name", () => {
    assert.equal(databaseNameFor("w1-ext"), "ai_meeting_summarizer_w1_ext");
  });
});
