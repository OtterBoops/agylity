import type http from 'node:http';
import { sendJson, methodNotAllowed, readBody } from '../http.js';
import type { WebServerOptions } from '../types.js';
import { logger } from '../../logs/logger.js';

export function handleGetDispatches(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  url: URL,
  method: string
): void {
  if (method !== 'GET') return methodNotAllowed(res);
  const limit = Number(url.searchParams.get('limit') ?? 50);
  const rows = options.configStore
    .getDatabase()
    .listDispatches(Number.isFinite(limit) ? limit : 50);
  return sendJson(res, 200, rows, { 'Cache-Control': 'no-store' });
}

export async function handlePostDispatch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  method: string
): Promise<void> {
  const log = options.logger ?? logger.child('web');
  if (method !== 'POST') return methodNotAllowed(res);

  const body = await readBody(req, res);
  if (!body.trim()) return sendJson(res, 400, { error: 'Request body cannot be empty' });

  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { error: 'Malformed JSON payload' });
  }

  if (!payload || typeof payload !== 'object' || !payload.repositoryName) {
    return sendJson(res, 400, { error: 'repositoryName is required' });
  }

  const repositoryName = String(payload.repositoryName);
  const allowOverage = Boolean(payload.allowOverage);

  const resolved = options.configStore.resolveConfig();
  const minHeadroom = resolved.minDispatchHeadroomPercent ?? 10;

  // Safety Floor Check: Prevent paid credit consumption & overage billing
  const pools = options.sentryState?.getState()?.pools
    ? Object.values(options.sentryState.getState().pools)
    : [];
  if (pools.length > 0) {
    const maxHeadroomPct = Math.max(...pools.map((p) => (p.remainingFraction ?? 0) * 100));
    if (maxHeadroomPct < minHeadroom && !allowOverage) {
      log.warn(
        'Task dispatch blocked for "%s": remaining headroom (%d%%) is below safety floor (%d%%)',
        repositoryName,
        Math.round(maxHeadroomPct),
        minHeadroom
      );
      return sendJson(res, 400, {
        success: false,
        error: `Overage Protection: Remaining quota (${Math.round(maxHeadroomPct)}%) is below the safety floor (${minHeadroom}%). Dispatch locked to prevent paid AI overages or credit consumption. Pass allowOverage: true to override.`,
        code: 'OVERAGE_PROTECTION_TRIGGERED',
        minDispatchHeadroomPercent: minHeadroom,
        currentHeadroomPercent: Math.round(maxHeadroomPct),
      });
    }
  }

  // Check if task orchestrator is enabled
  if (!resolved.orchestratorEnabled) {
    return sendJson(res, 200, {
      success: false,
      error:
        'Task orchestrator is disabled while running in alerting-only mode. Enable orchestrator in settings or set ORCHESTRATOR_ENABLED=true.',
      code: 'ORCHESTRATOR_DISABLED',
      dispatchId: `disp-${Date.now()}`,
      repo: repositoryName,
    });
  }

  return sendJson(res, 200, {
    success: false,
    error: 'Task dispatch is disabled while running in alerting-only mode.',
    dispatchId: `disp-${Date.now()}`,
    repo: repositoryName,
  });
}
