# w5-demo decisions (demo mode, public-instance safety, README)

For the integrator to fold into `docs/DECISIONS.md` and `CLAUDE.md`.

## The demo account: a fixed address, no schema change

- The demo account is the user `demo@example.com` (`src/demo/types.ts`).
  example.com is reserved, so no real person can own it. Recognising it
  by email needs no new column (no `schema/` branch) and works for the
  read-only check, which only has `req.user` (`{ id, name, email }`).
- It never has a password: the seed clears `passwordHash`, so the
  normal sign-in can't reach it. The only way in is
  `POST /api/demo/login`, which exists only with `DEMO_MODE=true` (off
  by default; 404 otherwise) and answers 503 with a hint when the demo
  was never seeded.
- passport regenerates the session on the demo sign-in (no fixation).
  The session lasts `DEMO_SESSION_HOURS` (default 2) instead of 30 days.
  The controller saves the session a second time so the store keeps the
  short `originalMaxAge`; without that the rolling cookie would grow
  back to 30 days on the next request (tested).

## Read-only is one deny-by-default middleware

- `middleware/demo.middleware.ts` runs right after the session is read,
  before every router. For the demo account, every method except GET,
  HEAD and OPTIONS is a 403 with one message, apart from
  `POST /auth/logout` and `POST /auth/login`. Paths are compared lower
  case without a trailing slash (Express matches them that way), and a
  mismatch can only refuse, never allow.
- Rejected alternative: a list of forbidden routes. A route added later
  by any track would be writable by the demo until someone remembered
  the list. Deny by default covers uploads, deletes, renames, settings,
  device tokens, email exports, re-summarize, chat and live capture,
  and anything added later.
- The one GET that calls Gemini is `GET /search` (it embeds the
  query). For the demo account it is answered by a keyword search over
  its own segments (`services/w5-demo.service.ts`), mounted before the
  real handler; everyone else falls through. Same result shape, so the
  Ask page works. The demo has no embeddings, because making them would
  call Gemini.
- `test/w5-demo/readOnly.test.ts` lists every registered route (same
  method as w4-acct's isolation test) and sends every non-GET one as
  the demo account: all are 403 and no repository, embedding or Gemini
  call runs. A new mutating route anywhere is covered automatically.

## Seed data: hand-written v2 summaries over the synthetic fixtures

- The three meetings (lecture, interview, project) use the transcripts
  of `fixtures/transcripts/` (a test checks them line for line), so the
  demo shows the same material the accuracy harness measures. The
  summaries are written by hand in `src/demo/content/*.ts`, in the
  pipeline's schemaVersion 2 shape, with mode sections, and respect the
  fixtures' answer keys: every must-appear item is there and cites an
  accepted segment, no must-not-appear trap is (tested).
- Evidence is written as segment idx numbers. `src/demo/build.ts` turns
  each into `{ idx, speaker, startMs }` from the real segment, the way
  VERIFY does, and throws on an idx that does not exist, so a chip can
  never point nowhere. Spoken dates are resolved by `lib/dates` against
  the meeting start, like the pipeline.
- Speakers follow w2-spk: the recording user is the `mic` profile and
  channel, others are `Speaker N` profiles with display names. Noise
  labels mark the small talk, asides and logistics, so the transcript's
  "Hide noise" works.
- The builder is pure (no env, Prisma or network): the seed, the tests
  and the screenshot runner share it.

## Audio: generated at seed time, never committed

- `.gitignore` excludes every audio format and CLAUDE.md forbids
  committing audio, so `demo:seed` generates the recordings:
  - Windows: SAPI through one PowerShell process (built in, offline).
  - Linux/macOS: `espeak-ng` or `espeak` if installed.
  - Otherwise: a soft tone per speaker, as long as the line would take
    to say. Playable and deterministic, clearly not speech.
- Each line is spoken separately and the clips are laid end to end in
  the capture contract's stereo layout (left = mic, right = others). The
  segment times come from the clip lengths, so every chip seeks to where
  its line is actually spoken.
- ffmpeg compresses the WAV to Ogg Opus at 40 kb/s when available
  (about 0.6 MB for 2.5 minutes); otherwise the WAV is kept.
- Files go to `STORAGE_DIR/demo/<key>.ogg`, through `lib/storage`.
  Measured: the interview takes about 9 s to generate with SAPI.

## Public-instance limits

- **Rate limits** (`middleware/rateLimit.middleware.ts`): in memory,
  fixed window, per user when signed in, else per client IP.
  - General: `RATE_LIMIT_PER_MINUTE` (300).
  - Heavy (uploads, processing, re-summarize, index, chat, email
    export, live session start, sign-in, sign-up, demo sign-in), on top
    of the general one: `RATE_LIMIT_HEAVY_PER_HOUR` (60).
  - `RATE_LIMIT_ENABLED` defaults to production only, so the existing
    route tests and local use are unaffected.
  - No dependency (express-rate-limit would add one to a package this
    track does not own). One backend process, so memory is enough; a
    restart only forgets counters.
  - Client IP: the app keeps `trust proxy` off. When the socket peer is
    a private or loopback address (Caddy on the compose network), the
    last `X-Forwarded-For` entry, the one Caddy appended, is the client.
    A direct internet peer is never private, so it cannot choose its
    key with a forged header.
- **Size and duration caps:** size stays `MAX_UPLOAD_MB` (multer).
  `MAX_AUDIO_MINUTES` (default 180 in production, 0 = off elsewhere):
  - `/transcribe`, `/process` and `/retry` measure the stored recording
    with ffprobe before work starts, and answer 413 when it is longer.
    If ffprobe fails, the request goes on and the failure is logged
    (fail open): the transcription timeout still bounds it, and a
    missing binary should not take processing down.
  - Live chunks are refused (413) once the session's `elapsedMs` reached
    the cap. That check runs before device auth (it is mounted ahead of
    the live router), so it can tell an unauthenticated caller that an
    unguessable session id exists and is long; nothing else.
  - `POST /:id/upload` stores and transcribes in one request, so there
    is no moment to measure the file. While a cap is set it answers 400
    and points to `/audio` + `/process` (what the web app uses). See the
    request below to lift this.
- **Retention:** the demo account's own audio is `KEEP` (the seed sets
  it), demo sessions expire after `DEMO_SESSION_HOURS` and the session
  store sweeps them, sign-up is off in production (w4-acct), and the
  w4-acct retention job applies to real accounts. Re-running `demo:seed`
  resets the demo account completely.

