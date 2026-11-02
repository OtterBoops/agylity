---
name: agylity
description: >-
  Authoritative architecture, language server RPC protocols, ToS compliance guardrails,
  and operational use cases for Agylity (autonomous Antigravity quota sentry & swarm task orchestrator).
  Trigger whenever developing, debugging, extending, or automating Antigravity, quota monitoring, or agy tasks.
---

# Agylity Operational & Architecture Playbook

## 1. System Topology & Strict Dependency Posture

- **Repository Location:** `D:/Code/OtterBoops/agylity`
- **Runtime:** Pure TypeScript targeting Node 26 (`node:26-slim`).
- **Zero-CVE Minimal Dependency Surface:**
  - Runtime dependencies: `discord.js@^14.27.0`, `ky@^2.2.0`, `zod@^4.6.7`.
  - Storage: Native `node:sqlite` (`data/agylity.db`) in WAL mode with `PRAGMA busy_timeout = 5000;`.
  - Process Execution: Native `node:child_process.execFile` with array arguments.
- **Zod v4 API Invariant:**
  - Validation error collections in Zod v4 must strictly be accessed via `result.error.issues` (`result.error.errors` does not exist in Zod v4).
- **Frontend Stack:** Vite + Preact + Tailwind CSS (`frontend/`) serving a strictly decoupled dashboard. If `WEB_UI_ENABLED=false`, zero HTTP server or listener is bound.
- **Native Modal Invariant:**
  - All modals in the Preact UI strictly use the native HTML `<dialog>` element triggered via `dialogRef.current.showModal()`, eliminating custom fixed-position `role="dialog"` div overlays.
- **Web UI & Control-Plane Security & Lock Invariant:**
  - `WEB_UI_AUTH_TOKEN`: When configured, control-plane endpoints enforce constant-time Bearer token verification (`crypto.timingSafeEqual`) and anti-brute-force sliding-window rate limiting (HTTP 429 after 10 failed attempts within 60s). Runner endpoints (`/api/tasks/poll`, `/api/tasks/:id/status`, `/api/workers/register`) use dedicated runner authentication tokens.
  - Zero-DOM-Leak Lock Screen: Unauthenticated requests or locked sessions unmount the application shell completely, rendering a dedicated full-screen `<ControlPlaneGate />`. Zero private views, sidebars, or settings forms are exposed in the DOM.
- **Application-Native IP Filtering & Anti-Spoofing (CWE-290):**
  - `ALLOWED_IP_RANGES`: Zero-dependency IPv4/IPv6 and CIDR allowlist engine. Dynamically active only when entries exist.
  - `TRUSTED_PROXIES`: Proxy headers (`CF-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP`) are strictly ignored unless the direct TCP peer socket (`req.socket.remoteAddress`) is verified as an RFC1918 private network or loopback hop. Direct external connections attempting header injection are evaluated against their physical peer IP.
- **Non-Blocking Telemetry & Hidden Execution:**
  - Background stale-while-revalidate credits probing (`getRemainingCredits`) updates cached credit balances without blocking quota queries.
  - On Windows, local CLI commands execute via PowerShell with `-WindowStyle Hidden` and `windowsHide: true`, eliminating focus stealing and flashing terminal windows.
- **Single-Post Webhook Invariant:**
  - Discord and generic webhooks render clean rich embeds without duplicating text content (`delete outgoingPayload.content`).
  - Intermediate runner progress heartbeats (`executing`, polling) are suppressed from webhooks, delivering discrete initial dispatch and final completion embeds with elapsed duration metrics.
- **Self-Contained Container Swarm Architecture:**
  - **Baked Container Binaries:** Coordinator and worker images bake their required toolchains (`agy`, Node 26, git, curl) directly inside the image layers. Never bind-mount host binaries (e.g. `/home/ott/.local/bin/agy`) into containers.
  - **Coordinator Isolation:** The coordinator operates as a control plane with baked telemetry binaries and requires only its persistent data volume (`agylity-data:/app/data`). It does not run task loops, git commands, or agent processes, and requires zero runner or host credential mounts.
  - **Worker as an Extra Container:** On container hosts (e.g. homelab Docker / Arcane), the worker is simply an extra container (`agylity-worker:main`) in the Compose stack. It communicates with the coordinator via `COORDINATOR_URL` and authenticates via `WORKER_SHARED_SECRET` in `.env`.
  - **Zero Host Credential Mounts:** Workers execute headless tasks against git repos via `cloneUrl` (with ephemeral container storage) or dedicated mounted repository volumes. Never bind-mount user host credentials (`~/.gemini` or host `~/.gitconfig`) into containers.
  - **Host Diagnostics:** Probing host processes and listening ports (e.g. sniffing local IDE Connect-RPC tokens/ports on developer workstations) is supported for host/desktop runners, but containers rely on explicit environment variables and internal network resolution.
  - **Lightweight Healthcheck:** Container healthchecks must strictly use native `curl -fsS http://127.0.0.1:8484/api/health`. Never spawn Node.js or Python runtime processes inside container healthchecks.
