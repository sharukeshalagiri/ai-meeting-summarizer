# w4-acct decisions (accounts)

For the integrator to fold into `docs/DECISIONS.md` and `CLAUDE.md`.

## Auth library: Passport + express-session + @node-rs/argon2

- **Passport (`passport-local`)** handles email + password sign-in.
  It is the standard auth layer for Express, still maintained, and
  CommonJS. A Google login later is one more strategy.
  Passport 0.6+ regenerates the session on login and logout, which
  prevents session fixation.
- **express-session** (maintained by the Express team) handles the
  session, with our own small store over a Prisma `Session` table
  (`lib/auth/sessionStore.ts`):
  - The sessions live on the server, so signing out, or a password
    change ending every other session, takes effect at once. A signed,
    self-contained cookie can't be revoked.
  - The cookie is named `ams.sid` and is httpOnly, `SameSite=Lax`,
    `Secure` in production and rolling (`SESSION_MAX_AGE_DAYS`, default
    30). `proxy: true` trusts Caddy's `X-Forwarded-Proto`, so app-wide
    `trust proxy` stays unchanged.
  - `saveUninitialized: false`: there is no row and no cookie until
    login.
- **@node-rs/argon2** hashes passwords with argon2id at the library's
  defaults, which are the OWASP minimum (19 MiB, t=2, p=1), stored in
  the hash string. It ships prebuilt binaries for Windows and for glibc
  and musl Linux, so neither a laptop nor the Docker image needs
  node-gyp.
- **Why not Better Auth** (the current all-in-one, and what Lucia's
  author points to now):
  - It is ESM-only and its `exports` have no `require` condition. The
    backend compiles to CommonJS with node10 resolution
    (`tsconfig.json`, which no track owns), so its subpath imports, such
    as the Prisma adapter, don't resolve without changing the module
    system of the whole backend.
  - It brings its own table shapes for user, account, session and
    verification, which would mean reshaping `User` (an `emailVerified`
    column, the password on a separate `account` row) rather than adding
    to it.
  - Its route handler works on Web `Request` objects and is mounted
    beside Express, not through it.
  - For one user with email and password, these costs buy nothing
    we need.
- **Not Auth.js:** its Express adapter is experimental and it is built
  around OAuth providers.
- **Hardening:**
  - Every failed login gets the same 401 text.
  - Unknown emails still run an argon2 verify, so response time does
    not reveal which emails have accounts.
  - An in-memory throttle allows 10 failures per email and per IP in
    15 minutes, then answers 429.
  - Minimum password length is 10.
  - `GET /auth/me` never returns `passwordHash`
    (`user.repository.publicUserSelect`).
- **Not done:** CSRF tokens. SameSite=Lax already stops cross-site POSTs
  from carrying the cookie, and every state change is a POST, PUT, PATCH
  or DELETE. If the app ever moves to a different site than its API,
  this needs revisiting.

## Sign-up and the existing dev user

- `AUTH_ALLOW_SIGNUP` defaults to on outside production and off in
  production.
- `npm --prefix backend run user:password -- --email <e> [--name <n>]`
  (`--list` shows the users):
  - It sets a password for an existing user, such as the dev user that
    owns every pre-account meeting, or creates one with `--name`.
  - It ends that user's sessions.
  - The password is read from a hidden prompt or from stdin, never from
    argv.
- The code is in `src/lib/auth/cli.ts`, so the production image runs it
  as `node dist/lib/auth/cli.js` (`deploy/README.md`).
- **The "first user" fallback is gone.** A meeting's owner is always
  the signed-in user or the device token's account. A `userId` in a
  request body is ignored.

## Scoping every query (defence in depth)

1. **`routes/index.ts`** reads the session for every request.
   - `/auth` and `/health` are public, and `/live` has device auth.
   - Everything else is behind `requireUser`.
   - `router.use("/meetings/:id", requireMeetingAccess)` runs before any
     router that serves meeting sub-resources (meeting, w1-sum, w2-spk,
     w3-jobs, exports). Another account's meeting is a 404 identical to
     a missing one, and those controllers never run.
   - `/live/sessions/:id` has the same guard (`requireLiveSessionAccess`),
     placed before multer, so a chunk for someone else's session is
     never written to disk.
2. **Lists take a `userId` down to SQL:**
   - meetings, analytics (every aggregate), action items, transcripts,
     series, devices, users;
   - chat threads (`ChatMessage.userId`, new);
   - search: the raw SQL adds `m."userId" = $4` and an optional
     meeting-id array for a series.
