import type http from 'node:http';
import { sendJson, methodNotAllowed } from '../http.js';
import type { WebServerOptions } from '../types.js';
import { LOG_LEVELS, type LogLevel } from '../../logs/buffer.js';

export const handleGetLogs = (
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  url: URL,
  method: string
): void => {
  if (method !== 'GET') return methodNotAllowed(res);

  const since = Number(url.searchParams.get('since') ?? 0);
  const levelParam = url.searchParams.get('level') ?? 'debug';
  const level: LogLevel = LOG_LEVELS.includes(levelParam as LogLevel)
    ? (levelParam as LogLevel)
    : 'debug';

  const entries = options.logBuffer
    ? options.logBuffer.since(Number.isFinite(since) ? since : 0, level)
    : [];

  return sendJson(
    res,
    200,
    { enabled: Boolean(options.logBuffer), latestId: options.logBuffer?.latestId ?? 0, entries },
    { 'Cache-Control': 'no-store' }
  );
};
