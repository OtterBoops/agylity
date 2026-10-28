import type { ConfigStore } from '../config/store.js';
import type { QuotaClient } from '../sentry/models.js';
import type { SentryStateManager } from '../sentry/state.js';
import type { LogBuffer } from '../logs/buffer.js';
import type { Logger } from '../logs/logger.js';
import type { Notifier } from '../notify/types.js';

export interface WebServerOptions {
  host?: string;
  port?: number;
  configStore: ConfigStore;
  quotaClient?: QuotaClient;
  sentryState?: SentryStateManager;
  logBuffer?: LogBuffer;
  notifier?: Notifier;
  logger?: Logger;
}

export const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};
