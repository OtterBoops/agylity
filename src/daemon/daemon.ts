import http from 'node:http';
import { ConfigStore } from '../config/store.js';
import { AppDatabase } from '../storage/db.js';
import { type ResolvedConfig } from '../config/schema.js';
import { ConnectRpcQuotaClient } from '../sentry/client.js';
import { SentryStateManager, type EarlyResetPool } from '../sentry/state.js';
import { QuotaEvaluator } from '../sentry/evaluator.js';
import {
  type QuotaAlert,
  type QuotaSnapshot,
  type QuotaClient as IQuotaClient,
  calculateHoursUntilReset,
  snapshotsFromSentryState,
} from '../sentry/models.js';
import { createDaemonNotifier } from '../notify/factory.js';
import { type DeliveryOutcome, type InfoNotice, type Notifier } from '../notify/types.js';
import { LogBuffer } from '../logs/buffer.js';
import { logger, DefaultLogger, type Logger, type LogLevel } from '../logs/logger.js';
import { Coordinator } from '../coordinator/index.js';
import { DynamicModelCatalog } from '../coordinator/catalog.js';
import { sharedAgyUpdater, type AgyUpdaterLike } from '../agy/updater.js';

interface MilestonePlan {
  alerts: QuotaAlert[];
  superseded?: Map<string, number[]> | Record<string, number[]>;
  earlyResets?: EarlyResetPool[];
  retiredPools?: string[];
}

const formatPercent = (fraction: number): string => `${Math.round(fraction * 100)}%`;

