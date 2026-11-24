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

/** The four stored secrets/URLs a test payload may override without saving. */
type OverridableStringKey =
  'notificationWebhookUrl' | 'webhookSecret' | 'discordToken' | 'discordNotificationChannelId';

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
    let targetChannel: string | undefined;
    let testOverrides: Record<string, unknown> = {};

    if (body.trim()) {
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === 'object') {
          if (parsed.channel && typeof parsed.channel === 'string') {
            targetChannel = parsed.channel.trim().toLowerCase();
          }
          testOverrides = parsed;
        }
      } catch {}
    }

    const resolved = { ...baseResolved };
    let hasOverrides = false;

    const rawWebhook = testOverrides.notificationWebhookUrl ?? testOverrides.webhookUrl;
    const rawDiscordChan =
      testOverrides.discordNotificationChannelId ?? testOverrides.discordChannelId;

    // Only a value that differs from the stored one is an override; the stored config is the baseline.
    const applyStringOverride = (key: OverridableStringKey, raw: unknown): void => {
      if (typeof raw !== 'string' || raw.trim() === '') return;
      const clean = raw.trim();
      if (clean === baseResolved[key]) return;
      resolved[key] = clean;
      hasOverrides = true;
    };

    applyStringOverride('notificationWebhookUrl', rawWebhook);
    applyStringOverride('webhookSecret', testOverrides.webhookSecret);
    applyStringOverride('discordToken', testOverrides.discordToken);
    applyStringOverride('discordNotificationChannelId', rawDiscordChan);

    if (typeof testOverrides.discordOwnerUserId === 'string') {
      const clean = testOverrides.discordOwnerUserId.trim() || undefined;
      if (clean !== baseResolved.discordOwnerUserId) {
        resolved.discordOwnerUserId = clean;
        hasOverrides = true;
      }
    }

    if (typeof testOverrides.discordPingOwner === 'boolean') {
      if (testOverrides.discordPingOwner !== baseResolved.discordPingOwner) {
        resolved.discordPingOwner = testOverrides.discordPingOwner;
        hasOverrides = true;
      }
    }

    if (!targetChannel && hasOverrides) {
      if (testOverrides.discordToken || rawDiscordChan) {
        targetChannel = 'discord';
      } else if (rawWebhook || testOverrides.webhookSecret) {
        targetChannel = 'webhook';
      }
    }

    const channel =
      targetChannel ??
      (resolved.notificationChannels.length > 0
        ? resolved.notificationChannels.join(', ')
        : resolved.notificationChannel);

    const sampleAlert = {
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
    };

    let resultMessage = `Test notification sent via ${channel}!`;
    let isSuccess = true;

    let activeNotifier: any;
    let shouldShutdown = false;

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

    if (!activeNotifier) {
      const { createNotifier } = await import('../../notify/factory.js');
      activeNotifier = await createNotifier(targetChannel ?? resolved, resolved, {
        onOwnerDiscovered: async (ownerId: string) => {
          if (!resolved.discordOwnerUserId && options.configStore) {
            options.configStore.setOverride('discordOwnerUserId', ownerId);
          }
        },
      });
      shouldShutdown = true;
    }

    try {
      if (shouldShutdown) {
        await activeNotifier.initialize();
      }

      if (activeNotifier.testNotification) {
        const testRes = await activeNotifier.testNotification(targetChannel);
        isSuccess = testRes.success;
        resultMessage = testRes.message;
      } else {
        await activeNotifier.notifyQuotaAlert(sampleAlert);
      }
    } finally {
      if (shouldShutdown) {
        await activeNotifier.shutdown();
      }
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
