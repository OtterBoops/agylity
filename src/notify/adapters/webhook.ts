import ky from 'ky';
import crypto from 'node:crypto';
import type { Notifier, NotifierOptions, QuotaAlert, DispatchStatusUpdate } from '../types.js';
import type { ResolvedConfig } from '../../config/schema.js';
import { BUILTIN_DEFAULTS } from '../../config/schema.js';
import { logger } from '../../logs/logger.js';

export interface WebhookPayload {
  event: 'quota_alert' | 'dispatch_status' | 'test_ping';
  timestamp: string;
  data: Record<string, unknown>;
}

/**
 * Sanitizes a webhook URL by masking sensitive path tokens, user credentials,
 * and query parameter values while preserving host, scheme, and non-sensitive path routing.
 */
export function sanitizeWebhookUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const u = new URL(rawUrl);

    // 1. Mask basic auth user/password credentials if present
    if (u.username) u.username = '***';
    if (u.password) u.password = '***';

    // 2. Clear hash fragment if present to prevent secret leakage
    if (u.hash) u.hash = '';

    // 3. Mask all query parameter values
    for (const key of Array.from(u.searchParams.keys())) {
      u.searchParams.set(key, '***');
    }

    // 4. Mask sensitive path segments
    const cleanSegments = u.pathname.split('/').filter(Boolean);

    if (
      cleanSegments.length >= 3 &&
      cleanSegments[0]?.toLowerCase() === 'api' &&
      cleanSegments[1]?.toLowerCase() === 'webhooks'
    ) {
      // Discord: /api/webhooks/<id>/<token> -> /api/webhooks/<id>/***
      const id = cleanSegments[2];
      u.pathname = `/api/webhooks/${id}/***`;
    } else if (
      cleanSegments.length >= 3 &&
      cleanSegments[0]?.toLowerCase() === 'services' &&
      (u.hostname.toLowerCase().includes('slack.com') || cleanSegments[1]?.startsWith('T'))
    ) {
      // Slack: /services/<team>/<bot>/<token> -> /services/${cleanSegments[1]}/${cleanSegments[2]}/***
      u.pathname = `/services/${cleanSegments[1]}/${cleanSegments[2]}/***`;
    } else if (
      u.hostname.toLowerCase().includes('discord.com') ||
      u.hostname.toLowerCase().includes('discordapp.com')
    ) {
      u.pathname = `/${cleanSegments[0] || 'api'}/***`;
    } else if (cleanSegments.length >= 2) {
      // Generic multi-segment webhook paths: mask terminal token segment
      const base = cleanSegments.slice(0, cleanSegments.length - 1).join('/');
      u.pathname = `/${base}/***`;
    } else if (cleanSegments.length > 0) {
      // Check individual segments for UUID or high-entropy token shapes
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const tokenRegex = /^[A-Za-z0-9_-]{24,}$/;
      let modified = false;
      const masked = cleanSegments.map((seg) => {
        if (uuidRegex.test(seg) || tokenRegex.test(seg)) {
          modified = true;
          return '***';
        }
        return seg;
      });
      if (modified) {
        u.pathname = `/${masked.join('/')}`;
      }
    }

    return u.toString();
  } catch {
    return '[invalid-url]';
  }
}

/**
 * Strips raw webhook URLs and secrets from error strings before logging or API delivery.
 */
export function sanitizeErrorMessage(message: string, rawUrl?: string): string {
  if (!message || typeof message !== 'string') return '';
  let result = message;
  if (rawUrl && typeof rawUrl === 'string' && rawUrl.length > 0) {
    const sanitized = sanitizeWebhookUrl(rawUrl);
    result = result.split(rawUrl).join(sanitized);
  }
  return result.replace(/https?:\/\/[^\s"',)]+/gi, (matchedUrl) => {
    return sanitizeWebhookUrl(matchedUrl);
  });
}

export class WebhookNotifier implements Notifier {
  readonly channelName: string = 'webhook';
  public initialized = false;
  public alerts: QuotaAlert[] = [];
  public statuses: DispatchStatusUpdate[] = [];
  protected config: ResolvedConfig;
  protected options: NotifierOptions;