- **Responsive Dashboard Architecture:**
  - Layout is strictly mobile-first: 1-column on mobile, 2-column on tablet/laptop (`md:grid-cols-2`), scaling to 3-column on desktop (`xl:grid-cols-3`).
  - Sticky mobile header `< md` with collapsible navigation drawer; fixed/sticky sidebar on `md+`.
  - Quota cards enforce non-truncating headers, dynamic model name allocation, and `whitespace-nowrap` badge chip integrity.
- **Zero In-Place Container Mutation:**
  - Never hot-patch a running container via `docker cp` (e.g. copying `dist/` into `/app/dist`).
  - For local development and rapid iteration, iterate using the Vite dev server and host runtime directly. When validating container images, perform a clean container rebuild (`docker compose build` / `docker build`) rather than mutating running containers in-place.

---

## 2. Language Server IPC & Protobuf Specifications

Antigravity IDE runs a companion binary (`language_server.exe` on Windows, `language_server` on Linux) exposing a local Connect-RPC server on loopback `127.0.0.1`.

### Platform-Agnostic IPC & Discovery Architecture

Agylity is designed to be **cross-platform and container-native** (Linux, macOS, Windows, Docker).

#### 1. Container & Remote Sentry Deployment

When running in Docker or headless server environments, configure explicit connection parameters via environment variables:

- `ANTIGRAVITY_ENDPOINT_URL`: Explicit Connect-RPC base URL (e.g. `http://host.docker.internal:60643` or `http://192.168.1.100:60643`).
- `ANTIGRAVITY_CSRF_TOKEN`: Explicit session CSRF token (`x-codeium-csrf-token`).

#### 2. Best-Effort Local IDE Process Discovery (Host Workstations)

When running directly on a developer workstation alongside an active Antigravity IDE (where ephemeral ports and dynamic tokens are generated), Agylity sniffs the local runtime using native OS primitives:

- **Linux / POSIX:** Uses `pgrep -a language_server` combined with `ss -tlpn` or `lsof -iTCP -sTCP:LISTEN` to map PID to active listening loopback ports.
- **macOS (Darwin):** Uses `pgrep` and `lsof -nP -iTCP -sTCP:LISTEN | grep language_server` to discover local listener sockets.
- **Windows:** Uses PowerShell `Get-NetTCPConnection` and `Win32_Process` to extract dynamic ports and parse `--csrf_token` from process arguments.

### Connect-RPC Endpoints & Headers

Every request to the Language Server Connect-RPC endpoints must provide:

- Header: `x-codeium-csrf-token: <csrf_token>`
- Header: `Connect-Protocol-Version: 1`
- Header: `Content-Type: application/json`

- **Primary Quota Telemetry:**
  `POST /exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`
  - Body: `{}`
  - Returns: Grouped quota pools (Gemini Weekly & 5h, Claude & GPT Weekly & 5h, Gemini 4 Argon) with `remainingFraction` (0.0 to 1.0) and ISO `resetTime`.
- **Legacy Fallback Endpoint:**
  `POST /exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData`
  - Returns: `clientModelConfigs` containing model configuration list and availability.

### Non-Blocking Background AI Credits Probing & Window Hiding

In addition to percentage headroom, Antigravity accounts may carry pay-as-you-go or bundled AI credits probed via `agy --output-format json -p /credits`:

- **Stale-While-Revalidate Invariant:** Quota polling queries (`getQuotaSnapshots`) must never block waiting for the CLI process. `getRemainingCredits()` returns cached credits immediately and triggers background refresh (`triggerCreditsRefreshInBackground`) if stale (built-in 5m cache TTL).
- **Windows Terminal Suppression:** On Windows workstations, CLI queries spawn through hidden PowerShell (`-WindowStyle Hidden`, `windowsHide: true`) to completely eliminate disruptive console popup windows during user workflows.
- **Built-in Sentry Architecture:** Operates automatically as a core daemon capability without requiring configuration flags.

