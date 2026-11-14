# Parallel tracks

Several Claude Code sessions work at the same time, each in its own git
worktree (`claude --worktree <track>`, which creates branch
`worktree-<track>` under `.claude/worktrees/`), and each ends in **one
PR**. These rules keep them from colliding. Every track session follows
them, along with the operating mode in [CLAUDE.md](../CLAUDE.md).

## Start

1. `npm run worktree:env <track>`. It writes `backend/.env`,
   `frontend/.env` and `ai-service/.env` with your track's ports and
   database (`ai_meeting_summarizer_<track>`), installs dependencies and
   runs migrations. **Use only the ports and database it sets.**
2. Read [docs/OWNERSHIP.md](OWNERSHIP.md) for your globs, and the contracts
   you build on: [CAPTURE_CONTRACT.md](CAPTURE_CONTRACT.md) and
   [SCHEMA_NOTES.md](SCHEMA_NOTES.md).
3. Plan, then wait for approval (gate a).

If your track does not own `ai-service/` files, your backend uses the
**shared ai-service** in the main checkout on `:8000`. Ask the engineer to
keep it running (`npm run dev:ai` there); don't start your own.

## Rules

- **Edit only the paths your track owns** in `docs/OWNERSHIP.md`. Need a
  change elsewhere? Don't make it. List it under **"Requests for other
  tracks"** in your PR, with the file, the change and the reason.
- You **may create** new files whose name contains your track id in
  `backend/src/controllers/`, `backend/src/routes/`,
  `backend/src/services/`, `frontend/src/api/` and `frontend/src/types/`
  (e.g. `backend/src/routes/w1-sum.routes.ts`). Editing existing unowned
  files there still goes through "Requests for other tracks".
- You may add tests next to code you own, under `backend/test/<track>/`,
  and `docs/decisions/<track>.md`.
- **Never edit `backend/prisma/schema.prisma` or migrations** (gate c).
  If you need a schema change, stop and ask. It happens on a separate
  `schema/<name>` branch.
- **Never edit `CLAUDE.md` or `docs/DECISIONS.md`.** Write your decisions
  in `docs/decisions/<track>.md`. The integrator folds them in.
- **Shared registration files are append-only**: add a few lines and
  don't reformat or reorder anything. They are `backend/src/routes/index.ts`,
  `backend/src/app.ts`, `backend/src/lib/env.ts`, `frontend/src/App.tsx`,
  `ai-service/main.py`, every `package.json` / `package-lock.json`, and
  every `.env.example`.
- **New dependencies only in a package you own.** On a lockfile
  conflict, take origin/main's lockfile, re-run `npm install` in that
  package so your dependency is added back, then `git add` the lockfile
  and continue. Never hand-merge a lockfile. Which side is origin/main
  depends on the operation:
  - during a **rebase**, origin/main is "ours": `git checkout --ours <lockfile>`, then `git rebase --continue`.
  - during a **merge**, origin/main is "theirs": `git checkout --theirs <lockfile>`, then `git commit`.
- **Commit locally after each milestone** (for example `wip: providers
  done`). WIP commits are fine and need no squash, because PRs are
  squash-merged on GitHub. Never push before the finish protocol.
- **Catching up with main:** rebase only before a branch's first push.
  Once a branch is pushed, catch up with `git fetch origin && git merge
  origin/main`. A rebased branch would need a force-push, and
  force-pushing is denied.
- **Deleting files:** you may delete an uncommitted scratch file that
  your own session created. Anything committed, or created by someone
  else, needs the engineer's OK (gate d).
- Segment references (summary evidence, citations, corrections,
  `jumpToSegment`) always use **`TranscriptSegment.idx`, never array
  positions**. Live idx values are sparse (`seq * 1000 + i`).
- **Never** push to `main`, force-push, merge your own PR, touch other
  worktrees or branches, or commit secrets, `.env` files, recordings or
  real transcripts. The repo is public, so fixtures must be synthetic.

## Finish protocol

Run these in order and fix any failure yourself before moving on:

1. Typecheck and tests for every package you touched
   (`npm --prefix backend run typecheck && npm --prefix backend test`,
   `npm --prefix frontend run typecheck && npm --prefix frontend run lint && npm --prefix frontend run build`,
   `npm run test:ai`, `npm run test:scripts`; or `npm run check` for all).
2. `npm run check:ownership`. It must pass.
3. Write `docs/decisions/<track>.md`: the decisions, the alternatives
   considered and anything the integrator must know.
