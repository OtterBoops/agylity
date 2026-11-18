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
                                  |   Pull-Based Swarm Queue  | (Optional; COORDINATOR_ENABLED)
                                  |   SQLite Task Queue       |
                                  +-------------+-------------+
                                                ▲
                                                │ (Outbound HTTPS Long-Poll)
                         +----------------------+----------------------+
                         |                                             |
             +-----------+------------+                   +------------+-----------+
             | Headless Runner        |                   | Visible Runner         |
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

Continuation tasks are designed to be executed strictly on designated runner machines or homelab containers via pull-based swarm runners, never headlessly on the monitoring daemon host.

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

- **Route Lockdown**: every `/api/*` route requires Bearer authorization, except public `GET /api/health` and the four runner-token endpoints (`POST /api/tasks/poll`, `POST /api/tasks/:id/status`, `POST /api/runner/heartbeat`, `POST /api/runners/register`). The full surface is tabulated in §3.9.
- **Loopback Exemption**: `WEB_UI_AUTH_EXEMPT_LOCALHOST` (default `true`) skips the token requirement only when _both_ the resolved client IP and the direct peer socket address are loopback — one forwarded header alone is never enough.
- **Timing-Safe Verification**: both sides are hashed with SHA-256 before `crypto.timingSafeEqual`, so the comparison runs over fixed-width digests and a wrong token cannot be distinguished by its length. Runner shared secrets are stored as SHA-256 hex (`hashRunnerToken`) and compared the same way.
- **Anti-Brute-Force Sliding Window**: In-memory rate limiter tracks failed authentication attempts per IP. 10 failures within 60s temporarily blocks the IP with HTTP 429 (`Retry-After: 60`). The map is pruned of expired records and capped at 10,000 entries.
- **Body Ceiling**: request bodies are capped at 64 KB (`MAX_BODY_BYTES`, `src/web/http.ts`); an oversized body is answered with 413 and the socket drained. Runner status reports are pre-clipped to 56 KB by `fitStatusPayload` before they are sent, so a legitimate report can never trip the ceiling.

### 3.8. Control-Plane HTTP Surface

`src/web/routes.ts` is the single router. Paths below are the only ones the server answers; anything else outside the static/SPA shell is a `404` plain-text response.

