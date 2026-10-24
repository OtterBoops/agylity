import type http from 'node:http';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConfigStore } from '../config/store.js';
import type { QuotaClient, QuotaSnapshot } from '../sentry/models.js';
import type { SentryStateManager } from '../sentry/state.js';
import type { LogBuffer, LogLevel } from '../logs/buffer.js';
import { logger, type Logger } from '../logs/logger.js';
import { isSecretKey, maskSecret } from '../storage/crypto.js';

export interface WebServerOptions {
  host?: string;
  port?: number;
  configStore: ConfigStore;
  quotaClient?: QuotaClient;
  sentryState?: SentryStateManager;
  logBuffer?: LogBuffer;
  notifier?: import('../notify/types.js').Notifier;
  logger?: Logger;
}

const sanitizeConfigForClient = (config: Record<string, any>) => {
  const result: Record<string, any> = { ...config };
  for (const [k, v] of Object.entries(result)) {
    if (isSecretKey(k)) {
      result[k] = maskSecret(v);
    }
  }
  return result;
};

const getSecretsMeta = (config: Record<string, any>) => {
  const meta: Record<string, { isSet: boolean }> = {};
  for (const [k, v] of Object.entries(config)) {
    if (isSecretKey(k)) {
      meta[k] = { isSet: Boolean(v && typeof v === 'string' && v.trim() !== '') };
    }
  }
  return meta;
};

const sendJson = (
  res: http.ServerResponse,
  status: number,
  data: unknown,
  headers: Record<string, string> = {}
): void => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(data));
};

const methodNotAllowed = (res: http.ServerResponse): void => {
  sendJson(res, 405, { error: 'Method Not Allowed' });
};

const resolvePublicFilePath = (relative: string): string | null => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(currentDir, 'public', relative),
    path.join(currentDir, '..', '..', 'src', 'web', 'public', relative),
    path.join(process.cwd(), 'src', 'web', 'public', relative),
    path.join(process.cwd(), 'dist', 'web', 'public', relative),
  ];
  return candidates.find(existsSync) ?? null;
};

const resolveIndexHtmlPath = (): string =>
  resolvePublicFilePath('index.html') ??
  path.join(process.cwd(), 'src', 'web', 'public', 'index.html');

const loadIndexHtml = async (): Promise<string> => fs.readFile(resolveIndexHtmlPath(), 'utf-8');

export const MAX_BODY_BYTES = 64 * 1024; // 64 KB (65,536 bytes)

export class PayloadTooLargeError extends Error {
  readonly statusCode = 413;

  constructor(message = 'Request body exceeds maximum allowed size of 65536 bytes') {
    super(message);
    this.name = 'PayloadTooLargeError';
  }
}

export const sendPayloadTooLarge = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  message = 'Request body exceeds maximum allowed size of 65536 bytes'
): void => {
  if (res.headersSent) return;

  res.writeHead(413, {
    'Content-Type': 'application/json',
    Connection: 'close',
  });

  const payload = JSON.stringify({
    error: 'Payload Too Large',
    message,
  });

  res.write(payload);

  // If request has already ended or completed, end response immediately
  if (req.readableEnded || req.complete) {
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
    return;
  }

  let cleanupCalled = false;
  let timer: NodeJS.Timeout | undefined;

  const cleanup = () => {
    if (cleanupCalled) return;
    cleanupCalled = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    req.off('data', onData);
    req.off('end', onEnd);
    req.off('error', onError);
    req.off('close', onClose);
    res.off('close', onClose);
    res.off('finish', onClose);
  };

  const safeEnd = (destroySocket = false) => {
    cleanup();
    try {
      if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
    } catch {}
    if (destroySocket) {
      try {
        req.destroy();
      } catch {}
    }
  };

  const onData = () => {
    // Discard incoming chunks to drain the socket receive buffer
  };

  const onEnd = () => {
    safeEnd(false);
  };

  const onClose = () => {
    safeEnd(false);
  };

  const onError = () => {
    safeEnd(false);
  };

  // Safety timeout: abort uncooperative or infinite streams after 3000ms
  timer = setTimeout(() => {
    safeEnd(true);
  }, 3000);
  timer.unref();

  req.on('data', onData);
  req.on('end', onEnd);
  req.on('error', onError);
  req.on('close', onClose);
  res.once('close', onClose);
  res.once('finish', onClose);

  req.resume();
};

