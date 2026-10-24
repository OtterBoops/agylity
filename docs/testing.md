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
│   │   └── index.ts                 # Reusable mock RPC server, UDP listener, Discord mocks, temp dir
│   ├── runner.ts                    # Standalone multi-tier E2E suite orchestrator
│   ├── tier1_features/              # Core Feature Coverage (>=5 tests per feature)
│   │   ├── config_persistence.test.ts   # Features 2, 3, 4 (Zod schema, SQLite store, fallback)
│   │   ├── quota_sentry.test.ts         # Features 5, 6, 7, 8, 9 (Connect-RPC, model pools, deduplication)
│   │   ├── notification_discord.test.ts # Features 10-14 (Notifier, dynamic isolation, components, 3s defer)
│   │   ├── remote_orchestrator.test.ts  # Features 15-18 (Worker wake, connection polling, zero-clobber, safe exec)
│   │   └── web_ui_lifecycle.test.ts     # Features 19, 20, 25 (Web dashboard, zero-overhead, lifecycle)
│   ├── tier2_boundaries/            # Boundary & Corner Cases (>=5 tests per domain)
│   │   ├── config_boundaries.test.ts    # Extreme env, boolean string traps, SQL injection safety
│   │   ├── quota_boundaries.test.ts     # Precision boundaries, negative reset times, empty RPC
│   │   ├── discord_boundaries.test.ts   # 4000-char prompts, emojis, 3s timeout guardrail
│   │   ├── remote_boundaries.test.ts    # MAC normalization, Base64 safety, dirty git trees
│   │   └── web_boundaries.test.ts       # Port collisions, malformed JSON, 404/405 guards
│   ├── tier3_combinations/          # Cross-Feature Interactions
│   │   └── cross_feature.test.ts        # Pairwise subsystem interactions & dynamic updates
│   ├── tier4_application/           # Real-World Autonomous Scenarios
│   │   └── scenarios.test.ts            # Realistic end-to-end full lifecycle flows
│   └── tier5_adversarial/           # Adversarial Stress Testing & Attack Hardening
│       ├── config_web_adversarial.test.ts
│       └── daemon_remote_adversarial.test.ts
└── unit/                            # Implementation module unit tests
    ├── config.test.ts               # Unit tests for schema & preprocessors
    ├── db.test.ts                   # Unit tests for SQLite storage & WAL mode
    ├── notify.test.ts               # Notification factory & Discord components
    ├── remote.test.ts               # Worker dispatch & execution
    ├── sentry.test.ts               # Connect-RPC parser & milestone evaluator
    └── web.test.ts                  # REST API endpoints & route guards
```

---

## 3. Test Tier Architecture

### Tier 1: Core Feature Coverage

Covers the happy paths and primary operational semantics across all functional modules. Each feature is verified with a minimum of 5 distinct test cases exercising input parsing, state transformation, protocol serialization, and contract conformance.

### Tier 2: Boundary & Corner Cases

Adversarial and extreme condition tests across 5 critical domains:

1. **Config Boundaries**: Boolean string traps (`" FALSE "`, `"1"`, `""`), SQL injection attempts in keys/values, unicode emojis, and concurrent writes under SQLite WAL mode.
2. **Quota Sentry Boundaries**: Floating point thresholds (`0.250001` vs `0.250000`), clock skew / negative reset times, empty model arrays, and server 500 errors.
3. **Discord Boundaries**: Modal prompt length boundary (exact 4000 vs 4001 characters), rapid double-clicks (race debouncing), and missing permissions.
4. **Remote Orchestrator Boundaries**: MAC casing / delimiters, directed broadcast IPs, shell metacharacter injection in prompts, and dirty git workspace aborts.
5. **Web UI Boundaries**: Port collision (`EADDRINUSE`), 404/405 HTTP status handling, malformed JSON payloads, and zero-overhead verification.

### Tier 3: Cross-Feature Combinations

Verifies pairwise integration contracts:

- Dynamic SQLite UI override updating active configuration without process restart.
- CLI fallback mode avoiding duplicate milestone alerts by querying `state.json`.
- Dynamic rescheduling of Sentry interval when SQLite override is modified.
- Discord modal prompt escaping cleanly translated into Base64 task commands.
- Zero-clobber timeout abort routing directly into Discord/Webhook failure embeds.
- Web UI repository updates reflected immediately in Discord `StringSelectMenu`.
- Notification channel switching cleanly destroying old adapters.
- Sentry late-wake reconciliation resolving missed milestones without spam.

### Tier 4: Real-World Application Scenarios

Simulates realistic, multi-step autonomous workflows:

- **Scenario 1**: Quota alert $\to$ `/quota` trigger $\to$ select repository $\to$ modal prompt $\to$ synchronous `deferReply()` $\to$ worker wake $\to$ connection polling $\to$ clean git check $\to$ continuation branch checkout $\to$ `agy` execution $\to$ Discord completion update.
- **Scenario 2**: Workstation fails to wake $\to$ 60s timeout $\to$ Zero-Clobber Guardrail triggers $\to$ clean abort $\to$ failure alert $\to$ zero headless execution on daemon host.
- **Scenario 3**: Direct Connect-RPC endpoint is unreachable $\to$ Sentry falls back to `agy CLI` $\to$ model config populated $\to$ quota evaluated $\to$ webhook dispatched.
- **Scenario 4**: User adjusts threshold via Web UI $\to$ Persisted to SQLite $\to$ Sentry immediately detects new threshold on next evaluation cycle.
- **Scenario 5**: Daemon crash recovery $\to$ reads existing `state.json` $\to$ avoids duplicate alerts $\to$ advances cleanly to next milestone window.

### Tier 5: Adversarial Coverage Hardening

Deep stress-testing suites verifying:

- Resistance to process crashes on broken sockets, truncated streams, or abrupt RPC drops.
- Snapshot isolation in SQLite under concurrent read/write transactions.
- Zero external CDNs, fonts, or scripts in the served web dashboard (air-gap verification).

---

## 4. Running the Test Suite

```bash
# 1. Run complete deterministic test suite (all 339 tests)
npm test

# 2. Typecheck TypeScript source
npm run typecheck

# 3. Run individual tier suites
node --no-warnings --import tsx --test tests/e2e/tier1_features/*.test.ts
node --no-warnings --import tsx --test tests/e2e/tier2_boundaries/*.test.ts
node --no-warnings --import tsx --test tests/e2e/tier3_combinations/*.test.ts
node --no-warnings --import tsx --test tests/e2e/tier4_application/*.test.ts
node --no-warnings --import tsx --test tests/e2e/tier5_adversarial/*.test.ts
```
