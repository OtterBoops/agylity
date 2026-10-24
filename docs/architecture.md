# System Architecture & Invariants

This document details the core architectural subsystems, Connect-RPC integration with Google Antigravity, cryptographic security, and guardrails implemented in `agylity`.

---

## 1. High-Level Architecture Topology

```
                            +-------------------------------------+
                            |      Antigravity Language Server    |
                            |       Connect-RPC (Port 60643)      |
                            +-------------------+-----------------+
                                                |
                                                v (POST /RetrieveUserQuotaSummary)
+------------------------+        +------------+------------+
|   Discord Client       | <----> |      Quota Sentry       | <----> data/state.json
|  (/quota, Alerts,      |        | (Evaluator & Deduplica- |
|   Interactive Modals)  |        |  tion Engine)           |
+------------------------+        +------------+------------+
                                                |
                                                v
+------------------------+        +------------+------------+
|  Swarm Worker Network  | <....> |   SQLite Config Store   | <----> data/agylity.db
|  (Pull-Based Execution |        |  (AES-256-GCM Encrypted |
|   Roadmap / To-Do)     |        |   UI Overrides > .env)  |
+------------------------+        +------------+------------+
                                                |
                                                | (Optional)
                                   +------------+------------+
                                   |  Decoupled Web Server   | (WEB_UI_ENABLED=false
                                   |  (Preact + Native HTTP) |  zero listener by default)
                                   +-------------------------+
```

---

## 2. Language Server Connect-RPC Engine

Agylity queries quota metadata directly from the internal HTTP/1.1 Connect-RPC service hosted by Google Antigravity's Language Server (`language_server.exe`).

### 2.1. Dual-Bucket Endpoint (`/RetrieveUserQuotaSummary`)

Frontier models in Antigravity are governed by two distinct limits:

1. **Weekly Limit**: The long-term allocation budget. This resets once per week and is the **primary evaluation target** driving sentry alerts and health badges.
2. **5-Hour Rolling Limit**: The short-term burst limiter, preventing heavy consumption spikes.

- **Endpoint**: `POST /exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`
- **Protocol Headers**:
  - `Content-Type: application/json`
  - `Connect-Protocol-Version: 1`
  - `x-codeium-csrf-token: <token>`
- **Payload**: `{}`
- **Response**: Returns quota group objects detailing `weekly` and `5h` limits, remaining fractions (`remainingFraction`), and reset timestamps (`resetTime`).

### 2.2. Resilience & Fallback Hierarchy

1. **Primary Port 60643**: Connect-RPC query to `/RetrieveUserQuotaSummary`.
2. **Legacy Endpoint Fallback**: Retries `/GetCascadeModelConfigData` if summary endpoint is unsupported.
3. **Secondary Port 60642**: Automatically retried if port 60643 is unreachable (e.g. after language server restart).
4. **CLI Introspection Fallback**: If the HTTP RPC service is unreachable, executes:
   ```bash
   agy --output-format json models
   ```
   Validated against `CliModelsResponseSchema`, preserving previously cached reset deadlines while monitoring available models.

---

## 3. Security Guardrails & Invariants

### 3.1. The Zero-Clobber Guardrail

> **Under NO condition shall an automated task fallback to local headless execution on the monitoring daemon host.**

Continuation tasks are designed to be executed strictly on designated worker machines or homelab containers via pull-based swarm workers, never headlessly on the monitoring daemon host.

#### Operational Rationale:

- The daemon monitoring host (e.g. Raspberry Pi, low-power server, Docker container) lacks the workstation's compilers, GPU acceleration, toolchains, build caches, and credentials.
- Running headless tasks locally pollutes the monitoring host's disk and memory.
- It desynchronizes developer git trees by creating orphan branches on the wrong host.

### 3.2. Cryptographic Security at Rest (AES-256-GCM)

Sensitive tokens (Discord Bot Token, Language Server CSRF headers, webhook secrets) stored in SQLite are encrypted before being written to disk using native Node 24 `node:crypto` AES-256-GCM authenticated encryption (`enc:v1:<iv>:<tag>:<ciphertext>`). On all REST API routes (`GET /api/config`), secret values are masked (`••••••••`) to prevent accidental credential leakage in browser network logs or client inspection.

### 3.3. AI Overcharge & Credit Safety Floor

Tasks are blocked from dispatch when remaining quota headroom is $\le \text{MIN\_DISPATCH\_HEADROOM\_PERCENT}$ (default: `10%`) to protect against billable AI overages or credit consumption. Pass `allowOverage: true` in the API or UI to override. Setting this to `0` is recommended for flat-tier / non-metered accounts.

