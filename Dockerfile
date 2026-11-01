# ==============================================================================
# agylity - Multi-Stage Production Dockerfile
# Base: node:24-slim with zero-CVE minimal footprint
# ==============================================================================

# ------------------------------------------------------------------------------
# Stage 1: Production Dependencies (Built in parallel with builder)
# ------------------------------------------------------------------------------
FROM node:24-slim AS prod-deps

WORKDIR /app

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts

# ------------------------------------------------------------------------------
# Stage 2: Build & Compile TypeScript + Vite Client
# ------------------------------------------------------------------------------
FROM node:24-slim AS builder

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
# Stage 3: Swarm Runner Runtime (Target: worker -> ghcr.io/otterboops/agylity-worker)
# Includes git, openssh-client, and curl for isolated branch execution & agy CLI
# ------------------------------------------------------------------------------
FROM node:24-slim AS worker

WORKDIR /app

RUN rm -f /etc/apt/apt.conf.d/docker-clean; echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends git openssh-client curl ca-certificates procps && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

RUN mkdir -p /home/node/.gemini /repos && \
    chown -R node:node /home/node /repos

ENV NODE_ENV=production \
    COORDINATOR_URL=http://agylity:8484

CMD ["node", "dist/worker-cli.js"]

# ------------------------------------------------------------------------------
# Stage 4: Coordinator & Sentry Runtime (Default Target: coordinator -> ghcr.io/otterboops/agylity)
# Lean control plane + Quota Sentry without heavy git/build toolchain bloat
# ------------------------------------------------------------------------------
FROM node:24-slim AS coordinator

WORKDIR /app

# Install minimal CA certificates and procps for Language Server discovery
RUN rm -f /etc/apt/apt.conf.d/docker-clean; echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates procps && \
    rm -rf /var/lib/apt/lists/*

# Copy package manifests and production dependencies directly from prod-deps stage (instant)
COPY package*.json ./
COPY --from=prod-deps /app/node_modules ./node_modules

# Copy compiled JavaScript and static assets from builder stage
COPY --from=builder /app/dist ./dist

# Create persistent state directory for SQLite database (agylity.db)
RUN mkdir -p /app/data

# Default production environment configuration
ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    DATABASE_PATH=/app/data/agylity.db \
    QUOTA_STATE_FILE_PATH=/app/data/state.json \
    WEB_UI_ENABLED=false \
    WEB_UI_PORT=8484 \
    WEB_UI_HOST=0.0.0.0

# Persistent volume for SQLite database and state
VOLUME ["/app/data"]

# Expose Web UI dashboard & Swarm Runner API port (conditional listener)
EXPOSE 8484

# Native Node 24 invocation
CMD ["node", "dist/index.js"]
