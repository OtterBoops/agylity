import { CANONICAL_SECRET_CONFIG_KEYS } from '../config/schema.js';
import { AGYLITY_VERSION } from '../version.js';
import { LogBuffer, installConsoleTee } from '../logs/buffer.js';
import { logger } from '../logs/logger.js';
import { createDaemon, type AgylityDaemon } from '../daemon/daemon.js';

// Primary CLI execution entrypoint for standalone daemon process.
export const main = async (): Promise<AgylityDaemon> => {
  const banner = `agylity v${AGYLITY_VERSION} — Autonomous Quota Sentry & Remote Task Orchestrator`;
  const rule = '='.repeat(banner.length + 4);
  console.log(rule);
  console.log(`  ${banner}  `);
  console.log(rule);

  try {
    if (typeof (process as any).loadEnvFile === 'function') {
      (process as any).loadEnvFile();
    }
  } catch {
    // .env file is optional
  }

  // Tee console output into a bounded, secret-redacting ring buffer for the dashboard Logs view
  let daemonRef: AgylityDaemon | undefined;
  let cachedSecrets: string[] = [];
  let secretsLoaded = false;

  const refreshCachedSecrets = () => {
    const c = daemonRef?.configStore.resolveConfig();
    const secrets: Array<string | undefined> = [
      ...(c ? CANONICAL_SECRET_CONFIG_KEYS.map((k) => c[k] as string | undefined) : []),
      process.env.WEB_UI_AUTH_TOKEN,
      process.env.GITHUB_TOKEN,
      process.env.AGYLITY_SECRET_KEY,
      process.env.ENCRYPTION_KEY,
      ...(c?.webhookCustomHeaders ? Object.values(c.webhookCustomHeaders) : []),
    ];

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

    cachedSecrets = secrets.filter((s): s is string => Boolean(s) && typeof s === 'string');
  };

  const logBuffer = new LogBuffer(1000, () => {
    // An empty result is a valid loaded state, so gate on having loaded, not on emptiness.
    if (!secretsLoaded) {
      secretsLoaded = true;
      refreshCachedSecrets();
    }
    return cachedSecrets;
  });
  installConsoleTee(logBuffer);

  const daemon = await createDaemon({ logBuffer });
  daemonRef = daemon;
  refreshCachedSecrets();
  daemon.configStore.on('change', () => {
    refreshCachedSecrets();
  });

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

  // A fatal error must shut down cleanly (closing the database and web server) before exiting.
  const handleFatal = async (kind: string, err: unknown): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    logger.error('[Fatal] %s: %s', kind, detail);
    try {
      await daemon.shutdown();
    } catch (shutdownErr) {
      logger.error('Error during fatal shutdown:', shutdownErr);
    }
    process.exit(1);
  };

  process.on('unhandledRejection', (reason) => void handleFatal('unhandledRejection', reason));
  process.on('uncaughtException', (err) => void handleFatal('uncaughtException', err));

  await daemon.start();
  logger.info('Daemon started.');
  return daemon;
};
