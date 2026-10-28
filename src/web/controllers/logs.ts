import type http from 'node:http';
import { sendJson, methodNotAllowed } from '../http.js';
import type { WebServerOptions } from '../types.js';
import type { LogLevel } from '../../logs/buffer.js';

export function handleGetLogs(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  url: URL,
  method: string
): void {
  if (method !== 'GET') return methodNotAllowed(res);

  const since = Number(url.searchParams.get('since') ?? 0);
  const levelParam = url.searchParams.get('level') ?? 'debug';
  const level: LogLevel = (['debug', 'info', 'warn', 'error'] as const).includes(
    levelParam as LogLevel
  )
    ? (levelParam as LogLevel)
    : 'debug';

  const entries = options.logBuffer
    ? options.logBuffer.since(Number.isFinite(since) ? since : 0, level)
    : [];

  return sendJson(
    res,
    200,
    { enabled: Boolean(options.logBuffer), entries },
    { 'Cache-Control': 'no-store' }
  );
}