3. **Single-row writes outside `/meetings/:id`** check the owner first
   (`services/account/access.service.ts`): action item status, a chat
   thread id (a guessed `conversationId` cannot read or extend someone
   else's thread), transcripts, series, device revoke, and "Since last
   time" applying a change to an earlier meeting's task.
- All ownership lookups are in `repositories/access.repository.ts`.
- **Tests:** `test/w4-acct/isolation.test.ts` lists every registered
  route and fails if a route or router is not classified.
  - Every id route, called by Alice with Bob's id, is a 404.
  - Every list or create route reaches its repositories with Alice's id
    only.
  - Every non-public route without a session is a 401.
  - A mutation check confirmed it: removing the `/meetings/:id` guard
    fails 27 tests.

### Test setup (`test/setup.auth.ts`, in `vitest.config.mts`)

- Route tests written before accounts send no credentials and mock only
  their own repositories. The setup file signs every request in as a
  default user (`x-test-user: <id>` picks another, `anonymous` none).
  It also makes every ownership lookup answer that user and resolves
  account settings to the defaults.
- w4-acct suites override these mocks per test, or `vi.unmock` the
  identity seam (`auth.test.ts` uses the real cookie path).
- Production code has no test bypass. The only seam is
  `lib/auth/currentUser.ts` `resolveUser`, which reads `req.user`.

## Per-user device tokens

- **Table:** `DeviceToken` holds the SHA-256 of a 256-bit random token
  (`amsd_` + base64url), a display prefix, `kind` (EXTENSION, DESKTOP,
  OTHER), `lastUsedAt` and `revokedAt`.
  - A fast hash is enough for a high-entropy secret, and it keeps lookup
    to one indexed equality.
  - The token is shown once.
- **Only the auth middleware changed** (`deviceAuth.middleware.ts`):
  - A Bearer token must belong to some account and not be revoked.
    Revocation is checked on every request, with no cache.
  - The request then runs as that account.
  - A bad token is a 401 even when a session cookie is also present: an
    explicit credential that fails never falls back to another.
  - With no header, the session is used. That is the web Live page.
- **Recorders are unchanged:** both already send
  `Authorization: Bearer <their setting>`, so the user pastes the new
  token into the same field.
- `test/w4-acct/devices.test.ts` replays both recorders' exact multipart
  uploads. After revoke, chunk, start, roster and end are all 401, and
  nothing is stored. One account's token cannot upload into another's
  session (404).
- **`DEVICE_TOKEN`** is deprecated and ignored, and no longer required
  in production. `SESSION_SECRET` is required in production instead
  (at least 32 characters).

## Settings

- **Columns:** added to `User` (additive migration), not a separate
  table. They are always read together with the user.
- **Display name:** the "You" label for unnamed mic profiles. It is
  used by w2-spk (`shownName(profile, meLabel)`, name-suggestion
  exclusions) and by exports, and resolved per meeting owner by
  `services/account/context.ts`.
  - Existing segment rows keep the label they were written with. The
    speaker list and exports show the new name.
  - Text-diarized uploads without a meeting context still use
    `ME_DISPLAY_NAME`.
- **Timezone:** the fallback for the w1-sum date resolver when the
  request does not name one.
- **Default mode:** applied when a meeting is created with no mode or
  with `AUTO` (recorders send `AUTO` by default).
- **Transcription provider:** per user, `local` or `deepgram`.
  - Deepgram can only be selected when the server has a key; otherwise
    the server's provider runs.
  - Uploads are looked up by their recording path, because the w3-jobs
    pipeline calls `transcribeAudioDetailed(path)` without a meeting id.
  - Live chunks pass `meetingId`.
- **Glossary:** appended to the transcription hints after the session
  hints and roster.
- **Lookups fail safe:** every settings lookup falls back to the server
  defaults on error. Settings refine processing and never fail it.

## Audio retention (scheduled job)

- **Job:** `Queues.AUDIO_RETENTION` (`audio-retention`) is registered in
  `jobs/definitions.ts` and `jobs/worker.ts`.
  - It is scheduled only by the server (`schedules: true`) on
    `RETENTION_CRON` (default `17 * * * *`, hourly, UTC).
  - The memory driver uses `*/60` because it only parses `*/N`.
  - `retryLimit: 0`: the next run picks up whatever is left.
- **Policies:**
  - `AFTER_PROCESSING` deletes the recording of any COMPLETED meeting
    with no active stage.
  - `AFTER_DAYS` does the same for meetings older than N days.
  - FAILED meetings keep their audio so they can be retried.
- **What is deleted:**
  - The upload file and every LiveChunk file are deleted, and then
    `Meeting.audioDeletedAt` is set and `audioPath` cleared.
  - A missing file counts as deleted, and a file that cannot be removed
    leaves its meeting for the next run.
  - LiveChunk rows stay (they are the idempotency record).
  - Transcripts, summaries, tasks and the search index are kept.

## Exports

- **One model, two renderers:** `services/export/exportModel.ts` builds
  a neutral document, rendered to Markdown and to PDF (pdfkit, pure JS,
  built-in Helvetica). Non-Latin-1 text becomes `?` in the PDF only;
  the Markdown keeps it exactly.
- **Names, not ids:** evidence becomes "Priya at 1:05", and the owner's
  label replaces the default "You". No database id appears (a test
  asserts this).
- **Noise and rejected items are left out:**
  - CLEAN-labelled small talk, logistics, filler and off-topic segments
    are dropped from the transcript.
  - Action items come from the ActionItem rows, minus task texts a human
    rejected.
  - Dismissed "Since last time" items are dropped.
- **Endpoints:**
  - `GET /meetings/:id/export?format=json|md|pdf&transcript=1`: `json`
    backs "copy as Markdown". CORS exposes `Content-Disposition`.
  - `POST /meetings/:id/export/email`: nodemailer over `SMTP_*`; with no
    `SMTP_HOST` it answers 503.
    - Recipients default to the owner's own address, at most 10.
    - The body is Markdown, with the PDF and `.md` attached, and
      `replyTo` is the owner.
- **Email testing:** tests use nodemailer's `jsonTransport`. No real
  mail is ever sent.

## Series, "Since last time", Prep, Ask by series

- **Series:** `Series` is unique per user and name. `Meeting.seriesId`
  is nullable, and deleting a series sets it to null. The meeting page
  has a picker that can also create a series.
- **"Since last time"** runs inside the w1-sum v2 summarize (`runNow`),
  only when the meeting is in a series and earlier meetings have open
  items. Then it is one Gemini call:
  - It covers up to 30 earlier PENDING items, newest first.
  - The transcript is sent without noise segments, capped at 60k
    characters.
  - The output is validated (`parseVerdicts`):
    - invented segment ids are dropped;
    - "done" without evidence is downgraded to "still open";
    - a missing verdict is "not mentioned".
  - It is stored in `Summary.data.sinceLastTime`, so it needs no column.
  - A failure only skips the section and never costs the summary.
  - A re-run keeps earlier dismissals.
  - The legacy fallback summary has no section.
- **Confirm or dismiss:**
  `POST /meetings/:id/since-last-time/:actionItemId {apply|dismiss}`.
  `apply` sets the earlier item to COMPLETED (after an owner check on
  that item) and records a `SINCE_LAST_TIME` Correction with the
  evidence idx values.
- **Prep:** `GET /series/:id/prep` returns the open items across the
  series, and the latest meeting's TL;DR, decisions, open questions,
  "prepare for next time" and "since last time".
- **Ask:** `seriesId` on `GET /search` and `POST /chat` restricts
  retrieval to the series' meetings. The Ask page has a series filter.

## Frontend

- **API client:** `api.ts` sends `withCredentials` and drops the
  `VITE_DEVICE_TOKEN` header. A 401 outside `/auth/` fires
  `ams:auth-required`, and Layout redirects to `/login?next=…`; only
  same-app paths are accepted for `next`.
- **Layout is the gate:** `AuthProvider` lives inside `Layout`, so
  `App.tsx` only gained routes.
- **Progress stream:** EventSource uses `withCredentials`
  (`useMeetingProgress.ts`).
- **Web Live page:** it uses the session cookie, through a `fetchImpl`
  with `credentials: "include"` (`useLiveCapture.ts`).
- **Playback:** `<audio>` sends the cookie by itself.
- **CORS** (`app.ts`): `credentials: true`. `CORS_ORIGIN=*` now
  reflects the caller's origin (development), and anything else is a
  comma-separated allow-list. Production is same-origin through Caddy.

## For the integrator

- **Env vars (CLAUDE.md table):** `SESSION_SECRET` (required in prod),
  `SESSION_MAX_AGE_DAYS`, `AUTH_ALLOW_SIGNUP`, `SMTP_HOST`, `SMTP_PORT`,
  `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` and
  `RETENTION_CRON`. Mark `DEVICE_TOKEN` and `VITE_DEVICE_TOKEN`
  deprecated.
- **CLAUDE.md:** "no owner check until auth exists" (playback) is now
  owner-checked, and the w3-jobs SSE auth TODO is done (cookie).
- **Extension popup placeholder:** "Only if the backend sets
  DEVICE_TOKEN" is out of date (w1-ext). It should say "from the
  Devices page".
- **Upload pipeline:** it could pass `{ meetingId }` to
  `transcribeAudioDetailed` (w3-jobs `pipeline.ts`), so settings need
  no path lookup.
