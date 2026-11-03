import ky from 'ky';
import crypto from 'node:crypto';
import type {
  Notifier,
  NotifierOptions,
  QuotaAlert,
  DispatchStatusUpdate,
  DeliveryOutcome,
} from '../types.js';
import type { ResolvedConfig } from '../../config/schema.js';
import { BUILTIN_DEFAULTS } from '../../config/schema.js';
import { logger } from '../../logs/logger.js';
import { FAMILY_DISPLAY_NAMES } from '../../sentry/models.js';
import {
  buildQuotaAlertEmbed,
  buildTestAlertEmbed,
  buildDispatchStatusEmbed,
  formatResetWindow,
  renderSquareProgressBar,
} from '../embeds/index.js';

export { formatResetWindow, renderSquareProgressBar };

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

// Sanitizes a webhook URL by masking sensitive path tokens, user credentials,
export const sanitizeWebhookUrl = (rawUrl: string): string => {
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
    } else if (cleanSegments.length >= 1) {
      // Generic webhook paths: mask the terminal token segment regardless of count or length,
      // so a single-segment secret such as /secret123 is not returned verbatim.
      const base = cleanSegments.slice(0, cleanSegments.length - 1).join('/');
      u.pathname = base ? `/${base}/***` : '/***';
    }

    return u.toString();
  } catch {
    return '[invalid-url]';
  }
};

// Extracts the raw path/query values that sanitizeWebhookUrl masks, so the same secret can be
function extractMaskedTokens(rawUrl: string): string[] {
  try {
    const raw = new URL(rawUrl);
    const sanitized = new URL(sanitizeWebhookUrl(rawUrl));
    const rawSegments = raw.pathname.split('/').filter(Boolean);
    const sanitizedSegments = sanitized.pathname.split('/').filter(Boolean);
    const tokens = new Set<string>();
    rawSegments.forEach((segment, i) => {
      if (segment && sanitizedSegments[i] !== segment) tokens.add(segment);
    });
    for (const key of raw.searchParams.keys()) {
      const value = raw.searchParams.get(key);
      if (value) tokens.add(value);
    }
    return [...tokens];
  } catch {
    return [];
  }
}

// Strips raw webhook URLs and secrets from error strings before logging or API delivery.
export function sanitizeErrorMessage(message: string, rawUrl?: string): string {
  if (!message || typeof message !== 'string') return '';
  let result = message;
  if (rawUrl && typeof rawUrl === 'string' && rawUrl.length > 0) {
    const sanitized = sanitizeWebhookUrl(rawUrl);
    result = result.split(rawUrl).join(sanitized);
    // Response bodies and error text can quote a secret with no URL around it.
    for (const token of extractMaskedTokens(rawUrl)) {
      result = result.split(token).join('***');
    }
  }
  return result.replace(/https?:\/\/[^\s"',)]+/gi, (matchedUrl) => {
    return sanitizeWebhookUrl(matchedUrl);
  });
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

  async updateConfig(newConfig: Partial<ResolvedConfig>): Promise<void> {
    this.config = { ...this.config, ...newConfig };
  }

  async notifyQuotaAlert(alert: QuotaAlert): Promise<DeliveryOutcome> {
    this.alerts.push(alert);
    if (this.alerts.length > 100) this.alerts.shift();

    const poolName = alert.pool.displayName || alert.pool.poolId || 'Quota Pool';
    const percent = alert.remainingPercentage;
    const hours = alert.milestoneHours;
    const textMsg = `[Alert] Quota Milestone: ${poolName} is at ${percent}% with ${hours}h before reset.`;
    const embed = buildQuotaAlertEmbed(alert, {
      ownerUserId: this.config.discordOwnerUserId,
      pingOwner: this.config.discordPingOwner !== false,
    });

    const payload: WebhookPayload = {
      event: 'quota_alert',
      poolId: alert.pool.poolId,
      milestone: alert.milestoneHours,
      timestamp: alert.triggeredAt || new Date().toISOString(),
      username: 'Agylity',
      content: textMsg,
      text: textMsg,
      message: textMsg,
      embeds: [embed],
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
      return { delivered: true, results: { [this.channelName]: { success: true } } };
    } catch (err: any) {
      return {
        delivered: false,
        results: {
          [this.channelName]: {
            success: false,
            error: sanitizeErrorMessage(err?.message ?? String(err), this.getWebhookUrl()),
          },
        },
      };
    }
  }

  async notifyDispatchStatus(status: DispatchStatusUpdate): Promise<void> {
    this.statuses.push(status);
    if (this.statuses.length > 100) this.statuses.shift();

    const step = String(status.status ?? (status.step as string) ?? 'executing').toLowerCase();
    const isTerminal = ['completed', 'failed', 'aborted'].includes(step);
    const isInitial = step === 'polling' || step === 'waking';

    // Only broadcast initial dispatch and final completion to webhooks
    // Suppress noisy intermediate runner progress heartbeats
    if (!isInitial && !isTerminal) {
      return;
    }

    const textMsg = `[Dispatch] Task status: ${step}${status.message ? ` — ${status.message}` : ''}`;
    const embed = buildDispatchStatusEmbed(status);

    const payload: WebhookPayload = {
      event: 'dispatch_status',
      status: step,
      message: status.message ?? '',
      timestamp: status.timestamp || new Date().toISOString(),
      username: 'Agylity',
      content: textMsg,
      text: textMsg,
      embeds: [embed],
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

    const resetIso = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
    const modelsList = ['Claude Opus', 'Claude Sonnet', 'GPT-OSS'];
    const textMsg =
      '[Notice] Agylity Notification Test — Quota milestone simulation: Claude and GPT models is at 25% with 3h before reset.';
    const embed = buildTestAlertEmbed(undefined, {
      ownerUserId: this.config.discordOwnerUserId,
      pingOwner: this.config.discordPingOwner !== false,
    });

    const payload: WebhookPayload = {
      event: 'test_ping',
      poolId: 'claude',
      milestone: 3,
      timestamp: new Date().toISOString(),
      username: 'Agylity',
      content: textMsg,
      text: textMsg,
      message: textMsg,
      embeds: [embed],
      data: {
        poolId: 'claude',
        displayName: FAMILY_DISPLAY_NAMES.claude,
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
        message: `Webhook ping delivered successfully (status ${res.status}).`,
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
    const isOwnerAlertEvent =
      outgoingPayload.event === 'quota_alert' || outgoingPayload.event === 'test_ping';
    const hasEmbeds = Array.isArray(outgoingPayload.embeds) && outgoingPayload.embeds.length > 0;
    if (isDiscordWebhook(url) && hasEmbeds) {
      const ownerId = this.config.discordOwnerUserId?.trim();
      if (isOwnerAlertEvent && this.config.discordPingOwner !== false && ownerId) {
        outgoingPayload.content = `<@${ownerId}>`;
        outgoingPayload.allowed_mentions = {
          users: [ownerId],
        };
      } else {
        // Prevent double-posting: Discord renders both content and embeds if content is populated.
        // Strip duplicate content so only the clean embed box appears.
        delete outgoingPayload.content;
      }
    }

    const bodyStr = JSON.stringify(outgoingPayload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Agylity-Notifier/0.3.2',
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
        // ky's default retry.methods excludes POST, so opt it in explicitly.
        retry: { limit: 1, methods: ['post'] },
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