### 3.4. Three-Tier Precedence Hierarchy with UI Overrides

Configuration is resolved dynamically across three tiers:
$$\text{Resolved Value} = \text{SQLite UI Overrides} \mathbin{??} \text{Environment Variables} \mathbin{??} \text{Built-in Defaults}$$
Changes made in the Web UI take immediate effect over the in-memory event bus without requiring process restarts.

---

## 4. Strict Zero-CVE Dependency Posture

Agylity enforces a minimalist runtime footprint to eliminate supply-chain vulnerabilities in 24/7 autonomous environments:

- **Runtime Dependencies**: Strictly limited to three packages:
  - `discord.js`: Rock-solid Discord gateway interactions and UI components.
  - `ky`: Lightweight HTTP client for Connect-RPC endpoints.
  - `zod`: Schema validation and type inference across configs and RPC payloads.
- **Development Tooling**: `typescript`, `@types/node`, `tsx`.
- **Zero Third-Party Primitives**:
  - **Cryptographic Security at Rest**: Native `node:crypto` AES-256-GCM authenticated encryption. Sensitive tokens (Discord Bot Tokens, CSRF headers, webhook secrets) are encrypted before writing to SQLite and masked across all REST endpoints.
  - **Embedded Persistence**: Native Node 24 `node:sqlite` (`DatabaseSync`) in WAL mode.
  - **Fast HTTP**: Native Node `node:http` (zero Express/Fastify bloat).
  - **Test Suite**: Native Node 24 test runner (`node:test`, `node:assert/strict`).

---

## 5. Subsystem Breakdown

1. **Configuration Store (`src/config/`)**: Manages the three-tier precedence hierarchy (`SQLite Overrides ?? .env ?? Defaults`). Emits granular change events over an in-memory event bus.
2. **Quota Sentry (`src/sentry/`)**: Connect-RPC client with automatic port-hunting (`60643` $\to$ `60642`), model pooling aggregator, milestone evaluator (`24h`, `12h`, `3h`), and atomic alert state deduplication (`data/state.json`).
3. **Pluggable Notifications (`src/notify/`)**: Universal `Notifier` interface with dynamic `import()` isolation. Inactive notification channels never load `discord.js` into memory or bind listeners.
4. **Optional Swarm Orchestrator**: Fully decoupled and optional (`orchestratorEnabled: false` by default). When disabled, zero execution resources or dispatch sockets are initialized.
5. **Decoupled Web Dashboard (`src/web/` & `frontend/`)**: Modern reactive dashboard built with **Vite + Preact + Tailwind CSS v4** served via native `node:http`. Zero overhead when disabled (`WEB_UI_ENABLED=false`).

---

## 6. Repository Architecture

```
agylity/
├── .github/
│   └── workflows/
│       └── docker-publish.yml  # Dual-stage CI (PR validation & typecheck) & CD (GHCR container release)
├── docs/                       # Authoritative operational guides
│   ├── architecture.md         # System design, Connect-RPC, security invariants
│   ├── configuration.md        # Environment variables & SQLite hierarchy
│   ├── deployment.md           # Docker Compose, Arcane GitOps, systemd
│   └── testing.md              # Multi-tier verification architecture & test harness
├── frontend/                   # Dedicated Vite + Preact + Tailwind CSS client
│   ├── public/                 # Static vector assets (favicon, icons)
│   ├── src/                    # Preact components, hooks, and types
│   ├── package.json            # Client workspace dependencies
│   └── vite.config.ts          # Bundles directly to dist/web/public
├── src/                        # Pure TypeScript daemon source
│   ├── config/                 # Zod validation & SQLite store hierarchy
│   ├── notify/                 # Pluggable notifiers (Discord, Console, Webhook)
│   ├── sentry/                 # Connect-RPC client, model pools & evaluator
│   ├── storage/                # Native node:sqlite database & AES-256-GCM crypto
│   ├── web/                    # Native HTTP server & REST API routes
│   └── index.ts                # Daemon bootstrap & graceful shutdown coordinator
├── tests/                      # Deterministic test suites (Tiers 1-5 + unit)
│   ├── e2e/                    # Opaque-box E2E suites & shared mock harness
│   └── unit/                   # Focused unit tests
├── Dockerfile                  # Multi-stage production container (node:24-slim)
├── docker-compose.yaml         # Container deployment definition (ports: 3000:3000)
├── LICENSE                     # PolyForm Noncommercial License 1.0.0
├── package.json                # Root manifest (Node >=24, minimal dependencies)
├── tsconfig.json               # NodeNext, strict: true
└── README.md                   # Clean project landing page & quickstart
```
