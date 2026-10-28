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
# Stage 3: Production Runtime
# ------------------------------------------------------------------------------
FROM node:24-slim AS runner

WORKDIR /app

# Install git, curl, and CA certificates with persistent APT cache
RUN rm -f /etc/apt/apt.conf.d/docker-clean; echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends git curl ca-certificates procps && \
    rm -rf /var/lib/apt/lists/*

# Copy package manifests and production dependencies directly from prod-deps stage (instant)
COPY package*.json ./
COPY --from=prod-deps /app/node_modules ./node_modules

# Copy compiled JavaScript and static assets from builder stage
COPY --from=builder /app/dist ./dist

# Create persistent state directory for SQLite database (agylity.db)
RUN mkdir -p /app/data /home/node/.gemini /home/node/.config /repos

# Default production environment configuration
ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    DATABASE_PATH=/app/data/agylity.db \
    QUOTA_STATE_FILE_PATH=/app/data/state.json \
    WEB_UI_ENABLED=false \
    WEB_UI_PORT=3000 \
    WEB_UI_HOST=0.0.0.0

# Persistent volume for SQLite database and state
VOLUME ["/app/data", "/repos"]

# Expose Web UI dashboard port (conditional listener)
EXPOSE 3000

# Native Node 24 invocation
CMD ["node", "dist/index.js"]
