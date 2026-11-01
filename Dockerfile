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
# Includes git, openssh-client, curl, gh CLI, and agy CLI
# ------------------------------------------------------------------------------
FROM node:24-slim AS worker

WORKDIR /app

RUN rm -f /etc/apt/apt.conf.d/docker-clean; echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends git openssh-client curl ca-certificates procps && \
    (which gh || (curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y --no-install-recommends gh)) && \
    (curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /usr/local/bin || true) && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

RUN mkdir -p /home/node/.gemini /repos /data && \
    chown -R node:node /home/node /repos /data /app

USER node

ENV NODE_ENV=production \
    COORDINATOR_URL=http://agylity:8484 \
    RUNNER_STATE_PATH=/data/runner.json

CMD ["node", "--no-warnings", "dist/worker-cli.js"]

# ------------------------------------------------------------------------------
# Stage 4: Coordinator & Sentry Runtime (Default Target: coordinator -> ghcr.io/otterboops/agylity)
# Lean control plane + Quota Sentry + baked agy CLI for authoritative /usage polling
# ------------------------------------------------------------------------------
FROM node:24-slim AS coordinator

WORKDIR /app

# Install minimal CA certificates, procps, and curl for agy installer
RUN rm -f /etc/apt/apt.conf.d/docker-clean; echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates procps curl && \
    (curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /usr/local/bin || true) && \
    rm -rf /var/lib/apt/lists/*

# Copy package manifests and production dependencies directly from prod-deps stage (instant)
COPY package*.json ./
COPY --from=prod-deps /app/node_modules ./node_modules

# Copy compiled JavaScript and static assets from builder stage
COPY --from=builder /app/dist ./dist

# Create persistent state directory for SQLite database (agylity.db)
RUN mkdir -p /app/data /home/node/.gemini && \
    chown -R node:node /app/data /home/node /app

# Switch to non-root node user
USER node

# Healthcheck for coordinator web service
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "if (process.env.WEB_UI_ENABLED !== 'true') process.exit(0); fetch('http://127.0.0.1:' + (process.env.WEB_UI_PORT || 8484) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Default production environment configuration
ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    DATABASE_PATH=/app/data/agylity.db \
    QUOTA_STATE_FILE_PATH=/app/data/state.json \
    WEB_UI_ENABLED=true \
    WEB_UI_PORT=8484 \
    WEB_UI_HOST=0.0.0.0

# Persistent volume for SQLite database and state
VOLUME ["/app/data"]

# Expose Web UI dashboard & Swarm Runner API port (conditional listener)
EXPOSE 8484

# Native Node 24 invocation
CMD ["node", "--no-warnings", "dist/index.js"]
