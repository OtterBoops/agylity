import ky from 'ky';
import crypto from 'node:crypto';
import { AGYLITY_VERSION } from '../../version.js';
import type {
  Notifier,
  NotifierOptions,
  QuotaAlert,
  DispatchStatusUpdate,
  DeliveryOutcome,
  InfoNotice,
} from '../types.js';
import type { ResolvedConfig } from '../../config/schema.js';
import { BUILTIN_DEFAULTS } from '../../config/schema.js';
import { logger } from '../../logs/logger.js';
import { normalizeStep, isTerminalStep } from '../embeds/formatters.js';
import { POOL_GROUP_DEFAULT_MODELS, POOL_GROUP_DISPLAY_NAMES } from '../../sentry/models.js';
import {
  buildQuotaAlertEmbed,
  buildTestAlertEmbed,
  buildDispatchStatusEmbed,
  buildInfoNoticeEmbed,
} from '../embeds/index.js';

interface WebhookPayload {
  event: 'quota_alert' | 'dispatch_status' | 'test_ping' | 'info_notice';
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

export const sanitizeWebhookUrl = (rawUrl: string): string => {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const u = new URL(rawUrl);

    if (u.username) u.username = '***';
    if (u.password) u.password = '***';

    if (u.hash) u.hash = '';

    for (const key of Array.from(u.searchParams.keys())) {
      u.searchParams.set(key, '***');
    }

    const cleanSegments = u.pathname.split('/').filter(Boolean);

    if (
      cleanSegments.length >= 3 &&
      cleanSegments[0]?.toLowerCase() === 'api' &&
      cleanSegments[1]?.toLowerCase() === 'webhooks'
    ) {
      const id = cleanSegments[2];
      u.pathname = `/api/webhooks/${id}/***`;
    } else if (
      cleanSegments.length >= 3 &&
      cleanSegments[0]?.toLowerCase() === 'services' &&
      (u.hostname.toLowerCase().includes('slack.com') || cleanSegments[1]?.startsWith('T'))
    ) {
      u.pathname = `/services/${cleanSegments[1]}/${cleanSegments[2]}/***`;
    } else if (
      u.hostname.toLowerCase().includes('discord.com') ||
      u.hostname.toLowerCase().includes('discordapp.com')
    ) {
      u.pathname = `/${cleanSegments[0] || 'api'}/***`;
    } else if (cleanSegments.length >= 1) {
      const base = cleanSegments.slice(0, cleanSegments.length - 1).join('/');
      u.pathname = base ? `/${base}/***` : '/***';
    }

    return u.toString();
  } catch {
    return '[invalid-url]';
  }
};

// The raw path/query values sanitizeWebhookUrl masks, so error text can be scrubbed of them too.
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

export function sanitizeErrorMessage(message: string, rawUrl?: string): string {
  if (!message || typeof message !== 'string') return '';
  let result = message;
  if (rawUrl && typeof rawUrl === 'string' && rawUrl.length > 0) {
    const sanitized = sanitizeWebhookUrl(rawUrl);
    result = result.split(rawUrl).join(sanitized);
    for (const token of extractMaskedTokens(rawUrl)) {
      result = result.split(token).join('***');
    }
  }
  return result.replace(/https?:\/\/[^\s"',)]+/gi, (matchedUrl) => {
    return sanitizeWebhookUrl(matchedUrl);
  });
}

function isDiscordWebhook(url?: string): boolean {
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

const describeBody = (data: unknown): string => {
  if (data === undefined || data === null) return '';
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data);
  } catch {
    return '';
  }
};

// The server's own body is the most useful part of a failed delivery, but it is untrusted text.
// ky has already read it into `err.data`, so `response.text()` on the same error always throws.
const responseDetail = async (err: any): Promise<string> => {
  let body = describeBody(err?.data);
  if (!body && typeof err?.response?.text === 'function') {
    try {
      body = await err.response.text();
    } catch {
      body = '';
    }
  }
  return body ? `: ${body.slice(0, 150)}` : '';
};

// A Slack mention token (`<@id>`) must not ping the channel, so `<` is escaped.
const escapeMentions = (text: string): string => text.replace(/<(?=[!@])/g, '&lt;');

const CONNECT_FAILURES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

export class WebhookNotifier implements Notifier {
  readonly channelName: string = 'webhook';
  public initialized = false;
  protected config: ResolvedConfig;
  protected options: NotifierOptions;

