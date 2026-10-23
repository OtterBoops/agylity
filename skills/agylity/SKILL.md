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
- **Runtime:** Pure TypeScript targeting Node 24 (`node:24-slim`).
- **Zero-CVE Minimal Dependency Surface:**
  - Runtime dependencies: `discord.js@^14.27.0`, `ky@^2.2.0`, `zod@^3.24.0`.
  - Storage: Native `node:sqlite` (`data/agylity.db`) in WAL mode.
  - Process Execution: Native `node:child_process.execFile` with array arguments.
- **Frontend Stack:** Vite + Preact + Tailwind CSS (`frontend/`) serving a strictly decoupled dashboard. If `WEB_UI_ENABLED=false`, zero HTTP server or listener is bound.

---

## 2. Language Server IPC & Protobuf Specifications

Antigravity IDE runs a companion binary (`language_server.exe` on Windows, `language_server` on Linux) exposing a local Connect-RPC server on loopback `127.0.0.1`.

### Platform-Agnostic IPC & Discovery Architecture

Agylity is designed to be **cross-platform and container-native** (Linux, macOS, Windows, Docker).

#### 1. Container & Production Deployment (Platform-Agnostic Default)

In containerized environments (Docker, Kubernetes, homelab host, cloud VPS) or headless servers, Agylity eliminates host dependency by running `language_server` as an internal companion daemon:

```bash
language_server -standalone -headless -http_server_port=60643 -gemini_dir=/home/node/.gemini
```

- **Port:** Fixed internal loopback port (`http://127.0.0.1:60643`).
- **Auth:** Standard read-only volume mount for OAuth credentials (`~/.gemini` or `~/.config/antigravity`).
- **Isolation:** 100% self-contained in the container network namespace across any host OS.

#### 2. Environment Configuration Precedence (12-Factor Standard)

Explicit environment variables take precedence over dynamic discovery on all operating systems:

- `ANTIGRAVITY_ENDPOINT_URL`: Explicit Connect-RPC base URL (e.g. `http://127.0.0.1:60643`).
- `ANTIGRAVITY_LS_PORT`: Explicit port override.
- `ANTIGRAVITY_CSRF_TOKEN`: Explicit session CSRF token.

#### 3. Best-Effort Local IDE Process Discovery (Host Workstations)

When running directly on a developer workstation alongside an active Antigravity IDE (where `--https_server_port 0` dynamically assigns ephemeral ports), Agylity sniffs the local runtime using native OS primitives:

- **Linux / POSIX:**
  Uses `pgrep -a language_server` combined with `ss -tlpn` or `lsof -iTCP -sTCP:LISTEN` to map PID to active listening loopback ports.
- **macOS (Darwin):**
  Uses `pgrep` and `lsof -nP -iTCP -sTCP:LISTEN | grep language_server` to discover local listener sockets.
- **Windows:**
  Uses PowerShell `Get-NetTCPConnection` and `Win32_Process` to extract dynamic ports and parse `--csrf_token` from process arguments.

### Connect-RPC Endpoints

- **Primary Quota Telemetry:**
  `POST /exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`
  - Header: `x-codeium-csrf-token: <csrf_token>`
  - Body: `{}`
  - Returns: Grouped quota pools (Gemini Weekly & 5h, Claude & GPT Weekly & 5h, Gemini 4 Argon) with `remainingFraction` (0.0 to 1.0) and ISO `resetTime`.
- **User Plan & Flex Credit Telemetry:**
  `POST /exa.language_server_pb.LanguageServerService/GetUserStatus`
  - Body: `{}`
  - Returns: `planStatus.planInfo` (`teamsTier`, `monthlyFlexCreditPurchaseAmount`, `canBuyMoreCredits`, `availablePromptCredits`, `availableFlowCredits`).
- **Legacy Fallback Endpoint:**
  `POST /exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData`

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
   - **Rule:** Keep `agy` execution within the same residential network (e.g. desktop or local homelab node on `192.168.0.0/24`) to share the same public IP. Avoid cloud datacenter IPs or commercial VPN exit nodes that trigger Google Account fraud/suspicious sign-in locks.
4. **Task-Driven Cadence:**
   - **Rule:** Automate discrete, queued software engineering objectives; never run continuous 24/7 infinite loops purely to drain quota to 0%.