## Screenshots: the real frontend, the API mocked from the seed builder

- `npm run screenshots` runs `e2e/screenshots/` (Playwright, one
  headless chromium, one Vite dev server) with the API answered in the
  browser from `buildDemoMeetings()` and tone audio. It writes
  `docs/images/*.png` (25–80 KB each, 1280×800, scale 1).
- A real local stack would need Docker, Postgres, the backend and the
  seed: about 2 GB more on a laptop with about 1 GB free. The mock
  serves the same data the seed writes, so the pictures match.
- Each step asserts what it photographs (the TL;DR, the exam section,
  the highlighted cited line), so a broken page fails instead of being
  photographed.

## README accuracy table: generated, with its source named

- `scripts/readme-accuracy.mjs` rewrites the block between
  `<!-- accuracy:start -->` and `<!-- accuracy:end -->` from the newest
  `eval/reports/*.json` (by name: date, then run number; mtimes are not
  reliable after a checkout). With no report it says "Not yet measured"
  and prints no number (tested).
- The block names its source (`<!-- source: ... -->`). The test checks
  that the committed block is exactly the generator's output for that
  source, so a hand edit fails CI. It does not require the newest
  report: otherwise w5-acc committing a report would turn every PR red
  until someone regenerated the README (which only w5-demo owns).
  `--check` prints a note when a newer report exists.
- The metric labels are copied from `eval/src/report.ts`; a test parses
  that file and fails if they drift.

## For the integrator

### Requests for other tracks (files this track does not own)

1. **`frontend/src/components/MeetingCard.tsx` (bug on main):** the
   meeting list reads the version 1 summary shape
   (`summary.keyDecisions.length`, `summary.blockers.length`,
   `summary.executiveSummary`). Every schemaVersion 2 summary (every
   summary since w1-sum) throws "Cannot read properties of undefined
   (reading 'length')", and with no error boundary the Meetings page
   goes blank. Fix: branch on `schemaVersion === 2` and read `tldr`,
   `decisions.length` and the project blockers, or guard with `?? []`.
   The screenshot runner has a "meeting list" step that skips itself
   while this fails, and takes `docs/images/meetings.png` once fixed.
2. **`frontend/src/components/Layout.tsx`:** render
   `<DemoBanner email={account.email} />` (from
   `components/demo/DemoBanner.tsx`) under the header, so demo visitors
   see "read-only" before an edit is refused.
3. **`backend/test/w4-acct/isolation.test.ts`:** classify
   `GET /api/demo/` and `POST /api/demo/login` as `public`, add
   `["/api/demo", demoRouter]` to `mounts()`, and then mount `demoRouter`
   directly in `routes/index.ts`. Until then `routes/w5-demo.routes.ts`
   exports a function wrapping the router, so that test's sub-router
   count is unchanged; `test/w5-demo/` covers both routes.
4. **`backend/src/services/meeting.service.ts` `processMeeting`:** call a
   duration check on the stored file (export it from
   `middleware/rateLimit.middleware.ts` as a service helper) so
   `POST /:id/upload` can be reopened while `MAX_AUDIO_MINUTES` is set.
5. **Deploy (`docker-compose.prod.yml`, `deploy/.env.example`,
   `deploy/README.md`, `backend/Dockerfile`):** pass `DEMO_MODE`,
   `DEMO_SESSION_HOURS`, `RATE_LIMIT_*` and `MAX_AUDIO_MINUTES`; document
   `docker compose run --rm backend node dist/demo/seed.js` for the
   public instance; optionally `apt-get install espeak-ng` in the backend
   image so the seeded audio is speech, not tones.

### CLAUDE.md

- Env table: `DEMO_MODE` (false), `DEMO_SESSION_HOURS` (2),
  `RATE_LIMIT_ENABLED` (production), `RATE_LIMIT_PER_MINUTE` (300),
  `RATE_LIMIT_HEAVY_PER_HOUR` (60), `MAX_AUDIO_MINUTES` (180 in
  production, 0 elsewhere), `FFPROBE_PATH` (ffprobe), and `DEMO_TTS`
  (seed only: auto | sapi | espeak | tones).
- Commands: `npm --prefix backend run demo:seed`, `npm run screenshots`
  (needs `npm run setup:e2e`), `npm run readme:accuracy [-- --check]`.
- Routes: `/api/demo` (public), the demo read-only rule, and the keyword
  search for the demo account.
