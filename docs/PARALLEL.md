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
- **New dependencies only in a package you own.** On a lockfile conflict
  during rebase, take origin/main's lockfile with
  `git checkout --ours <lockfile>` (during a rebase, "ours" is the branch
  you are rebasing onto, i.e. origin/main). Then re-run `npm install` in
  that package so your dependency is added back, `git add` the lockfile
  and `git rebase --continue`. Never hand-merge a lockfile.
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
5. `git fetch origin && git rebase origin/main`.
6. Re-run the tests from step 1.
7. Push your branch (`git push -u origin worktree-<track>`).
8. `gh pr create --base main --label wave-<n>` and fill in the PR template
   (`.github/pull_request_template.md`). Files outside ownership must be
   "None".
9. Wait for CI (`gh pr checks --watch`) and fix any failure yourself.
10. Report the PR URL and a summary of 5 lines or fewer.

**Merging is done later by the integrator session, after the engineer
approves.** Do not merge.
