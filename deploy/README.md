# Deploying

The whole product runs on **one Linux host** with Docker Compose:

```
internet ─► caddy :80/:443 (TLS) ─┬─ /api/*, /health ─► backend :5000 ─┬─► postgres (pgvector/pg16)
                                  └─ everything else ─► web :8080       ├─► ai-service :8000 (faster-whisper, CPU int8)
                                                                        └─► Gemini (HTTPS)
                       migrate (one-shot prisma migrate deploy) runs before backend starts
```

Files: [`docker-compose.prod.yml`](../docker-compose.prod.yml),
[`Caddyfile`](Caddyfile), [`.env.example`](.env.example) and the
Dockerfiles in `backend/`, `ai-service/` and `frontend/`.

**Why one host and not a PaaS split:** the backend hands the ai-service
an *absolute file path* (`/app/uploads/...`) and the ai-service opens it
directly, so the two containers must share a filesystem (the `uploads`
volume). Render, Fly.io or Railway would put them on separate machines.
That split only works with `TRANSCRIPTION_PROVIDER=deepgram`, which is
paid per audio minute (see `docs/DECISIONS.md`).

Nothing here creates an account or spends money. Every step that does
is marked **(engineer)**.

## What runs where

| Service | Image | User | Health check | Published |
| --- | --- | --- | --- | --- |
| caddy | `caddy:2.11.8-alpine` | root (upstream image; binds 80/443) | none (proxy) | 80, 443 |
| web | `frontend/Dockerfile` → `nginxinc/nginx-unprivileged:1.30.6-alpine` | uid 101 | `GET /healthz` | no |
| backend | `backend/Dockerfile` → `node:22.23.4-bookworm-slim` | `node` (uid 1000) | `GET /health` | no |
| migrate | same image as backend | `node` | exits 0 / non-zero | no |
| ai-service | `ai-service/Dockerfile` → `python:3.12.15-slim-bookworm` | `app` (uid 1000, same as backend for the shared volume) | `GET /health` (no model load) | no |
| postgres | `pgvector/pgvector:0.8.1-pg16-bookworm` | postgres | `pg_isready` | no |

- **Migrations on deploy:** `migrate` runs `prisma migrate deploy` on
  every `up`. The backend has `depends_on: migrate:
  service_completed_successfully`, so a failed migration keeps the old
  containers running and the new backend never starts.
- **Whisper model:** not in the image. It is downloaded on the first
  transcription into the `whisper_models` volume (`HF_HOME=/models`), about
  460 MB for `small`. The ai-service image itself is expected to be
  about 450-600 MB (ctranslate2, onnxruntime, PyAV, numpy; no torch, no CUDA).
- **Memory:** budget about 1-1.5 GB for the ai-service while it transcribes
  (`small`, int8), about 200 MB each for backend and Postgres, and about 30 MB for
  nginx and Caddy. **4 GB of RAM is the practical minimum.** 2 GB works only
  with `WHISPER_MODEL=base` or `tiny`.

## The two setups compared

Prices were checked on 2026-11-15 and exclude VAT. Check them again before
you sign up, because both vendors change plans often.

