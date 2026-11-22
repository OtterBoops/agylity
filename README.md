# agylity

> **Stop letting precious Antigravity quotas evaporate into thin air while sleeping, touching grass, or losing track of time.**  
> A lightweight, zero-CVE 24/7 sentry, AI overcharge guard, and pull-based task coordinator for Google Antigravity (`agy`). Built for Node 26 (`node:26-slim`) with pure TypeScript and 3 runtime dependencies (`discord.js`, `ky`, `zod`).

[![CI/CD Pipeline](https://github.com/OtterBoops/agylity/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/OtterBoops/agylity/actions/workflows/docker-publish.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D26.0.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/License-PolyForm_Noncommercial_1.0.0-blue.svg)](./LICENSE)

## What is this thing?

Google Antigravity gives you generous rolling quotas across **Claude**, **Gemini**, and **GPT** — on aggressive 5-hour sprint throttles and weekly deadlines. Finishing the day with 80% headroom left means donating free compute back to the ether; leaving an unattended script running overnight with flex credits enabled means waking up to a surprise bill.

**Agylity** solves both. Running 24/7 on a Raspberry Pi, homelab box, or VPS, it watches both quota buckets, alerts your channels before headroom expires, and acts as an emergency brake against paid overages — while coordinating backlog work and maintenance routines across isolated swarm runners.

- **Dual-Bucket Quota Sentry**: Tracks 5-hour rolling throttles and weekly budgets via Language Server Connect-RPC (with headless CLI fallback).
- **Wallet Protection Shield**: Enforces `MIN_DISPATCH_HEADROOM_PERCENT` (default `10%`, or `0%` on flat-tier accounts to burn quota down to the last drop).
- **3-Tier Coordinator & Swarm Runners**: Orchestrates immediate dispatches, backlog items, and pre-reset routines across pull-based runners (`src/runner/`) without opening inbound ports.
- **Config with Common Sense**: Three-tier fallback (`SQLite Overrides` → `.env` → `Defaults`) with AES-256-GCM encrypted secrets, live UI edits, and silent-by-default multi-channel alerts (`discord`, `webhook`).
- **Hardened Web Dashboard**: Optional Vite + Preact + Tailwind v4 UI (`WEB_UI_ENABLED=true`, port `8484`) with Bearer auth, rate limiting, and trusted-proxy CIDR validation.

## Quickstart (Docker Compose)

No need to clone the repo — grab the compose file and env template directly:

```bash
curl -sLO https://raw.githubusercontent.com/OtterBoops/agylity/main/docker-compose.yaml
curl -sLO https://raw.githubusercontent.com/OtterBoops/agylity/main/.env.example
cp .env.example .env
# Configure notifications, safety floor, WEB_UI_AUTH_TOKEN, and GITHUB_TOKEN (for runners)
docker compose up -d
```

Dashboard: `http://localhost:8484`.

> [!NOTE]
> Runner containers need `GITHUB_TOKEN` in both `.env` **and** `compose.yaml` `environment:` — otherwise they exit `1` at boot rather than burning quota on a branch they cannot push. Set `ALLOW_TOKENLESS_RUNNER=true` only for non-GitHub remotes.

## Documentation

- **[Architecture & Security](./docs/architecture.md)** — Connect-RPC protocols, SQLite schema, 3-tier task lifecycle, and security invariants.
- **[Configuration Reference](./docs/configuration.md)** — Every `.env` variable, milestone window, and SQLite override.
- **[Deployment Playbooks](./docs/deployment.md)** — Docker Compose, runner registration, and Node 26 systemd templates.
- **[Testing & Verification](./docs/testing.md)** — Deterministic unit and e2e suites using Node's native test runner.

## Local Development

Requires **Node.js >= 26.0.0** and **npm >= 10.0.0**.

```bash
git clone https://github.com/OtterBoops/agylity.git && cd agylity
npm ci && npm --prefix frontend ci
cp .env.example .env

# Dev servers (backend on :8484, Vite HMR on :5173)
npm run dev:server
npm run dev:client

# Verification & production build
npm run lint
npm run typecheck
npm test
npm run build && npm start
```

## Releasing

1. Bump `version` in `package.json` and `frontend/package.json`, commit, and push `main`.
2. Push an annotated tag: `git tag -a vX.Y.Z -m "vX.Y.Z — Short Title" && git push origin vX.Y.Z`.

## Credits & License

Built with **[Vite](https://vite.dev/)**, **[Preact](https://preactjs.com/)**, **[Tailwind CSS](https://tailwindcss.com/)**, **[Discord.js](https://discord.js.org/)**, and **[Rosé Pine](https://rosepinetheme.com/)** (the best color palette on the internet).

[PolyForm Noncommercial License 1.0.0](./LICENSE) © [OtterBoops](https://github.com/OtterBoops). Free for personal homelabs, noncommercial hacking, and learning; commercial hosting or SaaS wrapping is strictly prohibited.