| Route                                  | Auth   | Notes                                                             |
| :------------------------------------- | :----- | :---------------------------------------------------------------- |
| `GET /api/health`                      | public | Liveness only; reports `authRequired`.                            |
| `GET /api/quota`                       | Bearer | Current pools, limits and reset deadlines.                        |
| `GET /api/alerts`                      | Bearer | Active alert state.                                               |
| `POST /api/alerts/dismiss`             | Bearer | Clears the active alert set.                                      |
| `GET /api/alerts/events`               | Bearer | Paginated alert history (`limit` ≤ 200, `before` cursor, `pool`). |
| `GET /api/logs`                        | Bearer | Redacted in-memory log ring, query-filterable.                    |
| `GET /api/config`                      | Bearer | Resolved config, overrides, secret metadata.                      |
| `POST /api/config`                     | Bearer | Upsert overrides (`{key,value}` or `{set,clear}`).                |
| `DELETE /api/config/:key`              | Bearer | Removes one override.                                             |
| `POST /api/notify/test`                | Bearer | Fires a test notification through active channels.                |
| `POST /api/dispatch`                   | Bearer | Enqueues an `immediate`-tier task.                                |
| `GET /api/models`                      | Bearer | Model catalog with pool mapping and effort options.               |
| `GET /api/dispatch/eligibility`        | Bearer | Pre-flight safety-floor verdict for a dispatch.                   |
| `GET /api/tasks`                       | Bearer | Task list (the heavy `output` column is omitted).                 |
| `GET /api/tasks/:id`                   | Bearer | Single task, including `output`.                                  |
| `POST /api/tasks/:id/cancel`           | Bearer | Cancels a queued or executing task.                               |
| `POST /api/tasks/:id/retry`            | Bearer | Re-queues a terminal task.                                        |
| `GET /api/backlog`                     | Bearer | Backlog items.                                                    |
| `POST /api/backlog`                    | Bearer | Creates one backlog item.                                         |
| `PATCH /api/backlog/bulk`              | Bearer | Pause/resume up to 200 ids (`{action, ids}`).                     |
| `POST /api/backlog/sync-github`        | Bearer | Pulls labelled issues into the backlog.                           |
| `GET /api/backlog/:id`                 | Bearer | Single backlog item.                                              |
| `PATCH /api/backlog/:id`               | Bearer | Edits fields or re-arms a failed item.                            |
| `DELETE /api/backlog/:id`              | Bearer | Deletes the item.                                                 |
| `POST /api/backlog/:id/dispatch`       | Bearer | Dispatches one item now.                                          |
| `GET /api/routines`                    | Bearer | Routine definitions.                                              |
| `POST /api/routines`                   | Bearer | Creates a routine.                                                |
| `GET /api/routines/:id`                | Bearer | Single routine.                                                   |
| `PATCH /api/routines/:id`              | Bearer | Edits a routine (including `enabled`).                            |
| `DELETE /api/routines/:id`             | Bearer | Deletes the routine.                                              |
| `POST /api/routines/:id/trigger`       | Bearer | Manual trigger, subject to the one-in-flight rule.                |
| `GET /api/runners`                     | Bearer | Registered runners, status and last-seen timestamps.              |
| `POST /api/runners/registration-token` | Bearer | Mints a short-lived enrolment token.                              |
| `PATCH /api/runners/:id`               | Bearer | Enables or disables a runner (`{enabled}`).                       |
| `DELETE /api/runners/:id`              | Bearer | Revokes a runner and its token hash.                              |
| `POST /api/tasks/poll`                 | Runner | Long-poll for a claimable task.                                   |
| `POST /api/tasks/:id/status`           | Runner | Intermediate and final status reports.                            |
| `POST /api/runner/heartbeat`           | Runner | Lease keep-alive while executing.                                 |
| `POST /api/runners/register`           | Runner | Exchanges a registration token for a runner id.                   |

"Bearer" means the `WEB_UI_AUTH_TOKEN` control-plane check; "Runner" means the request carries a runner credential and is exempt from the web token. The HTML shell and hashed assets are served unauthenticated — the client-side `<ControlPlaneGate />` (§3.9) is what withholds the dashboard DOM, so no API data is reachable without the token.

### 3.9. Zero-DOM-Leak Control Plane Gate (`<ControlPlaneGate />`)

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
- **Development Tooling**: `typescript`, `@types/node`, `tsx`, plus `eslint`, `prettier` and the Tailwind CSS v4 toolchain used by the frontend build. None of it ships in the runtime image.
- **Zero Third-Party Primitives**:
  - **Cryptographic Security at Rest**: Native `node:crypto` AES-256-GCM authenticated encryption. Sensitive tokens (Discord Bot Tokens, CSRF headers, webhook secrets) are encrypted before writing to SQLite and masked across all REST endpoints.
  - **Embedded Persistence**: Native Node 26 `node:sqlite` (`DatabaseSync`) in WAL mode.
  - **Fast HTTP**: Native Node `node:http` (zero Express/Fastify bloat).
  - **Test Suite**: Native Node 26 test runner (`node:test`, `node:assert/strict`).

---

## 5. Subsystem Breakdown