const formatWindow = (hours: number): string => {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.floor(hours / 24)}d ${Math.round(hours % 24)}h`;
};

const buildEarlyResetNotice = (pools: EarlyResetPool[], detectedAt: string): InfoNotice => {
  const lines = pools.map((pool) => {
    const name = pool.displayName || pool.poolId;
    const window = formatWindow(
      calculateHoursUntilReset(pool.previousResetTime, Date.parse(detectedAt))
    );
    return `${name}: ${formatPercent(pool.previousRemainingFraction)} -> ${formatPercent(pool.remainingFraction)} remaining, ${window} before its scheduled reset.`;
  });

  const single = pools.length === 1 ? pools[0] : null;

  return {
    title: 'Quota reset early',
    message: `${lines.join(' ')} Upstream replenished ${
      pools.length === 1 ? 'this pool' : 'these pools'
    } ahead of schedule.`,
    path: '/overview',
    poolGroup: single?.poolId,
    poolName: single?.displayName,
    resetTime: single?.resetTime,
    hoursUntilReset: single
      ? calculateHoursUntilReset(single.resetTime, Date.parse(detectedAt))
      : undefined,
    timestamp: detectedAt,
  };
};

export interface AgylityDaemonOptions {
  configStore?: ConfigStore;
  config?: Partial<ResolvedConfig>;
  database?: AppDatabase;
  quotaClient?: IQuotaClient;
  sentryState?: SentryStateManager;
  sentryEvaluator?: QuotaEvaluator;
  notifier?: Notifier;
  coordinator?: Coordinator;
  dbPath?: string;
  statePath?: string;
  autoCheckOnStart?: boolean;
  logBuffer?: LogBuffer;
  logger?: Logger;
  agyUpdater?: AgyUpdaterLike;
}

export class AgylityDaemon {
  public readonly configStore: ConfigStore;
  public readonly database: AppDatabase;
  public readonly quotaClient: IQuotaClient;
  public readonly sentryState: SentryStateManager;
  public readonly sentryEvaluator: QuotaEvaluator;
  public readonly notifier: Notifier;
  public readonly coordinator: Coordinator;
  public readonly modelCatalog: DynamicModelCatalog;
  public webServer?: http.Server;
  public readonly logBuffer?: LogBuffer;
  public readonly logger: Logger;
  public agyUpdater: AgyUpdaterLike = sharedAgyUpdater;

  public isRunning = false;
  public isSentryStopped = false;
  public isDbClosed = false;
  public isNotifierShutdown = false;

  private timer: NodeJS.Timeout | null = null;
  private agyUpdateTimer: NodeJS.Timeout | null = null;
  private probeInFlight = false;
  private agyUpdateInFlight = false;
  private probeInFlightPromise: Promise<QuotaAlert[]> | null = null;
  private agyUpdateInFlightPromise: Promise<boolean> | null = null;
  private configSyncChain: Promise<void> = Promise.resolve();
  private shutdownPromise?: Promise<void>;
  private shutdownRequested = false;
  private readonly autoCheckOnStart: boolean;
  private readonly warnedLowQuotaPools = new Map<string, string>();
  private readonly warnedAgyDrift = new Set<string>();
  private warnedAuthRequired = false;

  constructor(
    configStore: ConfigStore,
    quotaClient: IQuotaClient,
    sentryState: SentryStateManager,
    sentryEvaluator: QuotaEvaluator,
    notifier: Notifier,
    autoCheckOnStart = true,
    logBuffer?: LogBuffer,
    loggerInstance?: Logger,
    coordinatorInstance?: Coordinator
  ) {
    this.configStore = configStore;
    this.database = configStore.getDatabase();
    this.quotaClient = quotaClient;
    this.sentryState = sentryState;
    this.sentryEvaluator = sentryEvaluator;
    this.notifier = notifier;
    this.autoCheckOnStart = autoCheckOnStart;
    this.logBuffer = logBuffer;
    this.logger = loggerInstance ?? logger.child('daemon');
    this.modelCatalog = new DynamicModelCatalog({
      logger: this.logger.child('catalog'),
    });
    this.coordinator =
      coordinatorInstance ??
      new Coordinator({
        configStore,
        sentryState,
        notifier,
        modelCatalog: this.modelCatalog,
        logger: this.logger.child('coordinator'),
      });
    this.coordinator.setNotifier(notifier);
    // An injected coordinator arrives without a catalog, so the active one is handed over here.
    this.coordinator.setModelCatalog?.(this.modelCatalog);
    const initialConfig = configStore.resolveConfig();
    if (initialConfig.logLevel) {
      this.applyLogLevel(initialConfig.logLevel);
    }

    this.configStore.on('change', ({ key, resolvedConfig }) => {
      if (this.shutdownRequested) return;
      // Rapid saves must not interleave, so each sync runs after the previous one settles.
      this.configSyncChain = this.configSyncChain
        .then(async () => {
          this.logger.info('Configuration update detected, syncing active components...');
          if (resolvedConfig.logLevel) {
            this.applyLogLevel(resolvedConfig.logLevel);
          }
          await this.syncComponent('notification adapter', () =>
            this.notifier.updateConfig?.(resolvedConfig)
          );
          await this.syncComponent('quota client', () =>
            this.quotaClient.updateConfig?.(resolvedConfig)
          );
          await this.syncComponent('sentry evaluator', () =>
            this.sentryEvaluator.updateConfig?.({
              milestoneHours: resolvedConfig.quotaMilestoneHours,
              alertThresholdPercent: resolvedConfig.quotaAlertThresholdPercent,
            })
          );
          await this.syncComponent('sentry timer', () => {
            if (
              this.timer &&
              resolvedConfig.quotaCheckIntervalSeconds &&
              (key === 'quotaCheckIntervalSeconds' || key === '*')
            ) {
              const newIntervalSeconds = Math.max(15, resolvedConfig.quotaCheckIntervalSeconds);
              this.logger.info(
                'Rescheduling quota sentry timer to %ds interval',
                newIntervalSeconds
              );
              this.scheduleSentryTimer(newIntervalSeconds);
            }
          });
          await this.syncComponent('agy update timer', () => {
            if (key === 'agyUpdateIntervalHours' || key === '*') {
              this.scheduleAgyUpdateTimer(resolvedConfig.agyUpdateIntervalHours);
            }
          });
        })
        .catch((err: any) => {
          this.logger.error('Configuration sync failed: %s', err?.message ?? err);
        });
    });
  }

  private async syncComponent(name: string, step: () => void | Promise<void>): Promise<void> {
    try {
      await step();
    } catch (err: any) {
      this.logger.error(
        'Error syncing %s with updated configuration: %s',
        name,
        err?.message ?? err
      );
    }
  }

  public static async create(options: AgylityDaemonOptions = {}): Promise<AgylityDaemon> {
    const dbPath = options.dbPath ?? process.env.DATABASE_PATH ?? 'data/agylity.db';
    const configStore =
      options.configStore ?? new ConfigStore(options.database ?? dbPath, options.config);

    const resolved = configStore.resolveConfig();

    // Sentry state shares the coordinator's SQLite transaction, so a delivered alert and its
    // milestone dedupe row commit together; a pre-SQLite state.json imports once, ledger empty.
    const legacyStatePath =
      options.statePath ?? process.env.QUOTA_STATE_FILE_PATH ?? 'data/state.json';
    const sentryState =
      options.sentryState ??
      new SentryStateManager({
        db: configStore.getDatabase(),
        legacyStatePath,
      });

    const sentryEvaluator =
      options.sentryEvaluator ??
      new QuotaEvaluator({
        milestoneHours: resolved.quotaMilestoneHours,
        alertThresholdPercent: resolved.quotaAlertThresholdPercent,
      });

    const quotaClient =
      options.quotaClient ??
      new ConnectRpcQuotaClient({
        endpointUrl: resolved.antigravityEndpointUrl,
        csrfToken: resolved.antigravityCsrfToken,
        minRefreshIntervalMs: 30000,
        logger: options.logger ? options.logger.child('sentry') : logger.child('sentry'),
        cachedSnapshotProvider: () => {
          return snapshotsFromSentryState(sentryState.getState());
        },
        overageEnabledProvider: () => configStore.resolveConfig().allowOverage,
      });

    const coordinator =
      options.coordinator ??
      new Coordinator({
        configStore,
        sentryState,
        logger: options.logger ? options.logger.child('coordinator') : logger.child('coordinator'),
      });

    const notifier =
      options.notifier ??
      (await createDaemonNotifier(resolved, {
        onQuotaRequested: async (): Promise<QuotaSnapshot[]> => {
          return await quotaClient.fetchQuota();
        },
        onOwnerDiscovered: async (ownerId: string): Promise<void> => {
          const currentConfig = configStore.resolveConfig();
          if (!currentConfig.discordOwnerUserId) {
            configStore.setOverride('discordOwnerUserId', ownerId);
          }
        },
        onDispatchRequested: async (req) => {
          const startedAt = Date.now();
          const disp = await coordinator.dispatch({
            repositoryId: req.repositoryId,
            repositoryName: req.repositoryName,
            repositoryPath: req.repositoryPath,
            cloneUrl: req.cloneUrl,
            prompt: req.prompt,
            requestedBy: req.requestedBy,
            requestedByUserId: req.requestedByUserId,
            cascade: req.cascade,
            requiredLabels: req.requiredLabels,
            allowOverage: req.allowOverage,
            pushBranch: req.pushBranch,
            verifyCommand: req.verifyCommand,
          });
          return {
            success: disp.success,
            taskId: disp.taskId,
            branchName: disp.branchName,
            output: disp.output,
            error: disp.error,
            status: disp.status,
            scheduleMode: disp.scheduleMode,
            code: disp.code,
            durationMs: disp.durationMs ?? Date.now() - startedAt,
          };
        },
        onContinueRequested: async (req) => {
          const startedAt = Date.now();
          const disp = await coordinator.dispatchContinuation({
            taskId: req.taskId,
            branchName: req.branchName,
            prompt: req.prompt,
            requestedBy: req.requestedBy,
            requestedByUserId: req.requestedByUserId,
            cascade: req.cascade,
            repositoryName: req.repositoryName,
            repositoryId: req.repositoryId,
          });
          return {
            success: disp.success,
            taskId: disp.taskId,
            branchName: disp.branchName,
            output: disp.output,
            error: disp.error,
            status: disp.status,
            scheduleMode: disp.scheduleMode,
            code: disp.code,
            durationMs: disp.durationMs ?? Date.now() - startedAt,
          };
        },
      }));

    coordinator.setNotifier(notifier);

    const autoCheckOnStart = options.autoCheckOnStart ?? true;

    const daemon = new AgylityDaemon(
      configStore,
      quotaClient,
      sentryState,
      sentryEvaluator,
      notifier,
      autoCheckOnStart,
      options.logBuffer,
      options.logger,
      coordinator
    );
    if (options.agyUpdater) {
      daemon.agyUpdater = options.agyUpdater;
    }
    return daemon;
  }

  public async start(): Promise<void> {
    if (this.isRunning || this.shutdownPromise) {
      return;
    }

    const resolved = this.configStore.resolveConfig();

    await this.sentryState.load();
    this.logger.info('Sentry persistent state loaded.');

    await this.notifier.initialize();
    this.logger.info('Active notification adapter initialized (%s).', this.notifier.channelName);

    if (!resolved.coordinatorEnabled) {
      this.logger.info(
        'Coordinator is disabled (coordinatorEnabled=false). Operating in pure Quota Sentry mode.'
      );
    } else {
      this.logger.info('Coordinator is enabled (coordinatorEnabled=true).');
    }

    if (resolved.webUiEnabled) {
      const { startWebServer } = await import('../web/server.js');
      const { server, port, host } = await startWebServer({
        configStore: this.configStore,
        quotaClient: this.quotaClient,
        sentryState: this.sentryState,
        logBuffer: this.logBuffer,
        notifier: this.notifier,
        coordinator: this.coordinator,
        modelCatalog: this.modelCatalog,
        agyUpdater: this.agyUpdater,
        logger: this.logger.child('web'),
        port: resolved.webUiPort,
        host: resolved.webUiHost,
      });
      this.webServer = server;
      this.logger.info('Web UI active on http://%s:%d', host, port);
    }

    if (resolved.webUiEnabled) {
      // Primed here so /api/health answers from cache instead of spawning on the request path.
      void this.agyUpdater.getVersion();
    }
    this.scheduleAgyUpdateTimer(resolved.agyUpdateIntervalHours);

    if (this.autoCheckOnStart) {
      await this.checkQuota().catch((err) => {
        this.logger.warn('Initial quota evaluation warning: %s', err?.message ?? err);
      });
    }

    if (this.shutdownRequested) {
      return;
    }
    const intervalSeconds = Math.max(15, resolved.quotaCheckIntervalSeconds ?? 60);
    this.logger.info('Sentry recurring check scheduled every %d seconds.', intervalSeconds);
    this.scheduleSentryTimer(intervalSeconds);

    this.isRunning = true;
    this.isSentryStopped = false;
    this.isDbClosed = false;
    this.isNotifierShutdown = false;
  }

  public async checkQuota(): Promise<QuotaAlert[]> {
    // One probe at a time: the agy CLI fallback must never read an install mid-update.
    if (this.probeInFlight || this.agyUpdateInFlight) {
      this.logger.debug('Skipping quota evaluation; a probe or agy update is already running');
      return [];
    }
    this.probeInFlight = true;
    const probe = this.probeQuota();
    this.probeInFlightPromise = probe;
    try {
      return await probe;
    } finally {
      this.probeInFlight = false;
      this.probeInFlightPromise = null;
    }
  }

  private async probeQuota(): Promise<QuotaAlert[]> {
    let reaped = false;
    try {
      this.logger.debug('Running scheduled quota evaluation...');
      const snapshots = await this.quotaClient.fetchQuota();
      const plan = this.evaluateMilestonePlan(snapshots);
      const alerts = plan.alerts;
      if (plan.earlyResets && plan.earlyResets.length > 0) {
        this.coordinator.onEarlyQuotaReset(plan.earlyResets);
      }
      if (plan.retiredPools && plan.retiredPools.length > 0) {
        this.logger.info(
          'Probe no longer reports %s; dropped from pool state and offline fallbacks',
          plan.retiredPools.join(', ')
        );
      }
      this.warnOnAgyDrift();
      this.coordinator.onQuotaUpdated(snapshots);
      reaped = true;

      for (const s of snapshots) {
        const pct = Math.round(s.remainingFraction * 100);
        if (pct <= 10) {
          const poolKey = s.poolId || s.poolGroup;
          const resetKey = s.resetTime || 'no-reset';
          if (this.warnedLowQuotaPools.get(poolKey) !== resetKey) {
            this.warnedLowQuotaPools.set(poolKey, resetKey);
            if (pct === 0) {
              this.logger.info(
                '%s quota exhausted (0%% remaining); model pool is currently unusable until reset',
                s.displayName || s.poolGroup
              );
            } else {
              this.logger.info(
                '%s approaching minimum headroom floor (%d%% remaining)',
                s.displayName || s.poolGroup,
                pct
              );
            }
          }
        }
      }

      for (const alert of alerts) {
        this.logger.warn(
          'Milestone warning: %s reached %sh milestone with %d%% quota remaining',
          alert.pool.displayName || alert.pool.poolId,
          alert.milestoneHours,
          alert.remainingPercentage
        );
        const outcome = await this.deliverQuotaAlert(alert);
        if (outcome.delivered) {
          this.recordDeliveredMilestones(plan, alert, outcome);
        } else {
          this.logger.warn(
            'Quota alert for %s (%sh milestone) could not be delivered; leaving milestone unrecorded for retry',
            alert.pool.displayName || alert.pool.poolId,
            alert.milestoneHours
          );
        }
      }

      if (plan.earlyResets && plan.earlyResets.length > 0) {
        await this.announceEarlyReset(plan.earlyResets);
      }

      const probeSource =
        typeof (this.quotaClient as any).getLastProbeSource === 'function'
          ? (this.quotaClient as any).getLastProbeSource()
          : 'connect_rpc';
      this.sentryState.updateProbe(probeSource);
      this.warnedAuthRequired = false;
      await this.sentryState.save();
      return alerts;
    } catch (err: any) {
      if (err?.code === 'AUTH_REQUIRED') {
        if (!this.warnedAuthRequired) {
          this.warnedAuthRequired = true;
          this.logger.warn('[Notice] Quota probe paused: %s', err.message);
        }
        this.sentryState.updateProbe('auth_required', undefined, {
          authRequired: true,
          authErrorMessage: err?.message,
        });
      } else {
        this.warnedAuthRequired = false;
        this.logger.warn('Quota probe failed; sentry marked unreachable: %s', err?.message ?? err);
        this.sentryState.updateProbe('unreachable');
      }
      try {
        await this.sentryState.save();
      } catch {}
      return [];
    } finally {
      try {
        if (!reaped) {
          this.coordinator.reapStaleClaims();
        }
      } catch (reapErr: any) {
        this.logger.warn('Stale claim reaper failed: %s', reapErr?.message ?? reapErr);
      }
    }
  }

  private applyLogLevel(level: LogLevel): void {
    const root = this.logger instanceof DefaultLogger ? this.logger.getRoot() : this.logger;
    root.setLevel(level);
  }

  private scheduleSentryTimer(intervalSeconds: number): void {
    // Shutdown clears timers early, so a scheduling call after the request must never re-arm one.
    if (this.shutdownRequested) return;
    if (this.timer) clearInterval(this.timer);
    // setInterval overflows above 2^31-1 ms and fires immediately, so the delay is clamped.
    const intervalMs = Math.min(intervalSeconds * 1000, 2_147_483_647);
    this.timer = setInterval(() => {
      void this.checkQuota().catch((err) => {
        this.logger.warn('Scheduled quota evaluation warning: %s', err?.message ?? err);
      });
    }, intervalMs);
  }

  private scheduleAgyUpdateTimer(intervalHours: number): void {
    // Shutdown clears timers early, so a scheduling call after the request must never re-arm one.
    if (this.shutdownRequested) return;
    if (this.agyUpdateTimer) {
      clearInterval(this.agyUpdateTimer);
      this.agyUpdateTimer = null;
    }
    if (!(intervalHours > 0)) {
      this.logger.info('Periodic agy update disabled (agyUpdateIntervalHours=0)');
      return;
    }
    // setInterval overflows above 2^31-1 ms and fires immediately, so the delay is clamped.
    const intervalMs = Math.min(intervalHours * 3600 * 1000, 2_147_483_647);
    this.agyUpdateTimer = setInterval(() => {
      void this.runScheduledAgyUpdate();
    }, intervalMs);
    this.agyUpdateTimer.unref();
    this.logger.info('Periodic agy update scheduled every %sh', intervalHours);
  }

  /** Idle-only: a probe or an in-flight refresh already owns the binary, so this tick is skipped. */
  public async runScheduledAgyUpdate(): Promise<boolean> {
    if (this.probeInFlight || this.agyUpdateInFlight) {
      this.logger.debug('Skipping scheduled agy update; a probe or update is already running');
      return false;
    }
    this.agyUpdateInFlight = true;
    const update = this.runAgyUpdate();
    this.agyUpdateInFlightPromise = update;
    try {
      return await update;
    } finally {
      this.agyUpdateInFlight = false;
      this.agyUpdateInFlightPromise = null;
    }
  }

  private async runAgyUpdate(): Promise<boolean> {
    try {
      await this.agyUpdater.update();
      return true;
    } catch (err: any) {
      this.logger.warn('Scheduled agy update failed: %s', err?.message ?? err);
      return false;
    }
  }

  /** A runner on a different agy build can accept a different id set; say so once per mismatch. */
  private warnOnAgyDrift(): void {
    const ours = this.agyUpdater.getCachedVersion();
    if (!ours) return;
    for (const runner of this.coordinator.listRunners()) {
      const theirs = runner.systemInfo?.agyVersion;
      if (!theirs || theirs === ours) continue;
      const key = `${runner.runnerId}@${theirs}`;
      if (this.warnedAgyDrift.has(key)) continue;
      this.warnedAgyDrift.add(key);
      this.logger.warn(
        'Runner %s reports agy %s while this coordinator runs %s; model availability can differ until they match',
        runner.name || runner.runnerId,
        theirs,
        ours
      );
    }
  }

  private evaluateMilestonePlan(snapshots: QuotaSnapshot[]): MilestonePlan {
    const evaluator = this.sentryEvaluator as unknown as {
      evaluateWithPlan?: (
        snapshots: QuotaSnapshot[],
        state: SentryStateManager
      ) => {
        alerts?: QuotaAlert[];
        supersededMilestones?: Map<string, number[]>;
        earlyResets?: EarlyResetPool[];
        retiredPools?: string[];
      };
    };
    if (typeof evaluator.evaluateWithPlan === 'function') {
      const plan = evaluator.evaluateWithPlan(snapshots, this.sentryState);
      return {
        alerts: plan.alerts ?? [],
        superseded: plan.supersededMilestones,
        earlyResets: plan.earlyResets ?? [],
        retiredPools: plan.retiredPools ?? [],
      };
    }
    return { alerts: this.sentryEvaluator.evaluate(snapshots, this.sentryState) };
  }

  private async announceEarlyReset(pools: EarlyResetPool[]): Promise<void> {
    const detectedAt = new Date().toISOString();
    const fresh: EarlyResetPool[] = [];
    for (const pool of pools) {
      if (this.sentryState.hasEarlyResetAlert(pool.poolId, pool.previousResetTime)) {
        this.logger.debug(
          '%s already announced an early reset for the %s cycle; skipping the notice',
          pool.displayName || pool.poolId,
          pool.previousResetTime
        );
        continue;
      }
      fresh.push(pool);
      this.logger.info(
        '%s reset ahead of schedule: %s -> %s remaining before the %s deadline',
        pool.displayName || pool.poolId,
        formatPercent(pool.previousRemainingFraction),
        formatPercent(pool.remainingFraction),
        pool.previousResetTime
      );
    }
    if (fresh.length === 0) return;

    const notice = this.sentryState.recordEarlyResetNotice(fresh, detectedAt);
    let outcome: DeliveryOutcome = { delivered: false, results: {} };
    try {
      outcome = (await this.notifier.notifyInfo(
        buildEarlyResetNotice(fresh, notice.detectedAt)
      )) ?? { delivered: true, results: {} };
    } catch (err: any) {
      this.logger.warn('Early reset notice delivery failed: %s', err?.message ?? err);
    }

    for (const pool of fresh) {
      this.sentryState.recordCycleAlert({
        poolId: pool.poolId,
        resetTime: pool.previousResetTime,
        kind: 'early_reset',
        headroomPercent: Math.round(pool.remainingFraction * 1000) / 10,
        channels: outcome.results,
        firedAt: notice.detectedAt,
      });
    }
  }

  private async deliverQuotaAlert(alert: QuotaAlert): Promise<DeliveryOutcome> {
    try {
      const outcome = await this.notifier.notifyQuotaAlert(alert);
      return outcome ?? { delivered: true, results: {} };
    } catch (err: any) {
      this.logger.warn(
        'Quota alert delivery failed for %s: %s',
        alert.pool.displayName || alert.pool.poolId,
        err?.message ?? err
      );
      return { delivered: false, results: {} };
    }
  }

  private recordDeliveredMilestones(
    plan: MilestonePlan,
    alert: QuotaAlert,
    outcome: DeliveryOutcome
  ): void {
    const poolId = alert.pool.poolId;
    this.sentryState.recordDeliveredAlert({
      poolId,
      resetTime: alert.pool.resetTime,
      milestoneHours: alert.milestoneHours,
      headroomPercent: alert.remainingPercentage,
      channels: outcome.results,
      firedAt: alert.triggeredAt,
    });
    const superseded = plan.superseded;
    if (!superseded) return;
    const list =
      superseded instanceof Map
        ? superseded.get(poolId)
        : (superseded as Record<string, number[] | undefined>)[poolId];
    if (list && list.length > 0) {
      this.sentryState.recordSupersededMilestones(poolId, list);
    }
  }

  /** A wait that must never outlive the shutdown budget. */
  private async settleWithin(promise: Promise<unknown>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 5000);
      timer.unref?.();
    });
    try {
      await Promise.race([promise.catch(() => undefined), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** A probe writing to SQLite must finish before the connection closes; the wait is bounded. */
  private async settleInFlight(): Promise<void> {
    const pending: Promise<unknown>[] = [];
    if (this.probeInFlightPromise) pending.push(this.probeInFlightPromise);
    if (this.agyUpdateInFlightPromise) pending.push(this.agyUpdateInFlightPromise);
    if (pending.length === 0) return;

    await this.settleWithin(Promise.all(pending.map((promise) => promise.catch(() => undefined))));
  }

  public shutdown(): Promise<void> {
    this.shutdownPromise ??= this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    this.shutdownRequested = true;
    if (!this.isRunning && this.isDbClosed) {
      return;
    }

    this.logger.info('Initiating graceful daemon shutdown...');

    // Timers stop before any await: a queued sync must not be able to re-arm them.
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.agyUpdateTimer) {
      clearInterval(this.agyUpdateTimer);
      this.agyUpdateTimer = null;
    }
    this.isSentryStopped = true;

    // A queued config sync may still append work, so it drains under the shutdown deadline.
    await this.settleWithin(this.configSyncChain);

    // An in-flight probe still writes through the live connection.
    await this.settleInFlight();

    if (this.notifier && !this.isNotifierShutdown) {
      try {
        await this.notifier.shutdown();
        this.logger.info('Notification adapter shut down cleanly.');
      } catch (err) {
        this.logger.error('Notification shutdown error:', err);
      }
      this.isNotifierShutdown = true;
    }

    if (this.webServer) {
      try {
        const { closeWebServer } = await import('../web/server.js');
        await closeWebServer(this.webServer);
        this.logger.info('Web server stopped cleanly.');
      } catch (err) {
        this.logger.error('Web server shutdown error:', err);
      }
      this.webServer = undefined;
    }

    if (!this.isDbClosed) {
      try {
        this.configStore.close();
        this.logger.info('Database connection closed cleanly.');
      } catch (err) {
        this.logger.error('Database close error:', err);
      }
      this.isDbClosed = true;
    }

    this.isRunning = false;
  }

  public async stop(): Promise<void> {
    return this.shutdown();
  }
}

export const createDaemon = async (options: AgylityDaemonOptions = {}): Promise<AgylityDaemon> =>
  AgylityDaemon.create(options);

export const startDaemon = async (options: AgylityDaemonOptions = {}): Promise<AgylityDaemon> => {
  const daemon = await AgylityDaemon.create(options);
  await daemon.start();
  return daemon;
};

export const stopDaemon = async (daemon: AgylityDaemon): Promise<void> => {
  await daemon.shutdown();
};
