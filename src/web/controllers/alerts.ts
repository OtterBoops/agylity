import type http from 'node:http';
import { sendJson, methodNotAllowed } from '../http.js';
import type { WebServerOptions } from '../types.js';

export const handleGetAlertEvents = (
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  url: URL,
  method: string
): void => {
  if (method !== 'GET') return methodNotAllowed(res);
  if (!options.sentryState) {
    return sendJson(res, 503, { error: 'Sentry state is unavailable' });
  }

  const params = url.searchParams;
  // The store clamps and defaults the page size, so only a usable number is forwarded.
  const rawLimit = params.get('limit');
  const parsedLimit = rawLimit === null ? undefined : Number(rawLimit);
  const limit = Number.isFinite(parsedLimit) ? parsedLimit : undefined;
  const before = params.get('before');
  const pool = params.get('pool');

  try {
    const page = options.sentryState.listAlertEvents({
      limit,
      before,
      poolId: pool && pool.trim() !== '' ? pool.trim() : null,
    });
    return sendJson(res, 200, page, { 'Cache-Control': 'no-store' });
  } catch (err: any) {
    return sendJson(res, 500, { error: 'Failed to read alert history', code: err?.code });
  }
};
