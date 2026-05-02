# syntax=docker/dockerfile:1.7

# -----------------------------------------------------------------------------
# Dockerfile for @metaplex-agent/server
#
# Multi-stage build: installs workspace deps with pnpm, compiles
# shared -> core -> server, then ships the runnable tree in a slim image.
#
# Image contents at runtime: the compiled workspace under /app, including
# node_modules. We do not prune devDependencies in the runtime stage -- pnpm
# workspace layouts make `--prod` pruning fragile, and the size delta isn't
# worth the template complexity. Shrink later if you need to.
#
# Used by Railway (via railway.json) and works anywhere else that supports
# Dockerfiles (Fly, Render, Koyeb, Kubernetes, plain `docker run`, etc.).
# -----------------------------------------------------------------------------

FROM node:20-slim AS builder
WORKDIR /app

# Enable pnpm via corepack (shipped with Node 20).
RUN corepack enable

# Copy workspace manifests first so `pnpm install` is cacheable independently
# of source changes.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/core/package.json ./packages/core/
COPY packages/server/package.json ./packages/server/

RUN pnpm install --frozen-lockfile

# Copy sources for the server chain. The chat UI lives in a separate repo
# (metaplex-agent-chat-template) and is deployed separately (e.g. Vercel).
COPY tsconfig.json ./
COPY packages/shared ./packages/shared
COPY packages/core ./packages/core
COPY packages/server ./packages/server

RUN pnpm --filter @metaplex-agent/shared \
         --filter @metaplex-agent/core \
         --filter @metaplex-agent/server \
         build

# -----------------------------------------------------------------------------
# Runtime stage
# -----------------------------------------------------------------------------
FROM node:20-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Run as a non-root user. Railway doesn't require this, but it's a good default
# for any other host (k8s PSA, Fly machines, etc.). `WORKDIR` creates /app as
# root-owned; chown it so the agent user can write agent-state.json there on
# first-run registration.
RUN useradd --system --uid 1001 --create-home agent \
    && chown agent:agent /app

COPY --from=builder --chown=agent:agent /app /app

USER agent

# The server binds to WEB_CHANNEL_PORT, which falls back to PORT (the env var
# Railway / Render / Fly inject). 3002 is the local-dev default.
EXPOSE 3002

CMD ["node", "packages/server/dist/index.js"]