---

## 4. Operational Use Cases

### Use Case 1: 24/7 Quota Sentry & Milestone Alerting

- Evaluates quota pools every 15 minutes.
- Milestones: Alerts at configurable intervals (default: 24h, 12h, 3h before reset) if quota headroom exceeds threshold (`>25%` remaining).
- Deduplication: State persisted in SQLite (`sentry_alerts` table) across daemon restarts.
- Notification: Rich Discord embeds showing reset countdowns (`"1d 21h"`, `"3h 15m"`) matching native IDE formatting.

### Use Case 2: AI Overcharge & Flex Credit Protection

- Protobuf schema `OverageInfo { bool enabled = 1; }` under `RetrieveUserQuotaSummaryResponse.overage_info`.
- **Hard Capped Accounts (`enabled: false`):** 0% quota results in harmless 429 throttling until reset.
- **Flex Overages Active (`enabled: true`):** 0% quota begins billing monetary charges for tokens.
- **Safety Floor Rule:** Agylity enforces `minDispatchHeadroomPercent` (default: 10%). Dispatches are automatically blocked/alerted when headroom drops below the floor to prevent billable overcharges.

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

## 5. Swarm & Task Poller Architecture (Roadmap)

Legacy direct SSH push and Wake-on-LAN have been scrapped in favor of a **Pull-Based Worker Swarm**:

```
Coordinator (Homelab / Cloud)
  ├── SQLite Task Queue (P0 Urgent, P1 Scheduled, P2 Quota-Burn)
  ├── Discord Bot (/dispatch modal)
  └── REST API (/api/tasks/poll)
        ▲
        │ (Outbound HTTPS Long-Poll)
        ├── Headless Worker (Docker container) -> Unattended tasks
        └── Visible Worker (Home Desktop PC)   -> Supervised tasks in active terminal
```

- **Outbound Polling:** Workers poll outbound; zero inbound firewall ports needed.
- **Worker Routing:** Tasks can target `worker_mode: 'headless'` or `worker_mode: 'visible'`.
- **Opportunistic Quota Burning (P2):** Low-priority background tasks only dispatch when remaining time to reset is short (`< 2h`) and headroom is healthy (`> 30%`), utilizing free allowance before it expires.

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

Agylity uses zero external database dependencies, relying exclusively on Node 24 native `node:sqlite`:

- **Database Path:** `data/agylity.db` (enforces `PRAGMA journal_mode = WAL;`).
- **Configuration Hierarchy:**
  $$\text{Resolved Value} = \text{SQLite UI Overrides} \succ \text{Environment Variables (.env)} \succ \text{Built-in Defaults}$$
- **Key Tables:**
  - `config_overrides`: `(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`
  - `sentry_alerts`: `(id TEXT PRIMARY KEY, pool_family TEXT, milestone_hours REAL, triggered_at TEXT)`
  - `log_entries`: In-memory and persistent ring buffer for recent operations and dispatch traces.

---

## 8. Notifier Architecture & Discord Runtime Invariants

- **Dynamic Import Isolation Invariant:**
  To guarantee a minimal runtime memory footprint, inactive notification channels must never initialize listeners or load modules into memory. The notifier factory uses dynamic `await import()` so `discord.js` is strictly isolated and never loaded when `NOTIFICATION_CHANNEL=console` or `webhook`.
- **Discord 3-Second Timeout Guard:**
  Discord API requires interactions (slash commands like `/quota`, modal submissions) to receive an initial acknowledgment within **3000ms**, or it throws fatal error `10062: Unknown interaction`.
  - **Invariant:** Modal submissions and slash commands must immediately invoke `await interaction.deferReply()` prior to any network I/O, quota polling, or task spawning.

---

## 9. Verification Commands & Test Invariants

- **Full Compilation:** `npm run build` (builds Preact client via Vite into `dist/web/public` and compiles TypeScript daemon via `tsc`).
- **Test Suite Execution:** `npm test` runs Node 24 native test runner (`node --no-warnings --import tsx --test tests/**/*.test.ts`).
- **Test Runner Handle Hygiene:** Any test binding an HTTP server, child process, or socket must guarantee unbinding inside `try ... finally` or `t.after()` to prevent unclosed handles from silently hanging the test runner.
