# w3-infra decisions

Production images, `docker-compose.prod.yml`, deploy guide and the
release workflow. Everything here is new files. There are no changes to
app code, CI or the schema.

## Images

| Image | Base (pinned) | Why |
| --- | --- | --- |
| backend | `node:22.23.4-bookworm-slim` (build + runtime) | glibc + OpenSSL 3 are what Prisma's engines target. Alpine/musl is a common source of "Query Engine not found". `openssl` is installed in both stages so `prisma generate` picks the same target. `tini` is PID 1. |
| ai-service | `python:3.12.15-slim-bookworm` | ctranslate2, onnxruntime and PyAV publish manylinux wheels (amd64 and arm64). No torch, no CUDA, no ffmpeg binary (PyAV bundles the libs). |
| web | build on node slim, serve on `nginxinc/nginx-unprivileged:1.30.6-alpine` | Non-root nginx on :8080. The SPA fallback and `/healthz` are inlined with a Dockerfile heredoc (`# syntax=docker/dockerfile:1.7`), so the build context stays `frontend/`. |

- **Non-root everywhere we build:** `node` (1000) for the backend, `app`
  (**1000**, deliberately the same uid) for the ai-service, and nginx 101.
  The ai-service shares the `uploads` volume with the backend, and Docker
  copies the first mounter's directory ownership into an empty named
  volume. With equal uids, it doesn't matter which container mounts it
  first. The ai-service mount is also `:ro`, since it only reads.
- **Same mount path in both containers** (`/app/uploads`): the backend
  sends `path.resolve(UPLOAD_DIR/...)`, and the ai-service opens it
  directly (see CLAUDE.md, "The ai-service reads the file by path").
- **Whisper model not baked in:** `HF_HOME=/models` sits on the
  `whisper_models` volume, so the first transcription downloads about
  460 MB (`small`). The image is expected to be about 450-600 MB. CPU int8
  is the default (`WHISPER_DEVICE=cpu`, `WHISPER_COMPUTE_TYPE=int8`), and
  there is a single uvicorn worker, because the model is per process.
- **Per-Dockerfile ignore files** (`<dir>/Dockerfile.dockerignore`, read
  by BuildKit) rather than `.dockerignore`, because only `**/Dockerfile*`
  is in this track's ownership. The root `.dockerignore` stays unclaimed.
  Effect: `.env`, `node_modules`, `dist`, `uploads`, tests and venvs never
  enter a build context.
- **Health checks** use what each slim image already has: `node -e fetch`
  (no curl in node slim), python `urllib`, and busybox `wget` in nginx alpine.

## Migrations on deploy

A one-shot `migrate` service (same image as the backend) runs
`npx --no-install prisma migrate deploy`. `backend` has `depends_on:
migrate: service_completed_successfully`. Alternatives considered:

- A migration step in the backend's entrypoint. This was rejected because
  it runs on every restart, races if the backend is ever scaled, and mixes
  the migration log into the app log.
- A manual step in the README. This was rejected because it is easy to forget.

## Compose

- **Caddy in front** (`caddy:2.11.8-alpine`): automatic TLS and a
  single origin. `/api/*` and `/health` go to the backend, everything
  else to web, so the frontend is built with `VITE_API_URL=/api` (no
  CORS, no rebuild per domain). Caddy is the only service with published
  ports. The upstream image runs as root to bind 80/443. Running it
  non-root would mean pre-chowning its data volumes; it is left as is
  because it is not one of our Dockerfiles.
- Secrets are only `${VAR:?}` interpolation from `deploy/.env`. That file
  is ignored by the existing `**/.env` rule, and `deploy/.env.example` is
  kept by `!**/.env.example`. The name `.env.prod` was rejected because it
  is **not** gitignored, and `.gitignore` is not ours.
- `ai-service` has a memory limit (`AI_SERVICE_MEMORY_LIMIT`, default
  2g), so a runaway transcription cannot OOM Postgres.

## Hosting (deploy/README.md)

The options are (A) a Hetzner CX23 at €5.99/month (CPX22 at €16.99 if the
CX23 is sold out) and (B) the Oracle Always Free A1 (2 OCPU / 12 GB, arm64,
$0, card required, idle reclamation). Prices were checked on 2026-11-15
against the vendor pages linked in the README. A PaaS split
(Render/Fly/Railway) was rejected: the ai-service reads files by path, so
it must share a filesystem with the backend, unless
`TRANSCRIPTION_PROVIDER=deepgram` (paid).

## Release workflow

`.github/workflows/release.yml` triggers **only** on `push: tags: v*`.
There is no `workflow_dispatch` (lead decision).

- `extension`: `build-capture --check`, a tag vs `manifest.json` version
  check (any `-rc` suffix is ignored), and a zip without `scripts/` and
  `README.md`.
- `desktop`: a matrix of windows/macos/ubuntu with `fail-fast: false`,
  `requirements-build.txt`, pytest, then PyInstaller one-folder windowed
  (the same flags as `desktop-recorder/README.md`), plus explicit
  `pystray._<backend>` hidden imports. Output is zip, ditto zip (.app) or
  tar.gz.
- `release`: needs both and runs if the extension succeeded. It uses
  `gh release create` with `GITHUB_TOKEN` (job-scoped `contents: write`;
  no third-party release action, no secrets). Tags with `-` become
  pre-releases.
- Testing it means pushing an rc tag to a fork (README, "Testing the
  release workflow"). It has **never run**. macOS/Linux PyInstaller
  builds are unproven: the macOS build is unsigned, and the Linux tray
  needs AppIndicator/X at runtime.

## Verification done / not done

- `docker compose -f docker-compose.prod.yml config` passed with
  placeholder env values. It also fails clearly when a required variable
  is missing. The `:ro` and uid change came after that run, and Docker was
  then switched off to save memory, so the final file was checked by reading.
- Images were **not built locally** (laptop RAM). actionlint was not run
  (Docker off). The YAML and Dockerfiles were reviewed by reading.

## For the integrator

- **Request:** add a `docker-build` job to `.github/workflows/ci.yml`
  (PRs touching `**/Dockerfile*`, `docker-compose.prod.yml`, `deploy/**`).
  It should run `docker compose -f docker-compose.prod.yml config` with
  dummy env values, then `docker build` for `backend/`, `frontend/` and
  `ai-service/` (`docker/build-push-action` with `push: false` and the GHA
  cache), plus `rhysd/actionlint` on `.github/workflows/`. That is the
  first real build of these images.
- CLAUDE.md could gain a short "Deploy" pointer to `deploy/README.md` and
  the new `deploy/.env` file.