  constructor(config: Partial<ResolvedConfig> = {}, options: NotifierOptions = {}) {
    this.config = { ...BUILTIN_DEFAULTS, ...config };
    this.options = options;
  }

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
  }

  async updateConfig(newConfig: Partial<ResolvedConfig>): Promise<void> {
    this.config = { ...this.config, ...newConfig };
  }

  async notifyQuotaAlert(alert: QuotaAlert): Promise<DeliveryOutcome> {
    const poolName = alert.pool.displayName || alert.pool.poolId || 'Quota Pool';
    const percent = alert.remainingPercentage;
    const hours = alert.milestoneHours;
    const textMsg = escapeMentions(
      `[Alert] Quota Milestone: ${poolName} is at ${percent}% with ${hours}h before reset.`
    );
    const embed = buildQuotaAlertEmbed(alert, {
      ownerUserId: this.config.discordOwnerUserId,
      pingOwner: this.config.webhookPingOwner !== false,
      baseUrl: this.config.baseUrl,
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
        poolGroup: alert.pool.poolGroup,
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
      return this.failureOutcome(
        sanitizeErrorMessage(err?.message ?? String(err), this.getWebhookUrl())
      );
    }
  }

  async notifyDispatchStatus(status: DispatchStatusUpdate): Promise<void> {
    const step = normalizeStep(status);
    const isTerminal = isTerminalStep(step);
    const isInitial = step === 'polling' || step === 'waking';

    if (!isInitial && !isTerminal) {
      return;
    }

    const textMsg = escapeMentions(
      `[Dispatch] Task status: ${step}${status.message ? ` — ${status.message}` : ''}`
    );
    const embed = buildDispatchStatusEmbed(status, { baseUrl: this.config.baseUrl });

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
    } catch {}
  }

  async notifyInfo(notice: InfoNotice): Promise<DeliveryOutcome> {
    const textMsg = escapeMentions(`[Notice] ${notice.title} — ${notice.message}`);
    const embed = buildInfoNoticeEmbed(notice, { baseUrl: this.config.baseUrl });

    const payload: WebhookPayload = {
      event: 'info_notice',
      timestamp: notice.timestamp || new Date().toISOString(),
      username: 'Agylity',
      content: textMsg,
      text: textMsg,
      message: textMsg,
      embeds: [embed],
      data: { ...notice } as Record<string, unknown>,
    };

    try {
      await this.postWebhook(payload);
      return { delivered: true, results: { [this.channelName]: { success: true } } };
    } catch (err: any) {
      return this.failureOutcome(
        sanitizeErrorMessage(err?.message ?? String(err), this.getWebhookUrl())
      );
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
    const modelsList = POOL_GROUP_DEFAULT_MODELS.claude;
    const textMsg =
      '[Notice] Agylity Notification Test — Quota milestone simulation: Claude and GPT models is at 25% with 3h before reset.';
    const embed = buildTestAlertEmbed(undefined, {
      ownerUserId: this.config.discordOwnerUserId,
      pingOwner: this.config.webhookPingOwner !== false,
      baseUrl: this.config.baseUrl,
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
        displayName: POOL_GROUP_DISPLAY_NAMES.claude,
        poolGroup: 'claude',
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
      const extra = await responseDetail(err);
      return {
        success: false,
        message: `Webhook ping failed: ${sanitizeErrorMessage((err?.message ?? String(err)) + extra, url)}`,
        channel: this.channelName,
      };
    }
  }

  private failureOutcome(error: string): DeliveryOutcome {
    return { delivered: false, results: { [this.channelName]: { success: false, error } } };
  }

  public getWebhookUrl(): string | undefined {
    return this.config.notificationWebhookUrl || process.env.NOTIFICATION_WEBHOOK_URL;
  }

  public getWebhookSecret(): string | undefined {
    return this.config.webhookSecret || process.env.WEBHOOK_SECRET;
  }

  public async postWebhook(payload: WebhookPayload): Promise<{ status: number }> {
    const url = this.getWebhookUrl();
    if (!url) throw new Error('No webhook URL is configured for this channel');

    const outgoingPayload: any = { ...payload };
    const isOwnerAlertEvent =
      outgoingPayload.event === 'quota_alert' || outgoingPayload.event === 'test_ping';
    const hasEmbeds = Array.isArray(outgoingPayload.embeds) && outgoingPayload.embeds.length > 0;
    if (isDiscordWebhook(url) && hasEmbeds) {
      const ownerId = this.config.discordOwnerUserId?.trim();
      if (isOwnerAlertEvent && this.config.webhookPingOwner !== false && ownerId) {
        outgoingPayload.content = `<@${ownerId}>`;
        outgoingPayload.allowed_mentions = {
          users: [ownerId],
        };
      } else {
        // Discord renders both content and embeds, so strip content to avoid a double post.
        delete outgoingPayload.content;
      }
    }

    const bodyStr = JSON.stringify(outgoingPayload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': `Agylity-Notifier/${AGYLITY_VERSION}`,
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
        // Only a failure that cannot have reached the receiver is retried: a lost response would
        // double-post, so ECONNRESET/ETIMEDOUT and other post-send errors are left alone.
        retry: {
          limit: 1,
          methods: ['post'],
          shouldRetry: ({ error }: { error: unknown }) => {
            const status = (error as any)?.response?.status;
            if (typeof status === 'number')
              return status === 408 || status === 429 || status >= 500;
            const code = String((error as any)?.cause?.code ?? (error as any)?.code ?? '');
            return CONNECT_FAILURES.has(code);
          },
        },
      });

      logger
        .child('notify:webhook')
        .info('Webhook delivered to %s (status %d)', sanitizeWebhookUrl(url), response.status);
      return { status: response.status };
    } catch (err: any) {
      const extra = await responseDetail(err);
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
