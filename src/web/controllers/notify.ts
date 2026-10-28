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

export async function handleTestNotify(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  method: string
): Promise<void> {
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
      } catch {
        // ignore malformed body
      }
    }

    const resolved = { ...baseResolved };
    let hasOverrides = false;

    const rawWebhook = testOverrides.notificationWebhookUrl ?? testOverrides.webhookUrl;
    if (typeof rawWebhook === 'string' && rawWebhook.trim()) {
      resolved.notificationWebhookUrl = rawWebhook.trim();
      hasOverrides = true;
    }

    if (typeof testOverrides.webhookSecret === 'string' && testOverrides.webhookSecret.trim()) {
      resolved.webhookSecret = testOverrides.webhookSecret.trim();
      hasOverrides = true;
    }

    if (typeof testOverrides.discordToken === 'string' && testOverrides.discordToken.trim()) {
      resolved.discordToken = testOverrides.discordToken.trim();
      hasOverrides = true;
    }

    const rawDiscordChan =
      testOverrides.discordNotificationChannelId ?? testOverrides.discordChannelId;
    if (typeof rawDiscordChan === 'string' && rawDiscordChan.trim()) {
      resolved.discordNotificationChannelId = rawDiscordChan.trim();
      hasOverrides = true;
    }

    const channel =
      targetChannel ??
      (resolved.notificationChannels && resolved.notificationChannels.length > 0
        ? resolved.notificationChannels.join(', ')
        : (resolved.notificationChannel ?? 'none'));

    const sampleAlert = {
      pool: {
        poolId: 'test-pool',
        family: 'claude' as const,
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
      activeNotifier = await createNotifier(targetChannel ?? resolved, resolved);
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
    if (err instanceof PayloadTooLargeError || err?.statusCode === 413) {
      sendPayloadTooLarge(req, res, err?.message);
      return;
    }
    return sendJson(res, 500, {
      success: false,
      error: err?.message || 'Failed to send test notification',
    });
  }
}
