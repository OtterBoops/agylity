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
import { clearAuthFailures } from '../../src/web/routes.js';
import type { QuotaClient, QuotaSnapshot } from '../../src/sentry/models.js';
import { DynamicModelCatalog } from '../../src/coordinator/catalog.js';
import {
  handleSyncGithubBacklog,
  listOpenIssues,
  resolveGithubRepoSlug,
} from '../../src/web/controllers/backlog.js';
import { Coordinator } from '../../src/coordinator/coordinator.js';
import {
  formatBuildLabel,
  isNewerMainCommit,
  normalizeBuildCommit,
  resolveBuildChannel,
} from '../../src/shared/build.js';
import type { Logger } from '../../src/logs/logger.js';

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

        // The reported host:port must be the socket actually listening, not the requested 0.
        assert.ok(started.port > 0, `Expected assigned port > 0, got ${started.port}`);
        const health = await ky
          .get(`http://${started.host}:${started.port}/api/health`, { retry: 0 })
          .json<any>();
        assert.equal(health.status, 'ok');
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
        // The retired DispatchModal left this marker behind; the palette id proves the shell ships.
        assert.ok(scriptBody.includes('command-palette-dialog'));
        assert.ok(scriptBody.includes('quotaGrid'));
        // Settings search moved into the palette, so the field catalogue must ship with the shell.
        assert.ok(scriptBody.includes('Polling interval (seconds)'));

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
            poolGroup: 'claude',
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
      const sentryState = new SentryStateManager({ db: store.getDatabase() });
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
            poolId: 'gemini',
            poolGroup: 'gemini',
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
        assert.deepEqual(quotas[0]?.models, [
          'Gemini 3.8 Flash',
          'Gemini 4 Hydrogen',
          'Gemini 4 Argon',
        ]);
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('GET /api/alerts returns sentry alert state from SentryStateManager', async () => {
      const { dir, cleanup } = makeTempDir('web_test_alerts_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      const sentryState = new SentryStateManager({ db: store.getDatabase() });
      sentryState.setState({
        version: 1,
        lastProbeAt: '2026-10-19T14:00:00.000Z',
        lastProbeSource: 'connect_rpc',
        pools: {
          gemini: {
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
        assert.deepEqual(alerts.pools.gemini.firedMilestones, ['12h']);
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('POST /api/alerts/dismiss clears the early-reset notice and GET reflects it', async () => {
      const { dir, cleanup } = makeTempDir('web_test_alerts_dismiss_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      const sentryState = new SentryStateManager({ db: store.getDatabase() });
      sentryState.setState({
        version: 1,
        lastProbeAt: '2026-10-19T14:00:00.000Z',
        lastProbeSource: 'connect_rpc',
        pools: {},
        earlyResetNotice: {
          detectedAt: '2026-10-19T13:30:00.000Z',
          pools: [
            {
              poolId: 'gemini',
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
        assert.equal(before.earlyResetNotice.pools[0].poolId, 'gemini');

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

    it('POST /api/config applies { set, clear } in one atomic request', async () => {
      const { dir, cleanup } = makeTempDir('web_test_config_envelope_');
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

        const postRes = await ky
          .post(`http://127.0.0.1:${started.port}/api/config`, {
            json: {
              set: { quotaCheckIntervalSeconds: 300, logLevel: 'debug' },
              clear: ['quotaAlertThresholdPercent'],
            },
          })
          .json<any>();

        assert.equal(postRes.success, true);
        assert.equal(postRes.resolved.quotaCheckIntervalSeconds, 300);
        assert.equal(store.get('quotaCheckIntervalSeconds'), 300);
        assert.equal(store.get('logLevel'), 'debug');
        assert.deepEqual(postRes.cleared, ['quotaAlertThresholdPercent']);
        assert.equal(store.getAllOverrides().quotaAlertThresholdPercent, undefined);
        assert.equal(postRes.overrides.quotaAlertThresholdPercent, undefined);
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('POST /api/config rejects the whole envelope when any set key is invalid', async () => {
      const { dir, cleanup } = makeTempDir('web_test_config_envelope_atomic_');
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
              json: { set: { quotaCheckIntervalSeconds: 300, notARealKey: true } },
              retry: 0,
            });
          },
          (err: any) => err.response?.status === 400
        );

        // Neither the valid half nor the delete half may land.
        assert.equal(store.getAllOverrides().quotaCheckIntervalSeconds, undefined);
        assert.equal(store.get('quotaCheckIntervalSeconds'), 60);

        await assert.rejects(
          async () => {
            await ky.post(`http://127.0.0.1:${started.port}/api/config`, {
              json: { clear: ['notARealKey'] },
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

    it('POST /api/config keeps a masked secret in `set` and deletes a secret in `clear`', async () => {
      const { dir, cleanup } = makeTempDir('web_test_config_envelope_secret_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      store.setOverride('discordToken', 'stored-discord-token');
      store.setOverride('webhookSecret', 'stored-hmac-secret');
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
            json: { set: { discordToken: '••••••••' }, clear: ['webhookSecret'] },
          })
          .json<any>();

        assert.equal(store.getAllOverrides().discordToken, 'stored-discord-token');
        assert.equal(store.getAllOverrides().webhookSecret, undefined);
        assert.deepEqual(postRes.cleared, ['webhookSecret']);
        assert.equal(postRes.secretsMeta.discordToken.isSet, true);
        assert.equal(postRes.secretsMeta.webhookSecret.isSet, false);
        assert.equal(postRes.overrides.discordToken, '••••••••');
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('GET /api/config masks githubToken and reports it as set', async () => {
      const { dir, cleanup } = makeTempDir('web_test_config_github_token_mask_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      store.setOverride('githubToken', 'ghp_plaintext_never_returned');
      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;

        const res = await ky.get(`http://127.0.0.1:${started.port}/api/config`).json<any>();

        assert.equal(res.resolved.githubToken, '••••••••');
        assert.equal(res.overrides.githubToken, '••••••••');
        assert.equal(res.secretsMeta.githubToken.isSet, true);
        assert.equal(
          JSON.stringify(res).includes('ghp_plaintext_never_returned'),
          false,
          'the plaintext token must never reach the client'
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

    it('DELETE /api/config/:key rejects unknown and prototype keys with 400', async () => {
      const { dir, cleanup } = makeTempDir('web_test_config_delete_guard_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      store.setOverride('quotaAlertThresholdPercent', 45);
      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;
        const base = `http://127.0.0.1:${started.port}`;

        for (const key of ['notAConfigKey', '__proto__', 'constructor']) {
          const res = await ky.delete(`${base}/api/config/${key}`, {
            retry: 0,
            throwHttpErrors: false,
          });
          assert.equal(res.status, 400, `${key} must never reach the settings store`);
        }

        // The same key set is refused on the POST path, including a masked secret value.
        for (const payload of [
          { key: '__proto__', value: 'x' },
          { notAConfigKey: 'x' },
          { notAConfigKey: '********' },
        ]) {
          const res = await ky.post(`${base}/api/config`, {
            json: payload,
            retry: 0,
            throwHttpErrors: false,
          });
          assert.equal(res.status, 400, `${JSON.stringify(payload)} must be rejected`);
        }

        assert.equal(store.get('quotaAlertThresholdPercent'), 45);
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

    it('POST /api/dispatch validates the cascade: empty or unknown hops 400, an unknown effort clamps', async () => {
      const { dir, cleanup } = makeTempDir('web_test_dispatch_cascade_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        coordinatorEnabled: true,
        defaultDispatchModel: 'gemini-4-hydrogen',
        defaultDispatchEffort: 'medium',
      });
      const sentryState = new SentryStateManager({ db: store.getDatabase() });
      sentryState.setState({
        version: 1,
        lastProbeAt: new Date().toISOString(),
        lastProbeSource: 'connect_rpc',
        pools: {
          gemini: {
            resetTime: new Date(Date.now() + 3600000).toISOString(),
            remainingFraction: 0.8,
            firedMilestones: [],
            lastAlertSentAt: null,
          },
          claude: {
            resetTime: new Date(Date.now() + 3600000).toISOString(),
            remainingFraction: 0.8,
            firedMilestones: [],
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
        const base = `http://127.0.0.1:${port}`;
        const post = (cascade: unknown) =>
          ky.post(`${base}/api/dispatch`, {
            json: { repositoryId: 'agylity', prompt: 'Cascade contract', cascade: cascade as any },
            retry: 0,
            throwHttpErrors: false,
          });

        for (const [label, cascade] of [
          ['an empty cascade', []],
          ['an unknown model', [{ model: 'gemini-9-turbo', effort: 'low' }]],
          ['a hop with no model', [{ effort: 'low' }]],
          ['a hop that is not an object', ['gemini-4-hydrogen']],
          ['a bare string instead of a list', 'gemini-4-hydrogen'],
        ] as Array<[string, unknown]>) {
          const res = await post(cascade);
          assert.equal(res.status, 400, `${label} must be a 400, got ${res.status}`);
          const body = (await res.json()) as { error?: string };
          assert.equal(typeof body.error, 'string', `${label} must explain the rejection`);
        }

        // A known model with an unknown effort is normalised, not rejected: it clamps to the
        // model's default effort ('medium' for hydrogen).
        const clamped = await post([{ model: 'gemini-4-hydrogen', effort: 'ultra' }]);
        assert.equal(clamped.status, 200);
        const clampedBody = (await clamped.json()) as any;
        assert.equal(clampedBody.success, true);
        const fetchedClamped = await ky
          .get(`${base}/api/tasks/${clampedBody.taskId}`, { retry: 0 })
          .json<any>();
        assert.equal(fetchedClamped.model, 'gemini-4-hydrogen');
        assert.equal(fetchedClamped.effort, 'medium');

        // The first hop is what dispatches, carrying ITS effort — not the model default, not hop 2.
        const first = await post([
          { model: 'gemini-4-hydrogen', effort: 'low' },
          { model: 'claude-sonnet-5-5', effort: 'high' },
        ]);
        assert.equal(first.status, 200);
        const firstBody = (await first.json()) as any;
        assert.equal(firstBody.success, true);
        assert.equal(firstBody.model, 'gemini-4-hydrogen');
        const fetchedFirst = await ky
          .get(`${base}/api/tasks/${firstBody.taskId}`, { retry: 0 })
          .json<any>();
        assert.equal(fetchedFirst.effort, 'low');
      } finally {
        await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('POST /api/dispatch blocks execution when quota headroom is below safety floor without allowOverage', async () => {
      const { dir, cleanup } = makeTempDir('web_test_dispatch_overage_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        minDispatchHeadroomPercent: 15,
      });
      const sentryState = new SentryStateManager({ db: store.getDatabase() });
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
        notificationChannel: 'webhook',
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
        assert.equal(res.channel, 'webhook');
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
  /* 8. HTTP Body Bounding & Payload Protection                           */
  /* ==================================================================== */
  describe('8. HTTP Body Bounding & Payload Protection', () => {
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
      // The failure counter is module-global and keyed by client IP, so this test sends a
      // forwarded address: its counter cannot be primed by an earlier test's success, and
      // being blocked at the end cannot rate-limit the 127.0.0.1 tests that follow.
      const forwarded = { 'x-forwarded-for': '203.0.113.77' };
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        webUiAuthToken: 'correct_token',
        webUiAuthExemptLocalhost: false,
        trustedProxies: true,
      });
      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;
        const base = `http://127.0.0.1:${started.port}`;

        // Prove the counter starts at zero rather than inheriting another test's failures.
        const primed = await ky.get(`${base}/api/quota`, {
          headers: { ...forwarded, Authorization: 'Bearer correct_token' },
          throwHttpErrors: false,
        });
        assert.equal(primed.status, 200);

        // 9 failed attempts should return 401
        for (let i = 0; i < 9; i++) {
          const res = await ky.get(`${base}/api/quota`, {
            headers: { ...forwarded, Authorization: 'Bearer wrong_token' },
            throwHttpErrors: false,
          });
          assert.equal(res.status, 401);
        }

        // 10th failed attempt triggers 429
        const tenthRes = await ky.get(`${base}/api/quota`, {
          headers: { ...forwarded, Authorization: 'Bearer wrong_token' },
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

    it('locks out a peer that brute-forces a runner credential without throttling a valid runner', async () => {
      const { dir, cleanup } = makeTempDir('web_test_runner_lockout_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        coordinatorEnabled: true,
        runnerSharedSecret: 'runner-shared-secret-777',
        trustedProxies: true,
      });
      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;
        const pollUrl = `http://127.0.0.1:${started.port}/api/tasks/poll`;
        const attacker = { 'x-forwarded-for': '198.51.100.42' };

        for (let i = 0; i < 10; i++) {
          const res = await ky.post(pollUrl, {
            headers: { ...attacker, 'x-agylity-runner-token': 'wrong-runner-token' },
            json: {},
            retry: 0,
            throwHttpErrors: false,
          });
          assert.equal(res.status, 401, `attempt ${i + 1} must be rejected before the lockout`);
        }

        // The runner endpoints are exempt from the control-plane token, so this lockout is their own.
        const blocked = await ky.post(pollUrl, {
          headers: { ...attacker, 'x-agylity-runner-token': 'wrong-runner-token' },
          json: {},
          retry: 0,
          throwHttpErrors: false,
        });
        assert.equal(blocked.status, 429);
        assert.equal(blocked.headers.get('retry-after'), '60');

        const legit = await ky.post(pollUrl, {
          headers: {
            'x-forwarded-for': '198.51.100.43',
            'x-agylity-runner-token': 'runner-shared-secret-777',
          },
          json: {},
          retry: 0,
          throwHttpErrors: false,
        });
        assert.equal(legit.status, 200);
      } finally {
        clearAuthFailures('198.51.100.42', 'runner');
        clearAuthFailures('198.51.100.43', 'runner');
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('leases the coordinator GitHub token in memory and never writes it to the task row', async () => {
      const { dir, cleanup } = makeTempDir('web_test_lease_token_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        coordinatorEnabled: true,
        runnerSharedSecret: 'runner-shared-secret-901',
        repositories: [
          {
            id: 'OtterBoops/agylity',
            name: 'OtterBoops/agylity',
            path: path.join(dir, 'repo'),
            cloneUrl: 'https://github.com/OtterBoops/agylity.git',
            defaultBranch: 'main',
          },
        ],
      });
      // Set through the UI path so the at-rest encryption is part of what this asserts.
      store.setOverride('githubToken', 'ghp_lease_me_123456');
      const sentryState = new SentryStateManager({ db: store.getDatabase() });
      sentryState.setState({
        version: 1,
        lastProbeAt: new Date().toISOString(),
        lastProbeSource: 'connect_rpc',
        pools: {
          gemini: {
            resetTime: new Date(Date.now() + 3600000).toISOString(),
            remainingFraction: 0.8,
            firedMilestones: [],
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
        const base = `http://127.0.0.1:${started.port}`;

        const dispatch = await ky
          .post(`${base}/api/dispatch`, {
            json: {
              repositoryId: 'OtterBoops/agylity',
              prompt: 'Lease the credential',
              cascade: [{ model: 'gemini-4-hydrogen', effort: 'high' }],
            },
            retry: 0,
          })
          .json<any>();
        assert.equal(dispatch.success, true, JSON.stringify(dispatch));

        const lease = await ky
          .post(`${base}/api/tasks/poll`, {
            headers: { 'x-agylity-runner-token': 'runner-shared-secret-901' },
            json: { runnerId: 'runner-lease' },
            retry: 0,
          })
          .json<any>();

        assert.equal(lease.credentialsAvailable, true);
        assert.equal(lease.githubToken, 'ghp_lease_me_123456');
        assert.equal(lease.task?.id, dispatch.taskId);

        // The lease lives in the response only: neither the API nor the row may carry it.
        const listed = await ky.get(`${base}/api/tasks`).json<any>();
        assert.equal(JSON.stringify(listed).includes('ghp_lease_me_123456'), false);
        const rows = store.getDatabase().getRawDb().prepare('SELECT * FROM swarm_tasks').all();
        assert.equal(JSON.stringify(rows).includes('ghp_lease_me_123456'), false);
        // At rest it is ciphertext, like every other secret.
        assert.equal(store.getDatabase().getRaw('githubToken')?.includes('enc:v1:'), true);
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('isolates the runner and control-plane brute-force counters', async () => {
      const { dir, cleanup } = makeTempDir('web_test_domain_isolation_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        coordinatorEnabled: true,
        runnerSharedSecret: 'runner-shared-secret-888',
        webUiAuthToken: 'control-token-888',
        webUiAuthExemptLocalhost: false,
        trustedProxies: true,
      });
      let server: http.Server | undefined;
      const runnerIp = '198.51.100.51';
      const controlIp = '198.51.100.52';

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;
        const base = `http://127.0.0.1:${started.port}`;

        // A runner brute-force locks the runner domain only.
        for (let i = 0; i < 10; i++) {
          const res = await ky.post(`${base}/api/tasks/poll`, {
            headers: { 'x-forwarded-for': runnerIp, 'x-agylity-runner-token': 'wrong' },
            json: {},
            retry: 0,
            throwHttpErrors: false,
          });
          assert.equal(res.status, 401);
        }
        const runnerBlocked = await ky.post(`${base}/api/tasks/poll`, {
          headers: { 'x-forwarded-for': runnerIp, 'x-agylity-runner-token': 'wrong' },
          json: {},
          retry: 0,
          throwHttpErrors: false,
        });
        assert.equal(runnerBlocked.status, 429);

        // The same peer's control-plane token must still be accepted.
        const controlOk = await ky.get(`${base}/api/quota`, {
          headers: { 'x-forwarded-for': runnerIp, Authorization: 'Bearer control-token-888' },
          throwHttpErrors: false,
        });
        assert.equal(controlOk.status, 200);

        // Mirror: a control-plane brute-force locks the control domain only.
        for (let i = 0; i < 10; i++) {
          await ky.get(`${base}/api/quota`, {
            headers: { 'x-forwarded-for': controlIp, Authorization: 'Bearer wrong' },
            throwHttpErrors: false,
          });
        }
        const controlBlocked = await ky.get(`${base}/api/quota`, {
          headers: { 'x-forwarded-for': controlIp, Authorization: 'Bearer control-token-888' },
          throwHttpErrors: false,
        });
        assert.equal(controlBlocked.status, 429);

        const runnerOk = await ky.post(`${base}/api/tasks/poll`, {
          headers: {
            'x-forwarded-for': controlIp,
            'x-agylity-runner-token': 'runner-shared-secret-888',
          },
          json: {},
          retry: 0,
          throwHttpErrors: false,
        });
        assert.equal(runnerOk.status, 200);
      } finally {
        for (const ip of [runnerIp, controlIp]) {
          clearAuthFailures(ip, 'runner');
          clearAuthFailures(ip, 'control');
        }
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
  /* 10b. Task Text Fields Must Be Strings On POST                        */
  /* ==================================================================== */
  describe('10b. Task Text Fields Must Be Strings On POST', () => {
    it('rejects POST /api/backlog with a non-string text field and creates no row', async () => {
      const { dir, cleanup } = makeTempDir('web_backlog_post_nonstring_');
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

        // A truthy object or array used to pass validation and be stored as
        // "[object Object]" / "1,2".
        const rejected: Array<Record<string, unknown>> = [
          { title: { x: 1 }, prompt: 'P', repositoryId: 'agylity' },
          { title: 'Valid title', prompt: [1, 2], repositoryId: 'agylity' },
        ];
        for (const body of rejected) {
          const res = await ky.post(`${base}/api/backlog`, {
            json: body,
            retry: 0,
            throwHttpErrors: false,
          });
          assert.equal(
            res.status,
            400,
            `POST ${JSON.stringify(body)} must be a 400, got ${res.status}`
          );
        }

        const listRes = await ky.get(`${base}/api/backlog`, { retry: 0 });
        assert.equal(listRes.status, 200);
        const list = await listRes.json<any[]>();
        assert.deepEqual(list, [], 'a rejected POST must not leave a backlog row behind');
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('rejects POST /api/routines with non-string text fields and creates no row', async () => {
      const { dir, cleanup } = makeTempDir('web_routine_post_nonstring_');
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

        const rejected: Array<Record<string, unknown>> = [
          { title: 'Valid title', prompt: [1, 2], repositoryId: 'agylity' },
          { title: 7, prompt: 'Valid prompt', repositoryId: 'agylity' },
        ];
        for (const body of rejected) {
          const res = await ky.post(`${base}/api/routines`, {
            json: body,
            retry: 0,
            throwHttpErrors: false,
          });
          assert.equal(
            res.status,
            400,
            `POST ${JSON.stringify(body)} must be a 400, got ${res.status}`
          );
        }

        const list = await ky.get(`${base}/api/routines`, { retry: 0 }).json<any[]>();
        assert.deepEqual(list, [], 'a rejected POST must not leave a routine row behind');
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('still accepts a fully valid POST /api/backlog with 201', async () => {
      const { dir, cleanup } = makeTempDir('web_backlog_post_valid_');
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

        const createdRes = await ky.post(`${base}/api/backlog`, {
          json: { title: 'Valid backlog row', prompt: 'Do the thing', repositoryId: 'agylity' },
          retry: 0,
          throwHttpErrors: false,
        });
        assert.equal(createdRes.status, 201);
        const created = await createdRes.json<any>();
        assert.equal(created.title, 'Valid backlog row');
        assert.equal(created.prompt, 'Do the thing');
        assert.equal(created.repositoryId, 'agylity');

        const list = await ky.get(`${base}/api/backlog`, { retry: 0 }).json<any[]>();
        assert.equal(list.length, 1);
        assert.equal(list[0].title, 'Valid backlog row');
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });
  });

  /* ==================================================================== */
  /* 10c. Bulk Backlog Actions                                            */
  /* ==================================================================== */
  describe('10c. Bulk Backlog Actions', () => {
    it('pauses only pending/dispatched rows, reports skipped ids and rejects a bad body', async () => {
      const { dir, cleanup } = makeTempDir('web_backlog_bulk_pause_');
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

        const create = async (title: string) =>
          ky
            .post(`${base}/api/backlog`, {
              json: { title, prompt: 'P', repositoryId: 'agylity' },
              retry: 0,
              throwHttpErrors: false,
            })
            .json<{ id: string }>();

        const pending = await create('Pending row');
        const settled = await create('Completed row');
        const patched = await ky.patch(`${base}/api/backlog/${encodeURIComponent(settled.id)}`, {
          json: { status: 'completed' },
          retry: 0,
          throwHttpErrors: false,
        });
        assert.equal(patched.status, 200);

        const missing = 'backlog-does-not-exist';
        const res = await ky.patch(`${base}/api/backlog/bulk`, {
          json: { ids: [pending.id, settled.id, missing], action: 'pause' },
          retry: 0,
          throwHttpErrors: false,
        });
        assert.equal(res.status, 200);
        const body = await res.json<{
          updated: number;
          items: Array<{ id: string; status: string }>;
          skipped: string[];
        }>();
        assert.equal(body.updated, 1);
        assert.deepEqual(
          body.items.map((item) => item.id),
          [pending.id]
        );
        assert.equal(body.items[0]!.status, 'paused');
        assert.deepEqual([...body.skipped].sort(), [settled.id, missing].sort());

        // A settled row keeps its outcome, and the paused row leaves the pending pool.
        const settledAfter = await ky
          .get(`${base}/api/backlog/${encodeURIComponent(settled.id)}`)
          .json<{ status: string }>();
        assert.equal(settledAfter.status, 'completed');
        const pendingPool = await ky
          .get(`${base}/api/backlog?status=pending`, { retry: 0 })
          .json<any[]>();
        assert.deepEqual(pendingPool, []);
        const pausedPool = await ky
          .get(`${base}/api/backlog?status=paused`, { retry: 0 })
          .json<any[]>();
        assert.deepEqual(
          pausedPool.map((row) => row.id),
          [pending.id]
        );

        const invalidBodies: Array<Record<string, unknown>> = [
          { ids: [], action: 'pause' },
          { ids: 'not-an-array', action: 'pause' },
          { ids: [pending.id], action: 'sideways' },
          { ids: [1, 2], action: 'pause' },
        ];
        for (const invalid of invalidBodies) {
          const badRes = await ky.patch(`${base}/api/backlog/bulk`, {
            json: invalid,
            retry: 0,
            throwHttpErrors: false,
          });
          assert.equal(
            badRes.status,
            400,
            `expected 400 for ${JSON.stringify(invalid)}, got ${badRes.status}`
          );
          const errBody = await badRes.json<{ error?: string }>();
          assert.ok(errBody.error, 'a rejected bulk body must explain itself');
        }

        // The bulk route is PATCH-only: it must not fall through to the /api/backlog/<id> parser.
        const getRes = await ky.get(`${base}/api/backlog/bulk`, {
          retry: 0,
          throwHttpErrors: false,
        });
        assert.equal(getRes.status, 405);
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('returns paused rows to pending on resume and counts a repeated id once', async () => {
      const { dir, cleanup } = makeTempDir('web_backlog_bulk_resume_');
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
            json: { title: 'Resumable row', prompt: 'P', repositoryId: 'agylity' },
            retry: 0,
            throwHttpErrors: false,
          })
          .json<{ id: string }>();

        const paused = await ky.patch(`${base}/api/backlog/bulk`, {
          json: { ids: [created.id], action: 'pause' },
          retry: 0,
          throwHttpErrors: false,
        });
        assert.equal(paused.status, 200);
        assert.equal(
          (await paused.json<{ updated: number }>()).updated,
          1,
          'a pending row must be pausable'
        );

        // A repeated id is one row, not two updates.
        const resumed = await ky.patch(`${base}/api/backlog/bulk`, {
          json: { ids: [created.id, created.id], action: 'resume' },
          retry: 0,
          throwHttpErrors: false,
        });
        assert.equal(resumed.status, 200);
        const body = await resumed.json<{
          updated: number;
          items: Array<{ id: string; status: string }>;
          skipped: string[];
        }>();
        assert.equal(body.updated, 1);
        assert.equal(body.items[0]!.status, 'pending');
        assert.deepEqual(body.skipped, []);

        const after = await ky
          .get(`${base}/api/backlog/${encodeURIComponent(created.id)}`)
          .json<{ status: string }>();
        assert.equal(after.status, 'pending');

        // Resuming something already pending changes nothing and says so.
        const again = await ky.patch(`${base}/api/backlog/bulk`, {
          json: { ids: [created.id], action: 'resume' },
          retry: 0,
          throwHttpErrors: false,
        });
        const againBody = await again.json<{ updated: number; skipped: string[] }>();
        assert.equal(againBody.updated, 0);
        assert.deepEqual(againBody.skipped, [created.id]);
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('deletes rows by id on POST, reports unknown ids and 404s the deleted row', async () => {
      const { dir, cleanup } = makeTempDir('web_backlog_bulk_delete_');
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

        const create = async (title: string) =>
          ky
            .post(`${base}/api/backlog`, {
              json: { title, prompt: 'P', repositoryId: 'agylity' },
              retry: 0,
              throwHttpErrors: false,
            })
            .json<{ id: string }>();
        const setStatus = async (id: string, status: string) => {
          const patched = await ky.patch(`${base}/api/backlog/${encodeURIComponent(id)}`, {
            json: { status },
            retry: 0,
            throwHttpErrors: false,
          });
          assert.equal(patched.status, 200);
        };

        const completed = await create('Completed row');
        await setStatus(completed.id, 'completed');
        const canceled = await create('Canceled row');
        await setStatus(canceled.id, 'canceled');
        const pending = await create('Pending row');

        const missing = 'backlog-does-not-exist';
        const res = await ky.post(`${base}/api/backlog/bulk`, {
          json: { ids: [completed.id, canceled.id, missing], action: 'delete' },
          retry: 0,
          throwHttpErrors: false,
        });
        assert.equal(res.status, 200);
        // Delete is allowed for settled rows, and deleted ids echo the request order.
        assert.deepEqual(await res.json(), {
          deleted: 2,
          ids: [completed.id, canceled.id],
          skipped: [missing],
        });

        const list = await ky
          .get(`${base}/api/backlog`, { retry: 0 })
          .json<Array<{ id: string }>>();
        assert.deepEqual(
          list.map((row) => row.id),
          [pending.id]
        );

        const gone = await ky.get(`${base}/api/backlog/${encodeURIComponent(completed.id)}`, {
          retry: 0,
          throwHttpErrors: false,
        });
        assert.equal(gone.status, 404);
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('keeps a dispatched row on bulk delete because it is bound to a live run', async () => {
      const { dir, cleanup } = makeTempDir('web_backlog_bulk_delete_dispatched_');
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
            json: { title: 'In flight row', prompt: 'P', repositoryId: 'agylity' },
            retry: 0,
            throwHttpErrors: false,
          })
          .json<{ id: string }>();
        const url = `${base}/api/backlog/${encodeURIComponent(created.id)}`;
        const patched = await ky.patch(url, {
          json: { status: 'dispatched' },
          retry: 0,
          throwHttpErrors: false,
        });
        assert.equal(patched.status, 200);

        const res = await ky.post(`${base}/api/backlog/bulk`, {
          json: { ids: [created.id], action: 'delete' },
          retry: 0,
          throwHttpErrors: false,
        });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { deleted: 0, ids: [], skipped: [created.id] });

        const after = await ky.get(url, { retry: 0 }).json<{ status: string }>();
        assert.equal(after.status, 'dispatched');
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('rejects an unknown bulk action with 400 and still accepts PATCH pause', async () => {
      const { dir, cleanup } = makeTempDir('web_backlog_bulk_unknown_action_');
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
            json: { title: 'Pausable row', prompt: 'P', repositoryId: 'agylity' },
            retry: 0,
            throwHttpErrors: false,
          })
          .json<{ id: string }>();

        const rejected = await ky.post(`${base}/api/backlog/bulk`, {
          json: { ids: [created.id], action: 'purge' },
          retry: 0,
          throwHttpErrors: false,
        });
        assert.equal(rejected.status, 400);
        assert.deepEqual(await rejected.json(), {
          error: "action must be 'pause', 'resume' or 'delete'",
        });

        const paused = await ky.patch(`${base}/api/backlog/bulk`, {
          json: { ids: [created.id], action: 'pause' },
          retry: 0,
          throwHttpErrors: false,
        });
        assert.equal(paused.status, 200);
        assert.equal((await paused.json<{ updated: number }>()).updated, 1);
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

    const healthyFlashState = (store: ConfigStore): SentryStateManager => {
      const state = new SentryStateManager({ db: store.getDatabase() });
      state.setState({
        version: 1,
        lastProbeAt: new Date().toISOString(),
        lastProbeSource: 'connect_rpc',
        pools: {
          gemini: {
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

        const { tasks } = await ky.get(`${baseUrl}/api/tasks`).json<{ tasks: any[] }>();
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
        sentryState: healthyFlashState(store),
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

    it('persists the status report fields a runner returns', async () => {
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
            numTurns: 4,
            totalTokens: 1670,
            thinkingTokens: 120,
          },
        });

        const { tasks } = await ky.get(`${baseUrl}/api/tasks`).json<{ tasks: any[] }>();
        const task = tasks.find((t) => t.id === disp.taskId);
        assert.equal(task?.prUrl, 'https://github.com/OtterBoops/agylity/pull/99');
        assert.equal(task?.numTurns, 4);
        assert.equal(task?.totalTokens, 1670);
        assert.equal(task?.thinkingTokens, 120);
      } finally {
        await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('persists a settled title, issue URLs, and a cleared branch name', async () => {
      const { dir, cleanup } = makeTempDir('web_status_deliverable_');
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
              prompt: 'Report findings as issues',
              allowOverage: true,
            },
          })
          .json<any>();

        // The claim is the coordinator's, so the runner's later reports are the ones under test.
        await ky.post(`${baseUrl}/api/tasks/poll`, {
          headers: authHeaders,
          json: { runnerId: 'runner-a', timeoutMs: 0 },
        });

        const executing = await ky
          .post(`${baseUrl}/api/tasks/${disp.taskId}/status`, {
            headers: authHeaders,
            json: {
              status: 'executing',
              runnerId: 'runner-a',
              branchName: 'agy/abc12345-report-findings',
            },
          })
          .json<any>();
        assert.equal(executing.task.branchName, 'agy/abc12345-report-findings');

        const issueUrls = ['https://github.com/OtterBoops/agylity/issues/21'];
        const reported = await ky
          .post(`${baseUrl}/api/tasks/${disp.taskId}/status`, {
            headers: authHeaders,
            json: {
              status: 'completed',
              runnerId: 'runner-a',
              branchName: null,
              title: 'Parser drops the trailing token',
              issueUrls,
            },
          })
          .json<any>();

        assert.equal(reported.success, true);
        assert.equal(reported.task.title, 'Parser drops the trailing token');
        assert.deepEqual(reported.task.issueUrls, issueUrls);
        // A discarded branch is cleared, not merely left at whatever the executing report said.
        assert.equal(reported.task.branchName, undefined);

        const { tasks } = await ky.get(`${baseUrl}/api/tasks`).json<{ tasks: any[] }>();
        const task = tasks.find((t) => t.id === disp.taskId);
        assert.equal(task?.title, 'Parser drops the trailing token');
        assert.deepEqual(task?.issueUrls, issueUrls);
        assert.equal(task?.branchName, undefined);
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

    const healthySentryState = (store: ConfigStore, resetTime: string): SentryStateManager => {
      const state = new SentryStateManager({ db: store.getDatabase() });
      state.setState({
        version: 1,
        lastProbeAt: new Date().toISOString(),
        lastProbeSource: 'connect_rpc',
        pools: {
          gemini: {
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
        sentryState: healthySentryState(store, resetTime),
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
              cascade: [{ model: 'gemini-3.8-flash', effort: 'medium' }],
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
        const afterBlock = await ky.get(`${base}/api/tasks`).json<{ tasks: any[] }>();
        assert.equal(afterBlock.tasks.length, 1);

        // With the floor back under the pool's headroom the same retry succeeds.
        store.set('minDispatchHeadroomPercent', 10);
        const retried = await ky
          .post(`${base}/api/tasks/${disp.taskId}/retry`, { retry: 0 })
          .json<any>();
        assert.equal(retried.success, true);
        assert.ok(retried.taskId);
        assert.notEqual(retried.taskId, disp.taskId);

        const afterRetry = await ky.get(`${base}/api/tasks`).json<{ tasks: any[] }>();
        assert.equal(afterRetry.tasks.length, 2);
        assert.equal(afterRetry.tasks.find((t) => t.id === retried.taskId)?.status, 'queued');
      } finally {
        await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('GET /api/tasks searches title and repository, keeps % literal and reports a full total', async () => {
      const { dir, cleanup } = makeTempDir('web_task_search_');
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
          {
            id: 'nebula',
            name: 'Nebula',
            path: dir,
            cloneUrl: 'https://example.invalid/nebula.git',
            defaultBranch: 'main',
          },
        ],
      });
      const { server, port } = await startWebServer({
        configStore: store,
        sentryState: healthySentryState(store, resetTime),
        host: '127.0.0.1',
        port: 0,
      });

      try {
        const base = `http://127.0.0.1:${port}`;
        const dispatch = (repositoryId: string, title: string, prompt: string) =>
          ky
            .post(`${base}/api/dispatch`, {
              json: {
                repositoryId,
                title,
                prompt,
                cascade: [{ model: 'gemini-3.8-flash', effort: 'medium' }],
              },
              retry: 0,
            })
            .json<any>();

        const quarterly = await dispatch('agylity', 'Quarterly migration', 'move the schema');
        const chart = await dispatch('nebula', 'Chart cleanup', 'quarterly prompt-only term');
        const percent = await dispatch('agylity', 'Latency 99% fixup', 'investigate p99');
        for (const disp of [quarterly, chart, percent]) assert.equal(disp.success, true);

        const list = (query: string) =>
          ky.get(`${base}/api/tasks${query}`, { retry: 0 }).json<{
            tasks: any[];
            total: number;
            offset: number;
            limit: number;
          }>();

        // The unfiltered page reports the match set, not the page length.
        const all = await list('?limit=2');
        assert.equal(all.tasks.length, 2);
        assert.equal(all.total, 3);
        assert.equal(all.limit, 2);
        assert.equal(all.offset, 0);

        const paged = await list('?limit=2&offset=2');
        assert.equal(paged.tasks.length, 1);
        assert.equal(paged.total, 3);
        assert.equal(paged.offset, 2);

        // A title hit. The `chart` row carries "quarterly" only in its prompt and must not appear.
        const byTitle = await list('?q=quarterly');
        assert.deepEqual(
          byTitle.tasks.map((t) => t.title),
          ['Quarterly migration']
        );
        assert.equal(byTitle.total, 1);

        // A repository-name hit, matched case-insensitively.
        const byRepo = await list('?q=NEBULA');
        assert.deepEqual(
          byRepo.tasks.map((t) => t.title),
          ['Chart cleanup']
        );
        assert.equal(byRepo.total, 1);

        // A prompt-only term finds nothing.
        assert.equal((await list('?q=prompt-only')).total, 0);

        // `%` is literal: it matches only the row whose title contains one, never everything.
        const byPercent = await list('?q=%25');
        assert.deepEqual(
          byPercent.tasks.map((t) => t.title),
          ['Latency 99% fixup']
        );
        assert.equal(byPercent.total, 1);

        // taskNumber names exactly one row.
        const row = all.tasks.find((t) => t.id === percent.taskId) ?? byPercent.tasks[0];
        const byNumber = await list(`?taskNumber=${row.taskNumber}`);
        assert.equal(byNumber.total, 1);
        assert.deepEqual(
          byNumber.tasks.map((t) => t.id),
          [percent.taskId]
        );

        // An unknown status is a caller error, not a filter that silently matches nothing.
        const badStatus = await ky.get(`${base}/api/tasks?status=bogus`, {
          retry: 0,
          throwHttpErrors: false,
        });
        assert.equal(badStatus.status, 400);
        assert.ok((await badStatus.json<{ error?: string }>()).error);

        // The list is live state and must never be cached.
        const listRes = await ky.get(`${base}/api/tasks`, { retry: 0 });
        assert.equal(listRes.headers.get('cache-control'), 'no-store');
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
        sentryState: healthySentryState(store, resetTime),
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
              cascade: [{ model: 'gemini-3.8-flash', effort: 'medium' }],
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
        sentryState: healthySentryState(store, resetTime),
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
              cascade: [{ model: 'gemini-3.8-flash', effort: 'medium' }],
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
        // The manual trigger burns the pool cycle so the coordinator cannot re-run it this cycle.
        assert.deepEqual(Object.values(row.lastTriggeredCycles ?? {}), [resetTime]);
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
              cascade: [{ model: 'gemini-3.8-flash', effort: 'medium' }],
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
          // A cascade patch is validated hop by hop, never silently coerced.
          { cascade: [] },
          { cascade: 'gemini-4-hydrogen' },
          { cascade: [{}] },
          { cascade: [{ model: 'gemini-9-turbo', effort: 'low' }] },
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
            json: {
              title: 'Renamed routine',
              triggerBeforeResetHours: 6,
              minHeadroomPercent: 25,
              cascade: [
                { model: 'gemini-4-hydrogen', effort: 'low' },
                { model: 'claude-sonnet-5-5', effort: 'high' },
              ],
            },
            retry: 0,
          })
          .json<any>();
        assert.equal(updated.title, 'Renamed routine');
        assert.equal(updated.triggerBeforeResetHours, 6);
        assert.equal(updated.minHeadroomPercent, 25);
        assert.deepEqual(updated.cascade, [
          { model: 'gemini-4-hydrogen', effort: 'low' },
          { model: 'claude-sonnet-5-5', effort: 'high' },
        ]);

        const reread = await ky.get(url).json<any>();
        assert.equal(reread.title, 'Renamed routine');
        assert.equal(reread.prompt, 'Original prompt');
        // The cascade is echoed back on read, hop order and effort intact.
        assert.deepEqual(reread.cascade, [
          { model: 'gemini-4-hydrogen', effort: 'low' },
          { model: 'claude-sonnet-5-5', effort: 'high' },
        ]);
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
              cascade: [{ model: 'gemini-3.8-flash', effort: 'medium' }],
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
          // A cascade patch is validated hop by hop, never silently coerced.
          { cascade: [] },
          { cascade: 'gemini-4-hydrogen' },
          { cascade: [{}] },
          { cascade: [{ model: 'gemini-9-turbo', effort: 'low' }] },
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
        assert.deepEqual(untouched.cascade, [{ model: 'gemini-3.8-flash', effort: 'medium' }]);

        const updated = await ky
          .patch(url, {
            json: {
              title: 'Renamed backlog row',
              prompt: 'Rewritten prompt',
              cascade: [{ model: 'gemini-4-hydrogen', effort: 'low' }],
            },
            retry: 0,
          })
          .json<any>();
        assert.equal(updated.title, 'Renamed backlog row');
        assert.equal(updated.prompt, 'Rewritten prompt');
        assert.deepEqual(updated.cascade, [{ model: 'gemini-4-hydrogen', effort: 'low' }]);
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
            cascade: [{ model: 'gemini-3.8-flash', effort: 'medium' }],
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
        // The posted cascade is echoed back as hops, effort included.
        assert.deepEqual(created.cascade, [{ model: 'gemini-3.8-flash', effort: 'medium' }]);

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
        assert.deepEqual(listed.cascade, [{ model: 'gemini-3.8-flash', effort: 'medium' }]);

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
              cascade: [{ model: 'gemini-3.8-flash', effort: 'medium' }],
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
              cascade: [{ model: 'gemini-3.8-flash', effort: 'medium' }],
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
  /* ==================================================================== */
  /* 12. Alert History Ledger & Dispatch Eligibility Preview              */
  /* ==================================================================== */
  describe('12. Alert History & Dispatch Eligibility Preview', () => {
    const runnerToken = 'swarm-secret-token-999';

    const poolState = (remainingFraction: number, resetTime: string) => ({
      version: 1 as const,
      lastProbeAt: new Date().toISOString(),
      lastProbeSource: 'connect_rpc' as const,
      pools: {
        gemini: {
          resetTime,
          remainingFraction,
          firedMilestones: [],
          lastAlertSentAt: null,
        },
      },
    });

    it('GET /api/alerts/events paginates the ledger newest-first with a keyset cursor', async () => {
      const { dir, cleanup } = makeTempDir('web_alert_events_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {});
      const sentryState = new SentryStateManager({ db: store.getDatabase() });
      const resetTime = new Date(Date.now() + 6 * 3600 * 1000).toISOString();

      let server: http.Server | undefined;
      try {
        for (let i = 0; i < 3; i++) {
          sentryState.recordDeliveredAlert({
            poolId: i === 1 ? 'claude' : 'gemini',
            resetTime,
            milestoneHours: 12 - i,
            headroomPercent: 40 + i,
            channels: { console: { success: true } },
            firedAt: `2026-11-20T1${i}:00:00.000Z`,
          });
        }

        const started = await startWebServer({
          configStore: store,
          sentryState,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;
        const baseUrl = `http://127.0.0.1:${started.port}`;

        const firstPage = await ky.get(`${baseUrl}/api/alerts/events?limit=2`).json<any>();
        assert.equal(firstPage.events.length, 2);
        assert.equal(firstPage.events[0].kind, 'milestone');
        assert.equal(firstPage.events[0].milestoneHours, 10);
        assert.equal(firstPage.events[0].poolId, 'gemini');
        assert.equal(firstPage.events[0].firedAt, '2026-11-20T12:00:00.000Z');
        assert.equal(firstPage.events[0].headroomPercent, 42);
        assert.equal(firstPage.events[0].resetTime, resetTime);
        assert.deepEqual(firstPage.events[0].channels, { console: { success: true } });
        assert.equal(typeof firstPage.events[0].id, 'number');
        assert.ok(firstPage.nextBefore);

        const secondPage = await ky
          .get(
            `${baseUrl}/api/alerts/events?limit=2&before=${encodeURIComponent(firstPage.nextBefore)}`
          )
          .json<any>();
        assert.equal(secondPage.events.length, 1);
        assert.equal(secondPage.events[0].milestoneHours, 12);
        assert.equal(secondPage.nextBefore, null);

        // A pool filter narrows the ledger without disturbing the ordering.
        const filtered = await ky.get(`${baseUrl}/api/alerts/events?pool=claude`).json<any>();
        assert.deepEqual(
          filtered.events.map((event: any) => event.poolId),
          ['claude']
        );

        // The limit is clamped, not trusted.
        const clamped = await ky.get(`${baseUrl}/api/alerts/events?limit=9999`).json<any>();
        assert.equal(clamped.events.length, 3);
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('GET /api/dispatch/eligibility refuses while the coordinator is disabled', async () => {
      const { dir, cleanup } = makeTempDir('web_eligibility_coordinator_off_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        coordinatorEnabled: false,
        defaultDispatchModel: 'gemini-3.8-flash',
      });
      const sentryState = new SentryStateManager({ db: store.getDatabase() });
      sentryState.setState(poolState(0.95, new Date(Date.now() + 6 * 3600 * 1000).toISOString()));

      let server: http.Server | undefined;
      try {
        const started = await startWebServer({
          configStore: store,
          sentryState,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;
        // allowOverage clears the floor, so only the coordinator gate can refuse this.
        const verdict = await ky
          .get(`http://127.0.0.1:${started.port}/api/dispatch/eligibility?allowOverage=1`)
          .json<any>();
        assert.equal(verdict.accepts, false);
        assert.equal(verdict.code, 'COORDINATOR_DISABLED');
        assert.match(verdict.reason, /alerting-only mode/);
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('GET /api/dispatch/eligibility reports the safety-floor block and an online runner', async () => {
      const { dir, cleanup } = makeTempDir('web_eligibility_blocked_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        coordinatorEnabled: true,
        runnerSharedSecret: runnerToken,
        minDispatchHeadroomPercent: 10,
        defaultDispatchModel: 'gemini-4-hydrogen',
      });
      const sentryState = new SentryStateManager({ db: store.getDatabase() });
      const resetTime = new Date(Date.now() + 6 * 3600 * 1000).toISOString();
      sentryState.setState(poolState(0.05, resetTime));

      let server: http.Server | undefined;
      try {
        const started = await startWebServer({
          configStore: store,
          sentryState,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;
        const baseUrl = `http://127.0.0.1:${started.port}`;

        // A poll registers the runner as idle, which is what makes it "online".
        const pollRes = await ky.post(`${baseUrl}/api/tasks/poll`, {
          headers: { 'x-agylity-runner-token': runnerToken },
          json: { runnerId: 'runner-online-1', runnerName: 'Online Runner' },
        });
        assert.equal(pollRes.status, 200);

        const blocked = await ky.get(`${baseUrl}/api/dispatch/eligibility`).json<any>();
        assert.equal(blocked.accepts, false);
        assert.equal(blocked.code, 'OVERAGE_PROTECTION_TRIGGERED');
        assert.ok(blocked.reason);
        assert.equal(blocked.model, 'gemini-4-hydrogen');
        assert.equal(blocked.poolGroup, 'gemini');
        assert.equal(blocked.floorPercent, 10);
        assert.equal(blocked.allowOverage, false);
        assert.equal(blocked.willRunNow, true);
        assert.equal(blocked.runners.online, 1);
        assert.deepEqual(blocked.warnings, []);
        assert.equal(blocked.pool.poolId, 'gemini');
        assert.equal(blocked.pool.effectivePercent, 5);
        assert.equal(blocked.pool.limitingWindow, 'weekly');
        assert.equal(blocked.pool.resetTime, resetTime);
        // A state-derived snapshot synthesizes a weekly bucket and no short-term one.
        assert.equal(blocked.pool.weeklyPercent, 5);
        assert.equal(blocked.pool.shortTermPercent, null);
        assert.equal(blocked.telemetry.probeSource, 'connect_rpc');
        assert.equal(blocked.autonomy.quenched, false);
        assert.equal(blocked.autonomy.remainingMs, 0);
        assert.ok(blocked.evaluatedAt);

        // allowOverage is the documented override for the safety floor.
        const overridden = await ky
          .get(`${baseUrl}/api/dispatch/eligibility?allowOverage=1`)
          .json<any>();
        assert.equal(overridden.accepts, true);
        assert.equal(overridden.allowOverage, true);
        assert.equal(overridden.code, null);
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('GET /api/dispatch/eligibility keeps accepts=true when no runner is online', async () => {
      const { dir, cleanup } = makeTempDir('web_eligibility_no_runner_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        coordinatorEnabled: true,
        minDispatchHeadroomPercent: 10,
        defaultDispatchModel: 'gemini-3.8-flash',
      });
      const sentryState = new SentryStateManager({ db: store.getDatabase() });
      const resetTime = new Date(Date.now() + 6 * 3600 * 1000).toISOString();
      sentryState.setState(poolState(0.8, resetTime));

      let server: http.Server | undefined;
      try {
        const started = await startWebServer({
          configStore: store,
          sentryState,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;

        const preview = await ky
          .get(`http://127.0.0.1:${started.port}/api/dispatch/eligibility`)
          .json<any>();
        // Runner availability must never influence the gate: the task queues, it is still accepted.
        assert.equal(preview.accepts, true);
        assert.equal(preview.code, null);
        assert.equal(preview.willRunNow, false);
        assert.equal(preview.runners.online, 0);
        assert.deepEqual(preview.warnings, ['No runner online: the task will queue, not run.']);
        assert.equal(preview.pool.effectivePercent, 80);
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });
  });
});

describe('Web: Antigravity CLI version reporting', () => {
  const agyUpdaterStub = (version: string | null) => ({
    getVersion: async () => version,
    getCachedVersion: () => version,
    invalidate: () => {},
    update: async () => ({ before: version, after: version, updated: false }),
  });

  it('reports the cached agy version on /api/health', async () => {
    const { dir, cleanup } = makeTempDir('web_agy_version_');
    const store = new ConfigStore(path.join(dir, 'test.db'), {});
    let server: http.Server | undefined;

    try {
      const started = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
        agyUpdater: agyUpdaterStub('0.4.2'),
      });
      server = started.server;

      const health = await ky.get(`http://127.0.0.1:${started.port}/api/health`).json<any>();
      assert.equal(health.status, 'ok');
      assert.equal(health.agyVersion, '0.4.2');
    } finally {
      if (server) await closeWebServer(server);
      store.close();
      cleanup();
    }
  });

  it('answers /api/health with a null version when agy could not be probed', async () => {
    const { dir, cleanup } = makeTempDir('web_agy_version_unknown_');
    const store = new ConfigStore(path.join(dir, 'test.db'), {});
    let server: http.Server | undefined;

    try {
      const started = await startWebServer({
        configStore: store,
        host: '127.0.0.1',
        port: 0,
        agyUpdater: agyUpdaterStub(null),
      });
      server = started.server;

      const health = await ky.get(`http://127.0.0.1:${started.port}/api/health`).json<any>();
      assert.equal(health.status, 'ok');
      assert.equal(health.agyVersion, null);
    } finally {
      if (server) await closeWebServer(server);
      store.close();
      cleanup();
    }
  });

  it('serves flat pool-group percentages and agyVersion on GET /api/summary', async () => {
    const { dir, cleanup } = makeTempDir('web_summary_');
    const store = new ConfigStore(path.join(dir, 'test.db'), {});
    const state = new SentryStateManager(path.join(dir, 'state.json'));
    const resetTime = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    // Gemini's former hydrogen/argon pools now report as one merged pool group.
    state.updatePoolQuota('gemini', 0.874, resetTime);
    state.updatePoolQuota('claude', 0.25, resetTime);
    let server: http.Server | undefined;

    try {
      const started = await startWebServer({
        configStore: store,
        sentryState: state,
        host: '127.0.0.1',
        port: 0,
        agyUpdater: agyUpdaterStub('1.5.11'),
      });
      server = started.server;

      const summary = await ky.get(`http://127.0.0.1:${started.port}/api/summary`).json<any>();
      assert.deepEqual(summary, {
        geminiPercent: 87,
        claudePercent: 25,
        agyVersion: '1.5.11',
      });
    } finally {
      if (server) await closeWebServer(server);
      store.close();
      cleanup();
    }
  });

  describe('GitHub Backlog Sync (#14)', () => {
    const createMockResponse = (): {
      res: http.ServerResponse;
      getBody: () => any;
      getStatus: () => number;
    } => {
      let status = 200;
      let raw = '';
      const res = {
        writeHead(code: number) {
          status = code;
          return res;
        },
        setHeader() {},
        end(chunk?: string | Buffer) {
          if (chunk) raw += chunk.toString();
        },
      } as unknown as http.ServerResponse;
      return {
        res,
        getStatus: () => status,
        getBody: () => (raw ? JSON.parse(raw) : undefined),
      };
    };

    it('resolves repoSlug from cloneUrl, id, name, or local git origin remote', async () => {
      assert.equal(
        await resolveGithubRepoSlug({
          id: 'agylity',
          name: 'agylity',
          path: '/repos/agylity',
          cloneUrl: 'https://github.com/OtterBoops/agylity.git',
        }),
        'OtterBoops/agylity'
      );

      assert.equal(
        await resolveGithubRepoSlug({
          id: 'agylity',
          name: 'agylity',
          path: '/repos/agylity',
          cloneUrl: 'git@github.com:OtterBoops/agylity.git',
        }),
        'OtterBoops/agylity'
      );

      assert.equal(
        await resolveGithubRepoSlug({
          id: 'OtterBoops/agylity',
          name: 'agylity',
          path: '/repos/agylity',
        }),
        'OtterBoops/agylity'
      );

      assert.equal(
        await resolveGithubRepoSlug({
          id: 'agylity',
          name: 'OtterBoops/agylity',
          path: '/repos/agylity',
        }),
        'OtterBoops/agylity'
      );

      const fromGitOrigin = await resolveGithubRepoSlug(
        {
          id: 'agylity',
          name: 'agylity',
          path: '/repos/agylity',
        },
        async () => ({ stdout: 'https://github.com/OtterBoops/agylity.git\n', stderr: '' })
      );
      assert.equal(fromGitOrigin, 'OtterBoops/agylity');

      const unresolvable = await resolveGithubRepoSlug(
        {
          id: 'agylity',
          name: 'agylity',
          path: '/repos/agylity',
        },
        async () => {
          throw new Error('not a git repo');
        }
      );
      assert.equal(unresolvable, undefined);
    });

    it('reports unresolvable repos in failedRepos via POST /api/backlog/sync-github', async () => {
      const { dir, cleanup } = makeTempDir('web_backlog_sync_unresolvable_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        coordinatorEnabled: true,
        repositories: [
          {
            id: 'local-only',
            name: 'local-only',
            path: path.join(dir, 'missing'),
            defaultBranch: 'main',
          },
        ],
      });
      let server: http.Server | undefined;

      try {
        const started = await startWebServer({
          configStore: store,
          host: '127.0.0.1',
          port: 0,
        });
        server = started.server;

        const body = await ky
          .post(`http://127.0.0.1:${started.port}/api/backlog/sync-github`, { retry: 0 })
          .json<any>();

        assert.equal(body.success, false);
        assert.equal(body.importedCount, 0);
        assert.deepEqual(body.failedRepos, ['local-only']);
        assert.equal(body.failures.length, 1);
        assert.equal(body.failures[0].repositoryId, 'local-only');
        assert.match(body.failures[0].reason, /cannot resolve GitHub owner\/repo/);
      } finally {
        if (server) await closeWebServer(server);
        store.close();
        cleanup();
      }
    });

    it('imports issues via repo.name / git origin and re-imports previously canceled issues', async () => {
      const { dir, cleanup } = makeTempDir('web_backlog_sync_canceled_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        coordinatorEnabled: true,
        githubBacklogLabel: 'backlog',
        repositories: [
          {
            id: 'repo-by-name',
            name: 'OtterBoops/repo-one',
            path: path.join(dir, 'one'),
            defaultBranch: 'main',
          },
          {
            id: 'repo-by-git',
            name: 'repo-two',
            path: path.join(dir, 'two'),
            defaultBranch: 'main',
          },
        ],
      });
      const coordinator = new Coordinator({ configStore: store });

      try {
        // Canceled row for issue #10 should NOT block re-importing #10.
        const canceledRow = coordinator.queue.createBacklogTask({
          title: '[GH #10] Previously canceled',
          prompt: 'Old prompt',
          repositoryId: 'repo-by-name',
          githubIssueNumber: 10,
        });
        coordinator.queue.updateBacklogTask(canceledRow.id, { status: 'canceled' });

        // Active pending row for issue #11 SHOULD block duplicate import.
        coordinator.queue.createBacklogTask({
          title: '[GH #11] Still pending',
          prompt: 'Active prompt',
          repositoryId: 'repo-by-name',
          githubIssueNumber: 11,
        });

        const requestedSlugs: string[] = [];
        const mockRes = createMockResponse();
        await handleSyncGithubBacklog(
          {} as http.IncomingMessage,
          mockRes.res,
          { configStore: store, coordinator },
          'POST',
          {
            execFileAsync: async () => ({
              stdout: 'git@github.com:OtterBoops/repo-two.git\n',
              stderr: '',
            }),
            listOpenIssues: async (slug) => {
              requestedSlugs.push(slug);
              if (slug === 'OtterBoops/repo-one') {
                return {
                  ok: true,
                  truncated: false,
                  issues: [
                    { number: 10, title: 'Reopened issue', body: 'Should re-import' },
                    { number: 11, title: 'Already active', body: 'Should skip' },
                  ],
                };
              }
              return {
                ok: true,
                truncated: false,
                issues: [{ number: 20, title: 'From git origin', body: 'Origin body' }],
              };
            },
          }
        );

        assert.equal(mockRes.getStatus(), 200);
        assert.deepEqual(requestedSlugs, ['OtterBoops/repo-one', 'OtterBoops/repo-two']);
        assert.deepEqual(mockRes.getBody(), {
          success: true,
          importedCount: 2,
          canceledCount: 0,
          label: 'backlog',
          failedRepos: [],
          failures: [],
        });

        const tasks = coordinator.queue.listBacklogTasks();
        const reimported = tasks.filter(
          (t) =>
            t.repositoryId === 'repo-by-name' &&
            t.githubIssueNumber === 10 &&
            t.status === 'pending'
        );
        assert.equal(reimported.length, 1);
        assert.equal(reimported[0]?.title, '[GH #10] Reopened issue');

        const activeDuplicates = tasks.filter(
          (t) => t.repositoryId === 'repo-by-name' && t.githubIssueNumber === 11
        );
        assert.equal(activeDuplicates.length, 1);

        const fromOrigin = tasks.filter(
          (t) => t.repositoryId === 'repo-by-git' && t.githubIssueNumber === 20
        );
        assert.equal(fromOrigin.length, 1);
      } finally {
        store.close();
        cleanup();
      }
    });

    it('POST /api/backlog/sync-github passes the coordinator config token to the issue listing', async () => {
      const { dir, cleanup } = makeTempDir('web_backlog_sync_config_token_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        repositories: [
          {
            id: 'OtterBoops/agylity',
            name: 'OtterBoops/agylity',
            path: path.join(dir, 'agylity'),
            defaultBranch: 'main',
          },
        ],
      });
      store.setOverride('githubToken', 'ghp_coordinator_token');
      const coordinator = new Coordinator({ configStore: store });
      const savedEnvToken = process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_TOKEN;

      try {
        const receivedTokens: Array<string | undefined> = [];
        const mockRes = createMockResponse();
        await handleSyncGithubBacklog(
          {} as http.IncomingMessage,
          mockRes.res,
          { configStore: store, coordinator },
          'POST',
          {
            listOpenIssues: async (_slug, _label, ghToken) => {
              receivedTokens.push(ghToken);
              return { ok: true, truncated: false, issues: [] };
            },
          }
        );

        assert.equal(mockRes.getStatus(), 200);
        assert.deepEqual(receivedTokens, ['ghp_coordinator_token']);
      } finally {
        if (savedEnvToken === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = savedEnvToken;
        store.close();
        cleanup();
      }
    });

    it('cancels only active rows when an issue leaves the open listing', async () => {
      const { dir, cleanup } = makeTempDir('web_backlog_sync_closed_issue_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        coordinatorEnabled: true,
        githubBacklogLabel: 'backlog',
        repositories: [
          {
            id: 'OtterBoops/repo-closed',
            name: 'repo-closed',
            path: path.join(dir, 'closed'),
            defaultBranch: 'main',
          },
        ],
      });
      const coordinator = new Coordinator({ configStore: store });

      try {
        const create = (title: string, githubIssueNumber: number) =>
          coordinator.queue.createBacklogTask({
            title,
            prompt: 'P',
            repositoryId: 'OtterBoops/repo-closed',
            githubIssueNumber,
          });

        const completedRow = create('[GH #10] Completed', 10);
        coordinator.queue.updateBacklogTask(completedRow.id, {
          status: 'completed',
          lastError: 'settled attempt output',
        });
        const canceledRow = create('[GH #11] Canceled', 11);
        coordinator.queue.updateBacklogTask(canceledRow.id, { status: 'canceled' });
        const pendingRow = create('[GH #12] Pending', 12);

        const mockRes = createMockResponse();
        await handleSyncGithubBacklog(
          {} as http.IncomingMessage,
          mockRes.res,
          { configStore: store, coordinator },
          'POST',
          {
            listOpenIssues: async () => ({ ok: true, truncated: false, issues: [] }),
          }
        );

        assert.equal(mockRes.getStatus(), 200);
        // Finished rows are history, so only the live pending row is canceled.
        assert.equal(mockRes.getBody().canceledCount, 1);

        const completedAfter = coordinator.queue.getBacklogTask(completedRow.id);
        assert.equal(completedAfter?.status, 'completed');
        assert.equal(completedAfter?.lastError, 'settled attempt output');
        assert.equal(coordinator.queue.getBacklogTask(canceledRow.id)?.status, 'canceled');

        const pendingAfter = coordinator.queue.getBacklogTask(pendingRow.id);
        assert.equal(pendingAfter?.status, 'canceled');
        assert.equal(pendingAfter?.lastError, undefined);
      } finally {
        store.close();
        cleanup();
      }
    });

    const makeLoggerStub = () => {
      const warns: unknown[][] = [];
      const logger = {
        namespace: undefined,
        debug: () => {},
        info: () => {},
        warn: (...args: unknown[]) => {
          warns.push(args);
        },
        error: () => {},
        child: () => logger,
        setLevel: () => {},
        getLevel: () => 'info',
        addSink: () => () => {},
        removeSink: () => {},
        clearSinks: () => {},
        setSinks: () => {},
      } as unknown as Logger;
      return { logger, warns };
    };

    it('uses the authenticated GitHub REST API when a token is supplied', async () => {
      const originalFetch = globalThis.fetch;
      let capturedAuth: string | null = null;
      let ghCliCalls = 0;
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        capturedAuth = req.headers.get('authorization');
        return new Response(
          JSON.stringify([
            {
              number: 42,
              title: 'Real issue',
              body: 'body',
              html_url: 'https://github.com/OtterBoops/agylity/issues/42',
            },
            {
              number: 43,
              title: 'Pull request item',
              pull_request: { url: 'https://api.github.com/repos/OtterBoops/agylity/pulls/43' },
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }) as typeof fetch;

      try {
        const result = await listOpenIssues(
          'OtterBoops/agylity',
          'backlog',
          'ghp_test',
          undefined,
          async () => {
            ghCliCalls++;
            throw new Error('gh should not run when the REST call succeeds');
          }
        );

        assert.equal(capturedAuth, 'Bearer ghp_test');
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(result.truncated, false);
        assert.deepEqual(
          result.issues.map((issue) => issue.number),
          [42]
        );
        assert.equal(ghCliCalls, 0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('falls back to the gh CLI when the authenticated REST call fails', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ message: 'Bad credentials' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch;

      let ghArgs: readonly string[] = [];
      try {
        const result = await listOpenIssues(
          'OtterBoops/agylity',
          'backlog',
          'ghp_expired',
          undefined,
          async (cmd: string, args: readonly string[]) => {
            assert.equal(cmd, 'gh');
            ghArgs = args;
            return {
              stdout: JSON.stringify([{ number: 7, title: 'From CLI', body: 'body', url: 'u' }]),
              stderr: '',
            };
          }
        );

        assert.deepEqual(ghArgs.slice(0, 4), ['issue', 'list', '--repo', 'OtterBoops/agylity']);
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.deepEqual(
          result.issues.map((issue) => issue.number),
          [7]
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('reports a reason when no GitHub token is configured and the gh CLI is unavailable', async () => {
      const originalFetch = globalThis.fetch;
      let restCalls = 0;
      globalThis.fetch = (async () => {
        restCalls++;
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;
      const { logger, warns } = makeLoggerStub();

      try {
        const result = await listOpenIssues(
          'OtterBoops/agylity',
          'backlog',
          undefined,
          logger,
          async () => {
            throw new Error('spawn gh ENOENT');
          }
        );

        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.match(result.reason, /no GitHub token is configured on the coordinator/);
        assert.match(result.reason, /spawn gh ENOENT/);
        assert.equal(restCalls, 0, 'must not call GitHub REST without a token');
        assert.equal(warns.length, 1, 'the failure must be logged at warn level');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('reports both REST and gh CLI errors when both fail with a token', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ message: 'Bad credentials' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch;

      try {
        const result = await listOpenIssues(
          'OtterBoops/agylity',
          'backlog',
          'ghp_expired',
          undefined,
          async () => {
            throw new Error('gh: not authenticated');
          }
        );

        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.match(result.reason, /GitHub REST API failed/);
        assert.match(result.reason, /gh: not authenticated/);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('surfaces per-repo failure reasons from POST /api/backlog/sync-github', async () => {
      const { dir, cleanup } = makeTempDir('web_backlog_sync_failures_');
      const store = new ConfigStore(path.join(dir, 'test.db'), {
        coordinatorEnabled: true,
        githubBacklogLabel: 'backlog',
        repositories: [
          {
            id: 'OtterBoops/broken',
            name: 'OtterBoops/broken',
            path: path.join(dir, 'broken'),
            defaultBranch: 'main',
          },
          {
            id: 'local-only',
            name: 'local-only',
            path: path.join(dir, 'missing'),
            defaultBranch: 'main',
          },
        ],
      });
      const coordinator = new Coordinator({ configStore: store });
      const { logger, warns } = makeLoggerStub();

      try {
        const mockRes = createMockResponse();
        await handleSyncGithubBacklog(
          {} as http.IncomingMessage,
          mockRes.res,
          { configStore: store, coordinator, logger },
          'POST',
          {
            execFileAsync: async () => {
              throw new Error('not a git repo');
            },
            listOpenIssues: async () => ({
              ok: false,
              reason:
                'no GitHub token is configured on the coordinator and the gh CLI is unavailable (spawn gh ENOENT)',
            }),
          }
        );

        assert.equal(mockRes.getStatus(), 200);
        assert.deepEqual(mockRes.getBody(), {
          success: false,
          importedCount: 0,
          canceledCount: 0,
          label: 'backlog',
          failedRepos: ['OtterBoops/broken', 'local-only'],
          failures: [
            {
              repositoryId: 'OtterBoops/broken',
              reason:
                'no GitHub token is configured on the coordinator and the gh CLI is unavailable (spawn gh ENOENT)',
            },
            {
              repositoryId: 'local-only',
              reason:
                'cannot resolve GitHub owner/repo from repository name, clone URL, or git origin remote',
            },
          ],
        });
        assert.ok(warns.length >= 1, 'slug resolution failures must be logged at warn level');
      } finally {
        store.close();
        cleanup();
      }
    });
  });
});

describe('Web: build channel reporting', () => {
  const withBuildEnv = async (
    channel: string | undefined,
    commit: string | undefined,
    fn: (port: number) => Promise<void>
  ): Promise<void> => {
    const { dir, cleanup } = makeTempDir('web_build_channel_');
    const store = new ConfigStore(path.join(dir, 'test.db'), {});
    const previous = { channel: process.env.BUILD_CHANNEL, commit: process.env.BUILD_COMMIT };
    let server: http.Server | undefined;

    try {
      if (channel === undefined) delete process.env.BUILD_CHANNEL;
      else process.env.BUILD_CHANNEL = channel;
      if (commit === undefined) delete process.env.BUILD_COMMIT;
      else process.env.BUILD_COMMIT = commit;

      const started = await startWebServer({ configStore: store, host: '127.0.0.1', port: 0 });
      server = started.server;
      await fn(started.port);
    } finally {
      if (server) await closeWebServer(server);
      if (previous.channel === undefined) delete process.env.BUILD_CHANNEL;
      else process.env.BUILD_CHANNEL = previous.channel;
      if (previous.commit === undefined) delete process.env.BUILD_COMMIT;
      else process.env.BUILD_COMMIT = previous.commit;
      store.close();
      cleanup();
    }
  };

  it('reports a main build channel with a seven-character commit on /api/health', async () => {
    await withBuildEnv('main', '32789fb995558b4a3f017182ed58bbef2c41ed06', async (port) => {
      const health = await ky.get(`http://127.0.0.1:${port}/api/health`).json<any>();
      assert.equal(health.status, 'ok');
      assert.equal(health.buildChannel, 'main');
      assert.equal(health.buildCommit, '32789fb');
    });
  });

  it('reports the release channel unchanged', async () => {
    await withBuildEnv('release', 'abc1234', async (port) => {
      const health = await ky.get(`http://127.0.0.1:${port}/api/health`).json<any>();
      assert.equal(health.buildChannel, 'release');
      assert.equal(health.buildCommit, 'abc1234');
    });
  });

  it('falls back to the dev channel and a null commit when the build args are absent', async () => {
    await withBuildEnv(undefined, undefined, async (port) => {
      const health = await ky.get(`http://127.0.0.1:${port}/api/health`).json<any>();
      assert.equal(health.buildChannel, 'dev');
      assert.equal(health.buildCommit, null);
    });
  });
});

describe('Shared: build channel helpers', () => {
  it('accepts only the three known channels and fails open to dev', () => {
    assert.equal(resolveBuildChannel('release'), 'release');
    assert.equal(resolveBuildChannel('MAIN'), 'main');
    assert.equal(resolveBuildChannel('dev'), 'dev');
    assert.equal(resolveBuildChannel('nightly'), 'dev');
    assert.equal(resolveBuildChannel(''), 'dev');
    assert.equal(resolveBuildChannel(undefined), 'dev');
  });

  it('normalises a commit to seven lowercase hex characters', () => {
    assert.equal(normalizeBuildCommit('32789FB995558B4A3F017182ED58BBEF2C41ED06'), '32789fb');
    assert.equal(normalizeBuildCommit('32789fb'), '32789fb');
    assert.equal(normalizeBuildCommit('32789f'), null);
    assert.equal(normalizeBuildCommit('not-a-sha'), null);
    assert.equal(normalizeBuildCommit(null), null);
  });

  it('labels a main build with its short SHA and every other channel with the version', () => {
    assert.equal(formatBuildLabel('main', '0.6.6', '32789fb'), 'main · 32789fb');
    assert.equal(formatBuildLabel('main', '0.6.6', null), 'v0.6.6');
    assert.equal(formatBuildLabel('release', '0.6.6', '32789fb'), 'v0.6.6');
    assert.equal(formatBuildLabel('dev', '0.6.6', '32789fb'), 'v0.6.6');
  });

  it('treats any different main commit as newer, never as an ordering', () => {
    assert.equal(isNewerMainCommit('32789fb', '9e1c0aa'), true);
    assert.equal(isNewerMainCommit('9e1c0aa', '32789fb'), true);
    assert.equal(isNewerMainCommit('32789fb', '32789fb'), false);
    assert.equal(isNewerMainCommit('32789fb', '32789fb0000000000'), false);
    assert.equal(isNewerMainCommit('32789fb', null), false);
    assert.equal(isNewerMainCommit(null, '9e1c0aa'), false);
  });
});
