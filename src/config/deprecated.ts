import type { Logger } from '../logs/logger.js';

const DEPRECATED_ENV_VARS: Readonly<Record<string, string>> = {
  NOTIFICATION_CHANNEL: 'NOTIFICATION_CHANNELS',
  WEBHOOK_URL: 'NOTIFICATION_WEBHOOK_URL',
  ENCRYPTION_KEY: 'AGYLITY_SECRET_KEY',
  AGYLITY_COORDINATOR_URL: 'COORDINATOR_URL',
  AGYLITY_REGISTRATION_TOKEN: 'REGISTRATION_TOKEN',
  AGYLITY_RUNNER_TOKEN: 'RUNNER_TOKEN',
};

export const warnDeprecatedEnvVars = (
  env: NodeJS.ProcessEnv,
  log: Pick<Logger, 'warn'>
): string[] => {
  const found: string[] = [];
  for (const [legacy, canonical] of Object.entries(DEPRECATED_ENV_VARS)) {
    if (env[legacy]?.trim()) {
      found.push(legacy);
      log.warn(
        'Deprecated environment variable %s is no longer read; use %s instead.',
        legacy,
        canonical
      );
    }
  }
  return found;
};
