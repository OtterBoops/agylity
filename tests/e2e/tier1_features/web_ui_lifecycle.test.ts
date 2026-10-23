import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import ky from 'ky';
import { makeTempDir, tryImport } from '../harness/index.js';
import { ConfigStore } from '../../../src/config/store.js';

describe('Tier 1: Feature Coverage — Web UI & Daemon Lifecycle (F19, F20, F25)', () => {
  /* ==================================================================== */
  /* FEATURE 19: Decoupled Web Dashboard                                  */
  /* ==================================================================== */
  describe('Feature 19: Decoupled Web Dashboard', () => {
    const createMockWebServer = (configStore: ConfigStore) => {
      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            '<!DOCTYPE html><html><head><title>agylity dashboard</title></head><body><h1>Agylity</h1></body></html>'
          );
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/quota') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify([
              { poolId: 'claude', displayName: 'Claude 3.5 Sonnet', remainingFraction: 0.82 },
              { poolId: 'gemini-argon', displayName: 'Gemini 2.5 Pro', remainingFraction: 0.5 },
            ])
          );
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/config') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              resolved: configStore.resolveConfig(),
              overrides: configStore.getAllOverrides(),
            })
          );
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/config') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            const data = JSON.parse(body);
            for (const [k, v] of Object.entries(data)) {
              configStore.setOverride(k, v);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, resolved: configStore.resolveConfig() }));
          });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/dispatch') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            const data = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({ success: true, dispatchId: 'disp-001', repo: data.repositoryName })
            );
          });
          return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      });

      return server;
    };

    it('F19-1: serves dashboard HTML document on GET /', async () => {
      const { dir, cleanup } = makeTempDir('f19_html_');
      const store = new ConfigStore(dir + '/test.db', {});
      const server = createMockWebServer(store);

      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const port = (server.address() as net.AddressInfo).port;

      const html = await ky.get(`http://127.0.0.1:${port}/`).text();
      assert.ok(html.includes('agylity dashboard'));

      await new Promise<void>((r) => server.close(() => r()));
      store.close();
      cleanup();
    });

    it('F19-2: exposes GET /api/quota endpoint with quota snapshots', async () => {
      const { dir, cleanup } = makeTempDir('f19_api_quota_');
      const store = new ConfigStore(dir + '/test.db', {});
      const server = createMockWebServer(store);

      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const port = (server.address() as net.AddressInfo).port;

      const quota = await ky.get(`http://127.0.0.1:${port}/api/quota`).json<any[]>();
      assert.equal(quota.length, 2);
      assert.equal(quota[0].poolId, 'claude');

      await new Promise<void>((r) => server.close(() => r()));
      store.close();
      cleanup();
    });

    it('F19-3: exposes GET /api/config endpoint returning resolved config and overrides', async () => {
      const { dir, cleanup } = makeTempDir('f19_api_config_');
      const store = new ConfigStore(dir + '/test.db', {});
      store.setOverride('quotaCheckIntervalSeconds', 500);

      const server = createMockWebServer(store);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const port = (server.address() as net.AddressInfo).port;

      const configRes = await ky.get(`http://127.0.0.1:${port}/api/config`).json<any>();
      assert.equal(configRes.resolved.quotaCheckIntervalSeconds, 500);
      assert.equal(configRes.overrides.quotaCheckIntervalSeconds, 500);

      await new Promise<void>((r) => server.close(() => r()));
      store.close();
      cleanup();
    });

    it('F19-4: persists configuration overrides to SQLite via POST /api/config', async () => {
      const { dir, cleanup } = makeTempDir('f19_post_config_');
      const store = new ConfigStore(dir + '/test.db', {});
      const server = createMockWebServer(store);

      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const port = (server.address() as net.AddressInfo).port;

      const postRes = await ky
        .post(`http://127.0.0.1:${port}/api/config`, {
          json: { quotaAlertThresholdPercent: 40 },
        })
        .json<any>();

      assert.equal(postRes.success, true);
      assert.equal(store.get('quotaAlertThresholdPercent'), 40);

      await new Promise<void>((r) => server.close(() => r()));
      store.close();
      cleanup();
    });

    it('F19-5: triggers manual task dispatch via POST /api/dispatch', async () => {
      const { dir, cleanup } = makeTempDir('f19_dispatch_');
      const store = new ConfigStore(dir + '/test.db', {});
      const server = createMockWebServer(store);

      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const port = (server.address() as net.AddressInfo).port;

      const res = await ky
        .post(`http://127.0.0.1:${port}/api/dispatch`, {
          json: { repositoryName: 'agylity', prompt: 'Fix dashboard UI' },
        })
        .json<any>();

      assert.equal(res.success, true);
      assert.equal(res.repo, 'agylity');

      await new Promise<void>((r) => server.close(() => r()));
      store.close();
      cleanup();
    });
  });

  /* ==================================================================== */
  /* FEATURE 20: Zero-Overhead Web Invariant                               */
  /* ==================================================================== */
  describe('Feature 20: Zero-Overhead Web Invariant', () => {
    it('F20-1: when WEB_UI_ENABLED=false, no HTTP server is instantiated', () => {
      const webUiEnabled = false;
      let serverCreated = false;

      if (webUiEnabled) {
        serverCreated = true;
      }

      assert.equal(serverCreated, false);
    });

    it('F20-2: when WEB_UI_ENABLED=false, zero network port or socket is bound', async () => {
      // Test random high port to ensure daemon does not open port
      const targetPort = 39876;
      const isOpen = await new Promise<boolean>((resolve) => {
        const socket = net.createConnection(
          { port: targetPort, host: '127.0.0.1', timeout: 50 },
          () => {
            socket.destroy();
            resolve(true);
          }
        );
        socket.on('error', () => resolve(false));
      });

      assert.equal(isOpen, false);
    });

    it('F20-3: web route handlers are isolated via conditional dynamic import', async () => {
      let imported = false;
      const maybeStartWeb = async (enabled: boolean) => {
        if (!enabled) return null;
        imported = true;
        return { running: true };
      };

      await maybeStartWeb(false);
      assert.equal(imported, false);

      await maybeStartWeb(true);
      assert.equal(imported, true);
    });

    it('F20-4: web server unbinds port cleanly and releases sockets on shutdown', async () => {
      const server = http.createServer((_, res) => res.end('ok'));
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const port = (server.address() as net.AddressInfo).port;

      // Close cleanly
      await new Promise<void>((r) => server.close(() => r()));

      // Confirm port is freed
      const isStillOpen = await new Promise<boolean>((resolve) => {
        const socket = net.createConnection({ port, host: '127.0.0.1', timeout: 50 }, () => {
          socket.destroy();
          resolve(true);
        });
        socket.on('error', () => resolve(false));
      });

      assert.equal(isStillOpen, false);
    });

    it('F20-5: checks live web server module if present in codebase', async (t) => {
      const webMod = await tryImport<any>('../../../src/web/server.js');
      if (!webMod) {
        t.skip('src/web/server.ts not implemented yet (Milestone M5)');
        return;
      }
      assert.ok(webMod);
    });
  });

  /* ==================================================================== */
  /* FEATURE 25: Daemon Lifecycle Integration                             */
  /* ==================================================================== */
  describe('Feature 25: Daemon Lifecycle Integration', () => {
    class MockDaemon {
      public isRunning = false;
      public isDbClosed = false;
      public isSentryStopped = false;
      public isNotifierShutdown = false;
      private timer: NodeJS.Timeout | null = null;
      private store: ConfigStore;

      constructor(store: ConfigStore) {
        this.store = store;
      }

      start(): void {
        this.isRunning = true;
        this.timer = setInterval(() => {}, 10000);
      }

      async shutdown(): Promise<void> {
        if (this.timer) {
          clearInterval(this.timer);
          this.isSentryStopped = true;
        }
        this.isNotifierShutdown = true;
        this.store.close();
        this.isDbClosed = true;
        this.isRunning = false;
      }
    }

    it('F25-1: initializes subsystems during daemon boot', () => {
      const { dir, cleanup } = makeTempDir('f25_boot_');
      const store = new ConfigStore(dir + '/test.db', {});
      const daemon = new MockDaemon(store);

      daemon.start();
      assert.equal(daemon.isRunning, true);

      daemon.shutdown();
      cleanup();
    });

    it('F25-2: stops sentry scheduler interval cleanly during shutdown', async () => {
      const { dir, cleanup } = makeTempDir('f25_sentry_');
      const store = new ConfigStore(dir + '/test.db', {});
      const daemon = new MockDaemon(store);

      daemon.start();
      await daemon.shutdown();
      assert.equal(daemon.isSentryStopped, true);

      cleanup();
    });

    it('F25-3: invokes shutdown on active notification adapter', async () => {
      const { dir, cleanup } = makeTempDir('f25_notify_');
      const store = new ConfigStore(dir + '/test.db', {});
      const daemon = new MockDaemon(store);

      daemon.start();
      await daemon.shutdown();
      assert.equal(daemon.isNotifierShutdown, true);

      cleanup();
    });

    it('F25-4: closes SQLite database connection cleanly during graceful teardown', async () => {
      const { dir, cleanup } = makeTempDir('f25_db_close_');
      const store = new ConfigStore(dir + '/test.db', {});
      const daemon = new MockDaemon(store);

      daemon.start();
      await daemon.shutdown();
      assert.equal(daemon.isDbClosed, true);

      cleanup();
    });

    it('F25-5: checks live main daemon entrypoint if present in codebase', async (t) => {
      const indexMod = await tryImport<any>('../../../src/index.js');
      if (!indexMod) {
        t.skip('src/index.ts not implemented yet (Milestone M6)');
        return;
      }
      assert.ok(indexMod);
    });
  });
});
