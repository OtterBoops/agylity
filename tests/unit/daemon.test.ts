import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { createMemorySink, makeTempDir } from '../e2e/harness/index.js';
import { SentryStateManager, type EarlyResetPool } from '../../src/sentry/state.js';
import { ConnectRpcQuotaClient } from '../../src/sentry/client.js';
import { ConsoleNotifier } from '../../src/notify/adapters/console.js';
import { buildInfoNoticeEmbed } from '../../src/notify/embeds/index.js';
import type { QuotaAlert, DeliveryOutcome, InfoNotice } from '../../src/notify/types.js';
import type { QuotaSnapshot } from '../../src/sentry/models.js';
import { createLogger, logger, type Logger } from '../../src/logs/logger.js';
import { createDaemon, startDaemon, stopDaemon } from '../../src/index.js';

describe('Unit Tests: Daemon Lifecycle & Packaging (Milestone 6)', () => {
  /* ==================================================================== */
  /* 1. Subsystem Instantiation & Wiring                                   */
  /* ==================================================================== */
  describe('1. Subsystem Instantiation & Wiring', () => {
    it('applies explicit createDaemon() options to the config the subsystems read', async () => {
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

      // The declared types already guarantee the wiring; what matters is that the explicit
      // options reached the store every subsystem resolves from.
      const resolved = daemon.configStore.resolveConfig();
      assert.equal(resolved.quotaCheckIntervalSeconds, 60);
      assert.equal(resolved.webUiEnabled, false);

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

      const memory = createMemorySink();
      const detach = logger.addSink(memory.sink);

      try {
        assert.equal(daemon.isRunning, true);

        // Mutate interval override to 45 seconds
        daemon.configStore.setOverride('quotaCheckIntervalSeconds', 45);
        await new Promise((r) => setTimeout(r, 50));

        assert.equal(daemon.configStore.resolveConfig().quotaCheckIntervalSeconds, 45);
        assert.ok(
          memory.records.some((record) =>
            record.formatted.includes('Rescheduling quota sentry timer to 45s interval')
          ),
          'a live interval override must re-arm the running sentry timer without a restart'
        );
      } finally {
        detach();
        await daemon.shutdown();
        cleanup();
      }
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

    it('emits one early-reset notice when upstream flaps back and forth on the same cycle', async () => {
      const { dir, cleanup } = makeTempDir('daemon_early_reset_flap_');
      const dbPath = path.join(dir, 'test.db');
      const statePath = path.join(dir, 'state.json');

      const now = Date.now();
      const resetTime = new Date(now + 100 * 3600 * 1000).toISOString();

      const sentryState = new SentryStateManager(statePath);
      sentryState.setState({
        version: 1,
        lastProbeAt: new Date(now).toISOString(),
        lastProbeSource: 'connect_rpc',
        pools: {
          claude: {
            resetTime,
            remainingFraction: 0.43,
            firedMilestones: ['48h', '24h', '12h'],
            lastAlertSentAt: null,
          },
        },
      });

      let remainingFraction = 1;
      const notices: InfoNotice[] = [];
      class RecordingNotifier extends ConsoleNotifier {
        override async notifyInfo(notice: InfoNotice): Promise<void> {
          notices.push(notice);
        }
      }

      const daemon = await createDaemon({
        dbPath,
        statePath,
        sentryState,
        quotaClient: {
          async fetchQuota(): Promise<QuotaSnapshot[]> {
            return [
              {
                poolId: 'claude',
                family: 'claude' as const,
                displayName: 'Claude Pool',
                remainingFraction,
                resetTime,
                hoursUntilReset: 100,
                models: ['claude-3-5-sonnet'],
              },
            ];
          },
        },
        notifier: new RecordingNotifier(),
        autoCheckOnStart: false,
        config: {
          quotaMilestoneHours: [48, 24, 12],
          quotaAlertThresholdPercent: 25,
          webUiEnabled: false,
        },
      });

      const hookCalls: EarlyResetPool[][] = [];
      const coordinator = daemon.coordinator;
      const earlyResetHook = coordinator.onEarlyQuotaReset.bind(coordinator);
      coordinator.onEarlyQuotaReset = (pools) => {
        hookCalls.push(pools);
        earlyResetHook(pools);
      };

      try {
        // 0.43 -> 1.0 -> 0.43 -> 1.0 on one deadline: the refill flaps, the cycle does not change.
        for (const next of [1, 0.43, 1]) {
          remainingFraction = next;
          await daemon.checkQuota();
        }

        assert.equal(notices.length, 1);
        assert.equal(hookCalls.length, 1);

        const events = daemon.sentryState.listAlertEvents().events;
        assert.equal(events.length, 1);
        assert.equal(events[0]?.kind, 'early_reset');
        assert.equal(events[0]?.resetTime, resetTime);
        assert.equal(daemon.sentryState.getState().earlyResetNotice?.pools.length, 1);
      } finally {
        await daemon.shutdown();
        sentryState.close();
        cleanup();
      }
    });

    it('skips pools whose early-reset cycle alert was already recorded', async () => {
      const { dir, cleanup } = makeTempDir('daemon_early_reset_recorded_');
      const dbPath = path.join(dir, 'test.db');

      const now = Date.now();
      const resetTime = new Date(now + 100 * 3600 * 1000).toISOString();
      const previousResetTime = new Date(now + 40 * 3600 * 1000).toISOString();

      const notices: InfoNotice[] = [];
      class RecordingNotifier extends ConsoleNotifier {
        override async notifyInfo(notice: InfoNotice): Promise<void> {
          notices.push(notice);
        }
      }

      const daemon = await createDaemon({
        dbPath,
        statePath: path.join(dir, 'state.json'),
        notifier: new RecordingNotifier(),
        autoCheckOnStart: false,
        config: { webUiEnabled: false },
      });

      const recordedPool: EarlyResetPool = {
        poolId: 'claude',
        displayName: 'Claude Pool',
        previousRemainingFraction: 0.43,
        remainingFraction: 1,
        previousResetTime,
        resetTime,
      };
      const freshPool: EarlyResetPool = {
        poolId: 'gemini',
        displayName: 'Gemini Pool',
        previousRemainingFraction: 0.3,
        remainingFraction: 1,
        previousResetTime,
        resetTime,
      };
      const announce = (daemon as any).announceEarlyReset as (
        pools: EarlyResetPool[]
      ) => Promise<void>;

      try {
        await announce.call(daemon, [recordedPool]);
        assert.equal(notices.length, 1);
        assert.match(notices[0]?.message ?? '', /Claude Pool/);

        // Same cycle again: nothing new to announce, and the stored notice is left untouched.
        await announce.call(daemon, [recordedPool]);
        assert.equal(notices.length, 1);
        assert.equal(daemon.sentryState.listAlertEvents().events.length, 1);

        // A batch carrying one already-recorded pool announces only the fresh one.
        await announce.call(daemon, [recordedPool, freshPool]);
        assert.equal(notices.length, 2);
        assert.match(notices[1]?.message ?? '', /Gemini Pool/);
        assert.doesNotMatch(notices[1]?.message ?? '', /Claude Pool/);
        assert.deepEqual(
          daemon.sentryState.getState().earlyResetNotice?.pools.map((pool) => pool.poolId),
          ['gemini']
        );
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

  /* ==================================================================== */
  /* 6. Delivered-Alert Ledger                                            */
  /* ==================================================================== */
  describe('Delivered-alert ledger', () => {
    const poolingSnapshot = (resetTime: string): QuotaSnapshot[] => [
      {
        poolId: 'claude',
        family: 'claude' as const,
        displayName: 'Claude Pool',
        remainingFraction: 0.6,
        resetTime,
        hoursUntilReset: 10,
        models: ['claude-3-5-sonnet'],
      },
    ];

    class ToggleNotifier extends ConsoleNotifier {
      public delivered = true;
      public calls = 0;
      override async notifyQuotaAlert(_alert: QuotaAlert): Promise<DeliveryOutcome> {
        this.calls++;
        return this.delivered
          ? { delivered: true, results: { console: { success: true } } }
          : { delivered: false, results: { console: { success: false, error: 'channel down' } } };
      }
    }

    it('records a delivered milestone in both alert_events and pool_milestones', async () => {
      const { dir, cleanup } = makeTempDir('daemon_ledger_ok_');
      const dbPath = path.join(dir, 'test.db');
      const notifier = new ToggleNotifier();
      const resetTime = new Date(Date.now() + 10 * 3600 * 1000).toISOString();

      const daemon = await createDaemon({
        dbPath,
        quotaClient: {
          async fetchQuota() {
            return poolingSnapshot(resetTime);
          },
        },
        notifier,
        autoCheckOnStart: false,
        config: {
          quotaMilestoneHours: [48, 24, 12],
          quotaAlertThresholdPercent: 25,
          webUiEnabled: false,
        },
      });

      try {
        const alerts = await daemon.checkQuota();
        assert.equal(alerts.length, 1);
        assert.equal(daemon.sentryState.isMilestoneFired('claude', 12), true);

        const events = daemon.sentryState.listAlertEvents().events;
        assert.equal(events.length, 1);
        assert.equal(events[0]?.kind, 'milestone');
        assert.equal(events[0]?.milestoneHours, 12);
        assert.equal(events[0]?.resetTime, resetTime);
        assert.equal(events[0]?.headroomPercent, 60);
        assert.deepEqual(events[0]?.channels, { console: { success: true } });

        // The dedupe row is written by the same transaction as the event; the two superseded
        // windows are recorded like fired ones, exactly as the legacy state file did.
        const milestoneRows = daemon.database
          .getRawDb()
          .prepare('SELECT * FROM pool_milestones WHERE pool_id = ? ORDER BY milestone_hours ASC')
          .all('claude') as Array<Record<string, any>>;
        assert.deepEqual(
          milestoneRows.map((row) => Number(row.milestone_hours)),
          [12, 24, 48]
        );
        assert.equal(String(milestoneRows[0]?.reset_time), resetTime);
      } finally {
        await daemon.shutdown();
        cleanup();
      }
    });

    it('writes neither row for a failed delivery and re-fires it on the next probe', async () => {
      const { dir, cleanup } = makeTempDir('daemon_ledger_fail_');
      const dbPath = path.join(dir, 'test.db');
      const notifier = new ToggleNotifier();
      notifier.delivered = false;
      const resetTime = new Date(Date.now() + 10 * 3600 * 1000).toISOString();

      const daemon = await createDaemon({
        dbPath,
        quotaClient: {
          async fetchQuota() {
            return poolingSnapshot(resetTime);
          },
        },
        notifier,
        autoCheckOnStart: false,
        config: {
          quotaMilestoneHours: [48, 24, 12],
          quotaAlertThresholdPercent: 25,
          webUiEnabled: false,
        },
      });

      try {
        const first = await daemon.checkQuota();
        assert.equal(first.length, 1);
        // Nothing recorded, so the milestone is still armed for the retry.
        assert.equal(daemon.sentryState.isMilestoneFired('claude', 12), false);
        assert.equal(daemon.sentryState.listAlertEvents().events.length, 0);
        assert.equal(
          (
            daemon.database
              .getRawDb()
              .prepare('SELECT COUNT(*) AS c FROM pool_milestones')
              .get() as { c?: number }
          ).c,
          0
        );

        notifier.delivered = true;
        const second = await daemon.checkQuota();
        assert.equal(second.length, 1, 'the undelivered milestone must fire again');
        assert.equal(second[0]?.milestoneHours, 12);
        assert.equal(daemon.sentryState.isMilestoneFired('claude', 12), true);
        assert.equal(daemon.sentryState.listAlertEvents().events.length, 1);

        // A third probe is a no-op: the delivered milestone is now deduplicated.
        const third = await daemon.checkQuota();
        assert.equal(third.length, 0);
        assert.equal(notifier.calls, 2);
      } finally {
        await daemon.shutdown();
        cleanup();
      }
    });

    it('records one early_reset event per pool, keyed on the previous deadline', async () => {
      const { dir, cleanup } = makeTempDir('daemon_ledger_early_');
      const dbPath = path.join(dir, 'test.db');
      const now = Date.now();
      const resetTime = new Date(now + 100 * 3600 * 1000).toISOString();

      const sentryState = new SentryStateManager(path.join(dir, 'state.json'));
      sentryState.setState({
        version: 1,
        lastProbeAt: new Date(now).toISOString(),
        lastProbeSource: 'connect_rpc',
        pools: {
          claude: {
            resetTime,
            remainingFraction: 0.25,
            firedMilestones: [],
            lastAlertSentAt: null,
          },
        },
      });

      const daemon = await createDaemon({
        dbPath,
        sentryState,
        quotaClient: {
          async fetchQuota() {
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
        },
        notifier: new ToggleNotifier(),
        autoCheckOnStart: false,
        config: {
          quotaMilestoneHours: [48, 24, 12],
          quotaAlertThresholdPercent: 25,
          webUiEnabled: false,
        },
      });

      try {
        await daemon.checkQuota();
        const events = daemon.sentryState.listAlertEvents().events;
        assert.equal(events.length, 1);
        assert.equal(events[0]?.kind, 'early_reset');
        assert.equal(events[0]?.milestoneHours, null);
        assert.equal(events[0]?.resetTime, resetTime);

        // A second observation of the same premature reset is the same event, and dismissing the
        // notice must not delete the history row.
        await daemon.checkQuota();
        assert.equal(daemon.sentryState.listAlertEvents().events.length, 1);
        daemon.sentryState.dismissEarlyResetNotice();
        assert.equal(daemon.sentryState.listAlertEvents().events.length, 1);
      } finally {
        await daemon.shutdown();
        sentryState.close();
        cleanup();
      }
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Periodic agy update (idle-only)                                            */
/* -------------------------------------------------------------------------- */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const quietAgyLogger = (): Logger => createLogger({ minLevel: 'error', sinks: [() => {}] });

describe('Daemon: idle-only agy update', () => {
  it('skips the scheduled update while a quota probe is in flight', async () => {
    const { dir, cleanup } = makeTempDir('daemon_agy_probe_busy_');
    const probeStarted = deferred<void>();
    const probeGate = deferred<QuotaSnapshot[]>();
    const updates: string[] = [];

    const quotaClient = {
      async fetchQuota(): Promise<QuotaSnapshot[]> {
        probeStarted.resolve();
        return probeGate.promise;
      },
    };

    const daemon = await createDaemon({
      dbPath: path.join(dir, 'test.db'),
      statePath: path.join(dir, 'state.json'),
      quotaClient,
      agyUpdater: {
        getVersion: async () => null,
        getCachedVersion: () => null,
        invalidate: () => {},
        update: async () => {
          updates.push('update');
          return { before: null, after: null, updated: false };
        },
      },
      autoCheckOnStart: false,
      logger: quietAgyLogger(),
      config: { webUiEnabled: false },
    });

    try {
      const probe = daemon.checkQuota();
      await probeStarted.promise;

      assert.equal(await daemon.runScheduledAgyUpdate(), false);
      assert.deepEqual(updates, [], 'a probe in flight must win over a scheduled refresh');

      probeGate.resolve([]);
      await probe;

      assert.equal(await daemon.runScheduledAgyUpdate(), true);
      assert.deepEqual(updates, ['update']);
    } finally {
      probeGate.resolve([]);
      await daemon.shutdown();
      cleanup();
    }
  });

  it('blocks a quota probe while the agy update runs', async () => {
    const { dir, cleanup } = makeTempDir('daemon_agy_update_busy_');
    const updateGate = deferred<void>();
    let quotaCalls = 0;

    const quotaClient = {
      async fetchQuota(): Promise<QuotaSnapshot[]> {
        quotaCalls++;
        return [];
      },
    };

    const daemon = await createDaemon({
      dbPath: path.join(dir, 'test.db'),
      statePath: path.join(dir, 'state.json'),
      quotaClient,
      agyUpdater: {
        getVersion: async () => '0.1.0',
        getCachedVersion: () => '0.1.0',
        invalidate: () => {},
        update: async () => {
          await updateGate.promise;
          return { before: '0.1.0', after: '0.2.0', updated: true };
        },
      },
      autoCheckOnStart: false,
      logger: quietAgyLogger(),
      config: { webUiEnabled: false },
    });

    try {
      const updating = daemon.runScheduledAgyUpdate();
      assert.deepEqual(await daemon.checkQuota(), []);
      assert.equal(quotaCalls, 0, 'the CLI fallback must not run against an install mid-update');
      assert.equal(await daemon.runScheduledAgyUpdate(), false, 'ticks must not stack');

      updateGate.resolve();
      assert.equal(await updating, true);

      await daemon.checkQuota();
      assert.equal(quotaCalls, 1);
    } finally {
      updateGate.resolve();
      await daemon.shutdown();
      cleanup();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Live settings overrides (written by the Web UI)                             */
/* -------------------------------------------------------------------------- */

const inertAgyUpdater = {
  getVersion: async () => null,
  getCachedVersion: () => null,
  invalidate: () => {},
  update: async () => ({ before: null, after: null, updated: false }),
};

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('Daemon: live settings overrides', () => {
  it('reschedules the agy update timer when the interval override changes', async () => {
    const { dir, cleanup } = makeTempDir('daemon_live_agy_interval_');
    const sink = createMemorySink();
    const logger = createLogger({ minLevel: 'debug', sinks: [sink.sink] });

    const daemon = await createDaemon({
      dbPath: path.join(dir, 'test.db'),
      statePath: path.join(dir, 'state.json'),
      quotaClient: {
        async fetchQuota(): Promise<QuotaSnapshot[]> {
          return [];
        },
      },
      agyUpdater: inertAgyUpdater,
      autoCheckOnStart: false,
      logger,
      config: { webUiEnabled: false },
    });

    try {
      await daemon.start();
      sink.clear();

      daemon.configStore.setOverride('agyUpdateIntervalHours', 6);
      await settle();
      assert.ok(
        sink.records.some(
          (record) =>
            record.level === 'info' &&
            record.formatted.includes('Periodic agy update scheduled every 6h')
        ),
        'a saved interval must reschedule the running timer, not wait for a restart'
      );

      sink.clear();
      daemon.configStore.setOverride('agyUpdateIntervalHours', 0);
      await settle();
      assert.ok(
        sink.records.some((record) => record.formatted.includes('agy update disabled')),
        '0 must clear the timer'
      );
    } finally {
      await daemon.shutdown();
      cleanup();
    }
  });

  it('applies a logLevel override to the running logger without a restart', async () => {
    const { dir, cleanup } = makeTempDir('daemon_live_log_level_');
    const logger = createLogger({ minLevel: 'info', sinks: [() => {}] });

    const daemon = await createDaemon({
      dbPath: path.join(dir, 'test.db'),
      statePath: path.join(dir, 'state.json'),
      quotaClient: {
        async fetchQuota(): Promise<QuotaSnapshot[]> {
          return [];
        },
      },
      agyUpdater: inertAgyUpdater,
      autoCheckOnStart: false,
      logger,
      config: { webUiEnabled: false },
    });

    try {
      await daemon.start();
      assert.equal(daemon.logger.getLevel(), 'info');

      daemon.configStore.setOverride('logLevel', 'debug');
      await settle();

      assert.equal(daemon.logger.getLevel(), 'debug');
    } finally {
      await daemon.shutdown();
      cleanup();
    }
  });
});
