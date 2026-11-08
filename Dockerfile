# syntax=docker/dockerfile:1

# ────────────────────────────── 1. build the static site ──────────────────────────────
FROM node:24-alpine AS build

WORKDIR /app
# `packageManager: pnpm@10.33.0` in package.json pins the version corepack downloads.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Install deps first so this layer survives source-only changes.
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# ────────────────────────────── 2. serve it with nginx ──────────────────────────────
# Unprivileged build: runs as uid 101 and listens on 8080 (no root, no port 80).
FROM nginxinc/nginx-unprivileged:1.29-alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080
