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
|  Pluggable Notifier    | <----> |      Quota Sentry       | <----> data/state.json
|  CompositeNotifier:    |        | (Evaluator & Deduplica- |
|  - Discord Client      |        |  tion Engine)           |
|  - Webhook POST        |        +------------+------------+
|  - Console Logger      |                      |
+------------------------+                      v
                                  +------------+------------+
                                  |   SQLite Config Store   | <----> data/agylity.db
                                  |  (AES-256-GCM Encrypted |
                                  |   UI Overrides > .env)  |
                                  +------------+------------+
                                                |
                                                | (Optional)
                                   +------------+------------+
                                   |  Decoupled Web Server   | (WEB_UI_ENABLED=false
                                   |  (Preact + Native HTTP) |  zero listener by default)
                                   +------------+------------+
                                                |
                                                v (REST /api/tasks/poll)
                                  +---------------------------+
                                  |   Pull-Based Swarm Queue  | (Roadmap Architecture)
                                  |   SQLite Task Queue       |
                                  +-------------+-------------+
                                                ▲
                                                │ (Outbound HTTPS Long-Poll)
                         +----------------------+----------------------+
                         |                                             |
             +-----------+------------+                   +------------+-----------+
             | Headless Worker        |                   | Visible Worker         |
             | (Docker on Homelab/VPS)|                   | (Workstation Terminal) |
             +------------------------+                   +------------------------+
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

Sensitive tokens (Discord Bot Token, Language Server CSRF headers, webhook secrets) stored in SQLite are encrypted before being written to disk using native Node 26 `node:crypto` AES-256-GCM authenticated encryption (`enc:v1:<iv>:<tag>:<ciphertext>`). On all REST API routes (`GET /api/config`), secret values are masked (`••••••••`) to prevent accidental credential leakage in browser network logs or client inspection.

### 3.3. AI Overcharge & Credit Safety Floor

A task is blocked from dispatch when the headroom of its chosen pool is **strictly below** `MIN_DISPATCH_HEADROOM_PERCENT` (default `10%`), protecting against billable AI overages.

The check **fails closed**: headroom is also treated as below the floor when it cannot be established — no readable pool for the requested family, stale telemetry, or an unparseable fraction. An unknown quota is never assumed to be full. The refusal reaches the caller as HTTP 400 with `OVERAGE_PROTECTION_TRIGGERED` or `TELEMETRY_UNAVAILABLE`.

`allowOverage: true` is the override, and it is the honest record of your billing posture: the language server does not report whether overages are enabled, so Agylity cannot detect it for you. Note that setting the floor to `0` disables the check entirely — with overages enabled on your account that is an unbounded spend path, so only do it for flat-tier or non-metered accounts.

### 3.4. Strict Single-User Binding (Single-Tenant Invariant)

An Antigravity Pro/Individual license represents a single developer seat and must never be exposed as a multi-tenant proxy or shared service bureau:

- **Explicit Owner Binding (`DISCORD_OWNER_USER_ID`)**: When configured via `.env` or SQLite UI override (`discordOwnerUserId`), `DiscordNotifier` verifies `interaction.user.id === discordOwnerUserId` across every slash command (`/quota`), repository selector (`repo_select`), and modal submission (`modal_dispatch`). Unauthorized users are immediately rejected with an ephemeral `[Blocked] Single-User Binding` response.
- **Trust-On-First-Use (TOFU) Session Pinning**: If `DISCORD_OWNER_USER_ID` is not explicitly set, `DiscordNotifier` automatically pins the first Discord user ID that interacts with the instance for the duration of the session and blocks any subsequent interactions from secondary Discord users in the same guild or channel.

### 3.5. Three-Tier Precedence Hierarchy with UI Overrides

Configuration is resolved dynamically across three tiers:
$$\text{Resolved Value} = \text{SQLite UI Overrides} \mathbin{??} \text{Environment Variables} \mathbin{??} \text{Built-in Defaults}$$
Changes made in the Web UI take immediate effect over the in-memory event bus (dynamically updating active notification channels, Language Server endpoints, and quota evaluator thresholds/milestones) without requiring process restarts.

