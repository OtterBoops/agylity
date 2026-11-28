import type http from 'node:http';
import { resolveWebUiAuthToken } from '../config/schema.js';
import crypto from 'node:crypto';
import type { WebServerOptions } from './types.js';
import { logger } from '../logs/logger.js';
import { extractClientIp, isIpAllowed, isLoopbackIp, normalizeIp } from '../net/ip.js';
import { PayloadTooLargeError, sendPayloadTooLarge, sendJson } from './http.js';
import { handleStaticAsset, handleIndexHtml } from './controllers/static.js';
import { matchRoute, routeAuthFor } from './routeRegistry.js';
import { clearAuthFailures, isIpRateLimited, recordAuthFailure } from './authFailures.js';

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

// Re-exported so a test can reset the module-level lockout table.
export { clearAuthFailures };

// A browser sends Origin (and usually Sec-Fetch-Site) on every cross-site write; any other client
// sends neither, so this blocks a hostile page driving the loopback control plane while leaving
// runners, curl and the dashboard untouched.
const isCrossSiteWrite = (req: http.IncomingMessage): boolean => {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site.trim() !== '') {
    // The browser's own verdict: a port or subdomain change is not the dashboard, and 'none' is a
    // user-initiated navigation rather than another page's fetch.
    const value = site.trim().toLowerCase();
    return value !== 'same-origin' && value !== 'none';
  }

  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.trim() === '') return false;
  const host = req.headers.host;
  if (typeof host !== 'string' || host.trim() === '') return true;

  // Without Sec-Fetch-Site the port matters: another service on loopback is a different origin.
  const trimmedHost = host.trim();
  if (/[\s/?#@]/.test(trimmedHost)) return true;
  try {
    const originUrl = new URL(origin);
    if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') return true;
    // Parsing Host under the Origin's scheme normalizes explicit default ports (:80 / :443).
    const requestUrl = new URL(`${originUrl.protocol}//${trimmedHost}`);
    return originUrl.host.toLowerCase() !== requestUrl.host.toLowerCase();
  } catch {
    return true;
  }
};

const sendCrossSiteRefused = (res: http.ServerResponse): void => {
  sendJson(res, 403, { error: 'Forbidden: cross-site request' });
};

const sendRateLimited = (res: http.ServerResponse): void => {
  sendJson(
    res,
    429,
    {
      error:
        'Too Many Requests: IP temporarily blocked due to repeated failed authentication attempts',
      retryAfterSeconds: 60,
    },
    { 'Retry-After': '60' }
  );
};

export const handleRequest = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  shutdownSignal?: AbortSignal
): Promise<void> => {
  try {
    // A constant base: a malformed Host header must not make routing throw.
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;
    // Node drops the body of a HEAD response itself, so only the routing decision needs the GET.
    const method = req.method === 'HEAD' ? 'GET' : (req.method ?? 'GET');

    const resolvedConfig = options.configStore?.resolveConfig();
    const allowedRanges = resolvedConfig?.allowedIpRanges ?? [];
    const trustedProxies = resolvedConfig?.trustedProxies ?? false;
    const trustedProxyRanges = resolvedConfig?.trustedProxyRanges ?? [];

    const clientIp = extractClientIp(req, trustedProxies, trustedProxyRanges);

    if (!isIpAllowed(clientIp, allowedRanges)) {
      logger
        .child('security')
        .warn('Rejected connection from unauthorized IP: %s (path: %s)', clientIp, pathname);
      return sendJson(res, 403, { error: 'Forbidden: IP not in allowlist', clientIp });
    }

    const expectedToken = resolveWebUiAuthToken(resolvedConfig);
    const peerIp = normalizeIp(req.socket?.remoteAddress ?? '');
    const isLocalhost = isLoopbackIp(clientIp) && isLoopbackIp(peerIp);
    const exemptLocalhost = resolvedConfig?.webUiAuthExemptLocalhost ?? true;
    const authRequired = Boolean(expectedToken) && !(isLocalhost && exemptLocalhost);

    if (method !== 'GET' && method !== 'HEAD' && isCrossSiteWrite(req)) {
      logger.child('security').warn('Rejected cross-site %s %s', method, pathname);
      return sendCrossSiteRefused(res);
    }

    const routeAuth = routeAuthFor(pathname);

    // A runner credential is brute-forceable too, so it keeps its own lockout counter.
    if (routeAuth === 'runner' && isIpRateLimited(clientIp, 'runner')) {
      return sendRateLimited(res);
    }

    if (authRequired && expectedToken && routeAuth === 'bearer') {
      if (isIpRateLimited(clientIp, 'control')) {
        logger
          .child('security')
          .warn(
            'Temporarily blocked brute-force requests from IP: %s (path: %s)',
            clientIp,
            pathname
          );
        return sendRateLimited(res);
      }

      if (!isAuthorized(req, expectedToken)) {
        const isBlocked = recordAuthFailure(clientIp, 'control');
        if (isBlocked) {
          logger
            .child('security')
            .warn('Rate limit threshold engaged for IP: %s (10 failed auth attempts)', clientIp);
          return sendRateLimited(res);
        }
        return sendJson(res, 401, { error: 'Unauthorized: Invalid or missing Bearer token' });
      }

      clearAuthFailures(clientIp, 'control');
    }

    if (pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
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

    const matched = matchRoute(pathname);
    if (matched) {
      return await matched.route.invoke({
        req,
        res,
        options,
        url,
        pathname,
        method,
        params: matched.params,
        authRequired,
        shutdownSignal,
      });
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
