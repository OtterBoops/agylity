import type http from 'node:http';
import type { WebServerOptions } from '../types.js';
import { methodNotAllowed, sendJson } from '../http.js';
import { normalizeBuildCommit, resolveBuildChannel } from '../../shared/build.js';

/** Cache-only on purpose: a healthcheck must answer while `agy update` rewrites the binary. */
export const handleHealth = (
  res: http.ServerResponse,
  options: WebServerOptions,
  method: string,
  authRequired: boolean
): void => {
  if (method !== 'GET') {
    methodNotAllowed(res);
    return;
  }
  void options.agyUpdater?.getVersion();
  sendJson(res, 200, {
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    authRequired: Boolean(authRequired),
    agyVersion: options.agyUpdater?.getCachedVersion() ?? null,
    buildChannel: resolveBuildChannel(process.env.BUILD_CHANNEL),
    buildCommit: normalizeBuildCommit(process.env.BUILD_COMMIT),
  });
};
