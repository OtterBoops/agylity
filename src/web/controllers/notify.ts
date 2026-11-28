import type http from 'node:http';
import {
  sendJson,
  methodNotAllowed,
  readBody,
  PayloadTooLargeError,
  sendPayloadTooLarge,
} from '../http.js';
import type { WebServerOptions } from '../types.js';
import { logger } from '../../logs/logger.js';
import { NotificationDestinationSchema } from '../../config/env.js';
import { type ResolvedConfig } from '../../config/types.js';
import { resolvedDestinations } from '../../notify/factory.js';
import { destinationChannelName, mergeDestinationSecrets } from '../../config/destinations.js';
import type { NotificationDestination } from '../../shared/contracts.js';

/** The four stored secrets/URLs a legacy test payload may override without saving. */
type OverridableStringKey =
  'notificationWebhookUrl' | 'webhookSecret' | 'discordToken' | 'discordNotificationChannelId';

const sampleAlert = () => ({
  pool: {
    poolId: 'test-pool',
    poolGroup: 'claude' as const,
    displayName: 'Test Notification — Claude',
    remainingFraction: 0.45,
    resetTime: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
    hoursUntilReset: 3.0,
    models: ['claude-sonnet'],
  },
  milestoneHours: 3,
  remainingPercentage: 45,
  triggeredAt: new Date().toISOString(),
});

type TestNotifier = {
  channelName: string;
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  testNotification?: (
    target?: string
  ) => Promise<{ success: boolean; message: string; channel?: string }>;
  notifyQuotaAlert?: (alert: any) => Promise<unknown>;
};

type TestResult = { success: boolean; message: string; channel: string };

const deliverTest = async (notifier: TestNotifier, channel: string): Promise<TestResult> => {
  await notifier.initialize();
  try {
    if (notifier.testNotification) {
      const res = await notifier.testNotification();
      return { success: res.success, message: res.message, channel };
    }
    await notifier.notifyQuotaAlert?.(sampleAlert());
    return { success: true, message: `Test notification sent via ${channel}`, channel };
  } finally {
    await notifier.shutdown().catch(() => {});
  }
};

