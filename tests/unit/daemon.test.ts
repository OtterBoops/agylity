import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { makeTempDir } from '../e2e/harness/index.js';
import { ConfigStore } from '../../src/config/store.js';
import { SentryStateManager } from '../../src/sentry/state.js';
import { QuotaEvaluator } from '../../src/sentry/evaluator.js';
import { ConnectRpcQuotaClient } from '../../src/sentry/client.js';
import { ConsoleNotifier } from '../../src/notify/adapters/console.js';
import type { Notifier, QuotaAlert, DispatchStatusUpdate } from '../../src/notify/types.js';
import type { QuotaSnapshot } from '../../src/sentry/models.js';
import { AgylityDaemon, createDaemon, startDaemon, stopDaemon } from '../../src/index.js';

describe('Unit Tests: Daemon Lifecycle & Packaging (Milestone 6)', () => {
  /* ==================================================================== */
  /* 1. Subsystem Instantiation & Wiring                                   */
  /* ==================================================================== */
  describe('1. Subsystem Instantiation & Wiring', () => {
    it('instantiates all subsystems cleanly via createDaemon() with custom options', async () => {
      const { dir, cleanup } = makeTempDir('daemon_init_');
      const dbPath = path.join(dir, 'test.db');
      const statePath = path.join(dir, 'state.json');

      const daemon = await createDaemon({
        dbPath,
        statePath,
        autoCheckOnStart: false,
        config: {
          webUiEnabled: false,
          quotaCheckIntervalSeconds: 60,
        },
      });

      assert.ok(daemon instanceof AgylityDaemon);
      assert.ok(daemon.configStore instanceof ConfigStore);
      assert.ok(daemon.sentryState instanceof SentryStateManager);
      assert.ok(daemon.sentryEvaluator instanceof QuotaEvaluator);
      assert.ok(daemon.quotaClient instanceof ConnectRpcQuotaClient);
      assert.ok(daemon.notifier);
      assert.equal(daemon.isRunning, false);
      assert.equal(daemon.webServer, undefined);

      await daemon.shutdown();
      cleanup();
    });

    it('respects configuration fallback precedence in daemon store', async () => {
      const { dir, cleanup } = makeTempDir('daemon_cfg_');
      const dbPath = path.join(dir, 'test.db');
      const statePath = path.join(dir, 'state.json');

      const daemon = await createDaemon({
        dbPath,
        statePath,
        autoCheckOnStart: false,
        config: {
          quotaAlertThresholdPercent: 35,
        },
      });

      const resolved = daemon.configStore.resolveConfig();
      assert.equal(resolved.quotaAlertThresholdPercent, 35);

      await daemon.shutdown();
      cleanup();
    });
  });

  /* ==================================================================== */
  /* 2. Startup Lifecycle & Quota Evaluation                              */
  /* ==================================================================== */
  describe('2. Startup Lifecycle & Quota Evaluation', () => {
    it('initializes notifier, loads state, and triggers initial quota check on start()', async () => {
      const { dir, cleanup } = makeTempDir('daemon_start_');
      const dbPath = path.join(dir, 'test.db');
      const statePath = path.join(dir, 'state.json');

      const notifiedAlerts: QuotaAlert[] = [];
      class MockNotifier extends ConsoleNotifier {
        override async notifyQuotaAlert(alert: QuotaAlert): Promise<void> {
          notifiedAlerts.push(alert);
        }
      }

      const mockNotifier = new MockNotifier();

      // Mock quota client returning snapshot crossing 12h milestone with 60% headroom
      const now = Date.now();
      const mockClient = {
        async fetchQuota(): Promise<QuotaSnapshot[]> {
          return [
            {
              poolId: 'claude',
              family: 'claude' as const,
              displayName: 'Claude 3.5 Sonnet',
              remainingFraction: 0.6,
              resetTime: new Date(now + 10 * 3600 * 1000).toISOString(), // 10h remaining <= 12h milestone
              hoursUntilReset: 10,
              models: ['claude-3-5-sonnet'],
            },
          ];
        },
      };

      const daemon = await createDaemon({
        dbPath,
        statePath,
        quotaClient: mockClient,
        notifier: mockNotifier,
        autoCheckOnStart: true,
        config: {
          quotaMilestoneHours: [24, 12, 3],
          quotaAlertThresholdPercent: 25,
          webUiEnabled: false,
        },
      });

      await daemon.start();
      assert.equal(daemon.isRunning, true);
      assert.equal(mockNotifier.initialized, true);
      assert.equal(notifiedAlerts.length, 1);
      assert.equal(notifiedAlerts[0]?.pool.poolId, 'claude');
      assert.equal(notifiedAlerts[0]?.milestoneHours, 12);

      await daemon.shutdown();
      cleanup();
    });

    it('handles quota client errors gracefully without crashing or throwing', async () => {
      const { dir, cleanup } = makeTempDir('daemon_err_');
      const dbPath = path.join(dir, 'test.db');
      const statePath = path.join(dir, 'state.json');

      const failingClient = new ConnectRpcQuotaClient({
        fetchFn: async () => {
          throw new Error('Connect-RPC connection reset by peer');
        },
        enableCliFallback: false,
        enableProcessDiscovery: false,
      });

      const daemon = await createDaemon({
        dbPath,
        statePath,
        quotaClient: failingClient,
        autoCheckOnStart: true,
      });

      // Starting with a failing quota probe should not throw
      await daemon.start();
      assert.equal(daemon.isRunning, true);

      // Verify probe state recorded as unreachable
      const state = daemon.sentryState.getState();
      assert.equal(state.lastProbeSource, 'unreachable');

      await daemon.shutdown();
      cleanup();
    });
  });

  /* ==================================================================== */
  /* 3. Decoupled Web UI Lifecycle                                        */
  /* ==================================================================== */
  describe('3. Decoupled Web UI Lifecycle Integration', () => {
    it('spawns web server when webUiEnabled is true and binds ephemeral port', async () => {
      const { dir, cleanup } = makeTempDir('daemon_web_on_');
      const dbPath = path.join(dir, 'test.db');
      const statePath = path.join(dir, 'state.json');

      const daemon = await createDaemon({
        dbPath,
        statePath,
        autoCheckOnStart: false,
        config: {
          webUiEnabled: true,
          webUiPort: 0,
          webUiHost: '127.0.0.1',
        },
      });

      await daemon.start();
      assert.ok(daemon.webServer instanceof http.Server);
      const addr = daemon.webServer.address() as net.AddressInfo;
      assert.ok(addr.port > 0);

      await daemon.shutdown();
      assert.equal(daemon.webServer, undefined);
      cleanup();
    });

    it('leaves webServer undefined when webUiEnabled is false (Zero-Overhead)', async () => {
      const { dir, cleanup } = makeTempDir('daemon_web_off_');
      const dbPath = path.join(dir, 'test.db');
      const statePath = path.join(dir, 'state.json');

      const daemon = await createDaemon({
        dbPath,
        statePath,
        autoCheckOnStart: false,
        config: {
          webUiEnabled: false,
        },
      });

      await daemon.start();
      assert.equal(daemon.webServer, undefined);

      await daemon.shutdown();
      cleanup();
    });
  });

  /* ==================================================================== */
  /* 4. Graceful Teardown & Idempotency                                   */
  /* ==================================================================== */
  describe('4. Graceful Teardown & Idempotency', () => {
    it('shuts down all subsystems in strict graceful sequence', async () => {
      const { dir, cleanup } = makeTempDir('daemon_shutdown_');
      const dbPath = path.join(dir, 'test.db');
      const statePath = path.join(dir, 'state.json');

      let notifierShutdownCalled = false;
      class TrackedNotifier extends ConsoleNotifier {
        override async shutdown(): Promise<void> {
          notifierShutdownCalled = true;
          await super.shutdown?.();
        }
      }

      const trackedNotifier = new TrackedNotifier();

      const daemon = await startDaemon({
        dbPath,
        statePath,
        notifier: trackedNotifier,
        autoCheckOnStart: false,
        config: {
          webUiEnabled: false,
          quotaCheckIntervalSeconds: 300,
        },
      });

      assert.equal(daemon.isRunning, true);

      // Execute shutdown
      await stopDaemon(daemon);

      assert.equal(daemon.isRunning, false);
      assert.equal(daemon.isSentryStopped, true);
      assert.equal(daemon.isNotifierShutdown, true);
      assert.equal(notifierShutdownCalled, true);
      assert.equal(daemon.isDbClosed, true);

      cleanup();
    });

    it('handles idempotent shutdown() without errors or double-close exceptions', async () => {
      const { dir, cleanup } = makeTempDir('daemon_idempotent_');
      const dbPath = path.join(dir, 'test.db');
      const statePath = path.join(dir, 'state.json');

      const daemon = await startDaemon({
        dbPath,
        statePath,
        autoCheckOnStart: false,
        config: {
          webUiEnabled: false,
        },
      });

      // Call shutdown 3 times consecutively
      await daemon.shutdown();
      await daemon.shutdown();
      await daemon.shutdown();

      assert.equal(daemon.isRunning, false);
      assert.equal(daemon.isDbClosed, true);

      cleanup();
    });
  });
});
