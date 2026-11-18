import type http from 'node:http';
import { resolveWebUiAuthToken } from '../config/schema.js';
import crypto from 'node:crypto';
import type { WebServerOptions } from './types.js';
import { logger } from '../logs/logger.js';
import { extractClientIp, isIpAllowed, isLoopbackIp, normalizeIp } from './ip.js';
import { PayloadTooLargeError, sendPayloadTooLarge, sendJson, methodNotAllowed } from './http.js';
import { handleStaticAsset, handleIndexHtml } from './controllers/static.js';
import { handleGetQuota, handleGetAlerts, handleDismissAlerts } from './controllers/quota.js';
import { handleGetAlertEvents } from './controllers/alerts.js';
import { handleDispatchEligibility } from './controllers/eligibility.js';
import { handleGetLogs } from './controllers/logs.js';
import { handleConfigEndpoint, handleDeleteConfigOverride } from './controllers/config.js';
import { handleTestNotify } from './controllers/notify.js';
import {
  handlePostDispatch,
  handleGetModels,
  handleGetTasks,
  handleGetTaskById,
  handlePollTasks,
  handleRunnerHeartbeat,
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
  handleBulkBacklogTasks,
  handleSyncGithubBacklog,
} from './controllers/backlog.js';
import { handleRoutineTasks, handleRoutineTaskById } from './controllers/routines.js';

export type { WebServerOptions };

const isAuthorized = (req: http.IncomingMessage, expectedToken: string): boolean => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }
  const token = authHeader.slice(7).trim();
  // Fixed-width digests: a Buffer compare returns early on a length mismatch and leaks token length in timing.
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
  if (pathname === '/api/runner/heartbeat') return false;
  if (pathname.startsWith('/api/tasks/') && pathname.endsWith('/status')) return false;
  if (pathname === '/api/runners/register') return false;

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

    if (pathname === '/api/health') {
      if (method !== 'GET') {
        return methodNotAllowed(res);
      }
      // Cache-only: a healthcheck must answer while `agy update` is rewriting the binary.
      void options.agyUpdater?.getVersion();
      return sendJson(res, 200, {
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        authRequired,
        agyVersion: options.agyUpdater?.getCachedVersion() ?? null,
      });
    }

    // Awaited so a rejection lands in this try block; a bare return would skip the 413 mapping below.
    if (
      pathname.startsWith('/assets/') ||
      pathname.startsWith('/vendor/') ||
      pathname.endsWith('.svg') ||
      pathname.endsWith('.png') ||
      pathname.endsWith('.ico')
    ) {
      return await handleStaticAsset(req, res, pathname, method);
    }

    if (!pathname.startsWith('/api/') && !pathname.slice(1).includes('.')) {
      return await handleIndexHtml(req, res, method);
    }

    if (pathname === '/api/quota') {
      return await handleGetQuota(req, res, options, method);
    }

    if (pathname === '/api/alerts') {
      return await handleGetAlerts(req, res, options, method);
    }

    if (pathname === '/api/alerts/dismiss') {
      return await handleDismissAlerts(req, res, options, method);
    }

    if (pathname === '/api/alerts/events') {
      return handleGetAlertEvents(req, res, options, url, method);
    }

    if (pathname === '/api/logs') {
      return await handleGetLogs(req, res, options, url, method);
    }

    if (pathname === '/api/config') {
      return await handleConfigEndpoint(req, res, options, method);
    }

    if (pathname.startsWith('/api/config/')) {
      return await handleDeleteConfigOverride(req, res, options, pathname, method);
    }

    if (pathname === '/api/notify/test') {
      return await handleTestNotify(req, res, options, method);
    }

    if (pathname === '/api/dispatch') {
      return await handlePostDispatch(req, res, options, method);
    }

    if (pathname === '/api/models') {
      return await handleGetModels(req, res, options, method);
    }

    if (pathname === '/api/dispatch/eligibility') {
      return handleDispatchEligibility(req, res, options, url, method);
    }

    if (pathname === '/api/tasks') {
      return await handleGetTasks(req, res, options, url, method);
    }

    if (pathname === '/api/tasks/poll') {
      return await handlePollTasks(req, res, options, method);
    }

    if (pathname === '/api/runner/heartbeat') {
      return await handleRunnerHeartbeat(req, res, options, method);
    }

    if (pathname.startsWith('/api/tasks/') && pathname.endsWith('/status')) {
      return await handleTaskStatus(req, res, options, pathname, method);
    }

    if (pathname.startsWith('/api/tasks/') && pathname.endsWith('/cancel')) {
      return await handleTaskCancel(req, res, options, pathname, method);
    }

    if (pathname.startsWith('/api/tasks/') && pathname.endsWith('/retry')) {
      return await handleTaskRetry(req, res, options, pathname, method);
    }

    if (pathname.startsWith('/api/tasks/') && !pathname.slice('/api/tasks/'.length).includes('/')) {
      return await handleGetTaskById(req, res, options, pathname, method);
    }

    if (pathname === '/api/backlog/sync-github') {
      return await handleSyncGithubBacklog(req, res, options, method);
    }

    if (pathname === '/api/backlog') {
      return await handleBacklogTasks(req, res, options, url, method);
    }

    // Must precede the /api/backlog/<id> branch below, which would otherwise read "bulk" as an id.
    if (pathname === '/api/backlog/bulk') {
      return await handleBulkBacklogTasks(req, res, options, method);
    }

    if (pathname.startsWith('/api/backlog/')) {
      return await handleBacklogTaskById(req, res, options, pathname, method);
    }

    if (pathname === '/api/routines') {
      return await handleRoutineTasks(req, res, options, url, method);
    }

    if (pathname.startsWith('/api/routines/')) {
      return await handleRoutineTaskById(req, res, options, pathname, method);
    }

    if (pathname === '/api/runners') {
      return await handleGetRunners(req, res, options, method);
    }

    if (pathname === '/api/runners/registration-token') {
      return await handleCreateRegistrationToken(req, res, options, method);
    }

    if (pathname === '/api/runners/register') {
      return await handleRegisterRunner(req, res, options, method);
    }

    if (pathname.startsWith('/api/runners/')) {
      return await handleManageRunnerById(req, res, options, pathname, method);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
  } catch (err: any) {
    if (err instanceof PayloadTooLargeError || err?.statusCode === 413) {
      sendPayloadTooLarge(req, res, err?.message);
      return;
    }
    throw err;
  }
};
