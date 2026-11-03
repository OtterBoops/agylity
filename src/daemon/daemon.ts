import http from 'node:http';
import { ConfigStore } from '../config/store.js';
import { AppDatabase } from '../storage/db.js';
import { type ResolvedConfig } from '../config/schema.js';
import { ConnectRpcQuotaClient } from '../sentry/client.js';
import { SentryStateManager } from '../sentry/state.js';
import { QuotaEvaluator } from '../sentry/evaluator.js';
import {
  type QuotaAlert,
  type QuotaSnapshot,
  type QuotaClient as IQuotaClient,
  snapshotsFromSentryState,
} from '../sentry/models.js';
import { createDaemonNotifier } from '../notify/factory.js';
import { type Notifier } from '../notify/types.js';
import { LogBuffer } from '../logs/buffer.js';
import { logger, DefaultLogger, type Logger, type LogLevel } from '../logs/logger.js';
import { OrchestratorCoordinator } from '../orchestrator/index.js';

/** Dry-run milestone plan returned by the evaluator; state is recorded only after delivery. */
interface MilestonePlan {
  alerts: QuotaAlert[];
  superseded?: Map<string, number[]> | Record<string, number[]>;
}

export interface AgylityDaemonOptions {
  configStore?: ConfigStore;
  config?: Partial<ResolvedConfig>;
  database?: AppDatabase;
  quotaClient?: IQuotaClient;
  sentryState?: SentryStateManager;
  sentryEvaluator?: QuotaEvaluator;
  notifier?: Notifier;
  orchestrator?: OrchestratorCoordinator;
  dbPath?: string;
  statePath?: string;
  autoCheckOnStart?: boolean;
  logBuffer?: LogBuffer;
  logger?: Logger;
}

export class AgylityDaemon {
  public readonly configStore: ConfigStore;
  public readonly database: AppDatabase;
  public readonly quotaClient: IQuotaClient;
  public readonly sentryState: SentryStateManager;
  public readonly sentryEvaluator: QuotaEvaluator;
  public readonly notifier: Notifier;
  public readonly orchestrator: OrchestratorCoordinator;
  public webServer?: http.Server;
  public readonly logBuffer?: LogBuffer;
  public readonly logger: Logger;

  public isRunning = false;
  public isSentryStopped = false;
  public isDbClosed = false;
  public isNotifierShutdown = false;

  private timer: NodeJS.Timeout | null = null;
  private readonly autoCheckOnStart: boolean;
  private readonly warnedLowQuotaPools = new Map<string, string>();
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
    orchestratorInstance?: OrchestratorCoordinator
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
    this.orchestrator =
      orchestratorInstance ??
      new OrchestratorCoordinator({
        configStore,
        sentryState,
        notifier,
        logger: this.logger.child('orchestrator'),
      });
    this.orchestrator.setNotifier(notifier);
    const initialConfig = configStore.resolveConfig();
    if (initialConfig.logLevel) {
      this.applyLogLevel(initialConfig.logLevel);
    }