export async function readBody(
  req: http.IncomingMessage,
  resOrMaxBytes?: http.ServerResponse | number,
  optionalMaxBytes?: number
): Promise<string> {
  let res: http.ServerResponse | undefined;
  let maxBytes = MAX_BODY_BYTES;

  if (typeof resOrMaxBytes === 'number') {
    maxBytes = resOrMaxBytes;
  } else if (resOrMaxBytes) {
    res = resOrMaxBytes;
    if (typeof optionalMaxBytes === 'number') {
      maxBytes = optionalMaxBytes;
    }
  }

  if (req.readableEnded || req.complete) {
    return '';
  }
  if (req.destroyed) {
    throw new Error('Cannot read body from destroyed request');
  }

  return new Promise<string>((resolve, reject) => {
    let totalBytes = 0;
    const chunks: Buffer[] = [];
    let exceeded = false;

    const onData = (chunk: Buffer | string) => {
      if (exceeded) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;

      if (totalBytes > maxBytes) {
        exceeded = true;
        // Stop buffering immediately to prevent memory growth
        chunks.length = 0;
        cleanup();
        const msg = `Request body exceeds maximum allowed size of ${maxBytes} bytes`;
        if (res && !res.headersSent) {
          sendPayloadTooLarge(req, res, msg);
        }
        reject(new PayloadTooLargeError(msg));
        return;
      }

      chunks.push(buf);
    };

    const onEnd = () => {
      if (exceeded) return;
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf-8'));
    };

    const onError = (err: Error) => {
      if (exceeded) return;
      cleanup();
      reject(err);
    };

    const onClose = () => {
      if (exceeded) return;
      cleanup();
      if (!req.complete && !req.readableEnded) {
        reject(new Error('Request closed before body was fully received'));
      }
    };

    function cleanup() {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

const MIME_TYPES: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

export const handleRequest = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions
): Promise<void> => {
  const log = options.logger ?? logger.child('web');
  try {
    const host = req.headers.host || '127.0.0.1';
    const url = new URL(req.url ?? '/', `http://${host}`);
    const { pathname } = url;
    const method = req.method ?? 'GET';

    if (pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }

    // Static Assets (/assets/*, /vendor/*, SVG/images)
    if (
      pathname.startsWith('/assets/') ||
      pathname.startsWith('/vendor/') ||
      pathname.endsWith('.svg') ||
      pathname.endsWith('.png') ||
      pathname.endsWith('.ico')
    ) {
      if (method !== 'GET') return methodNotAllowed(res);

      const fullPath = resolvePublicFilePath(pathname.slice(1));
      if (!fullPath) return sendJson(res, 404, { error: 'Asset not found' });

      try {
        const ext = path.extname(fullPath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        const content = await fs.readFile(fullPath);
        res
          .writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=86400',
          })
          .end(content);
        return;
      } catch (err: any) {
        res
          .writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          .end(`Error loading asset: ${err?.message}`);
        return;
      }
    }

    // GET /
    if (pathname === '/') {
      if (method !== 'GET') return methodNotAllowed(res);
      try {
        const html = await loadIndexHtml();
        res
          .writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
          })
          .end(html);
        return;
      } catch (err: any) {
        res
          .writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          .end(`Failed to load dashboard: ${err?.message}`);
        return;
      }
    }

    // GET /api/quota
    if (pathname === '/api/quota') {
      if (method !== 'GET') return methodNotAllowed(res);

      try {
        let snapshots: QuotaSnapshot[] = [];
        if (options.quotaClient) {
          snapshots = await options.quotaClient.fetchQuota();
        } else if (options.sentryState) {
          const pools = options.sentryState.getState().pools ?? {};
          snapshots = Object.entries(pools).map(([poolId, pool]) => {
            const resetDate = new Date(pool.resetTime);
            const hoursUntil = Math.max(
              0,
              Math.round(((resetDate.getTime() - Date.now()) / 3600000) * 10) / 10
            );
            const family = poolId.includes('flash')
              ? 'gemini-flash'
              : poolId.includes('argon') || poolId.includes('pro')
                ? 'gemini-argon'
                : 'claude';
            const displayName =
              family === 'gemini-flash'
                ? 'Gemini Flash'
                : family === 'gemini-argon'
                  ? 'Gemini Argon'
                  : 'Claude Sonnet';

            return {
              poolId,
              family,
              displayName,
              remainingFraction: pool.remainingFraction,
              resetTime: pool.resetTime,
              hoursUntilReset: hoursUntil,
              overageEnabled: false,
              models: [],
            };
          });
        }
        return sendJson(res, 200, snapshots);
      } catch (err: any) {
        return sendJson(res, 500, { error: 'Failed to fetch quota', message: err?.message });
      }
    }

    // GET /api/alerts
    if (pathname === '/api/alerts') {
      if (method !== 'GET') return methodNotAllowed(res);
      const alertData = options.sentryState?.getState() ?? {
        version: 1,
        lastProbeAt: new Date().toISOString(),
        lastProbeSource: 'unreachable',
        pools: {},
      };
      return sendJson(res, 200, alertData);
    }

    // GET /api/logs
    if (pathname === '/api/logs') {
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

    // GET /api/dispatches
    if (pathname === '/api/dispatches') {
      if (method !== 'GET') return methodNotAllowed(res);
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const rows = options.configStore
        .getDatabase()
        .listDispatches(Number.isFinite(limit) ? limit : 50);
      return sendJson(res, 200, rows, { 'Cache-Control': 'no-store' });
    }

    // /api/config (GET, POST)
    if (pathname === '/api/config') {
      if (method === 'GET') {
        const resolved = options.configStore.resolveConfig();
        const overrides = options.configStore.getAllOverrides();
        return sendJson(res, 200, {
          resolved: sanitizeConfigForClient(resolved),
          overrides: sanitizeConfigForClient(overrides),
          secretsMeta: getSecretsMeta(resolved),
        });
      }

      if (method === 'POST') {
        const body = await readBody(req, res);
        if (!body.trim()) return sendJson(res, 400, { error: 'Request body cannot be empty' });

        let payload: any;
        try {
          payload = JSON.parse(body);
        } catch {
          return sendJson(res, 400, { error: 'Malformed JSON payload' });
        }

        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
          return sendJson(res, 400, { error: 'Payload must be a JSON object' });
        }

        const handleSet = (key: string, value: unknown) => {
          if (isSecretKey(key)) {
            if (value === '••••••••' || value === '********') {
              return; // preserve existing secret, do not overwrite with mask
            }
            if (value === null || value === '') {
              options.configStore.deleteOverride(key);
              return;
            }
          }
          options.configStore.setOverride(key, value);
        };

        if (
          typeof payload.key === 'string' &&
          'value' in payload &&
          Object.keys(payload).length === 2
        ) {
          handleSet(payload.key, payload.value);
        } else {
          for (const [k, v] of Object.entries(payload)) {
            handleSet(k, v);
          }
        }

        const updatedResolved = options.configStore.resolveConfig();
        const updatedOverrides = options.configStore.getAllOverrides();
        const keys = typeof payload.key === 'string' ? [payload.key] : Object.keys(payload);
        log.info('Configuration updated via Web API (keys: %s)', keys.join(', '));
        return sendJson(res, 200, {
          success: true,
          resolved: sanitizeConfigForClient(updatedResolved),
          overrides: sanitizeConfigForClient(updatedOverrides),
          secretsMeta: getSecretsMeta(updatedResolved),
        });
      }

      return methodNotAllowed(res);
    }

    // DELETE /api/config/:key
    if (pathname.startsWith('/api/config/')) {
      const key = pathname.slice('/api/config/'.length).trim();
      if (!key || method !== 'DELETE') return methodNotAllowed(res);

      const decodedKey = decodeURIComponent(key);
      options.configStore.deleteOverride(decodedKey);
      log.info('Configuration override deleted via Web API: %s', decodedKey);
      const resolved = options.configStore.resolveConfig();
      const overrides = options.configStore.getAllOverrides();
      return sendJson(res, 200, {
        success: true,
        resolved: sanitizeConfigForClient(resolved),
        overrides: sanitizeConfigForClient(overrides),
        secretsMeta: getSecretsMeta(resolved),
      });
    }

    // POST /api/notify/test
    if (pathname === '/api/notify/test') {
      if (method !== 'POST') return methodNotAllowed(res);

      const body = await readBody(req, res);
      try {
        const resolved = options.configStore.resolveConfig();
        let targetChannel: string | undefined;

        if (body.trim()) {
          try {
            const parsed = JSON.parse(body);
            if (parsed.channel && typeof parsed.channel === 'string') {
              targetChannel = parsed.channel.trim().toLowerCase();
            }
          } catch {
            // ignore malformed body
          }
        }

        const channel =
          targetChannel ??
          (resolved.notificationChannels && resolved.notificationChannels.length > 0
            ? resolved.notificationChannels.join(', ')
            : (resolved.notificationChannel ?? 'none'));

        const sampleAlert = {
          pool: {
            poolId: 'test-pool',
            family: 'claude' as const,
            displayName: 'Test Notification — Claude',
            remainingFraction: 0.45,
            resetTime: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
            hoursUntilReset: 3.0,
            models: ['claude-sonnet'],
          },
          milestoneHours: 3,
          remainingPercentage: 45,
          triggeredAt: new Date().toISOString(),
        };

        let resultMessage = `Test notification sent via ${channel}!`;
        let isSuccess = true;

        const activeNotifier =
          options.notifier ??
          (await (async () => {
            const { createNotifier } = await import('../notify/factory.js');
            return createNotifier(targetChannel ?? resolved, {});
          })());

        try {
          if (!options.notifier) {
            await activeNotifier.initialize();
          }

          if (activeNotifier.testNotification) {
            const testRes = await activeNotifier.testNotification(targetChannel);
            isSuccess = testRes.success;
            resultMessage = testRes.message;
          } else {
            await activeNotifier.notifyQuotaAlert(sampleAlert);
          }
        } finally {
          if (!options.notifier) {
            await activeNotifier.shutdown();
          }
        }

        log.info(
          'Test notification executed via Web API (channel: %s, success: %s)',
          channel,
          isSuccess
        );
        return sendJson(res, isSuccess ? 200 : 400, {
          success: isSuccess,
          channel,
          message: resultMessage,
        });
      } catch (err: any) {
        if (err instanceof PayloadTooLargeError || err?.statusCode === 413) {
          sendPayloadTooLarge(req, res, err?.message);
          return;
        }
        return sendJson(res, 500, {
          success: false,
          error: err?.message || 'Failed to send test notification',
        });
      }
    }

    // POST /api/dispatch
    if (pathname === '/api/dispatch') {
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
      const prompt = payload.prompt ? String(payload.prompt) : 'Default task prompt from Web UI';
      const requestedBy = payload.requestedBy ? String(payload.requestedBy) : 'web-ui';
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

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
  } catch (err: any) {
    if (err instanceof PayloadTooLargeError || err?.statusCode === 413) {
      sendPayloadTooLarge(req, res, err?.message);
      return;
    }
    throw err;
  }
};
