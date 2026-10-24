import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  ConnectRpcQuotaClient,
  LanguageServerError,
  RPC_PATH,
  QUOTA_SUMMARY_RPC_PATH,
} from '../../src/sentry/client.js';
import { createNotifier, CompositeNotifier } from '../../src/notify/factory.js';
import { ConsoleNotifier } from '../../src/notify/adapters/console.js';
import type { QuotaAlert, DispatchStatusUpdate } from '../../src/notify/types.js';
import { BUILTIN_DEFAULTS, type ResolvedConfig } from '../../src/config/schema.js';

describe('Challenger M2: Empirical Verification of Process Discovery & Notifier Dispatch', () => {
  let unhandledRejections: any[] = [];
  let originalEnv: NodeJS.ProcessEnv;

  const rejectionHandler = (reason: any) => {
    unhandledRejections.push(reason);
  };

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.ANTIGRAVITY_CSRF_TOKEN;
    delete process.env.ANTIGRAVITY_ENDPOINT_URL;
    delete process.env.ANTIGRAVITY_LS_PORT;
    delete process.env.REMOTE_AGY_BIN_PATH;
    delete process.env.AGY_BIN_PATH;

    unhandledRejections = [];
    process.on('unhandledRejection', rejectionHandler);
  });

  afterEach(() => {
    process.env = originalEnv;
    process.removeListener('unhandledRejection', rejectionHandler);
    assert.equal(
      unhandledRejections.length,
      0,
      `Detected ${unhandledRejections.length} unhandled rejection(s): ${JSON.stringify(
        unhandledRejections.map((e) => (e instanceof Error ? e.stack || e.message : String(e)))
      )}`
    );
  });

  /* ========================================================================= */
  /* Part 1: ConnectRpcQuotaClient Process Discovery & Port Fallbacks          */
  /* ========================================================================= */
  describe('Part 1: ConnectRpcQuotaClient Discovery, Fallback Ports & CLI Introspection', () => {
    const createMockQuotaSummaryResponse = () => ({
      response: {
        groups: [
          {
            displayName: 'Claude and GPT models',
            buckets: [
              {
                bucketId: '3p-weekly',
                displayName: 'Weekly Limit Remaining',
                window: 'weekly',
                remainingFraction: 0.65,
                resetTime: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
              },
              {
                bucketId: '3p-5h',
                displayName: 'Five Hour Limit Remaining',
                window: '5h',
                remainingFraction: 0.9,
                resetTime: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
              },
            ],
          },
        ],
      },
    });

    const createMockCascadeResponse = () => ({
      clientModelConfigs: [
        {
          label: 'Claude Sonnet 5.5 (Medium)',
          modelId: 'claude-sonnet-5-5-medium',
          quotaInfo: {
            remainingFraction: 0.65,
            resetTime: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
          },
        },
      ],
    });

    it('proactively discovers live port and csrfToken, successfully fetching quota', async () => {
      let rpcReceived = false;
      let receivedCsrf = '';

      const rpcServer = createServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => {
          if (req.url === QUOTA_SUMMARY_RPC_PATH && req.method === 'POST') {
            rpcReceived = true;
            receivedCsrf = String(req.headers['x-codeium-csrf-token'] || '');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(createMockQuotaSummaryResponse()));
            return;
          }
          res.writeHead(404);
          res.end();
        });
      });

      await new Promise<void>((resolve) => rpcServer.listen(0, '127.0.0.1', () => resolve()));
      const port = (rpcServer.address() as any).port;

      try {
        const mockExecFile = async (file: string) => {
          if (file === 'powershell.exe' || file === 'pgrep') {
            return {
              stdout: `CMD: language_server.exe --csrf_token test-discovered-token\nPORTS:${port}\n`,
              stderr: '',
            };
          }
          throw new Error(`Unexpected command: ${file}`);
        };

        const client = new ConnectRpcQuotaClient({
          port: 60643,
          fallbackPorts: [60643],
          enableProcessDiscovery: true,
          enableCliFallback: false,
          timeoutMs: 1000,
          execFileFn: mockExecFile as any,
        });

        const snapshots = await client.fetchQuota();
        assert.ok(snapshots.length > 0, 'Must return at least one quota snapshot');
        assert.equal(rpcReceived, true, 'Target server must have received the RPC call');
        assert.equal(
          receivedCsrf,
          'test-discovered-token',
          'Discovered CSRF token must be passed in header'
        );
        assert.equal(snapshots[0].family, 'claude');
        assert.equal(snapshots[0].remainingFraction, 0.65);
      } finally {
        await new Promise<void>((resolve) => rpcServer.close(() => resolve()));
      }
    });

    it('handles multiple fallback ports when primary discovered port is unresponsive', async () => {
      let liveServerHit = false;

      // Spin up only the secondary server; first port will be an unbound dead loopback port
      const liveServer = createServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => {
          if (req.url === QUOTA_SUMMARY_RPC_PATH) {
            liveServerHit = true;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(createMockQuotaSummaryResponse()));
            return;
          }
          res.writeHead(404);
          res.end();
        });
      });

      await new Promise<void>((resolve) => liveServer.listen(0, '127.0.0.1', () => resolve()));
      const livePort = (liveServer.address() as any).port;
      // Guaranteed dead port: choose a distinct unused loopback port
      const deadPort = livePort >= 65000 ? livePort - 100 : livePort + 100;

      try {
        // Discovered ports list: [deadPort, livePort]
        // Note: Math.max selects the higher port as primary, and fallbackPorts preserves candidates
        const mockExecFile = async () => ({
          stdout: `CMD: language_server.exe --csrf_token fallback-token\nPORTS:${deadPort},${livePort}\n`,
          stderr: '',
        });

        const client = new ConnectRpcQuotaClient({
          port: 60643,
          enableProcessDiscovery: true,
          enableCliFallback: false,
          timeoutMs: 500,
          execFileFn: mockExecFile as any,
        });

        const snapshots = await client.fetchQuota();
        assert.equal(liveServerHit, true, 'Live fallback port must be queried and succeed');
        assert.ok(snapshots.length > 0);
        assert.equal(snapshots[0].family, 'claude');
      } finally {
        await new Promise<void>((resolve) => liveServer.close(() => resolve()));
      }
    });

    it('reactively discovers credentials when initial RPC attempts fail', async () => {
      let reactiveServerHit = false;

      const reactiveServer = createServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => {
          if (req.url === QUOTA_SUMMARY_RPC_PATH) {
            reactiveServerHit = true;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(createMockQuotaSummaryResponse()));
            return;
          }
          res.writeHead(404);
          res.end();
        });
      });

      await new Promise<void>((resolve) => reactiveServer.listen(0, '127.0.0.1', () => resolve()));
      const livePort = (reactiveServer.address() as any).port;
      const deadPort = livePort >= 65000 ? livePort - 100 : livePort + 100;

      try {
        let callCount = 0;
        const mockExecFile = async () => {
          callCount++;
          // First proactive call returns nothing, reactive call returns live port
          if (callCount === 1) {
            return { stdout: '', stderr: '' };
          }
          return {
            stdout: `CMD: language_server.exe --csrf_token reactive-token\nPORTS:${livePort}\n`,
            stderr: '',
          };
        };

        const client = new ConnectRpcQuotaClient({
          port: deadPort, // Unreachable port
          fallbackPorts: [deadPort],
          enableProcessDiscovery: true,
          enableCliFallback: false,
          timeoutMs: 400,
          execFileFn: mockExecFile as any,
        });

        const snapshots = await client.fetchQuota();
        assert.equal(reactiveServerHit, true, 'Reactive discovery must find and query live port');
        assert.ok(snapshots.length > 0);
      } finally {
        await new Promise<void>((resolve) => reactiveServer.close(() => resolve()));
      }
    });

    it('falls back to legacy GetCascadeModelConfigData when RetrieveUserQuotaSummary returns 404', async () => {
      let cascadeHit = false;

      const server = createServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => {
          if (req.url === QUOTA_SUMMARY_RPC_PATH) {
            res.writeHead(404);
            res.end();
            return;
          }
          if (req.url === RPC_PATH) {
            cascadeHit = true;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(createMockCascadeResponse()));
            return;
          }
          res.writeHead(404);
          res.end();
        });
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as any).port;

      try {
        const client = new ConnectRpcQuotaClient({
          port,
          fallbackPorts: [port],
          csrfToken: 'legacy-csrf',
          enableProcessDiscovery: false,
          enableCliFallback: false,
          timeoutMs: 1000,
        });

        const snapshots = await client.fetchQuota();
        assert.equal(cascadeHit, true, 'Legacy cascade RPC path must be queried');
        assert.equal(snapshots.length, 1);
        assert.equal(snapshots[0].family, 'claude');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('falls back to agy CLI when all RPC endpoints fail', async () => {
      let cliInvoked = false;

      const mockExecFile = async (_file: string, args: readonly string[]) => {
        if (args && args.includes('models')) {
          cliInvoked = true;
          return {
            stdout: JSON.stringify({
              status: 'SUCCESS',
              command: {
                name: 'models',
                data: {
                  models: [
                    { id: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 (High)' },
                    { id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' },
                  ],
                },
              },
            }),
            stderr: '',
          };
        }
        return { stdout: '', stderr: '' };
      };

      const client = new ConnectRpcQuotaClient({
        port: 58888, // Dead port
        fallbackPorts: [58888],
        enableProcessDiscovery: false,
        enableCliFallback: true,
        timeoutMs: 400,
        execFileFn: mockExecFile as any,
      });

      const snapshots = await client.fetchQuota();
      assert.equal(cliInvoked, true, 'CLI fallback must be executed');
      assert.equal(snapshots.length, 2);
      assert.equal(snapshots[0].family, 'claude');
      assert.equal(snapshots[1].family, 'gemini-argon');
    });

    it('throws LanguageServerError with LANGUAGE_SERVER_UNAVAILABLE when both RPC and CLI fail', async () => {
      const mockExecFile = async () => {
        throw new Error('agy CLI binary missing');
      };

      const client = new ConnectRpcQuotaClient({
        port: 58888,
        fallbackPorts: [58888],
        enableProcessDiscovery: false,
        enableCliFallback: true,
        timeoutMs: 400,
        execFileFn: mockExecFile as any,
      });

      await assert.rejects(
        async () => {
          await client.fetchQuota();
        },
        (err: unknown) => {
          assert.ok(err instanceof LanguageServerError);
          assert.equal(err.code, 'LANGUAGE_SERVER_UNAVAILABLE');
          assert.match(err.message, /Language Server Connect-RPC failed/);
          return true;
        }
      );
    });

    it('throws immediately when enableCliFallback is false and RPC fails', async () => {
      let cliCalled = false;
      const mockExecFile = async () => {
        cliCalled = true;
        return { stdout: '{}', stderr: '' };
      };

      const client = new ConnectRpcQuotaClient({
        port: 58888,
        fallbackPorts: [58888],
        enableProcessDiscovery: false,
        enableCliFallback: false,
        timeoutMs: 400,
        execFileFn: mockExecFile as any,
      });

      await assert.rejects(
        async () => {
          await client.fetchQuota();
        },
        (err: unknown) => {
          assert.ok(err instanceof LanguageServerError);
          assert.equal(err.code, 'LANGUAGE_SERVER_UNAVAILABLE');
          return true;
        }
      );
      assert.equal(cliCalled, false, 'CLI fallback must not be attempted when disabled');
    });

    it('stress-tests applyDiscoveredCredentials against malformed, boundary, and hostile inputs', async () => {
      const client = new ConnectRpcQuotaClient({
        port: 60643,
        fallbackPorts: [60643],
        enableProcessDiscovery: false,
      });

      // Inputs that must return false (no valid token, no valid ports array, no port)
      const falseInputs = [
        null,
        undefined,
        {},
        { ports: [] },
        { ports: null },
        { port: 0 },
        { csrfToken: '' },
      ];

      for (const input of falseInputs) {
        const result = (client as any).applyDiscoveredCredentials(input);
        assert.equal(
          result,
          false,
          `Input ${JSON.stringify(input)} must safely return false without throwing`
        );
      }

      // Valid token update without ports
      const tokenOnlyResult = (client as any).applyDiscoveredCredentials({
        csrfToken: 'valid-token-only',
      });
      assert.equal(tokenOnlyResult, true);
      assert.equal((client as any).csrfToken, 'valid-token-only');

      // Valid port update with single port (> 1)
      const singlePortResult = (client as any).applyDiscoveredCredentials({ port: 51234 });
      assert.equal(singlePortResult, true);
      assert.equal((client as any).port, 51234);

      // Valid ports array update
      const multiPortResult = (client as any).applyDiscoveredCredentials({
        ports: [52000, 52001, 51999],
      });
      assert.equal(multiPortResult, true);
      assert.equal((client as any).port, 52001); // Math.max
      assert.ok((client as any).fallbackPorts.includes(52000));
      assert.ok((client as any).fallbackPorts.includes(52001));
    });
  });

  /* ========================================================================= */
  /* Part 2: Notification Dispatch & Elimination of Double-Delivery Hazard     */
  /* ========================================================================= */
  describe('Part 2: Elimination of Double Webhook Delivery in CompositeNotifier', () => {
    const sampleAlert: QuotaAlert = {
      pool: {
        poolId: 'claude',
        family: 'claude',
        displayName: 'Claude 5.5 / Opus',
        remainingFraction: 0.28,
        resetTime: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
        hoursUntilReset: 12,
        models: ['Claude Sonnet 5.5'],
      },
      remainingPercentage: 28,
      milestoneHours: 12,
      triggeredAt: new Date().toISOString(),
    };

    const sampleStatus: DispatchStatusUpdate = {
      status: 'executing',
      step: 'executing',
      repositoryName: 'agylity',
      branchName: 'antigravity/task-test',
      message: 'Running verification tests',
      timestamp: new Date().toISOString(),
    };

    it('dispatches quota alert EXACTLY ONCE to webhook when channels are [console, webhook]', async () => {
      const receivedRequests: Array<{ body: any; headers: any }> = [];

      const webhookServer = createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          try {
            receivedRequests.push({ body: JSON.parse(raw), headers: req.headers });
          } catch {
            receivedRequests.push({ body: raw, headers: req.headers });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      });

      await new Promise<void>((resolve) => webhookServer.listen(0, '127.0.0.1', () => resolve()));
      const webhookPort = (webhookServer.address() as any).port;
      const webhookUrl = `http://127.0.0.1:${webhookPort}/api/webhook`;

      try {
        const config: ResolvedConfig = {
          ...BUILTIN_DEFAULTS,
          notificationChannels: ['console', 'webhook'],
          notificationWebhookUrl: webhookUrl,
          webhookSecret: 'test-secret-double-check',
        };

        const notifier = await createNotifier(config);
        assert.ok(notifier instanceof CompositeNotifier);

        // Ensure console logs don't pollute test runner output
        const origLog = console.log;
        let consoleLogged = false;
        console.log = () => {
          consoleLogged = true;
        };

        try {
          await notifier.notifyQuotaAlert(sampleAlert);
        } finally {
          console.log = origLog;
        }

        // Assertions for exact single delivery
        assert.equal(
          receivedRequests.length,
          1,
          `Webhook alert MUST be delivered exactly once; received ${receivedRequests.length}`
        );
        assert.equal(consoleLogged, true, 'ConsoleNotifier must log output to console');

        const postData = receivedRequests[0];
        assert.equal(postData.body.event, 'quota_alert');
        assert.equal(postData.body.poolId, 'claude');
        assert.equal(postData.body.milestone, 12);
        assert.ok(postData.headers['x-agylity-signature'], 'HMAC signature must be included');
      } finally {
        await new Promise<void>((resolve) => webhookServer.close(() => resolve()));
      }
    });

    it('dispatches status update EXACTLY ONCE to webhook when channels are [console, webhook]', async () => {
      const receivedRequests: Array<{ body: any }> = [];

      const webhookServer = createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          try {
            receivedRequests.push({ body: JSON.parse(raw) });
          } catch {
            receivedRequests.push({ body: raw });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      });

      await new Promise<void>((resolve) => webhookServer.listen(0, '127.0.0.1', () => resolve()));
      const webhookPort = (webhookServer.address() as any).port;
      const webhookUrl = `http://127.0.0.1:${webhookPort}/api/webhook`;

      try {
        const config: ResolvedConfig = {
          ...BUILTIN_DEFAULTS,
          notificationChannels: ['console', 'webhook'],
          notificationWebhookUrl: webhookUrl,
        };

        const notifier = await createNotifier(config);

        const origLog = console.log;
        console.log = () => {};
        try {
          await notifier.notifyDispatchStatus(sampleStatus);
        } finally {
          console.log = origLog;
        }

        assert.equal(
          receivedRequests.length,
          1,
          `Dispatch status MUST be delivered exactly once; received ${receivedRequests.length}`
        );
        assert.equal(receivedRequests[0].body.event, 'dispatch_status');
        assert.equal(receivedRequests[0].body.status, 'executing');
      } finally {
        await new Promise<void>((resolve) => webhookServer.close(() => resolve()));
      }
    });

    it('ConsoleNotifier alone performs ZERO HTTP requests even with notificationWebhookUrl configured', async () => {
      let httpRequestsCount = 0;

      const webhookServer = createServer((_req, res) => {
        httpRequestsCount++;
        res.writeHead(200);
        res.end();
      });

      await new Promise<void>((resolve) => webhookServer.listen(0, '127.0.0.1', () => resolve()));
      const webhookPort = (webhookServer.address() as any).port;
      const webhookUrl = `http://127.0.0.1:${webhookPort}/api/webhook`;

      try {
        const config: ResolvedConfig = {
          ...BUILTIN_DEFAULTS,
          notificationChannels: ['console'],
          notificationWebhookUrl: webhookUrl,
        };

        const notifier = await createNotifier(config);
        assert.ok(notifier instanceof ConsoleNotifier);

        const origLog = console.log;
        console.log = () => {};
        try {
          await notifier.notifyQuotaAlert(sampleAlert);
          await notifier.notifyDispatchStatus(sampleStatus);
          await notifier.testNotification();
        } finally {
          console.log = origLog;
        }

        assert.equal(
          httpRequestsCount,
          0,
          'ConsoleNotifier must strictly perform ZERO HTTP network requests'
        );
      } finally {
        await new Promise<void>((resolve) => webhookServer.close(() => resolve()));
      }
    });

    it('handles high-concurrency burst of 25 alerts with exact 1:1 delivery and zero loss', async () => {
      const receivedEvents: string[] = [];

      const webhookServer = createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            receivedEvents.push(parsed.poolId);
          } catch {
            receivedEvents.push('malformed');
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      });

      await new Promise<void>((resolve) => webhookServer.listen(0, '127.0.0.1', () => resolve()));
      const webhookPort = (webhookServer.address() as any).port;
      const webhookUrl = `http://127.0.0.1:${webhookPort}/api/webhook`;

      try {
        const config: ResolvedConfig = {
          ...BUILTIN_DEFAULTS,
          notificationChannels: ['console', 'webhook'],
          notificationWebhookUrl: webhookUrl,
        };

        const notifier = await createNotifier(config);

        const origLog = console.log;
        console.log = () => {};

        const burstCount = 25;
        const alerts: QuotaAlert[] = Array.from({ length: burstCount }, (_, i) => ({
          pool: {
            poolId: `pool-burst-${i}`,
            family: 'claude',
            displayName: `Burst Pool ${i}`,
            remainingFraction: 0.3,
            resetTime: new Date().toISOString(),
            hoursUntilReset: 6,
            models: ['model-x'],
          },
          remainingPercentage: 30,
          milestoneHours: 6,
          triggeredAt: new Date().toISOString(),
        }));

        try {
          await Promise.all(alerts.map((a) => notifier.notifyQuotaAlert(a)));
        } finally {
          console.log = origLog;
        }

        assert.equal(
          receivedEvents.length,
          burstCount,
          `Expected exactly ${burstCount} webhook deliveries, received ${receivedEvents.length}`
        );

        // Verify every alert was delivered
        for (let i = 0; i < burstCount; i++) {
          assert.ok(
            receivedEvents.includes(`pool-burst-${i}`),
            `Missing delivery for pool-burst-${i}`
          );
        }
      } finally {
        await new Promise<void>((resolve) => webhookServer.close(() => resolve()));
      }
    });

    it('survives abrupt webhook server socket drop without unhandled rejections', async () => {
      const dropServer = createServer((_req, res) => {
        // Destroy socket immediately to cause ECONNRESET
        res.destroy();
      });

      await new Promise<void>((resolve) => dropServer.listen(0, '127.0.0.1', () => resolve()));
      const dropPort = (dropServer.address() as any).port;
      const dropUrl = `http://127.0.0.1:${dropPort}/dropped`;

      try {
        const config: ResolvedConfig = {
          ...BUILTIN_DEFAULTS,
          notificationChannels: ['console', 'webhook'],
          notificationWebhookUrl: dropUrl,
        };

        const notifier = await createNotifier(config);

        const origLog = console.log;
        const origErr = console.error;
        console.log = () => {};
        console.error = () => {};

        try {
          // Must not throw or create unhandled rejections
          await notifier.notifyQuotaAlert(sampleAlert);
          await notifier.notifyDispatchStatus(sampleStatus);
        } finally {
          console.log = origLog;
          console.error = origErr;
        }

        assert.equal(unhandledRejections.length, 0);
      } finally {
        await new Promise<void>((resolve) => dropServer.close(() => resolve()));
      }
    });
  });
});
