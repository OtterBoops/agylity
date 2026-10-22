import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  aggregateQuotaPools,
  aggregateUserQuotaSummary,
  calculateHoursUntilReset,
  formatHoursHuman,
  formatResetTimeHuman,
  resolveModelFamily,
  LanguageServerResponseSchema,
  RetrieveUserQuotaSummaryResponseSchema,
  QuotaInfoSchema,
  type LanguageServerModelConfig,
  type LanguageServerResponse,
} from '../../src/sentry/models.js';
import {
  SentryStateManager,
  normalizeMilestoneKey,
  createInitialState,
} from '../../src/sentry/state.js';
import { QuotaEvaluator } from '../../src/sentry/evaluator.js';
import {
  ConnectRpcQuotaClient,
  LanguageServerError,
  RPC_PATH,
  QUOTA_SUMMARY_RPC_PATH,
} from '../../src/sentry/client.js';

// ==========================================
// Test Fixtures: 13 Antigravity Models
// ==========================================

const SAMPLE_RESET_TIME_CLAUDE = new Date(Date.now() + 20 * 3600 * 1000).toISOString();
const SAMPLE_RESET_TIME_ARGON = new Date(Date.now() + 100 * 3600 * 1000).toISOString();
const SAMPLE_RESET_TIME_FLASH = new Date(Date.now() + 2 * 3600 * 1000).toISOString();

const createMock13ModelsResponse = (): LanguageServerResponse => ({
  clientModelConfigs: [
    {
      label: 'Gemini 4 Argon (Medium)',
      modelId: 'gemini-4-argon-medium',
      quotaInfo: {
        remainingFraction: 0.1699,
        resetTime: SAMPLE_RESET_TIME_ARGON,
      },
    },
    {
      label: 'Gemini 4 Argon (High)',
      modelId: 'gemini-4-argon-high',
      quotaInfo: {
        remainingFraction: 0.1699,
        resetTime: SAMPLE_RESET_TIME_ARGON,
      },
    },
    {
      label: 'Gemini 4 Argon (Low)',
      modelId: 'gemini-4-argon-low',
      quotaInfo: {
        remainingFraction: 0.1699,
        resetTime: SAMPLE_RESET_TIME_ARGON,
      },
    },
    {
      label: 'Gemini 3.8 Flash (High)',
      modelId: 'gemini-3.8-flash-high',
      quotaInfo: {
        remainingFraction: 0.8084,
        resetTime: SAMPLE_RESET_TIME_FLASH,
      },
    },
    {
      label: 'Gemini 3.8 Flash (Medium)',
      modelId: 'gemini-3.8-flash-medium',
      quotaInfo: {
        remainingFraction: 0.8084,
        resetTime: SAMPLE_RESET_TIME_FLASH,
      },
    },
    {
      label: 'Gemini 3.8 Flash (Low)',
      modelId: 'gemini-3.8-flash-low',
      quotaInfo: {
        remainingFraction: 0.8084,
        resetTime: SAMPLE_RESET_TIME_FLASH,
      },
    },
    {
      label: 'Claude Opus 5.5 (Low)',
      modelId: 'claude-opus-5-5-low',
      quotaInfo: {
        remainingFraction: 0.4944,
        resetTime: SAMPLE_RESET_TIME_CLAUDE,
      },
    },
    {
      label: 'Claude Opus 5.5 (Medium)',
      modelId: 'claude-opus-5-5-medium',
      quotaInfo: {
        remainingFraction: 0.4944,
        resetTime: SAMPLE_RESET_TIME_CLAUDE,
      },
    },
    {
      label: 'Claude Opus 5.5 (High)',
      modelId: 'claude-opus-5-5-high',
      quotaInfo: {
        remainingFraction: 0.4944,
        resetTime: SAMPLE_RESET_TIME_CLAUDE,
      },
    },
    {
      label: 'Claude Sonnet 5.5 (Low)',
      modelId: 'claude-sonnet-5-5-low',
      quotaInfo: {
        remainingFraction: 0.4944,
        resetTime: SAMPLE_RESET_TIME_CLAUDE,
      },
    },
    {
      label: 'Claude Sonnet 5.5 (Medium)',
      modelId: 'claude-sonnet-5-5-medium',
      quotaInfo: {
        remainingFraction: 0.4944,
        resetTime: SAMPLE_RESET_TIME_CLAUDE,
      },
    },
    {
      label: 'Claude Sonnet 5.5 (High)',
      modelId: 'claude-sonnet-5-5-high',
      quotaInfo: {
        remainingFraction: 0.4944,
        resetTime: SAMPLE_RESET_TIME_CLAUDE,
      },
    },
    {
      label: 'GPT-OSS 120B (Medium)',
      modelId: 'gpt-oss-120b-medium',
      quotaInfo: {
        remainingFraction: 0.4944,
        resetTime: SAMPLE_RESET_TIME_CLAUDE,
      },
    },
  ],
  clientModelSorts: [
    {
      name: 'Recommended',
      groups: [
        {
          modelLabels: [
            'Gemini 4 Argon (Medium)',
            'Claude Sonnet 5.5 (Medium)',
            'Gemini 3.8 Flash (Medium)',
          ],
        },
      ],
    },
  ],
});