| | **A. Hetzner Cloud VPS** | **B. Oracle Cloud Always Free (Ampere A1)** |
| --- | --- | --- |
| Machine | CX23: 2 vCPU x86, 4 GB, 40 GB NVMe | VM.Standard.A1.Flex: up to 2 OCPU Arm, 12 GB |
| Monthly cost | **€5.99** (CX23). If CX23 is sold out: CPX22 (2 vCPU, 4 GB, 80 GB) at €16.99 in HEL1. Optional backups: about 20% of the server price. IPv4 included. | **$0** within the free limits: 2 OCPU, 12 GB, 200 GB block storage, 10 TB/month egress |
| Architecture | amd64 | **arm64**. The images build on the host; every dependency has arm64 wheels or images. |
| Whisper `small` speed | about 0.5-1x real time on 2 vCPU | similar or better (12 GB lets you try `medium`) |
| Signup | Account with ID or payment verification **(engineer)** | Account **with a credit card** for verification **(engineer)**. Free resources must be in your home region. |
| Risks | Cheapest plans are often "currently unavailable" | Free A1 capacity is often "out of capacity"; **idle instances can be reclaimed** (7-day CPU, network and memory utilization all under 20%) |
| Best for | A demo that must stay up | Zero cost, if you accept the risk of reclamation |
| Sources | [hetzner.com/cloud/cost-optimized](https://www.hetzner.com/cloud/cost-optimized/), [hetzner.com/cloud/regular-performance](https://www.hetzner.com/cloud/regular-performance/) | [Oracle Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) |

Costs on both setups: **Gemini** (summaries, diarization, chat and embeddings
are billed by Google per token; the free tier may cover a personal demo),
and optionally a **domain** (about $10-15/year). Without a domain, use
the server IP with `DOMAIN=<ip>.sslip.io` so Caddy can still get a certificate.

**Recommendation:** A (Hetzner CX23) for the portfolio demo, because it is
predictable and costs about €6/month. B is a good free fallback.

## Setup A: Hetzner Cloud

1. **(engineer)** Create a Hetzner Cloud project and add your SSH public key.
2. **(engineer)** Create a server with the **Ubuntu 24.04** image, type
   **CX23** (or CPX22), and your SSH key. Optional: enable backups.
3. **(engineer)** Optional domain: add a DNS `A` record from
   `meetings.<your-domain>` to the server's IPv4 address.
4. Firewall: in the Hetzner console (or `ufw`), allow only 22, 80 and 443
   (TCP), plus 443/UDP for HTTP/3.
5. Then follow [Common steps](#common-steps-both-setups).

## Setup B: Oracle Cloud Always Free

1. **(engineer)** Sign up for Oracle Cloud Free Tier. A credit card is
   required for verification. Pick a home region close to you, because
   free resources only exist there.
2. **(engineer)** Compute → Instances → Create: image **Ubuntu 24.04
   (aarch64)**, shape **VM.Standard.A1.Flex** with 2 OCPU and 12 GB, boot
   volume 50 GB, your SSH key, and a public IPv4. If it says "out of
   capacity", try another availability domain or retry later.
3. Networking: in the VCN's security list, add ingress rules for TCP 80
   and 443 (and UDP 443). Ubuntu images on OCI also have iptables rules,
   so open the ports on the host as well:
   ```bash
   sudo iptables -I INPUT 6 -p tcp -m multiport --dports 80,443 -j ACCEPT
   sudo iptables -I INPUT 6 -p udp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   ```
4. **(engineer)** Optional domain: add a DNS `A` record pointing to the public IP.
5. Then follow [Common steps](#common-steps-both-setups). Everything builds
   natively on arm64.

## Common steps (both setups)

On the server, as a sudo user:

```bash
# 1. Docker Engine + compose plugin (official convenience script)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER" && newgrp docker

# 2. Optional on 4 GB machines: 2 GB swap so builds don't OOM
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile \
  && sudo mkswap /swapfile && sudo swapon /swapfile \
  && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 3. Code (public repo)
git clone https://github.com/<owner>/ai-meeting-summarizer.git
cd ai-meeting-summarizer

# 4. Secrets: server-only file, ignored by git (**/.env)
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
nano deploy/.env        # DOMAIN, POSTGRES_PASSWORD, GEMINI_API_KEY, DEVICE_TOKEN
#   POSTGRES_PASSWORD / DEVICE_TOKEN:  openssl rand -hex 32

# 5. Build, migrate, start (migrate runs automatically before backend)
docker compose -f docker-compose.prod.yml --env-file deploy/.env up -d --build

# 6. Verify
docker compose -f docker-compose.prod.yml --env-file deploy/.env ps     # all healthy, migrate "exited (0)"
curl -fsS https://$DOMAIN/health                                        # {"success":true,...}
docker compose -f docker-compose.prod.yml --env-file deploy/.env logs migrate
```

The first build takes about 5-10 minutes. The first transcription also
downloads the Whisper model.

Then point the recorders at the server:

- **Chrome extension** → Settings: backend URL `https://<DOMAIN>/api`,
  device token = `DEVICE_TOKEN`.
- **Desktop recorder** → Settings: the same API URL and token, and web app URL
  `https://<DOMAIN>`.

### Update and roll back

```bash
git pull --ff-only
# Keep the previous images around under their old tag:
IMAGE_TAG=$(git rev-parse --short HEAD) docker compose -f docker-compose.prod.yml --env-file deploy/.env up -d --build
# Roll back code: check out the previous commit and run the same command with its tag.
```

Migrations only move forward. Before an update that includes a new
migration, take a database dump (below). A rollback across a migration
means restoring that dump.

### Backups

```bash
# Database
docker compose -f docker-compose.prod.yml --env-file deploy/.env exec -T postgres \
  pg_dump -U postgres -Fc ai_meeting_summarizer > backup-$(date +%F).dump
# Recordings (uploads volume)
docker run --rm -v ai-meeting-summarizer-prod_uploads:/data -v "$PWD":/out alpine \
  tar -czf /out/uploads-$(date +%F).tgz -C /data .
```

Keep the backups off the server. Recordings are personal data.

### Hardening checklist

- `DEVICE_TOKEN` is required, and the backend refuses to boot without it
  in production. Until auth exists, anyone with the URL can read meetings
  through the web app, so share the URL carefully.
- Postgres, backend and ai-service publish no ports. Only Caddy is exposed.
- Don't set `VITE_DEVICE_TOKEN` for a public build, because it would ship in the JS bundle.
- `sudo apt install unattended-upgrades` for OS security patches.

## Testing the release workflow

`.github/workflows/release.yml` runs **only** when a `v*` tag is pushed.
It builds the extension zip, plus desktop-recorder binaries for Windows,
macOS and Linux, and attaches them to a GitHub Release. To try it without
releasing from the main repo **(engineer)**:

1. Fork the repo on GitHub. Actions are disabled on new forks, so enable
   them on the fork's Actions tab.
2. In a clone of the fork, set `extension/manifest.json` `version` to the
   tag's number (e.g. `1.1.0`), commit, then:
   `git tag v1.1.0-rc1 && git push <fork-remote> v1.1.0-rc1`.
   A tag with a `-suffix` is published as a **pre-release**, and the suffix
   is ignored when checking the manifest version.
3. Check the run. The release should contain
   `meeting-extension-v1.1.0-rc1.zip` and `MeetingRecorder-v1.1.0-rc1-{windows,macos}.zip`
   plus `...-linux.tar.gz`. macOS and Linux are **untested**: if one fails,
   the release is still published with what succeeded, and the notes say so.
4. Delete the rc release and tag on the fork afterwards.
