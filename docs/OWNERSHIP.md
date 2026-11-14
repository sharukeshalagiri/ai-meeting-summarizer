# Track ownership

Which paths each parallel track may change. `scripts/check-ownership.mjs`
(`npm run check:ownership`, and a CI job on every PR) enforces this, and
`scripts/worktree-env.mjs` reads the port slot from it. **The fenced
`ownership` block below is the source of truth**, so update it, not a copy.

Rules: see [docs/PARALLEL.md](PARALLEL.md).

## How a path is allowed

For a branch named `worktree-<track>`, `<track>`, `<track>/...` or
`track/<track>`, a changed path passes when **any** of these is true:

1. It matches one of the track's globs (and none of its `!` exclusions).
2. It is a **shared registration file** (the `[shared]` section). These
   are append-only: add a few lines, never reformat.
3. It is `docs/decisions/<track>.md`.
4. It lives in `backend/src/controllers/`, `backend/src/routes/`,
   `backend/src/services/`, `frontend/src/api/` or `frontend/src/types/`
   **and its name contains the track id**, e.g.
   `backend/src/routes/w1-sum.routes.ts`, `frontend/src/api/w1-sum.ts`.
   Use this to *create* new files. Changing an existing file in those
   folders that you don't own still goes through "Requests for other
   tracks".
5. It is a test next to code the track owns: `foo.test.ts` next to an
   owned `foo.ts`, or `test_foo.py` next to an owned `foo.py`. It may also
   live under `backend/test/<track>/` or `frontend/test/<track>/`.

Any change under `backend/prisma/` (schema or migrations) fails on a track
branch. Schema changes go on a separate `schema/<name>` branch (gate c),
which may only touch `backend/prisma/**`, `docs/SCHEMA_NOTES.md`, the
shared files and `docs/decisions/`.

Branches that are neither track nor `schema/` branches (`chore/*`, the
integrator) are not checked. Those are run by the human or the integrator
session.

## Ports

Each track has a fixed **slot**: `base = 5100 + 10 * slot`. The backend
uses `base`, the frontend `base + 1` and the ai-service `base + 2`. Slots
must be unique and the highest port must stay at or below 6000, so slots
go up to 89. The main checkout keeps the defaults (5000 / 5173 / 8000).

| Track | Slot | Backend | Frontend | ai-service |
| --- | --- | --- | --- | --- |
| w1-ext | 1 | 5110 | 5111 | shared :8000 |
| w1-desk | 2 | 5120 | 5121 | shared :8000 |
| w1-asr | 3 | 5130 | 5131 | **own 5132** |
| w1-sum | 4 | 5140 | 5141 | shared :8000 |
| w2-spk | 5 | 5150 | 5151 | **own 5152** |
| w2-eval | 6 | 5160 | 5161 | shared :8000 |
| w2-bot | 7 | 5170 | 5171 | shared :8000 |
| w3-jobs | 8 | 5180 | 5181 | shared :8000 |
| w3-infra | 9 | 5190 | 5191 | shared :8000 |
| w4-acct | 10 | 5200 | 5201 | shared :8000 |
| w5-demo | 11 | 5210 | 5211 | shared :8000 |
| w5-acc | 12 | 5220 | 5221 | shared :8000 |

Tracks that own files under `ai-service/` run their own ai-service.
Everyone else uses the main checkout's on port 8000 (start it there with
`npm run dev:ai`).

## Overlaps to know about

- `backend/src/services/live.service.ts` is owned by **w2-spk** and
  **w3-jobs**. They are in different waves, so they never run at the same
  time; w3-jobs rebases on whatever w2-spk merged.
- **w4-acct** has broad backend ownership (middleware, repositories,
  controllers, routes) because it scopes every query by user. It runs
  alone (no other track in parallel). w5-demo and w5-acc run after it
  and do not overlap each other. w3-jobs and w5-acc both list
  `w1-sum.service.ts`; they run in different steps.
- Files no track owns (for example `frontend/src/api/api.ts`,
  `backend/src/controllers/meeting.controller.ts`, `backend/src/lib/gemini.ts`)
  change only through "Requests for other tracks" in a PR. The integrator
  picks those up.

## Ownership data

