import type http from 'node:http';
import { sendJson, methodNotAllowed } from '../http.js';
import { logger } from '../../logs/logger.js';
import type { WebServerOptions } from '../types.js';
import type { QuotaFamily, QuotaSnapshot } from '../../sentry/models.js';
import { computeBurnProjection, snapshotsFromSentryState } from '../../sentry/models.js';
import type { SentryStateManager } from '../../sentry/state.js';

const withCatalogModels = (
  snapshots: QuotaSnapshot[],
  options: WebServerOptions
): QuotaSnapshot[] => {
  if (!options.modelCatalog) return snapshots;
  const catalog = options.modelCatalog.getModels();
  if (catalog.length === 0) return snapshots;

  const labelsByFamily = new Map<QuotaFamily, string[]>();
  for (const entry of catalog) {
    const labels = labelsByFamily.get(entry.family) ?? [];
    labels.push(entry.label);
    labelsByFamily.set(entry.family, labels);
  }

  return snapshots.map((snapshot) => {
    const labels = labelsByFamily.get(snapshot.family);
    return labels && labels.length > 0 ? { ...snapshot, models: labels } : snapshot;
  });
};

const withStoredProjections = (
  snapshots: QuotaSnapshot[],
  sentryState: SentryStateManager
): QuotaSnapshot[] => {
  const pools = sentryState.getState().pools;
  return snapshots.map((snapshot) => {
    const pool = pools[snapshot.poolId];
    if (!pool?.samples || pool.samples.length === 0) return snapshot;
    const burnProjection = computeBurnProjection({
      samples: pool.samples,
      resetTime: snapshot.resetTime,
    });
    return burnProjection ? { ...snapshot, burnProjection } : snapshot;
  });
};

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
      // ?refresh=1 forces a probe; otherwise a manual refresh can be served the 30s cache.
      const force = new URL(req.url ?? '/', 'http://localhost').searchParams.get('refresh') === '1';
      const probed = await options.quotaClient.fetchQuota(force);
      snapshots = options.sentryState ? withStoredProjections(probed, options.sentryState) : probed;
    } else if (options.sentryState) {
      snapshots = snapshotsFromSentryState(options.sentryState.getState());
    }
    return sendJson(res, 200, withCatalogModels(snapshots, options), {
      'Cache-Control': 'no-store',
    });
  } catch (err: any) {
    const statusCode = err?.code === 'AUTH_REQUIRED' ? 401 : 500;
    logger.child('web').error('Quota fetch failed: %s', err?.stack ?? err);
    return sendJson(res, statusCode, {
      error: err?.code === 'AUTH_REQUIRED' ? 'Authentication Required' : 'Failed to fetch quota',
      code: err?.code,
    });
  }
};

export const handleGetSummary = (
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  method: string
): void => {
  if (method !== 'GET') return methodNotAllowed(res);

  const snapshots = options.sentryState
    ? snapshotsFromSentryState(options.sentryState.getState())
    : [];
  const percentFor = (family: QuotaFamily): number | null => {
    const match = snapshots.find((s) => s.family === family || s.poolId === family);
    return match ? Math.round(match.remainingFraction * 100) : null;
  };

  return sendJson(
    res,
    200,
    {
      hydrogenPercent: percentFor('gemini-hydrogen'),
      argonPercent: percentFor('gemini-argon'),
      claudePercent: percentFor('claude'),
      agyVersion: options.agyUpdater?.getCachedVersion() ?? null,
    },
    { 'Cache-Control': 'no-store' }
  );
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
  return sendJson(res, 200, alertData, { 'Cache-Control': 'no-store' });
};

export const handleDismissAlerts = async (
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  method: string
): Promise<void> => {
  if (method !== 'POST') return methodNotAllowed(res);
  if (!options.sentryState) {
    return sendJson(res, 503, { error: 'Sentry state is unavailable' });
  }

  const dismissed = options.sentryState.dismissEarlyResetNotice();
  try {
    await options.sentryState.save();
  } catch (err: any) {
    logger.child('web').error('Failed to persist alert dismissal: %s', err?.message ?? err);
    return sendJson(res, 500, { error: 'Failed to persist dismissal' });
  }

  return sendJson(res, 200, { success: true, dismissed, earlyResetNotice: null });
};
