import type http from 'node:http';
import { sendJson, methodNotAllowed } from '../http.js';
import type { WebServerOptions } from '../types.js';
import type { QuotaSnapshot } from '../../sentry/models.js';

export async function handleGetQuota(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  method: string
): Promise<void> {
  if (method !== 'GET') return methodNotAllowed(res);

  try {
    let snapshots: QuotaSnapshot[] = [];
    if (options.quotaClient) {
      snapshots = await options.quotaClient.fetchQuota();
    } else if (options.sentryState) {
      const pools = options.sentryState.getState().pools ?? {};
      snapshots = Object.entries(pools).map(([poolId, pool]) => {
        const resetDate = new Date(pool.resetTime);
        const hoursUntil = Math.max(
          0,
          Math.round(((resetDate.getTime() - Date.now()) / 3600000) * 10) / 10
        );
        const family = poolId.includes('flash')
          ? 'gemini-flash'
          : poolId.includes('argon') || poolId.includes('pro')
            ? 'gemini-argon'
            : 'claude';
        const displayName =
          family === 'gemini-flash'
            ? 'Gemini Flash'
            : family === 'gemini-argon'
              ? 'Gemini Argon'
              : 'Claude Sonnet';

        return {
          poolId,
          family,
          displayName,
          remainingFraction: pool.remainingFraction,
          resetTime: pool.resetTime,
          hoursUntilReset: hoursUntil,
          overageEnabled: false,
          models: [],
        };
      });
    }
    return sendJson(res, 200, snapshots);
  } catch (err: any) {
    return sendJson(res, 500, { error: 'Failed to fetch quota', message: err?.message });
  }
}

export function handleGetAlerts(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  method: string
): void {
  if (method !== 'GET') return methodNotAllowed(res);
  const alertData = options.sentryState?.getState() ?? {
    version: 1,
    lastProbeAt: new Date().toISOString(),
    lastProbeSource: 'unreachable',
    pools: {},
  };
  return sendJson(res, 200, alertData);
}
