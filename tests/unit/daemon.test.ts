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
import { buildInfoNoticeEmbed } from '../../src/notify/embeds/index.js';
import type { QuotaAlert, DeliveryOutcome, InfoNotice } from '../../src/notify/types.js';
import type { QuotaSnapshot } from '../../src/sentry/models.js';
import { logger } from '../../src/logs/logger.js';
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
        override async notifyQuotaAlert(alert: QuotaAlert): Promise<DeliveryOutcome> {
          notifiedAlerts.push(alert);
          return { delivered: true, results: {} };
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
          quotaMilestoneHours: [48, 24, 12],
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

  it('applies the configured logLevel to the root logger so unrelated namespaces inherit it', async () => {
    const { dir, cleanup } = makeTempDir('daemon_loglevel_');
    const dbPath = path.join(dir, 'test.db');
    const statePath = path.join(dir, 'state.json');

    const daemon = await createDaemon({
      dbPath,
      statePath,
      autoCheckOnStart: false,
      config: {
        webUiEnabled: false,
        logLevel: 'debug',
      },
    });

    // Subsystems (notify, coordinator) build loggers from the root singleton, not the daemon child.
    assert.equal(logger.child('notify:webhook').getLevel(), 'debug');
    assert.equal(daemon.logger.getLevel(), 'debug');

    await daemon.shutdown();
    cleanup();
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

    it('dynamically reschedules sentry timer when quotaCheckIntervalSeconds override changes', async () => {
      const { dir, cleanup } = makeTempDir('daemon_resched_');
      const dbPath = path.join(dir, 'test.db');
      const statePath = path.join(dir, 'state.json');

      const daemon = await startDaemon({
        dbPath,
        statePath,
        autoCheckOnStart: false,
        config: {
          webUiEnabled: false,
          quotaCheckIntervalSeconds: 120,
        },
      });

      assert.equal(daemon.isRunning, true);
      const timerBefore = (daemon as any).timer;
      assert.ok(timerBefore);

      // Mutate interval override to 45 seconds
      daemon.configStore.setOverride('quotaCheckIntervalSeconds', 45);
      await new Promise((r) => setTimeout(r, 50));
      const timerAfter = (daemon as any).timer;
      assert.ok(timerAfter);
      assert.notEqual(timerBefore, timerAfter);

      await daemon.shutdown();
      cleanup();
    });
  });

  /* ==================================================================== */
  /* 5. Premature Quota Reset Detection                                   */
  /* ==================================================================== */
  describe('Premature quota reset detection', () => {
    it('notifies once and records the notice when a used pool refills before its deadline', async () => {
      const { dir, cleanup } = makeTempDir('daemon_early_reset_');
      const dbPath = path.join(dir, 'test.db');
      const statePath = path.join(dir, 'state.json');

      const now = Date.now();
      const resetTime = new Date(now + 100 * 3600 * 1000).toISOString();

      // Prior usage on the same deadline: 25% left with 100h still to go.
      const sentryState = new SentryStateManager(statePath);
      sentryState.setState({
        version: 1,
        lastProbeAt: new Date(now).toISOString(),
        lastProbeSource: 'connect_rpc',
        pools: {
          claude: {
            resetTime,
            remainingFraction: 0.25,
            firedMilestones: ['48h', '24h', '12h'],
            lastAlertSentAt: null,
          },
        },
      });

      const notices: InfoNotice[] = [];
      const alerts: QuotaAlert[] = [];
      class RecordingNotifier extends ConsoleNotifier {
        override async notifyInfo(notice: InfoNotice): Promise<void> {
          notices.push(notice);
        }
        override async notifyQuotaAlert(alert: QuotaAlert): Promise<DeliveryOutcome> {
          alerts.push(alert);
          return { delivered: true, results: {} };
        }
      }

      const mockClient = {
        async fetchQuota(): Promise<QuotaSnapshot[]> {
          return [
            {
              poolId: 'claude',
              family: 'claude' as const,
              displayName: 'Claude Pool',
              remainingFraction: 0.98,
              resetTime,
              hoursUntilReset: 100,
              models: ['claude-3-5-sonnet'],
            },
          ];
        },
      };

      const daemon = await createDaemon({
        dbPath,
        statePath,
        quotaClient: mockClient,
        notifier: new RecordingNotifier(),
        sentryState,
        autoCheckOnStart: false,
        config: {
          quotaMilestoneHours: [48, 24, 12],
          quotaAlertThresholdPercent: 25,
          webUiEnabled: false,
        },
      });

      try {
        await daemon.checkQuota();

        assert.equal(alerts.length, 0);
        assert.equal(notices.length, 1);
        assert.equal(notices[0]?.title, 'Quota reset early');
        assert.match(notices[0]?.message ?? '', /Claude Pool/);

        const notice = daemon.sentryState.getState().earlyResetNotice;
        assert.ok(notice);
        assert.equal(notice.pools.length, 1);
        assert.equal(notice.pools[0]?.poolId, 'claude');
        assert.equal(notice.pools[0]?.displayName, 'Claude Pool');
        assert.equal(notice.pools[0]?.previousRemainingFraction, 0.25);
        assert.equal(notice.pools[0]?.remainingFraction, 0.98);
        assert.equal(notice.pools[0]?.previousResetTime, resetTime);
        assert.equal(notice.pools[0]?.resetTime, resetTime);
      } finally {
        await daemon.shutdown();
        cleanup();
      }
    });

    it('ignores a never-used pool whose reset time merely floats forward', async () => {
      const { dir, cleanup } = makeTempDir('daemon_early_reset_unused_');
      const dbPath = path.join(dir, 'test.db');
      const statePath = path.join(dir, 'state.json');

      const now = Date.now();
      const previousResetTime = new Date(now + 100 * 3600 * 1000).toISOString();
      const floatedResetTime = new Date(now + 101 * 3600 * 1000).toISOString();

      // Untouched pool: full headroom, so the shifted deadline is a scheduling artefact.
      const sentryState = new SentryStateManager(statePath);
      sentryState.setState({
        version: 1,
        lastProbeAt: new Date(now).toISOString(),
        lastProbeSource: 'connect_rpc',
        pools: {
          claude: {
            resetTime: previousResetTime,
            remainingFraction: 1,
            firedMilestones: [],
            lastAlertSentAt: null,
          },
        },
      });

      const notices: InfoNotice[] = [];
      class RecordingNotifier extends ConsoleNotifier {
        override async notifyInfo(notice: InfoNotice): Promise<void> {
          notices.push(notice);
        }
      }

      const mockClient = {
        async fetchQuota(): Promise<QuotaSnapshot[]> {
          return [
            {
              poolId: 'claude',
              family: 'claude' as const,
              displayName: 'Claude Pool',
              remainingFraction: 1,
              resetTime: floatedResetTime,
              hoursUntilReset: 101,
              models: ['claude-3-5-sonnet'],
            },
          ];
        },
      };

      const daemon = await createDaemon({
        dbPath,
        statePath,
        quotaClient: mockClient,
        notifier: new RecordingNotifier(),
        sentryState,
        autoCheckOnStart: false,
        config: {
          quotaMilestoneHours: [48, 24, 12],
          quotaAlertThresholdPercent: 25,
          webUiEnabled: false,
        },
      });

      try {
        await daemon.checkQuota();

        assert.equal(notices.length, 0);
        assert.equal(daemon.sentryState.getState().earlyResetNotice, undefined);
        assert.equal(daemon.sentryState.getState().pools['claude']?.resetTime, floatedResetTime);
      } finally {
        await daemon.shutdown();
        cleanup();
      }
    });

    it('routes the early-reset notice to /overview and fires it before the quota update', async () => {
      const { dir, cleanup } = makeTempDir('daemon_early_reset_order_');
      const dbPath = path.join(dir, 'test.db');
      const statePath = path.join(dir, 'state.json');

      const now = Date.now();
      const resetTime = new Date(now + 100 * 3600 * 1000).toISOString();

      // Same refill shape as above: 25% left on a deadline 100h out, then 98% on the same deadline.
      const sentryState = new SentryStateManager(statePath);
      sentryState.setState({
        version: 1,
        lastProbeAt: new Date(now).toISOString(),
        lastProbeSource: 'connect_rpc',
        pools: {
          claude: {
            resetTime,
            remainingFraction: 0.25,
            firedMilestones: ['48h', '24h', '12h'],
            lastAlertSentAt: null,
          },
        },
      });

      const notices: InfoNotice[] = [];
      class RecordingNotifier extends ConsoleNotifier {
        override async notifyInfo(notice: InfoNotice): Promise<void> {
          notices.push(notice);
        }
      }

      const mockClient = {
        async fetchQuota(): Promise<QuotaSnapshot[]> {
          return [
            {
              poolId: 'claude',
              family: 'claude' as const,
              displayName: 'Claude Pool',
              remainingFraction: 0.98,
              resetTime,
              hoursUntilReset: 100,
              models: ['claude-3-5-sonnet'],
            },
          ];
        },
      };

      const daemon = await createDaemon({
        dbPath,
        statePath,
        quotaClient: mockClient,
        notifier: new RecordingNotifier(),
        sentryState,
        autoCheckOnStart: false,
        config: {
          quotaMilestoneHours: [48, 24, 12],
          quotaAlertThresholdPercent: 25,
          webUiEnabled: false,
        },
      });

      try {
        // Pins the documented ordering: the early-reset hook must run BEFORE onQuotaUpdated swaps the
        // quota view, because the hook re-arms routines keyed on the reset time the new snapshot no longer carries.
        const callOrder: string[] = [];
        const coordinator = daemon.coordinator;
        const earlyResetHook = coordinator.onEarlyQuotaReset.bind(coordinator);
        const quotaUpdatedHook = coordinator.onQuotaUpdated.bind(coordinator);
        coordinator.onEarlyQuotaReset = (pools) => {
          callOrder.push('onEarlyQuotaReset');
          earlyResetHook(pools);
        };
        coordinator.onQuotaUpdated = (snapshots) => {
          callOrder.push('onQuotaUpdated');
          quotaUpdatedHook(snapshots);
        };

        await daemon.checkQuota();

        assert.equal(notices.length, 1);
        const notice = notices[0];
        assert.ok(notice);
        assert.equal(notice.path, '/overview');
        // The path is what routes the Discord/webhook embed to the dashboard overview.
        assert.equal(
          buildInfoNoticeEmbed(notice, { baseUrl: 'https://agylity.example.com' }).url,
          'https://agylity.example.com/overview'
        );
        assert.deepEqual(callOrder, ['onEarlyQuotaReset', 'onQuotaUpdated']);
      } finally {
        await daemon.shutdown();
        cleanup();
      }
    });
  });
});