1. **Configuration Store (`src/config/`)**: Manages the three-tier precedence hierarchy (`SQLite Overrides ?? .env ?? Defaults`). Emits granular change events over an in-memory event bus.
2. **Quota Sentry (`src/sentry/`)**: Connect-RPC client with automatic port-hunting (`60643` $\to$ `60642`), model pooling aggregator, milestone evaluator (`48h`, `24h`, `12h`), and atomic alert state deduplication (`data/state.json`). Premature-reset notices are deduplicated per cycle on `(pool_id, reset_time, kind = 'early_reset')` in the alert ledger, so upstream quota that flaps after an early reset is announced once.
3. **Pluggable Multi-Channel Notifications (`src/notify/`)**: Universal `Notifier` interface backed by `CompositeNotifier` fan-out to active adapters (`Discord`, `Webhook`, `Console`, `None`) with dynamic `import()` isolation. Inactive notification channels never load `discord.js` into memory or bind listeners.
4. **Optional Swarm Coordinator**: Decoupled and optional (`coordinatorEnabled: false` by default). When disabled, zero execution resources or dispatch sockets are initialized.
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
   - The buffer and in-memory sinks live in the test harness (`tests/e2e/harness/index.ts`): `createBufferSink(buffer)` feeds the bounded, secret-redacting `LogBuffer`, and `createMemorySink()` records entries for assertion.
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

## 7. Pull-Based Runner Swarm Architecture

Agylity's execution model is a **Pull-Based Runner Swarm**:

```
Coordinator (Homelab / Cloud)
  ├── SQLite Task Queue (tier: immediate | backlog | routine, scheduleMode: immediate | pre_reset)
  ├── Discord Bot (/dispatch modal)
  └── REST API (/api/tasks/poll)
        ▲
        │ (Outbound HTTPS Long-Poll)
        ├── Headless Runner (Docker on homelab/VPS) -> Unattended tasks
        └── Visible Runner (Home Desktop PC)        -> Supervised tasks in active terminal
```

### 7.1. Architectural Principles & Invariants

1. **Outbound Long-Polling (Inbound Firewall Invariant)**:
   - Runner machines connect outbound via HTTPS to `/api/tasks/poll`.
   - Zero inbound listening ports, dynamic DNS punch-through, or port forwarding are required on runner nodes.
2. **Task Scheduling**: every task carries a `scheduleMode`.
   - **`immediate`**: run as soon as a matching runner polls.
   - **`pre_reset`**: opportunistic quota-burn. The task is enqueued immediately but stays unclaimed until the reset deadline is imminent and headroom is ample, so free allowance is used rather than forfeited. Until then it reports `QUOTA_BURN_QUEUED`.
3. **Target Routing by Labels and Repository**:
   - A task declares `requiredLabels`; a runner claims it only if it holds **all** of them, and only if the task's repository is in the runner's own scope. A runner's scope comes from its registration — the poll payload may narrow it, never widen it.
4. **One Active Task per Runner**:
   - `claimNext` hands out nothing while the runner's `active_task_id` still points at a task in
     `claimed`/`executing`: a second claim would overwrite the pointer and leave the first task's lease
     to expire with nobody executing it. A pointer left over from a task that already finished or
     vanished is cleared on the next poll, so a runner whose final report was lost resumes work instead
     of idling forever.
5. **Runner Reports Are Ownership-Scoped**:
   - A status report carrying a `runnerId` only applies to the row whose `runner_id` matches it, so a
     runner can never settle a task it was not handed. A `queued` task (`runner_id IS NULL`) is settled
     only by the coordinator itself: the reaper, a cancel, or the backlog reconciler.
6. **Safety Floor Rule**:
   - The coordinator blocks a dispatch when headroom is **strictly below** `MIN_DISPATCH_HEADROOM_PERCENT` (default `10%`), and equally when headroom is **unknown** (no readable pool for the requested family, stale telemetry, or an unparseable fraction). Unknown is never treated as full headroom. Both refusals reach the caller as HTTP 400 with `OVERAGE_PROTECTION_TRIGGERED` or `TELEMETRY_UNAVAILABLE`; `allowOverage: true` is the documented override.
7. **Alerting-First Operational Mode**:
   - `COORDINATOR_ENABLED=false` (the default) runs Agylity in pure sentry mode: dispatch attempts cleanly return `COORDINATOR_DISABLED` and no execution resources are initialised.

### 7.2. Task Taxonomy: Three Tiers

