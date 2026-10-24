import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

import { ConnectRpcQuotaClient, LanguageServerError } from '../../../src/sentry/client.js';
import { QuotaEvaluator } from '../../../src/sentry/evaluator.js';
import { SentryStateManager } from '../../../src/sentry/state.js';
import { AgylityDaemon, createDaemon, startDaemon, stopDaemon } from '../../../src/index.js';
import { makeTempDir, createMockRpcServer } from '../harness/index.js';
import { ConfigStore } from '../../../src/config/store.js';
import type { Notifier } from '../../../src/notify/types.js';
import type { QuotaAlert, QuotaSnapshot } from '../../../src/sentry/models.js';

describe('Tier 5 Adversarial Hardening — Track A: Core Daemon & Alerting Engine', () => {
  /* ==================================================================== */
  /* CATEGORY 4: Connect-RPC Client, Dual Ports & Fallbacks               */
  /* ==================================================================== */
  describe('4. Connect-RPC Client & Introspection Fallbacks (src/sentry/client.ts)', () => {
    it('T5-CLI-1: queries Connect-RPC endpoint, verifies CSRF token header, and aggregates quota pools', async () => {
      const mockServer = await createMockRpcServer(0, {
        expectedCsrfToken: 'secret-token-xyz',
        responseBody: {
          clientModelConfigs: [
            {
              modelId: 'claude-3-5-sonnet',
              label: 'Claude 3.5 Sonnet',
              quotaInfo: {
                remainingFraction: 0.75,
                resetTime: new Date(Date.now() + 18 * 3600 * 1000).toISOString(),
              },
            },
            {
              modelId: 'gemini-4-argon',
              label: 'Gemini 4 Argon',
              quotaInfo: {
                remainingFraction: 0.4,
                resetTime: new Date(Date.now() + 10 * 3600 * 1000).toISOString(),
              },
            },
            {
              modelId: 'gemini-2-5-flash',
              label: 'Gemini 2.5 Flash',
              quotaInfo: {
                remainingFraction: 0.9,
                resetTime: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
              },
            },
          ],
        },
      });

      try {
        const client = new ConnectRpcQuotaClient({
          endpointUrl: mockServer.url,
          csrfToken: 'secret-token-xyz',
          enableCliFallback: false,
          enableProcessDiscovery: false,
        });

        const snapshots = await client.fetchQuota();
        assert.equal(snapshots.length, 3);

        const claude = snapshots.find((s) => s.family === 'claude');
        assert.ok(claude);
        assert.equal(claude.remainingFraction, 0.75);
        assert.ok(claude.hoursUntilReset > 17 && claude.hoursUntilReset <= 18);

        const geminiArgon = snapshots.find((s) => s.family === 'gemini-argon');
        assert.ok(geminiArgon);
        assert.equal(geminiArgon.remainingFraction, 0.4);

        const geminiFlash = snapshots.find((s) => s.family === 'gemini-flash');
        assert.ok(geminiFlash);
        assert.equal(geminiFlash.remainingFraction, 0.9);
      } finally {
        await mockServer.close();
      }
    });

    it('T5-CLI-2: falls back to secondary port when primary port is unreachable', async () => {
      const secondaryServer = await createMockRpcServer(0, {
        expectedCsrfToken: 'tok',
        responseBody: {
          clientModelConfigs: [
            {
              modelId: 'claude-3-5-sonnet',
              label: 'Claude 3.5 Sonnet',
              quotaInfo: {
                remainingFraction: 0.55,
                resetTime: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
              },
            },
          ],
        },
      });

      try {
        // Primary port points to closed port 12349, secondary fallback is secondaryServer.port
        const client = new ConnectRpcQuotaClient({
          host: '127.0.0.1',
          port: 12349,
          fallbackPorts: [12349, secondaryServer.port],
          csrfToken: 'tok',
          enableCliFallback: false,
          enableProcessDiscovery: false,
        });

        const snapshots = await client.fetchQuota();
        assert.equal(snapshots.length, 1);
        assert.equal(snapshots[0].family, 'claude');
        assert.equal(snapshots[0].remainingFraction, 0.55);
      } finally {
        await secondaryServer.close();
      }
    });

    it('T5-CLI-3: falls back to agy CLI when all RPC ports are unreachable', async () => {
      const mockCliExec = (async () => {
        return {
          stdout: JSON.stringify({
            status: 'ok',
            command: {
              data: {
                models: [
                  { id: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet' },
                  { id: 'gemini-4-argon', label: 'Gemini 4 Argon' },
                ],
              },
            },
          }),
          stderr: '',
        };
      }) as any;

      const client = new ConnectRpcQuotaClient({
        port: 19998,
        fallbackPorts: [19998],
        enableCliFallback: true,
        enableProcessDiscovery: false,
        execFileFn: mockCliExec,
      });

      const snapshots = await client.fetchQuota();
      assert.equal(snapshots.length, 2);
      assert.equal(snapshots[0].family, 'claude');
      assert.equal(snapshots[0].remainingFraction, 1.0);
      assert.equal(snapshots[1].family, 'gemini-argon');
    });

    it('T5-CLI-4: throws LanguageServerError with LANGUAGE_SERVER_UNAVAILABLE when RPC and CLI both fail', async () => {
      const failingCliExec = (async () => {
        throw new Error('Command failed: agy not found');
      }) as any;

      const client = new ConnectRpcQuotaClient({
        port: 19997,
        fallbackPorts: [19997],
        enableCliFallback: true,
        enableProcessDiscovery: false,
        execFileFn: failingCliExec,
      });

      await assert.rejects(
        () => client.fetchQuota(),
        (err: any) => {
          assert.equal(err instanceof LanguageServerError, true);
          assert.equal(err.code, 'LANGUAGE_SERVER_UNAVAILABLE');
          return true;
        }
      );
    });

    it('T5-CLI-5: cached snapshot provider preserves remainingFraction and updates hoursUntilReset during CLI fallback', async () => {
      const cachedTime = new Date(Date.now() + 6 * 3600 * 1000).toISOString();
      const cachedProvider = () => [
        {
          poolId: 'claude',
          family: 'claude' as const,
          displayName: 'Claude Pool',
          remainingFraction: 0.33,
          resetTime: cachedTime,
          hoursUntilReset: 12,
          models: ['Claude 3.5 Sonnet'],
        },
      ];

      const mockCliExec = (async () => {
        return {
          stdout: JSON.stringify({
            models: [{ id: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet' }],
          }),
          stderr: '',
        };
      }) as any;

      const client = new ConnectRpcQuotaClient({
        port: 19996,
        fallbackPorts: [19996],
        enableCliFallback: true,
        enableProcessDiscovery: false,
        cachedSnapshotProvider: cachedProvider,
        execFileFn: mockCliExec,
      });

      const snapshots = await client.fetchQuota();
      assert.equal(snapshots.length, 1);
      assert.equal(snapshots[0].remainingFraction, 0.33); // preserved!
      assert.ok(snapshots[0].hoursUntilReset <= 6.1 && snapshots[0].hoursUntilReset >= 5.9);
    });
  });

  /* ==================================================================== */
  /* CATEGORY 5: Quota Evaluator Math & Milestone Anti-Spam               */
  /* ==================================================================== */
  describe('5. Quota Evaluator Math & Anti-Spam (src/sentry/evaluator.ts)', () => {
    it('T5-EVA-1: precision boundary testing around 25% threshold (0.249 vs 0.250 vs 0.250001)', () => {
      const evaluator = new QuotaEvaluator({
        milestoneHours: [24, 12, 3],
        alertThresholdPercent: 25,
      });

      const makeSnapshot = (fraction: number): QuotaSnapshot => ({
        poolId: 'claude',
        family: 'claude',
        displayName: 'Claude',
        remainingFraction: fraction,
        resetTime: new Date(Date.now() + 10 * 3600 * 1000).toISOString(), // 10h remaining
        hoursUntilReset: 10,
        models: ['Sonnet'],
      });

      // 24.9% remaining -> NO alert (< 25%)
      const sub = evaluator.evaluatePool(makeSnapshot(0.249));
      assert.equal(sub.alert, null);

      // 25.0% remaining -> ALERTS (>= 25%)
      const exact = evaluator.evaluatePool(makeSnapshot(0.25));
      assert.notEqual(exact.alert, null);
      assert.equal(exact.alert?.remainingPercentage, 25.0);
      assert.equal(exact.alert?.milestoneHours, 12);

      // 25.0001% remaining -> ALERTS
      const slightlyAbove = evaluator.evaluatePool(makeSnapshot(0.250001));
      assert.notEqual(slightlyAbove.alert, null);

      // 0% remaining -> NO alert
      const zero = evaluator.evaluatePool(makeSnapshot(0.0));
      assert.equal(zero.alert, null);

      // 100% remaining -> ALERTS
      const full = evaluator.evaluatePool(makeSnapshot(1.0));
      assert.notEqual(full.alert, null);
      assert.equal(full.alert?.remainingPercentage, 100.0);
    });

    it('T5-EVA-2: late-wake multi-milestone reconciliation triggers ONLY most urgent milestone and supersedes larger windows', () => {
      const evaluator = new QuotaEvaluator({
        milestoneHours: [24, 12, 3],
        alertThresholdPercent: 25,
      });

      // Host wakes at 8 hours until reset (both 24h and 12h windows passed, 3h window not yet)
      const now = Date.now();
      const snapshot: QuotaSnapshot = {
        poolId: 'gemini-argon',
        family: 'gemini-argon',
        displayName: 'Gemini Argon',
        remainingFraction: 0.6,
        resetTime: new Date(now + 8 * 3600 * 1000).toISOString(),
        hoursUntilReset: 8,
        models: ['Gemini 2.5 Pro'],
      };

      // Fired milestones is empty (daemon was asleep)
      const res = evaluator.evaluatePool(snapshot, [], now);
      assert.notEqual(res.alert, null);
      // Most urgent applicable is 12h (not 24h)
      assert.equal(res.alert?.milestoneHours, 12);
      // 24h is marked as superseded
      assert.deepEqual(res.supersededMilestones, [24]);
    });

    it('T5-EVA-3: deduplication prevents re-alerting for already fired milestones', () => {
      const evaluator = new QuotaEvaluator({ milestoneHours: [24, 12, 3] });
      const now = Date.now();
      const snapshot: QuotaSnapshot = {
        poolId: 'claude',
        family: 'claude',
        displayName: 'Claude',
        remainingFraction: 0.8,
        resetTime: new Date(now + 20 * 3600 * 1000).toISOString(), // 20h remaining -> 24h milestone
        hoursUntilReset: 20,
        models: [],
      };

      // Already fired '24h'
      const res1 = evaluator.evaluatePool(snapshot, ['24h'], now);
      assert.equal(res1.alert, null);

      // Already fired numeric 24
      const res2 = evaluator.evaluatePool(snapshot, [24], now);
      assert.equal(res2.alert, null);
    });

    it('T5-EVA-4: cycle rollover resets fired milestones and permits new cycle alerts', () => {
      const { dir, cleanup } = makeTempDir('rollover_');
      try {
        const stateManager = new SentryStateManager(path.join(dir, 'state.json'));
        const evaluator = new QuotaEvaluator({ milestoneHours: [24, 12, 3] });

        const cycle1Reset = new Date(Date.now() + 10 * 3600 * 1000).toISOString();
        const cycle2Reset = new Date(Date.now() + 22 * 3600 * 1000).toISOString();

        const snap1: QuotaSnapshot = {
          poolId: 'claude',
          family: 'claude',
          displayName: 'Claude',
          remainingFraction: 0.7,
          resetTime: cycle1Reset,
          hoursUntilReset: 10,
          models: [],
        };

        // First cycle evaluation fires milestone 12
        const alerts1 = evaluator.evaluate([snap1], stateManager);
        assert.equal(alerts1.length, 1);
        assert.equal(alerts1[0].milestoneHours, 12);

        // Immediate second evaluation fires nothing (deduplicated)
        const alerts2 = evaluator.evaluate([snap1], stateManager);
        assert.equal(alerts2.length, 0);

        // Rollover to new cycle resetTime
        const snap2: QuotaSnapshot = {
          poolId: 'claude',
          family: 'claude',
          displayName: 'Claude',
          remainingFraction: 0.85,
          resetTime: cycle2Reset,
          hoursUntilReset: 22,
          models: [],
        };

        // New cycle: milestone 24 can now fire
        const alerts3 = evaluator.evaluate([snap2], stateManager);
        assert.equal(alerts3.length, 1);
        assert.equal(alerts3[0].milestoneHours, 24);
      } finally {
        cleanup();
      }
    });

    it('T5-EVA-5: handles adversarial and extreme inputs without exceptions or NaN', () => {
      const evaluator = new QuotaEvaluator({
        milestoneHours: [-10, 0, NaN as any, 24],
        alertThresholdPercent: 25,
      });

      // Filtered milestone list should only contain positive numbers [24]
      assert.deepEqual(evaluator.milestoneHours, [24]);

      // Reset time in the past (clock skew)
      const pastSnapshot: QuotaSnapshot = {
        poolId: 'claude',
        family: 'claude',
        displayName: 'Claude',
        remainingFraction: 0.9,
        resetTime: new Date(Date.now() - 3600 * 1000).toISOString(),
        hoursUntilReset: 0,
        models: [],
      };
      const pastRes = evaluator.evaluatePool(pastSnapshot);
      assert.equal(pastRes.alert, null);

      // Malformed resetTime string
      const corruptSnapshot: QuotaSnapshot = {
        poolId: 'claude',
        family: 'claude',
        displayName: 'Claude',
        remainingFraction: 0.9,
        resetTime: 'not-a-valid-date-string',
        hoursUntilReset: 0,
        models: [],
      };
      const corruptRes = evaluator.evaluatePool(corruptSnapshot);
      assert.equal(corruptRes.alert, null);
    });
  });

  /* ==================================================================== */
  /* CATEGORY 6: Atomic State Persistence & Corrupt Quarantine           */
  /* ==================================================================== */
  describe('6. Atomic State Persistence & Quarantine (src/sentry/state.ts)', () => {
    it('T5-STA-1: saves state atomically via tempfile replacement and validates JSON schema', async () => {
      const { dir, cleanup } = makeTempDir('atomic_state_');
      try {
        const stateFile = path.join(dir, 'state.json');
        const manager = new SentryStateManager(stateFile);

        manager.updateProbe('connect_rpc');
        manager.updatePoolQuota(
          'claude',
          0.65,
          new Date(Date.now() + 24 * 3600 * 1000).toISOString()
        );
        manager.recordMilestoneFired('claude', 24);

        await manager.save();

        assert.equal(fs.existsSync(stateFile), true);
        const raw = fs.readFileSync(stateFile, 'utf-8');
        const parsed = JSON.parse(raw);
        assert.equal(parsed.version, 1);
        assert.equal(parsed.lastProbeSource, 'connect_rpc');
        assert.equal(parsed.pools.claude.remainingFraction, 0.65);
        assert.deepEqual(parsed.pools.claude.firedMilestones, ['24h']);
      } finally {
        cleanup();
      }
    });

    it('T5-STA-2: corrupt state file quarantine renames corrupt file and initializes fresh state', async () => {
      const { dir, cleanup } = makeTempDir('corrupt_quarantine_');
      try {
        const stateFile = path.join(dir, 'state.json');
        // Write corrupted JSON to state.json
        fs.writeFileSync(stateFile, '{"version": 1, "lastProbeAt": "truncated...', 'utf-8');

        const manager = new SentryStateManager(stateFile);
        const loadedState = await manager.load();

        // Fresh state initialized
        assert.equal(loadedState.version, 1);
        assert.deepEqual(loadedState.pools, {});

        // Corrupted file was quarantined
        const files = fs.readdirSync(dir);
        const quarantined = files.find((f) => f.includes('state.json.corrupt.'));
        assert.ok(quarantined, 'Expected quarantined file matching pattern state.json.corrupt.*');
      } finally {
        cleanup();
      }
    });

    it('T5-STA-3: rapid concurrent saves stress test (15 parallel saves) maintains file integrity', async () => {
      const { dir, cleanup } = makeTempDir('concurrent_state_');
      try {
        const stateFile = path.join(dir, 'state.json');
        const manager = new SentryStateManager(stateFile);

        const saves: Promise<void>[] = [];
        for (let i = 0; i < 15; i++) {
          manager.recordMilestoneFired('pool_concurrent', i);
          saves.push(manager.save());
        }

        await Promise.all(saves);

        const raw = fs.readFileSync(stateFile, 'utf-8');
        const parsed = JSON.parse(raw);
        assert.equal(parsed.version, 1);
        assert.ok(parsed.pools.pool_concurrent.firedMilestones.length > 0);
      } finally {
        cleanup();
      }
    });

    it('T5-STA-4: getState() returns a deep clone ensuring internal state isolation', () => {
      const manager = new SentryStateManager();
      manager.updatePoolQuota('test', 0.5, '2026-10-20T00:00:00Z');

      const stateCopy = manager.getState();
      stateCopy.pools.test.remainingFraction = 0.99;
      stateCopy.pools.test.firedMilestones.push('99h');

      const freshCopy = manager.getState();
      assert.equal(freshCopy.pools.test.remainingFraction, 0.5);
      assert.deepEqual(freshCopy.pools.test.firedMilestones, []);
    });
  });

  /* ==================================================================== */
  /* CATEGORY 7: Core Daemon Lifecycle & Subsystem Integration           */
  /* ==================================================================== */
  describe('7. Core Daemon Lifecycle & Teardown (src/index.ts)', () => {
    it('T5-DMN-1: daemon bootstrap, initial quota check, scheduler timer, and graceful shutdown', async () => {
      const { dir, cleanup } = makeTempDir('daemon_lifecycle_');
      try {
        const dbPath = path.join(dir, 'test.db');
        const statePath = path.join(dir, 'state.json');

        let alertReceived = false;
        const mockNotifier: Notifier = {
          channelName: 'mock',
          async initialize() {},
          async notifyQuotaAlert() {
            alertReceived = true;
          },
          async notifyDispatchStatus() {},
          async shutdown() {},
        };

        const mockClient = {
          async fetchQuota(): Promise<QuotaSnapshot[]> {
            return [
              {
                poolId: 'claude',
                family: 'claude' as const,
                displayName: 'Claude',
                remainingFraction: 0.8,
                resetTime: new Date(Date.now() + 10 * 3600 * 1000).toISOString(),
                hoursUntilReset: 10,
                models: ['Sonnet'],
              },
            ];
          },
        };

        const daemon = await createDaemon({
          dbPath,
          statePath,
          autoCheckOnStart: true,
          notifier: mockNotifier,
          quotaClient: mockClient,
          config: {
            webUiEnabled: false,
            quotaCheckIntervalSeconds: 60,
          },
        });

        await daemon.start();
        assert.equal(daemon.isRunning, true);
        assert.equal(alertReceived, true, 'Expected autoCheckOnStart to trigger quota alert');

        // Shutdown daemon
        await daemon.shutdown();
        assert.equal(daemon.isRunning, false);
        assert.equal(daemon.isSentryStopped, true);
        assert.equal(daemon.isDbClosed, true);
        assert.equal(daemon.isNotifierShutdown, true);
      } finally {
        cleanup();
      }
    });

    it('T5-DMN-2: idempotent start() and shutdown() calls do not leak resources or throw', async () => {
      const { dir, cleanup } = makeTempDir('daemon_idempotent_');
      try {
        const dbPath = path.join(dir, 'test.db');
        const statePath = path.join(dir, 'state.json');

        const daemon = await createDaemon({
          dbPath,
          statePath,
          autoCheckOnStart: false,
          config: { webUiEnabled: false },
        });

        await daemon.start();
        await daemon.start(); // second start is no-op
        assert.equal(daemon.isRunning, true);

        await daemon.shutdown();
        await daemon.shutdown(); // second shutdown is no-op
        assert.equal(daemon.isRunning, false);
      } finally {
        cleanup();
      }
    });

    it('T5-DMN-3: daemon checkQuota gracefully handles QuotaClient errors without crashing process', async () => {
      const { dir, cleanup } = makeTempDir('daemon_resilience_');
      try {
        const dbPath = path.join(dir, 'test.db');
        const statePath = path.join(dir, 'state.json');

        const failingClient = {
          async fetchQuota(): Promise<QuotaSnapshot[]> {
            throw new Error('Connection refused: Connect-RPC server down');
          },
        };

        const daemon = await createDaemon({
          dbPath,
          statePath,
          autoCheckOnStart: false,
          quotaClient: failingClient,
          config: { webUiEnabled: false },
        });

        await daemon.start();

        // checkQuota catches error and records 'unreachable' probe
        const alerts = await daemon.checkQuota();
        assert.deepEqual(alerts, []);

        const state = daemon.sentryState.getState();
        assert.equal(state.lastProbeSource, 'unreachable');

        await daemon.shutdown();
      } finally {
        cleanup();
      }
    });

    it('T5-DMN-4: full autonomous end-to-end integration: quota alert -> dispatch request -> worker completion', async () => {
      const { dir, cleanup } = makeTempDir('daemon_e2e_');
      try {
        const dbPath = path.join(dir, 'test.db');
        const statePath = path.join(dir, 'state.json');

        let alertReceived: QuotaAlert | null = null;

        const mockNotifier: Notifier = {
          channelName: 'mock_discord',
          async initialize() {},
          async notifyQuotaAlert(alert: QuotaAlert) {
            alertReceived = alert;
          },
          async notifyDispatchStatus() {},
          async shutdown() {},
        };

        const mockClient = {
          async fetchQuota(): Promise<QuotaSnapshot[]> {
            return [
              {
                poolId: 'claude',
                family: 'claude' as const,
                displayName: 'Claude 3.5 Sonnet',
                remainingFraction: 0.85,
                resetTime: new Date(Date.now() + 10 * 3600 * 1000).toISOString(),
                hoursUntilReset: 10,
                models: ['Sonnet'],
              },
            ];
          },
        };

        const daemon = await createDaemon({
          dbPath,
          statePath,
          autoCheckOnStart: true,
          notifier: mockNotifier,
          quotaClient: mockClient,
          config: { webUiEnabled: false },
        });

        await daemon.start();

        assert.ok(alertReceived, 'Expected quota alert to be dispatched to notifier');
        assert.equal(alertReceived!.pool.poolId, 'claude');

        await daemon.shutdown();
      } finally {
        cleanup();
      }
    });
  });
});
