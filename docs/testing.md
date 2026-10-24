# Testing & Verification Architecture

This document details the multi-tier testing methodology, test hierarchy, and boundary verification architecture used in `agylity`.

---

## 1. Testing Philosophy & Core Invariants

Agylity uses Node's native test runner (`node:test`) and strict assertions (`node:assert/strict`) executed directly via `tsx`.

1. **Opaque-Box Verification**: Tests exercise public contracts, wire protocols, mathematical calculations, and state machines rather than internal private variables.
2. **Deterministic & Isolated Execution**: Ephemeral mock Connect-RPC servers, UDP packet listeners, and in-memory SQLite instances are used to verify network and database operations deterministically without external internet access.
3. **Zero Third-Party Test Footprint**: Eliminates Jest, Vitest, Mocha, and Sinon to preserve the strict zero-CVE minimal dependency footprint.
4. **Adversarial & Boundary Rigor**: Every subsystem is hardened against malformed payloads, unicode edge cases, timing hazards, and unexpected process crashes.

---

## 2. Directory Layout & Test Suite Hierarchy

```
tests/
├── e2e/
│   ├── harness/
│   │   └── index.ts                         # Reusable mock RPC server, UDP listener, Discord mocks, temp dir
│   ├── runner.ts                            # Standalone multi-tier E2E suite orchestrator
│   ├── tier1_features/                      # Core Feature Coverage
│   │   ├── config_persistence.test.ts       # Zod schema, SQLite store, fallback hierarchy
│   │   └── web_ui_lifecycle.test.ts         # Web dashboard, zero-overhead, server lifecycle
│   ├── tier2_boundaries/                    # Boundary & Corner Cases
│   │   ├── config_boundaries.test.ts        # Extreme env, boolean string traps, SQL injection safety
│   │   └── web_boundaries.test.ts           # Port collisions, malformed JSON, 404/405 guards
│   ├── tier4_application/                   # Real-World Autonomous Scenarios
│   │   └── scenarios.test.ts                # Realistic end-to-end full lifecycle flows
│   └── tier5_adversarial/                   # Adversarial Stress Testing & Attack Hardening
│       ├── config_web_adversarial.test.ts   # Concurrent transactions, socket drops, air-gap UI
│       └── daemon_remote_adversarial.test.ts# Network partitions, UDP frame fuzzing, git safety
└── unit/                                    # Implementation module & challenger stress tests
    ├── canonical_and_formatting.test.ts     # Prettier formatting and canonical Tailwind classes
    ├── config.test.ts                       # Unit tests for schema & preprocessors
    ├── daemon.test.ts                       # Daemon lifecycle, signals, and scheduler
    ├── db.test.ts                           # SQLite storage, WAL mode, key-value overrides
    ├── logger.test.ts                       # Universal pluggable logger, sinks, levels, namespaces
    ├── logs_history.test.ts                 # LogBuffer ring buffer and secret redaction
    ├── m1_adversarial.test.ts               # Config & persistence adversarial edge cases
    ├── m1_challenger2_edge_cases.test.ts    # Extreme environment variables & SQL boundary safety
    ├── m2_challenger2_stress.test.ts        # Connect-RPC precision boundaries & clock skews
    ├── m2_challenger_stress.test.ts         # Milestone calculation stress & RPC crash recovery
    ├── m2_empirical_challenger.test.ts      # Empirical process discovery & RPC edge cases
    ├── m3_challenger_stress.test.ts         # Notification isolation & WoL frame stress
    ├── multi_channel_notify.test.ts         # Multi-channel composite routing & test pings
    ├── notify.test.ts                       # Discord adapter, components, modals, 3s defer
    ├── optional_orchestrator_and_crypto.test.ts # AES-256-GCM crypto & orchestrator guardrail
    ├── sentry.test.ts                       # Connect-RPC parser, CLI fallback, milestone math
    └── web.test.ts                          # REST API routes, 404/405 guards, 64 KB body limits
```

---

## 3. Test Tier Architecture

### Tier 1: Core Feature Coverage

Covers the happy paths and primary operational semantics across functional modules (config persistence and decoupled web dashboard server lifecycle).

### Tier 2: Boundary & Corner Cases

Boundary and extreme condition tests across critical domains:

1. **Config Boundaries**: Boolean string traps (`" FALSE "`, `"1"`, `""`), SQL injection attempts in keys/values, unicode emojis, and concurrent writes under SQLite WAL mode.
2. **Web UI Boundaries**: Port collision (`EADDRINUSE`), 404/405 HTTP status handling, malformed JSON payloads, and zero-overhead verification.

### Tier 4: Real-World Application Scenarios

Simulates realistic, multi-step autonomous workflows:

- **Scenario 1**: Quota alert $\to$ sentry milestone detection $\to$ alert state persistence $\to$ Discord embed formatting $\to$ clean notification delivery.
- **Scenario 2**: Orchestrator disabled $\to$ task dispatch request received $\to$ Zero-Clobber Guardrail triggers $\to$ returns `ORCHESTRATOR_DISABLED` $\to$ zero headless execution on daemon host.
- **Scenario 3**: Direct Connect-RPC endpoint is unreachable $\to$ Sentry falls back to secondary port, then `agy CLI` $\to$ model config populated $\to$ quota evaluated.
- **Scenario 4**: User adjusts threshold via Web UI $\to$ persisted to SQLite $\to$ Sentry immediately detects new threshold on next evaluation cycle.
- **Scenario 5**: Daemon crash recovery $\to$ reads existing `state.json` $\to$ avoids duplicate alerts $\to$ advances cleanly to next milestone window.

### Tier 5: Adversarial Coverage Hardening

Deep stress-testing suites verifying:

- Resistance to process crashes on broken sockets, truncated streams, or abrupt RPC drops.
- Snapshot isolation in SQLite under concurrent read/write transactions.
- Zero external CDNs, fonts, or scripts in the served web dashboard (air-gap verification).
- Network partitions, UDP frame fuzzing, and Git workspace clean state validation.

### Unit & Challenger Stress Tiers

Focused unit tests and adversarial challenger suites verifying:

- Connect-RPC parser, model pooling math, and milestone countdown calculations.
- Multi-channel notification routing (`CompositeNotifier`) across Discord, Webhook, and Console.
- AES-256-GCM authenticated encryption at rest and keyfile derivation.
- REST API body size enforcement (64 KB ceiling with HTTP 413) and socket handle teardown hygiene.
- Prettier formatting compliance and Tailwind CSS utility class canonicalization.

---

## 4. Running the Test Suite

```bash
# 1. Run complete deterministic test suite (381 tests across 99 suites)
npm test

# 2. Run standalone E2E test runner (104 tests across 22 suites)
node --import tsx tests/e2e/runner.ts

# 3. Typecheck TypeScript source
npm run typecheck

# 4. Check formatting and canonical Tailwind utility classes
npm run lint

# 5. Run individual tier suites
node --no-warnings --import tsx --test tests/e2e/tier1_features/*.test.ts
node --no-warnings --import tsx --test tests/e2e/tier2_boundaries/*.test.ts
node --no-warnings --import tsx --test tests/e2e/tier4_application/*.test.ts
node --no-warnings --import tsx --test tests/e2e/tier5_adversarial/*.test.ts
node --no-warnings --import tsx --test tests/unit/*.test.ts
```