### 3.6. Application-Native IP Filtering & Anti-Spoofing Defense (CWE-290)

Zero-dependency IPv4/IPv6 and CIDR subnet parser (`src/web/ip.ts`):

- **Dynamic Posture**: Inactive when `ALLOWED_IP_RANGES` is empty; strictly active when entries exist.
- **Proxy Header Spoof Protection**: Reverse proxy headers (`CF-Connecting-IP`, `X-Real-IP`, `X-Forwarded-For`) are strictly ignored unless the direct TCP peer socket (`req.socket.remoteAddress`) is verified as a loopback or RFC1918 private network hop (`127.0.0.0/8`, `::1/128`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`, `fe80::/10`). Direct external connections attempting header injection are evaluated against their physical peer IP.

### 3.7. Edge Rate Limiting & Timing-Safe Control Plane

`WEB_UI_AUTH_TOKEN` is mandatory for a non-loopback `WEB_UI_HOST`: the server refuses to start without it, and only warns for a loopback bind. When configured:

- **Route Lockdown**: All `/api/*` routes require Bearer token authorization, except public `/api/health` and runner-authenticated endpoints (`/api/tasks/poll`, `/api/tasks/:id/status`, `/api/workers/register`).
- **Timing-Safe Verification**: Bearer tokens and runner shared secrets are verified using constant-time `crypto.timingSafeEqual` with buffer length validation.
- **Anti-Brute-Force Sliding Window**: In-memory rate limiter tracks failed authentication attempts per IP. 10 failures within 60s temporarily blocks the IP with HTTP 429 (`Retry-After: 60`).

### 3.8. Zero-DOM-Leak Control Plane Gate (`<ControlPlaneGate />`)

In the Web UI, unauthenticated requests or active lockouts completely unmount the application shell:

- Rather than displaying a dismissable translucent overlay over private dashboards, unauthenticated users see a solid, dedicated full-screen lock screen.
- Zero dashboard views, navigation sidebars, settings forms, or embed simulators exist in the DOM until a valid Bearer token is verified.
- Authenticated sessions provide in-place session locking from the TopBar, instantly purging local credentials and remounting the secure gate.

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
  - **Embedded Persistence**: Native Node 26 `node:sqlite` (`DatabaseSync`) in WAL mode.
  - **Fast HTTP**: Native Node `node:http` (zero Express/Fastify bloat).
  - **Test Suite**: Native Node 26 test runner (`node:test`, `node:assert/strict`).

---

## 5. Subsystem Breakdown

1. **Configuration Store (`src/config/`)**: Manages the three-tier precedence hierarchy (`SQLite Overrides ?? .env ?? Defaults`). Emits granular change events over an in-memory event bus.
2. **Quota Sentry (`src/sentry/`)**: Connect-RPC client with automatic port-hunting (`60643` $\to$ `60642`), model pooling aggregator, milestone evaluator (`24h`, `12h`, `3h`), and atomic alert state deduplication (`data/state.json`).
3. **Pluggable Multi-Channel Notifications (`src/notify/`)**: Universal `Notifier` interface backed by `CompositeNotifier` fan-out to active adapters (`Discord`, `Webhook`, `Console`, `None`) with dynamic `import()` isolation. Inactive notification channels never load `discord.js` into memory or bind listeners.
4. **Optional Swarm Orchestrator**: Decoupled and optional (`orchestratorEnabled: false` by default). When disabled, zero execution resources or dispatch sockets are initialized.
5. **Decoupled Web Dashboard (`src/web/` & `frontend/`)**: Modern reactive dashboard built with **Vite + Preact + Tailwind CSS v4** served via native `node:http`. Zero overhead when disabled (`WEB_UI_ENABLED=false`).
6. **Universal Pluggable Logging Subsystem (`src/logs/`)**: Hierarchical, zero-dependency logging engine (`Logger`, `DefaultLogger`, `logger.child()`) with pluggable sinks (`console`, in-memory `LogBuffer`, memory sink for unit tests). Enforces fault-isolated sink execution, dynamic log-level filtering (`LOG_LEVEL`), secret-redacting in-memory ring buffering, and real-time streaming to the Web UI (`GET /api/logs`).

---

## 6. Universal Pluggable Logging Architecture

Agylity incorporates a lightweight, universal logging subsystem designed for production visibility without external log framework bloat:

```
+-------------------------------------------------------------------------+
|                              Logger Core                                |
|  logger.child('sentry') / logger.child('web') / logger.child('daemon')  |
+------------------------------------+------------------------------------+
                                     |
                                     v (Format & LogRecord Dispatch)
                   +-----------------+-----------------+
                   |                                   |
                   v (Default Console Sink)            v (Buffer Sink)
+------------------------------------+   +--------------------------------+
|       Terminal / Docker stdout     |   |    LogBuffer (In-Memory Ring)  |
|      (console.log/warn/error)      |   |  (Secret Redaction & Monotonic)|
+------------------------------------+   +---------------+----------------+
                                                         |
                                                         v
                                         +--------------------------------+
                                         |     Web UI Logs Dashboard      |
                                         |       (GET /api/logs)          |
                                         +--------------------------------+
```

### 6.1. Core Invariants

1. **Zero External Logging Dependencies**:
   - Powered purely by Node's native `node:util` `format` module, supporting format specifiers (`%s`, `%d`, `%j`), multiple arguments, and `Error` stack traces.
2. **Pluggable Sinks & Extensibility**:
   - Consumers can add or replace sinks via `logger.addSink(sink)`, `logger.removeSink(sink)`, and `logger.setSinks([...])`.
   - Built-in sinks:
     - `createConsoleSink()`: Standard output to stdout/stderr with component tagging (`[sentry]`, `[daemon]`, `[web]`).
     - `createBufferSink(buffer)`: Feeds structured logs directly into the bounded, secret-redacting in-memory `LogBuffer`.
     - `createMemorySink()`: Records log entries in an array for unit testing assertions.
3. **Fault-Isolated Execution**:
   - Sinks are executed inside individual `try ... catch` blocks. A failing or throwing sink (e.g. disk write failure or network transport crash) will never crash the daemon or prevent other sinks from logging.
4. **Child Namespacing & Tag Cleanliness**:
   - `logger.child('sentry')` tags entries with `[sentry]`. Nested child loggers produce colon-delimited namespaces (e.g. `[sentry:rpc]`).
   - Prevents duplicate tagging if a log message already contains the component prefix.
5. **Dynamic Level Configuration**:
   - Supports `debug`, `info`, `warn`, and `error` log levels.
   - Configurable at boot via `LOG_LEVEL` environment variable.
   - Reactively syncs to new log levels at runtime via `configStore.on('change', ...)` without daemon restarts.
6. **Secret Redaction**:
   - High-entropy secrets (Discord bot tokens, CSRF tokens, webhook URLs/secrets, encryption keys) are masked before persistence in the ring buffer or exposure via `/api/logs`.

---

## 7. Pull-Based Worker Swarm Architecture

Agylity's execution model is a **Pull-Based Worker Swarm**:

```
Coordinator (Homelab / Cloud)
  ├── SQLite Task Queue (scheduleMode: immediate | pre_reset)
  ├── Discord Bot (/dispatch modal)
  └── REST API (/api/tasks/poll)
        ▲
        │ (Outbound HTTPS Long-Poll)
        ├── Headless Worker (Docker on homelab/VPS) -> Unattended tasks
        └── Visible Worker (Home Desktop PC)        -> Supervised tasks in active terminal
```

### 7.1. Architectural Principles & Invariants

1. **Outbound Long-Polling (Inbound Firewall Invariant)**:
   - Worker machines connect outbound via HTTPS to `/api/tasks/poll`.
   - Zero inbound listening ports, dynamic DNS punch-through, or port forwarding are required on worker nodes.
2. **Task Scheduling**: every task carries a `scheduleMode`.
   - **`immediate`**: run as soon as a matching worker polls.
   - **`pre_reset`**: opportunistic quota-burn. The task is enqueued immediately but stays unclaimed until the reset deadline is imminent and headroom is ample, so free allowance is used rather than forfeited. Until then it reports `QUOTA_BURN_QUEUED`.
3. **Target Routing by Labels and Repository**:
   - A task declares `requiredLabels`; a worker claims it only if it holds **all** of them, and only if the task's repository is in the worker's own scope. A worker's scope comes from its registration — the poll payload may narrow it, never widen it.
4. **Safety Floor Rule**:
   - The coordinator blocks a dispatch when headroom is **strictly below** `MIN_DISPATCH_HEADROOM_PERCENT` (default `10%`), and equally when headroom is **unknown** (no readable pool for the requested family, stale telemetry, or an unparseable fraction). Unknown is never treated as full headroom. Both refusals reach the caller as HTTP 400 with `OVERAGE_PROTECTION_TRIGGERED` or `TELEMETRY_UNAVAILABLE`; `allowOverage: true` is the documented override.
5. **Alerting-First Operational Mode**:
   - `ORCHESTRATOR_ENABLED=false` (the default) runs Agylity in pure sentry mode: dispatch attempts cleanly return `ORCHESTRATOR_DISABLED` and no execution resources are initialised.

---

## 8. Repository Architecture

```
agylity/
├── .github/
│   └── workflows/
│       └── docker-publish.yml  # Dual-stage CI (PR validation & typecheck) & CD (GHCR container release)
├── docs/                       # Authoritative operational guides
│   ├── architecture.md         # System design, Connect-RPC, security invariants
│   ├── configuration.md        # Environment variables & SQLite hierarchy
│   ├── deployment.md           # Docker Compose, Arcane GitOps, systemd
│   └── testing.md              # Test layout, coverage by suite, and commands
├── frontend/                   # Dedicated Vite + Preact + Tailwind CSS client
│   ├── public/                 # Static vector assets (favicon, icons)
│   ├── src/                    # Preact components, hooks, and types
│   ├── package.json            # Client workspace dependencies
│   └── vite.config.ts          # Bundles directly to dist/web/public
├── src/                        # Pure TypeScript daemon source
│   ├── cli/                    # Daemon entrypoint, startup banner & log-buffer wiring
│   ├── config/                 # Zod validation & SQLite store hierarchy
│   ├── daemon/                 # Probe scheduler, milestone evaluation & lifecycle
│   ├── logs/                   # Universal pluggable logger & secret-redacting buffer
│   ├── notify/                 # Pluggable notifiers (Discord, Console, Webhook)
│   ├── orchestrator/           # Swarm coordinator, task queue, model routing & worker runner
│   ├── sentry/                 # Connect-RPC client, model pools & evaluator
│   ├── storage/                # Native node:sqlite database & AES-256-GCM crypto
│   ├── web/                    # Native HTTP server & REST API routes
│   ├── version.ts              # Shared version constant, read from package.json
│   ├── worker-cli.ts           # Standalone headless swarm worker runner CLI
│   └── index.ts                # Daemon bootstrap & graceful shutdown coordinator
├── tests/                      # Deterministic test suites (unit + e2e)
│   ├── e2e/                    # Opaque-box E2E suites & shared mock harness
│   └── unit/                   # Focused unit tests
├── Dockerfile                  # Multi-stage production container (node:26-slim)
├── docker-compose.yaml         # Container deployment definition (ports: 8484:8484)
├── LICENSE                     # PolyForm Noncommercial License 1.0.0
├── package.json                # Root manifest (Node >=26, minimal dependencies)
├── tsconfig.json               # NodeNext, strict: true
└── README.md                   # Clean project landing page & quickstart
```