4. Commit.
5. Catch up with main: `git fetch origin && git rebase origin/main` if
   the branch has never been pushed, otherwise `git merge origin/main`
   (see "Catching up with main" above).
6. Re-run the tests from step 1.
7. Push your branch by name: `git push -u origin <your-branch>` (e.g.
   `worktree-w1-sum` or `w1-sum/impl`). A bare `git push` is denied,
   because it follows the upstream and could target `main`.
8. `gh pr create --base main --label wave-<n>` and fill in the PR template
   (`.github/pull_request_template.md`). Files outside ownership must be
   "None".
9. Wait for CI (`gh pr checks --watch`) and fix any failure yourself.
10. Report the PR URL and a summary of 5 lines or fewer.

**Merging is done later by the integrator session, after the engineer
approves.** Do not merge.

## Lead + subagent mode

The alternative to one terminal per track: **one terminal**, where a
**lead session** builds tracks in pairs using the `track-builder`
subagent (`.claude/agents/track-builder.md`, `isolation: worktree`).

1. **Pairs.** The lead starts two `track-builder` subagents at a time, one
   per track in the pair (e.g. w1-ext + w1-desk). Each works in its own
   isolated worktree.
2. **Branches.** Each subagent creates `<track>/impl` (e.g. `w1-sum/impl`)
   and runs `npm run worktree:env <track>`. `check-ownership` maps
   `<track>/impl` to the track (tested in `scripts/lib/ownership.test.mjs`),
   so the same ownership rules and CI checks apply.
3. **Plans first.** Each subagent returns only a plan (files, tests,
   risks, decisions needed) and makes no edits. The lead shows **both plans
   to the engineer together** and resumes each subagent with the approval
   or changes (gate a).
4. **Decisions.** Subagents can't ask the engineer anything. At any gate
   they stop and return a block starting `DECISION NEEDED:` with 2–3
   options and a recommendation. The lead relays it word for word and
   resumes the subagent with the answer.
5. **Build.** Each subagent implements, tests and follows the finish
   protocol up to an open PR with green CI, then reports in 5 lines or
   fewer plus the PR URL. If a subagent lacks a tool (e.g. a gated
   command), it says so and the lead does that step.
6. **Merging.** Only the lead merges, and only after the engineer
   approves (gate b). Subagents never merge.

## Crash recovery

If a session or subagent dies mid-build (power loss, crash), its
uncommitted work is still on disk in its worktree, but a new subagent
may not be able to run git in that worktree.

1. Relaunch the builder in a **new worktree** from the same base, with
   its original brief and a resume note that names the old worktree.
2. It copies the old worktree's work over, checks it first (diff
   against the approved plan, files cut off mid-write, typecheck,
   tests), fixes anything damaged, and reports one line: "integrity OK"
   or what it fixed.
3. It pushes as **`<track>/impl-resume`**. `check-ownership` maps this
   name to the track, like `<track>/impl`.
4. The lead lists the old worktree and its branch for cleanup (gate d).
   Neither is deleted without the engineer's OK.

## Unattended mode

For a run the engineer will not watch (e.g. overnight), with a
**pre-approved list of PRs** that may be merged. The lead session only;
subagents never do this.

1. **Back up first.** Copy `.claude/settings.json` byte for byte into
   the session's scratchpad and record its SHA-256
   (`sha256sum`, or `Get-FileHash -Algorithm SHA256` on Windows).
2. **Relax only what the run needs.** Temporarily move the `ask` rules
   for `git push` and `gh pr merge` to `allow`. Every `deny` rule stays
   (no force-push, no push to `main`). Personal overrides for the run go
   in `.claude/settings.local.json`.
3. **Crash safety.** A session that starts and finds
   `.claude/settings.json` modified (`git diff` not empty) restores it
   from the backup (or `main`) before doing anything else, and says so
   in the first line of its report.
4. **Before every `gh pr merge`,** print the PR number and its branch
   and check both against the pre-approved list. Anything not on the
   list is not merged.
5. **Everything else is queued as a decision** for the engineer, not
   done: gates (c), (d), (e) and (f), merge conflicts that touch logic,
   any plan that goes beyond its brief, and anything that failed twice.
6. **At the end, restore byte-exact:** copy the backup back, confirm
   `git diff .claude/settings.json` is empty and the SHA-256 matches the
   recorded one, and remove `.claude/settings.local.json` (the run's
   overrides). Put both confirmations (empty diff + SHA match, local
   file removed) at the top of the end report, followed by the queued
   decisions.
