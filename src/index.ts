import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore, type IConfigStore } from './config/store.js';
import { AppDatabase } from './storage/db.js';
import { type ResolvedConfig } from './config/schema.js';
import { ConnectRpcQuotaClient, QuotaClient, LanguageServerError } from './sentry/client.js';
import { SentryStateManager } from './sentry/state.js';
import { QuotaEvaluator } from './sentry/evaluator.js';
import {
  type QuotaAlert,
  type QuotaSnapshot,
  type QuotaClient as IQuotaClient,
} from './sentry/models.js';
import { createNotifier } from './notify/factory.js';
import { type Notifier } from './notify/types.js';
import { LogBuffer, installConsoleTee } from './logs/buffer.js';
import { logger, createLogger, type Logger } from './logs/logger.js';

// Alias exports for external consumers and test suites
export {
  ConnectRpcQuotaClient,
  QuotaClient,
  LanguageServerError,
  ConfigStore,
  AppDatabase,
  SentryStateManager,
  QuotaEvaluator,
  LogBuffer,
  installConsoleTee,
  logger,
  createLogger,
  type Logger,
};

export interface AgylityDaemonOptions {
  configStore?: ConfigStore;
  config?: Partial<ResolvedConfig>;
  database?: AppDatabase;
  quotaClient?: IQuotaClient;
  sentryState?: SentryStateManager;
  sentryEvaluator?: QuotaEvaluator;
  notifier?: Notifier;
  dbPath?: string;
  statePath?: string;
  autoCheckOnStart?: boolean;
  logBuffer?: LogBuffer;
  logger?: Logger;
}

/**
 * AgylityDaemon coordinates the complete autonomous lifecycle of agylity:
 * 1. Persistent configuration store (node:sqlite with fallback precedence)
 * 2. Antigravity Language Server Connect-RPC client with agy CLI fallback
 * 3. Quota Sentry milestone evaluator and deduplication state engine
 * 4. Pluggable notification adapters (Discord with slash commands & modal prompt, Console)
 * 5. Task orchestrator with pluggable worker executor
 * 6. Decoupled Web UI (zero-overhead dynamic import on demand)
 * 7. Graceful teardown on SIGINT/SIGTERM
 */
export class AgylityDaemon {
  public readonly configStore: ConfigStore;
  public readonly database: AppDatabase;
  public readonly quotaClient: IQuotaClient;
  public readonly sentryState: SentryStateManager;
  public readonly sentryEvaluator: QuotaEvaluator;
  public readonly notifier: Notifier;
  public webServer?: http.Server;
  public readonly logBuffer?: LogBuffer;
  public readonly logger: Logger;

  public isRunning = false;
  public isSentryStopped = false;
  public isDbClosed = false;
  public isNotifierShutdown = false;

  private timer: NodeJS.Timeout | null = null;
  private readonly autoCheckOnStart: boolean;

  constructor(
    configStore: ConfigStore,
    quotaClient: IQuotaClient,
    sentryState: SentryStateManager,
    sentryEvaluator: QuotaEvaluator,
    notifier: Notifier,
    autoCheckOnStart = true,
    logBuffer?: LogBuffer,
    loggerInstance?: Logger
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
    const initialConfig = configStore.resolveConfig();
    if (initialConfig.logLevel) {
      this.logger.setLevel(initialConfig.logLevel);
    }

    // Reactively update active notifier and quota client when configuration is updated (e.g. via Web UI)
    this.configStore.on('change', async ({ resolvedConfig }) => {
      try {
        this.logger.info('Configuration update detected, syncing active components...');
        if (resolvedConfig.logLevel) {
          this.logger.setLevel(resolvedConfig.logLevel);
        }
        if (typeof this.notifier.updateConfig === 'function') {
          await this.notifier.updateConfig(resolvedConfig);
        }
        if (typeof this.quotaClient.updateConfig === 'function') {
          this.quotaClient.updateConfig(resolvedConfig);
        }
      } catch (err: any) {
        this.logger.error('Error syncing updated configuration:', err?.message ?? err);
      }
    });
  }

