import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { WebhookNotifier } from '../../src/notify/adapters/webhook.js';
import { CompositeNotifier } from '../../src/notify/adapters/composite.js';
import { createNotifier } from '../../src/notify/factory.js';
import type { Notifier, QuotaAlert, DispatchStatusUpdate } from '../../src/notify/types.js';
import type { ResolvedConfig } from '../../src/config/schema.js';
import { BUILTIN_DEFAULTS } from '../../src/config/schema.js';

describe('Unit Tests: Multi-Channel & Pluggable Notification Adapters', () => {
  const sampleAlert: QuotaAlert = {
    pool: {
      poolId: 'claude-weekly',
      family: 'claude',
      displayName: 'Claude 3.5 Sonnet (Weekly)',
      remainingFraction: 0.35,
      resetTime: '2026-10-27T00:00:00Z',
      hoursUntilReset: 48,
      models: ['claude-3-5-sonnet'],
    },
    milestoneHours: 24,
    remainingPercentage: 35,
    triggeredAt: '2026-10-25T00:00:00Z',
  };

  const sampleDispatch: DispatchStatusUpdate = {
    status: 'executing',
    repositoryName: 'agylity',
    branchName: 'antigravity/continuation-test',
    message: 'Worker running continuation script',
    durationMs: 1200,
  };

  /* ==================================================================== */
  /* 1. Dedicated WebhookNotifier Unit Tests                              */
  /* ==================================================================== */
  describe('1. WebhookNotifier', () => {
    it('initializes and shuts down cleanly', async () => {
      const notifier = new WebhookNotifier({ notificationWebhookUrl: 'http://localhost/hook' });
      assert.equal(notifier.initialized, false);
      await notifier.initialize();
      assert.equal(notifier.initialized, true);
      await notifier.shutdown();
      assert.equal(notifier.initialized, false);
    });

    it('returns error when testNotification is called without configured URL', async () => {
      const notifier = new WebhookNotifier({ notificationWebhookUrl: '' });
      await notifier.initialize();
      const res = await notifier.testNotification();
      assert.equal(res.success, false);
      assert.ok(res.message.includes('No webhook URL configured'));
      await notifier.shutdown();
    });

    it('dispatches quota alert payload with correct JSON format and HMAC signature', async () => {
      let receivedHeaders: http.IncomingHttpHeaders = {};
      let receivedBody: any = null;

      const server = http.createServer((req, res) => {
        receivedHeaders = req.headers;
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          receivedBody = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      });

      try {
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        const port = (server.address() as { port: number }).port;
        const testUrl = `http://127.0.0.1:${port}/webhook-test`;
        const secret = 'super-secret-hmac-key';

        const notifier = new WebhookNotifier({
          notificationWebhookUrl: testUrl,
          webhookSecret: secret,
        });
        await notifier.initialize();

        await notifier.notifyQuotaAlert(sampleAlert);

        assert.equal(receivedBody.event, 'quota_alert');
        assert.equal(receivedBody.poolId, 'claude-weekly');
        assert.equal(receivedBody.milestone, 24);
        assert.equal(receivedBody.data.remainingPercentage, 35);
        assert.equal(receivedBody.data.displayName, 'Claude 3.5 Sonnet (Weekly)');

        // Validate HMAC signature
        const signatureHeader = receivedHeaders['x-agylity-signature'] as string;
        assert.ok(signatureHeader);
        assert.ok(signatureHeader.startsWith('sha256='));

        const expectedHash = crypto
          .createHmac('sha256', secret)
          .update(JSON.stringify(receivedBody))
          .digest('hex');
        assert.equal(signatureHeader, `sha256=${expectedHash}`);

        // Also test dispatch status
        await notifier.notifyDispatchStatus(sampleDispatch);
        assert.equal(receivedBody.event, 'dispatch_status');
        assert.equal(receivedBody.status, 'executing');
        assert.equal(receivedBody.message, 'Worker running continuation script');

        // Also test testNotification ping
        const testResult = await notifier.testNotification();
        assert.equal(testResult.success, true);
        assert.equal(receivedBody.event, 'test_ping');

        await notifier.shutdown();
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });

    it('safely handles non-200 HTTP responses without throwing unhandled rejection', async () => {
      const server = http.createServer((req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      });

      try {
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        const port = (server.address() as { port: number }).port;
        const notifier = new WebhookNotifier({
          notificationWebhookUrl: `http://127.0.0.1:${port}/fail`,
        });
        await notifier.initialize();

        // notifyQuotaAlert should swallow HTTP errors and not crash
        await notifier.notifyQuotaAlert(sampleAlert);

        // testNotification should return structured failure
        const testRes = await notifier.testNotification();
        assert.equal(testRes.success, false);
        assert.ok(testRes.message.includes('Webhook ping failed'));

        await notifier.shutdown();
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });
  });

  /* ==================================================================== */
  /* 2. CompositeNotifier Unit Tests                                      */
  /* ==================================================================== */
  describe('2. CompositeNotifier', () => {
    it('handles empty notifier list as silent channel', async () => {
      const composite = new CompositeNotifier([]);
      assert.equal(composite.channelName, 'none');
      assert.equal(composite.getNotifiers().length, 0);

      await composite.initialize();
      await composite.notifyQuotaAlert(sampleAlert);
      await composite.notifyDispatchStatus(sampleDispatch);

      const testRes = await composite.testNotification();
      assert.equal(testRes.success, true);
      assert.equal(testRes.channel, 'none');

      await composite.shutdown();
    });

    it('broadcasts quota alerts and dispatch updates to all child notifiers concurrently', async () => {
      let n1AlertReceived = false;
      let n2AlertReceived = false;
      let n1DispatchReceived = false;
      let n2DispatchReceived = false;

      const mockNotifier1: Notifier = {
        channelName: 'mock1',
        initialize: async () => {},
        shutdown: async () => {},
        notifyQuotaAlert: async () => {
          n1AlertReceived = true;
        },
        notifyDispatchStatus: async () => {
          n1DispatchReceived = true;
        },
        testNotification: async () => ({ success: true, message: 'Mock1 OK', channel: 'mock1' }),
      };

      const mockNotifier2: Notifier = {
        channelName: 'mock2',
        initialize: async () => {},
        shutdown: async () => {},
        notifyQuotaAlert: async () => {
          n2AlertReceived = true;
        },
        notifyDispatchStatus: async () => {
          n2DispatchReceived = true;
        },
        testNotification: async () => ({ success: true, message: 'Mock2 OK', channel: 'mock2' }),
      };

      const composite = new CompositeNotifier([mockNotifier1, mockNotifier2]);
      assert.equal(composite.channelName, 'composite');
      assert.equal(composite.getNotifiers().length, 2);

      await composite.initialize();
      await composite.notifyQuotaAlert(sampleAlert);
      assert.equal(n1AlertReceived, true);
      assert.equal(n2AlertReceived, true);

      await composite.notifyDispatchStatus(sampleDispatch);
      assert.equal(n1DispatchReceived, true);
      assert.equal(n2DispatchReceived, true);

      const testRes = await composite.testNotification();
      assert.equal(testRes.success, true);
      assert.ok(testRes.message.includes('mock1: Mock1 OK'));
      assert.ok(testRes.message.includes('mock2: Mock2 OK'));

      await composite.shutdown();
    });

    it('isolates errors when one child notifier rejects during broadcast', async () => {
      let healthyReceived = false;

      const failingNotifier: Notifier = {
        channelName: 'failing',
        initialize: async () => {},
        shutdown: async () => {},
        notifyQuotaAlert: async () => {
          throw new Error('Explosion in failing adapter');
        },
        notifyDispatchStatus: async () => {
          throw new Error('Explosion in failing dispatch');
        },
        testNotification: async () => {
          throw new Error('Test ping crashed');
        },
      };

      const healthyNotifier: Notifier = {
        channelName: 'healthy',
        initialize: async () => {},
        shutdown: async () => {},
        notifyQuotaAlert: async () => {
          healthyReceived = true;
        },
        notifyDispatchStatus: async () => {},
        testNotification: async () => ({
          success: true,
          message: 'Healthy OK',
          channel: 'healthy',
        }),
      };

      const composite = new CompositeNotifier([failingNotifier, healthyNotifier]);
      await composite.initialize();

      // notifyQuotaAlert should complete without throwing unhandled rejection
      await composite.notifyQuotaAlert(sampleAlert);
      assert.equal(healthyReceived, true);

      // testNotification should capture the error per-channel
      const testRes = await composite.testNotification();
      assert.equal(testRes.success, false);
      assert.equal(testRes.results?.['failing']?.success, false);
      assert.equal(testRes.results?.['healthy']?.success, true);

      // Targeted testing of single channel
      const targetedRes = await composite.testNotification('healthy');
      assert.equal(targetedRes.success, true);
      assert.equal(targetedRes.results?.['healthy']?.success, true);

      await composite.shutdown();
    });

    it('forwards updateConfig to all child notifiers implementing it', async () => {
      let updatedConfig: Partial<ResolvedConfig> | null = null;

      const mockNotifier: Notifier = {
        channelName: 'updatable',
        initialize: async () => {},
        shutdown: async () => {},
        notifyQuotaAlert: async () => {},
        notifyDispatchStatus: async () => {},
        updateConfig: async (cfg) => {
          updatedConfig = cfg;
        },
      };

      const composite = new CompositeNotifier([mockNotifier]);
      await composite.updateConfig({ quotaAlertThresholdPercent: 50 });
      assert.deepEqual(updatedConfig, { quotaAlertThresholdPercent: 50 });
    });
  });

  /* ==================================================================== */
  /* 3. createNotifier Multi-Channel Factory Integration                  */
  /* ==================================================================== */
  describe('3. createNotifier Factory Integration', () => {
    it('returns SilentNotifier (CompositeNotifier with channelName none) when channels is empty or none', async () => {
      const notifierEmpty = await createNotifier('');
      assert.equal(notifierEmpty.channelName, 'none');

      const notifierNone = await createNotifier('none');
      assert.equal(notifierNone.channelName, 'none');

      const notifierConfigNone = await createNotifier({
        ...BUILTIN_DEFAULTS,
        notificationChannels: [],
      });
      assert.equal(notifierConfigNone.channelName, 'none');
    });

    it('creates single WebhookNotifier when only webhook is specified', async () => {
      const notifier = await createNotifier('webhook');
      assert.equal(notifier.channelName, 'webhook');
      assert.equal(notifier instanceof WebhookNotifier, true);
    });

    it('creates single ConsoleNotifier when only console is specified', async () => {
      const notifier = await createNotifier('console');
      assert.equal(notifier.channelName, 'console');
    });

    it('creates CompositeNotifier when multiple comma-separated channels are provided', async () => {
      const notifier = await createNotifier('console,webhook');
      assert.equal(notifier.channelName, 'composite');
      assert.equal(notifier instanceof CompositeNotifier, true);

      const children = (notifier as CompositeNotifier).getNotifiers();
      assert.equal(children.length, 2);
      assert.equal(children[0].channelName, 'console');
      assert.equal(children[1].channelName, 'webhook');
    });

    it('creates CompositeNotifier when notificationChannels array has multiple entries', async () => {
      const config: ResolvedConfig = {
        ...BUILTIN_DEFAULTS,
        notificationChannels: ['console', 'webhook'],
      };
      const notifier = await createNotifier(config);
      assert.equal(notifier.channelName, 'composite');

      const children = (notifier as CompositeNotifier).getNotifiers();
      assert.equal(children.length, 2);
      assert.equal(children[0].channelName, 'console');
      assert.equal(children[1].channelName, 'webhook');
    });

    it('deduplicates identical channels in input string or array', async () => {
      const notifier = await createNotifier('console,console,console');
      assert.equal(notifier.channelName, 'console');
    });
  });
});
