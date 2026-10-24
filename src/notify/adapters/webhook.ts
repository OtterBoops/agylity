import ky from 'ky';
import crypto from 'node:crypto';
import type { Notifier, NotifierOptions, QuotaAlert, DispatchStatusUpdate } from '../types.js';
import type { ResolvedConfig } from '../../config/schema.js';
import { BUILTIN_DEFAULTS } from '../../config/schema.js';

export interface WebhookPayload {
  event: 'quota_alert' | 'dispatch_status' | 'test_ping';
  timestamp: string;
  data: Record<string, unknown>;
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
        message: `Webhook ping delivered successfully to ${url} (status ${res.status})`,
        channel: this.channelName,
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Webhook ping failed: ${err.message}`,
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

      return { status: response.status };
    } catch (err: any) {
      console.error(`[WebhookNotifier] Webhook delivery failed: ${err.message}`);
      throw err;
    }
  }
}