---

## 3. Terms of Service & Compliance Invariants

To remain 100% compliant with Google Cloud Platform Terms of Service, Google Generative AI Additional Terms, and Antigravity policies:

1. **Official Client Invariant:**
   - **Rule:** Never emulate, reverse-engineer, or scrape generation RPCs directly to simulate an agent loop.
   - **Implementation:** All task dispatches must shell out directly to the official, unmodified `agy` binary via child process (`execFile('agy', ['-p', prompt, ...])`).
2. **Single-Tenant Invariant:**
   - **Rule:** The Antigravity Pro license is an individual developer seat; never expose Agylity as a public service bureau or multi-tenant proxy.
   - **Implementation:** Restrict Discord bot dispatches to whitelisted owner IDs (`DISCORD_OWNER_USER_ID`) and keep Web UI local/authenticated.
3. **Network Egress & Account Safety:**
   - **Rule:** Keep `agy` execution within the same residential network (e.g. desktop or local homelab server on `192.168.0.0/24`) to share the same public IP. Avoid cloud datacenter IPs or commercial VPN exit nodes that trigger Google Account fraud/suspicious sign-in locks.
4. **Task-Driven Cadence:**
   - **Rule:** Automate discrete, queued software engineering objectives; never run continuous 24/7 infinite loops purely to drain quota to 0%.

---

## 4. Operational Use Cases

### Use Case 1: 24/7 Quota Sentry & Milestone Alerting

- Evaluates quota pools every 60 seconds by default (`QUOTA_CHECK_INTERVAL_SECONDS=60`, minimum clamp 30s).
- Milestones: Alerts at configurable intervals (default: 24h, 12h, 3h before reset) if quota headroom exceeds threshold (`>25%` remaining).
- Deduplication: State persisted in `data/state.json` via `SentryStateManager` across daemon restarts.
- Notification: Clean textual bracketed alerts (`[Alert]`, `[Notice]`, `[Success]`) and rich embeds showing reset countdowns (`"1d 21h"`, `"3h 15m"`).

### Use Case 2: AI Overcharge & Flex Credit Protection

- Protobuf schema `OverageInfo { bool enabled = 1; }` under `RetrieveUserQuotaSummaryResponse.overage_info`.
- **Hard Capped Accounts (`enabled: false`):** 0% quota results in harmless 429 throttling until reset.
- **Flex Overages Active (`enabled: true`):** 0% quota begins billing monetary charges for tokens.
- **Safety Floor Rule:** Agylity enforces `minDispatchHeadroomPercent` (default: 10%). Dispatches are automatically blocked/alerted when headroom drops below the floor to prevent billable overcharges unless explicitly overridden with `allowOverage`.

### Use Case 3: Autonomous Task Dispatching via Official CLI

- Worker checks out an isolated continuation branch:
  `git checkout -b antigravity/task-<id>-<slug>`
- Dispatches prompt via `agy`:
  ```bash
  agy -p "<prompt>" --mode auto --dangerously-skip-permissions --effort high
  ```
- Runs verification loop (`npm test` / `pytest`).
- Pushes isolated branch upstream and posts status back to Discord/Web UI.
- Never commits or pushes directly to `main`.

---

## 5. Swarm & Task Orchestrator Architecture

Agylity implements a pull-based worker swarm designed for zero inbound firewall ports:

```
Coordinator (Homelab / Cloud)
  ├── SQLite Task Queue (P0 Urgent, P1 Scheduled, P2 Quota-Burn)
  ├── Discord Bot (/dispatch modal & /quota commands)
  ├── Web Control Plane (/api/dispatch & /api/workers)
  └── Runner API (/api/tasks/poll, /api/workers/register)
        ▲
        │ (Outbound HTTPS Long-Poll via ky)
        ├── Container Runner (agylity-worker:latest) -> Unattended tasks
        └── Host / Desktop Runner (dist/worker-cli.js) -> Supervised desktop tasks
```

### 1. Runner Token Lifecycle

- **Registration Token (`agyr_reg_...`)**: Short-lived (1-hour expiration) token generated via Web UI or API.
- **Exchange**: On first boot, worker POSTs to `/api/workers/register` exchanging the registration token for a permanent runner credential (`agyr_run_...`).
- **Persistence**: Runner credential persisted to `runner.json` (or `/data/runner.json` in containers via volume mount).

### 2. Isolated Git Checkout & Subprocess Credential Hygiene