  /**
   * Factory method to construct and wire all daemon subsystems.
   */
  public static async create(options: AgylityDaemonOptions = {}): Promise<AgylityDaemon> {
    // 1. Initialize configuration store & database
    const dbPath = options.dbPath ?? options.config?.databasePath ?? 'data/agylity.db';
    const configStore =
      options.configStore ?? new ConfigStore(options.database ?? dbPath, options.config);

    const resolved = configStore.resolveConfig();

    // 2. Initialize Sentry State Manager
    const statePath = options.statePath ?? resolved.quotaStateFilePath ?? 'data/state.json';
    const sentryState = options.sentryState ?? new SentryStateManager(statePath);

    // 3. Initialize Quota Evaluator
    const sentryEvaluator =
      options.sentryEvaluator ??
      new QuotaEvaluator({
        milestoneHours: resolved.quotaMilestoneHours,
        alertThresholdPercent: resolved.quotaAlertThresholdPercent,
      });

    // 4. Initialize Quota Client (Connect-RPC with CLI fallback)
    const daemonLogger = options.logger ?? logger.child('daemon');
    const quotaClient =
      options.quotaClient ??
      new ConnectRpcQuotaClient({
        endpointUrl: resolved.antigravityEndpointUrl,
        csrfToken: resolved.antigravityCsrfToken,
        port: resolved.antigravityLsPort,
        minRefreshIntervalMs: 30000,
        logger: options.logger ? options.logger.child('sentry') : logger.child('sentry'),
        cachedSnapshotProvider: () => {
          const state = sentryState.getState();
          const list: QuotaSnapshot[] = [];
          for (const [poolId, pool] of Object.entries(state.pools)) {
            list.push({
              poolId,
              family: poolId as any,
              displayName: poolId,
              remainingFraction: pool.remainingFraction,
              resetTime: pool.resetTime,
              hoursUntilReset: 0,
              models: [],
            });
          }
          return list;
        },
      });

    const notifier =
      options.notifier ??
      (await createNotifier(resolved, {
        onQuotaRequested: async (): Promise<QuotaSnapshot[]> => {
          return await quotaClient.fetchQuota();
        },
      }));

    const autoCheckOnStart = options.autoCheckOnStart ?? true;

    return new AgylityDaemon(
      configStore,
      quotaClient,
      sentryState,
      sentryEvaluator,
      notifier,
      autoCheckOnStart,
      options.logBuffer,
      options.logger
    );
  }

