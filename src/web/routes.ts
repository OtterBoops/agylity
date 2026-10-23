import type http from 'node:http';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConfigStore } from '../config/store.js';
import type { QuotaClient, QuotaSnapshot } from '../sentry/models.js';
import type { SentryStateManager } from '../sentry/state.js';
import type { LogBuffer, LogLevel } from '../logs/buffer.js';
import { isSecretKey, maskSecret } from '../storage/crypto.js';

export interface WebServerOptions {
  host?: string;
  port?: number;
  configStore: ConfigStore;
  quotaClient?: QuotaClient;
  sentryState?: SentryStateManager;
  logBuffer?: LogBuffer;
  notifier?: import('../notify/types.js').Notifier;
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

const readBody = async (req: http.IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8');
};

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
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
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
      const body = await readBody(req);
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

    options.configStore.deleteOverride(decodeURIComponent(key));
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

    try {
      const resolved = options.configStore.resolveConfig();
      const channel = resolved.notificationChannel ?? 'discord';
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

      if (options.notifier) {
        await options.notifier.notifyQuotaAlert(sampleAlert);
      } else {
        const { createNotifier } = await import('../notify/factory.js');
        const ephemeralNotifier = await createNotifier(resolved, {});
        try {
          await ephemeralNotifier.initialize();
          await ephemeralNotifier.notifyQuotaAlert(sampleAlert);
        } finally {
          await ephemeralNotifier.shutdown();
        }
      }

      return sendJson(res, 200, {
        success: true,
        channel,
        message: `Test notification sent via ${channel}!`,
      });
    } catch (err: any) {
      return sendJson(res, 500, {
        success: false,
        error: err?.message || 'Failed to send test notification',
      });
    }
  }

  // POST /api/dispatch
  if (pathname === '/api/dispatch') {
    if (method !== 'POST') return methodNotAllowed(res);

    const body = await readBody(req);
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

    const repoEntry = (resolved.repositories ?? []).find((r) => r.name === repositoryName);
    const repositoryPath = payload.repositoryPath
      ? String(payload.repositoryPath)
      : repoEntry
        ? repoEntry.path
        : repositoryName;

    return sendJson(res, 200, {
      success: false,
      error: 'Task dispatch is disabled while running in alerting-only mode.',
      dispatchId: `disp-${Date.now()}`,
      repo: repositoryName,
    });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
};
