import type { Notifier, NotifierOptions, QuotaAlert, DispatchStatusUpdate } from '../types.js';
import type { ResolvedConfig } from '../../config/schema.js';
import { logger } from '../../logs/logger.js';

export class CompositeNotifier implements Notifier {
  public readonly notifiers: Notifier[];
  private readonly options?: NotifierOptions;
  private lastConfig: Partial<ResolvedConfig> = {};

  get channelName(): string {
    if (this.notifiers.length === 0) return 'none';
    if (this.notifiers.length === 1 && this.notifiers[0]) return this.notifiers[0].channelName;
    return 'composite';
  }

  constructor(
    notifiers: Notifier[] = [],
    options?: NotifierOptions,
    initialConfig?: Partial<ResolvedConfig>
  ) {
    this.notifiers = notifiers;
    this.options = options;
    if (initialConfig) {
      this.lastConfig = { ...initialConfig };
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

  private async syncResolvedOwner(): Promise<void> {
    const discordNotifier = this.notifiers.find((n) => n.channelName === 'discord') as any;
    if (discordNotifier && typeof discordNotifier.resolveOwnerUserId === 'function') {
      const resolvedOwner = await discordNotifier.resolveOwnerUserId();
      if (resolvedOwner) {
        for (const n of this.notifiers) {
          if (n !== discordNotifier && typeof (n as any).updateConfig === 'function') {
            await (n as any).updateConfig({ discordOwnerUserId: resolvedOwner });
          }
        }
      }
    }
  }

  async notifyQuotaAlert(alert: QuotaAlert): Promise<void> {
    await this.syncResolvedOwner();
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
    this.lastConfig = { ...this.lastConfig, ...newConfig };
    const rawChannels =
      newConfig.notificationChannels !== undefined
        ? newConfig.notificationChannels
        : newConfig.notificationChannel !== undefined
          ? newConfig.notificationChannel === 'none'
            ? []
            : [newConfig.notificationChannel]
          : undefined;

    if (rawChannels !== undefined) {
      const targetChannelNames = Array.from(
        new Set(
          (Array.isArray(rawChannels) ? rawChannels : [rawChannels])
            .map((c) => String(c).trim().toLowerCase())
            .filter((c) => Boolean(c) && c !== 'none')
        )
      );

      // Shutdown & remove notifiers no longer present
      const toKeep: Notifier[] = [];
      for (const n of this.notifiers) {
        if (!targetChannelNames.includes(n.channelName)) {
          try {
            await n.shutdown();
          } catch (err: any) {
            logger
              .child('notify:composite')
              .error('Shutdown error on %s: %s', n.channelName, err.message);
          }
        } else {
          toKeep.push(n);
        }
      }
      this.notifiers.length = 0;
      this.notifiers.push(...toKeep);

      // Instantiate any new channels that aren't currently active
      const currentNames = this.notifiers.map((n) => n.channelName);
      for (const ch of targetChannelNames) {
        if (!currentNames.includes(ch)) {
          try {
            const { createNotifier } = await import('../factory.js');
            const newNotifier = await createNotifier(
              ch,
              this.lastConfig as ResolvedConfig,
              this.options
            );
            await newNotifier.initialize();
            this.notifiers.push(newNotifier);
          } catch (err: any) {
            logger
              .child('notify:composite')
              .error('Failed to dynamically activate %s: %s', ch, err.message);
          }
        }
      }
    }

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
    await this.syncResolvedOwner();

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