describe('Milestone 2: Quota Sentry & RPC Engine', () => {
  // ==========================================
  // 1. Models & Pool Aggregation
  // ==========================================
  describe('1. Models & Pool Aggregator', () => {
    it('validates QuotaInfoSchema bounds', () => {
      assert.doesNotThrow(() => {
        QuotaInfoSchema.parse({
          remainingFraction: 0.5,
          resetTime: new Date().toISOString(),
        });
      });

      // Bound errors
      assert.throws(() => {
        QuotaInfoSchema.parse({
          remainingFraction: 1.5,
          resetTime: new Date().toISOString(),
        });
      });
      assert.throws(() => {
        QuotaInfoSchema.parse({
          remainingFraction: -0.1,
          resetTime: new Date().toISOString(),
        });
      });
    });

    it('parses full 13-model Connect-RPC response via LanguageServerResponseSchema', () => {
      const sample = createMock13ModelsResponse();
      const parsed = LanguageServerResponseSchema.parse(sample);
      assert.equal(parsed.clientModelConfigs.length, 13);
      assert.equal(parsed.clientModelSorts?.[0].groups[0].modelLabels.length, 3);
    });

    it('accurately resolves canonical model families', () => {
      assert.equal(resolveModelFamily({ modelId: 'claude-sonnet-5-5-high' })?.family, 'claude');
      assert.equal(resolveModelFamily({ modelId: 'claude-opus-5-5-low' })?.family, 'claude');
      assert.equal(resolveModelFamily({ modelId: 'gpt-oss-120b-medium' })?.family, 'claude');
      assert.equal(
        resolveModelFamily({ modelId: 'gemini-4-argon-medium' })?.family,
        'gemini-argon'
      );
      assert.equal(
        resolveModelFamily({ modelId: 'gemini-3.8-flash-high' })?.family,
        'gemini-flash'
      );
      assert.equal(resolveModelFamily({ modelId: 'unknown-model-xyz' }), null);
    });

    it('pools 13 raw models into 3 canonical family pools', () => {
      const sample = createMock13ModelsResponse();
      const snapshots = aggregateQuotaPools(sample.clientModelConfigs);

      assert.equal(snapshots.length, 3);

      const [claudePool, argonPool, flashPool] = snapshots;

      assert.equal(claudePool.family, 'claude');
      assert.equal(claudePool.poolId, 'claude');
      assert.equal(claudePool.displayName, 'Claude 5.5 / Opus');
      assert.equal(claudePool.remainingFraction, 0.4944);
      assert.equal(claudePool.models.length, 7); // 3 sonnet + 3 opus + 1 gpt-oss

      assert.equal(argonPool.family, 'gemini-argon');
      assert.equal(argonPool.poolId, 'gemini-argon');
      assert.equal(argonPool.displayName, 'Gemini 4 Argon');
      assert.equal(argonPool.remainingFraction, 0.1699);
      assert.equal(argonPool.models.length, 3); // 3 argon variants

      assert.equal(flashPool.family, 'gemini-flash');
      assert.equal(flashPool.poolId, 'gemini-flash');
      assert.equal(flashPool.displayName, 'Gemini 3.8 Flash');
      assert.equal(flashPool.remainingFraction, 0.8084);
      assert.equal(flashPool.models.length, 3); // 3 flash variants
    });

    it('calculates hours until reset and formats human readable time', () => {
      const now = Date.now();
      const in2Hours = new Date(now + 2 * 3600 * 1000).toISOString();
      const inPast = new Date(now - 1000).toISOString();

      assert.equal(calculateHoursUntilReset(in2Hours, now), 2);
      assert.equal(calculateHoursUntilReset(inPast, now), 0);
      assert.equal(calculateHoursUntilReset('invalid-date', now), 0);

      assert.equal(formatHoursHuman(2.5), '2h 30m');
      assert.equal(formatHoursHuman(0.75), '45m');
      assert.equal(formatHoursHuman(0), '0m');
    });

    it('handles models with null or missing quotaInfo safely', () => {
      const mixedConfigs: LanguageServerModelConfig[] = [
        {
          label: 'Claude Sonnet 5.5',
          modelId: 'claude-sonnet-5-5-high',
          quotaInfo: null,
        },
        {
          label: 'Gemini 4 Argon',
          modelId: 'gemini-4-argon-medium',
          quotaInfo: {
            remainingFraction: 0.5,
            resetTime: new Date(Date.now() + 50000).toISOString(),
          },
        },
      ];

      const pools = aggregateQuotaPools(mixedConfigs);
      assert.equal(pools.length, 1);
      assert.equal(pools[0].family, 'gemini-argon');
    });
  });

  // ==========================================
  // 2. Sentry State Manager
  // ==========================================
  describe('2. Sentry State Manager & Persistence', () => {
    const testDir = join('data', 'test_sentry_state_' + Date.now());
    const stateFile = join(testDir, 'state.json');

    beforeEach(() => {
      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
      mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    });

    it('initializes clean default state on ENOENT', async () => {
      const manager = new SentryStateManager(stateFile);
      const state = await manager.load();
      assert.equal(state.version, 1);
      assert.equal(state.lastProbeSource, 'unreachable');
      assert.deepEqual(state.pools, {});
    });

    it('persists state atomically via temporary file and reload', async () => {
      const manager = new SentryStateManager(stateFile);
      await manager.load();

      manager.updateProbe('connect_rpc', '2026-10-19T14:00:00Z');
      manager.updatePoolQuota('claude', 0.49, '2026-10-20T12:00:00Z');
      manager.recordMilestoneFired('claude', 24);

      await manager.save();
      assert.equal(existsSync(stateFile), true);

      // Verify second manager loads exact state
      const manager2 = new SentryStateManager(stateFile);
      const loaded = await manager2.load();

      assert.equal(loaded.lastProbeSource, 'connect_rpc');
      assert.equal(loaded.pools['claude']?.remainingFraction, 0.49);
      assert.deepEqual(loaded.pools['claude']?.firedMilestones, ['24h']);
      assert.equal(manager2.isMilestoneFired('claude', 24), true);
      assert.equal(manager2.isMilestoneFired('claude', '24h'), true);
      assert.equal(manager2.isMilestoneFired('claude', 12), false);
    });

    it('detects cycle rollover and clears fired milestones when resetTime advances', async () => {
      const manager = new SentryStateManager(stateFile);
      await manager.load();

      // Cycle 1
      manager.updatePoolQuota('claude', 0.5, '2026-10-20T10:00:00Z');
      manager.recordMilestoneFired('claude', 24);
      manager.recordMilestoneFired('claude', 12);
      assert.equal(manager.isMilestoneFired('claude', 24), true);

      // Cycle 2: new reset deadline
      const rolledOver = manager.updatePoolQuota('claude', 0.95, '2026-10-21T10:00:00Z');
      assert.equal(rolledOver, true);
      assert.equal(manager.isMilestoneFired('claude', 24), false);
      assert.equal(manager.isMilestoneFired('claude', 12), false);
      assert.deepEqual(manager.getPoolState('claude')?.firedMilestones, []);
    });

    it('quarantines corrupt JSON state file and initializes fresh state', async () => {
      // Write corrupted JSON to state file
      writeFileSync(stateFile, '{"version": 1, "pools": INVALID_JSON_SYNTAX', 'utf-8');

      const manager = new SentryStateManager(stateFile);
      const state = await manager.load();

      assert.equal(state.version, 1);
      assert.deepEqual(state.pools, {});

      // Verify corrupted file was quarantined
      const files = existsSync(testDir);
      assert.ok(files);
    });

    it('normalizes milestone keys consistently', () => {
      assert.equal(normalizeMilestoneKey(24), '24h');
      assert.equal(normalizeMilestoneKey('24h'), '24h');
      assert.equal(normalizeMilestoneKey('12'), '12h');
      assert.equal(normalizeMilestoneKey(3.5), '3.5h');
    });
  });

  // ==========================================
  // 3. Quota Evaluator Math & Late-Wake Anti-Spam
  // ==========================================
  describe('3. Quota Evaluator Math & Late-Wake Reconciliation', () => {
    it('suppresses alert when remaining headroom is below alert threshold', () => {
      const evaluator = new QuotaEvaluator({
        milestoneHours: [24, 12, 3],
        alertThresholdPercent: 25,
      });

      const now = Date.now();
      const snapshot = {
        poolId: 'claude',
        family: 'claude' as const,
        displayName: 'Claude 5.5 / Opus',
        remainingFraction: 0.15, // 15% remaining < 25% threshold
        resetTime: new Date(now + 10 * 3600 * 1000).toISOString(), // 10h remaining
        hoursUntilReset: 10,
        models: ['Claude Sonnet 5.5'],
      };

      const result = evaluator.evaluatePool(snapshot, [], now);
      assert.equal(result.alert, null);
    });

    it('suppresses alert when reset deadline has already passed', () => {
      const evaluator = new QuotaEvaluator({
        milestoneHours: [24, 12, 3],
        alertThresholdPercent: 25,
      });

      const now = Date.now();
      const snapshot = {
        poolId: 'claude',
        family: 'claude' as const,
        displayName: 'Claude 5.5 / Opus',
        remainingFraction: 0.5,
        resetTime: new Date(now - 1000).toISOString(), // Past
        hoursUntilReset: 0,
        models: ['Claude Sonnet 5.5'],
      };

      const result = evaluator.evaluatePool(snapshot, [], now);
      assert.equal(result.alert, null);
    });

    it('progressively triggers 24h, 12h, and 3h milestones in order', () => {
      const evaluator = new QuotaEvaluator({
        milestoneHours: [24, 12, 3],
        alertThresholdPercent: 25,
      });

      const resetTime = new Date('2026-10-20T12:00:00Z').getTime();
      const makeSnapshot = (now: number) => ({
        poolId: 'claude',
        family: 'claude' as const,
        displayName: 'Claude 5.5 / Opus',
        remainingFraction: 0.5,
        resetTime: new Date(resetTime).toISOString(),
        hoursUntilReset: (resetTime - now) / 3600000,
        models: ['Claude Sonnet 5.5'],
      });

      const fired: (number | string)[] = [];

      // Step 1: 23 hours remaining -> fires 24h
      const now1 = resetTime - 23 * 3600 * 1000;
      const r1 = evaluator.evaluatePool(makeSnapshot(now1), fired, now1);
      assert.ok(r1.alert);
      assert.equal(r1.alert.milestoneHours, 24);
      fired.push(r1.alert.milestoneHours);

      // Step 2: 15 hours remaining -> 24h already fired, 12h not reached yet
      const now2 = resetTime - 15 * 3600 * 1000;
      const r2 = evaluator.evaluatePool(makeSnapshot(now2), fired, now2);
      assert.equal(r2.alert, null);

      // Step 3: 11 hours remaining -> fires 12h
      const now3 = resetTime - 11 * 3600 * 1000;
      const r3 = evaluator.evaluatePool(makeSnapshot(now3), fired, now3);
      assert.ok(r3.alert);
      assert.equal(r3.alert.milestoneHours, 12);
      fired.push(r3.alert.milestoneHours);

      // Step 4: 2.5 hours remaining -> fires 3h
      const now4 = resetTime - 2.5 * 3600 * 1000;
      const r4 = evaluator.evaluatePool(makeSnapshot(now4), fired, now4);
      assert.ok(r4.alert);
      assert.equal(r4.alert.milestoneHours, 3);
      fired.push(r4.alert.milestoneHours);

      // Step 5: 1 hour remaining -> all milestones fired
      const now5 = resetTime - 1 * 3600 * 1000;
      const r5 = evaluator.evaluatePool(makeSnapshot(now5), fired, now5);
      assert.equal(r5.alert, null);
    });

    it('late-wake anti-spam: triggers ONLY most urgent milestone and supersedes larger windows', () => {
      const evaluator = new QuotaEvaluator({
        milestoneHours: [24, 12, 3],
        alertThresholdPercent: 25,
      });

      const resetTime = new Date('2026-10-20T12:00:00Z').getTime();

      // Daemon wakes at 2 hours remaining (crossing 24h, 12h, and 3h simultaneously)
      const now = resetTime - 2 * 3600 * 1000;
      const snapshot = {
        poolId: 'claude',
        family: 'claude' as const,
        displayName: 'Claude 5.5 / Opus',
        remainingFraction: 0.6,
        resetTime: new Date(resetTime).toISOString(),
        hoursUntilReset: 2,
        models: ['Claude Sonnet 5.5'],
      };

      const result = evaluator.evaluatePool(snapshot, [], now);

      assert.ok(result.alert);
      // Most urgent is 3
      assert.equal(result.alert.milestoneHours, 3);
      // Superseded are 24 and 12
      assert.deepEqual(result.supersededMilestones.sort(), [12, 24]);
    });

    it('evaluates snapshots and integrates with SentryStateManager seamlessly', () => {
      const stateManager = new SentryStateManager();
      const evaluator = new QuotaEvaluator({
        milestoneHours: [24, 12, 3],
        alertThresholdPercent: 25,
      });

      const resetTime = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
      const snapshots = [
        {
          poolId: 'claude',
          family: 'claude' as const,
          displayName: 'Claude 5.5 / Opus',
          remainingFraction: 0.5,
          resetTime,
          hoursUntilReset: 2,
          models: ['Claude Sonnet 5.5'],
        },
      ];

      // First run: fires 3h milestone, supersedes 24 and 12
      const alerts = evaluator.evaluate(snapshots, stateManager);
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].milestoneHours, 3);

      assert.equal(stateManager.isMilestoneFired('claude', 3), true);
      assert.equal(stateManager.isMilestoneFired('claude', 12), true);
      assert.equal(stateManager.isMilestoneFired('claude', 24), true);

      // Second run immediately after: zero new alerts
      const alerts2 = evaluator.evaluate(snapshots, stateManager);
      assert.equal(alerts2.length, 0);
    });
  });

  // ==========================================
  // 4. Connect-RPC Quota Client & Fallbacks
  // ==========================================
  describe('4. Connect-RPC Client & CLI Fallback', () => {
    let mockServer: Server;
    let mockPort: number;
    let lastReceivedHeaders: Record<string, string | string[] | undefined> = {};
    let lastReceivedBody = '';
    let mockResponseStatus = 200;
    let mockResponseBody: unknown = createMock13ModelsResponse();

    beforeEach(async () => {
      mockResponseStatus = 200;
      mockResponseBody = createMock13ModelsResponse();

      await new Promise<void>((resolve) => {
        mockServer = createServer((req, res) => {
          lastReceivedHeaders = req.headers;
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', () => {
            lastReceivedBody = body;

            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.end('Method Not Allowed');
              return;
            }

            if (req.headers['x-codeium-csrf-token'] !== 'valid-test-token') {
              res.statusCode = 401;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ code: 'unauthenticated', message: 'invalid CSRF token' }));
              return;
            }

            if (!req.headers['content-type']?.includes('application/json')) {
              res.statusCode = 415;
              res.end('Unsupported Media Type');
              return;
            }

            res.statusCode = mockResponseStatus;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(mockResponseBody));
          });
        });

        mockServer.listen(0, '127.0.0.1', () => {
          const addr = mockServer.address() as { port: number };
          mockPort = addr.port;
          resolve();
        });
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => {
        mockServer.close(() => resolve());
      });
    });

    it('queries Connect-RPC endpoint with proper headers and empty body', async () => {
      const client = new ConnectRpcQuotaClient({
        port: mockPort,
        csrfToken: 'valid-test-token',
        enableCliFallback: false,
        enableProcessDiscovery: false,
      });

      const snapshots = await client.fetchQuota();

      assert.equal(snapshots.length, 3);
      assert.equal(lastReceivedHeaders['x-codeium-csrf-token'], 'valid-test-token');
      assert.equal(lastReceivedHeaders['content-type'], 'application/json');
      assert.equal(lastReceivedBody, '{}');
    });

    it('falls back to secondary port when primary port is unreachable', async () => {
      // Primary port unreachable (unused port 59999), secondary port is mockPort
      const client = new ConnectRpcQuotaClient({
        port: 59999,
        fallbackPorts: [59999, mockPort],
        csrfToken: 'valid-test-token',
        enableCliFallback: false,
        enableProcessDiscovery: false,
        timeoutMs: 1000,
      });

      const snapshots = await client.fetchQuota();
      assert.equal(snapshots.length, 3);
    });

    it('falls back to agy CLI when RPC fails', async () => {
      // Mock execFileFn simulating successful CLI output
      const mockExecFile = async (_cmd: string, _args: readonly string[]) => {
        return {
          stdout: JSON.stringify({
            status: 'SUCCESS',
            command: {
              name: 'models',
              data: {
                models: [
                  { id: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 (High)' },
                  { id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' },
                  { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
                ],
              },
            },
          }),
          stderr: '',
        };
      };

      const client = new ConnectRpcQuotaClient({
        port: 59999, // unreachable
        fallbackPorts: [59999],
        csrfToken: 'invalid',
        enableCliFallback: true,
        enableProcessDiscovery: false,
        timeoutMs: 500,
        execFileFn: mockExecFile as any,
      });

      const snapshots = await client.fetchQuota();
      assert.equal(snapshots.length, 3);
      assert.equal(snapshots[0].family, 'claude');
      assert.equal(snapshots[1].family, 'gemini-argon');
      assert.equal(snapshots[2].family, 'gemini-flash');
    });

    it('throws LanguageServerError with code LANGUAGE_SERVER_UNAVAILABLE when all options fail', async () => {
      const mockFailingExec = async () => {
        throw new Error('agy CLI executable not found in PATH');
      };

      const client = new ConnectRpcQuotaClient({
        port: 59999,
        fallbackPorts: [59999],
        csrfToken: 'invalid',
        enableCliFallback: true,
        enableProcessDiscovery: false,
        timeoutMs: 500,
        execFileFn: mockFailingExec as any,
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
    });

    it('CLI fallback updates hoursUntilReset on cached snapshots if available', async () => {
      const priorReset = new Date(Date.now() + 5 * 3600 * 1000).toISOString();
      const cachedProvider = () => [
        {
          poolId: 'claude',
          family: 'claude' as const,
          displayName: 'Claude 5.5 / Opus',
          remainingFraction: 0.42,
          resetTime: priorReset,
          hoursUntilReset: 10, // outdated
          models: ['Claude Sonnet 5.5'],
        },
      ];

      const mockExecFile = async () => ({
        stdout: JSON.stringify({
          status: 'SUCCESS',
          command: {
            name: 'models',
            data: { models: [{ id: 'claude-sonnet-5-5-high' }] },
          },
        }),
        stderr: '',
      });

      const client = new ConnectRpcQuotaClient({
        port: 59999,
        fallbackPorts: [59999],
        enableCliFallback: true,
        enableProcessDiscovery: false,
        timeoutMs: 500,
        cachedSnapshotProvider: cachedProvider,
        execFileFn: mockExecFile as any,
      });

      const snapshots = await client.fetchQuota();
      assert.equal(snapshots.length, 1);
      assert.equal(snapshots[0].remainingFraction, 0.42);
      // Recalculated hoursUntilReset should be approximately 5, not stale 10
      assert.ok(snapshots[0].hoursUntilReset >= 4.9 && snapshots[0].hoursUntilReset <= 5.1);
    });

    it('successfully queries RetrieveUserQuotaSummary Connect-RPC endpoint with weekly eval target', async () => {
      const nowMs = Date.now();
      const mockQuotaSummary = {
        response: {
          groups: [
            {
              displayName: 'Gemini Models',
              buckets: [
                {
                  bucketId: 'gemini-weekly',
                  displayName: 'Weekly Limit Remaining',
                  window: 'weekly',
                  remainingFraction: 0.73,
                  resetTime: new Date(nowMs + 120 * 3600 * 1000).toISOString(),
                },
                {
                  bucketId: 'gemini-5h',
                  displayName: 'Five Hour Limit Remaining',
                  window: '5h',
                  remainingFraction: 0.99,
                  resetTime: new Date(nowMs + 3.3 * 3600 * 1000).toISOString(),
                },
              ],
            },
            {
              displayName: 'Claude and GPT models',
              buckets: [
                {
                  bucketId: '3p-weekly',
                  displayName: 'Weekly Limit Remaining',
                  window: 'weekly',
                  remainingFraction: 0.49,
                  resetTime: new Date(nowMs + 27 * 3600 * 1000).toISOString(),
                },
                {
                  bucketId: '3p-5h',
                  displayName: 'Five Hour Limit Remaining',
                  window: '5h',
                  remainingFraction: 1.0,
                  resetTime: new Date(nowMs + 5 * 3600 * 1000).toISOString(),
                },
              ],
            },
            {
              displayName: 'Gemini 4 Argon',
              buckets: [
                {
                  bucketId: 'gemini-argon-wtu-weekly',
                  displayName: 'Gemini 4 Argon Weekly Limit',
                  window: 'weekly',
                  remainingFraction: 0.28,
                  resetTime: new Date(nowMs + 165 * 3600 * 1000).toISOString(),
                },
              ],
            },
          ],
        },
      };

      const server = createServer((req, res) => {
        if (req.url === QUOTA_SUMMARY_RPC_PATH && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(mockQuotaSummary));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as any).port;

      try {
        const client = new ConnectRpcQuotaClient({
          endpointUrl: `http://127.0.0.1:${port}`,
          csrfToken: 'test-token',
          timeoutMs: 1000,
          enableCliFallback: false,
        });

        const snapshots = await client.fetchQuota();
        assert.equal(snapshots.length, 3);

        // Claude: weekly is 0.49, 5h is 1.0
        const claude = snapshots.find((s) => s.family === 'claude');
        assert.ok(claude);
        assert.equal(claude.remainingFraction, 0.49); // Weekly is the primary eval target
        assert.equal(claude.weekly?.remainingFraction, 0.49);
        assert.equal(claude.shortTerm?.remainingFraction, 1.0);
        assert.equal(claude.shortTerm?.window, '5h');

        // Gemini 4 Argon: weekly is 0.28, no 5h limit
        const argon = snapshots.find((s) => s.family === 'gemini-argon');
        assert.ok(argon);
        assert.equal(argon.remainingFraction, 0.28); // Weekly is the primary eval target
        assert.equal(argon.shortTerm, undefined);

        // Gemini Flash: weekly is 0.73, 5h is 0.99
        const flash = snapshots.find((s) => s.family === 'gemini-flash');
        assert.ok(flash);
        assert.equal(flash.remainingFraction, 0.73);
        assert.equal(flash.shortTerm?.remainingFraction, 0.99);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('formatResetTimeHuman formats hours into natural human durations', () => {
      assert.equal(formatResetTimeHuman(0), '0m');
      assert.equal(formatResetTimeHuman(-1), '0m');
      assert.equal(formatResetTimeHuman(1.5), '1h 30m');
      assert.equal(formatResetTimeHuman(3.3), '3h 18m');
      assert.equal(formatResetTimeHuman(24), '1d');
      assert.equal(formatResetTimeHuman(27), '1d 3h');
      assert.equal(formatResetTimeHuman(112.5), '4d 16h');
      assert.equal(formatResetTimeHuman(165), '6d 21h');
    });

    it('parses overageInfo and sets overageEnabled flag accurately', () => {
      // 1. Overage enabled via camelCase overageInfo
      const summaryWithOverage = {
        response: {
          groups: [
            {
              displayName: 'Gemini Models',
              buckets: [
                {
                  bucketId: 'gemini-weekly',
                  displayName: 'Weekly Limit',
                  remainingFraction: 0.85,
                  resetTime: new Date().toISOString(),
                },
              ],
            },
          ],
          overageInfo: {
            enabled: true,
          },
        },
      };

      const parsedWithOverage = RetrieveUserQuotaSummaryResponseSchema.parse(summaryWithOverage);
      const snapshotsWithOverage = aggregateUserQuotaSummary(parsedWithOverage);
      assert.equal(snapshotsWithOverage[0]?.overageEnabled, true);

      // 2. Overage disabled via snake_case overage_info
      const summaryCapped = {
        response: {
          groups: [
            {
              displayName: 'Gemini Models',
              buckets: [
                {
                  bucketId: 'gemini-weekly',
                  displayName: 'Weekly Limit',
                  remainingFraction: 0.85,
                  resetTime: new Date().toISOString(),
                },
              ],
            },
          ],
          overage_info: {
            enabled: false,
          },
        },
      };

      const parsedCapped = RetrieveUserQuotaSummaryResponseSchema.parse(summaryCapped);
      const snapshotsCapped = aggregateUserQuotaSummary(parsedCapped);
      assert.equal(snapshotsCapped[0]?.overageEnabled, false);

      // 3. Overage omitted (proto3 false default)
      const summaryOmitted = {
        response: {
          groups: [
            {
              displayName: 'Gemini Models',
              buckets: [
                {
                  bucketId: 'gemini-weekly',
                  displayName: 'Weekly Limit',
                  remainingFraction: 0.85,
                  resetTime: new Date().toISOString(),
                },
              ],
            },
          ],
        },
      };

      const parsedOmitted = RetrieveUserQuotaSummaryResponseSchema.parse(summaryOmitted);
      const snapshotsOmitted = aggregateUserQuotaSummary(parsedOmitted);
      assert.equal(snapshotsOmitted[0]?.overageEnabled, false);
    });
  });
});
