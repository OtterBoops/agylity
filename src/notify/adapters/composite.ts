import type { Notifier, QuotaAlert, DispatchStatusUpdate } from '../types.js';
import type { ResolvedConfig } from '../../config/schema.js';
import { logger } from '../../logs/logger.js';

export class CompositeNotifier implements Notifier {
  readonly channelName: string;
  public readonly notifiers: Notifier[];

  constructor(notifiers: Notifier[] = []) {
    this.notifiers = notifiers;
    if (this.notifiers.length === 0) {
      this.channelName = 'none';
    } else if (this.notifiers.length === 1 && this.notifiers[0]) {
      this.channelName = this.notifiers[0].channelName;
    } else {
      this.channelName = 'composite';
    }
  }

  public getNotifiers(): Notifier[] {
    return this.notifiers;
  }

  public getNotifier(channelName: string): Notifier | undefined {
    return this.notifiers.find((n) => n.channelName === channelName);
  }

  async initialize(): Promise<void> {
    await Promise.all(this.notifiers.map((n) => n.initialize()));
  }

  async init(): Promise<void> {
    return this.initialize();
  }

  async notifyQuotaAlert(alert: QuotaAlert): Promise<void> {
    const results = await Promise.allSettled(this.notifiers.map((n) => n.notifyQuotaAlert(alert)));
    for (const res of results) {
      if (res.status === 'rejected') {
        logger.child('notify:composite').error('Quota alert delivery error:', res.reason);
      }
    }
  }

  async notifyDispatchStatus(status: DispatchStatusUpdate): Promise<void> {
    const results = await Promise.allSettled(
      this.notifiers.map((n) => n.notifyDispatchStatus(status))
    );
    for (const res of results) {
      if (res.status === 'rejected') {
        logger.child('notify:composite').error('Dispatch status delivery error:', res.reason);
      }
    }
  }

  async updateConfig(newConfig: Partial<ResolvedConfig>): Promise<void> {
    await Promise.all(
      this.notifiers.map(async (n) => {
        if (n.updateConfig) {
          try {
            await n.updateConfig(newConfig);
          } catch (err: any) {
            logger
              .child('notify:composite')
              .error('Failed to update config on %s: %s', n.channelName, err.message);
          }
        }
      })
    );
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(this.notifiers.map((n) => n.shutdown()));
  }

  async testNotification(targetChannel?: string): Promise<{
    success: boolean;
    message: string;
    channel: string;
    results?: Record<string, { success: boolean; message: string }>;
  }> {
    if (this.notifiers.length === 0) {
      return {
        success: true,
        message: 'Silent sentry mode active (no notification channels enabled).',
        channel: 'none',
      };
    }

    const testTargets = targetChannel
      ? this.notifiers.filter((n) => n.channelName === targetChannel)
      : this.notifiers;

    if (targetChannel && testTargets.length === 0) {
      return {
        success: false,
        message: `Notification channel "${targetChannel}" is not active.`,
        channel: targetChannel,
      };
    }

    const results: Record<string, { success: boolean; message: string }> = {};
    let overallSuccess = true;

    for (const notifier of testTargets) {
      try {
        if (notifier.testNotification) {
          const res = await notifier.testNotification();
          results[notifier.channelName] = { success: res.success, message: res.message };
          if (!res.success) overallSuccess = false;
        } else {
          results[notifier.channelName] = {
            success: true,
            message: `Delivered test notification via ${notifier.channelName}`,
          };
        }
      } catch (err: any) {
        results[notifier.channelName] = {
          success: false,
          message: err.message || 'Test delivery failed',
        };
        overallSuccess = false;
      }
    }

    const summary = Object.entries(results)
      .map(([ch, r]) => `${ch}: ${r.message}`)
      .join(' | ');

    return {
      success: overallSuccess,
      message: summary,
      channel: this.channelName,
      results,
    };
  }
}
