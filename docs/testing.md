# Testing & Verification Architecture

This document details the testing methodology, layout, and boundary verification architecture used in `agylity`.

---

## 1. Testing Philosophy & Core Invariants

Agylity uses Node's native test runner (`node:test`) and strict assertions (`node:assert/strict`) executed directly via `tsx`. There is no Jest, Vitest, Mocha or Sinon — the test toolchain adds no runtime dependency.

1. **Opaque-Box Verification**: Tests exercise public contracts, wire protocols, mathematical calculations, and state machines rather than internal private variables.
2. **Deterministic & Isolated Execution**: The real web server binds an ephemeral loopback port, RPC and webhook transports are replaced by stubbed `fetch` functions, and every database is a throwaway instance — `:memory:` for unit suites, a temp-directory file for the e2e dispatch — so network and storage behaviour is verified deterministically, with no external internet access.
3. **Handle Hygiene**: Any test that binds an HTTP server, socket or child process tears it down inside `try ... finally` (or `t.after()`), so a failing assertion can never leave an open handle that silently hangs the runner.
4. **Adversarial & Boundary Rigor**: Subsystems are hardened against malformed payloads, unicode edge cases, timing hazards and unexpected process crashes.

---

## 2. Directory Layout

```
tests/
├── e2e/
│   ├── harness/
│   │   └── index.ts            # Shared helpers: temp dirs and the in-memory log sinks
│   └── dispatch.test.ts        # Full dispatch lifecycle against a real temp git repository
└── unit/
    ├── catalog.test.ts         # Dynamic agy model catalog: fetch, parse, cache TTL
    ├── config.test.ts          # Zod schema, preprocessors, store fallback precedence
    ├── daemon.test.ts          # Daemon lifecycle, signals, scheduler
    ├── db.test.ts              # node:sqlite storage, WAL, key-value overrides, encryption failures
    ├── ip.test.ts              # IP allowlist / CIDR parsing
    ├── logger.test.ts          # Logger, sinks, levels, namespaces, redaction
    ├── notify.test.ts          # Adapters, embeds, components, Discord interaction plumbing
    ├── coordinator.test.ts     # Task queue, coordinator, model routing, pull-runner swarm
    ├── runner.test.ts          # TaskExecutor and RemoteSwarmRunner contracts
    ├── schema.test.ts          # SQLite schema and migration column diffs
    ├── sentry.test.ts          # Connect-RPC parsing, CLI fallback, milestone math
    ├── tier-lifecycle.test.ts  # Immediate / backlog / routine tier transitions, origin settlement
    └── web.test.ts             # REST routes, auth guards, 404/405, 64 KB body limit
```

`npm test` runs `node --no-warnings --import tsx --test tests/**/*.test.ts`, so it covers both directories in one pass.

---

## 3. What Each Layer Verifies

### Unit suites (`tests/unit/`)

| File                     | Covers                                                                                                                                                                                                                                                                                                                                       |
| :----------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog.test.ts`        | `agy models` suffix/output parsing, grouping by base model id, pool group and effort resolution, stale-while-revalidate cache TTL, `/api/models` annotation.                                                                                                                                                                                 |
| `config.test.ts`         | Boolean string traps (`" FALSE "`, `"1"`, `""`), milestone parsing, the `SQLite > env > defaults` hierarchy, prototype-pollution key rejection.                                                                                                                                                                                              |
| `db.test.ts`             | WAL mode, key-value overrides, AES-256-GCM round-trips, and that a decryption failure surfaces rather than silently returning an empty secret.                                                                                                                                                                                               |
| `ip.test.ts`             | CIDR parsing (a bare `/` must be rejected, never read as `/0`), loopback-only proxy trust.                                                                                                                                                                                                                                                   |
| `logger.test.ts`         | Level filtering, child namespaces, sink fault isolation.                                                                                                                                                                                                                                                                                     |
| `notify.test.ts`         | Multi-channel fan-out, webhook signing and retry, embed field limits, Discord modal/select plumbing.                                                                                                                                                                                                                                         |
| `coordinator.test.ts`    | Enqueue/claim/status transitions, lease reaping and ownership guards, branch naming, dispatch eligibility and the safety floor, runner registration.                                                                                                                                                                                         |
| `runner.test.ts`         | `TaskExecutor` and `RemoteSwarmRunner`: telemetry parsing, process-group kill, capacity failover with continuation context, bare-mirror clone, status-payload budget, git secret redaction, PR policy and documentation classification, verification guard, persisted identity, coordinator request contract, runner CLI env/arg precedence. |
| `schema.test.ts`         | A fresh database matches the declared schema exactly, each migration lands the expected column diff, and v4 renames every stored `gemini-flash` pool id onto `gemini-hydrogen` without colliding with rows already renamed.                                                                                                                  |
| `sentry.test.ts`         | Quota aggregation, dual-window headroom math, milestone evaluation and late-wake reconciliation, CLI fallback parsing, and a `data/state.json` import that upgrades a pre-rename pool key.                                                                                                                                                   |
| `tier-lifecycle.test.ts` | Immediate, backlog and routine tier transitions, untyped patches and unknown models, origin settlement (no stranded backlog), mounted working copies surviving a run.                                                                                                                                                                        |
| `web.test.ts`            | Every REST route, control-plane auth, IP rate limiting, 404/405 guards, the 64 KB body ceiling (HTTP 413), and status-report refusals.                                                                                                                                                                                                       |
| `daemon.test.ts`         | Startup, signal handling, scheduler wiring.                                                                                                                                                                                                                                                                                                  |

### End-to-end suite (`tests/e2e/`)

`dispatch.test.ts` drives a full dispatch against a **real temporary git repository**: it initialises the repo, runs the coordinator and a runner through enqueue → claim → execute → report, and asserts on the resulting branch and task record. The harness in `tests/e2e/harness/index.ts` supplies `makeTempDir()` (used by most unit suites) and the `createBufferSink` / `createMemorySink` log sinks.

---

## 4. Running the Suite

```bash
# Everything: unit + e2e
npm test

# Unit only
node --no-warnings --import tsx --test tests/unit/*.test.ts

# The e2e dispatch lifecycle
node --no-warnings --import tsx --test tests/e2e/dispatch.test.ts

# Typecheck daemon, tests and frontend
npm run typecheck

# Prettier check + ESLint (incl. canonical Tailwind class sorting)
npm run lint

# Format in place
npm run format

# Build both the Preact client and the TypeScript daemon
npm run build
```

Counts drift; `npm test` prints the authoritative `tests` / `suites` totals.
