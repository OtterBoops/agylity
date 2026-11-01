import type http from 'node:http';
import { sendJson, methodNotAllowed } from '../http.js';
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
      snapshots = await options.quotaClient.fetchQuota();
    } else if (options.sentryState) {
      snapshots = snapshotsFromSentryState(options.sentryState.getState());
    }
    return sendJson(res, 200, snapshots);
  } catch (err: any) {
    return sendJson(res, 500, { error: 'Failed to fetch quota', message: err?.message });
  }
};

export const handleGetAlerts = (
  req: http.IncomingMessage,
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
