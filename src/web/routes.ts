import type http from 'node:http';
import { resolveWebUiAuthToken } from '../config/schema.js';
import crypto from 'node:crypto';
import type { WebServerOptions } from './types.js';
import { logger } from '../logs/logger.js';
import { extractClientIp, isIpAllowed, isLoopbackIp, normalizeIp } from './ip.js';
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
import {
  handleGetDispatches,
  handlePostDispatch,
  handleGetModels,
  handleGetTasks,
  handlePollTasks,
  handleTaskStatus,
  handleTaskCancel,
  handleTaskRetry,
  handleGetRunners,
  handleCreateRegistrationToken,
  handleRegisterRunner,
  handleManageRunnerById,
} from './controllers/dispatch.js';
import {
  handleBacklogTasks,
  handleBacklogTaskById,
  handleSyncGithubBacklog,
} from './controllers/backlog.js';
import { handleRoutineTasks, handleRoutineTaskById } from './controllers/routines.js';

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

const isAuthorized = (req: http.IncomingMessage, expectedToken: string): boolean => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }
  const token = authHeader.slice(7).trim();
  // Compare fixed-width digests: a raw Buffer compare returns early on a length mismatch,
  // which leaks the expected token's length through response timing.
  const tokenDigest = crypto.createHash('sha256').update(token).digest();
  const expectedDigest = crypto.createHash('sha256').update(expectedToken).digest();
  return crypto.timingSafeEqual(tokenDigest, expectedDigest);
};

interface AuthFailureRecord {
  failures: number;
  blockedUntilMs: number;
  lastFailureMs: number;
}

const authFailuresByIp = new Map<string, AuthFailureRecord>();

const AUTH_FAILURE_WINDOW_MS = 60_000;
const AUTH_FAILURE_MAX_ENTRIES = 10_000;

/** Entries are only otherwise removed on a successful auth, so a flood must not grow the map. */
const pruneAuthFailures = (now: number): void => {
  for (const [ip, record] of authFailuresByIp) {
    if (record.blockedUntilMs <= now && now - record.lastFailureMs > AUTH_FAILURE_WINDOW_MS) {
      authFailuresByIp.delete(ip);
    }
  }

  while (authFailuresByIp.size > AUTH_FAILURE_MAX_ENTRIES) {
    let oldestIp: string | null = null;
    let oldestMs = Number.POSITIVE_INFINITY;
    for (const [ip, record] of authFailuresByIp) {
      if (record.lastFailureMs < oldestMs) {
        oldestMs = record.lastFailureMs;
        oldestIp = ip;
      }
    }
    if (oldestIp === null) break;
    authFailuresByIp.delete(oldestIp);
  }
};

export const recordAuthFailure = (clientIp: string): boolean => {
  const now = Date.now();
  const record = authFailuresByIp.get(clientIp) ?? {
    failures: 0,
    blockedUntilMs: 0,
    lastFailureMs: now,
  };

  if (now - record.lastFailureMs > AUTH_FAILURE_WINDOW_MS) {
    record.failures = 0;
    record.blockedUntilMs = 0;
  }

  record.failures++;
  record.lastFailureMs = now;

  if (record.failures >= 10) {
    record.blockedUntilMs = now + AUTH_FAILURE_WINDOW_MS;
  }

  authFailuresByIp.set(clientIp, record);
  pruneAuthFailures(now);
  return record.blockedUntilMs > now;
};

export const isIpRateLimited = (clientIp: string): boolean => {
  const record = authFailuresByIp.get(clientIp);
  if (!record) return false;
  return record.blockedUntilMs > Date.now();
};

export const clearAuthFailures = (clientIp: string): void => {
  authFailuresByIp.delete(clientIp);
};

const isControlPlaneRoute = (pathname: string): boolean => {
  if (!pathname.startsWith('/api/')) return false;
  if (pathname === '/api/health') return false;
  // Outbound pull-runner endpoints (authenticated independently via runnerToken)
  if (pathname === '/api/tasks/poll') return false;
  if (pathname.startsWith('/api/tasks/') && pathname.endsWith('/status')) return false;
  if (pathname === '/api/runners/register') return false;

  // All other API routes require WEB_UI_AUTH_TOKEN
  return true;
};

