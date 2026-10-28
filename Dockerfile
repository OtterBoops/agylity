# ==============================================================================
# agylity - Multi-Stage Production Dockerfile
# Base: node:24-slim with zero-CVE minimal footprint
# ==============================================================================

# ------------------------------------------------------------------------------
# Stage 1: Build & Compile TypeScript
# ------------------------------------------------------------------------------
FROM node:24-slim AS builder

WORKDIR /app

# Copy dependency manifests
COPY package*.json tsconfig.json ./
COPY frontend/package*.json ./frontend/

# Install root and frontend dependencies
RUN npm ci
RUN cd frontend && npm ci

# Copy application and frontend source code
COPY src/ ./src/
COPY frontend/ ./frontend/

# Compile TypeScript and build Vite Preact frontend
RUN npm run build

# ------------------------------------------------------------------------------
# Stage 2: Production Runtime
# ------------------------------------------------------------------------------
FROM node:24-slim AS runner

WORKDIR /app

# Install git, curl, and CA certificates
RUN apt-get update && \
    apt-get install -y --no-install-recommends git curl ca-certificates procps && \
    rm -rf /var/lib/apt/lists/*

# Copy package manifests and install strictly production dependencies (zero-CVE surface)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled JavaScript and static assets from builder stage
COPY --from=builder /app/dist ./dist

# Create persistent state directory for SQLite database (agylity.db)
RUN mkdir -p /app/data /home/node/.gemini /home/node/.config /repos

# Default production environment configuration
ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV DATABASE_PATH=/app/data/agylity.db
ENV QUOTA_STATE_FILE_PATH=/app/data/state.json
ENV WEB_UI_ENABLED=false
ENV WEB_UI_PORT=3000
ENV WEB_UI_HOST=0.0.0.0

# Persistent volume for SQLite database and state
VOLUME ["/app/data", "/repos"]

# Expose Web UI dashboard port (conditional listener)
EXPOSE 3000

# Native Node 24 invocation
CMD ["node", "dist/index.js"]
