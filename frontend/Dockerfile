# syntax=docker/dockerfile:1.7
#
# Frontend (React + Vite), built to static files and served by an
# unprivileged nginx.
#
#   docker build --build-arg VITE_API_URL=https://example.com/api -t meeting-web frontend/
#
# VITE_* values are compiled into the bundle at build time, so the API
# URL is a build argument, not a runtime variable. Do not pass a real
# VITE_DEVICE_TOKEN for a public deployment: anything VITE_* is readable
# by every visitor.

ARG NODE_IMAGE=node:22.23.4-bookworm-slim
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.30.6-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG VITE_API_URL=/api
ARG VITE_DEVICE_TOKEN=
ENV VITE_API_URL=${VITE_API_URL} \
    VITE_DEVICE_TOKEN=${VITE_DEVICE_TOKEN}
RUN npm run build

# nginx-unprivileged runs as uid 101 and listens on 8080, so no root
# and no privileged port.
FROM ${NGINX_IMAGE} AS runtime
COPY <<'NGINX' /etc/nginx/conf.d/default.conf
server {
    listen 8080;
    server_name _;
    root /usr/share/nginx/html;

    # Liveness probe for compose and hosting platforms.
    location = /healthz {
        access_log off;
        default_type text/plain;
        return 200 "ok\n";
    }

    # Hashed build assets never change: cache them for a year.
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }

    # Single-page app: unknown paths fall back to index.html so
    # react-router handles deep links. index.html itself is never cached.
    location / {
        add_header Cache-Control "no-cache";
        try_files $uri $uri/ /index.html;
    }
}
NGINX
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