| Tier        | Source row      | Created through                                         | First dispatched by                                       |
| :---------- | :-------------- | :------------------------------------------------------ | :-------------------------------------------------------- |
| `immediate` | `swarm_tasks`   | Web UI, Discord, `POST /api/dispatch`                   | `coordinator.dispatch`                                    |
| `backlog`   | `backlog_tasks` | `POST /api/backlog`, GitHub label sync                  | autonomous evaluator, or `POST /api/backlog/:id/dispatch` |
| `routine`   | `routine_tasks` | `POST /api/routines`, legacy `standing_tasks` migration | pre-reset evaluator, or `POST /api/routines/:id/trigger`  |

Every `swarm_tasks` row carries `tier`, `origin_id`, `origin_number` and `origin_title`, which is what
lets the dashboard link a run back to the item that produced it.

- **Autonomy quench**: the autonomous evaluator runs on each quota probe but stays quiet for two hours
  after an `immediate`-tier dispatch (a human started it now). The timestamp lives in `runtime_state`, so a
  redeploy does not re-arm autonomous work.
- **Tier 2 (backlog)**: at most one item per probe, gated on effective headroom of at least
  `max(40, MIN_DISPATCH_HEADROOM_PERCENT)`.
- **Tier 3 (routine)**: sequential looping inside one pool reset cycle — a routine re-triggers as soon
  as its previous run reaches `completed`, while the window and headroom still hold. At most one run is
  in flight per routine at any time (checked against `origin_id`, so a manual trigger counts too), and a
  `failed`/`aborted` run burns the rest of the cycle: `last_triggered_reset_time` plus the terminal
  status of `last_task_id` is the gate. Released only inside `trigger_before_reset_hours` and only while
  headroom is at least `max(routine.min_headroom_percent, MIN_DISPATCH_HEADROOM_PERCENT)`. Needs
  `COORDINATOR_ENABLED` and `ROUTINES_ENABLED`.
- **Burn kick notice**: the first time a pool's pre-reset window opens in a reset cycle — whether from a
  routine or from an opportunistic `pre_reset` task being claimed — one silent `[Notice]` is delivered
  through every configured channel. It is informational by construction: no owner mention, so it cannot
  page anyone. The announced cycle per pool is recorded in `runtime_state` (`burnKickAnnouncedCycles`),
  so looping inside the same cycle does not repeat it and a redeploy does not re-announce it.
- **Model preference chains**: both autonomous tiers store an ordered `models[]` and dispatch the
  first candidate whose pool clears the floor (`evaluateModelPreferenceChain`). A model id that maps
  to no pool is refused rather than charged to another family's headroom.
- **Origin settlement**: a backlog item closes on `completed`/`no_changes`, returns to `pending` while
  `attempt_count < max_attempts`, then `failed`. Settlement runs from the runner's status report _and_
  from the reconciler sweep, which is what covers a reaped lease, a queued task that expired, and a
  user cancel — none of those produce a runner report.
- **Routes**: `GET|POST /api/backlog`, `PATCH /api/backlog/bulk`, `GET|PATCH|DELETE /api/backlog/:id`,
  `POST /api/backlog/:id/dispatch`, `POST /api/backlog/sync-github`, `GET|POST /api/routines`,
  `GET|PATCH|DELETE /api/routines/:id`, `POST /api/routines/:id/trigger`. A refusal by the safety floor
  is HTTP 400 on every one of them, including the two single-item dispatch routes.

### 7.3. Runner Execution Lifecycle

A runner cycle is gated in four places, and every gate fails safe rather than burning a run:

1. **CLI auth gate (before any claim)**: the runner executes `agy --output-format json models` and
   claims nothing until that returns successfully. A pass is cached for 5 minutes, so polling does not
   shell out on every cycle; a CLI auth failure backs off 30 seconds and logs a `[Blocked]` line telling
   the operator to authenticate (`docker exec -it agylity agy`). Without this gate an unauthenticated
   CLI would be discovered only after a clone and a full agent run.
