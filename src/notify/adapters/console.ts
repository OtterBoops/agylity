import ky from 'ky';
import crypto from 'node:crypto';
import type { Notifier, NotifierOptions, QuotaAlert, DispatchStatusUpdate } from '../types.js';
import type { ResolvedConfig } from '../../config/schema.js';
import { BUILTIN_DEFAULTS } from '../../config/schema.js';

export class ConsoleNotifier implements Notifier {
  readonly channelName: string = 'console';
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

  async notifyQuotaAlert(alert: QuotaAlert): Promise<void> {
    this.alerts.push(alert);

    // Format rich ASCII box for console output
    const poolName = alert.pool.displayName || alert.pool.poolId;
    const remainingPct = `${alert.remainingPercentage}%`;
    const milestoneText = `${alert.milestoneHours}h before reset`;
    const resetTime = alert.pool.resetTime;

    const line1 = `│ [QUOTA ALERT] ${poolName}`.padEnd(72) + '│';
    const line2 =
      `│ Headroom: ${remainingPct} remaining | Milestone: ${milestoneText}`.padEnd(72) + '│';
    const line3 =
      `│ Reset Deadline: ${resetTime} | Triggered: ${alert.triggeredAt}`.padEnd(72) + '│';

    console.log('┌' + '─'.repeat(71) + '┐');
    console.log(line1);
    console.log(line2);
    console.log(line3);
    console.log('└' + '─'.repeat(71) + '┘');

    // If webhook URL configured, post JSON payload
    if (this.config.notificationWebhookUrl) {
      await this.dispatchWebhook({
        event: 'quota_alert',
        poolId: alert.pool.poolId,
        milestone: alert.milestoneHours,
        data: {
          displayName: alert.pool.displayName,
          remainingFraction: alert.pool.remainingFraction,
          remainingPercentage: alert.remainingPercentage,
          resetTime: alert.pool.resetTime,
          hoursUntilReset: alert.pool.hoursUntilReset,
          triggeredAt: alert.triggeredAt,
        },
      });
    }
  }

  async notifyDispatchStatus(status: DispatchStatusUpdate): Promise<void> {
    this.statuses.push(status);

    const step = status.status ?? (status.step as string) ?? 'executing';
    const repo = status.repositoryName ?? 'N/A';
    const branch = status.branchName ?? 'N/A';
    const msg = status.message ?? '';

    const line1 = `│ [DISPATCH STATUS] Step: ${step.toUpperCase()}`.padEnd(72) + '│';
    const line2 = `│ Repo: ${repo} | Branch: ${branch}`.padEnd(72) + '│';
    const line3 = `│ Message: ${msg}`.padEnd(72) + '│';

    console.log('┌' + '─'.repeat(71) + '┐');
    console.log(line1);
    console.log(line2);
    console.log(line3);
    console.log('└' + '─'.repeat(71) + '┘');

    if (this.config.notificationWebhookUrl) {
      await this.dispatchWebhook({
        event: 'dispatch_status',
        status: step,
        message: msg,
        data: status,
      });
    }
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
  }

  protected async dispatchWebhook(payload: Record<string, unknown>): Promise<void> {
    const url = this.config.notificationWebhookUrl;
    if (!url) return;

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      const secret = process.env.WEBHOOK_SECRET;
      if (secret) {
        const hmac = crypto
          .createHmac('sha256', secret)
          .update(JSON.stringify(payload))
          .digest('hex');
        headers['x-agylity-signature'] = `sha256=${hmac}`;
      }

      await ky.post(url, {
        json: payload,
        headers,
        timeout: 5000,
        retry: 0,
      });
    } catch (err: any) {
      // Safe logging without throwing unhandled rejections
      console.error(`[ConsoleNotifier] Webhook delivery failed: ${err.message}`);
    }
  }
}

export class WebhookNotifier extends ConsoleNotifier {
  override readonly channelName: string = 'webhook';

  constructor(config: Partial<ResolvedConfig> = {}, options: NotifierOptions = {}) {
    super(config, options);
  }
}