    // Reactively update active notifier and quota client when configuration is updated (e.g. via Web UI)
    this.configStore.on('change', async ({ key, resolvedConfig }) => {
      try {
        this.logger.info('Configuration update detected, syncing active components...');
        if (resolvedConfig.logLevel) {
          this.applyLogLevel(resolvedConfig.logLevel);
        }
        if (typeof this.notifier.updateConfig === 'function') {
          await this.notifier.updateConfig(resolvedConfig);
        }
        if (typeof this.quotaClient.updateConfig === 'function') {
          this.quotaClient.updateConfig(resolvedConfig);
        }
        if (typeof this.sentryEvaluator.updateConfig === 'function') {
          this.sentryEvaluator.updateConfig({
            milestoneHours: resolvedConfig.quotaMilestoneHours,
            alertThresholdPercent: resolvedConfig.quotaAlertThresholdPercent,
          });
        }
        if (
          this.timer &&
          resolvedConfig.quotaCheckIntervalSeconds &&
          (key === 'quotaCheckIntervalSeconds' || key === '*')
        ) {
          const newIntervalSeconds = Math.max(30, resolvedConfig.quotaCheckIntervalSeconds);
          this.logger.info('Rescheduling quota sentry timer to %ds interval', newIntervalSeconds);
          this.scheduleSentryTimer(newIntervalSeconds);
        }
      } catch (err: any) {
        this.logger.error('Error syncing updated configuration:', err?.message ?? err);
      }
    });
  }

  // Factory method to construct and wire all daemon subsystems.
  public static async create(options: AgylityDaemonOptions = {}): Promise<AgylityDaemon> {
    // 1. Initialize configuration store & database
    const dbPath = options.dbPath ?? process.env.DATABASE_PATH ?? 'data/agylity.db';
    const configStore =
      options.configStore ?? new ConfigStore(options.database ?? dbPath, options.config);

    const resolved = configStore.resolveConfig();

    // 2. Initialize Sentry State Manager
    const statePath = options.statePath ?? process.env.QUOTA_STATE_FILE_PATH ?? 'data/state.json';
    const sentryState = options.sentryState ?? new SentryStateManager(statePath);

    // 3. Initialize Quota Evaluator
    const sentryEvaluator =
      options.sentryEvaluator ??
      new QuotaEvaluator({
        milestoneHours: resolved.quotaMilestoneHours,
        alertThresholdPercent: resolved.quotaAlertThresholdPercent,
      });

    // 4. Initialize Quota Client (Connect-RPC with CLI fallback)
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

    const orchestrator =
      options.orchestrator ??
      new OrchestratorCoordinator({
        configStore,
        sentryState,
        logger: options.logger
          ? options.logger.child('orchestrator')
          : logger.child('orchestrator'),
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
          const disp = await orchestrator.dispatch({
            repositoryId: req.repositoryId,
            repositoryName: req.repositoryName,
            repositoryPath: req.repositoryPath,
            cloneUrl: req.cloneUrl,
            prompt: req.prompt,
            requestedBy: req.requestedBy,
            requestedByUserId: req.requestedByUserId,
            model: req.model,
            effort: req.effort,
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
          const disp = await orchestrator.dispatchContinuation({
            taskId: req.taskId,
            branchName: req.branchName,
            prompt: req.prompt,
            requestedBy: req.requestedBy,
            requestedByUserId: req.requestedByUserId,
            effort: req.effort,
            repositoryName: req.repositoryName,
            repositoryId: req.repositoryId,
            model: req.model,
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

    orchestrator.setNotifier(notifier);

    const autoCheckOnStart = options.autoCheckOnStart ?? true;

    return new AgylityDaemon(
      configStore,
      quotaClient,
      sentryState,
      sentryEvaluator,
      notifier,
      autoCheckOnStart,
      options.logBuffer,
      options.logger,
      orchestrator
    );
  }

  // Starts the daemon, initializing notifier, loading state, conditionally starting
  public async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    const resolved = this.configStore.resolveConfig();

    // 1. Load persistent sentry state
    await this.sentryState.load();
    this.logger.info('Sentry persistent state loaded.');

    // 2. Initialize active notification adapter
    await this.notifier.initialize();
    this.logger.info('Active notification adapter initialized (%s).', this.notifier.channelName);

    // 3. Orchestrator Status
    if (!resolved.orchestratorEnabled) {
      this.logger.info(
        'Orchestrator is disabled (orchestratorEnabled=false). Operating in pure Quota Sentry mode.'
      );
    } else {
      this.logger.info('Orchestrator is enabled (orchestratorEnabled=true).');
    }

    // 4. Conditional Web UI bootstrap (Zero-Overhead Invariant)
    if (resolved.webUiEnabled) {
      const { startWebServer } = await import('../web/server.js');
      const { server, port, host } = await startWebServer({
        configStore: this.configStore,
        quotaClient: this.quotaClient,
        sentryState: this.sentryState,
        logBuffer: this.logBuffer,
        notifier: this.notifier,
        orchestrator: this.orchestrator,
        logger: this.logger.child('web'),
        port: resolved.webUiPort,
        host: resolved.webUiHost,
      });
      this.webServer = server;
      this.logger.info('Web UI active on http://%s:%d', host, port);
    }

    // 4. Initial quota check on boot
    if (this.autoCheckOnStart) {
      await this.checkQuota().catch((err) => {
        this.logger.warn('Initial quota evaluation warning: %s', err?.message ?? err);
      });
    }

    // 5. Setup recurring sentry interval
    const intervalSeconds = Math.max(30, resolved.quotaCheckIntervalSeconds ?? 60);
    this.logger.info('Sentry recurring check scheduled every %d seconds.', intervalSeconds);
    this.scheduleSentryTimer(intervalSeconds);

    this.isRunning = true;
    this.isSentryStopped = false;
    this.isDbClosed = false;
    this.isNotifierShutdown = false;
  }

  // Executes a single quota probe and milestone evaluation cycle.
  public async checkQuota(): Promise<QuotaAlert[]> {
    try {
      this.logger.debug('Running scheduled quota evaluation...');
      const snapshots = await this.quotaClient.fetchQuota();
      this.orchestrator.onQuotaUpdated(snapshots);
      const plan = this.evaluateMilestonePlan(snapshots);
      const alerts = plan.alerts;

      // Informational status when quota is low or pool exhausted (deduplicated per reset cycle)
      for (const s of snapshots) {
        const pct = Math.round(s.remainingFraction * 100);
        if (pct <= 10) {
          const poolKey = s.poolId || s.family;
          const resetKey = s.resetTime || 'no-reset';
          if (this.warnedLowQuotaPools.get(poolKey) !== resetKey) {
            this.warnedLowQuotaPools.set(poolKey, resetKey);
            if (pct === 0) {
              this.logger.info(
                '%s quota exhausted (0%% remaining); model pool is currently unusable until reset',
                s.displayName || s.family
              );
            } else {
              this.logger.info(
                '%s approaching minimum headroom floor (%d%% remaining)',
                s.displayName || s.family,
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
        if (await this.deliverQuotaAlert(alert)) {
          // Record only after a confirmed delivery so an outage cannot permanently lose the alert.
          this.recordDeliveredMilestones(plan, alert);
        } else {
          this.logger.warn(
            'Quota alert for %s (%sh milestone) could not be delivered; leaving milestone unrecorded for retry',
            alert.pool.displayName || alert.pool.poolId,
            alert.milestoneHours
          );
        }
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
      } catch {
        // State persistence failure logged without throwing
      }
      return [];
    } finally {
      try {
        this.orchestrator.reapStaleClaims();
      } catch (reapErr: any) {
        // A reaper failure (e.g. database already closed) must never escape the probe outcome.
        this.logger.warn('Stale claim reaper failed: %s', reapErr?.message ?? reapErr);
      }
    }
  }

  /** Applies a level to the root logger so every namespace inherits it; children may still override. */
  private applyLogLevel(level: LogLevel): void {
    const root = this.logger instanceof DefaultLogger ? this.logger.getRoot() : this.logger;
    root.setLevel(level);
  }

  /** Single scheduling path for the recurring probe so the two call sites cannot drift. */
  private scheduleSentryTimer(intervalSeconds: number): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.checkQuota().catch((err) => {
        this.logger.warn('Scheduled quota evaluation warning: %s', err?.message ?? err);
      });
    }, intervalSeconds * 1000);
  }

  // Evaluates snapshots via the evaluator's dry-run plan when available, so milestone
  private evaluateMilestonePlan(snapshots: QuotaSnapshot[]): MilestonePlan {
    const evaluator = this.sentryEvaluator as unknown as {
      evaluateWithPlan?: (
        snapshots: QuotaSnapshot[],
        state: SentryStateManager
      ) => { alerts?: QuotaAlert[]; supersededMilestones?: Map<string, number[]> };
    };
    if (typeof evaluator.evaluateWithPlan === 'function') {
      const plan = evaluator.evaluateWithPlan(snapshots, this.sentryState);
      return { alerts: plan.alerts ?? [], superseded: plan.supersededMilestones };
    }
    // Legacy evaluator records milestones itself and returns only the alerts.
    return { alerts: this.sentryEvaluator.evaluate(snapshots, this.sentryState) };
  }

  /** Delivers one alert; returns false when the notifier reports no successful channel. */
  private async deliverQuotaAlert(alert: QuotaAlert): Promise<boolean> {
    try {
      const outcome = await this.notifier.notifyQuotaAlert(alert);
      return outcome?.delivered !== false;
    } catch (err: any) {
      this.logger.warn(
        'Quota alert delivery failed for %s: %s',
        alert.pool.displayName || alert.pool.poolId,
        err?.message ?? err
      );
      return false;
    }
  }

  /** Records the fired and superseded milestones for a delivered alert. */
  private recordDeliveredMilestones(plan: MilestonePlan, alert: QuotaAlert): void {
    const poolId = alert.pool.poolId;
    this.sentryState.recordMilestoneFired(poolId, alert.milestoneHours, alert.triggeredAt);
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

  public async shutdown(): Promise<void> {
    if (!this.isRunning && this.isDbClosed) {
      return;
    }

    this.logger.info('Initiating graceful daemon shutdown...');

    // 1. Stop recurring sentry interval timer
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isSentryStopped = true;

    // 2. Shut down notification adapter
    if (this.notifier && !this.isNotifierShutdown) {
      try {
        await this.notifier.shutdown();
        this.logger.info('Notification adapter shut down cleanly.');
      } catch (err) {
        this.logger.error('Notification shutdown error:', err);
      }
      this.isNotifierShutdown = true;
    }

    // 3. Close web server if running
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

    // 4. Close database connection
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

  // Alias for shutdown() adhering to universal lifecycle conventions.
  public async stop(): Promise<void> {
    return this.shutdown();
  }
}

// Programmatic helper to create an unstarted AgylityDaemon.
export const createDaemon = async (options: AgylityDaemonOptions = {}): Promise<AgylityDaemon> =>
  AgylityDaemon.create(options);

// Programmatic helper to create and immediately start an AgylityDaemon.
export const startDaemon = async (options: AgylityDaemonOptions = {}): Promise<AgylityDaemon> => {
  const daemon = await AgylityDaemon.create(options);
  await daemon.start();
  return daemon;
};

// Programmatic helper to gracefully stop an active AgylityDaemon.
export const stopDaemon = async (daemon: AgylityDaemon): Promise<void> => {
  await daemon.shutdown();
};
