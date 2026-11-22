---
name: agylity
description: >-
  Authoritative architecture, language server RPC protocols, ToS compliance guardrails,
  and operational use cases for Agylity (autonomous Antigravity quota sentry & swarm task coordinator).
  Trigger whenever developing, debugging, extending, or automating Antigravity, quota monitoring, or agy tasks.
---

# Agylity Operational & Architecture Playbook

## 1. System Topology & Strict Dependency Posture

- **Repository Root:** every path in this playbook is relative to the repository root (`src/`, `frontend/`, `tests/`, `data/`). No machine-specific absolute path is required to use the repo.
- **Runtime:** Pure TypeScript targeting Node 26 (`node:26-slim`).
- **Zero-CVE Minimal Dependency Surface:**
  - Runtime dependencies: `discord.js@^14.27.0`, `ky@^2.2.0`, `zod@^4.6.7`.
  - Storage: Native `node:sqlite` (`data/agylity.db`) in WAL mode with `PRAGMA busy_timeout = 5000;`.
  - Process Execution: Native `node:child_process.execFile` with array arguments.
- **Zod v4 API Invariant:**
  - Validation error collections in Zod v4 must strictly be accessed via `result.error.issues` (`result.error.errors` does not exist in Zod v4).
- **Nullable SQLite Identifier Coercion Invariant:**
  - In SQLite schema update patches and mappers, optional external numeric identifiers (such as `github_issue_number`) must strictly distinguish `undefined` (retain existing), `null` (explicitly unlinked), and positive integers (`> 0`).
  - Never use naive default coercion `coerceNumber(val, existing ?? 0)` on nullable foreign keys or external IDs, as storing `0` creates false-positive issue references (`#0`) in UI badges and search queries.
- **Frontend Stack:** Vite + Preact + Tailwind CSS (`frontend/`) serving a strictly decoupled dashboard. If `WEB_UI_ENABLED=false`, zero HTTP server or listener is bound.
- **Single-Source Model Catalog Invariant:**
  - `src/shared/models.ts` is the only place the agy model catalog, effort list (`ALL_EFFORTS`) and dispatch default exist. It must stay import-free and erasable-syntax-only, because the frontend bundles it directly.
  - `src/coordinator/models.ts` re-exports it for backend callers and keeps the zod schemas; `frontend/src/config/fields.ts` derives `MODEL_OPTIONS` and the pre-load effort fallback from it. Never re-type a model or effort table in the UI.
  - The file sits outside the Vite root, so `frontend/vite.config.ts` must keep `server.fs.allow` pointing at the repo root or the dev server 403s the module.
  - Effort belongs to the model, not the task: `modelSupportsEffort(modelId, supportedEfforts?)` is the only check, and a model whose catalog entry has `supportedEfforts: []` (an `orchestrator` route such as `gemini-pro-orchestrator-g1-pro`) is invoked WITHOUT `--effort`. `agy` rejects the flag on such a model, so never default it back to a full effort list.
- **Native Modal Invariant:**
  - All modals in the Preact UI strictly use the native HTML `<dialog>` element triggered via `dialogRef.current.showModal()`, eliminating custom fixed-position `role="dialog"` div overlays.
