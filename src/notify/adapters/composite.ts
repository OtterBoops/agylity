import type {
  Notifier,
  NotifierFactory,
  NotifierOptions,
  QuotaAlert,
  DispatchStatusUpdate,
  DeliveryOutcome,
  DeliveryChannelResult,
  InfoNotice,
} from '../types.js';
import { type ResolvedConfig } from '../../config/types.js';
import type { NotificationDestination } from '../../shared/contracts.js';
import { destinationChannelName } from '../../config/destinations.js';
import { logger } from '../../logs/logger.js';
import { notificationKindEnabled, type NotificationKind } from '../../shared/notificationKinds.js';

/** Trimmed, lowercased, de-duplicated channel names; blank entries and `none` are dropped. */
export const normalizeChannelNames = (raw: Iterable<string>): string[] =>
  Array.from(
    new Set([...raw].map((c) => c.trim().toLowerCase()).filter((c) => Boolean(c) && c !== 'none'))
  );

export class CompositeNotifier implements Notifier {
  public readonly notifiers: Notifier[];
  private readonly options?: NotifierOptions;
  private lastConfig: Partial<ResolvedConfig> = {};
  private readonly silenced = new Set<NotificationKind>();
  private destinations: NotificationDestination[] = [];
  private readonly factory?: NotifierFactory;

  get channelName(): string {
    if (this.notifiers.length === 0) return 'none';
    if (this.notifiers.length === 1 && this.notifiers[0]) return this.notifiers[0].channelName;
    return 'composite';
  }

  constructor(
    notifiers: Notifier[] = [],
    options?: NotifierOptions,
    initialConfig?: Partial<ResolvedConfig>,
    factory?: NotifierFactory
  ) {
    this.notifiers = notifiers;
    this.options = options;
    this.factory = factory;
    if (initialConfig) {
      this.lastConfig = { ...initialConfig };
    }
  }

  public getNotifier(channelName: string): Notifier | undefined {
    return this.notifiers.find((n) => n.channelName === channelName);
  }

  /** The instances this composite was built from; `updateConfig` diffs against it. */
  public setDestinations(destinations: NotificationDestination[]): void {
    this.destinations = destinations.map((destination) => ({ ...destination }));
  }

  public getDestinations(): NotificationDestination[] {
    return this.destinations.map((destination) => ({ ...destination }));
  }

  private isDiscordNotifier(notifier: Notifier): boolean {
    return (
      notifier.destinationType === 'discord' ||
      notifier.channelName === 'discord' ||
      notifier.channelName.startsWith('discord:')
    );
  }

  async initialize(): Promise<void> {
    const results = await Promise.allSettled(this.notifiers.map((n) => n.initialize()));
    results.forEach((res, i) => {
      if (res.status === 'rejected') {
        logger
          .child('notify:composite')
          .error(
            'Notification adapter %s failed to initialize: %s',
            this.notifiers[i]?.channelName ?? 'unknown',
            (res.reason as any)?.message ?? String(res.reason)
          );
      }
    });
  }