2. **Lease heartbeat (while executing)**: `POST /api/runner/heartbeat` every 10 seconds with `taskId`,
   `runnerId` and a tail of the live output. A `409` means the lease is gone — the task was cancelled or
   reaped and now belongs to someone else — so the runner aborts the task immediately. Every other
   outcome (5xx, timeout, transport error) is logged and ignored: a coordinator hiccup must never kill
   real work. Beats do not stack; a tick is skipped while the previous one is still in flight.
3. **Credential rejection**: a `401`/`403` from the coordinator marks the runner credential rejected and
   pauses polling for 60 seconds, with one warning to mint a new registration token. Retrying a dead
   token in a tight loop is treated as the bug it is.
4. **Final status report**: attempted twice (one retry) on transport failures and 5xx only — a 4xx will
   never get better, so it is not retried. A `409` means the task is already terminal and is treated as
   settled. The body is pre-clipped to 56 KB by `fitStatusPayload`, which shortens `output`/`error`
   tail-first, so a legitimate report always fits under the server's 64 KB ceiling.

Coordinator-side bookkeeping matches it: an executing lease with no heartbeat for **10 minutes** is
reaped as `failed` (the reaper deliberately does not refresh `last_seen_at`, so the offline sweep still
notices the dead runner), runners whose `last_seen_at` is older than **10 minutes** are pruned, and the
newest **250** terminal tasks are retained. Registration tokens are kept to the 50 most recent.

A one-time registration token is spent by the runner's first authenticated request, not by the exchange,
so a runner that dies before it can write `runner.json` re-exchanges the same token instead of being
stranded; an exchange naming a runner an operator has since disabled is refused rather than silently
re-enabling it. A long-poll whose client socket has already closed claims nothing, so a hung-up poll
cannot strand a task until its lease expires.

### 7.4. Repository Clone Strategy

Runners clone through a local bare mirror cache keyed by the clone URL:
`<os tmpdir>/agylity-repo-mirrors/<sha256-of-clone-url>.git`. The mirror is created once with
`git clone --bare` and refreshed with `git fetch --prune` on later runs (a failed fetch logs and reuses
the mirror it already has), then the working copy is produced with
`git clone --reference-if-able <mirror> --dissociate`. `--dissociate` copies the objects the clone
actually needs, so deleting the mirror later cannot corrupt a working tree. If anything in the mirror
path fails, the runner removes the half-written target and falls back to a plain `git clone`. The cache
directory is container-local in Docker and is not persisted by the shipped compose file, so the first
task after a container restart pays for one cold clone to rebuild it.

---

## 8. Persistent Schema (`node:sqlite`)

The coordinator's queue schema is declared as column specs in `src/coordinator/queue.ts` and applied
through forward-only migrations recorded in `schema_migrations` (current head: `v3_cascade_hops`).
A fresh database is built from the current specs; an existing one is upgraded with idempotent
`ALTER TABLE ... ADD COLUMN` repairs, so a restart never re-creates a table or drops a row.

