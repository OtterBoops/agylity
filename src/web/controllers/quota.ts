import type http from 'node:http';
import { sendJson, methodNotAllowed } from '../http.js';
import { logger } from '../../logs/logger.js';
import type { WebServerOptions } from '../types.js';
import type { QuotaSnapshot } from '../../sentry/models.js';
import { snapshotsFromSentryState } from '../../sentry/models.js';

export const handleGetQuota = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  method: string
): Promise<void> => {
  if (method !== 'GET') return methodNotAllowed(res);

  try {
    let snapshots: QuotaSnapshot[] = [];
    if (options.quotaClient) {
      // ?refresh=1 forces a probe; without it a manual refresh can be served the 30s cache.
      const force = new URL(req.url ?? '/', 'http://localhost').searchParams.get('refresh') === '1';
      snapshots = await options.quotaClient.fetchQuota(force);
    } else if (options.sentryState) {
      snapshots = snapshotsFromSentryState(options.sentryState.getState());
    }
    return sendJson(res, 200, snapshots);
  } catch (err: any) {
    const statusCode = err?.code === 'AUTH_REQUIRED' ? 401 : 500;
    // The message stays in the log: it can carry absolute paths and SQL detail.
    logger.child('web').error('Quota fetch failed: %s', err?.stack ?? err);
    return sendJson(res, statusCode, {
      error: err?.code === 'AUTH_REQUIRED' ? 'Authentication Required' : 'Failed to fetch quota',
      code: err?.code,
    });
  }
};

export const handleGetAlerts = (
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  method: string
): void => {
  if (method !== 'GET') return methodNotAllowed(res);
  const alertData = options.sentryState?.getState() ?? {
    version: 1,
    lastProbeAt: new Date().toISOString(),
    lastProbeSource: 'unreachable',
    pools: {},
  };
  return sendJson(res, 200, alertData);
};
