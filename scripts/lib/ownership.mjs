/**
 * Ownership rules for parallel tracks, shared by check-ownership.mjs and
 * worktree-env.mjs. The data lives in docs/OWNERSHIP.md (the fenced
 * ```ownership block) so humans and scripts read the same source.
 *
 * Pure functions only; tested by ownership.test.mjs (node --test).
 */
import fs from "node:fs";

/** Converts a glob (`*`, `**`, `?`) to an anchored RegExp. */
export function globToRegExp(glob) {
  let re = "";

  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];

    if (c === "*" && glob[i + 1] === "*") {
      const atSegmentStart = i === 0 || glob[i - 1] === "/";

      if (atSegmentStart && glob[i + 2] === "/") {
        // "**/" matches zero or more whole directories.
        re += "(?:.*/)?";
        i += 2;
      } else {
        // "**" elsewhere (e.g. trailing "/**") matches anything.
        re += ".*";
        i += 1;
      }
      continue;
    }

    if (c === "*") {
      re += "[^/]*";
      continue;
    }

    if (c === "?") {
      re += "[^/]";
      continue;
    }

    re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }

  return new RegExp(`^${re}$`);
}

export const matchesAny = (path, globs) =>
  globs.some((glob) => globToRegExp(glob).test(path));

/**
 * Parses the ```ownership block:
 *
 *   [shared]
 *     backend/src/app.ts
 *   w1-ext slot=1
 *     extension/**
 *     !extension/vendor/**      (exclusion)
 */
export function parseOwnership(markdown) {
  const block = /```ownership\r?\n([\s\S]*?)```/.exec(markdown);

  if (!block) {
    throw new Error("docs/OWNERSHIP.md has no ```ownership block");
  }

  const tracks = new Map();
  const shared = [];
  let current = null;

  for (const raw of block[1].split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trimEnd();

    if (!line.trim()) continue;

    if (!/^\s/.test(line)) {
      const header = line.trim();

      if (header === "[shared]") {
        current = { globs: shared, excludes: [] };
        continue;
      }

      const m = /^([a-z0-9][a-z0-9-]*)\s+slot=(\d+)$/.exec(header);

      if (!m) throw new Error(`Bad ownership header: "${header}"`);

      const [, name, slot] = m;

      if (tracks.has(name)) throw new Error(`Duplicate track ${name}`);

      current = { name, slot: Number(slot), globs: [], excludes: [] };
      tracks.set(name, current);
      continue;
    }

    if (!current) throw new Error(`Glob outside a section: "${line}"`);

    const glob = line.trim();

    if (glob.startsWith("!")) current.excludes.push(glob.slice(1));
    else current.globs.push(glob);
  }

  const slots = [...tracks.values()].map((t) => t.slot);

  if (new Set(slots).size !== slots.length) {
    throw new Error("Two tracks share a port slot in docs/OWNERSHIP.md");
  }

  return { tracks, shared };
}

export const loadOwnership = (file) =>
  parseOwnership(fs.readFileSync(file, "utf8"));

/**
 * Branch name to track: worktree-w1-ext, w1-ext, w1-ext/anything,
 * track/w1-ext. Returns null for non-track branches.
 */
export function trackForBranch(branch, tracks) {
  const candidates = [
    branch.replace(/^worktree-/, ""),
    branch.split("/")[0],
    branch.replace(/^track\//, "").split("/")[0],
  ];

  return candidates.find((name) => tracks.has(name)) ?? null;
}

export const isSchemaPath = (path) => path.startsWith("backend/prisma/");

/** Directories where any track may create files named after itself. */
export const TRACK_NAMED_DIRS = [
  "backend/src/controllers/",
  "backend/src/routes/",
  "backend/src/services/",
  "frontend/src/api/",
  "frontend/src/types/",
];

/** foo.test.ts -> foo.ts; test_foo.py -> foo.py; null if not a test. */
export function testSubject(path) {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  const base = path.slice(slash + 1);

  const js = /^(.*)\.(test|spec)\.([cm]?[jt]sx?)$/.exec(base);
  if (js) return dir + `${js[1]}.${js[3]}`;

  const pyPrefix = /^test_(.+\.py)$/.exec(base);
  if (pyPrefix) return dir + pyPrefix[1];

  const pySuffix = /^(.+)_test\.py$/.exec(base);
  if (pySuffix) return dir + `${pySuffix[1]}.py`;

  return null;
}

/**
 * Why `path` is allowed for `track`, or null when it is not.
 * `track` is a parsed track object; `shared` the shared globs.
 */
export function allowedReason(path, track, shared) {
  const owns = (p) =>
    matchesAny(p, track.globs) && !matchesAny(p, track.excludes);

  if (isSchemaPath(path)) return null; // only schema/ branches, see below

  if (owns(path)) return "owned";

  if (matchesAny(path, shared)) return "shared registration file";

  if (path === `docs/decisions/${track.name}.md`) return "decision log";

  for (const dir of TRACK_NAMED_DIRS) {
    if (path.startsWith(dir) && path.slice(dir.length).includes(track.name)) {
      return "track-named file";
    }
  }

  if (
    path.startsWith(`backend/test/${track.name}/`) ||
    path.startsWith(`frontend/test/${track.name}/`)
  ) {
    return "track test directory";
  }

  const subject = testSubject(path);
  if (subject && owns(subject)) return "test next to owned code";

  return null;
}

/** Paths a schema/ branch may touch besides the shared files. */
const SCHEMA_BRANCH_GLOBS = ["backend/prisma/**", "docs/SCHEMA_NOTES.md"];

/**
 * Checks a list of changed paths. Returns { mode, violations[] } where
 * mode is "track", "schema" or "skipped".
 */
export function checkPaths({ branch, paths, ownership }) {
  const { tracks, shared } = ownership;

  if (branch.startsWith("schema/")) {
    const violations = paths.filter(
      (p) =>
        !matchesAny(p, SCHEMA_BRANCH_GLOBS) &&
        !matchesAny(p, shared) &&
        !p.startsWith("docs/decisions/")
    );

    return {
      mode: "schema",
      violations: violations.map((path) => ({
        path,
        reason: "schema/ branches may only change prisma files and docs",
      })),
    };
  }

  const name = trackForBranch(branch, tracks);

  if (!name) return { mode: "skipped", violations: [] };

  const track = tracks.get(name);
  const violations = [];

  for (const path of paths) {
    if (isSchemaPath(path)) {
      violations.push({
        path,
        reason:
          "schema or migration change: only allowed on a schema/ branch (gate c)",
      });
      continue;
    }

    if (!allowedReason(path, track, shared)) {
      violations.push({ path, reason: `not owned by ${name}` });
    }
  }

  return { mode: "track", track: name, violations };
}

/** Port block for a track slot; throws past 6000. */
export function portsForSlot(slot) {
  if (!Number.isInteger(slot) || slot < 1) {
    throw new Error(`Invalid port slot ${slot}`);
  }

  const base = 5100 + 10 * slot;
  const ports = { backend: base, frontend: base + 1, aiService: base + 2 };

  if (ports.aiService > 6000) {
    throw new Error(
      `Slot ${slot} would use ports up to ${ports.aiService}, past 6000. ` +
        "Pick a lower free slot in docs/OWNERSHIP.md."
    );
  }

  return ports;
}

/** Tracks that run their own ai-service: they own files under it. */
export const ownsAiService = (track) =>
  track.globs.some((glob) => glob.startsWith("ai-service/"));

export const databaseNameFor = (track) =>
  `ai_meeting_summarizer_${track.replace(/[^a-z0-9]/gi, "_").toLowerCase()}`;