| Table                        | Columns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| :--------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `swarm_tasks`                | `id`, `task_number`, `title`, `tier`, `origin_id`, `origin_number`, `origin_title`, `created_at`, `updated_at`, `repository_id`, `repository_name`, `repository_path`, `clone_url`, `default_branch`, `prompt`, `requested_by`, `pr_policy`, `schedule_mode`, `required_labels_json`, `model`, `candidate_models_json`, `pool_family`, `effort`, `allow_overage`, `push_branch`, `auto_create_pr`, `pr_url`, `expires_at`, `verify_command`, `status`, `runner_id`, `claimed_at`, `heartbeat_at`, `completed_at`, `branch_name`, `output`, `error`, `duration_ms`, `num_turns`, `total_tokens`, `thinking_tokens` |
| `backlog_tasks`              | `id`, `task_number`, `title`, `prompt`, `repository_id`, `models_json`, `verify_command`, `auto_create_pr`, `pr_policy`, `priority_order`, `status`, `attempt_count`, `max_attempts`, `last_error`, `swarm_task_id`, `github_issue_number`, `github_issue_url`, `created_at`, `updated_at`                                                                                                                                                                                                                                                                                                                        |
| `routine_tasks`              | `id`, `task_number`, `title`, `prompt`, `repository_id`, `models_json`, `verify_command`, `auto_create_pr`, `pr_policy`, `enabled`, `sort_order`, `trigger_before_reset_hours`, `min_headroom_percent`, `last_triggered_reset_time`, `last_triggered_cycles_json`, `last_task_id`, `created_at`, `updated_at`                                                                                                                                                                                                                                                                                                     |
| `swarm_runners`              | `runner_id`, `name`, `token_hash`, `labels_json`, `repositories_json`, `system_info_json`, `enabled`, `active_task_id`, `status`, `registered_at`, `last_seen_at`                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `swarm_runner_registrations` | `id`, `token_hash`, `name_hint`, `labels_json`, `repositories_json`, `expires_at`, `created_at`, `consumed_by_runner_id`, `consumed_at`                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `runtime_state`              | `key`, `value`, `updated_at` — quench timestamps, announced burn cycles and other cross-restart bookkeeping.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Defaults worth knowing about: `swarm_tasks.tier` is `immediate`, `schedule_mode` is `immediate`,
`pr_policy` is `inherit`, `effort` is `high`, `push_branch` and `auto_create_pr` are `1`,
`allow_overage` is `0`, and `status` starts at `queued`. `backlog_tasks.max_attempts` defaults to `2`,
`routine_tasks.min_headroom_percent` to `10`, and `routine_tasks.enabled` to `1`. All three task tables
carry a `title`; `swarm_tasks` also denormalises `repository_name`, `repository_path`, `clone_url` and
`default_branch` so a run is reproducible from its own row. `swarm_tasks.output` is capped at 512 KB
per task (tail-kept, with a truncation marker), and `GET /api/tasks` omits that column.

Two column families carry JSON: `*_json` model chains are ordered cascade hops
(`[{ model, effort }]`), rewritten in place by migration v3, and `required_labels_json` /
`labels_json` / `repositories_json` are string arrays. Uniqueness: `task_number` on all three task
tables, `token_hash` on registrations. Indexes: `idx_swarm_tasks_queue (status, created_at)` and the
three `task_number` unique indexes.

Dropped columns are not coming back: `backlog_tasks.effort` and `routine_tasks.effort` were folded into
the cascade hops, and the old `standing_task_id` link is gone — routine lineage travels in
`swarm_tasks.origin_id` / `origin_number` / `origin_title` plus `routine_tasks.last_task_id`.

---

## 9. Repository Architecture

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
│   ├── coordinator/            # Swarm coordinator, task queue & model routing
│   ├── runner/                 # Pull-runner: executor, git auth, PR policy & coordinator client
│   ├── sentry/                 # Connect-RPC client, model pools & evaluator
│   ├── storage/                # Native node:sqlite database & AES-256-GCM crypto
│   ├── web/                    # Native HTTP server & REST API routes
│   ├── version.ts              # Shared version constant, read from package.json
│   ├── runner-cli.ts           # Standalone headless swarm runner CLI
│   └── index.ts                # Daemon bootstrap & graceful shutdown coordinator
├── tests/                      # Deterministic test suites (unit + e2e)
│   ├── e2e/                    # Opaque-box E2E suites & shared mock harness
│   └── unit/                   # Focused unit tests
├── Dockerfile                  # Multi-stage production container (node:26-slim)
├── docker-compose.yaml         # Container deployment definition (ports: 8484:8484)
├── docker/entrypoint.sh        # Boot-time agy refresh, then exec the container command
├── LICENSE                     # PolyForm Noncommercial License 1.0.0
├── package.json                # Root manifest (Node >=26, minimal dependencies)
├── tsconfig.json               # NodeNext, strict: true
└── README.md                   # Clean project landing page & quickstart
```
