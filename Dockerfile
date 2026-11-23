# ==============================================================================
# agylity - Multi-Stage Production Dockerfile
# Base: node:26-slim with zero-CVE minimal footprint
# ==============================================================================

# Global default keeps `docker build --target coordinator|runner` self-contained
# using the local `base` stage; CI overrides this to a prebuilt registry image.
ARG BASE_IMAGE=base

# ------------------------------------------------------------------------------
# Stage 1: Production Dependencies (Built in parallel with builder)
# ------------------------------------------------------------------------------
FROM node:26-slim AS prod-deps

WORKDIR /app

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts

# ------------------------------------------------------------------------------
# Stage 2: Build & Compile TypeScript + Vite Client
# ------------------------------------------------------------------------------
FROM node:26-slim AS builder

WORKDIR /app

# Copy dependency manifests only (preserves layer cache against config edits)
COPY package*.json ./
COPY frontend/package*.json ./frontend/

# Install root and frontend dependencies using BuildKit package cache
RUN --mount=type=cache,target=/root/.npm \
    npm ci && \
    cd frontend && npm ci

# Copy TypeScript configuration and source code
COPY tsconfig.json ./
COPY src/ ./src/
COPY frontend/ ./frontend/

# Compile TypeScript and build Vite Preact frontend
RUN npm run build

# ------------------------------------------------------------------------------
# Stage 3: Compiled bundle
# CI overrides this stage with the test job's prebuilt directory
# (`--build-context dist=<dir>`), which drops `builder` from the dependency
# graph entirely. A plain `docker build --target coordinator|runner` still
# compiles from source through it.
# ------------------------------------------------------------------------------
FROM builder AS dist

# ------------------------------------------------------------------------------
# Stage 4: Shared runtime base
# Runtime libraries and the baked agy CLI live here once, so coordinator and
# runner stop each carrying their own copy of the ~110 MB CLI layer.
# ------------------------------------------------------------------------------
FROM node:26-slim AS base

WORKDIR /app

RUN rm -f /etc/apt/apt.conf.d/docker-clean; echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates procps curl && \
    mkdir -p /home/node/.local/bin /home/node/.gemini /app/data && \
    chown -R node:node /home/node /app && \
    su -s /bin/sh node -c "curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /home/node/.local/bin" && \
    rm -rf /var/lib/apt/lists/*

COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/agylity-entrypoint.sh

# ------------------------------------------------------------------------------
# Stage 5: Swarm Runner Runtime (Target: runner -> ghcr.io/otterboops/agylity-runner)
# Adds the git/ssh/gh toolchain the task executor needs on top of the shared base
# ------------------------------------------------------------------------------
FROM ${BASE_IMAGE} AS runner

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends git openssh-client && \
    (which gh || (curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y --no-install-recommends gh)) && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /repos /data && \
    chown node:node /repos /data

COPY --chown=node:node package*.json ./
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=dist /app/dist ./dist

USER node

# node-writable, so the entrypoint's boot refresh can replace it
ENV NODE_ENV=production \
    PATH=/home/node/.local/bin:$PATH \
    AGY_UPDATE_ON_BOOT=blocking \
    COORDINATOR_URL=http://agylity:8484 \
    RUNNER_STATE_PATH=/data/runner.json

ENTRYPOINT ["/usr/local/bin/agylity-entrypoint.sh"]
CMD ["node", "--no-warnings", "dist/runner-cli.js"]

# ------------------------------------------------------------------------------
# Stage 6: Coordinator & Sentry Runtime (Default Target: coordinator -> ghcr.io/otterboops/agylity)
# Lean control plane + Quota Sentry + baked agy CLI for authoritative /usage polling
# ------------------------------------------------------------------------------
FROM ${BASE_IMAGE} AS coordinator

# Build provenance for the dashboard's version indicator; CI passes one channel per ref.
ARG BUILD_CHANNEL=dev
ARG BUILD_COMMIT=

# Copy package manifests and production dependencies directly from prod-deps stage (instant)
COPY --chown=node:node package*.json ./
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules

# Copy compiled JavaScript and static assets from the dist stage
COPY --chown=node:node --from=dist /app/dist ./dist

# Switch to non-root node user
USER node

# Healthcheck for coordinator web service; start-period covers the entrypoint's agy refresh.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8484/api/health || exit 1

# Default production environment configuration
ENV NODE_ENV=production \
    PATH=/home/node/.local/bin:$PATH \
    AGY_UPDATE_ON_BOOT=background \
    DATA_DIR=/app/data \
    DATABASE_PATH=/app/data/agylity.db \
    QUOTA_STATE_FILE_PATH=/app/data/state.json \
    WEB_UI_ENABLED=true \
    WEB_UI_PORT=8484 \
    WEB_UI_HOST=0.0.0.0 \
    BUILD_CHANNEL=$BUILD_CHANNEL \
    BUILD_COMMIT=$BUILD_COMMIT

# Persistent volume for SQLite database and state
VOLUME ["/app/data"]

# Expose Web UI dashboard & Swarm Runner API port (conditional listener)
EXPOSE 8484

ENTRYPOINT ["/usr/local/bin/agylity-entrypoint.sh"]
CMD ["node", "--no-warnings", "dist/index.js"]