export const handleRequest = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions
): Promise<void> => {
  try {
    // A constant base: a malformed Host header must not make routing throw.
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;
    const method = req.method ?? 'GET';

    const resolvedConfig = options.configStore?.resolveConfig();
    const allowedRanges = resolvedConfig?.allowedIpRanges ?? [];
    const trustedProxies = resolvedConfig?.trustedProxies ?? false;

    const clientIp = extractClientIp(req, trustedProxies);

    // Application-Native IP Whitelisting: Off by default, strictly enforced when entries exist
    if (allowedRanges.length > 0) {
      if (!isIpAllowed(clientIp, allowedRanges)) {
        logger
          .child('security')
          .warn('Rejected connection from unauthorized IP: %s (path: %s)', clientIp, pathname);
        return sendJson(res, 403, { error: 'Forbidden: IP not in allowlist', clientIp });
      }
    }

    const expectedToken = resolveWebUiAuthToken(resolvedConfig);
    const peerIp = normalizeIp(req.socket?.remoteAddress || '127.0.0.1');
    const isLocalhost = isLoopbackIp(clientIp) && isLoopbackIp(peerIp);
    const exemptLocalhost = resolvedConfig?.webUiAuthExemptLocalhost ?? true;
    const authRequired = Boolean(expectedToken) && !(isLocalhost && exemptLocalhost);

    if (authRequired && expectedToken && isControlPlaneRoute(pathname)) {
      if (isIpRateLimited(clientIp)) {
        logger
          .child('security')
          .warn(
            'Temporarily blocked brute-force requests from IP: %s (path: %s)',
            clientIp,
            pathname
          );
        return sendJson(
          res,
          429,
          {
            error:
              'Too Many Requests: IP temporarily blocked due to repeated failed authentication attempts',
            retryAfterSeconds: 60,
          },
          { 'Retry-After': '60' }
        );
      }

      if (!isAuthorized(req, expectedToken)) {
        const isBlocked = recordAuthFailure(clientIp);
        if (isBlocked) {
          logger
            .child('security')
            .warn('Rate limit threshold engaged for IP: %s (10 failed auth attempts)', clientIp);
          return sendJson(
            res,
            429,
            {
              error:
                'Too Many Requests: IP temporarily blocked due to repeated failed authentication attempts',
              retryAfterSeconds: 60,
            },
            { 'Retry-After': '60' }
          );
        }
        return sendJson(res, 401, { error: 'Unauthorized: Invalid or missing Bearer token' });
      }

      clearAuthFailures(clientIp);
    }

    if (pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }

    // Healthcheck probe
    if (pathname === '/api/health') {
      if (method !== 'GET') {
        return methodNotAllowed(res);
      }
      return sendJson(res, 200, {
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        authRequired,
      });
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

    // Client-side SPA routes (preact-router HTML5 history navigation). Deriving the fallback
    // from the path shape keeps a new client route from 404ing on a hard refresh.
    if (!pathname.startsWith('/api/') && !pathname.slice(1).includes('.')) {
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

    // Available Model Catalog & Live Pool Headroom
    if (pathname === '/api/models') {
      return handleGetModels(req, res, options, method);
    }

    // Swarm Task Queue Listing
    if (pathname === '/api/tasks') {
      return handleGetTasks(req, res, options, url, method);
    }

    // Swarm Worker Outbound Long-Poll Claim
    if (pathname === '/api/tasks/poll') {
      return handlePollTasks(req, res, options, method);
    }

    // Swarm Task Status & Completion Callback
    if (pathname.startsWith('/api/tasks/') && pathname.endsWith('/status')) {
      return handleTaskStatus(req, res, options, pathname, method);
    }

    // Task Cancel / Abort
    if (pathname.startsWith('/api/tasks/') && pathname.endsWith('/cancel')) {
      return handleTaskCancel(req, res, options, pathname, method);
    }

    // Task Retry / Re-run
    if (pathname.startsWith('/api/tasks/') && pathname.endsWith('/retry')) {
      return handleTaskRetry(req, res, options, pathname, method);
    }

    // Backlog Tasks CRUD, Trigger & GitHub Sync
    if (pathname === '/api/backlog/sync-github') {
      return handleSyncGithubBacklog(req, res, options, method);
    }

    if (pathname === '/api/backlog') {
      return handleBacklogTasks(req, res, options, url, method);
    }

    if (pathname.startsWith('/api/backlog/')) {
      return handleBacklogTaskById(req, res, options, pathname, method);
    }

    // Routine Tasks CRUD & Trigger
    if (pathname === '/api/routines') {
      return handleRoutineTasks(req, res, options, url, method);
    }

    if (pathname.startsWith('/api/routines/')) {
      return handleRoutineTaskById(req, res, options, pathname, method);
    }

    // Registered Swarm Runners & Runner Registration Flow
    if (pathname === '/api/runners') {
      return handleGetRunners(req, res, options, method);
    }

    if (pathname === '/api/runners/registration-token') {
      return handleCreateRegistrationToken(req, res, options, method);
    }

    if (pathname === '/api/runners/register') {
      return handleRegisterRunner(req, res, options, method);
    }

    if (pathname.startsWith('/api/runners/')) {
      return handleManageRunnerById(req, res, options, pathname, method);
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