  private async syncResolvedOwner(): Promise<void> {
    const discordNotifier = this.notifiers.find((n) => this.isDiscordNotifier(n)) as any;
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

  private async fanOutOutcome(
    label: string,
    deliver: (notifier: Notifier) => Promise<DeliveryOutcome | void>
  ): Promise<DeliveryOutcome> {
    const results = await Promise.allSettled(this.notifiers.map(deliver));
    const channelResults: Record<string, DeliveryChannelResult> = {};
    let delivered = this.notifiers.length === 0;
    results.forEach((res, i) => {
      const channelName = this.notifiers[i]?.channelName ?? `channel-${i}`;
      if (res.status === 'fulfilled') {
        const outcome = res.value as DeliveryOutcome | undefined;
        const ok = !outcome || outcome.delivered !== false;
        const innerErr = outcome?.results?.[channelName]?.error;
        channelResults[channelName] = innerErr ? { success: ok, error: innerErr } : { success: ok };
        if (ok) delivered = true;
      } else {
        channelResults[channelName] = {
          success: false,
          error: (res.reason as any)?.message ?? String(res.reason),
        };
        logger.child('notify:composite').error('%s delivery error:', label, res.reason);
      }
    });
    return { delivered, results: channelResults };
  }

  // A suppressed type still logs where it fired; only the delivery is skipped, and the ledger row
  // names each active destination as suppressed so the history shows what a switch silenced.
  private gate(kind: NotificationKind): DeliveryOutcome | undefined {
    if (notificationKindEnabled(this.lastConfig.notificationTypes, kind)) return undefined;
    if (!this.silenced.has(kind)) {
      this.silenced.add(kind);
      logger
        .child('notify')
        .info(
          'Notification type "%s" is switched off; its events are logged but not delivered',
          kind
        );
    }
    const results: Record<string, DeliveryChannelResult> = {};
    if (this.notifiers.length === 0) {
      results.none = { success: false, suppressed: true };
    } else {
      for (const notifier of this.notifiers) {
        results[notifier.channelName] = { success: false, suppressed: true };
      }
    }
    return { delivered: false, suppressed: true, results };
  }

  async notifyQuotaAlert(alert: QuotaAlert): Promise<DeliveryOutcome> {
    const suppressed = this.gate('quota_alert');
    if (suppressed) return suppressed;
    await this.syncResolvedOwner();
    return this.fanOutOutcome('Quota alert', (n) => n.notifyQuotaAlert(alert));
  }

  async notifyDispatchStatus(status: DispatchStatusUpdate): Promise<void> {
    if (this.gate('dispatch')) return;
    const results = await Promise.allSettled(
      this.notifiers.map((n) => n.notifyDispatchStatus(status))
    );
    for (const res of results) {
      if (res.status === 'rejected') {
        logger.child('notify:composite').error('Dispatch status delivery error:', res.reason);
      }
    }
  }

  async notifyInfo(notice: InfoNotice): Promise<DeliveryOutcome> {
    return this.gate(notice.kind) ?? this.fanOutOutcome('Info notice', (n) => n.notifyInfo(notice));
  }

  private requireFactory(): NotifierFactory {
    if (!this.factory) {
      throw new Error('CompositeNotifier cannot rebuild destinations without a NotifierFactory');
    }
    return this.factory;
  }

  private async syncDestinations(next: NotificationDestination[]): Promise<void> {
    const enabled = next.filter((destination) => destination.enabled);
    const wanted = new Set(enabled.map((destination) => destinationChannelName(destination)));
    const factory = this.requireFactory();
    const { createNotifierForDestination, applyDestinationConfig } = factory;

    const toKeep: Notifier[] = [];
    for (const notifier of this.notifiers) {
      if (wanted.has(notifier.channelName)) {
        toKeep.push(notifier);
        continue;
      }
      try {
        await notifier.shutdown();
      } catch (err: any) {
        logger
          .child('notify:composite')
          .error('Shutdown error on %s: %s', notifier.channelName, err?.message ?? err);
      }
    }

    const current = new Set(toKeep.map((notifier) => notifier.channelName));
    for (const destination of enabled) {
      const name = destinationChannelName(destination);
      if (!current.has(name)) {
        try {
          const created = await createNotifierForDestination(
            destination,
            this.lastConfig as ResolvedConfig,
            this.options
          );
          await created.initialize();
          toKeep.push(created);
        } catch (err: any) {
          logger
            .child('notify:composite')
            .error('Failed to activate %s: %s', name, err?.message ?? err);
        }
      }
    }

    this.notifiers.length = 0;
    this.notifiers.push(...toKeep);
    this.setDestinations(next);

    const byName = new Map(
      enabled.map((destination) => [destinationChannelName(destination), destination])
    );
    await Promise.all(
      toKeep.map(async (notifier) => {
        const destination = byName.get(notifier.channelName);
        if (!destination || !notifier.updateConfig) return;
        try {
          await notifier.updateConfig(
            applyDestinationConfig(this.lastConfig as ResolvedConfig, destination)
          );
        } catch (err: any) {
          logger
            .child('notify:composite')
            .error('Failed to update config on %s: %s', notifier.channelName, err?.message ?? err);
        }
      })
    );
  }

  async updateConfig(newConfig: Partial<ResolvedConfig>): Promise<void> {
    this.lastConfig = { ...this.lastConfig, ...newConfig };

    if (newConfig.destinations !== undefined) {
      await this.syncDestinations(newConfig.destinations as NotificationDestination[]);
      // Each adapter already took its own instance config; a second pass with the top-level legacy
      // fields would overwrite its token/url/pingOwner with whatever the global config says.
      return;
    }

    // A destination write carries its own membership; the legacy channel toggle only runs when the
    // caller did not send instances, so an instance edit never shuts the other instances down.
    const rawChannels =
      newConfig.destinations !== undefined
        ? undefined
        : newConfig.notificationChannels !== undefined
          ? newConfig.notificationChannels
          : newConfig.notificationChannel !== undefined
            ? newConfig.notificationChannel === 'none'
              ? []
              : [newConfig.notificationChannel]
            : undefined;

    if (rawChannels !== undefined) {
      const targetChannelNames = normalizeChannelNames(
        (Array.isArray(rawChannels) ? rawChannels : [rawChannels]).map(String)
      );

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

      const currentNames = this.notifiers.map((n) => n.channelName);
      for (const ch of targetChannelNames) {
        if (!currentNames.includes(ch)) {
          try {
            const { createNotifier } = this.requireFactory();
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

    if (this.destinations.length > 0) {
      const { applyDestinationConfig } = this.requireFactory();
      const byName = new Map(
        this.destinations
          .filter((destination) => destination.enabled)
          .map((destination) => [destinationChannelName(destination), destination])
      );
      await Promise.all(
        this.notifiers.map(async (n) => {
          if (!n.updateConfig) return;
          const destination = byName.get(n.channelName);
          if (!destination) return;
          try {
            await n.updateConfig(
              applyDestinationConfig(this.lastConfig as ResolvedConfig, destination)
            );
          } catch (err: any) {
            logger
              .child('notify:composite')
              .error('Failed to update config on %s: %s', n.channelName, err.message);
          }
        })
      );
      return;
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