  constructor(config: Partial<ResolvedConfig> = {}, options: NotifierOptions = {}) {
    this.config = { ...BUILTIN_DEFAULTS, ...config };
    this.options = options;
  }

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async init(): Promise<void> {
    return this.initialize();
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
  }

  async notifyQuotaAlert(alert: QuotaAlert): Promise<void> {
    this.alerts.push(alert);

    const payload = {
      event: 'quota_alert' as const,
      poolId: alert.pool.poolId,
      milestone: alert.milestoneHours,
      timestamp: alert.triggeredAt || new Date().toISOString(),
      data: {
        poolId: alert.pool.poolId,
        displayName: alert.pool.displayName || alert.pool.poolId,
        family: alert.pool.family,
        remainingPercentage: alert.remainingPercentage,
        remainingFraction: alert.pool.remainingFraction,
        milestoneHours: alert.milestoneHours,
        resetTime: alert.pool.resetTime,
        hoursUntilReset: alert.pool.hoursUntilReset,
        models: alert.pool.models,
        triggeredAt: alert.triggeredAt,
      },
    };

    try {
      await this.postWebhook(payload);
    } catch {
      // Error already logged by postWebhook
    }
  }

  async notifyDispatchStatus(status: DispatchStatusUpdate): Promise<void> {
    this.statuses.push(status);

    const step = status.status ?? (status.step as string) ?? 'executing';
    const payload = {
      event: 'dispatch_status' as const,
      status: step,
      message: status.message ?? '',
      timestamp: status.timestamp || new Date().toISOString(),
      data: { ...status } as Record<string, unknown>,
    };

    try {
      await this.postWebhook(payload);
    } catch {
      // Error already logged by postWebhook
    }
  }

  async testNotification(): Promise<{ success: boolean; message: string; channel: string }> {
    const url = this.getWebhookUrl();
    if (!url) {
      return {
        success: false,
        message: 'No webhook URL configured (notificationWebhookUrl is unset).',
        channel: this.channelName,
      };
    }

    const payload: WebhookPayload = {
      event: 'test_ping',
      timestamp: new Date().toISOString(),
      data: {
        message: 'Agylity notification test ping',
        source: 'agylity-daemon',
      },
    };

    try {
      const res = await this.postWebhook(payload);
      return {
        success: true,
        message: `Webhook ping delivered successfully to ${sanitizeWebhookUrl(url)} (status ${res.status})`,
        channel: this.channelName,
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Webhook ping failed: ${sanitizeErrorMessage(err?.message ?? String(err), url)}`,
        channel: this.channelName,
      };
    }
  }

  public getWebhookUrl(): string | undefined {
    return (
      this.config.notificationWebhookUrl ||
      process.env.NOTIFICATION_WEBHOOK_URL ||
      process.env.WEBHOOK_URL
    );
  }

  public getWebhookSecret(): string | undefined {
    return this.config.webhookSecret || process.env.WEBHOOK_SECRET;
  }

  public async postWebhook(payload: WebhookPayload): Promise<{ status: number }> {
    const url = this.getWebhookUrl();
    if (!url) return { status: 0 };

    const bodyStr = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Agylity-Notifier/0.1.0',
    };

    if (this.config.webhookCustomHeaders) {
      Object.assign(headers, this.config.webhookCustomHeaders);
    }

    const secret = this.getWebhookSecret();
    if (secret) {
      const hmac = crypto.createHmac('sha256', secret).update(bodyStr).digest('hex');
      headers['x-agylity-signature'] = `sha256=${hmac}`;
    }

    try {
      const response = await ky.post(url, {
        body: bodyStr,
        headers,
        timeout: 5000,
        retry: 1,
      });

      logger
        .child('notify:webhook')
        .info('Webhook delivered to %s (status %d)', sanitizeWebhookUrl(url), response.status);
      return { status: response.status };
    } catch (err: any) {
      logger
        .child('notify:webhook')
        .error(
          'Webhook delivery failed: %s',
          sanitizeErrorMessage(err?.message ?? String(err), url)
        );
      throw err;
    }
  }
}