- **Web UI & Control-Plane Security & Lock Invariant:**
  - `WEB_UI_AUTH_TOKEN`: When configured, control-plane endpoints enforce constant-time Bearer token verification (`crypto.timingSafeEqual`) and anti-brute-force sliding-window rate limiting (HTTP 429 after 10 failed attempts within 60s). Runner endpoints (`/api/tasks/poll`, `/api/tasks/:id/status`, `/api/runner/heartbeat`, `/api/runners/register`) use dedicated runner authentication tokens.
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
  - **Baked Container Binaries:** Coordinator and runner images bake their required toolchains (`agy`, Node 26, git, curl) directly inside the image layers. Never bind-mount host binaries (e.g. the host's `agy` binary) into containers.
  - **Coordinator Isolation:** The coordinator operates as a control plane with baked telemetry binaries and its own persistent volumes (`agylity-data:/app/data`). It does not run task loops, git commands, or agent processes, and binds no host credential paths.
  - **The coordinator is credentialed and probes on its own.** `docker-compose.yaml` mounts the shared `agylity-gemini:/home/node/.gemini` volume into _both_ services, so the baked `agy` is authenticated in the coordinator too. A container has no `language_server` to discover, so Connect-RPC fails and `fallbackToCli()` (`agy --output-format json -p /usage`) supplies the quota groups, reporting probe source `cli` or `cli_fallback`. Never assume the containerised sentry is blind: check the compose volumes and `src/sentry/client.ts` fallback before designing anything around unavailable telemetry.
  - **Runner as an Extra Container:** On container hosts (e.g. homelab Docker / Arcane), the runner is simply an extra container (`agylity-runner:main`) in the Compose stack. It communicates with the coordinator via `COORDINATOR_URL` and authenticates via `RUNNER_SHARED_SECRET` in `.env`.
  - **Zero Host Credential Mounts:** Runners execute headless tasks against git repos via `cloneUrl` (with ephemeral container storage) or dedicated mounted repository volumes. Never _bind_ host credential paths (`~/.gemini`, host `~/.gitconfig`) into containers; a Docker-managed volume (the shared `agylity-gemini` session) is the sanctioned way to give `agy` an authenticated session.
  - **Host Diagnostics:** Probing host processes and listening ports (e.g. sniffing local IDE Connect-RPC tokens/ports on developer workstations) is supported for host/desktop runners, but containers rely on explicit environment variables and internal network resolution.
  - **Lightweight Healthcheck:** Container healthchecks must strictly use native `curl -fsS http://127.0.0.1:8484/api/health`. Never spawn Node.js or Python runtime processes inside container healthchecks.
- **Responsive Dashboard Architecture:**
  - Layout is strictly mobile-first: 1 column, 2 at `md`, 3 at `xl` — a fixed `QUOTA_GRID_COLUMNS`, because the quota grid renders **one cell per pool group** (`POOL_GROUPS`), not one per live pool. The column count therefore no longer varies by account; the earlier count-per-pool approach left a hollow third cell on a two-pool tier.
  - **Absent groups are shown, muted.** A group the probe reports no pool for renders a card with a `Not on plan` chip, its catalogued model labels and no bars or percentages. This is a sentry: telling the owner which pool they do not have is the product, not an upsell. It only renders alongside at least one live pool — a failed probe returns nothing, and claiming every group is missing would be a lie.
  - **The 1px cell divider is a `ring-1 ring-pine-highlight/70` on each cell**, never a tint behind `gap-px`: a container fill also paints every cell a partial last row does not fill. Cells are ringed but only real pools carry a surface.
  - A row the cells do not fill is completed with `No pool` filler cells (`quotaGridPlaceholders`), so a future fourth group wraps without framing bare space. The filler count differs per breakpoint, so each carries its own `hidden md:flex` / `hidden xl:flex` range.
  - Sticky mobile header `< md` with collapsible navigation drawer; fixed/sticky sidebar on `md+`.
  - Quota cards enforce non-truncating headers, dynamic model name allocation, and `whitespace-nowrap` badge chip integrity.
  - Card titles name the bucket by codename alone — `Hydrogen pool`, `Argon pool`, `Claude pool` — via `POOL_GROUP_SHORT_LABELS`; `POOL_GROUP_LABELS` ("Claude and GPT models") is the prose form used by notices. A group holding several pools falls back to the bucket's own display name so the cards stay distinguishable.
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
- Milestones: Alerts at configurable intervals (`QUOTA_MILESTONE_HOURS`, default `48,24,12` — 48h, 24h and 12h before reset) if quota headroom exceeds the configured threshold (`>25%` remaining).
- Deduplication: State persisted in `data/state.json` via `SentryStateManager` across daemon restarts.
- Notification: Clean textual bracketed alerts (`[Alert]`, `[Notice]`, `[Success]`) and rich embeds showing reset countdowns (`"1d 21h"`, `"3h 15m"`).

### Use Case 2: AI Overcharge & Flex Credit Protection

- Protobuf schema `OverageInfo { bool enabled = 1; }` under `RetrieveUserQuotaSummaryResponse.overage_info`.
- **Hard Capped Accounts (`enabled: false`):** 0% quota results in harmless 429 throttling until reset.
- **Flex Overages Active (`enabled: true`):** 0% quota begins billing monetary charges for tokens.
- **Safety Floor Rule:** Agylity enforces `minDispatchHeadroomPercent` (default: 10%). Dispatches are automatically blocked/alerted when headroom drops below the floor to prevent billable overcharges unless explicitly overridden with `allowOverage`.

### Use Case 3: Autonomous Task Dispatching via Official CLI

- Runner checks out an isolated continuation branch (never `main`/`master`):
  `git checkout -B agy/<shortId>-<slug>`
- Dispatches the prompt via `agy`:
  ```bash
  agy -p "<prompt>" --mode auto --dangerously-skip-permissions \
    --settings '{"enableTerminalSandbox":false}' --model <model-id> [--effort <effort>]
  ```
  `--effort` is present only when `modelSupportsEffort(<model-id>)` is true; the instruction footer and the PR body drop their "reasoning" clause on the same condition.
- Runs `verifyCommand` when the task sets one — a bare invocation of an allowlisted runner (`npm`, `pnpm`, `yarn`, `pytest`, `cargo`, `go`); see §5.
- Commits, pushes the isolated branch upstream and posts status back to Discord/Web UI.
- Never commits or pushes directly to `main`.

---

## 5. Swarm & Task Coordinator Architecture

Agylity implements a pull-based runner swarm designed for zero inbound firewall ports:

```
Coordinator (Homelab / Cloud)
  ├── SQLite Task Queue (tier: immediate | backlog | routine, scheduleMode: immediate | pre_reset)
  ├── Discord Bot (/dispatch modal & /quota commands)
  ├── Web Control Plane (/api/dispatch & /api/runners)
  └── Runner API (/api/tasks/poll, /api/runners/register)
        ▲
        │ (Outbound HTTPS Long-Poll via ky)
        ├── Container Runner (agylity-runner:latest) -> Unattended tasks
        └── Host / Desktop Runner (dist/runner-cli.js) -> Supervised desktop tasks
```

### 1. Runner Token Lifecycle

- **Registration Token (`agyr_reg_...`)**: Short-lived (1-hour expiration) token generated via Web UI or API.
- **Exchange**: On first boot, runner POSTs to `/api/runners/register` exchanging the registration token for a permanent runner credential (`agyr_run_...`).
- **Persistence**: Runner credential persisted to `runner.json` (or `/data/runner.json` in containers via volume mount).

### 2. Isolated Git Checkout, Branch Hygiene & Subprocess Credential Handling

- **Branch Isolation:** the executor refuses to run when the branch is `main`/`master`, and `buildContinuationBranchName()` never returns either one. Branches are cut as `git checkout -B agy/<shortId>-<slug>` — an 8-char id fragment plus a prompt slug capped at 32 chars (`agy/<shortId>-work` when the prompt yields no usable words).
- **A Working Copy Is Never Destroyed:** `prepareBranch()` inspects `git status --porcelain`; when the tree is dirty it runs `git stash push --include-untracked -m "agylity <taskId>"` and logs the stash ref. The stash is **never popped automatically** — a run against a real working copy can therefore leave a stash behind, and recovering it is the operator's job.
- **Base Sync Is Best-Effort:** `git checkout <baseBranch>` then `git pull --ff-only` are attempted before the branch is cut; a failed pull (unreachable remote) logs a secret-redacted warning and continues on the local base branch, because it must not cancel a run that could otherwise succeed. The `-B` checkout happens regardless of both steps, so an uncommitted-state error never blocks the task branch.
- **Zero Token in URL:** tokens are never embedded in git clone URLs.
- **Extraheader Injection:** authenticated clones pass authorization headers via git configuration:
  ```bash
  git -c http.https://github.com/.extraheader="AUTHORIZATION: basic ***" clone -- <url> <path>
  ```
  `buildGitAuthArgs()` only attaches that header when the clone URL is unset or starts with `https://github.com/`. The header is host-bound; sending it to any other host would hand that host the token, so non-GitHub remotes get no header at all.
- **Redaction:** `redactGitSecrets()` (`src/runner/git.ts`) is the single implementation — it splits out both the raw `GITHUB_TOKEN` value and its base64 basic-auth form, replacing each with `[redacted]`. Every git stderr/stdout path (clone, push, refusals) goes through it before logging or returning to a client.
- **Fail at Boot, Not at Push:** `assertRunnerGitCredentials()` throws on `start()` when `GITHUB_TOKEN` is unset (naming the runner's repository scope) unless `ALLOW_TOKENLESS_RUNNER=true`, because a tokenless runner only discovers the problem at push — after the agent run has already spent quota. `env_file` alone does not put a variable into the container environment; the token must also be listed under `environment:` in the compose file.

### 3. Runner Runtime Loop & Lease Semantics

The runner is a pure outbound pull loop; every failure mode below is deliberately asymmetric so a coordinator problem never kills real work.

- **Poll loop:** `POST /api/tasks/poll`; an empty claim sleeps the idle interval (default 2s), and a poll-cycle error logs and sleeps `max(idle, 3s)` before retrying.
- **Auth gate before each claim:** `checkAuthPreClaim()` runs `agy --output-format json models`. Success caches "authed" for 5 minutes; a CLI auth failure blocks claiming for 30s and warns once until the operator signs in.
- **Heartbeat:** while a task executes, `POST /api/runner/heartbeat` fires every 10s (`HEARTBEAT_INTERVAL_MS`) with the streamed output tail; an in-flight beat is never stacked. A **409 means the lease is gone** and aborts the task. Every other heartbeat outcome (non-2xx, transport error) is logged and treated as fine — a coordinator hiccup is not a cancelled task.
- **Credential rejection:** a 401/403 from the coordinator pauses polling for 60s (`CREDENTIAL_REJECT_BACKOFF_MS`) and warns once, instead of hot-looping a dead credential.
- **Status reporting:** `fitStatusPayload()` pre-clips `output`/`error` to 56 KB (`STATUS_BODY_MAX_BYTES`) so the body stays under the coordinator's 64 KB `MAX_BODY_BYTES` ceiling. The final status report is retried twice (`STATUS_REPORT_ATTEMPTS`) on transport failures and 5xx only; a 4xx is never retried, and a 409 means the task is already terminal. A lost report is treated as the coordinator's lease problem, not a reason to panic.
- **Coordinator side:** a `claimed`/`executing` task whose `heartbeat_at` is older than the 10-minute lease is failed by `reapStaleClaims()` ("Runner lease expired"). Busy runners are marked `offline` at the same 10 minutes, idle runners after 2 minutes, and `pruneOldRunners()` deletes offline, token-less runners after 10 minutes.

### 4. Capacity Failover & Model Cascade

- **Only capacity exhaustion fails over.** `isCapacityExhaustedOutput()` matches a bare `429` and the strings `model capacity exhausted`, `resource exhausted`, `capacity exhausted`, `too many requests`, `overloaded`. Any other error — or an aborted signal — ends the run on the attempt that produced it, because a second model would burn quota on the same broken task.
- **Next hop selection:** the next untried model comes from the task's cascade (`pickNextCandidateHop`). No untried hop left ends the run with the original failure.
- **Continuation prompt:** a dirty working tree hands the next hop a `buildCapacityContinuationPrompt()` brief — git status, diffstat and the last 2000 chars of the interrupted output, plus the original task — so it finishes the remaining work instead of redoing it. A clean tree simply retries the original prompt. Policy and attribution suffixes survive both paths.
- **Telemetry:** each attempt is parsed (`parseAgyTelemetry`) and the attempts are summed (`sumAgyTelemetry`) into the single final status report.
- **Invocation:** `agy -p <prompt> --mode auto --dangerously-skip-permissions --settings '{"enableTerminalSandbox":false}' --model <model-id> [--effort <effort>]`. The settings flag is mandatory in practice: unprivileged containers reject agy's nested Linux namespace sandbox with EPERM on fork/exec. `--effort` is omitted for a model with no effort variants.

### 5. Verification Sandbox (`verifyCommand`)

- **Metacharacter Rejection**: Verifications reject shell operators: ``/[;&|`$><\r\n]/``.
- **Executable Allowlist**: Only sanctioned test invocations may execute:
  `['npm', 'pnpm', 'yarn', 'pytest', 'cargo', 'go']`. `node` and `npx` are deliberately excluded -
  with either of them the "allowlist" is arbitrary code execution under the runner's identity.
- **Inline-Code Rejection**: `-e`, `--eval` and `-c` are rejected for the remaining interpreters.

### 6. PR Policy Gate (`PR_POLICY`)

`PR_POLICY` accepts `docs_only | issues_only | all | none` and defaults to `all`. A task-level `pr_policy` column defaults to `inherit` and overrides the env when set to anything else.

- **Autonomous tiers only.** `applyPrPolicy()` returns immediately for `tier === 'immediate'` — an immediate dispatch is a human asking for exactly that work and is never policed. `backlog` and `routine` runs are.
- **`none` / `issues_only`:** the branch is discarded (`discardBranch()` returns the copy to the base branch) and the task reports `success` with `no_changes` and a `[Policy Guard]` note in the output. `issues_only` additionally injects a prompt suffix forbidding file edits, branch pushes and PRs.
- **`docs_only`:** `git diff --name-only <base>..HEAD` is checked against `isDocumentationFile()`; the branch is discarded when **any** changed file is not documentation. Doc = `.md/.markdown/.mdown/.mkdn/.txt/.rst/.adoc` plus README/LICENSE/NOTICE/CHANGELOG/CODE_OF_CONDUCT-class basenames.

### 7. Task Tiers: Immediate, Backlog, Routine

Three tiers, and only the first is human-initiated per run:

- **`immediate`** — a direct dispatch from the Web UI, Discord or `POST /api/dispatch`. Sets the autonomy quench timestamp when `actor !== 'bot'`.
- **`backlog`** (`backlog_tasks`) — queued work items, created by hand or by the GitHub label sync. The evaluator dispatches at most one per quota probe, gated on headroom of at least `max(40, MIN_DISPATCH_HEADROOM_PERCENT)`.
- **`routine`** (`routine_tasks`, successor to the removed `standing_tasks` table) — recurring templates released inside `trigger_before_reset_hours`, looping sequentially within one pool reset cycle: a routine re-triggers as soon as its previous run reaches `completed`, gated on `max(min_headroom_percent, MIN_DISPATCH_HEADROOM_PERCENT)`. At most one run is in flight per routine (`origin_id`), and a `failed`/`aborted` run ends the cycle.

- **The autonomy quench is 2 hours** after a manual immediate dispatch, persisted in `runtime_state` so a restart cannot re-arm it.
- **Both autonomous tiers carry an ordered `models[]`** and dispatch the first candidate whose pool clears the floor (`evaluateModelPreferenceChain`); the manual dispatch routes pass the same chain to `coordinator.dispatch`. A model id mapping to no pool is refused, never charged to another group.
- **Origin settlement has two call sites** — the runner status report and `reconcileBacklogOrigins` — both strictly funneled through `applyBacklogOutcome`. Backlog rows never mutate terminal states (`completed`, `failed`, `canceled`) on late runner callbacks or redundant sweeps. A backlog row left on `dispatched` is picked by nothing.
- **Every refusal is a 4xx.** A safety-floor or telemetry block on a dispatch is HTTP 400; a cancel of an already-terminal task is 409.

---

## 6. Model Pools & Dual-Window Quota Math

Antigravity models do not consume a single monolithic quota counter; they are partitioned into distinct groups with **dual sliding windows**:

| Group Display Name        | Member Models                        | Tracked Buckets              | Reset Window Behaviors                                                      |
| :------------------------ | :----------------------------------- | :--------------------------- | :-------------------------------------------------------------------------- |
| **Gemini Models**         | Gemini Flash, Hydrogen, Neon, Carbon | `gemini-weekly`, `gemini-5h` | 5h limit smooths aggregate demand; weekly limit reflects subscription tier. |
| **Claude and GPT models** | Claude Opus, Claude Sonnet, GPT-OSS  | `3p-weekly`, `3p-5h`         | Separate 3P bucket with independent 5h and weekly limits.                   |
| **Gemini 4 Argon**        | Gemini 4 Argon                       | `gemini-argon-wtu-weekly`    | Dedicated weekly Work-Through-Unit (WTU) budget on Pro plans.               |

- **Internal pool group keys:** `claude`, `gemini-argon`, `gemini-hydrogen`. Gemini 3.8 Flash, Gemini 4 Hydrogen, Gemini 4 Neon, and Gemini 4 Carbon share the `gemini-hydrogen` pool; `gemini-flash` is the pre-rename key and stays accepted as a legacy alias in state files and pool group policy overrides. Stored pool ids are `<group>` or `<group>:<slug>`, so migration v4 rewrites only the prefix.
- **Orchestrator routes span both Gemini pools.** The live listing carries exactly two: `gemini-pro-orchestrator-neon` (`Orchestrator (Neon)`) bills Hydrogen, `gemini-pro-orchestrator-g1-pro` (`Orchestrator (Argon)`) bills Argon. Both are in `CANONICAL_AGY_MODELS` with `supportedEfforts: []` so a deployment that cannot probe still offers them and never passes `--effort`. Carbon (`gemini-4-carbon`) is deliberately absent from the bundle — it is Ultra-only, so the pickers must not offer it; `DynamicModelCatalog` discovers it from the live probe instead. A group default is never a route: `applyPoolGroupDefaults` filters orchestrator ids before choosing one.
- **Listed-but-unavailable models are skipped, not rejected.** The cascade endpoint lists placeholders with `disabled: true` or an empty `quotaInfo: {}`; a `-disabled` id resolves to no pool, an empty `quotaInfo` parses as absent telemetry, and neither may fail the whole probe.
- **A tier-withheld model resolves inside its own pool group.** The live `agy models` listing decides what the account may run: a configured or cascaded id missing from it (`gemini-4-hydrogen` on AI Plus) is replaced by the newest model the same pool group still serves (`gemini-3.8-flash`) through `resolveAvailableModelId`. It is never moved to another group, so the dispatch stays charged to the pool it was budgeted against, and a group with no live pool stays refused.
- **`pool_state` is reconciled per probe.** A successful probe retires every pool it did not report, deleting that pool's `pool_state`, `pool_milestones` and `pool_samples` rows plus its early-reset notice entry, so the offline fallback (`snapshotsFromSentryState`), the dashboard grid and `/api/summary` stop advertising a dropped pool. An empty probe retires nothing: a failed probe is not evidence the account lost its pools.
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
  - `swarm_tasks`: `(id TEXT PRIMARY KEY, task_number, title, tier, origin_id, origin_number, origin_title, created_at, updated_at, repository_id, repository_name, repository_path, clone_url, default_branch, prompt, requested_by, pr_policy DEFAULT 'inherit', schedule_mode, required_labels_json, model, candidate_models_json, pool_group, effort DEFAULT 'high', allow_overage, push_branch, auto_create_pr, pr_url, expires_at, verify_command, status, runner_id, claimed_at, heartbeat_at, completed_at, branch_name, output, error, duration_ms, num_turns, total_tokens, thinking_tokens)` - the swarm task queue and execution lifecycle. `title` exists (defaults to `''`), `tier` defaults to `immediate`, and `task_number` carries a unique index.
  - `backlog_tasks`: `(id, task_number, title, prompt, repository_id, models_json, verify_command, auto_create_pr, pr_policy DEFAULT 'inherit', priority_order, status, attempt_count, max_attempts DEFAULT 2, last_error, swarm_task_id, github_issue_number, github_issue_url, created_at, updated_at)` - queued autonomous work; `attempt_count`/`max_attempts` bound retries and `github_issue_number` is the nullable label-sync link.
  - `routine_tasks`: `(id, task_number, title, prompt, repository_id, models_json, verify_command, auto_create_pr, pr_policy DEFAULT 'inherit', enabled, sort_order, trigger_before_reset_hours, min_headroom_percent DEFAULT 10, last_triggered_reset_time, last_triggered_cycles_json, last_task_id, created_at, updated_at)` - recurring templates (supersedes the old `standing_tasks` table, which no longer exists in the schema). `last_task_id` is the most recent run, and a routine re-arms only when that run reached `completed` (a `failed`/`aborted` run ends the reset cycle).
  - `swarm_runners`: `(runner_id TEXT PRIMARY KEY, name, token_hash, labels_json, repositories_json, system_info_json, enabled, active_task_id, status, registered_at, last_seen_at)` - registered runner nodes and heartbeat telemetry. Labels and repositories are JSON columns, not `labels`/`worker_mode`.
  - `swarm_runner_registrations`: one row per one-time registration token; consumed and expired rows are pruned by `pruneRegistrationTokens()`.
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
  To guarantee a minimal runtime memory footprint, inactive notification channels must never initialize listeners or load modules into memory. The notifier factory uses dynamic `await import()` so `discord.js` is strictly isolated and never loaded when `NOTIFICATION_CHANNELS` lists only `webhook`.
- **Console is logging, not a channel.** There is no console adapter, no card and no ASCII box: every notification event is written to stdout and the Logs buffer by the logger at its source, unconditionally. A stored or env `console` value is dropped with one warning, because silently ending up with zero destinations is worse than saying the channel was retired. Any new event that notifies must also log where it is produced — the burn kick had to gain a log line for exactly this reason.
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
- **Format & Lint:** `npm run lint` runs `prettier --check . && eslint frontend/src`; `npm run format` runs `eslint --fix frontend/src && prettier --write .`. Pretty-printed markdown and SVG are checked by prettier, so a hand-edited file that skips `npm run format` fails CI.
- **Typecheck:** `npm run typecheck` runs `tsc --noEmit`, then `tsc -p tsconfig.test.json --noEmit`, then `npm --prefix frontend run typecheck`. All three must pass; the test tsconfig is separate and a source-only check hides test-file type errors.
- **Test Suite Execution:** `npm test` runs Node 26 native test runner (`node --no-warnings --import tsx --test tests/**/*.test.ts`).
- **Test Suite Handle Hygiene & Isolation:**
  - Any test binding an HTTP server, child process, daemon, or database MUST guarantee teardown inside `try ... finally` or `t.after()`.
  - Tests must NEVER write into repository `./data/` directories; strictly allocate temporary directories with `os.tmpdir()` and clean up on teardown.
  - Zero real wall-clock multi-second sleeps in unit tests (total test runtime must finish in < 5s).
