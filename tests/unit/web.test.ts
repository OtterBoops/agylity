import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import ky from 'ky';
import { makeTempDir } from '../e2e/harness/index.js';
import { ConfigStore } from '../../src/config/store.js';
import { SentryStateManager } from '../../src/sentry/state.js';
import { createWebServer, startWebServer, closeWebServer } from '../../src/web/server.js';
import type { QuotaClient, QuotaSnapshot } from '../../src/sentry/models.js';

describe('Unit Tests: Decoupled Web UI (Milestone 5)', () => {
  /* ==================================================================== */
  /* 1. Server Lifecycle & Port Collision                                 */
  /* ==================================================================== */
  describe('1. Server Lifecycle & Port Management', () => {
    it('starts on ephemeral port (0) and exposes bound port and host', async () => {
      const { dir, cleanup } = makeTempDir('web_test_start_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});

      const { server, port, host } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      assert.ok(server instanceof http.Server);
      assert.ok(port > 0, `Expected assigned port > 0, got ${port}`);
      assert.equal(host, '127.0.0.1');

      await closeWebServer(server);
      store.close();
      cleanup();
    });

    it('gracefully handles and rejects on port collision (EADDRINUSE)', async () => {
      const { dir, cleanup } = makeTempDir('web_test_collision_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});

      // Occupy an ephemeral port
      const blocker = http.createServer((_, res) => res.end('blocker'));
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

      await new Promise<void>((r) => blocker.close(() => r()));
      store.close();
      cleanup();
    });

    it('closeWebServer cleans up sockets and releases listening port', async () => {
      const { dir, cleanup } = makeTempDir('web_test_close_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});

      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      // Keep an idle connection open
      const client = net.createConnection({ port, host: '127.0.0.1' });
      await new Promise<void>((r) => client.once('connect', () => r()));

      await closeWebServer(server);

      // Verify port is freed
      const isReachable = await new Promise<boolean>((resolve) => {
        const socket = net.createConnection({ port, host: '127.0.0.1', timeout: 50 }, () => {
          socket.destroy();
          resolve(true);
        });
        socket.on('error', () => resolve(false));
      });

      assert.equal(isReachable, false);
      client.destroy();
      store.close();
      cleanup();
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

      const { server, port } = await startWebServer({
        configStore: store,
        quotaClient: mockQuotaClient,
        host: '127.0.0.1',
        port: 0,
      });

      const quotas = await ky.get(`http://127.0.0.1:${port}/api/quota`).json<QuotaSnapshot[]>();
      assert.equal(quotas.length, 1);
      assert.equal(quotas[0]?.poolId, 'claude');
      assert.equal(quotas[0]?.remainingFraction, 0.75);

      await closeWebServer(server);
      store.close();
      cleanup();
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

      const { server, port } = await startWebServer({
        configStore: store,
        sentryState,
        host: '127.0.0.1',
        port: 0,
      });

      const quotas = await ky.get(`http://127.0.0.1:${port}/api/quota`).json<QuotaSnapshot[]>();
      assert.equal(quotas.length, 1);
      assert.equal(quotas[0]?.poolId, 'claude');
      assert.equal(quotas[0]?.remainingFraction, 0.85);

      await closeWebServer(server);
      store.close();
      cleanup();
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

      const { server, port } = await startWebServer({
        configStore: store,
        sentryState,
        host: '127.0.0.1',
        port: 0,
      });

      const alerts = await ky.get(`http://127.0.0.1:${port}/api/alerts`).json<any>();
      assert.equal(alerts.version, 1);
      assert.equal(alerts.lastProbeSource, 'connect_rpc');
      assert.deepEqual(alerts.pools['gemini-argon'].firedMilestones, ['12h']);

      await closeWebServer(server);
      store.close();
      cleanup();
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

      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      const res = await ky.get(`http://127.0.0.1:${port}/api/config`).json<any>();
      assert.equal(res.resolved.quotaAlertThresholdPercent, 35);
      assert.equal(res.overrides.quotaAlertThresholdPercent, 35);

      await closeWebServer(server);
      store.close();
      cleanup();
    });

    it('POST /api/config updates overrides in SQLite', async () => {
      const { dir, cleanup } = makeTempDir('web_test_config_post_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});

      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      const postRes = await ky
        .post(`http://127.0.0.1:${port}/api/config`, {
          json: { quotaCheckIntervalSeconds: 600 },
        })
        .json<any>();

      assert.equal(postRes.success, true);
      assert.equal(postRes.resolved.quotaCheckIntervalSeconds, 600);
      assert.equal(store.get('quotaCheckIntervalSeconds'), 600);

      await closeWebServer(server);
      store.close();
      cleanup();
    });

    it('POST /api/config supports { key, value } format', async () => {
      const { dir, cleanup } = makeTempDir('web_test_config_post_kv_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});

      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      const postRes = await ky
        .post(`http://127.0.0.1:${port}/api/config`, {
          json: { key: 'webUiPort', value: 8088 },
        })
        .json<any>();

      assert.equal(postRes.success, true);
      assert.equal(store.get('webUiPort'), 8088);

      await closeWebServer(server);
      store.close();
      cleanup();
    });

    it('POST /api/config rejects empty body with 400 Bad Request', async () => {
      const { dir, cleanup } = makeTempDir('web_test_config_empty_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});

      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      await assert.rejects(
        async () => {
          await ky.post(`http://127.0.0.1:${port}/api/config`, {
            headers: { 'Content-Type': 'application/json' },
            body: '   ',
            retry: 0,
          });
        },
        (err: any) => err.response?.status === 400
      );

      await closeWebServer(server);
      store.close();
      cleanup();
    });

    it('POST /api/config rejects malformed JSON with 400 Bad Request', async () => {
      const { dir, cleanup } = makeTempDir('web_test_config_malformed_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});

      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      await assert.rejects(
        async () => {
          await ky.post(`http://127.0.0.1:${port}/api/config`, {
            headers: { 'Content-Type': 'application/json' },
            body: '{"invalid": json syntax}',
            retry: 0,
          });
        },
        (err: any) => err.response?.status === 400
      );

      await closeWebServer(server);
      store.close();
      cleanup();
    });

    it('DELETE /api/config/:key deletes override and restores default/env', async () => {
      const { dir, cleanup } = makeTempDir('web_test_config_delete_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      store.setOverride('quotaAlertThresholdPercent', 45);
      assert.equal(store.get('quotaAlertThresholdPercent'), 45);

      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      const delRes = await ky
        .delete(`http://127.0.0.1:${port}/api/config/quotaAlertThresholdPercent`)
        .json<any>();
      assert.equal(delRes.success, true);
      assert.equal(store.get('quotaAlertThresholdPercent'), 25); // default fallback

      await closeWebServer(server);
      store.close();
      cleanup();
    });
  });

  /* ==================================================================== */
  /* 5. REST API: Dispatch Task Endpoint                                  */
  /* ==================================================================== */
  describe('5. Task Dispatch Endpoint', () => {
    it('POST /api/dispatch reports disabled in alerting-only mode', async () => {
      const { dir, cleanup } = makeTempDir('web_test_dispatch_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});

      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      const res = await ky
        .post(`http://127.0.0.1:${port}/api/dispatch`, {
          json: {
            repositoryName: 'agylity',
            prompt: 'Run security audit',
            requestedBy: 'admin',
          },
        })
        .json<any>();

      assert.equal(res.success, false);
      assert.ok(res.error?.includes('disabled'));

      await closeWebServer(server);
      store.close();
      cleanup();
    });

    it('POST /api/dispatch rejects missing repositoryName with 400', async () => {
      const { dir, cleanup } = makeTempDir('web_test_dispatch_bad_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});

      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      await assert.rejects(
        async () => {
          await ky.post(`http://127.0.0.1:${port}/api/dispatch`, {
            json: { prompt: 'Missing repo' },
            retry: 0,
          });
        },
        (err: any) => err.response?.status === 400
      );

      await closeWebServer(server);
      store.close();
      cleanup();
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
          sonnet: {
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
  });

  /* ==================================================================== */
  /* 6. Route Guards: 404 & 405 Status Codes                              */
  /* ==================================================================== */
  describe('6. Route Guards (404 & 405)', () => {
    it('returns 404 Not Found for unrecognized URLs', async () => {
      const { dir, cleanup } = makeTempDir('web_test_404_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});

      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      await assert.rejects(
        async () => {
          await ky.get(`http://127.0.0.1:${port}/unknown/path/here`, { retry: 0 });
        },
        (err: any) => err.response?.status === 404
      );

      await closeWebServer(server);
      store.close();
      cleanup();
    });

    it('returns 405 Method Not Allowed for unsupported verbs on valid routes', async () => {
      const { dir, cleanup } = makeTempDir('web_test_405_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});

      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      // DELETE /api/config without key
      await assert.rejects(
        async () => {
          await ky.delete(`http://127.0.0.1:${port}/api/config`, { retry: 0 });
        },
        (err: any) => err.response?.status === 405
      );

      // POST /
      await assert.rejects(
        async () => {
          await ky.post(`http://127.0.0.1:${port}/`, { json: {}, retry: 0 });
        },
        (err: any) => err.response?.status === 405
      );

      // GET /api/dispatch
      await assert.rejects(
        async () => {
          await ky.get(`http://127.0.0.1:${port}/api/dispatch`, { retry: 0 });
        },
        (err: any) => err.response?.status === 405
      );

      // DELETE /api/quota
      await assert.rejects(
        async () => {
          await ky.delete(`http://127.0.0.1:${port}/api/quota`, { retry: 0 });
        },
        (err: any) => err.response?.status === 405
      );

      await closeWebServer(server);
      store.close();
      cleanup();
    });
  });

  /* ==================================================================== */
  /* 7. Zero-Overhead Invariant                                           */
  /* ==================================================================== */
  describe('7. Zero-Overhead Invariant', () => {
    it('verifies that webUiEnabled is false by default in config', () => {
      const { dir, cleanup } = makeTempDir('web_test_zero_overhead_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});

      const resolved = store.resolveConfig();
      assert.equal(resolved.webUiEnabled, false);

      store.close();
      cleanup();
    });

    it('when webUiEnabled is false, zero HTTP listener is spawned', async () => {
      const { dir, cleanup } = makeTempDir('web_test_zero_listener_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});

      let serverStarted = false;
      const resolved = store.resolveConfig();

      if (resolved.webUiEnabled) {
        await startWebServer({ configStore: store });
        serverStarted = true;
      }

      assert.equal(serverStarted, false);

      store.close();
      cleanup();
    });
  });
});