- **Zero Token in URL**: Tokens are never embedded in git clone URLs.
- **Extraheader Injection**: Authenticated clones pass authorization headers via git configuration:
  ```bash
  git -c http.https://github.com/.extraheader="AUTHORIZATION: basic <base64>" clone -- <url> <path>
  ```
- **Redaction**: Captured stderr/stdout runs through regex redaction (`basic\s+[A-Za-z0-9+/=]+` and token values) before logging or returning to clients.

### 3. Verification Sandbox (`verifyCommand`)

- **Metacharacter Rejection**: Verifications reject shell operators: `/[;&|`$><\r\n]/`.
- **Executable Allowlist**: Only sanctioned test invocations may execute:
  `['npm', 'pnpm', 'yarn', 'pytest', 'cargo', 'go']`. `node` and `npx` are deliberately excluded -
  with either of them the "allowlist" is arbitrary code execution under the runner's identity.
- **Inline-Code Rejection**: `-e`, `--eval` and `-c` are rejected for the remaining interpreters.

### 4. Opportunistic Quota Burning (P2)

- Low-priority background tasks only dispatch when remaining time to reset is short (`< 2h`) and headroom is healthy (`> 30%`), utilizing free allowance before it expires.

---

## 6. Model Pools & Dual-Window Quota Math

Antigravity models do not consume a single monolithic quota counter; they are partitioned into distinct groups with **dual sliding windows**:

| Group Display Name        | Member Models                       | Tracked Buckets              | Reset Window Behaviors                                                      |
| :------------------------ | :---------------------------------- | :--------------------------- | :-------------------------------------------------------------------------- |
| **Gemini Models**         | Gemini Flash, Gemini Pro            | `gemini-weekly`, `gemini-5h` | 5h limit smooths aggregate demand; weekly limit reflects subscription tier. |
| **Claude and GPT models** | Claude Opus, Claude Sonnet, GPT-OSS | `3p-weekly`, `3p-5h`         | Separate 3P bucket with independent 5h and weekly limits.                   |
| **Gemini 4 Argon**        | Gemini 4 Argon                      | `gemini-argon-wtu-weekly`    | Dedicated weekly Work-Through-Unit (WTU) budget on Pro plans.               |

- **Effective Headroom Calculation:** When evaluating whether a task can dispatch safely, Agylity takes the most constrained window:
  $$\text{effectiveHeadroom} = \min(\text{weeklyRemaining}, \text{fiveHourRemaining})$$
- **Human-Friendly Calendar Reset Strings:** Matches native IDE formatting (`"4d 16h"`, `"1d 3h"`, `"3h 18m"`).

---

## 7. Storage Engine & Fallback Precedence

Agylity uses zero external database dependencies, relying exclusively on Node 26 native `node:sqlite`:

- **Database Path:** `data/agylity.db` (enforces `PRAGMA journal_mode = WAL;` and `PRAGMA busy_timeout = 5000;`).
- **Configuration Hierarchy:**
  $$\text{Resolved Value} = \text{SQLite UI Overrides} \succ \text{Environment Variables (.env)} \succ \text{Built-in Defaults}$$
- **Key Tables & State:**
  - `settings`: `(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)` - stores persistent UI configuration overrides.
  - `swarm_tasks`: `(id TEXT PRIMARY KEY, repository_id, repository_name, repository_path, clone_url, default_branch, prompt, requested_by, schedule_mode, required_labels_json, model, pool_family, effort, allow_overage, push_branch, auto_create_pr, pr_url, expires_at, standing_task_id, verify_command, status, worker_id, claimed_at, heartbeat_at, completed_at, branch_name, output, error, duration_ms, num_turns, total_tokens, thinking_tokens)` - the swarm task queue and execution lifecycle. There is no `title` column.
  - `swarm_workers`: `(worker_id TEXT PRIMARY KEY, name, token_hash, labels_json, repositories_json, system_info_json, enabled, active_task_id, status, registered_at, last_seen_at)` - registered runner nodes and heartbeat telemetry. Labels and repositories are JSON columns, not `labels`/`worker_mode`.
  - `swarm_runner_registrations`: one row per one-time registration token; consumed and expired rows are pruned by `pruneRegistrationTokens()`.
  - `standing_tasks`: recurring task definitions triggered by the pre-reset window.
  - Legacy leftovers from an older schema (`dispatches`, and the `dispatch_id`, `priority`, `priority_rank`, `worker_mode` columns) are no longer written and are intentionally not dropped.
  - **Schema migration must be checked, not assumed:** `initSchema()`/`runMigrations()` are `CREATE TABLE IF NOT EXISTS` plus a `PRAGMA table_info` diff that `ALTER TABLE ADD COLUMN`s anything missing. The CREATE alone never upgrades a database written by an earlier schema, and the failure surfaces only when a user tries to dispatch (`table swarm_tasks has no column named schedule_mode`) while `/api/health` stays green. Diff `PRAGMA table_info` against the source definitions before trusting an existing `data/agylity.db`.
  - **Fail-Closed Startup:** the web server refuses to start when no `WEB_UI_AUTH_TOKEN` is configured and the bind host is not loopback (`127.0.0.1`/`::1`/`localhost`); a loopback bind without a token starts with a warning. Never re-introduce a silent skip of the auth block - that turned the shipped compose file, which binds `0.0.0.0:8484`, into an unauthenticated control plane.
  - **Strict CIDR prefixes:** an empty prefix such as `1.2.3.4/` must be rejected, never parsed as `/0`, which would silently allow every client.
  - Sentry Alert State: `data/state.json` tracks deduplicated milestone firings per pool across restarts.
  - Log Buffer: In-memory ring buffer (`LogBuffer`) for recent operations, broadcast to subscribers via SSE.

### Control Plane Authentication & Edge Security

- **Zero-Leak Control Plane Gate:** When `WEB_UI_AUTH_TOKEN` is configured, all API endpoints (excluding `/api/health` and the runner-token endpoints) require `Authorization: Bearer <token>`. Unauthenticated clients receive a solid `<ControlPlaneGate />` that completely unmounts and replaces the DOM, ensuring zero settings, logs, or metrics leak in the browser before authentication.
- **Application IP Allowlisting & Anti-Spoofing:** When `ALLOWED_IP_RANGES` is configured, requests from unlisted IPs or CIDR blocks receive HTTP 403 Forbidden. When behind reverse proxies (Caddy, Cloudflare, Traefik), `TRUSTED_PROXIES` (a boolean, not a list) honours proxy headers only when the direct TCP peer is loopback, and walks `x-forwarded-for` right-to-left skipping trusted hops, so a client-supplied prefix cannot name its own address. Private ranges are deliberately NOT trusted - any host on a LAN or Docker bridge could otherwise forge the headers. There is no `/api/auth/verify` route.

---

## 8. Notifier Architecture & Discord Runtime Invariants

- **Dynamic Import Isolation Invariant:**
  To guarantee a minimal runtime memory footprint, inactive notification channels must never initialize listeners or load modules into memory. The notifier factory uses dynamic `await import()` so `discord.js` is strictly isolated and never loaded when `NOTIFICATION_CHANNEL=console` or `webhook`.
- **Discord 3-Second Timeout Guard:**
  Discord API requires interactions (slash commands like `/quota`, modal submissions) to receive an initial acknowledgment within **3000ms**, or it throws fatal error `10062: Unknown interaction`.
  - **Invariant:** Modal submissions and slash commands must immediately invoke `await interaction.deferReply()` prior to any network I/O, quota polling, or task spawning.
- **Clean Alert Formatting (Anti-AI Invariant):**
  - Notification embeds and dispatch alerts must use clean, professional bracketed tags (`[Alert]`, `[Notice]`, `[Blocked]`, `[Success]`, `[Error]`) with zero decorative emojis.
  - Sentry polling intervals enforce a minimum 30s clamp (default: 60s) with cached cooldown to prevent Connect-RPC log flood.
- **Multi-Channel Configuration UI:**
  - Web UI notification settings must provide independent on/off toggles per destination channel, expanding relevant credentials and settings directly in-place.

---

## 9. Verification Commands & Test Invariants

- **Full Compilation:** `npm run build` (builds Preact client via Vite into `dist/web/public` and compiles TypeScript daemon via `tsc`).
- **Test Suite Execution:** `npm test` runs Node 26 native test runner (`node --no-warnings --import tsx --test tests/**/*.test.ts`).
- **Test Suite Handle Hygiene & Isolation:**
  - Any test binding an HTTP server, child process, daemon, or database MUST guarantee teardown inside `try ... finally` or `t.after()`.
  - Tests must NEVER write into repository `./data/` directories; strictly allocate temporary directories with `os.tmpdir()` and clean up on teardown.
  - Zero real wall-clock multi-second sleeps in unit tests (total test runtime must finish in < 5s).
