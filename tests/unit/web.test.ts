import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import ky from 'ky';
import { makeTempDir } from '../e2e/harness/index.js';
import { ConfigStore } from '../../src/config/store.js';
import { SentryStateManager } from '../../src/sentry/state.js';
import { startWebServer, closeWebServer } from '../../src/web/server.js';
import type { QuotaClient, QuotaSnapshot } from '../../src/sentry/models.js';

describe('Unit Tests: Decoupled Web UI (Milestone 5)', () => {
  /* ==================================================================== */
  /* 1. Server Lifecycle & Port Collision                                 */
  /* ==================================================================== */
  describe('1. Server Lifecycle & Port Management', () => {
    it('starts on ephemeral port (0) and exposes bound port and host', async () => {
      const { dir, cleanup } = makeTempDir('web_test_start_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;

        assert.ok(server instanceof http.Server);
        assert.ok(started.port > 0, `Expected assigned port > 0, got ${started.port}`);
        assert.equal(started.host, '127.0.0.1');
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('gracefully handles and rejects on port collision (EADDRINUSE)', async () => {
      const { dir, cleanup } = makeTempDir('web_test_collision_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});

      // Occupy an ephemeral port
      const blocker = http.createServer((_, res) => res.end('blocker'));
      try {
        await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
        const occupiedPort = (blocker.address() as net.AddressInfo).port;

        await assert.rejects(
          async () => {
            await startWebServer({
              configStore: store,
              host: '127.0.0.1',
              port: occupiedPort,
            });
          },
          (err: any) => {
            assert.equal(err.code, 'EADDRINUSE');
            return true;
          }
        );
      } finally {
        blocker.closeAllConnections?.();
        await new Promise<void>((r) => blocker.close(() => r()));
        store.close();
        cleanup();
      }
    });

    it('closeWebServer cleans up sockets and releases listening port', async () => {
      const { dir, cleanup } = makeTempDir('web_test_close_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      let serverInstance: http.Server | undefined;
      let client: net.Socket | undefined;

      try {
        const { server, port } = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        serverInstance = server;

        // Keep an idle connection open
        client = net.createConnection({ port, host: '127.0.0.1' });
        await new Promise<void>((r) => client!.once('connect', () => r()));

        await closeWebServer(server);
        serverInstance = undefined;

        // Verify port is freed
        const isReachable = await new Promise<boolean>((resolve) => {
          const socket = net.createConnection({ port, host: '127.0.0.1', timeout: 50 }, () => {
            socket.destroy();
            resolve(true);
          });
          socket.on('error', () => resolve(false));
        });

        assert.equal(isReachable, false);
      } finally {
        client?.destroy();
        if (serverInstance) await closeWebServer(serverInstance);
        store.close();
        cleanup();
      }
    });
  });

  /* ==================================================================== */
  /* 2. Static Dashboard HTML & Offline Invariant                         */
  /* ==================================================================== */
  describe('2. Static Dashboard HTML', () => {
    it('serves self-contained dashboard on GET / with UTF-8 Content-Type', async () => {
      const { dir, cleanup } = makeTempDir('web_test_html_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});

      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      try {
        const res = await ky.get(`http://127.0.0.1:${port}/`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
        assert.equal(res.headers.get('cache-control'), 'no-cache, no-store, must-revalidate');

        const body = await res.text();
        assert.ok(body.includes('Agylity Dashboard'));
        assert.ok(body.includes('id="app"'));

        // Locate and verify compiled Preact application bundle
        const scriptMatch = body.match(/src="(\/assets\/[^"]+\.js)"/);
        assert.ok(scriptMatch, 'Expected script module asset link in index.html');
        const scriptRes = await ky.get(`http://127.0.0.1:${port}${scriptMatch[1]}`);
        assert.equal(scriptRes.status, 200);
        assert.equal(
          scriptRes.headers.get('content-type'),
          'application/javascript; charset=utf-8'
        );
        assert.equal(scriptRes.headers.get('cache-control'), 'public, max-age=31536000, immutable');
        const scriptBody = await scriptRes.text();
        assert.ok(scriptBody.includes('dispatchModal'));
        assert.ok(scriptBody.includes('repoSelect'));
        assert.ok(scriptBody.includes('quotaGrid'));

        // Invariant: Zero external CDN links
        assert.equal(body.includes('https://cdnjs'), false);
        assert.equal(body.includes('https://cdn.jsdelivr'), false);
        assert.equal(body.includes('https://unpkg.com'), false);
        assert.equal(body.includes('https://fonts.googleapis.com'), false);
      } finally {
        await closeWebServer(server);
        store.close();
        cleanup();
      }
    });
  });

  /* ==================================================================== */
  /* 3. REST API: Quota & Alert Endpoints                                 */
  /* ==================================================================== */
  describe('3. Quota & Alert Endpoints', () => {
    it('GET /api/quota returns live snapshots from QuotaClient', async () => {
      const { dir, cleanup } = makeTempDir('web_test_quota_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      let server: http.Server | undefined;

      const mockQuotaClient: QuotaClient = {
        fetchQuota: async (): Promise<QuotaSnapshot[]> => [
          {
            poolId: 'claude',
            family: 'claude',
            displayName: 'Claude 3.5 Sonnet',
            remainingFraction: 0.75,
            resetTime: new Date(Date.now() + 18 * 3600 * 1000).toISOString(),
            hoursUntilReset: 18.0,
            models: ['claude-3-5-sonnet'],
          },
        ],
      };

      try {
        const started = await startWebServer({
          configStore: store,
          quotaClient: mockQuotaClient,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;

        const quotas = await ky
          .get(`http://127.0.0.1:${started.port}/api/quota`)
          .json<QuotaSnapshot[]>();
        assert.equal(quotas.length, 1);
        assert.equal(quotas[0]?.poolId, 'claude');
        assert.equal(quotas[0]?.remainingFraction, 0.75);
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('GET /api/quota synthesizes snapshots from SentryStateManager when client is omitted', async () => {
      const { dir, cleanup } = makeTempDir('web_test_quota_fallback_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      const sentryState = new SentryStateManager(path.join(dir, 'state.json'));
      sentryState.setState({
        version: 1,
        lastProbeAt: new Date().toISOString(),
        lastProbeSource: 'connect_rpc',
        pools: {
          claude: {
            resetTime: new Date(Date.now() + 20 * 3600 * 1000).toISOString(),
            remainingFraction: 0.85,
            firedMilestones: ['24h'],
            lastAlertSentAt: null,
          },
        },
      });

      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          sentryState,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;

        const quotas = await ky
          .get(`http://127.0.0.1:${started.port}/api/quota`)
          .json<QuotaSnapshot[]>();
        assert.equal(quotas.length, 1);
        assert.equal(quotas[0]?.poolId, 'claude');
        assert.equal(quotas[0]?.remainingFraction, 0.85);
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('GET /api/alerts returns sentry alert state from SentryStateManager', async () => {
      const { dir, cleanup } = makeTempDir('web_test_alerts_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      const sentryState = new SentryStateManager(path.join(dir, 'state.json'));
      sentryState.setState({
        version: 1,
        lastProbeAt: '2026-10-19T14:00:00.000Z',
        lastProbeSource: 'connect_rpc',
        pools: {
          'gemini-argon': {
            resetTime: '2026-10-20T00:00:00.000Z',
            remainingFraction: 0.45,
            firedMilestones: ['12h'],
            lastAlertSentAt: '2026-10-19T12:00:00.000Z',
          },
        },
      });

      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          sentryState,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;

        const alerts = await ky.get(`http://127.0.0.1:${started.port}/api/alerts`).json<any>();
        assert.equal(alerts.version, 1);
        assert.equal(alerts.lastProbeSource, 'connect_rpc');
        assert.deepEqual(alerts.pools['gemini-argon'].firedMilestones, ['12h']);
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });
  });

  /* ==================================================================== */
  /* 4. REST API: Config Store (GET, POST, DELETE)                        */
  /* ==================================================================== */
  describe('4. Configuration Store API', () => {
    it('GET /api/config returns resolved config and overrides', async () => {
      const { dir, cleanup } = makeTempDir('web_test_config_get_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      store.setOverride('quotaAlertThresholdPercent', 35);
      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;

        const res = await ky.get(`http://127.0.0.1:${started.port}/api/config`).json<any>();
        assert.equal(res.resolved.quotaAlertThresholdPercent, 35);
        assert.equal(res.overrides.quotaAlertThresholdPercent, 35);
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('POST /api/config updates overrides in SQLite', async () => {
      const { dir, cleanup } = makeTempDir('web_test_config_post_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;

        const postRes = await ky
          .post(`http://127.0.0.1:${started.port}/api/config`, {
            json: { quotaCheckIntervalSeconds: 600 },
          })
          .json<any>();

        assert.equal(postRes.success, true);
        assert.equal(postRes.resolved.quotaCheckIntervalSeconds, 600);
        assert.equal(store.get('quotaCheckIntervalSeconds'), 600);
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('POST /api/config supports { key, value } format', async () => {
      const { dir, cleanup } = makeTempDir('web_test_config_post_kv_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;

        const postRes = await ky
          .post(`http://127.0.0.1:${started.port}/api/config`, {
            json: { key: 'webUiPort', value: 8088 },
          })
          .json<any>();

        assert.equal(postRes.success, true);
        assert.equal(store.get('webUiPort'), 8088);
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('POST /api/config rejects empty body with 400 Bad Request', async () => {
      const { dir, cleanup } = makeTempDir('web_test_config_empty_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;

        await assert.rejects(
          async () => {
            await ky.post(`http://127.0.0.1:${started.port}/api/config`, {
              headers: { 'Content-Type': 'application/json' },
              body: '   ',
              retry: 0,
            });
          },
          (err: any) => err.response?.status === 400
        );
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('POST /api/config rejects malformed JSON with 400 Bad Request', async () => {
      const { dir, cleanup } = makeTempDir('web_test_config_malformed_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;

        await assert.rejects(
          async () => {
            await ky.post(`http://127.0.0.1:${started.port}/api/config`, {
              headers: { 'Content-Type': 'application/json' },
              body: '{"invalid": json syntax}',
              retry: 0,
            });
          },
          (err: any) => err.response?.status === 400
        );
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('DELETE /api/config/:key deletes override and restores default/env', async () => {
      const { dir, cleanup } = makeTempDir('web_test_config_delete_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      store.setOverride('quotaAlertThresholdPercent', 45);
      assert.equal(store.get('quotaAlertThresholdPercent'), 45);
      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;

        const delRes = await ky
          .delete(`http://127.0.0.1:${started.port}/api/config/quotaAlertThresholdPercent`)
          .json<any>();
        assert.equal(delRes.success, true);
        assert.equal(store.get('quotaAlertThresholdPercent'), 25); // default fallback
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('enforces timing-safe Bearer auth when WEB_UI_AUTH_TOKEN is configured', async () => {
      const { dir, cleanup } = makeTempDir('web_test_bearer_auth_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        webUiAuthToken: 'secret-auth-token-12345',
      });
      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;

        // Missing auth -> 401
        await assert.rejects(
          async () => {
            await ky.post(`http://127.0.0.1:${started.port}/api/config`, {
              json: { logLevel: 'info' },
              retry: 0,
            });
          },
          (err: any) => err.response?.status === 401
        );

        // Invalid auth -> 401
        await assert.rejects(
          async () => {
            await ky.post(`http://127.0.0.1:${started.port}/api/config`, {
              headers: { Authorization: 'Bearer wrong-token' },
              json: { logLevel: 'info' },
              retry: 0,
            });
          },
          (err: any) => err.response?.status === 401
        );

        // Valid auth -> 200
        const successRes = await ky
          .post(`http://127.0.0.1:${started.port}/api/config`, {
            headers: { Authorization: 'Bearer secret-auth-token-12345' },
            json: { logLevel: 'info' },
            retry: 0,
          })
          .json<any>();
        assert.equal(successRes.success, true);
        assert.equal(store.get('logLevel'), 'info');
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('enforces application-native IP whitelist when allowedIpRanges is configured', async () => {
      const { dir, cleanup } = makeTempDir('web_test_ip_whitelist_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        allowedIpRanges: ['10.0.0.1'], // Rejects 127.0.0.1
      });
      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;

        // Rejected IP -> 403 Forbidden
        await assert.rejects(
          async () => {
            await ky.get(`http://127.0.0.1:${started.port}/api/health`, { retry: 0 });
          },
          (err: any) => err.response?.status === 403
        );

        // Update allowedIpRanges to include 127.0.0.1 -> 200 OK
        store.set('allowedIpRanges', ['127.0.0.1']);
        const res = await ky
          .get(`http://127.0.0.1:${started.port}/api/health`, { retry: 0 })
          .json<any>();
        assert.equal(res.status, 'ok');
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });
  });

  /* ==================================================================== */
  /* 5. REST API: Dispatch Task Endpoint                                  */
  /* ==================================================================== */
  describe('5. Task Dispatch Endpoint', () => {
    it('POST /api/dispatch reports disabled in alerting-only mode', async () => {
      const { dir, cleanup } = makeTempDir('web_test_dispatch_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;

        const res = await ky
          .post(`http://127.0.0.1:${started.port}/api/dispatch`, {
            json: {
              repositoryName: 'agylity',
              prompt: 'Run security audit',
              requestedBy: 'admin',
            },
          })
          .json<any>();

        assert.equal(res.success, false);
        assert.ok(res.error?.includes('disabled'));
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('refuses a dispatch whose quota telemetry cannot be read', async () => {
      const { dir, cleanup } = makeTempDir('web_test_dispatch_telemetry_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        orchestratorEnabled: true,
      });
      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;

        const res = await ky
          .post(`http://127.0.0.1:${started.port}/api/dispatch`, {
            json: {
              repositoryName: 'agylity',
              prompt: 'Run security audit',
              requestedBy: 'admin',
            },
            retry: 0,
            throwHttpErrors: false,
          })
          .json<any>();

        // Queueing it would strand the task: claiming re-checks eligibility and refuses.
        assert.equal(res.success, false);
        assert.equal(res.code, 'TELEMETRY_UNAVAILABLE');
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('POST /api/dispatch rejects missing repositoryName with 400', async () => {
      const { dir, cleanup } = makeTempDir('web_test_dispatch_bad_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;

        await assert.rejects(
          async () => {
            await ky.post(`http://127.0.0.1:${started.port}/api/dispatch`, {
              json: { prompt: 'Missing repo' },
              retry: 0,
            });
          },
          (err: any) => err.response?.status === 400
        );
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('POST /api/dispatch blocks execution when quota headroom is below safety floor without allowOverage', async () => {
      const { dir, cleanup } = makeTempDir('web_test_dispatch_overage_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        minDispatchHeadroomPercent: 15,
      });
      const sentryState = new SentryStateManager(path.join(dir, 'state.json'));
      sentryState.setState({
        version: 1,
        lastProbeAt: new Date().toISOString(),
        lastProbeSource: 'connect_rpc',
        pools: {
          flash: {
            resetTime: new Date(Date.now() + 3600000).toISOString(),
            remainingFraction: 0.08, // 8% remaining, below 15% floor
            firedMilestones: ['1h'],
            lastAlertSentAt: null,
          },
        },
      });

      const { server, port } = await startWebServer({
        configStore: store,
        sentryState,
        host: '127.0.0.1',
        port: 0,
      });

      try {
        await assert.rejects(
          async () => {
            await ky.post(`http://127.0.0.1:${port}/api/dispatch`, {
              json: { repositoryName: 'agylity', prompt: 'Continue work' },
              retry: 0,
            });
          },
          (err: any) => {
            assert.equal(err.response?.status, 400);
            return true;
          }
        );

        // When allowOverage: true is supplied, dispatch proceeds past the safety floor check
        // and reports dispatch disabled in alerting-only mode
        const res = await ky
          .post(`http://127.0.0.1:${port}/api/dispatch`, {
            json: { repositoryName: 'agylity', prompt: 'Continue work', allowOverage: true },
            retry: 0,
          })
          .json<any>();

        assert.equal(res.success, false);
        assert.ok(res.error?.includes('alerting-only mode'));
      } finally {
        await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('POST /api/notify/test sends test notification through active notifier', async () => {
      const { dir, cleanup } = makeTempDir('web_test_notify_test_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        notificationChannel: 'console',
      });

      let alertReceived = false;
      const mockNotifier: any = {
        channelName: 'mock',
        initialize: async () => {},
        notifyQuotaAlert: async () => {
          alertReceived = true;
        },
        notifyDispatchStatus: async () => {},
        shutdown: async () => {},
      };

      const { server, port } = await startWebServer({
        configStore: store,
        notifier: mockNotifier,
        host: '127.0.0.1',
        port: 0,
      });

      try {
        const res = await ky
          .post(`http://127.0.0.1:${port}/api/notify/test`, { retry: 0 })
          .json<any>();
        assert.equal(res.success, true);
        assert.equal(res.channel, 'console');
        assert.equal(alertReceived, true);
      } finally {
        await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('POST /api/notify/test executes ephemeral test with unsaved webhook URL override', async () => {
      const { dir, cleanup } = makeTempDir('web_ephemeral_webhook_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        notificationChannel: 'none',
      });

      let receivedBody: any = null;
      const hookServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          receivedBody = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      });

      await new Promise<void>((r) => hookServer.listen(0, '127.0.0.1', () => r()));
      const hookPort = (hookServer.address() as { port: number }).port;

      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      try {
        const res = await ky
          .post(`http://127.0.0.1:${port}/api/notify/test`, {
            json: {
              channel: 'webhook',
              notificationWebhookUrl: `http://127.0.0.1:${hookPort}/ephemeral-hook`,
            },
            retry: 0,
          })
          .json<any>();

        assert.equal(res.success, true);
        assert.equal(res.channel, 'webhook');
        assert.ok(res.message.includes('Webhook ping delivered successfully'));
        assert.equal(receivedBody?.event, 'test_ping');
        assert.ok(receivedBody?.content);
      } finally {
        await closeWebServer(server);
        await new Promise<void>((r) => hookServer.close(() => r()));
        store.close();
        cleanup();
      }
    });
  });

  /* ==================================================================== */
  /* 6. Route Guards: 404 & 405 Status Codes                              */
  /* ==================================================================== */
  describe('6. Route Guards (404 & 405)', () => {
    it('hands unknown client routes to the app and 404s unknown assets', async () => {
      const { dir, cleanup } = makeTempDir('web_test_404_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;

        // A client route is the app's to resolve (NotFoundView), not the server's.
        const shell = await ky.get(`http://127.0.0.1:${started.port}/unknown/path/here`, {
          retry: 0,
          throwHttpErrors: false,
        });
        assert.notEqual(shell.status, 404);

        // A path naming a file is an asset request, so it still 404s.
        await assert.rejects(
          async () => {
            await ky.get(`http://127.0.0.1:${started.port}/unknown/asset.js`, { retry: 0 });
          },
          (err: any) => err.response?.status === 404
        );
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('returns 405 Method Not Allowed for unsupported verbs on valid routes', async () => {
      const { dir, cleanup } = makeTempDir('web_test_405_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;

        // DELETE /api/config without key
        await assert.rejects(
          async () => {
            await ky.delete(`http://127.0.0.1:${started.port}/api/config`, { retry: 0 });
          },
          (err: any) => err.response?.status === 405
        );

        // POST /
        await assert.rejects(
          async () => {
            await ky.post(`http://127.0.0.1:${started.port}/`, { json: {}, retry: 0 });
          },
          (err: any) => err.response?.status === 405
        );

        // GET /api/dispatch
        await assert.rejects(
          async () => {
            await ky.get(`http://127.0.0.1:${started.port}/api/dispatch`, { retry: 0 });
          },
          (err: any) => err.response?.status === 405
        );

        // DELETE /api/quota
        await assert.rejects(
          async () => {
            await ky.delete(`http://127.0.0.1:${started.port}/api/quota`, { retry: 0 });
          },
          (err: any) => err.response?.status === 405
        );
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });
  });

  /* ==================================================================== */
  /* 7. Zero-Overhead Invariant                                           */
  /* ==================================================================== */
  describe('7. Zero-Overhead Invariant', () => {
    it('verifies that webUiEnabled is false by default in config', () => {
      const { dir, cleanup } = makeTempDir('web_test_zero_overhead_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});

      try {
        const resolved = store.resolveConfig();
        assert.equal(resolved.webUiEnabled, false);
      } finally {
        store.close();
        cleanup();
      }
    });

    it('when webUiEnabled is false, zero HTTP listener is spawned', async () => {
      const { dir, cleanup } = makeTempDir('web_test_zero_listener_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});

      try {
        let serverStarted = false;
        const resolved = store.resolveConfig();

        if (resolved.webUiEnabled) {
          await startWebServer({ configStore: store });
          serverStarted = true;
        }

        assert.equal(serverStarted, false);
      } finally {
        store.close();
        cleanup();
      }
    });
  });

  /* ==================================================================== */
  /* 8. HTTP Body Bounding & Payload Protection                           */
  /* ==================================================================== */
  describe('8. HTTP Body Bounding & Payload Protection', () => {
    it('readBody rejects when payload exceeds maxBytes limit', async () => {
      const { Readable } = await import('node:stream');
      const { readBody, PayloadTooLargeError } = await import('../../src/web/routes.js');

      const stream = Readable.from([
        Buffer.from('a'.repeat(300)),
        Buffer.from('b'.repeat(300)),
      ]) as http.IncomingMessage;

      await assert.rejects(
        () => readBody(stream, 500),
        (err: any) => {
          assert.ok(err instanceof PayloadTooLargeError);
          assert.equal(err.statusCode, 413);
          return true;
        }
      );
    });

    it('POST /api/config rejects bodies exceeding 64 KB with HTTP 413', async () => {
      const { dir, cleanup } = makeTempDir('web_test_413_config_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;

        const oversizedPayload = JSON.stringify({
          largeData: 'x'.repeat(65 * 1024),
        });

        await assert.rejects(
          () =>
            ky.post(`http://127.0.0.1:${started.port}/api/config`, {
              body: oversizedPayload,
              headers: { 'Content-Type': 'application/json' },
              retry: 0,
            }),
          (err: any) => {
            assert.equal(err.response?.status, 413);
            return true;
          }
        );
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('POST /api/notify/test rejects bodies exceeding 64 KB with HTTP 413 (not 500)', async () => {
      const { dir, cleanup } = makeTempDir('web_test_413_notify_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;

        const oversizedPayload = JSON.stringify({
          channel: 'console',
          padding: 'x'.repeat(65 * 1024),
        });

        await assert.rejects(
          () =>
            ky.post(`http://127.0.0.1:${started.port}/api/notify/test`, {
              body: oversizedPayload,
              headers: { 'Content-Type': 'application/json' },
              retry: 0,
            }),
          (err: any) => {
            assert.equal(err.response?.status, 413);
            return true;
          }
        );
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('POST /api/dispatch rejects bodies exceeding 64 KB with HTTP 413', async () => {
      const { dir, cleanup } = makeTempDir('web_test_413_dispatch_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;

        const oversizedPayload = JSON.stringify({
          repositoryName: 'agylity',
          prompt: 'x'.repeat(65 * 1024),
        });

        await assert.rejects(
          () =>
            ky.post(`http://127.0.0.1:${started.port}/api/dispatch`, {
              body: oversizedPayload,
              headers: { 'Content-Type': 'application/json' },
              retry: 0,
            }),
          (err: any) => {
            assert.equal(err.response?.status, 413);
            return true;
          }
        );
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('streaming chunked body exceeding 64 KB cleanly receives HTTP 413 without socket reset', async () => {
      const { dir, cleanup } = makeTempDir('web_test_413_streaming_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;

        const responsePromise = new Promise<{
          statusCode: number;
          headers: http.IncomingHttpHeaders;
          body: string;
        }>((resolve, reject) => {
          const req = http.request(
            {
              hostname: '127.0.0.1',
              port: started.port,
              path: '/api/config',
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Transfer-Encoding': 'chunked',
              },
            },
            (res) => {
              let body = '';
              res.setEncoding('utf8');
              res.on('data', (chunk) => {
                body += chunk;
              });
              res.on('end', () => {
                resolve({
                  statusCode: res.statusCode ?? 0,
                  headers: res.headers,
                  body,
                });
              });
            }
          );

          req.on('error', (err) => {
            reject(err);
          });

          // Stream 128 KB in 16 KB chunks
          const chunk = Buffer.alloc(16 * 1024, 'a');
          let chunksSent = 0;
          const totalChunks = 8;

          const sendNext = () => {
            if (req.destroyed) return;
            while (chunksSent < totalChunks) {
              chunksSent++;
              const canContinue = req.write(chunk);
              if (!canContinue && chunksSent < totalChunks) {
                req.once('drain', sendNext);
                return;
              }
            }
            req.end();
          };

          sendNext();
        });

        const result = await responsePromise;
        assert.equal(result.statusCode, 413);
        assert.ok(result.headers['content-type']?.includes('application/json'));
        const parsed = JSON.parse(result.body);
        assert.equal(parsed.error, 'Payload Too Large');
        assert.ok(parsed.message.includes('65536 bytes'));
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });
  });

  /* ==================================================================== */
  /* 9. Hardened Security & Edge Protection                               */
  /* ==================================================================== */
  describe('9. Hardened Security & Edge Protection', () => {
    it('sets standard security headers on API responses', async () => {
      const { dir, cleanup } = makeTempDir('web_test_sec_headers_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;

        const res = await ky.get(`http://127.0.0.1:${started.port}/api/health`);
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(res.headers.get('x-frame-options'), 'DENY');
        assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('locks down all API routes (including quota and models) when webUiAuthToken is set', async () => {
      const { dir, cleanup } = makeTempDir('web_test_token_lockdown_');
      const secretToken = 'super_secret_test_token_42';
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        webUiAuthToken: secretToken,
      });
      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;

        // /api/health remains public and reports authRequired: true
        const healthRes = await ky.get(`http://127.0.0.1:${started.port}/api/health`);
        assert.equal(healthRes.status, 200);
        const healthData: any = await healthRes.json();
        assert.equal(healthData.authRequired, true);

        // /api/quota rejected with 401 without token
        const quotaErr = await ky
          .get(`http://127.0.0.1:${started.port}/api/quota`, { throwHttpErrors: false })
          .then((r) => r.status);
        assert.equal(quotaErr, 401);

        // /api/models rejected with 401 without token
        const modelsErr = await ky
          .get(`http://127.0.0.1:${started.port}/api/models`, { throwHttpErrors: false })
          .then((r) => r.status);
        assert.equal(modelsErr, 401);

        // /api/quota accepted with valid Bearer token
        const validRes = await ky.get(`http://127.0.0.1:${started.port}/api/quota`, {
          headers: { Authorization: `Bearer ${secretToken}` },
        });
        assert.equal(validRes.status, 200);
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('engages rate limiter with HTTP 429 after 10 failed auth attempts', async () => {
      const { dir, cleanup } = makeTempDir('web_test_ratelimit_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        webUiAuthToken: 'correct_token',
      });
      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;

        // 9 failed attempts should return 401
        for (let i = 0; i < 9; i++) {
          const res = await ky.get(`http://127.0.0.1:${started.port}/api/quota`, {
            headers: { Authorization: 'Bearer wrong_token' },
            throwHttpErrors: false,
          });
          assert.equal(res.status, 401);
        }

        // 10th failed attempt triggers 429
        const tenthRes = await ky.get(`http://127.0.0.1:${started.port}/api/quota`, {
          headers: { Authorization: 'Bearer wrong_token' },
          throwHttpErrors: false,
        });
        assert.equal(tenthRes.status, 429);
        assert.equal(tenthRes.headers.get('retry-after'), '60');
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });
  });

  /* ==================================================================== */
  /* 6. Runner Status Callbacks: Refusals & Token Telemetry               */
  /* ==================================================================== */
  describe('6. Runner Status Callbacks: Refusals & Token Telemetry', () => {
    const authHeaders = { 'x-agylity-worker-token': 'swarm-secret-token-999' };

    const healthyFlashState = (dir: string): SentryStateManager => {
      const state = new SentryStateManager(path.join(dir, 'state.json'));
      state.setState({
        version: 1,
        lastProbeAt: new Date().toISOString(),
        lastProbeSource: 'connect_rpc',
        pools: {
          'gemini-flash': {
            resetTime: new Date(Date.now() + 3600000).toISOString(),
            remainingFraction: 0.8,
            firedMilestones: [],
            lastAlertSentAt: null,
          },
        },
      });
      return state;
    };

    it('returns 409 with the persisted status and leaves a terminal task untouched', async () => {
      const { dir, cleanup } = makeTempDir('web_status_terminal_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        orchestratorEnabled: true,
        workerSharedSecret: 'swarm-secret-token-999',
      });
      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      try {
        const baseUrl = `http://127.0.0.1:${port}`;
        const disp = await ky
          .post(`${baseUrl}/api/dispatch`, {
            json: {
              repositoryName: 'agylity',
              prompt: 'Fail then report completed',
              allowOverage: true,
            },
          })
          .json<any>();
        assert.ok(disp.taskId);

        // First report marks the task failed (as the reaper would)
        const failed = await ky
          .post(`${baseUrl}/api/tasks/${disp.taskId}/status`, {
            headers: authHeaders,
            json: { status: 'failed', error: 'boom' },
          })
          .json<any>();
        assert.equal(failed.success, true);
        assert.equal(failed.task.status, 'failed');

        // A late 'completed' report must be refused, not reported as success
        await assert.rejects(
          async () => {
            await ky.post(`${baseUrl}/api/tasks/${disp.taskId}/status`, {
              headers: authHeaders,
              json: { status: 'completed', branchName: 'antigravity/late' },
              retry: 0,
            });
          },
          (err: any) => {
            assert.equal(err.response?.status, 409);
            return true;
          }
        );

        const tasks = await ky.get(`${baseUrl}/api/tasks`).json<any[]>();
        const task = tasks.find((t) => t.id === disp.taskId);
        assert.equal(task?.status, 'failed');
        assert.equal(task?.branchName, undefined);
      } finally {
        await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('returns 409 when a status patch comes from a different worker', async () => {
      const { dir, cleanup } = makeTempDir('web_status_crossworker_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        orchestratorEnabled: true,
        workerSharedSecret: 'swarm-secret-token-999',
      });
      const { server, port } = await startWebServer({
        configStore: store,
        sentryState: healthyFlashState(dir),
        host: '127.0.0.1',
        port: 0,
      });

      try {
        const baseUrl = `http://127.0.0.1:${port}`;
        const disp = await ky
          .post(`${baseUrl}/api/dispatch`, {
            json: { repositoryName: 'agylity', prompt: 'Owned by worker-a' },
          })
          .json<any>();

        const poll = await ky
          .post(`${baseUrl}/api/tasks/poll`, {
            headers: authHeaders,
            json: { workerId: 'worker-a', timeoutMs: 0 },
          })
          .json<any>();
        assert.equal(poll.task?.id, disp.taskId);

        // A patch from worker-b must be refused
        await assert.rejects(
          async () => {
            await ky.post(`${baseUrl}/api/tasks/${disp.taskId}/status`, {
              headers: authHeaders,
              json: { status: 'executing', workerId: 'worker-b' },
              retry: 0,
            });
          },
          (err: any) => {
            assert.equal(err.response?.status, 409);
            return true;
          }
        );

        // The owning worker-a patch is still accepted
        const accepted = await ky
          .post(`${baseUrl}/api/tasks/${disp.taskId}/status`, {
            headers: authHeaders,
            json: { status: 'executing', workerId: 'worker-a' },
          })
          .json<any>();
        assert.equal(accepted.success, true);
        assert.equal(accepted.task.status, 'executing');
      } finally {
        await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('persists runner token telemetry (numTurns, totalTokens, thinkingTokens) from a status report', async () => {
      const { dir, cleanup } = makeTempDir('web_status_telemetry_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        orchestratorEnabled: true,
        workerSharedSecret: 'swarm-secret-token-999',
      });
      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      try {
        const baseUrl = `http://127.0.0.1:${port}`;
        const disp = await ky
          .post(`${baseUrl}/api/dispatch`, {
            json: {
              repositoryName: 'agylity',
              prompt: 'Telemetry task',
              allowOverage: true,
            },
          })
          .json<any>();

        const reported = await ky
          .post(`${baseUrl}/api/tasks/${disp.taskId}/status`, {
            headers: authHeaders,
            json: {
              status: 'completed',
              branchName: 'antigravity/task-telemetry',
              numTurns: 4,
              totalTokens: 1670,
              thinkingTokens: 120,
            },
          })
          .json<any>();
        assert.equal(reported.success, true);

        const tasks = await ky.get(`${baseUrl}/api/tasks`).json<any[]>();
        const task = tasks.find((t) => t.id === disp.taskId);
        assert.equal(task?.numTurns, 4);
        assert.equal(task?.totalTokens, 1670);
        assert.equal(task?.thinkingTokens, 120);
      } finally {
        await closeWebServer(server);
        store.close();
        cleanup();
      }
    });
  });
});
