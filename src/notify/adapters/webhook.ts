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
  content?: string;
  text?: string;
  message?: string;
  username?: string;
  embeds?: unknown[];
  poolId?: string;
  milestone?: number;
  status?: string;
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

export function formatResetWindow(rawResetTime?: string): string {
  if (!rawResetTime) return 'Unknown';
  try {
    const d = new Date(rawResetTime);
    if (!isNaN(d.getTime())) {
      const unixSec = Math.floor(d.getTime() / 1000);
      return `<t:${unixSec}:R> (<t:${unixSec}:t>)`;
    }
  } catch {}
  return rawResetTime;
}

export function isDiscordWebhook(url?: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return (
      (host === 'discord.com' ||
        host === 'discordapp.com' ||
        host.endsWith('.discord.com') ||
        host.endsWith('.discordapp.com')) &&
      u.pathname.toLowerCase().includes('/api/webhooks/')
    );
  } catch {
    return false;
  }
}

export function renderSquareProgressBar(fraction: number, totalBars = 10): string {
  const safeFraction = Number.isFinite(fraction) ? fraction : 0;
  const clamped = Math.max(0, Math.min(1, safeFraction));
  const safeTotalBars = Number.isFinite(totalBars) && totalBars > 0 ? Math.floor(totalBars) : 10;
  const filled = Math.round(clamped * safeTotalBars);
  const empty = Math.max(0, safeTotalBars - filled);
  const bar = '■'.repeat(filled) + '□'.repeat(empty);
  const percent = Math.round(clamped * 100);
  return `\`[${bar}]\` **${percent}%**`;
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

    const poolName = alert.pool.displayName || alert.pool.poolId || 'Quota Pool';
    const percent = alert.remainingPercentage;
    const hours = alert.milestoneHours;
    const textMsg = `[Alert] Quota Milestone: ${poolName} is at ${percent}% with ${hours}h before reset.`;

    const payload: WebhookPayload = {
      event: 'quota_alert',
      poolId: alert.pool.poolId,
      milestone: alert.milestoneHours,
      timestamp: alert.triggeredAt || new Date().toISOString(),
      username: 'Agylity',
      content: textMsg,
      text: textMsg,
      message: textMsg,
      embeds: [
        {
          title: `[Alert] Quota Milestone: ${poolName}`,
          description: `Milestone threshold: **${hours}h** before quota reset.`,
          color: 0xffa500,
          fields: [
            {
              name: 'Remaining Quota',
              value: renderSquareProgressBar(alert.pool.remainingFraction ?? percent / 100),
              inline: true,
            },
            {
              name: 'Reset Window',
              value: formatResetWindow(alert.pool.resetTime),
              inline: true,
            },
          ],
          footer: { text: 'Agylity Quota Sentry' },
          timestamp: alert.triggeredAt || new Date().toISOString(),
        },
      ],
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

    if (alert.pool.models && alert.pool.models.length > 0) {
      (payload.embeds![0] as any).fields.push({
        name: 'Monitored Models',
        value: alert.pool.models.map((m) => `\`${m}\``).join(' • '),
        inline: false,
      });
    }

    try {
      await this.postWebhook(payload);
    } catch {
      // Error already logged by postWebhook
    }
  }

  async notifyDispatchStatus(status: DispatchStatusUpdate): Promise<void> {
    this.statuses.push(status);

    const step = status.status ?? (status.step as string) ?? 'executing';
    const textMsg = `[Dispatch] Task status: ${step}${status.message ? ` — ${status.message}` : ''}`;

    const payload: WebhookPayload = {
      event: 'dispatch_status',
      status: step,
      message: status.message ?? '',
      timestamp: status.timestamp || new Date().toISOString(),
      username: 'Agylity',
      content: textMsg,
      text: textMsg,
      embeds: [
        {
          title: `[Dispatch] Task Status: ${step}`,
          description: status.message || `Dispatch step: ${step}`,
          color: step === 'completed' ? 0x2ecc71 : step === 'failed' ? 0xe74c3c : 0x3498db,
          timestamp: status.timestamp || new Date().toISOString(),
          footer: { text: 'Agylity Orchestrator' },
        },
      ],
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

    const resetDate = new Date(Date.now() + 3 * 3600 * 1000);
    const resetIso = resetDate.toISOString();
    const resetWindow = formatResetWindow(resetIso);
    const modelsList = ['Claude Opus', 'Claude Sonnet', 'GPT-OSS'];
    const textMsg =
      '[Notice] Agylity Notification Test — Quota milestone simulation: Claude and GPT models is at 25% with 3h before reset.';
    const payload: WebhookPayload = {
      event: 'test_ping',
      poolId: 'claude',
      milestone: 3,
      timestamp: new Date().toISOString(),
      username: 'Agylity',
      content: textMsg,
      text: textMsg,
      message: textMsg,
      embeds: [
        {
          title: '[Alert] Quota Milestone: Claude & GPT Models',
          description: 'Milestone threshold: **3h** before quota reset.',
          color: 0xffa500,
          fields: [
            {
              name: 'Remaining Quota',
              value: renderSquareProgressBar(0.25),
              inline: true,
            },
            {
              name: 'Reset Window',
              value: resetWindow,
              inline: true,
            },
            {
              name: 'Monitored Models',
              value: modelsList.map((m) => `\`${m}\``).join(' • '),
              inline: false,
            },
          ],
          footer: { text: 'Agylity Quota Sentry • Test Notification Simulation' },
          timestamp: new Date().toISOString(),
        },
      ],
      data: {
        poolId: 'claude',
        displayName: 'Claude and GPT models',
        family: 'claude',
        remainingPercentage: 25,
        remainingFraction: 0.25,
        milestoneHours: 3,
        resetTime: resetIso,
        hoursUntilReset: 3.0,
        models: modelsList,
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
      let extra = '';
      if (err?.response && typeof err.response.text === 'function') {
        try {
          const body = await err.response.text();
          if (body) {
            extra = `: ${body.slice(0, 150)}`;
          }
        } catch {}
      }
      return {
        success: false,
        message: `Webhook ping failed: ${sanitizeErrorMessage((err?.message ?? String(err)) + extra, url)}`,
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

    const outgoingPayload: any = { ...payload };
    if (
      isDiscordWebhook(url) &&
      Array.isArray(outgoingPayload.embeds) &&
      outgoingPayload.embeds.length > 0
    ) {
      delete outgoingPayload.content;
    }

    const bodyStr = JSON.stringify(outgoingPayload);
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
      let extra = '';
      if (err?.response && typeof err.response.text === 'function') {
        try {
          const body = await err.response.text();
          if (body) {
            extra = `: ${body.slice(0, 150)}`;
          }
        } catch {}
      }
      logger
        .child('notify:webhook')
        .error(
          'Webhook delivery failed: %s',
          sanitizeErrorMessage((err?.message ?? String(err)) + extra, url)
        );
      throw err;
    }
  }
}
