import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ConnectRpcQuotaClient, LanguageServerError, RPC_PATH } from '../../src/sentry/client.js';
import { QuotaEvaluator } from '../../src/sentry/evaluator.js';
import { SentryStateManager } from '../../src/sentry/state.js';
import { type LanguageServerResponse } from '../../src/sentry/models.js';

const createSampleResponse = (): LanguageServerResponse => {
  const in10Hours = new Date(Date.now() + 10 * 3600 * 1000).toISOString();
  return {
    clientModelConfigs: [
      {
        label: 'Claude Sonnet 5.5 (Medium)',
        modelId: 'claude-sonnet-5-5-medium',
        quotaInfo: {
          remainingFraction: 0.5,
          resetTime: in10Hours,
        },
      },
      {
        label: 'Gemini 4 Argon (Medium)',
        modelId: 'gemini-4-argon-medium',
        quotaInfo: {
          remainingFraction: 0.3,
          resetTime: in10Hours,
        },
      },
      {
        label: 'Gemini 3.8 Flash (Medium)',
        modelId: 'gemini-3.8-flash-medium',
        quotaInfo: {
          remainingFraction: 0.8,
          resetTime: in10Hours,
        },
      },
    ],
  };
};

describe('Challenger M2: Adversarial Stress Test Suite', () => {
  let unhandledRejections: any[] = [];
  let originalEnv: NodeJS.ProcessEnv;

  const rejectionHandler = (reason: any) => {
    unhandledRejections.push(reason);
  };

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Isolate tests from developer environment variables
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
      `Detected ${unhandledRejections.length} unhandled promise rejection(s): ${JSON.stringify(
        unhandledRejections.map((e) => (e instanceof Error ? e.stack || e.message : String(e)))
      )}`
    );
  });

  // =========================================================================
  // Suite 1: Network Timeouts, Abrupt Socket Drops, HTTP Errors & Truncation
  // =========================================================================
  describe('Suite 1: Connect-RPC Network Stress & Zero Unhandled Rejections', () => {
    it('handles network timeout without unhandled rejection (server socket hangs)', async () => {
      const hangingServer = createServer((_req, _res) => {
        // Intentionally do not send headers or body
      });

      await new Promise<void>((resolve) => hangingServer.listen(0, '127.0.0.1', () => resolve()));
      const port = (hangingServer.address() as any).port;

      try {
        const client = new ConnectRpcQuotaClient({
          port,
          fallbackPorts: [port],
          csrfToken: 'test-token',
          timeoutMs: 150,
          enableCliFallback: false,
          enableProcessDiscovery: false,
        });

        await assert.rejects(
          async () => {
            await client.fetchQuota();
          },
          (err: any) => {
            assert.ok(err instanceof LanguageServerError);
            assert.equal(err.code, 'LANGUAGE_SERVER_UNAVAILABLE');
            return true;
          }
        );
      } finally {
        await new Promise<void>((resolve) => hangingServer.close(() => resolve()));
      }
    });

    it('handles abrupt connection reset (socket.destroy) without unhandled rejection', async () => {
      const resetServer = createServer((_req, res) => {
        res.socket?.destroy();
      });

      await new Promise<void>((resolve) => resetServer.listen(0, '127.0.0.1', () => resolve()));
      const port = (resetServer.address() as any).port;

      try {
        const client = new ConnectRpcQuotaClient({
          port,
          fallbackPorts: [port],
          csrfToken: 'test-token',
          timeoutMs: 500,
          enableCliFallback: false,
          enableProcessDiscovery: false,
        });

        await assert.rejects(
          async () => {
            await client.fetchQuota();
          },
          (err: any) => {
            assert.ok(err instanceof LanguageServerError);
            assert.equal(err.code, 'LANGUAGE_SERVER_UNAVAILABLE');
            return true;
          }
        );
      } finally {
        await new Promise<void>((resolve) => resetServer.close(() => resolve()));
      }
    });

    it('handles HTTP 401 Unauthenticated without unhandled rejection', async () => {
      const authServer = createServer((_req, res) => {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ code: 'unauthenticated', message: 'Invalid CSRF token' }));
      });

      await new Promise<void>((resolve) => authServer.listen(0, '127.0.0.1', () => resolve()));
      const port = (authServer.address() as any).port;

      try {
        const client = new ConnectRpcQuotaClient({
          port,
          fallbackPorts: [port],
          csrfToken: 'wrong-token',
          timeoutMs: 500,
          enableCliFallback: false,
          enableProcessDiscovery: false,
        });

        await assert.rejects(
          async () => {
            await client.fetchQuota();
          },
          (err: any) => {
            assert.ok(err instanceof LanguageServerError);
            assert.equal(err.code, 'LANGUAGE_SERVER_UNAVAILABLE');
            return true;
          }
        );
      } finally {
        await new Promise<void>((resolve) => authServer.close(() => resolve()));
      }
    });

    it('handles HTTP 400 Invalid Argument without unhandled rejection', async () => {
      const badReqServer = createServer((_req, res) => {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({ code: 'invalid_argument', message: 'Unsupported client version' })
        );
      });

      await new Promise<void>((resolve) => badReqServer.listen(0, '127.0.0.1', () => resolve()));
      const port = (badReqServer.address() as any).port;

      try {
        const client = new ConnectRpcQuotaClient({
          port,
          fallbackPorts: [port],
          csrfToken: 'test-token',
          timeoutMs: 500,
          enableCliFallback: false,
          enableProcessDiscovery: false,
        });

        await assert.rejects(
          async () => {
            await client.fetchQuota();
          },
          (err: any) => {
            assert.ok(err instanceof LanguageServerError);
            assert.equal(err.code, 'LANGUAGE_SERVER_UNAVAILABLE');
            return true;
          }
        );
      } finally {
        await new Promise<void>((resolve) => badReqServer.close(() => resolve()));
      }
    });

    it('handles HTTP 500 Internal Server Error without unhandled rejection', async () => {
      const errServer = createServer((_req, res) => {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'internal failure' }));
      });

      await new Promise<void>((resolve) => errServer.listen(0, '127.0.0.1', () => resolve()));
      const port = (errServer.address() as any).port;

      try {
        const client = new ConnectRpcQuotaClient({
          port,
          fallbackPorts: [port],
          csrfToken: 'test-token',
          timeoutMs: 500,
          enableCliFallback: false,
          enableProcessDiscovery: false,
        });

        await assert.rejects(
          async () => {
            await client.fetchQuota();
          },
          (err: any) => {
            assert.ok(err instanceof LanguageServerError);
            assert.equal(err.code, 'LANGUAGE_SERVER_UNAVAILABLE');
            return true;
          }
        );
      } finally {
        await new Promise<void>((resolve) => errServer.close(() => resolve()));
      }
    });

    it('handles truncated JSON response stream without unhandled rejection', async () => {
      const truncServer = createServer((_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked',
        });
        res.write('{"clientModelConfigs": [{"label": "Claude Sonnet", "modelId": "claude');
        setTimeout(() => {
          res.socket?.destroy();
        }, 20);
      });

      await new Promise<void>((resolve) => truncServer.listen(0, '127.0.0.1', () => resolve()));
      const port = (truncServer.address() as any).port;

      try {
        const client = new ConnectRpcQuotaClient({
          port,
          fallbackPorts: [port],
          csrfToken: 'test-token',
          timeoutMs: 500,
          enableCliFallback: false,
          enableProcessDiscovery: false,
        });

        await assert.rejects(
          async () => {
            await client.fetchQuota();
          },
          (err: any) => {
            assert.ok(err instanceof LanguageServerError);
            assert.equal(err.code, 'LANGUAGE_SERVER_UNAVAILABLE');
            return true;
          }
        );
      } finally {
        await new Promise<void>((resolve) => truncServer.close(() => resolve()));
      }
    });

    it('handles malformed Protobuf JSON violating Zod schema without unhandled rejection', async () => {
      const malformedServer = createServer((_req, res) => {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ unexpectedData: 12345, status: 'UNKNOWN' }));
      });

      await new Promise<void>((resolve) => malformedServer.listen(0, '127.0.0.1', () => resolve()));
      const port = (malformedServer.address() as any).port;

      try {
        const client = new ConnectRpcQuotaClient({
          port,
          fallbackPorts: [port],
          csrfToken: 'test-token',
          timeoutMs: 500,
          enableCliFallback: false,
          enableProcessDiscovery: false,
        });

        await assert.rejects(
          async () => {
            await client.fetchQuota();
          },
          (err: any) => {
            assert.ok(err instanceof LanguageServerError);
            assert.equal(err.code, 'LANGUAGE_SERVER_UNAVAILABLE');
            return true;
          }
        );
      } finally {
        await new Promise<void>((resolve) => malformedServer.close(() => resolve()));
      }
    });

    it('handles 10 concurrent fetchQuota calls during total outage without unhandled rejections', async () => {
      const client = new ConnectRpcQuotaClient({
        port: 59998,
        fallbackPorts: [59998, 59997],
        csrfToken: 'test-token',
        timeoutMs: 200,
        enableCliFallback: false,
        enableProcessDiscovery: false,
      });

      const promises = Array.from({ length: 10 }, () => client.fetchQuota());
      const results = await Promise.allSettled(promises);

      for (const res of results) {
        assert.equal(res.status, 'rejected');
        assert.ok(res.reason instanceof LanguageServerError);
      }
    });
  });

  // =========================================================================
  // Suite 2: CLI Fallback Failure Modes
  // =========================================================================
  describe('Suite 2: CLI Fallback Failure Modes', () => {
    it('handles missing CLI executable (ENOENT)', async () => {
      const mockExecMissing = async () => {
        const err: any = new Error('spawn agy ENOENT');
        err.code = 'ENOENT';
        throw err;
      };

      const client = new ConnectRpcQuotaClient({
        port: 59999,
        fallbackPorts: [59999],
        enableCliFallback: true,
        enableProcessDiscovery: false,
        execFileFn: mockExecMissing as any,
      });

      await assert.rejects(
        async () => {
          await client.fetchQuota();
        },
        (err: any) => {
          assert.ok(err instanceof LanguageServerError);
          assert.equal(err.code, 'LANGUAGE_SERVER_UNAVAILABLE');
          return true;
        }
      );
    });

    it('handles CLI returning non-zero exit code with stderr output', async () => {
      const mockExecFail = async () => {
        const err: any = new Error(
          'Command failed: agy --output-format json models\nError: Daemon not running'
        );
        err.code = 1;
        err.stderr = 'Error: Daemon not running';
        throw err;
      };

      const client = new ConnectRpcQuotaClient({
        port: 59999,
        fallbackPorts: [59999],
        enableCliFallback: true,
        enableProcessDiscovery: false,
        execFileFn: mockExecFail as any,
      });

      await assert.rejects(
        async () => {
          await client.fetchQuota();
        },
        (err: any) => {
          assert.ok(err instanceof LanguageServerError);
          assert.equal(err.code, 'LANGUAGE_SERVER_UNAVAILABLE');
          return true;
        }
      );
    });

    it('handles CLI returning malformed non-JSON output', async () => {
      const mockExecCorrupt = async () => ({
        stdout: 'Fatal error: unable to allocate memory',
        stderr: '',
      });

      const client = new ConnectRpcQuotaClient({
        port: 59999,
        fallbackPorts: [59999],
        enableCliFallback: true,
        enableProcessDiscovery: false,
        execFileFn: mockExecCorrupt as any,
      });

      await assert.rejects(
        async () => {
          await client.fetchQuota();
        },
        (err: any) => {
          assert.ok(err instanceof LanguageServerError);
          assert.equal(err.code, 'LANGUAGE_SERVER_UNAVAILABLE');
          return true;
        }
      );
    });

    it('handles CLI returning empty JSON object or empty models array', async () => {
      const mockExecEmptyJson = async () => ({
        stdout: JSON.stringify({}),
        stderr: '',
      });

      const client = new ConnectRpcQuotaClient({
        port: 59999,
        fallbackPorts: [59999],
        enableCliFallback: true,
        enableProcessDiscovery: false,
        execFileFn: mockExecEmptyJson as any,
      });

      await assert.rejects(
        async () => {
          await client.fetchQuota();
        },
        (err: any) => {
          assert.ok(err instanceof LanguageServerError);
          assert.equal(err.code, 'LANGUAGE_SERVER_UNAVAILABLE');
          return true;
        }
      );
    });

    it('handles slow CLI process timeout termination', async () => {
      const mockExecTimeout = async () => {
        const err: any = new Error('Command timed out');
        err.killed = true;
        err.signal = 'SIGTERM';
        throw err;
      };

      const client = new ConnectRpcQuotaClient({
        port: 59999,
        fallbackPorts: [59999],
        enableCliFallback: true,
        enableProcessDiscovery: false,
        execFileFn: mockExecTimeout as any,
      });

      await assert.rejects(
        async () => {
          await client.fetchQuota();
        },
        (err: any) => {
          assert.ok(err instanceof LanguageServerError);
          assert.equal(err.code, 'LANGUAGE_SERVER_UNAVAILABLE');
          return true;
        }
      );
    });
  });

  // =========================================================================
  // Suite 3: Process Discovery Resilience & Non-Standard Port Discovery
  // =========================================================================
  describe('Suite 3: Process Discovery & Dual-Port Discovery Resilience', () => {
    it('discovers credentials and connects when language_server is running on non-standard port', async () => {
      let serverReceivedToken = '';
      const testServer = createServer((req, res) => {
        serverReceivedToken = req.headers['x-codeium-csrf-token'] as string;
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(createSampleResponse()));
      });

      await new Promise<void>((resolve) => testServer.listen(0, '127.0.0.1', () => resolve()));
      const mockPort = (testServer.address() as any).port;

      try {
        const mockExecDiscovery = async () => {
          return {
            stdout: `language_server.exe --https_server_port ${mockPort - 1} --csrf_token discovered-secret-123`,
            stderr: '',
          };
        };

        const client = new ConnectRpcQuotaClient({
          port: 59995,
          fallbackPorts: [59995],
          csrfToken: '',
          enableCliFallback: false,
          enableProcessDiscovery: true,
          timeoutMs: 500,
          execFileFn: mockExecDiscovery as any,
        });

        // Bug Assertion: ConnectRpcQuotaClient.tryConnectRpc only queries fallbackPorts,
        // so discovered non-standard port is ignored and never queried.
        const snapshots = await client.fetchQuota();
        assert.ok(snapshots.length > 0);
        assert.equal(serverReceivedToken, 'discovered-secret-123');
      } finally {
        await new Promise<void>((resolve) => testServer.close(() => resolve()));
      }
    });

    it('handles process discovery failure cleanly when powershell/pgrep throws', async () => {
      const mockFailingDiscovery = async () => {
        throw new Error('Get-CimInstance : Access is denied');
      };

      const client = new ConnectRpcQuotaClient({
        port: 59999,
        fallbackPorts: [59999],
        csrfToken: '',
        enableCliFallback: false,
        enableProcessDiscovery: true,
        timeoutMs: 300,
        execFileFn: mockFailingDiscovery as any,
      });

      await assert.rejects(
        async () => {
          await client.fetchQuota();
        },
        (err: any) => {
          assert.ok(err instanceof LanguageServerError);
          assert.equal(err.code, 'LANGUAGE_SERVER_UNAVAILABLE');
          return true;
        }
      );
    });

    it('demonstrates logical OR override bug: empty string csrfToken is overridden by process.env', () => {
      process.env.ANTIGRAVITY_CSRF_TOKEN = 'env-secret-token';

      // Passing explicit empty string should indicate "no token / trigger discovery",
      // but because of `options.csrfToken || process.env.ANTIGRAVITY_CSRF_TOKEN`,
      // falsy '' is replaced by 'env-secret-token'.
      const client = new ConnectRpcQuotaClient({
        csrfToken: '',
      });

      // Bug: (client as any).csrfToken should be '' if nullish coalescing was used
      assert.equal((client as any).csrfToken, '', 'Expected explicit empty string to be preserved');
    });
  });

  // =========================================================================
  // Suite 4: Quota Evaluator Boundary & State Manager Resilience
  // =========================================================================
  describe('Suite 4: Quota Evaluator & State Manager Edge Cases', () => {
    it('strictly evaluates headroom threshold boundary (24.9% vs 25.0%)', () => {
      const evaluator = new QuotaEvaluator({
        milestoneHours: [24, 12, 3],
        alertThresholdPercent: 25,
      });

      const now = Date.now();
      const in5h = new Date(now + 5 * 3600 * 1000).toISOString();

      // 24.9% remaining fraction: should suppress
      const subThreshold = {
        poolId: 'claude',
        family: 'claude' as const,
        displayName: 'Claude 5.5 / Opus',
        remainingFraction: 0.249,
        resetTime: in5h,
        hoursUntilReset: 5,
        models: ['Claude Sonnet 5.5'],
      };

      const r1 = evaluator.evaluatePool(subThreshold, [], now);
      assert.equal(r1.alert, null);

      // 25.0% remaining fraction: should alert
      const atThreshold = {
        ...subThreshold,
        remainingFraction: 0.25,
      };

      const r2 = evaluator.evaluatePool(atThreshold, [], now);
      assert.ok(r2.alert);
      assert.equal(r2.alert.milestoneHours, 12);
    });

    it('handles unordered, negative, and duplicate milestone configurations', () => {
      const evaluator = new QuotaEvaluator({
        milestoneHours: [3, 24, -5, 12, 0, 24, 12, NaN],
        alertThresholdPercent: 20,
      });

      assert.deepEqual(evaluator.milestoneHours, [24, 12, 3]);
    });

    it('safely handles concurrent state saves without file corruption or ENOENT', async () => {
      const testDir = join('data', 'test_concurrent_state_' + Date.now());
      const stateFile = join(testDir, 'state.json');

      try {
        mkdirSync(testDir, { recursive: true });
        const manager = new SentryStateManager(stateFile);
        await manager.load();

        // Trigger concurrent saves in the same tick
        const saves = Array.from({ length: 5 }, async (_, i) => {
          manager.updatePoolQuota(`pool-${i}`, 0.5, new Date().toISOString());
          return manager.save();
        });

        await Promise.all(saves);

        const verifier = new SentryStateManager(stateFile);
        const state = await verifier.load();
        assert.equal(state.version, 1);
        assert.ok(Object.keys(state.pools).length > 0);
      } finally {
        if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
      }
    });
  });
});