```ownership
[shared]
  backend/src/routes/index.ts
  backend/src/app.ts
  backend/src/lib/env.ts
  frontend/src/App.tsx
  ai-service/main.py
  **/package.json
  **/package-lock.json
  **/.env.example
  .gitignore
  ai-service/requirements.txt

w1-ext slot=1
  extension/**
  frontend/src/hooks/useLiveCapture.ts
  frontend/src/pages/LiveMeeting.tsx
  frontend/src/lib/capture/**

w1-desk slot=2
  desktop-recorder/**

w1-asr slot=3
  ai-service/**
  !ai-service/diarization/**
  backend/src/services/speech.service.ts
  backend/src/providers/transcription/**
  scripts/benchmark-transcription*

w1-sum slot=4
  backend/src/services/summary.service.ts
  backend/src/prompts/**
  backend/src/lib/dates/**
  backend/src/types/summary.ts
  backend/src/services/actionItem.service.ts
  backend/src/repositories/actionItem.repository.ts
  frontend/src/components/SummaryView.tsx
  frontend/src/components/summary/**
  frontend/src/pages/Tasks.tsx

w2-spk slot=5
  backend/src/services/diarization.service.ts
  backend/src/services/speakers/**
  backend/src/services/live.service.ts
  backend/src/repositories/speakerProfile.repository.ts
  ai-service/diarization/**
  frontend/src/components/TranscriptView.tsx
  frontend/src/components/transcript/**

w2-eval slot=6
  eval/**
  fixtures/**
  e2e/**
  scripts/eval*
  scripts/fetch-ami*
  .github/workflows/eval*.yml

w2-bot slot=7
  bot/**
  frontend/src/pages/Notetaker.tsx

w3-jobs slot=8
  backend/src/jobs/**
  backend/src/services/meeting.service.ts
  backend/src/services/live.service.ts
  backend/src/lib/storage/**
  frontend/src/components/progress/**
  frontend/src/pages/MeetingDetails.tsx
  backend/src/repositories/liveChunk.repository.ts
  backend/src/repositories/meeting.repository.ts
  backend/src/services/w1-sum.service.ts
  backend/src/controllers/meeting.controller.ts

w3-infra slot=9
  **/Dockerfile*
  deploy/**
  docker-compose.prod.yml
  .github/workflows/release*.yml

w4-acct slot=10
  backend/src/middleware/**
  backend/src/repositories/**
  backend/src/controllers/**
  backend/src/routes/**
  backend/src/services/meeting.service.ts
  backend/src/services/user.service.ts
  backend/src/services/search.service.ts
  backend/src/services/analytics.service.ts
  backend/src/services/auth/**
  backend/src/services/account/**
  backend/src/services/export/**
  backend/src/services/series/**
  backend/src/services/retention/**
  backend/src/lib/auth/**
  backend/scripts/**
  frontend/src/api/api.ts
  frontend/src/lib/auth/**
  frontend/src/components/Layout.tsx
  frontend/src/components/account/**
  frontend/src/components/export/**
  frontend/src/components/series/**
  frontend/src/pages/Login.tsx
  frontend/src/pages/Settings.tsx
  frontend/src/pages/Devices.tsx
  frontend/src/pages/Prep.tsx
  frontend/src/pages/Ask.tsx
  frontend/src/pages/MeetingDetails.tsx
  frontend/src/components/summary/**
  backend/src/services/live.service.ts
  backend/src/services/speech.service.ts
  backend/src/services/w1-sum.service.ts
  backend/src/lib/dates/**

w5-demo slot=11
  backend/src/demo/**
  backend/src/middleware/rateLimit*
  backend/src/middleware/demo*
  demo/**
  frontend/src/components/demo/**
  frontend/src/pages/Login.tsx
  README.md
  docs/DEMO_SCRIPT.md
  docs/images/**
  scripts/readme*
  scripts/screenshots*
  e2e/screenshots/**

w5-acc slot=12
  backend/src/prompts/**
  backend/src/services/w1-sum.service.ts
  backend/src/services/w1-sum.parsers.ts
  backend/src/services/summary.service.ts
  backend/src/services/speech.service.ts
  backend/src/services/speakers/matcher.ts
  backend/src/lib/hints/**
  eval/reports/**
  eval/baseline.json
```
