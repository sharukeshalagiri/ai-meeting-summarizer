# syntax=docker/dockerfile:1
#
# Backend API (Express 5 + Prisma 6), production image.
#
#   docker build -t meeting-backend backend/
#
# Two stages: `build` compiles TypeScript with dev dependencies, then
# prunes them; `runtime` copies only dist/, the pruned node_modules
# (which still hold the generated Prisma client) and the Prisma schema +
# migrations, so the same image can run `prisma migrate deploy` as a
# one-shot migrate job (see docker-compose.prod.yml).
#
# bookworm-slim rather than alpine: Prisma's query engine is built for
# glibc + OpenSSL 3, and the musl variant is a frequent source of
# "could not locate the Query Engine" failures. openssl is installed in
# both stages so `prisma generate` detects the same engine target.

ARG NODE_IMAGE=node:22.23.4-bookworm-slim

FROM ${NODE_IMAGE} AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Schema first: `npm ci` runs `prisma generate` on postinstall.
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev --no-audit --no-fund \
 && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=5000 \
    UPLOAD_DIR=uploads/meetings \
    LIVE_CHUNK_DIR=uploads/live
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/prisma.config.ts ./
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# The uploads volume is mounted here; create it owned by `node` so a
# fresh named volume inherits writable permissions.
RUN mkdir -p /app/uploads/meetings /app/uploads/live && chown -R node:node /app/uploads
# Non-root: the official image ships the `node` user (uid 1000).
USER node
EXPOSE 5000
# Slim images have no curl/wget; Node 22 has a global fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# tini reaps zombies and forwards SIGTERM so the server shuts down cleanly.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
