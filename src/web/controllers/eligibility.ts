import type http from 'node:http';
import { sendJson, methodNotAllowed } from '../http.js';
import type { WebServerOptions } from '../types.js';
import { resolveCoordinator } from './dispatch.js';
import type { QuotaSnapshot } from '../../sentry/models.js';
import { calculateHoursUntilReset } from '../../sentry/models.js';
import { headroomPercentOf } from '../../sentry/store.js';
import { calculateEffectiveHeadroomPercent } from '../../coordinator/models.js';

const AUTONOMY_QUENCH_MS = 2 * 60 * 60 * 1000;

const bucketPercent = (bucket: QuotaSnapshot['weekly']): number | null => {
  if (!bucket || bucket.disabled === true) return null;
  if (typeof bucket.remainingFraction !== 'number') return null;
  if (!Number.isFinite(bucket.remainingFraction)) return null;
  return headroomPercentOf(bucket.remainingFraction);
};

const resolveLimitingWindow = (pool: QuotaSnapshot): 'weekly' | 'short_term' => {
  const candidates: Array<{ window: 'weekly' | 'short_term'; fraction: number }> = [];
  if (typeof pool.remainingFraction === 'number' && Number.isFinite(pool.remainingFraction)) {
    candidates.push({ window: 'weekly', fraction: pool.remainingFraction });
  }
  if (
    pool.weekly &&
    pool.weekly.disabled !== true &&
    Number.isFinite(pool.weekly.remainingFraction)
  ) {
    candidates.push({ window: 'weekly', fraction: pool.weekly.remainingFraction });
  }
  if (
    pool.shortTerm &&
    pool.shortTerm.disabled !== true &&
    Number.isFinite(pool.shortTerm.remainingFraction)
  ) {
    candidates.push({ window: 'short_term', fraction: pool.shortTerm.remainingFraction });
  }
  if (candidates.length === 0) return 'weekly';
  const min = candidates.reduce((a, b) => (b.fraction <= a.fraction ? b : a));
  return min.window;
};

const findPool = (pools: QuotaSnapshot[], poolGroup: string | null): QuotaSnapshot | undefined => {
  if (!poolGroup) return undefined;
  return pools.find((pool) => pool.poolId === poolGroup || pool.poolGroup === poolGroup);
};

export const handleDispatchEligibility = (
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  url: URL,
  method: string
): void => {
  if (method !== 'GET') return methodNotAllowed(res);
  if (!options.coordinator && !options.configStore) {
    return sendJson(res, 503, { error: 'Coordinator is unavailable' });
  }

  const params = url.searchParams;
  const requestedModel = params.get('model')?.trim() || undefined;
  const allowOverageParam = params.get('allowOverage');
  const allowOverage = allowOverageParam === '1' || allowOverageParam === 'true';

  try {
    const resolved = options.configStore.resolveConfig();
    const coordinator = resolveCoordinator(options);

    const eligibility = coordinator.evaluateEligibility({
      model: requestedModel,
      scheduleMode: 'immediate',
      allowOverage,
    });

    const pool = findPool(coordinator.getActivePools(), eligibility.poolGroup);
    const nowMs = Date.now();

    const onlineRunners = coordinator
      .listRunners()
      .filter((runner) => runner.enabled && runner.status !== 'offline').length;
    const willRunNow = onlineRunners > 0;

    const lastManualDispatchAt = coordinator.getLastManualDispatchAt();
    const quenchRemainingMs =
      lastManualDispatchAt > 0 ? Math.max(0, lastManualDispatchAt + AUTONOMY_QUENCH_MS - nowMs) : 0;

    const telemetryState = options.sentryState?.getState();

    const warnings: string[] = [];
    if (!willRunNow) {
      warnings.push('No runner online: the task will queue, not run.');
    }

    const hoursUntilReset = pool
      ? typeof pool.hoursUntilReset === 'number' && pool.hoursUntilReset > 0
        ? pool.hoursUntilReset
        : calculateHoursUntilReset(pool.resetTime, nowMs)
      : null;

    const effectivePercent = pool
      ? (calculateEffectiveHeadroomPercent(pool) ?? eligibility.effectiveHeadroomPercent)
      : null;

    const coordinatorEnabled = resolved.coordinatorEnabled !== false;
    const accepts = eligibility.allowed && coordinatorEnabled;
    const code = coordinatorEnabled ? (eligibility.code ?? null) : 'COORDINATOR_DISABLED';
    const reason = coordinatorEnabled
      ? (eligibility.reason ?? null)
      : 'Coordinator is disabled while running in alerting-only mode. Enable coordinator in settings or set COORDINATOR_ENABLED=true.';

    return sendJson(
      res,
      200,
      {
        evaluatedAt: new Date(nowMs).toISOString(),
        accepts,
        willRunNow,
        code,
        reason,
        model: eligibility.resolvedModel,
        poolGroup: eligibility.poolGroup,
        pool: pool
          ? {
              poolId: pool.poolId,
              displayName: pool.displayName || pool.poolId,
              weeklyPercent: bucketPercent(pool.weekly),
              shortTermPercent: bucketPercent(pool.shortTerm),
              effectivePercent,
              limitingWindow: resolveLimitingWindow(pool),
              hoursUntilReset,
              resetTime: pool.resetTime,
            }
          : null,
        floorPercent: resolved.minDispatchHeadroomPercent,
        allowOverage,
        autonomy: { quenched: quenchRemainingMs > 0, remainingMs: quenchRemainingMs },
        runners: { online: onlineRunners },
        telemetry: {
          probeSource: telemetryState?.lastProbeSource ?? 'unreachable',
          lastProbeAt: telemetryState?.lastProbeAt ?? null,
          authRequired: Boolean(telemetryState?.authRequired),
          authErrorMessage: telemetryState?.authErrorMessage ?? null,
        },
        warnings,
      },
      { 'Cache-Control': 'no-store' }
    );
  } catch (err: any) {
    return sendJson(res, 500, {
      error: 'Failed to evaluate dispatch eligibility',
      code: err?.code,
    });
  }
};
