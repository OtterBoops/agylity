import type http from 'node:http';
import type { WebServerOptions } from './types.js';
import {
  MAX_BODY_BYTES,
  PayloadTooLargeError,
  sendPayloadTooLarge,
  readBody,
  sendJson,
  methodNotAllowed,
} from './http.js';
import {
  resolvePublicFilePath,
  resolveIndexHtmlPath,
  loadIndexHtml,
  handleStaticAsset,
  handleIndexHtml,
} from './controllers/static.js';
import { handleGetQuota, handleGetAlerts } from './controllers/quota.js';
import { handleGetLogs } from './controllers/logs.js';
import {
  handleConfigEndpoint,
  handleDeleteConfigOverride,
  sanitizeConfigForClient,
  getSecretsMeta,
} from './controllers/config.js';
import { handleTestNotify } from './controllers/notify.js';
import { handleGetDispatches, handlePostDispatch } from './controllers/dispatch.js';

export type { WebServerOptions };
export {
  MAX_BODY_BYTES,
  PayloadTooLargeError,
  sendPayloadTooLarge,
  readBody,
  resolvePublicFilePath,
  resolveIndexHtmlPath,
  loadIndexHtml,
  sanitizeConfigForClient,
  getSecretsMeta,
};

export const handleRequest = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions
): Promise<void> => {
  try {
    const host = req.headers.host || '127.0.0.1';
    const url = new URL(req.url ?? '/', `http://${host}`);
    const { pathname } = url;
    const method = req.method ?? 'GET';

    if (pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }

    // Static Assets (/assets/*, /vendor/*, SVG/images/icons)
    if (
      pathname.startsWith('/assets/') ||
      pathname.startsWith('/vendor/') ||
      pathname.endsWith('.svg') ||
      pathname.endsWith('.png') ||
      pathname.endsWith('.ico')
    ) {
      return handleStaticAsset(req, res, pathname, method);
    }

    // Root SPA Dashboard
    if (pathname === '/') {
      return handleIndexHtml(req, res, method);
    }

    // Quota Snapshot
    if (pathname === '/api/quota') {
      return handleGetQuota(req, res, options, method);
    }

    // Alert State
    if (pathname === '/api/alerts') {
      return handleGetAlerts(req, res, options, method);
    }

    // In-Memory Ring Buffer Logs
    if (pathname === '/api/logs') {
      return handleGetLogs(req, res, options, url, method);
    }

    // Dispatch History
    if (pathname === '/api/dispatches') {
      return handleGetDispatches(req, res, options, url, method);
    }

    // Config GET & POST
    if (pathname === '/api/config') {
      return handleConfigEndpoint(req, res, options, method);
    }

    // Config Override DELETE
    if (pathname.startsWith('/api/config/')) {
      return handleDeleteConfigOverride(req, res, options, pathname, method);
    }

    // Notification Testing
    if (pathname === '/api/notify/test') {
      return handleTestNotify(req, res, options, method);
    }

    // Task Dispatch
    if (pathname === '/api/dispatch') {
      return handlePostDispatch(req, res, options, method);
    }

    // Route Guard 404
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
  } catch (err: any) {
    if (err instanceof PayloadTooLargeError || err?.statusCode === 413) {
      sendPayloadTooLarge(req, res, err?.message);
      return;
    }
    throw err;
  }
};
