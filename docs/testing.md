# Testing & Verification Architecture

This document details the testing methodology, layout, and boundary verification architecture used in `agylity`.

---

## 1. Testing Philosophy & Core Invariants

Agylity uses Node's native test runner (`node:test`) and strict assertions (`node:assert/strict`) executed directly via `tsx`. There is no Jest, Vitest, Mocha or Sinon — the test toolchain adds no runtime dependency.

1. **Opaque-Box Verification**: Tests exercise public contracts, wire protocols, mathematical calculations, and state machines rather than internal private variables.
2. **Deterministic & Isolated Execution**: Ephemeral mock Connect-RPC servers, mock webhook servers, free-port allocation and in-memory SQLite instances verify network and database behaviour deterministically, with no external internet access.
3. **Handle Hygiene**: Any test that binds an HTTP server, socket or child process tears it down inside `try ... finally` (or `t.after()`), so a failing assertion can never leave an open handle that silently hangs the runner.
4. **Adversarial & Boundary Rigor**: Subsystems are hardened against malformed payloads, unicode edge cases, timing hazards and unexpected process crashes.

---

## 2. Directory Layout

```
tests/
├── e2e/
│   ├── harness/
│   │   └── index.ts            # Shared helpers: mock RPC server, mock webhook server,
│   │                           # mock Discord interaction, free-port allocation, temp dirs
│   └── dispatch.test.ts        # Full dispatch lifecycle against a real temp git repository
└── unit/
    ├── config.test.ts          # Zod schema, preprocessors, store fallback precedence
    ├── daemon.test.ts          # Daemon lifecycle, signals, scheduler
    ├── db.test.ts              # node:sqlite storage, WAL, key-value overrides, encryption failures
    ├── ip.test.ts              # IP allowlist / CIDR parsing
    ├── logger.test.ts          # Logger, sinks, levels, namespaces, redaction
    ├── notify.test.ts          # Adapters, embeds, components, Discord interaction plumbing
    ├── orchestrator.test.ts    # Task queue, coordinator, model routing, pull-worker swarm
    ├── sentry.test.ts          # Connect-RPC parsing, CLI fallback, milestone math
    └── web.test.ts             # REST routes, auth guards, 404/405, 64 KB body limit
```

`npm test` runs `node --no-warnings --import tsx --test tests/**/*.test.ts`, so it covers both directories in one pass.

---

## 3. What Each Layer Verifies

### Unit suites (`tests/unit/`)

| File                   | Covers                                                                                                                                               |
| :--------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.test.ts`       | Boolean string traps (`" FALSE "`, `"1"`, `""`), milestone parsing, the `SQLite > env > defaults` hierarchy, prototype-pollution key rejection.      |
| `db.test.ts`           | WAL mode, key-value overrides, AES-256-GCM round-trips, and that a decryption failure surfaces rather than silently returning an empty secret.       |
| `ip.test.ts`           | CIDR parsing (a bare `/` must be rejected, never read as `/0`), loopback-only proxy trust.                                                           |
| `logger.test.ts`       | Level filtering, child namespaces, sink fault isolation.                                                                                             |
| `notify.test.ts`       | Multi-channel fan-out, webhook signing and retry, embed field limits, Discord modal/select plumbing.                                                 |
| `orchestrator.test.ts` | Enqueue/claim/status transitions, lease reaping and ownership guards, branch naming, dispatch eligibility and the safety floor, runner registration. |
| `sentry.test.ts`       | Quota aggregation, dual-window headroom math, milestone evaluation and late-wake reconciliation, CLI fallback parsing.                               |
| `web.test.ts`          | Every REST route, control-plane auth, IP rate limiting, 404/405 guards, the 64 KB body ceiling (HTTP 413), and status-report refusals.               |
| `daemon.test.ts`       | Startup, signal handling, scheduler wiring.                                                                                                          |

### End-to-end suite (`tests/e2e/`)

`dispatch.test.ts` drives a full dispatch against a **real temporary git repository**: it initialises the repo, runs the coordinator and a runner through enqueue → claim → execute → report, and asserts on the resulting branch and task record. The harness in `tests/e2e/harness/index.ts` supplies the mock RPC server, mock webhook server, mock Discord interaction, `getFreePort()` and `makeTempDir()`.

---

## 4. Running the Suite

```bash
# Everything: unit + e2e (233 tests across 55 suites)
npm test

# Unit only
npx tsx --test tests/unit/*.test.ts

# The e2e dispatch lifecycle
npx tsx --test tests/e2e/dispatch.test.ts

# Typecheck daemon, tests and frontend
npm run typecheck

# Prettier + canonical Tailwind class linting
npm run lint

# Build both the Preact client and the TypeScript daemon
npm run build
```

Counts drift; `npm test` prints the authoritative `tests` / `suites` totals.