  /**
   * Starts the daemon, initializing notifier, loading state, conditionally starting
   * the web UI, executing initial quota check, and activating the sentry poll interval.
   */
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
      const { startWebServer } = await import('./web/server.js');
      const { server, port, host } = await startWebServer({
        configStore: this.configStore,
        quotaClient: this.quotaClient,
        sentryState: this.sentryState,
        logBuffer: this.logBuffer,
        notifier: this.notifier,
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
    this.timer = setInterval(() => {
      void this.checkQuota().catch((err) => {
        this.logger.warn('Scheduled quota evaluation warning: %s', err?.message ?? err);
      });
    }, intervalSeconds * 1000);

    this.isRunning = true;
    this.isSentryStopped = false;
    this.isDbClosed = false;
    this.isNotifierShutdown = false;
  }

  /**
   * Executes a single quota probe and milestone evaluation cycle.
   */
  public async checkQuota(): Promise<QuotaAlert[]> {
    try {
      this.logger.debug('Running scheduled quota evaluation...');
      const snapshots = await this.quotaClient.fetchQuota();
      const alerts = this.sentryEvaluator.evaluate(snapshots, this.sentryState);

      // Warning when quota is low or approaching safety floor
      for (const s of snapshots) {
        const pct = Math.round(s.remainingFraction * 100);
        if (pct <= 10) {
          this.logger.warn(
            'Critical quota warning: %s is down to %d%% remaining',
            s.displayName || s.family,
            pct
          );
        }
      }

      for (const alert of alerts) {
        this.logger.warn(
          'Milestone warning: %s reached %sh milestone with %d%% quota remaining',
          alert.pool.displayName || alert.pool.poolId,
          alert.milestoneHours,
          alert.remainingPercentage
        );
        await this.notifier.notifyQuotaAlert(alert);
      }

      this.sentryState.updateProbe('connect_rpc');
      await this.sentryState.save();
      return alerts;
    } catch (err: any) {
      this.logger.warn('Quota probe failed; sentry marked unreachable: %s', err?.message ?? err);
      this.sentryState.updateProbe('unreachable');
      try {
        await this.sentryState.save();
      } catch {
        // State persistence failure logged without throwing
      }
      return [];
    }
  }

  /**
   * Graceful shutdown sequence:
   * 1. Stops sentry scheduler interval timer.
   * 2. Shuts down notification adapter.
   * 3. Closes decoupled web server if running.
   * 4. Closes SQLite database connection cleanly.
   */
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
        const { closeWebServer } = await import('./web/server.js');
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

  /**
   * Alias for shutdown() adhering to universal lifecycle conventions.
   */
  public async stop(): Promise<void> {
    return this.shutdown();
  }
}

/**
 * Programmatic helper to create an unstarted AgylityDaemon.
 */
export const createDaemon = async (options: AgylityDaemonOptions = {}): Promise<AgylityDaemon> =>
  AgylityDaemon.create(options);

/**
 * Programmatic helper to create and immediately start an AgylityDaemon.
 */
export const startDaemon = async (options: AgylityDaemonOptions = {}): Promise<AgylityDaemon> => {
  const daemon = await AgylityDaemon.create(options);
  await daemon.start();
  return daemon;
};

/**
 * Programmatic helper to gracefully stop an active AgylityDaemon.
 */
export const stopDaemon = async (daemon: AgylityDaemon): Promise<void> => {
  await daemon.shutdown();
};

/**
 * Primary CLI execution entrypoint for standalone daemon process.
 */
export const main = async (): Promise<AgylityDaemon> => {
  console.log('================================================================');
  console.log('   agylity — Autonomous Quota Sentry & Remote Task Orchestrator  ');
  console.log('================================================================');

  try {
    if (typeof (process as any).loadEnvFile === 'function') {
      (process as any).loadEnvFile();
    }
  } catch {
    // .env file is optional
  }

  // Tee console output into a bounded, secret-redacting ring buffer for the dashboard Logs view
  let daemonRef: AgylityDaemon | undefined;
  const logBuffer = new LogBuffer(1000, () => {
    const c = daemonRef?.configStore.resolveConfig();
    const secrets: Array<string | undefined> = [
      c?.discordToken,
      c?.antigravityCsrfToken,
      c?.webhookSecret,
      c?.notificationWebhookUrl,
      process.env.AGYLITY_SECRET_KEY,
      process.env.ENCRYPTION_KEY,
      ...(c?.webhookCustomHeaders ? Object.values(c.webhookCustomHeaders) : []),
    ];

    // Deconstruct webhook URL to capture individual secret tokens and query values
    if (c?.notificationWebhookUrl) {
      try {
        const u = new URL(c.notificationWebhookUrl);
        const segments = u.pathname.split('/').filter(Boolean);
        if (segments.length >= 2) {
          const lastSegment = segments[segments.length - 1];
          if (lastSegment && lastSegment.length >= 6) {
            secrets.push(lastSegment);
          }
        }
        for (const val of u.searchParams.values()) {
          if (val && val.length >= 6) {
            secrets.push(val);
          }
        }
      } catch {
        // Safe fallback for unparseable URLs
      }
    }

    return secrets.filter((s): s is string => Boolean(s) && typeof s === 'string' && s.length >= 6);
  });
  installConsoleTee(logBuffer);

  const daemon = await createDaemon({ logBuffer });
  daemonRef = daemon;

  let shuttingDown = false;
  const handleSignal = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Received %s. Initiating graceful shutdown...', signal);
    try {
      await daemon.shutdown();
      logger.info('Shutdown complete.');
      process.exit(0);
    } catch (err) {
      logger.error('Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.once('SIGINT', () => void handleSignal('SIGINT'));
  process.once('SIGTERM', () => void handleSignal('SIGTERM'));

  await daemon.start();
  logger.info('Daemon started.');
  return daemon;
};

// Auto-run when executed directly from CLI or Docker container
const isDirectExecution = (): boolean => {
  if (typeof process.argv[1] !== 'string') return false;
  // Guard against execution during test runs
  if (process.env.NODE_TEST_CONTEXT || process.env.VITEST) return false;

  try {
    const currentScript = fileURLToPath(import.meta.url);
    const invokedScript = path.resolve(process.argv[1]);
    return currentScript === invokedScript;
  } catch {
    return false;
  }
};

if (isDirectExecution()) {
  main().catch((err) => {
    console.error('[agylity] Fatal daemon startup error:', err);
    process.exit(1);
  });
}

export default AgylityDaemon;
