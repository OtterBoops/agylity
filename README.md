# agylity

> **Stop letting precious Antigravity quotas evaporate into thin air while sleeping, touching grass, or losing track of time.**  
> A lightweight, zero-CVE 24/7 sentry and AI overcharge guard for Google Antigravity (`agy`). Built for Node 26 (`node:26-slim`) with pure TypeScript and a strictly minimal runtime footprint to keep containers lean and supply chains secure.

[![CI/CD Pipeline](https://github.com/OtterBoops/agylity/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/OtterBoops/agylity/actions/workflows/docker-publish.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D26.0.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/License-PolyForm_Noncommercial_1.0.0-blue.svg)](./LICENSE)

---

## What is this thing?

Google Antigravity provides generous rolling quotas across frontier models (**Claude**, **Gemini**, and **GPT**). However, quotas expire on aggressive rolling 5-hour throttles and weekly deadlines.

Finishing work for the day with 80% quota headroom remaining means donating free compute back to the ether. Conversely, leaving an unattended agent script executing overnight with metered flex credits enabled can trigger unexpected billable overages.

**Agylity** solves both problems. Running 24/7 on lightweight hardware (Raspberry Pi, homelab host, or VPS), it monitors rolling capacity and alerts configured notification channels when headroom risks expiring unused. The notification layer is modular and platform-agnostic: the default is silent sentry mode (`none`), and multiple notification channels (`discord`, `webhook`, `console`) can be configured simultaneously. It also acts as an automated emergency brake against billable AI overages.

> [!NOTE]  
> Looking for ASCII architectural diagrams, Connect-RPC protobuf schemas, or security state machines?  
> See the in-depth **[Architecture & Security Guide (docs/architecture.md)](./docs/architecture.md)**.

---

## Key Highlights

- **Dual-Bucket Quota Sentry**: Tracks both short-term 5-hour sprint throttles and authoritative weekly marathon budgets via the local Language Server RPC.
- **Wallet Protection Shield**: Enforces a strict safety floor (`MIN_DISPATCH_HEADROOM_PERCENT`, default: `10%`) to block accidental paid overages. Can be dialed down to `0%` on flat-tier accounts to burn quota down to the last drop.
- **Strict Single-User Binding**: Enforces Antigravity's single-tenant seat boundary via explicit Discord owner pinning (`DISCORD_OWNER_USER_ID`) and automatic Trust-On-First-Use (TOFU) session binding so no secondary Discord user can query quotas or trigger actions.
- **Modular Multi-Channel Alerts**: Default is silent sentry mode (`none`). Multiple channels can be active simultaneously (Discord, Webhooks, Console, with more adapters on the roadmap) instead of locking into a single platform.
- **Decoupled Web Dashboard**: Optional dark-mode UI built with **Vite + Preact + Tailwind CSS** (Tailwind v4, Rosé Pine palette) for live gauges and config tweaks. Setting `WEB_UI_ENABLED=false` spawns zero HTTP listeners and binds zero ports.
- **Config with Common Sense**: Three-tier fallback (`SQLite Overrides` $\to$ `.env` $\to$ `Defaults`). Adjust settings live in the web dashboard without taking down the container.
- **Encrypted at Rest**: Sensitive bot tokens and CSRF credentials receive AES-256-GCM authenticated encryption at rest in SQLite and are masked in client-facing APIs.
- **Universal Pluggable Logger**: Lightweight, zero-dependency logging engine with hierarchical child namespaces (`[sentry]`, `[daemon]`, `[web]`), pluggable sinks, fault isolation, secret redaction, and real-time streaming to the Web UI dashboard.
- **Task Orchestrator & Swarm Runners**: Pull-based distributed task runner control plane: queue tasks into SQLite and execute isolated continuation branches across registered Docker or host CLI runners without opening inbound firewall ports.
- **Control-Plane Auth & Edge Defense**: Constant-time Bearer token verification (`WEB_UI_AUTH_TOKEN`, required for a non-loopback bind), sliding-window anti-brute-force rate limiting (HTTP 429), standard security headers (`nosniff`, `DENY`), and a zero-DOM-leak `<ControlPlaneGate />` lock screen that prevents unauthenticated UI inspection.
- **Application IP Whitelisting & Anti-Spoofing**: Native IPv4, IPv6, and CIDR subnet allowlisting (`ALLOWED_IP_RANGES`) with strict RFC1918 peer socket validation (`TRUSTED_PROXIES`) preventing proxy header injection (CWE-290).
- **Non-Blocking Hidden Telemetry**: Background stale-while-revalidate credits probe and headless Windows process execution (`-WindowStyle Hidden`, `windowsHide: true`) preventing terminal flashing or focus stealing.
- **Clean Single-Post Webhook Embeds**: Formatted rich Discord and generic webhook cards with elapsed duration metrics, dynamic Discord relative timestamps, and intermediate runner heartbeat suppression.
- **Zero npm Bloat**: Powered by Node 26 native primitives (`node:http`, `node:sqlite`, `node:crypto`, `node:test`). The entire production runtime depends strictly on **3 packages** (`discord.js`, `ky`, `zod`).

---

## Quickstart (Docker Compose)

Running Agylity does not require cloning the entire git repository. Grab the compose definition and environment template directly:

```bash
# 1. Download docker-compose.yaml and environment template
curl -sLO https://raw.githubusercontent.com/OtterBoops/agylity/main/docker-compose.yaml
curl -sLO https://raw.githubusercontent.com/OtterBoops/agylity/main/.env.example
cp .env.example .env

# 2. Configure environment (e.g. notifications, safety floor)
nano .env

# 3. Fire up the container
docker compose up -d
```

When `WEB_UI_ENABLED=true`, access the dashboard at `http://localhost:8484`.

> [!NOTE]
> The worker container needs `GITHUB_TOKEN` to push task branches. It must be set in the project `.env` **and** named in that project's `compose.yaml` `environment:` list — a `.env` entry alone reaches nothing, and a variable that is set but empty counts as unset. A worker with no token **refuses to start** (exit 1, so it crash-loops visibly) rather than claiming a task it could never deliver: the clone would succeed on a public repository, the task would run and spend its quota, and only the push would fail. Set `ALLOW_TOKENLESS_WORKER=true` only for a non-GitHub remote.

---

## Technical Documentation

Detailed operational guides and architectural references live in the [`docs/`](./docs) directory:

- **[System Architecture & Protocols](./docs/architecture.md)** — Connect-RPC dual-bucket mechanics, IPC sniffing, encryption internals, and zero-clobber invariants.
- **[Configuration Reference](./docs/configuration.md)** — Exhaustive breakdown of every `.env` setting, milestone window, and SQLite override.
- **[Deployment Playbooks](./docs/deployment.md)** — Docker Compose configs, homelab GitOps, and vanilla Node 26 systemd service templates.
- **[Testing & Verification](./docs/testing.md)** — Test architecture and methodology behind deterministic tests written with Node's native test runner.

---

## Contributing & Local Development

Contributions, issues, and feature requests are welcome! If you're submitting a pull request, please ensure tests and type checks pass before opening a PR.

### Prerequisites

- Node.js >= 26.0.0
- npm >= 10.0.0

### Local Dev Setup

```bash
# 1. Clone the repository
git clone https://github.com/OtterBoops/agylity.git
cd agylity

# 2. Install root and frontend dependencies
npm ci
npm --prefix frontend ci

# 3. Set up environment
cp .env.example .env
```

### Running Local Dev Servers

Agylity separates the backend daemon from the **Vite + Preact + Tailwind CSS** frontend:

```bash
# Terminal 1: Run the backend daemon with live watch (http://localhost:8484)
npm run dev:server

# Terminal 2: Run the Vite client dev server with HMR (http://localhost:5173)
npm run dev:client
```

The Vite dev server automatically proxies `/api` requests to the backend daemon on port 8484.

To test a full production build locally:

```bash
# Compiles frontend into dist/web/public and backend TypeScript into dist/
npm run build

# Runs production build
npm start
```

---

## Testing & Verification

Comprehensive deterministic unit, adversarial, and integration suites run using Node's native test runner (`node:test`):

```bash
# 1. Check code style and Tailwind canonicalization
npm run lint

# 2. Automatically format files and sort Tailwind classes
npm run format

# 3. Typecheck TypeScript
npm run typecheck

# 4. Run complete test suite
npm test
```

Verification status: **246 tests passing across 57 suites** (0 failures, 0 skipped, 100% deterministic). Run `npm test` for the current count — this line rots.

---

## Releasing

1. Bump `version` in both `package.json` and `frontend/package.json`, then commit.
2. Push `main`:

   ```bash
   git push origin main
   ```

3. Create and push an **annotated** tag. Its message becomes the release title, so write it as one:

   ```bash
   git tag -a v1.2.3 -m "v1.2.3 — Short Release Title"
   git push origin v1.2.3
   ```

   The publish job reads the title from the tag object. A lightweight tag has no message, so the workflow falls back to the tag name rather than a commit subject.

---

## For Autonomous Coding Agents

Autonomous agents and AI pair programmers working in this repository must adhere to these invariants:

1. **Always Check & Update Documentation**: Agents must inspect and update any relevant documentation (`README.md`, `docs/`) whenever modifying behavior, schemas, dependencies, or configuration.
2. **Prettier & Canonical Tailwind Classes**: All code must adhere to Prettier formatting and automatic Tailwind class sorting (`prettier-plugin-tailwindcss`). Utility classes in frontend components must be strictly canonical (e.g., `size-1.5`, `size-full`, `text-xs/relaxed`). Run `npm run lint` to enforce.
3. **Zero-CVE Minimal Posture**: Runtime dependencies are strictly locked to `discord.js`, `ky`, and `zod`. Do not add new external runtime dependencies.
4. **Zero-Clobber Invariant**: Autonomous tasks must never execute headlessly on the monitoring daemon host.
5. **Tailwind v4 Invariant**: In the **Vite + Preact + Tailwind CSS** frontend, styles must be composed strictly via utility classes in markup. Root stylesheets strictly hold `@import "tailwindcss";`, `@theme`, and design tokens with **zero custom class definitions**.
6. **Empirical Verification Loop**: Run `npm run lint`, `npm run typecheck`, and `npm test` before completion.

---

## Credits & Upstream Projects

- **[Vite](https://vite.dev/)**, **[Preact](https://preactjs.com/)** & **[Tailwind CSS](https://tailwindcss.com/)** — For the ultra-fast virtual DOM, bundle tooling, and utility-first styling engine.
- **[Discord.js](https://discord.js.org/)** — For reliable Discord gateway and component interaction bindings.
- **[Rosé Pine](https://rosepinetheme.com/)** — For the best color palette on the internet.

---

## License

[PolyForm Noncommercial License 1.0.0](./LICENSE) © [OtterBoops](https://github.com/OtterBoops). Free for personal homelabs, noncommercial hacking, and learning. Commercial exploitation, hosted charging, or SaaS wrapping is strictly prohibited.


## End-to-end verification

A dispatched task is claimed by a swarm worker, which runs `agy` in an isolated branch. The result is pushed and opened as a pull request automatically.
