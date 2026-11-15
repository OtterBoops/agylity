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
import { DynamicModelCatalog } from '../../src/coordinator/catalog.js';

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

    it('GET /api/quota populates pool.models from the live model catalog', async () => {
      const { dir, cleanup } = makeTempDir('web_test_quota_catalog_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      let server: http.Server | undefined;

      const liveModels = [
        { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
        { id: 'gemini-4-hydrogen-high', label: 'Gemini 4 Hydrogen (High)' },
        { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
      ];
      const provider = new DynamicModelCatalog({
        execFileFn: async () => ({
          stdout: JSON.stringify({
            status: 'SUCCESS',
            command: { name: 'models', data: { models: liveModels } },
          }),
          stderr: '',
        }),
      });
      await provider.refreshModels();

      // A cached snapshot keeps its own stale model list; the route must override it.
      const mockQuotaClient: QuotaClient = {
        fetchQuota: async (): Promise<QuotaSnapshot[]> => [
          {
            poolId: 'gemini-flash',
            family: 'gemini-flash',
            displayName: 'Gemini Flash',
            remainingFraction: 0.7,
            resetTime: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
            hoursUntilReset: 6,
            models: ['Gemini Flash', 'Gemini Pro'],
          },
        ],
      };

      try {
        const started = await startWebServer({
          configStore: store,
          quotaClient: mockQuotaClient,
          modelCatalog: provider,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;

        const quotas = await ky
          .get(`http://127.0.0.1:${started.port}/api/quota`)
          .json<QuotaSnapshot[]>();
        assert.equal(quotas.length, 1);
        assert.deepEqual(quotas[0]?.models, ['Gemini 3.8 Flash', 'Gemini 4 Hydrogen']);
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

    it('POST /api/alerts/dismiss clears the early-reset notice and GET reflects it', async () => {
      const { dir, cleanup } = makeTempDir('web_test_alerts_dismiss_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      const sentryState = new SentryStateManager(path.join(dir, 'state.json'));
      sentryState.setState({
        version: 1,
        lastProbeAt: '2026-10-19T14:00:00.000Z',
        lastProbeSource: 'connect_rpc',
        pools: {},
        earlyResetNotice: {
          detectedAt: '2026-10-19T13:30:00.000Z',
          pools: [
            {
              poolId: 'gemini-argon',
              displayName: 'Gemini Argon',
              previousRemainingFraction: 0.2,
              remainingFraction: 0.95,
              previousResetTime: '2026-10-23T00:00:00.000Z',
              resetTime: '2026-10-23T00:00:00.000Z',
            },
          ],
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
        const base = `http://127.0.0.1:${started.port}`;

        const before = await ky.get(`${base}/api/alerts`).json<any>();
        assert.equal(before.earlyResetNotice.pools.length, 1);
        assert.equal(before.earlyResetNotice.pools[0].poolId, 'gemini-argon');

        const res = await ky.post(`${base}/api/alerts/dismiss`, { retry: 0 });
        assert.equal(res.status, 200);
        const body = await res.json<any>();
        assert.deepEqual(body, { success: true, dismissed: true, earlyResetNotice: null });

        const after = await ky.get(`${base}/api/alerts`).json<any>();
        assert.equal(after.earlyResetNotice, null);

        // Dismissal is POST-only.
        await assert.rejects(
          async () => {
            await ky.get(`${base}/api/alerts/dismiss`, { retry: 0 });
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

    it('enforces timing-safe Bearer auth when WEB_UI_AUTH_TOKEN is configured and localhost exemption is disabled', async () => {
      const { dir, cleanup } = makeTempDir('web_test_bearer_auth_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        webUiAuthToken: 'secret-auth-token-12345',
        webUiAuthExemptLocalhost: false,
      });
      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;

        // Healthcheck reflects auth requirement
        const health = await ky.get(`http://127.0.0.1:${started.port}/api/health`).json<any>();
        assert.equal(health.authRequired, true);

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

    it('exempts localhost from auth by default when WEB_UI_AUTH_TOKEN is configured', async () => {
      const { dir, cleanup } = makeTempDir('web_test_bearer_auth_localhost_');
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

        // Health reports authRequired: false for localhost
        const health = await ky.get(`http://127.0.0.1:${started.port}/api/health`).json<any>();
        assert.equal(health.authRequired, false);

        // Control plane route succeeds without auth
        const res = await ky.get(`http://127.0.0.1:${started.port}/api/config`).json<any>();
        assert.ok(res.resolved);
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
              repositoryId: 'agylity',
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
        coordinatorEnabled: true,
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
              repositoryId: 'agylity',
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

    it('POST /api/dispatch rejects missing repositoryId with 400', async () => {
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
              json: { repositoryId: 'agylity', prompt: 'Continue work' },
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
            json: { repositoryId: 'agylity', prompt: 'Continue work', allowOverage: true },
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

    it('rejects a malformed path segment with 400 rather than crashing', async () => {
      const { dir, cleanup } = makeTempDir('web_test_badseg_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;

        // A bare '%' is not a valid escape; decodeURIComponent throws on it.
        const res = await ky.post(`http://127.0.0.1:${started.port}/api/tasks/%/cancel`, {
          retry: 0,
          throwHttpErrors: false,
        });
        assert.equal(res.status, 400);
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
          repositoryId: 'agylity',
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
        webUiAuthExemptLocalhost: false,
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
        webUiAuthExemptLocalhost: false,
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
  /* 10. Backlog Sub-route Guards                                         */
  /* ==================================================================== */
  describe('10. Backlog Sub-route Guards', () => {
    it('rejects PATCH on the dispatch sub-route with 405 and leaves the row unchanged', async () => {
      const { dir, cleanup } = makeTempDir('web_backlog_dispatch_patch_');
      const store = new ConfigStore(path.join(dir, 'test.db'), { coordinatorEnabled: true });
      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;
        const base = `http://127.0.0.1:${started.port}`;

        const created = await ky
          .post(`${base}/api/backlog`, {
            json: { title: 'B', prompt: 'P', repositoryId: 'agylity' },
            throwHttpErrors: false,
          })
          .json<{ id: string; status: string }>();
        assert.equal(created.status, 'pending');

        // The dispatch sub-route is POST-only; a PATCH must not fall through to the row update.
        const res = await ky.patch(
          `${base}/api/backlog/${encodeURIComponent(created.id)}/dispatch`,
          {
            json: { status: 'dispatched' },
            retry: 0,
            throwHttpErrors: false,
          }
        );
        assert.equal(res.status, 405);

        const after = await ky
          .get(`${base}/api/backlog/${encodeURIComponent(created.id)}`)
          .json<{ status: string; swarmTaskId?: string | null }>();
        assert.equal(after.status, 'pending');
        assert.equal(after.swarmTaskId ?? null, null);
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('answers 400 (not 500) for a null body or a non-string title on PATCH', async () => {
      const { dir, cleanup } = makeTempDir('web_backlog_patch_bad_');
      const store = new ConfigStore(path.join(dir, 'test.db'), { coordinatorEnabled: true });
      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;
        const base = `http://127.0.0.1:${started.port}`;

        const created = await ky
          .post(`${base}/api/backlog`, {
            json: { title: 'B', prompt: 'P', repositoryId: 'agylity' },
            throwHttpErrors: false,
          })
          .json<{ id: string }>();
        const url = `${base}/api/backlog/${encodeURIComponent(created.id)}`;

        for (const body of ['null', '{"title":5}']) {
          const res = await ky.patch(url, {
            body,
            headers: { 'content-type': 'application/json' },
            retry: 0,
            throwHttpErrors: false,
          });
          assert.equal(res.status, 400, `expected 400 for body ${body}, got ${res.status}`);
        }

        // The row is untouched by the rejected patches.
        const after = await ky.get(url).json<{ title: string }>();
        assert.equal(after.title, 'B');
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
    const authHeaders = { 'x-agylity-runner-token': 'swarm-secret-token-999' };

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
        coordinatorEnabled: true,
        runnerSharedSecret: 'swarm-secret-token-999',
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
              repositoryId: 'agylity',
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

    it('returns 409 when a status patch comes from a different runner', async () => {
      const { dir, cleanup } = makeTempDir('web_status_crossworker_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        coordinatorEnabled: true,
        runnerSharedSecret: 'swarm-secret-token-999',
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
            json: { repositoryId: 'agylity', prompt: 'Owned by runner-a' },
          })
          .json<any>();

        const poll = await ky
          .post(`${baseUrl}/api/tasks/poll`, {
            headers: authHeaders,
            json: { runnerId: 'runner-a', timeoutMs: 0 },
          })
          .json<any>();
        assert.equal(poll.task?.id, disp.taskId);

        // A patch from runner-b must be refused
        await assert.rejects(
          async () => {
            await ky.post(`${baseUrl}/api/tasks/${disp.taskId}/status`, {
              headers: authHeaders,
              json: { status: 'executing', runnerId: 'runner-b' },
              retry: 0,
            });
          },
          (err: any) => {
            assert.equal(err.response?.status, 409);
            return true;
          }
        );

        // The owning runner-a patch is still accepted
        const accepted = await ky
          .post(`${baseUrl}/api/tasks/${disp.taskId}/status`, {
            headers: authHeaders,
            json: { status: 'executing', runnerId: 'runner-a' },
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

    it('persists the PR url a runner reports on completion', async () => {
      const { dir, cleanup } = makeTempDir('web_status_pr_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        coordinatorEnabled: true,
        runnerSharedSecret: 'swarm-secret-token-999',
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
            json: { repositoryId: 'agylity', prompt: 'PR task', allowOverage: true },
          })
          .json<any>();

        await ky.post(`${baseUrl}/api/tasks/${disp.taskId}/status`, {
          headers: authHeaders,
          json: {
            status: 'completed',
            branchName: 'antigravity/task-pr',
            prUrl: 'https://github.com/OtterBoops/agylity/pull/99',
          },
        });

        const tasks = await ky.get(`${baseUrl}/api/tasks`).json<any[]>();
        const task = tasks.find((t) => t.id === disp.taskId);
        assert.equal(task?.prUrl, 'https://github.com/OtterBoops/agylity/pull/99');
      } finally {
        await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('persists runner token telemetry (numTurns, totalTokens, thinkingTokens) from a status report', async () => {
      const { dir, cleanup } = makeTempDir('web_status_telemetry_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        coordinatorEnabled: true,
        runnerSharedSecret: 'swarm-secret-token-999',
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
              repositoryId: 'agylity',
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

  /* ==================================================================== */
  /* 10. Task Retry, Routine Trigger Stamping & Patch Validation          */
  /* ==================================================================== */
  describe('10. Task Retry, Routine Trigger Stamping & Patch Validation', () => {
    const runnerHeaders = { 'x-agylity-runner-token': 'swarm-secret-token-999' };

    const poolResetTime = () => new Date(Date.now() + 6 * 3600 * 1000).toISOString();

    const healthySentryState = (dir: string, resetTime: string): SentryStateManager => {
      const state = new SentryStateManager(path.join(dir, 'state.json'));
      state.setState({
        version: 1,
        lastProbeAt: new Date().toISOString(),
        lastProbeSource: 'connect_rpc',
        pools: {
          'gemini-flash': {
            resetTime,
            remainingFraction: 0.8,
            firedMilestones: [],
            lastAlertSentAt: null,
          },
        },
      });
      return state;
    };

    it('POST /api/tasks/:id/retry answers 400 for a safety-floor block and 200 for a real retry', async () => {
      const { dir, cleanup } = makeTempDir('web_task_retry_');
      const resetTime = poolResetTime();
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        coordinatorEnabled: true,
        runnerSharedSecret: 'swarm-secret-token-999',
        repositories: [
          {
            id: 'agylity',
            name: 'Agylity',
            path: dir,
            cloneUrl: 'https://example.invalid/example.git',
            defaultBranch: 'main',
          },
        ],
      });
      const { server, port } = await startWebServer({
        configStore: store,
        sentryState: healthySentryState(dir, resetTime),
        host: '127.0.0.1',
        port: 0,
      });

      try {
        const base = `http://127.0.0.1:${port}`;
        const disp = await ky
          .post(`${base}/api/dispatch`, {
            json: {
              repositoryId: 'agylity',
              prompt: 'Retry a finished dispatch',
              model: 'gemini-3.8-flash',
            },
            retry: 0,
          })
          .json<any>();
        assert.equal(disp.success, true);
        assert.ok(disp.taskId);

        await ky.post(`${base}/api/tasks/${disp.taskId}/status`, {
          headers: runnerHeaders,
          json: { status: 'completed', branchName: 'antigravity/task-retry' },
          retry: 0,
        });

        // Raise the floor above the pool's remaining headroom: the retry is a 400, not a 200.
        store.set('minDispatchHeadroomPercent', 90);
        const blocked = await ky.post(`${base}/api/tasks/${disp.taskId}/retry`, {
          retry: 0,
          throwHttpErrors: false,
        });
        assert.equal(blocked.status, 400);
        const blockedBody = await blocked.json<any>();
        assert.equal(blockedBody.success, false);
        assert.equal(blockedBody.code, 'OVERAGE_PROTECTION_TRIGGERED');
        assert.match(blockedBody.error, /safety floor/);

        // Nothing was enqueued by the refused retry.
        const afterBlock = await ky.get(`${base}/api/tasks`).json<any[]>();
        assert.equal(afterBlock.length, 1);

        // With the floor back under the pool's headroom the same retry succeeds.
        store.set('minDispatchHeadroomPercent', 10);
        const retried = await ky
          .post(`${base}/api/tasks/${disp.taskId}/retry`, { retry: 0 })
          .json<any>();
        assert.equal(retried.success, true);
        assert.ok(retried.taskId);
        assert.notEqual(retried.taskId, disp.taskId);

        const afterRetry = await ky.get(`${base}/api/tasks`).json<any[]>();
        assert.equal(afterRetry.length, 2);
        assert.equal(afterRetry.find((t) => t.id === retried.taskId)?.status, 'queued');
      } finally {
        await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('POST /api/tasks/:id/retry repoints a backlog origin at the retried task', async () => {
      const { dir, cleanup } = makeTempDir('web_task_retry_origin_');
      const resetTime = poolResetTime();
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        coordinatorEnabled: true,
        runnerSharedSecret: 'swarm-secret-token-999',
        repositories: [
          {
            id: 'agylity',
            name: 'Agylity',
            path: dir,
            cloneUrl: 'https://example.invalid/example.git',
            defaultBranch: 'main',
          },
        ],
      });
      const { server, port } = await startWebServer({
        configStore: store,
        sentryState: healthySentryState(dir, resetTime),
        host: '127.0.0.1',
        port: 0,
      });

      try {
        const base = `http://127.0.0.1:${port}`;
        const created = await ky
          .post(`${base}/api/backlog`, {
            json: {
              title: 'Retry a backlog row',
              prompt: 'The retried task must replace the origin pointer',
              repositoryId: 'agylity',
              models: ['gemini-3.8-flash'],
            },
            retry: 0,
          })
          .json<any>();
        assert.ok(created.id);

        const disp = await ky
          .post(`${base}/api/backlog/${created.id}/dispatch`, { retry: 0 })
          .json<any>();
        assert.equal(disp.success, true);
        assert.ok(disp.taskId);

        // The run failed, so the row is back in the queue with the failure recorded.
        await ky.post(`${base}/api/tasks/${disp.taskId}/status`, {
          headers: runnerHeaders,
          json: { status: 'failed', error: 'runner crashed' },
          retry: 0,
        });
        const pending = await ky.get(`${base}/api/backlog/${created.id}`).json<any>();
        assert.equal(pending.status, 'pending');

        const retried = await ky
          .post(`${base}/api/tasks/${disp.taskId}/retry`, { retry: 0 })
          .json<any>();
        assert.equal(retried.success, true);
        assert.notEqual(retried.taskId, disp.taskId);

        const row = await ky.get(`${base}/api/backlog/${created.id}`).json<any>();
        assert.equal(row.status, 'dispatched');
        assert.equal(row.swarmTaskId, retried.taskId);
      } finally {
        await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('POST /api/routines/:id/trigger stamps lastTriggeredResetTime from the matching active pool', async () => {
      const { dir, cleanup } = makeTempDir('web_routine_trigger_stamp_');
      const resetTime = poolResetTime();
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        coordinatorEnabled: true,
        repositories: [
          {
            id: 'agylity',
            name: 'Agylity',
            path: dir,
            cloneUrl: 'https://example.invalid/example.git',
            defaultBranch: 'main',
          },
        ],
      });
      const { server, port } = await startWebServer({
        configStore: store,
        sentryState: healthySentryState(dir, resetTime),
        host: '127.0.0.1',
        port: 0,
      });

      try {
        const base = `http://127.0.0.1:${port}`;
        const routine = await ky
          .post(`${base}/api/routines`, {
            json: {
              title: 'Pre-reset sweep',
              prompt: 'Burn the remaining flash quota before it resets',
              repositoryId: 'agylity',
              models: ['gemini-3.8-flash'],
              triggerBeforeResetHours: 12,
            },
            retry: 0,
          })
          .json<any>();
        assert.ok(routine.id);
        assert.equal(routine.lastTriggeredResetTime, undefined);

        const triggered = await ky
          .post(`${base}/api/routines/${routine.id}/trigger`, { retry: 0 })
          .json<any>();
        assert.equal(triggered.success, true);
        assert.ok(triggered.taskId);

        const row = await ky.get(`${base}/api/routines/${routine.id}`).json<any>();
        assert.equal(row.lastTaskId, triggered.taskId);
        assert.equal(row.lastTriggeredResetTime, resetTime);
      } finally {
        await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('PATCH /api/routines/:id rejects blank text and unusable burn limits, then applies a valid edit', async () => {
      const { dir, cleanup } = makeTempDir('web_routine_patch_guard_');
      const store = new ConfigStore(path.join(dir, 'test.db'), { coordinatorEnabled: true });
      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      try {
        const base = `http://127.0.0.1:${port}`;
        const routine = await ky
          .post(`${base}/api/routines`, {
            json: {
              title: 'Guarded routine',
              prompt: 'Original prompt',
              repositoryId: 'agylity',
              models: ['gemini-3.8-flash'],
              triggerBeforeResetHours: 12,
              minHeadroomPercent: 15,
            },
            retry: 0,
          })
          .json<any>();
        const url = `${base}/api/routines/${routine.id}`;

        const rejected: Array<Record<string, unknown>> = [
          { title: '   ' },
          { title: '' },
          { title: 42 },
          { prompt: '' },
          { prompt: '  \t ' },
          { repositoryId: '' },
          { repositoryId: 7 },
          { triggerBeforeResetHours: 0 },
          { triggerBeforeResetHours: -1 },
          { triggerBeforeResetHours: 'abc' },
          { minHeadroomPercent: -1 },
          { minHeadroomPercent: 101 },
        ];
        for (const patch of rejected) {
          const res = await ky.patch(url, { json: patch, retry: 0, throwHttpErrors: false });
          assert.equal(
            res.status,
            400,
            `PATCH ${JSON.stringify(patch)} must be a 400, got ${res.status}`
          );
        }

        // 1e999 parses to Infinity, which is never a usable burn window.
        const infinite = await ky.patch(url, {
          headers: { 'Content-Type': 'application/json' },
          body: '{"triggerBeforeResetHours": 1e999}',
          retry: 0,
          throwHttpErrors: false,
        });
        assert.equal(infinite.status, 400);

        // JSON has no NaN literal, so a client sending one fails to parse: still a 400, not a 200.
        const nan = await ky.patch(url, {
          headers: { 'Content-Type': 'application/json' },
          body: '{"minHeadroomPercent": NaN}',
          retry: 0,
          throwHttpErrors: false,
        });
        assert.equal(nan.status, 400);

        // The refused patches changed nothing.
        const untouched = await ky.get(url).json<any>();
        assert.equal(untouched.title, 'Guarded routine');
        assert.equal(untouched.triggerBeforeResetHours, 12);
        assert.equal(untouched.minHeadroomPercent, 15);

        // A real edit still lands.
        const updated = await ky
          .patch(url, {
            json: { title: 'Renamed routine', triggerBeforeResetHours: 6, minHeadroomPercent: 25 },
            retry: 0,
          })
          .json<any>();
        assert.equal(updated.title, 'Renamed routine');
        assert.equal(updated.triggerBeforeResetHours, 6);
        assert.equal(updated.minHeadroomPercent, 25);

        const reread = await ky.get(url).json<any>();
        assert.equal(reread.title, 'Renamed routine');
        assert.equal(reread.prompt, 'Original prompt');
      } finally {
        await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('PATCH /api/backlog/:id rejects blank text fields and still applies a valid edit', async () => {
      const { dir, cleanup } = makeTempDir('web_backlog_patch_guard_');
      const store = new ConfigStore(path.join(dir, 'test.db'), { coordinatorEnabled: true });
      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      try {
        const base = `http://127.0.0.1:${port}`;
        const backlog = await ky
          .post(`${base}/api/backlog`, {
            json: {
              title: 'Guarded backlog row',
              prompt: 'Original backlog prompt',
              repositoryId: 'agylity',
              models: ['gemini-3.8-flash'],
            },
            retry: 0,
          })
          .json<any>();
        const url = `${base}/api/backlog/${backlog.id}`;

        for (const patch of [
          { title: '   ' },
          { title: '' },
          { prompt: '' },
          { prompt: ' \t ' },
          { repositoryId: '' },
          { title: 7 },
        ]) {
          const res = await ky.patch(url, { json: patch, retry: 0, throwHttpErrors: false });
          assert.equal(
            res.status,
            400,
            `PATCH ${JSON.stringify(patch)} must be a 400, got ${res.status}`
          );
        }

        const untouched = await ky.get(url).json<any>();
        assert.equal(untouched.title, 'Guarded backlog row');
        assert.equal(untouched.prompt, 'Original backlog prompt');
        assert.equal(untouched.repositoryId, 'agylity');

        const updated = await ky
          .patch(url, {
            json: { title: 'Renamed backlog row', prompt: 'Rewritten prompt' },
            retry: 0,
          })
          .json<any>();
        assert.equal(updated.title, 'Renamed backlog row');
        assert.equal(updated.prompt, 'Rewritten prompt');
      } finally {
        await closeWebServer(server);
        store.close();
        cleanup();
      }
    });
  });

  /* ==================================================================== */
  /* 11. Routine Eligibility & Runner Heartbeat                           */
  /* ==================================================================== */
  describe('11. Routine Eligibility & Runner Heartbeat', () => {
    const runnerToken = 'swarm-secret-token-999';
    const runnerHeaders = { 'x-agylity-runner-token': runnerToken };
    const HEARTBEAT_TAIL_CAP = 16384;
    const ELIGIBILITY_STATES = new Set([
      'disabled',
      'running',
      'ready',
      'waiting_window',
      'cycle_complete',
      'cycle_failed',
      'pool_disabled',
      'low_headroom',
      'no_telemetry',
    ]);

    // The dashboard renders label/detail verbatim: a blank one is a broken card, not a style nit.
    const assertEligibility = (value: any, where: string): void => {
      assert.ok(value && typeof value === 'object', `${where}: eligibility must be an object`);
      assert.ok(
        ELIGIBILITY_STATES.has(value.state),
        `${where}: unexpected eligibility state ${String(value.state)}`
      );
      assert.equal(typeof value.label, 'string', `${where}: label must be a string`);
      assert.ok(value.label.length > 0, `${where}: label must not be empty`);
      assert.equal(typeof value.detail, 'string', `${where}: detail must be a string`);
      assert.ok(value.detail.length > 0, `${where}: detail must not be empty`);
    };

    it('returns an eligibility block alongside the routine on list, create, GET by id and PATCH', async () => {
      const { dir, cleanup } = makeTempDir('web_routine_eligibility_');
      const store = new ConfigStore(path.join(dir, 'test.db'), { coordinatorEnabled: true });
      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      try {
        const base = `http://127.0.0.1:${port}`;
        const createdRes = await ky.post(`${base}/api/routines`, {
          json: {
            title: 'Eligibility list routine',
            prompt: 'Audit the dispatch queue',
            repositoryId: 'agylity',
            models: ['gemini-3.8-flash'],
          },
          retry: 0,
        });
        assert.equal(createdRes.status, 201);
        const created = await createdRes.json<any>();
        const url = `${base}/api/routines/${created.id}`;

        // Server-side verdict travels with the routine, and the routine keeps all of its own fields.
        assertEligibility(created.eligibility, 'POST /api/routines');
        assert.equal(created.title, 'Eligibility list routine');
        assert.equal(created.prompt, 'Audit the dispatch queue');
        assert.equal(created.repositoryId, 'agylity');
        assert.equal(created.enabled, true);

        const listRes = await ky.get(`${base}/api/routines`, { retry: 0 });
        assert.equal(listRes.status, 200);
        const list = await listRes.json<any[]>();
        assert.equal(list.length, 1);
        const listed = list[0];
        assertEligibility(listed.eligibility, 'GET /api/routines');
        assert.equal(listed.id, created.id);
        assert.equal(listed.taskNumber, created.taskNumber);
        assert.equal(listed.title, 'Eligibility list routine');
        assert.equal(listed.repositoryId, 'agylity');
        assert.deepEqual(listed.models, ['gemini-3.8-flash']);

        const fetched = await ky.get(url, { retry: 0 }).json<any>();
        assertEligibility(fetched.eligibility, 'GET /api/routines/:id');
        assert.equal(fetched.id, created.id);
        assert.equal(fetched.title, 'Eligibility list routine');

        const patchedRes = await ky.patch(url, {
          json: { title: 'Renamed eligibility routine', minHeadroomPercent: 30 },
          retry: 0,
        });
        assert.equal(patchedRes.status, 200);
        const patched = await patchedRes.json<any>();
        assertEligibility(patched.eligibility, 'PATCH /api/routines/:id');
        assert.equal(patched.id, created.id);
        assert.equal(patched.title, 'Renamed eligibility routine');
        assert.equal(patched.minHeadroomPercent, 30);
      } finally {
        await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it("reports 'disabled' for a disabled routine and 'no_telemetry' when no quota telemetry is live", async () => {
      const { dir, cleanup } = makeTempDir('web_routine_eligibility_states_');
      const store = new ConfigStore(path.join(dir, 'test.db'), { coordinatorEnabled: true });
      // No sentryState: getActivePools() is empty, so an enabled routine cannot validate dispatch.
      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      try {
        const base = `http://127.0.0.1:${port}`;
        const disabled = await ky
          .post(`${base}/api/routines`, {
            json: {
              title: 'Paused routine',
              prompt: 'Never dispatch me',
              repositoryId: 'agylity',
              models: ['gemini-3.8-flash'],
              enabled: false,
            },
            retry: 0,
          })
          .json<any>();
        assert.equal(disabled.enabled, false);
        assertEligibility(disabled.eligibility, 'POST disabled routine');
        assert.equal(disabled.eligibility.state, 'disabled');

        const live = await ky
          .post(`${base}/api/routines`, {
            json: {
              title: 'Live routine',
              prompt: 'Dispatch me when telemetry exists',
              repositoryId: 'agylity',
              models: ['gemini-3.8-flash'],
            },
            retry: 0,
          })
          .json<any>();
        assert.equal(live.enabled, true);
        assertEligibility(live.eligibility, 'POST enabled routine');
        assert.equal(live.eligibility.state, 'no_telemetry');

        // The list recomputes the same verdicts for both rows.
        const list = await ky.get(`${base}/api/routines`, { retry: 0 }).json<any[]>();
        const byId = new Map(list.map((rt) => [rt.id, rt]));
        assert.equal(byId.get(disabled.id)?.eligibility.state, 'disabled');
        assert.equal(byId.get(live.id)?.eligibility.state, 'no_telemetry');
        for (const rt of list) assertEligibility(rt.eligibility, 'GET /api/routines');
      } finally {
        await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('accepts a claimed task heartbeat, streams the output tail and truncates it to the last 16384 chars', async () => {
      const { dir, cleanup } = makeTempDir('web_heartbeat_output_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        coordinatorEnabled: true,
        runnerSharedSecret: runnerToken,
      });
      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      try {
        const base = `http://127.0.0.1:${port}`;
        const disp = await ky
          .post(`${base}/api/dispatch`, {
            json: { repositoryId: 'agylity', prompt: 'Stream your output', allowOverage: true },
            retry: 0,
          })
          .json<any>();
        assert.ok(disp.taskId);

        const poll = await ky
          .post(`${base}/api/tasks/poll`, {
            headers: runnerHeaders,
            json: { runnerId: 'runner-hb', timeoutMs: 0 },
            retry: 0,
          })
          .json<any>();
        assert.equal(poll.task?.id, disp.taskId);
        assert.equal(poll.task?.status, 'claimed');

        const first = await ky
          .post(`${base}/api/runner/heartbeat`, {
            headers: runnerHeaders,
            json: {
              taskId: disp.taskId,
              runnerId: 'runner-hb',
              leaseDurationMs: 60000,
              outputTail: 'compiling...\nok',
            },
            retry: 0,
          })
          .json<any>();
        assert.equal(first.leaseOk, true);
        assert.equal(first.status, 'claimed');
        assert.equal(first.task?.id, disp.taskId);
        assert.equal(first.task?.output, 'compiling...\nok');

        // 20000 chars: only the last 16384 may be persisted.
        const longTail = 'H'.repeat(5000) + 'T'.repeat(15000);
        assert.equal(longTail.length, 20000);
        const second = await ky
          .post(`${base}/api/runner/heartbeat`, {
            headers: runnerHeaders,
            json: {
              taskId: disp.taskId,
              runnerId: 'runner-hb',
              leaseDurationMs: 60000,
              outputTail: longTail,
            },
            retry: 0,
          })
          .json<any>();
        assert.equal(second.leaseOk, true);
        assert.equal(second.task.output.length, HEARTBEAT_TAIL_CAP);
        assert.equal(second.task.output, longTail.slice(-HEARTBEAT_TAIL_CAP));
        assert.notEqual(second.task.output, longTail);

        // The persisted row (not just the response echo) carries the capped tail.
        const row = await ky.get(`${base}/api/tasks/${disp.taskId}`, { retry: 0 }).json<any>();
        assert.equal(row.status, 'claimed');
        assert.equal(row.output.length, HEARTBEAT_TAIL_CAP);
        assert.equal(row.output, longTail.slice(-HEARTBEAT_TAIL_CAP));
      } finally {
        await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('answers 409 leaseOk:false for a terminal task and leaves its output untouched', async () => {
      const { dir, cleanup } = makeTempDir('web_heartbeat_terminal_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        coordinatorEnabled: true,
        runnerSharedSecret: runnerToken,
      });
      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      try {
        const base = `http://127.0.0.1:${port}`;
        const disp = await ky
          .post(`${base}/api/dispatch`, {
            json: { repositoryId: 'agylity', prompt: 'Dies mid-run', allowOverage: true },
            retry: 0,
          })
          .json<any>();

        await ky.post(`${base}/api/tasks/poll`, {
          headers: runnerHeaders,
          json: { runnerId: 'runner-hb', timeoutMs: 0 },
          retry: 0,
        });

        const warm = await ky
          .post(`${base}/api/runner/heartbeat`, {
            headers: runnerHeaders,
            json: {
              taskId: disp.taskId,
              runnerId: 'runner-hb',
              leaseDurationMs: 60000,
              outputTail: 'before-terminal',
            },
            retry: 0,
          })
          .json<any>();
        assert.equal(warm.leaseOk, true);
        assert.equal(warm.task.output, 'before-terminal');

        const failed = await ky
          .post(`${base}/api/tasks/${disp.taskId}/status`, {
            headers: runnerHeaders,
            json: { status: 'failed', error: 'runner crashed', runnerId: 'runner-hb' },
            retry: 0,
          })
          .json<any>();
        assert.equal(failed.task.status, 'failed');

        const refusedRes = await ky.post(`${base}/api/runner/heartbeat`, {
          headers: runnerHeaders,
          json: {
            taskId: disp.taskId,
            runnerId: 'runner-hb',
            leaseDurationMs: 60000,
            outputTail: 'after-terminal-must-not-land',
          },
          retry: 0,
          throwHttpErrors: false,
        });
        assert.equal(refusedRes.status, 409);
        const refused = await refusedRes.json<any>();
        assert.equal(refused.leaseOk, false);
        assert.equal(refused.status, 'failed');
        assert.equal(refused.task.status, 'failed');
        assert.equal(refused.task.output, 'before-terminal');

        // Neither the status transition nor the refused beat clobbered the stored tail.
        const row = await ky.get(`${base}/api/tasks/${disp.taskId}`, { retry: 0 }).json<any>();
        assert.equal(row.status, 'failed');
        assert.equal(row.error, 'runner crashed');
        assert.equal(row.output, 'before-terminal');
      } finally {
        await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('rejects heartbeats without a runner token, without a taskId, or for an unknown task', async () => {
      const { dir, cleanup } = makeTempDir('web_heartbeat_guards_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        coordinatorEnabled: true,
        runnerSharedSecret: runnerToken,
      });
      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      try {
        const base = `http://127.0.0.1:${port}`;
        const url = `${base}/api/runner/heartbeat`;

        const anonymous = await ky.post(url, {
          json: { taskId: 'any-task' },
          retry: 0,
          throwHttpErrors: false,
        });
        assert.equal(anonymous.status, 401);

        const wrongToken = await ky.post(url, {
          headers: { 'x-agylity-runner-token': 'not-the-secret' },
          json: { taskId: 'any-task' },
          retry: 0,
          throwHttpErrors: false,
        });
        assert.equal(wrongToken.status, 401);

        const missingTask = await ky.post(url, {
          headers: runnerHeaders,
          json: { runnerId: 'runner-hb' },
          retry: 0,
          throwHttpErrors: false,
        });
        assert.equal(missingTask.status, 400);

        const unknown = await ky.post(url, {
          headers: runnerHeaders,
          json: { taskId: 'nope', runnerId: 'runner-hb' },
          retry: 0,
          throwHttpErrors: false,
        });
        assert.equal(unknown.status, 404);
      } finally {
        await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('serves a single task by id without shadowing poll, status, cancel or retry', async () => {
      const { dir, cleanup } = makeTempDir('web_task_by_id_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        coordinatorEnabled: true,
        runnerSharedSecret: runnerToken,
      });
      const { server, port } = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
      });

      try {
        const base = `http://127.0.0.1:${port}`;
        const disp = await ky
          .post(`${base}/api/dispatch`, {
            json: { repositoryId: 'agylity', prompt: 'Inspect me by id', allowOverage: true },
            retry: 0,
          })
          .json<any>();
        assert.ok(disp.taskId);

        const fetchedRes = await ky.get(`${base}/api/tasks/${disp.taskId}`, { retry: 0 });
        assert.equal(fetchedRes.status, 200);
        const fetched = await fetchedRes.json<any>();
        assert.equal(fetched.id, disp.taskId);
        assert.equal(fetched.repositoryId, 'agylity');
        assert.equal(fetched.prompt, 'Inspect me by id');
        assert.equal(fetched.status, 'queued');

        const missingRes = await ky.get(`${base}/api/tasks/nope`, {
          retry: 0,
          throwHttpErrors: false,
        });
        assert.equal(missingRes.status, 404);
        const missing = await missingRes.json<any>();
        assert.match(String(missing.error), /nope/);

        // Route-order regression guard: the id route must not swallow the runner subroutes.
        const poll = await ky
          .post(`${base}/api/tasks/poll`, {
            headers: runnerHeaders,
            json: { runnerId: 'runner-hb', timeoutMs: 0 },
            retry: 0,
          })
          .json<any>();
        assert.equal(poll.task?.id, disp.taskId);
        assert.equal(poll.task?.status, 'claimed');

        const statusRes = await ky.post(`${base}/api/tasks/${disp.taskId}/status`, {
          headers: runnerHeaders,
          json: { status: 'executing', runnerId: 'runner-hb' },
          retry: 0,
          throwHttpErrors: false,
        });
        assert.equal(statusRes.status, 200);

        const afterStatus = await ky
          .get(`${base}/api/tasks/${disp.taskId}`, { retry: 0 })
          .json<any>();
        assert.equal(afterStatus.status, 'executing');

        const cancelRes = await ky.post(`${base}/api/tasks/${disp.taskId}/cancel`, {
          headers: runnerHeaders,
          json: {},
          retry: 0,
          throwHttpErrors: false,
        });
        assert.equal(cancelRes.status, 200);

        const retryRes = await ky.post(`${base}/api/tasks/${disp.taskId}/retry`, {
          headers: runnerHeaders,
          json: {},
          retry: 0,
          throwHttpErrors: false,
        });
        assert.equal(retryRes.status, 200);
        const retried = await retryRes.json<any>();
        assert.equal(retried.success, true);
        assert.notEqual(retried.task?.id, disp.taskId);
      } finally {
        await closeWebServer(server);
        store.close();
        cleanup();
      }
    });
  });
});