export const handleTestNotify = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  method: string
): Promise<void> => {
  const log = options.logger ?? logger.child('web');
  if (method !== 'POST') return methodNotAllowed(res);

  let body: string;
  try {
    body = await readBody(req, res);
  } catch (err: any) {
    if (err instanceof PayloadTooLargeError || err?.statusCode === 413) {
      sendPayloadTooLarge(req, res, err?.message);
      return;
    }
    throw err;
  }

  try {
    const baseResolved = options.configStore.resolveConfig();
    let payload: Record<string, any> = {};
    if (body.trim()) {
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === 'object') payload = parsed;
      } catch {}
    }

    const { createNotifierForDestination } = await import('../../notify/factory.js');

    // A draft instance and a stored one take the same path: build a throwaway adapter, touch no config.
    let draft: NotificationDestination | undefined;
    if (payload.destination !== undefined) {
      const parsedDraft = NotificationDestinationSchema.safeParse(payload.destination);
      if (!parsedDraft.success) {
        const reason = parsedDraft.error.issues[0]?.message ?? 'invalid destination payload';
        return sendJson(res, 400, {
          success: false,
          channel: 'draft',
          message: `Invalid notification destination: ${reason}`,
        });
      }
      draft = parsedDraft.data;
    }
    const destinationId =
      typeof payload.destinationId === 'string' ? payload.destinationId.trim() : '';
    const masterKey = options.configStore.getDatabase().getMasterKey();

    if (draft || destinationId) {
      const stored = resolvedDestinations(baseResolved, masterKey);
      // A draft that still carries a mask stands for the secret of the instance it came from.
      const destination: NotificationDestination | undefined = draft
        ? mergeDestinationSecrets([draft], stored)[0]
        : stored.find((entry) => entry.id === destinationId);
      if (!destination) {
        return sendJson(res, 400, {
          success: false,
          channel: destinationId || 'unknown',
          message: `Notification destination "${destinationId}" is not configured.`,
        });
      }
      const channel = destinationChannelName(destination);
      const notifier = await createNotifierForDestination(destination, baseResolved, {});
      const result = await deliverTest(notifier, channel);
      log.info(
        'Test notification executed via Web API (destination: %s, success: %s)',
        channel,
        result.success
      );
      return sendJson(res, result.success ? 200 : 400, result);
    }

    // Legacy shape: per-field overrides for one channel, still never persisted.
    let targetChannel: string | undefined;
    if (payload.channel && typeof payload.channel === 'string') {
      targetChannel = payload.channel.trim().toLowerCase();
    }
    const resolved: ResolvedConfig = { ...baseResolved };
    let hasOverrides = false;

    const rawWebhook = payload.notificationWebhookUrl ?? payload.webhookUrl;
    const rawDiscordChan = payload.discordNotificationChannelId ?? payload.discordChannelId;

    const applyStringOverride = (key: OverridableStringKey, raw: unknown): void => {
      if (typeof raw !== 'string' || raw.trim() === '') return;
      const clean = raw.trim();
      if (clean === baseResolved[key]) return;
      resolved[key] = clean;
      hasOverrides = true;
    };

    applyStringOverride('notificationWebhookUrl', rawWebhook);
    applyStringOverride('webhookSecret', payload.webhookSecret);
    applyStringOverride('discordToken', payload.discordToken);
    applyStringOverride('discordNotificationChannelId', rawDiscordChan);

    if (typeof payload.discordOwnerUserId === 'string') {
      const clean = payload.discordOwnerUserId.trim() || undefined;
      if (clean !== baseResolved.discordOwnerUserId) {
        resolved.discordOwnerUserId = clean;
        hasOverrides = true;
      }
    }

    if (typeof payload.discordPingOwner === 'boolean') {
      if (payload.discordPingOwner !== baseResolved.discordPingOwner) {
        resolved.discordPingOwner = payload.discordPingOwner;
        hasOverrides = true;
      }
    }

    if (!targetChannel && hasOverrides) {
      if (payload.discordToken || rawDiscordChan) {
        targetChannel = 'discord';
      } else if (rawWebhook || payload.webhookSecret) {
        targetChannel = 'webhook';
      }
    }

    const channel =
      targetChannel ??
      (resolved.notificationChannels.length > 0
        ? resolved.notificationChannels.join(', ')
        : resolved.notificationChannel);

    let activeNotifier: any;
    if (!hasOverrides && options.notifier) {
      if (targetChannel) {
        if (options.notifier.channelName === targetChannel) {
          activeNotifier = options.notifier;
        } else if (
          'getNotifier' in options.notifier &&
          typeof (options.notifier as any).getNotifier === 'function'
        ) {
          activeNotifier = (options.notifier as any).getNotifier(targetChannel);
        }
      } else if (options.notifier.channelName !== 'none') {
        activeNotifier = options.notifier;
      }
    }

    let shouldShutdown = false;
    if (!activeNotifier) {
      const { createNotifier } = await import('../../notify/factory.js');
      activeNotifier = await createNotifier(targetChannel ?? resolved, resolved, {});
      shouldShutdown = true;
    }

    let isSuccess = true;
    let resultMessage = `Test notification sent via ${channel}!`;
    try {
      if (shouldShutdown) await activeNotifier.initialize();
      if (activeNotifier.testNotification) {
        const testRes = await activeNotifier.testNotification(targetChannel);
        isSuccess = testRes.success;
        resultMessage = testRes.message;
      } else {
        await activeNotifier.notifyQuotaAlert(sampleAlert());
      }
    } finally {
      if (shouldShutdown) await activeNotifier.shutdown().catch(() => {});
    }

    log.info(
      'Test notification executed via Web API (channel: %s, success: %s)',
      channel,
      isSuccess
    );
    return sendJson(res, isSuccess ? 200 : 400, {
      success: isSuccess,
      channel,
      message: resultMessage,
    });
  } catch (err: any) {
    log.error('Test notification failed: %s', err?.stack ?? err);
    return sendJson(res, 500, {
      success: false,
      error: 'Failed to send test notification',
    });
  }
};
