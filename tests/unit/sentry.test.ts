import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import {
  aggregateQuotaPools,
  aggregateUserQuotaSummary,
  calculateHoursUntilReset,
  computeBurnProjection,
  deriveOverageEnabled,
  resolveModelFamily,
  snapshotsFromSentryState,
  GetUserStatusResponseSchema,
  LanguageServerResponseSchema,
  RetrieveUserQuotaSummaryResponseSchema,
  QuotaInfoSchema,
  QuotaSnapshotSchema,
  type BurnSample,
  type LanguageServerModelConfig,
} from '../../src/sentry/models.js';
import { SentryStateManager, normalizeMilestoneKey } from '../../src/sentry/state.js';
import { QuotaEvaluator } from '../../src/sentry/evaluator.js';
import { AppDatabase } from '../../src/storage/db.js';
import { makeTempDir } from '../e2e/harness/index.js';
import {
  ConnectRpcQuotaClient,
  LanguageServerError,
  QUOTA_SUMMARY_RPC_PATH,
  USER_STATUS_RPC_PATH,
} from '../../src/sentry/client.js';
import {
  discoverWindowsLanguageServer,
  parseWindowsNetstatPorts,
  type ExecFileAsyncFn,
  defaultExecFileAsync,
} from '../../src/sentry/discovery.js';

// ==========================================
// Test Fixtures: 13 Antigravity Models
// ==========================================

// Local mirror of the response shape; the models module only exports the schema.
type LanguageServerResponse = z.infer<typeof LanguageServerResponseSchema>;

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
        'gemini-hydrogen'
      );
      assert.equal(
        resolveModelFamily({ modelId: 'gemini-4-hydrogen-high' })?.family,
        'gemini-hydrogen'
      );
      assert.equal(resolveModelFamily({ modelId: 'unknown-model-xyz' }), null);
    });

    it('attributes new codenames to the correct pool without a bare pro match', () => {
      // Hydrogen is a Flash-pool model that no canonical list mentioned when this shipped.
      assert.equal(
        resolveModelFamily({ modelId: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen' })?.family,
        'gemini-hydrogen'
      );
      // The G1 Pro orchestrator route is an Argon model, whatever its 'pro' codename suggests.
      assert.equal(
        resolveModelFamily({ modelId: 'gemini-pro-orchestrator-g1-pro' })?.family,
        'gemini-argon'
      );
    });

    it('treats an empty quotaInfo placeholder as absent telemetry instead of failing the parse', () => {
      const resetTime = new Date(Date.now() + 3600 * 1000).toISOString();
      const parsed = LanguageServerResponseSchema.parse({
        clientModelConfigs: [
          { label: 'Gemini 4 Carbon', modelId: 'gemini-4-carbon-disabled', quotaInfo: {} },
          {
            label: 'Gemini 4 Argon (High)',
            modelId: 'gemini-4-argon-high',
            disabled: true,
            tagDescription: 'Requires an Ultra plan',
            quotaInfo: { remainingFraction: 0.5, resetTime },
          },
          {
            label: 'Gemini 4 Hydrogen (High)',
            modelId: 'gemini-4-hydrogen-high',
            quotaInfo: { remainingFraction: 0.9, resetTime },
          },
        ],
      });

      // The placeholder carries no telemetry, so it parses as absent rather than throwing.
      assert.equal(parsed.clientModelConfigs[0]?.quotaInfo, undefined);
      assert.equal(parsed.clientModelConfigs[1]?.disabled, true);
      assert.equal(parsed.clientModelConfigs[1]?.tagDescription, 'Requires an Ultra plan');

      // A disabled listing echoes the pool's balance but must not author a pool of its own.
      const pools = aggregateQuotaPools(parsed.clientModelConfigs);
      assert.deepEqual(
        pools.map((pool) => pool.family),
        ['gemini-hydrogen']
      );
      assert.deepEqual(pools[0]?.models, ['Gemini 4 Hydrogen (High)']);
    });

    it('bills Gemini 4 Carbon to the Hydrogen pool and drops its disabled listing', () => {
      assert.equal(resolveModelFamily({ modelId: 'gemini-4-carbon' })?.family, 'gemini-hydrogen');
      assert.equal(
        resolveModelFamily({ modelId: 'gemini-4-carbon-high' })?.family,
        'gemini-hydrogen'
      );
      assert.equal(resolveModelFamily({ modelId: 'gemini-4-carbon-disabled' }), null);

      const resetTime = new Date(Date.now() + 3600 * 1000).toISOString();
      // A `{}` placeholder only exists on the wire, so the response schema is what must tolerate it.
      const parsed = LanguageServerResponseSchema.parse({
        clientModelConfigs: [
          {
            label: 'Gemini 4 Hydrogen',
            modelId: 'gemini-4-hydrogen-high',
            quotaInfo: { remainingFraction: 0.7, resetTime },
          },
          {
            label: 'Gemini 4 Carbon',
            modelId: 'gemini-4-carbon',
            quotaInfo: { remainingFraction: 0.7, resetTime },
          },
          { label: 'Gemini 4 Carbon', modelId: 'gemini-4-carbon-disabled', quotaInfo: {} },
        ],
      });

      const pools = aggregateQuotaPools(parsed.clientModelConfigs);
      assert.equal(pools.length, 1);
      assert.equal(pools[0]?.family, 'gemini-hydrogen');
      assert.deepEqual(pools[0]?.models, ['Gemini 4 Carbon', 'Gemini 4 Hydrogen']);
    });

    it('separates the Carbon and Neon orchestrator routes from the Argon one', () => {
      assert.equal(
        resolveModelFamily({ modelId: 'gemini-pro-orchestrator' })?.family,
        'gemini-hydrogen'
      );
      assert.equal(
        resolveModelFamily({ modelId: 'gemini-pro-orchestrator', label: 'Orchestrator (Carbon)' })
          ?.family,
        'gemini-hydrogen'
      );
      assert.equal(
        resolveModelFamily({
          modelId: 'gemini-pro-orchestrator-neon',
          label: 'Orchestrator (Neon)',
        })?.family,
        'gemini-hydrogen'
      );
      assert.equal(
        resolveModelFamily({ modelId: 'gemini-4-neon-xhigh', label: 'Gemini 4 Neon (XHigh)' })
          ?.family,
        'gemini-hydrogen'
      );
      // A cascade entry may carry only one of the two signals, so each must resolve on its own.
      assert.equal(resolveModelFamily({ modelId: 'gemini-4-neon' })?.family, 'gemini-hydrogen');
      assert.equal(resolveModelFamily({ label: 'Gemini 4 Neon' })?.family, 'gemini-hydrogen');
      assert.equal(
        resolveModelFamily({
          modelId: 'gemini-pro-orchestrator-g1-pro',
          label: 'Orchestrator (Argon)',
        })?.family,
        'gemini-argon'
      );
      assert.equal(resolveModelFamily({ modelId: 'orchestrator-g1-pro' })?.family, 'gemini-argon');
      assert.equal(resolveModelFamily({ modelId: 'orchestrator-argon' })?.family, 'gemini-argon');
    });

    it('resolves the pre-rename pool family id as an alias of the current one', () => {
      const resetTime = new Date(Date.now() + 3600 * 1000).toISOString();
      const snapshots = snapshotsFromSentryState({
        pools: {
          'gemini-flash': { resetTime, remainingFraction: 0.5 },
          'gemini-flash:gemini-pro': { resetTime, remainingFraction: 0.3 },
        },
      });

      assert.deepEqual(
        snapshots.map((snapshot) => snapshot.family),
        ['gemini-hydrogen', 'gemini-hydrogen']
      );
      // The suffixed pool keeps its own identity; only the family prefix moved.
      assert.deepEqual(
        snapshots.map((snapshot) => snapshot.poolId),
        ['gemini-hydrogen', 'gemini-hydrogen:gemini-pro']
      );
    });

    it('attributes an unknown codename to the pool whose quota telemetry it matches', () => {
      const resetTime = new Date(Date.now() + 3600 * 1000).toISOString();
      const configs: LanguageServerModelConfig[] = [
        {
          label: 'Gemini 4 Argon',
          modelId: 'gemini-4-argon-high',
          quotaInfo: { remainingFraction: 0.6, resetTime },
        },
        {
          label: 'Gemini 3.8 Flash',
          modelId: 'gemini-3.8-flash-high',
          quotaInfo: { remainingFraction: 0.4, resetTime },
        },
        {
          label: 'Claude Sonnet 5.5',
          modelId: 'claude-sonnet-5-5-high',
          quotaInfo: { remainingFraction: 0.2, resetTime },
        },
        {
          label: 'Gemini Q7 Nebula',
          modelId: 'gemini-q7-nebula-high',
          quotaInfo: { remainingFraction: 0.4, resetTime },
        },
      ];

      const pools = aggregateQuotaPools(configs);
      const flashPool = pools.find((p) => p.family === 'gemini-hydrogen');
      assert.ok(flashPool);
      // Same telemetry as the flash pool, so the unknown codename joins that pool's model list.
      assert.ok(flashPool.models.includes('Gemini Q7 Nebula'));
      assert.equal(flashPool.models.length, 2);
      // And it must not leak into another pool.
      assert.ok(!pools.find((p) => p.family === 'claude')?.models.includes('Gemini Q7 Nebula'));
    });

    it('drops an unknown codename whose telemetry matches no pool or matches several', () => {
      const resetTime = new Date(Date.now() + 3600 * 1000).toISOString();
      const configs: LanguageServerModelConfig[] = [
        {
          label: 'Gemini 4 Argon',
          modelId: 'gemini-4-argon-high',
          quotaInfo: { remainingFraction: 0.5, resetTime },
        },
        {
          label: 'Gemini 3.8 Flash',
          modelId: 'gemini-3.8-flash-high',
          quotaInfo: { remainingFraction: 0.5, resetTime },
        },
        {
          label: 'Gemini Q7 Nebula',
          modelId: 'gemini-q7-nebula-high',
          quotaInfo: { remainingFraction: 0.5, resetTime },
        },
      ];

      const pools = aggregateQuotaPools(configs);
      for (const pool of pools) {
        assert.ok(!pool.models.includes('Gemini Q7 Nebula'));
      }
    });

    it('pools 13 raw models into 3 canonical family pools', () => {
      const sample = createMock13ModelsResponse();
      const snapshots = aggregateQuotaPools(sample.clientModelConfigs);

      assert.equal(snapshots.length, 3);

      const claudePool = snapshots.find((s) => s.family === 'claude');
      const argonPool = snapshots.find((s) => s.family === 'gemini-argon');
      const flashPool = snapshots.find((s) => s.family === 'gemini-hydrogen');

      assert.ok(claudePool);
      assert.ok(argonPool);
      assert.ok(flashPool);

      assert.equal(claudePool.family, 'claude');
      assert.equal(claudePool.poolId, 'claude');
      assert.equal(claudePool.displayName, 'Claude and GPT models');
      assert.equal(claudePool.remainingFraction, 0.4944);
      assert.equal(claudePool.models.length, 7); // 3 sonnet + 3 opus + 1 gpt-oss

      assert.equal(argonPool.family, 'gemini-argon');
      assert.equal(argonPool.poolId, 'gemini-argon');
      assert.equal(argonPool.displayName, 'Gemini Argon');
      assert.equal(argonPool.remainingFraction, 0.1699);
      assert.equal(argonPool.models.length, 3); // 3 argon variants

      assert.equal(flashPool.family, 'gemini-hydrogen');
      assert.equal(flashPool.poolId, 'gemini-hydrogen');
      assert.equal(flashPool.displayName, 'Gemini Hydrogen');
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
      assert.equal(pools[0]?.family, 'gemini-argon');
    });
  });

  // ==========================================
  // 2. Sentry State Manager
  // ==========================================
  describe('2. Sentry State Manager & Persistence', () => {
    const testDir = join(
      tmpdir(),
      'test_sentry_state_' + Date.now() + '_' + Math.random().toString(36).slice(2)
    );
    const stateFile = join(testDir, 'state.json');
    // The ledger lives beside the state path and holds the file open, so every handle is closed
    // before the temp directory is removed.
    const opened: SentryStateManager[] = [];
    const openState = (statePath: string = stateFile): SentryStateManager => {
      const manager = new SentryStateManager(statePath);
      opened.push(manager);
      return manager;
    };

    beforeEach(() => {
      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
      mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
      for (const manager of opened) manager.close();
      opened.length = 0;
      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    });

    it('initializes clean default state when no ledger exists', async () => {
      const manager = openState(stateFile);
      const state = await manager.load();
      assert.equal(state.version, 1);
      assert.equal(state.lastProbeSource, 'unreachable');
      assert.deepEqual(state.pools, {});
    });

    it('persists state through the SQLite ledger and reloads it', async () => {
      const manager = openState(stateFile);
      await manager.load();

      manager.updateProbe('connect_rpc', '2026-10-19T14:00:00Z');
      manager.updatePoolQuota('claude', 0.49, '2026-10-20T12:00:00Z');
      manager.recordMilestoneFired('claude', 24);

      await manager.save();
      assert.equal(existsSync(join(testDir, 'state.db')), true);

      // Verify second manager loads exact state
      const manager2 = openState(stateFile);
      const loaded = await manager2.load();

      assert.equal(loaded.lastProbeSource, 'connect_rpc');
      assert.equal(loaded.pools['claude']?.remainingFraction, 0.49);
      assert.deepEqual(loaded.pools['claude']?.firedMilestones, ['24h']);
      assert.equal(manager2.isMilestoneFired('claude', 24), true);
      assert.equal(manager2.isMilestoneFired('claude', '24h'), true);
      assert.equal(manager2.isMilestoneFired('claude', 12), false);
    });

    it('detects cycle rollover and clears fired milestones when resetTime advances', async () => {
      const manager = openState(stateFile);
      await manager.load();

      // Cycle 1
      manager.updatePoolQuota('claude', 0.5, '2026-10-20T10:00:00Z');
      manager.recordMilestoneFired('claude', 24);
      manager.recordMilestoneFired('claude', 12);
      assert.equal(manager.isMilestoneFired('claude', 24), true);

      // Cycle 2: new reset deadline
      const rolledOver = manager.updatePoolQuota('claude', 0.95, '2026-10-21T10:00:00Z');
      assert.equal(rolledOver.cycleRolled, true);
      assert.equal(rolledOver.earlyReset, null);
      assert.equal(manager.isMilestoneFired('claude', 24), false);
      assert.equal(manager.isMilestoneFired('claude', 12), false);
      assert.deepEqual(manager.getPoolState('claude')?.firedMilestones, []);
    });

    it('quarantines a corrupt pre-SQLite state file and initializes fresh state', async () => {
      // Write corrupted JSON to the legacy state path the ledger imports from.
      writeFileSync(stateFile, '{"version": 1, "pools": INVALID_JSON_SYNTAX', 'utf-8');

      const manager = openState(stateFile);
      const state = await manager.load();

      assert.equal(state.version, 1);
      assert.deepEqual(state.pools, {});

      // Verify corrupted file was quarantined
      const quarantined = readdirSync(testDir).filter((f) => f.includes('.corrupt.'));
      assert.equal(quarantined.length, 1);
    });

    it('imports a legacy state file keyed by the pre-rename pool family', async () => {
      writeFileSync(
        stateFile,
        JSON.stringify({
          version: 1,
          lastProbeAt: '2026-11-01T00:00:00Z',
          lastProbeSource: 'connect_rpc',
          pools: {
            'gemini-flash': {
              resetTime: '2026-11-20T00:00:00Z',
              remainingFraction: 0.4,
              firedMilestones: ['24h'],
            },
            'gemini-flash:gemini-pro': {
              resetTime: '2026-11-20T00:00:00Z',
              remainingFraction: 0.2,
              firedMilestones: [],
            },
            'gemini-hydrogen': {
              resetTime: '2026-11-25T00:00:00Z',
              remainingFraction: 0.9,
              firedMilestones: [],
            },
          },
          earlyResetNotice: {
            detectedAt: '2026-11-01T00:00:00Z',
            pools: [
              {
                poolId: 'gemini-flash',
                previousRemainingFraction: 0.1,
                remainingFraction: 0.9,
                previousResetTime: '2026-10-30T00:00:00Z',
                resetTime: '2026-11-20T00:00:00Z',
              },
            ],
          },
        }),
        'utf-8'
      );

      const manager = openState(stateFile);
      const state = await manager.load();

      assert.deepEqual(Object.keys(state.pools).sort(), [
        'gemini-hydrogen',
        'gemini-hydrogen:gemini-pro',
      ]);
      // Both ids collapse onto one key, so the newer quota cycle decides which state survives.
      assert.equal(state.pools['gemini-hydrogen']?.remainingFraction, 0.9);
      assert.equal(state.pools['gemini-hydrogen:gemini-pro']?.remainingFraction, 0.2);
      assert.equal(state.earlyResetNotice?.pools[0]?.poolId, 'gemini-hydrogen');
      // A state file that imported cleanly is history, not corruption.
      assert.deepEqual(
        readdirSync(testDir).filter((f) => f.includes('.corrupt.')),
        []
      );
    });

    it('leaves a valid state file alone when the read fails for a reason other than its content', async () => {
      // A directory at the state path makes the read throw EISDIR, not a parse or validation error.
      const dirAsStatePath = join(testDir, 'state-as-dir');
      mkdirSync(dirAsStatePath, { recursive: true });

      const manager = openState(dirAsStatePath);
      const state = await manager.load();

      assert.equal(state.version, 1);
      assert.deepEqual(state.pools, {});
      // Quarantining here would rename a file nothing is wrong with; nothing may be created.
      const quarantined = readdirSync(testDir).filter((f) => f.includes('.corrupt.'));
      assert.equal(quarantined.length, 0);
    });

    it('normalizes milestone keys consistently', () => {
      assert.equal(normalizeMilestoneKey(24), '24h');
      assert.equal(normalizeMilestoneKey('24h'), '24h');
      assert.equal(normalizeMilestoneKey('12'), '12h');
      assert.equal(normalizeMilestoneKey(3.5), '3.5h');
    });

    it('reports a premature reset when a used pool refills mid-cycle', () => {
      const manager = openState(stateFile);
      const nowMs = Date.parse('2026-11-14T12:00:00Z');
      const resetTime = new Date(nowMs + 48 * 3600 * 1000).toISOString();

      manager.updatePoolQuota('claude', 0.4, resetTime, nowMs);
      const update = manager.updatePoolQuota('claude', 1, resetTime, nowMs + 60_000);

      assert.equal(update.cycleRolled, false);
      assert.ok(update.earlyReset);
      assert.equal(update.earlyReset?.poolId, 'claude');
      assert.equal(update.earlyReset?.previousRemainingFraction, 0.4);
      assert.equal(update.earlyReset?.remainingFraction, 1);
      assert.equal(update.earlyReset?.previousResetTime, resetTime);
      assert.equal(update.earlyReset?.resetTime, resetTime);
    });

    it('reports a premature reset once per cycle when upstream flaps back and forth', () => {
      const manager = openState(stateFile);
      const nowMs = Date.parse('2026-11-14T12:00:00Z');
      const resetTime = new Date(nowMs + 48 * 3600 * 1000).toISOString();

      manager.updatePoolQuota('claude', 0.43, resetTime, nowMs);
      const refill = manager.updatePoolQuota('claude', 1, resetTime, nowMs + 60_000);
      assert.ok(refill.earlyReset);

      const recorded = manager.recordCycleAlert({
        poolId: 'claude',
        resetTime,
        kind: 'early_reset',
        firedAt: new Date(nowMs + 60_000).toISOString(),
      });
      assert.equal(recorded, true);
      assert.equal(manager.hasEarlyResetAlert('claude', resetTime), true);

      // Drain and refill again inside the same cycle: the ledger row is the dedupe key.
      const drain = manager.updatePoolQuota('claude', 0.43, resetTime, nowMs + 120_000);
      assert.equal(drain.earlyReset, null);
      const flap = manager.updatePoolQuota('claude', 1, resetTime, nowMs + 180_000);
      assert.equal(flap.earlyReset, null);
      assert.equal(manager.getPoolState('claude')?.remainingFraction, 1);
      assert.equal(
        manager.recordCycleAlert({
          poolId: 'claude',
          resetTime,
          kind: 'early_reset',
        }),
        false
      );
    });

    it('reports a premature reset again once the cycle has moved past the recorded one', () => {
      const manager = openState(stateFile);
      const nowMs = Date.parse('2026-11-14T12:00:00Z');
      const firstReset = new Date(nowMs + 48 * 3600 * 1000).toISOString();
      const secondReset = new Date(nowMs + 96 * 3600 * 1000).toISOString();

      manager.updatePoolQuota('claude', 0.2, firstReset, nowMs);
      manager.recordCycleAlert({ poolId: 'claude', resetTime: firstReset, kind: 'early_reset' });

      // The deadline rolls on its own, then the refill lands inside the new cycle.
      manager.updatePoolQuota('claude', 0.15, secondReset, nowMs + 60_000);
      const next = manager.updatePoolQuota('claude', 1, secondReset, nowMs + 120_000);

      assert.equal(next.earlyReset?.previousResetTime, secondReset);
      assert.equal(next.earlyReset?.resetTime, secondReset);
    });

    it('reports a premature reset when the refill also moves the reset deadline', () => {
      const manager = openState(stateFile);
      const nowMs = Date.parse('2026-11-14T12:00:00Z');
      const firstReset = new Date(nowMs + 24 * 3600 * 1000).toISOString();
      const secondReset = new Date(nowMs + 7 * 24 * 3600 * 1000).toISOString();

      manager.updatePoolQuota('gemini-hydrogen', 0.2, firstReset, nowMs);
      const update = manager.updatePoolQuota('gemini-hydrogen', 1, secondReset, nowMs + 60_000);

      assert.equal(update.cycleRolled, true);
      assert.equal(update.earlyReset?.previousResetTime, firstReset);
      assert.equal(update.earlyReset?.resetTime, secondReset);
    });

    it('ignores a never-used pool whose reset time merely floats forward', () => {
      const manager = openState(stateFile);
      const nowMs = Date.parse('2026-11-14T12:00:00Z');

      manager.updatePoolQuota(
        'gemini-hydrogen',
        1,
        new Date(nowMs + 3 * 3600 * 1000).toISOString(),
        nowMs
      );
      const update = manager.updatePoolQuota(
        'gemini-hydrogen',
        1,
        new Date(nowMs + 4 * 3600 * 1000).toISOString(),
        nowMs + 60_000
      );

      assert.equal(update.cycleRolled, true);
      assert.equal(update.earlyReset, null);
      assert.equal(manager.getEarlyResetNotice(), null);
    });

    it('ignores a refill inside the five-minute guard before the scheduled reset', () => {
      const manager = openState(stateFile);
      const nowMs = Date.parse('2026-11-14T12:00:00Z');
      const resetTime = new Date(nowMs + 4 * 60_000).toISOString();

      manager.updatePoolQuota('claude', 0.1, resetTime, nowMs);
      const update = manager.updatePoolQuota('claude', 1, resetTime, nowMs + 30_000);

      assert.equal(update.earlyReset, null);
    });

    it('ignores a gain below five percentage points', () => {
      const manager = openState(stateFile);
      const nowMs = Date.parse('2026-11-14T12:00:00Z');
      const resetTime = new Date(nowMs + 24 * 3600 * 1000).toISOString();

      manager.updatePoolQuota('claude', 0.5, resetTime, nowMs);
      const update = manager.updatePoolQuota('claude', 0.54, resetTime, nowMs + 60_000);

      assert.equal(update.earlyReset, null);
    });

    it('keeps only the newest early reset notice and persists it until dismissed', async () => {
      const manager = openState(stateFile);
      await manager.load();

      manager.recordEarlyResetNotice(
        [
          {
            poolId: 'claude',
            previousRemainingFraction: 0.3,
            remainingFraction: 1,
            previousResetTime: '2026-11-16T12:00:00.000Z',
            resetTime: '2026-11-16T12:00:00.000Z',
          },
        ],
        '2026-11-14T12:00:00.000Z'
      );
      manager.recordEarlyResetNotice(
        [
          {
            poolId: 'gemini-hydrogen',
            previousRemainingFraction: 0.1,
            remainingFraction: 0.95,
            previousResetTime: '2026-11-17T12:00:00.000Z',
            resetTime: '2026-11-17T12:00:00.000Z',
          },
        ],
        '2026-11-14T13:00:00.000Z'
      );

      const notice = manager.getEarlyResetNotice();
      assert.equal(notice?.detectedAt, '2026-11-14T13:00:00.000Z');
      assert.deepEqual(
        notice?.pools.map((p) => p.poolId),
        ['gemini-hydrogen']
      );

      await manager.save();

      const reloaded = openState(stateFile);
      await reloaded.load();
      assert.equal(reloaded.getEarlyResetNotice()?.pools[0]?.poolId, 'gemini-hydrogen');

      assert.equal(reloaded.dismissEarlyResetNotice(), true);
      assert.equal(reloaded.getEarlyResetNotice(), null);
      assert.equal(reloaded.dismissEarlyResetNotice(), false);
    });

    it('keeps the fired milestones when the same reset instant is re-rendered differently', async () => {
      const manager = openState(stateFile);
      await manager.load();

      manager.updatePoolQuota('claude', 0.5, '2026-11-20T22:00:00Z');
      manager.recordMilestoneFired('claude', 24);

      // Same instant, different rendering: this is not a new cycle.
      const sameInstant = manager.updatePoolQuota('claude', 0.5, '2026-11-20T22:00:00.000Z');
      assert.equal(sameInstant.cycleRolled, false);
      assert.equal(manager.isMilestoneFired('claude', 24), true);
      assert.deepEqual(manager.getPoolState('claude')?.firedMilestones, ['24h']);

      // A genuinely different deadline is a new cycle and re-arms the milestones.
      const newCycle = manager.updatePoolQuota('claude', 0.5, '2026-11-21T22:00:00Z');
      assert.equal(newCycle.cycleRolled, true);
      assert.equal(manager.isMilestoneFired('claude', 24), false);
      assert.deepEqual(manager.getPoolState('claude')?.firedMilestones, []);
    });

    it('keeps the stored deadline and fired milestones when a probe loses the reset time', async () => {
      const manager = openState(stateFile);
      await manager.load();

      manager.updatePoolQuota('claude', 0.5, '2026-11-20T22:00:00Z');
      manager.recordMilestoneFired('claude', 24);

      const lost = manager.updatePoolQuota('claude', 0.5, '');
      assert.equal(lost.cycleRolled, false);
      assert.equal(manager.getPoolState('claude')?.resetTime, '2026-11-20T22:00:00Z');
      assert.equal(manager.isMilestoneFired('claude', 24), true);
    });

    it('does not resurrect a dismissed notice, because a dismissal is already committed', async () => {
      const manager = openState(stateFile);
      await manager.load();
      manager.recordEarlyResetNotice(
        [
          {
            poolId: 'claude',
            previousRemainingFraction: 0.3,
            remainingFraction: 1,
            previousResetTime: '2026-11-16T12:00:00.000Z',
            resetTime: '2026-11-16T12:00:00.000Z',
          },
        ],
        '2026-11-14T12:00:00.000Z'
      );

      manager.dismissEarlyResetNotice();
      await manager.save();

      const reloaded = openState(stateFile);
      await reloaded.load();
      assert.equal(reloaded.getEarlyResetNotice(), null);
    });

    it('keeps the newest state when two mutations land back to back', async () => {
      const manager = openState(stateFile);
      await manager.load();

      manager.updateProbe('cli', '2026-11-14T00:00:00.000Z');
      const first = manager.save();
      manager.updateProbe('connect_rpc', '2026-11-14T00:01:00.000Z');
      const second = manager.save();
      // `save()` is a compatibility no-op: the mutations were already durable.
      await Promise.all([first, second]);

      const reloaded = openState(stateFile);
      await reloaded.load();
      assert.equal(reloaded.getState().lastProbeSource, 'connect_rpc');
    });

    it('records a delivered alert in both alert_events and pool_milestones', () => {
      const manager = openState(stateFile);
      const resetTime = '2026-11-21T22:00:00.000Z';

      manager.updatePoolQuota('claude', 0.4, resetTime);
      manager.recordDeliveredAlert({
        poolId: 'claude',
        resetTime,
        milestoneHours: 24,
        headroomPercent: 40,
        channels: { console: { success: true } },
        firedAt: '2026-11-20T22:00:00.000Z',
      });

      const page = manager.listAlertEvents();
      assert.equal(page.events.length, 1);
      assert.equal(page.events[0]?.kind, 'milestone');
      assert.equal(page.events[0]?.milestoneHours, 24);
      assert.equal(page.events[0]?.headroomPercent, 40);
      assert.deepEqual(page.events[0]?.channels, { console: { success: true } });
      assert.equal(manager.isMilestoneFired('claude', 24), true);

      // A second identical delivery is deduped by the unique key in both tables.
      manager.recordDeliveredAlert({
        poolId: 'claude',
        resetTime,
        milestoneHours: 24,
        headroomPercent: 40,
      });
      assert.equal(manager.listAlertEvents().events.length, 1);

      // And the milestone row survives a reload, which is what stops a re-alert after a restart.
      const reloaded = openState(stateFile);
      assert.equal(reloaded.isMilestoneFired('claude', 24), true);
      assert.equal(reloaded.listAlertEvents().events.length, 1);
    });

    it('keeps an early-reset event after its notice is dismissed', () => {
      const manager = openState(stateFile);
      const previousResetTime = '2026-11-16T12:00:00.000Z';

      manager.updatePoolQuota('claude', 0.4, previousResetTime);
      manager.recordEarlyResetNotice(
        [
          {
            poolId: 'claude',
            previousRemainingFraction: 0.4,
            remainingFraction: 1,
            previousResetTime,
            resetTime: previousResetTime,
          },
        ],
        '2026-11-14T12:00:00.000Z'
      );
      manager.recordCycleAlert({
        poolId: 'claude',
        resetTime: previousResetTime,
        kind: 'early_reset',
        headroomPercent: 100,
        firedAt: '2026-11-14T12:00:00.000Z',
      });
      // The same premature reset observed twice is one event: `milestone_hours` is NULL here, and
      // the partial unique index is what makes that dedupe hold.
      manager.recordCycleAlert({
        poolId: 'claude',
        resetTime: previousResetTime,
        kind: 'early_reset',
        headroomPercent: 100,
        firedAt: '2026-11-14T12:05:00.000Z',
      });

      assert.equal(manager.dismissEarlyResetNotice(), true);
      assert.equal(manager.getEarlyResetNotice(), null);

      const events = manager.listAlertEvents().events;
      assert.equal(events.length, 1);
      assert.equal(events[0]?.kind, 'early_reset');
      assert.equal(events[0]?.milestoneHours, null);
      assert.equal(events[0]?.resetTime, previousResetTime);
    });

    it('paginates alert history newest-first with a keyset cursor', () => {
      const manager = openState(stateFile);
      const resetTime = '2026-11-21T22:00:00.000Z';

      for (let i = 0; i < 5; i++) {
        manager.recordDeliveredAlert({
          poolId: i % 2 === 0 ? 'claude' : 'gemini-hydrogen',
          resetTime,
          milestoneHours: 24 - i,
          headroomPercent: 40 + i,
          firedAt: `2026-11-20T2${i}:00:00.000Z`,
        });
      }

      const firstPage = manager.listAlertEvents({ limit: 2 });
      assert.equal(firstPage.events.length, 2);
      assert.equal(firstPage.events[0]?.milestoneHours, 20);
      assert.ok(firstPage.nextBefore);

      const secondPage = manager.listAlertEvents({ limit: 2, before: firstPage.nextBefore });
      assert.equal(secondPage.events.length, 2);
      assert.equal(secondPage.events[0]?.milestoneHours, 22);

      const lastPage = manager.listAlertEvents({ limit: 2, before: secondPage.nextBefore });
      assert.equal(lastPage.events.length, 1);
      assert.equal(lastPage.nextBefore, null);

      // A pool filter narrows the same ledger without disturbing the order.
      const filtered = manager.listAlertEvents({ poolId: 'claude' });
      assert.deepEqual(
        filtered.events.map((event) => event.poolId),
        ['claude', 'claude', 'claude']
      );
    });
  });

  // ==========================================
  // 3. Quota Evaluator Math & Late-Wake Anti-Spam
  // ==========================================
  describe('3. Quota Evaluator Math & Late-Wake Reconciliation', () => {
    it('compares the raw fraction against the threshold, not its rounded display value', () => {
      const evaluator = new QuotaEvaluator({
        milestoneHours: [24, 12, 3],
        alertThresholdPercent: 25,
      });

      const now = Date.parse('2026-11-14T12:00:00Z');
      const makeSnapshot = (remainingFraction: number) => ({
        poolId: 'claude',
        family: 'claude' as const,
        displayName: 'Claude 5.5 / Opus',
        remainingFraction,
        resetTime: new Date(now + 23 * 3600 * 1000).toISOString(), // inside the 24h milestone
        hoursUntilReset: 23,
        models: ['Claude Sonnet 5.5'],
      });

      // 24.95% rounds to 25.0 for display but is still below a 25% floor.
      assert.equal(evaluator.evaluatePool(makeSnapshot(0.2495), [], now).alert, null);

      const atFloor = evaluator.evaluatePool(makeSnapshot(0.25), [], now);
      assert.ok(atFloor.alert);
      assert.equal(atFloor.alert.milestoneHours, 24);
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
      // Never the default `data/state.json`: a test must not write into the repository.
      const { dir, cleanup } = makeTempDir('sentry_evaluator_');
      const stateManager = new SentryStateManager({
        db: new AppDatabase(join(dir, 'evaluator.db')),
      });
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

      try {
        // First run: fires 3h milestone, supersedes 24 and 12
        const alerts = evaluator.evaluate(snapshots, stateManager);
        assert.equal(alerts.length, 1);
        assert.equal(alerts[0]?.milestoneHours, 3);

        assert.equal(stateManager.isMilestoneFired('claude', 3), true);
        assert.equal(stateManager.isMilestoneFired('claude', 12), true);
        assert.equal(stateManager.isMilestoneFired('claude', 24), true);

        // Second run immediately after: zero new alerts
        const alerts2 = evaluator.evaluate(snapshots, stateManager);
        assert.equal(alerts2.length, 0);
      } finally {
        stateManager.close();
        cleanup();
      }
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

    it('fails closed when the CLI can only report models, not quota', async () => {
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
                  { id: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen (Low)' },
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

      // Detected pools are reported as unknown rather than invented at 100% headroom,
      // so the probe reports failure and dispatch stays locked.
      await assert.rejects(async () => {
        await client.fetchQuota();
      });
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
      assert.equal(snapshots[0]?.remainingFraction, 0.42);
      // Recalculated hoursUntilReset should be approximately 5, not stale 10
      assert.ok(
        snapshots[0]?.hoursUntilReset !== undefined &&
          snapshots[0].hoursUntilReset >= 4.9 &&
          snapshots[0].hoursUntilReset <= 5.1
      );
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

        // Gemini Hydrogen: weekly is 0.73, 5h is 0.99
        const flash = snapshots.find((s) => s.family === 'gemini-hydrogen');
        assert.ok(flash);
        assert.equal(flash.remainingFraction, 0.73);
        assert.equal(flash.shortTerm?.remainingFraction, 0.99);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('gives a second group for one family its own pool id and name', () => {
      const summary = RetrieveUserQuotaSummaryResponseSchema.parse({
        response: {
          groups: [
            {
              displayName: 'Gemini Models',
              buckets: [
                {
                  bucketId: 'gemini-weekly',
                  displayName: 'Weekly Limit',
                  remainingFraction: 0.8,
                  resetTime: '2026-11-20T22:00:00.000Z',
                },
              ],
            },
            {
              displayName: 'Gemini Pro',
              buckets: [
                {
                  bucketId: 'gemini-pro-weekly',
                  displayName: 'Weekly Limit',
                  remainingFraction: 0.4,
                  resetTime: '2026-11-21T22:00:00.000Z',
                },
              ],
            },
          ],
        },
      });

      const snapshots = aggregateUserQuotaSummary(summary);
      assert.equal(snapshots.length, 2);
      // Sharing a pool id would flip the stored deadline between the two on every poll.
      assert.deepEqual(
        snapshots.map((s) => s.poolId),
        ['gemini-hydrogen', 'gemini-hydrogen:gemini-pro']
      );
      assert.deepEqual(
        snapshots.map((s) => s.displayName),
        ['Gemini Hydrogen', 'Gemini Pro']
      );
      assert.equal(snapshots[1]?.family, 'gemini-hydrogen');

      // The cached state path must still resolve a qualified id back to its family.
      const cached = snapshotsFromSentryState({
        pools: {
          'gemini-hydrogen:gemini-pro': {
            resetTime: '2026-11-21T22:00:00.000Z',
            remainingFraction: 0.4,
            firedMilestones: [],
          },
        },
      });
      assert.equal(cached.length, 1);
      assert.equal(cached[0]?.family, 'gemini-hydrogen');
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

      // 3. No overage signal at all: unknown, distinct from disabled
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
      assert.equal(snapshotsOmitted[0]?.overageEnabled, undefined);
    });

    it('ignores Google\'s stale "Models within this group" description for pool models', () => {
      const parsed = RetrieveUserQuotaSummaryResponseSchema.parse({
        response: {
          groups: [
            {
              displayName: 'Gemini Models',
              description: 'Models within this group: Gemini Flash, Gemini Pro',
              buckets: [
                {
                  bucketId: 'gemini-weekly',
                  displayName: 'Weekly Limit',
                  remainingFraction: 0.73,
                  resetTime: new Date(Date.now() + 120 * 3600 * 1000).toISOString(),
                },
              ],
            },
            {
              displayName: 'Claude and GPT models',
              description: 'Models within this group: Gemini Flash, Gemini Pro',
              buckets: [
                {
                  bucketId: '3p-weekly',
                  displayName: 'Weekly Limit',
                  remainingFraction: 0.49,
                  resetTime: new Date(Date.now() + 27 * 3600 * 1000).toISOString(),
                },
              ],
            },
          ],
        },
      });

      const snapshots = aggregateUserQuotaSummary(parsed);
      const flash = snapshots.find((s) => s.family === 'gemini-hydrogen');
      const claude = snapshots.find((s) => s.family === 'claude');

      assert.ok(flash);
      assert.ok(claude);
      assert.deepEqual(flash.models, ['Gemini 4 Hydrogen', 'Gemini 4 Neon', 'Gemini 3.8 Flash']);
      assert.deepEqual(claude.models, ['Claude Opus', 'Claude Sonnet', 'GPT-OSS']);
    });

    it('falls back to clean canonical model labels when synthesizing from sentry state', () => {
      const snapshots = snapshotsFromSentryState({
        pools: {
          'gemini-hydrogen': {
            resetTime: new Date(Date.now() + 3600 * 1000).toISOString(),
            remainingFraction: 0.8,
          },
          'gemini-argon': {
            resetTime: new Date(Date.now() + 3600 * 1000).toISOString(),
            remainingFraction: 0.5,
          },
          claude: {
            resetTime: new Date(Date.now() + 3600 * 1000).toISOString(),
            remainingFraction: 0.4,
          },
        },
      });

      assert.equal(snapshots.length, 3);
      const byFamily = new Map(snapshots.map((snapshot) => [snapshot.family, snapshot]));
      assert.deepEqual(byFamily.get('gemini-hydrogen')?.models, [
        'Gemini 4 Hydrogen',
        'Gemini 4 Neon',
        'Gemini 3.8 Flash',
      ]);
      assert.deepEqual(byFamily.get('gemini-argon')?.models, ['Gemini 4 Argon']);
      assert.deepEqual(byFamily.get('claude')?.models, ['Claude Opus', 'Claude Sonnet', 'GPT-OSS']);
    });

    it('skips prototype-named pool keys instead of synthesizing an inherited pool', () => {
      const state = {
        version: 1,
        lastProbeAt: '2026-11-14T12:00:00.000Z',
        lastProbeSource: 'connect_rpc',
        pools: {
          constructor: {
            resetTime: new Date(Date.now() + 3600 * 1000).toISOString(),
            remainingFraction: 0.9,
            firedMilestones: [],
          },
        },
      };

      // `constructor` is an inherited member of a plain object, not a pool alias.
      const snapshots = snapshotsFromSentryState(
        state as unknown as Parameters<typeof snapshotsFromSentryState>[0]
      );
      assert.deepEqual(snapshots, []);
    });

    it('derives overageEnabled from GetUserStatus and keeps unknown distinct from disabled', () => {
      // Real GetUserStatus shape: paid flex credits + canBuyMoreCredits => overage enabled
      const enabled = GetUserStatusResponseSchema.parse({
        userStatus: {
          planStatus: {
            planInfo: {
              teamsTier: 'TEAMS_TIER_PRO',
              planName: 'Pro',
              monthlyPromptCredits: 50000,
              monthlyFlowCredits: 150000,
              monthlyFlexCreditPurchaseAmount: 25000,
              canBuyMoreCredits: true,
            },
          },
        },
      });
      assert.equal(deriveOverageEnabled(enabled), true);

      const flexOnly = GetUserStatusResponseSchema.parse({
        userStatus: {
          planStatus: {
            planInfo: { monthlyFlexCreditPurchaseAmount: 0, canBuyMoreCredits: false },
          },
        },
      });
      assert.equal(deriveOverageEnabled(flexOnly), false);

      const noSignal = GetUserStatusResponseSchema.parse({ userStatus: { planStatus: {} } });
      assert.equal(deriveOverageEnabled(noSignal), undefined);
      assert.equal(deriveOverageEnabled(undefined), undefined);
    });

    it('non-blocking background credits probe queries without blocking fetchQuota and caches balance', async () => {
      let capturedCmd = '';
      let capturedArgs: readonly string[] = [];
      let capturedOptions: Record<string, unknown> = {};

      const mockExecFile = async (
        file: string,
        args: readonly string[],
        options: Record<string, unknown>
      ) => {
        capturedCmd = file;
        capturedArgs = args;
        capturedOptions = options;
        return {
          stdout: JSON.stringify({
            command: {
              name: 'credits',
              data: { remaining_credits: 717 },
            },
          }),
          stderr: '',
        };
      };

      const nowMs = Date.now();
      const testQuotaSummary = {
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
              ],
            },
          ],
        },
      };

      const server = createServer((req, res) => {
        if (req.url === QUOTA_SUMMARY_RPC_PATH && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(testQuotaSummary));
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
          execFileFn: mockExecFile as any,
        });

        // 1. fetchQuota returns immediately without blocking
        const snapshots = await client.fetchQuota();
        assert.equal(snapshots.length, 1);

        // 2. Await the background refresh probe directly
        const credits = await client.triggerCreditsRefreshInBackground(true);
        assert.equal(credits, 717);
        assert.equal(await client.getRemainingCredits(), 717);

        // 3. Verify execution hygiene: direct binary execution with windowsHide to prevent terminal windows from popping up
        assert.equal(capturedCmd, 'agy');
        assert.deepEqual(capturedArgs, ['--output-format', 'json', '-p', '/credits']);
        assert.equal(capturedOptions.windowsHide, true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('CLI auth failure triggers actionable message and engages 5-minute circuit breaker to stop retry loops', async () => {
      let execCount = 0;
      const mockExecFile: ExecFileAsyncFn = async () => {
        execCount++;
        throw new Error(
          'Command failed: agy --output-format json models\nError: Please sign in to view available models. Launch the CLI without arguments to sign in.'
        );
      };

      const client = new ConnectRpcQuotaClient({
        port: 59998,
        fallbackPorts: [59998],
        enableCliFallback: true,
        enableProcessDiscovery: false,
        timeoutMs: 200,
        execFileFn: mockExecFile as any,
      });

      // 1. Initial attempt fails with AUTH_REQUIRED and actionable text
      await assert.rejects(
        () => client.fetchQuota(),
        (err: any) => {
          assert.equal(err.code, 'AUTH_REQUIRED');
          assert.ok(err.message.includes('Antigravity CLI is not authenticated'));
          return true;
        }
      );
      assert.equal(execCount, 1, 'Executed agy once on initial failure');

      // 2. Second attempt within cooldown window is blocked by circuit breaker without executing agy
      await assert.rejects(
        () => client.fetchQuota(),
        (err: any) => {
          assert.equal(err.code, 'AUTH_REQUIRED');
          return true;
        }
      );
      assert.equal(execCount, 1, 'Circuit breaker prevented repeated CLI execution');

      // 3. Forcing refresh bypasses the circuit breaker
      await assert.rejects(
        () => client.fetchQuota(true),
        (err: any) => {
          assert.equal(err.code, 'AUTH_REQUIRED');
          return true;
        }
      );
      assert.equal(execCount, 2, 'Forced refresh executed CLI again');
    });

    it('reads overageEnabled from the GetUserStatus plan signal', async () => {
      const nowMs = Date.now();
      const quotaSummary = {
        response: {
          groups: [
            {
              displayName: 'Gemini Models',
              buckets: [
                {
                  bucketId: 'gemini-weekly',
                  displayName: 'Weekly Limit',
                  remainingFraction: 0.85,
                  resetTime: new Date(nowMs + 120 * 3600 * 1000).toISOString(),
                },
              ],
            },
          ],
        },
      };
      const userStatus = {
        userStatus: {
          planStatus: {
            planInfo: {
              teamsTier: 'TEAMS_TIER_PRO',
              planName: 'Pro',
              monthlyPromptCredits: 50000,
              monthlyFlowCredits: 150000,
              monthlyFlexCreditPurchaseAmount: 25000,
              canBuyMoreCredits: true,
            },
          },
        },
      };

      let serveUserStatus = true;
      const server = createServer((req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }
        if (!serveUserStatus && req.url === USER_STATUS_RPC_PATH) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(req.url === USER_STATUS_RPC_PATH ? userStatus : quotaSummary));
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as any).port;

      const mockExecFile = async () => ({
        stdout: JSON.stringify({ command: { name: 'credits', data: { remaining_credits: 675 } } }),
        stderr: '',
      });

      try {
        const client = new ConnectRpcQuotaClient({
          endpointUrl: `http://127.0.0.1:${port}`,
          csrfToken: 'test-token',
          timeoutMs: 1000,
          enableCliFallback: false,
          execFileFn: mockExecFile as any,
        });

        const snapshots = await client.fetchQuota();
        assert.equal(snapshots.length, 1);
        assert.equal(snapshots[0]?.overageEnabled, true);

        // Absent plan signal: the flag stays undefined instead of being guessed.
        serveUserStatus = false;
        const withoutStatus = new ConnectRpcQuotaClient({
          endpointUrl: `http://127.0.0.1:${port}`,
          csrfToken: 'test-token',
          timeoutMs: 1000,
          enableCliFallback: false,
          execFileFn: mockExecFile as any,
        });
        const bareSnapshots = await withoutStatus.fetchQuota();
        assert.equal(bareSnapshots.length, 1);
        assert.equal(bareSnapshots[0]?.overageEnabled, undefined);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('rolls a fresh synthetic reset for a degraded fallback probe older than 24 hours', async () => {
      const staleReset = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
      const cachedProvider = () => [
        {
          poolId: 'claude',
          family: 'claude' as const,
          displayName: 'Claude 5.5 / Opus',
          remainingFraction: 0.42,
          resetTime: staleReset,
          hoursUntilReset: 0,
          models: ['Claude Sonnet 5.5'],
        },
      ];

      const mockExecFile = async () => ({
        stdout: JSON.stringify({
          status: 'SUCCESS',
          command: { name: 'models', data: { models: [{ id: 'claude-sonnet-5-5-high' }] } },
        }),
        stderr: '',
      });

      const client = new ConnectRpcQuotaClient({
        port: 59997,
        fallbackPorts: [59997],
        csrfToken: 'invalid',
        enableCliFallback: true,
        enableProcessDiscovery: false,
        timeoutMs: 300,
        cachedSnapshotProvider: cachedProvider,
        execFileFn: mockExecFile as any,
      });

      const snapshots = await client.fetchQuota();
      assert.equal(snapshots.length, 1);
      // An elapsed degraded window must not be reported as full headroom
      assert.equal(snapshots[0]?.remainingFraction, 0.42);
      // The synthetic reset rolls forward instead of freezing at zero
      assert.ok((snapshots[0]?.hoursUntilReset ?? 0) > 23);
      assert.equal(client.getLastProbeSource(), 'cli_fallback');
    });

    it('probes for the CSRF token even when ports were already discovered', async () => {
      const mockExec = async (file: string) => {
        if (file === 'tasklist') {
          return { stdout: '"language_server.exe","1234","Console","1","123,456 K"', stderr: '' };
        }
        if (file === 'netstat') {
          return {
            stdout: [
              '  Proto  Local Address          Foreign Address        State           PID',
              '  TCP    127.0.0.1:60643        0.0.0.0:0              LISTENING       1234',
            ].join('\r\n'),
            stderr: '',
          };
        }
        if (file === 'powershell.exe') {
          return {
            stdout:
              'CMD:C:\\tools\\language_server.exe --csrf_token abc123secret --https_server_port 60642\nPORTS:60642',
            stderr: '',
          };
        }
        return { stdout: '', stderr: '' };
      };

      const discovered = await discoverWindowsLanguageServer(mockExec as any);
      assert.ok(discovered);
      assert.equal(discovered.csrfToken, 'abc123secret');
      assert.ok(discovered.ports?.includes(60643));
    });
  });

  // ==========================================
  // 5. Process Discovery
  // ==========================================
  describe('5. Process Discovery', () => {
    it('matches the language_server PID as an exact netstat column, not a substring', () => {
      const netstat = [
        '  Proto  Local Address          Foreign Address        State           PID',
        '  TCP    127.0.0.1:51234        0.0.0.0:0              LISTENING       9999',
        '  TCP    127.0.0.1:60643        0.0.0.0:0              LISTENING       1234',
        '  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       1234',
        '  TCP    [::1]:60644            0.0.0.0:0              LISTENING       1234',
      ].join('\r\n');

      // pid 1234 appears inside the first row's port (51234) but that row belongs to pid 9999
      assert.deepEqual(parseWindowsNetstatPorts(netstat, '1234'), [60643, 60644]);
    });
  });

  // ==========================================
  // 6. Burn-Rate Sampling & Projection
  // ==========================================
  describe('6. Burn-Rate Sampling & Projection', () => {
    const testDir = join(
      tmpdir(),
      'test_sentry_burn_' + Date.now() + '_' + Math.random().toString(36).slice(2)
    );
    const stateFile = join(testDir, 'state.json');

    const NOW_MS = Date.parse('2026-11-14T12:00:00Z');
    const MINUTE_MS = 60_000;
    const cycleReset = new Date(NOW_MS + 2 * 3600 * 1000).toISOString();
    const nextCycleReset = new Date(NOW_MS + 7 * 24 * 3600 * 1000).toISOString();

    const sampleAt = (
      minutesAgo: number,
      remainingFraction: number,
      resetTime: string = cycleReset
    ): BurnSample => ({
      at: new Date(NOW_MS - minutesAgo * MINUTE_MS).toISOString(),
      remainingFraction,
      resetTime,
    });

    // The ledger holds its file open, so it is closed before the temp directory goes away.
    const opened: SentryStateManager[] = [];
    const openState = (statePath: string = stateFile): SentryStateManager => {
      const manager = new SentryStateManager(statePath);
      opened.push(manager);
      return manager;
    };

    beforeEach(() => {
      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
      mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
      for (const manager of opened) manager.close();
      opened.length = 0;
      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    });

    it('appends a sample once ten minutes have passed', () => {
      const manager = openState();

      manager.updatePoolQuota('claude', 0.8, cycleReset, NOW_MS);
      manager.updatePoolQuota('claude', 0.795, cycleReset, NOW_MS + 59_000);
      assert.equal(manager.getPoolState('claude')?.samples?.length, 1);

      manager.updatePoolQuota('claude', 0.78, cycleReset, NOW_MS + 10 * MINUTE_MS);
      const samples = manager.getPoolState('claude')?.samples ?? [];
      assert.equal(samples.length, 2);
      assert.equal(samples[1]?.at, new Date(NOW_MS + 10 * MINUTE_MS).toISOString());
      assert.equal(samples[1]?.remainingFraction, 0.78);
      assert.equal(samples[1]?.resetTime, cycleReset);
    });

    it('ignores a rapid observation whose drain is below the noise floor', () => {
      const manager = openState();

      manager.updatePoolQuota('claude', 0.8, cycleReset, NOW_MS);
      manager.updatePoolQuota('claude', 0.795, cycleReset, NOW_MS + 30_000);

      const samples = manager.getPoolState('claude')?.samples ?? [];
      assert.equal(samples.length, 1);
      assert.equal(samples[0]?.remainingFraction, 0.8);
    });

    it('records a recent observation once the drain reaches a whole percent', () => {
      const manager = openState();

      manager.updatePoolQuota('claude', 0.9, cycleReset, NOW_MS);
      manager.updatePoolQuota('claude', 0.88, cycleReset, NOW_MS + 30_000);

      const samples = manager.getPoolState('claude')?.samples ?? [];
      assert.equal(samples.length, 2);
      assert.equal(samples[1]?.remainingFraction, 0.88);
    });

    it('clears the history when the reset time rolls into a new cycle', () => {
      const manager = openState();

      manager.updatePoolQuota('claude', 0.5, cycleReset, NOW_MS);
      manager.updatePoolQuota('claude', 0.45, cycleReset, NOW_MS + 20 * MINUTE_MS);
      assert.equal(manager.getPoolState('claude')?.samples?.length, 2);

      const rolled = manager.updatePoolQuota('claude', 1, nextCycleReset, NOW_MS + 21 * MINUTE_MS);
      assert.equal(rolled.cycleRolled, true);

      const samples = manager.getPoolState('claude')?.samples ?? [];
      assert.equal(samples.length, 1);
      assert.equal(samples[0]?.remainingFraction, 1);
      assert.equal(samples[0]?.resetTime, nextCycleReset);
    });

    it('clears the history when an early refill restarts the balance', () => {
      const manager = openState();

      manager.updatePoolQuota('claude', 0.4, cycleReset, NOW_MS);
      manager.updatePoolQuota('claude', 0.35, cycleReset, NOW_MS + 20 * MINUTE_MS);
      const update = manager.updatePoolQuota('claude', 1, cycleReset, NOW_MS + 21 * MINUTE_MS);

      assert.ok(update.earlyReset);
      const samples = manager.getPoolState('claude')?.samples ?? [];
      assert.equal(samples.length, 1);
      assert.equal(samples[0]?.remainingFraction, 1);
    });

    it('keeps only the newest twenty-four samples', () => {
      const manager = openState();
      let nowMs = NOW_MS;

      for (let i = 0; i < 30; i++) {
        manager.updatePoolQuota('claude', 1 - i * 0.02, cycleReset, nowMs);
        nowMs += 11 * MINUTE_MS;
      }

      const samples = manager.getPoolState('claude')?.samples ?? [];
      assert.equal(samples.length, 24);
      assert.equal(samples[0]?.remainingFraction, 1 - 6 * 0.02);
      assert.equal(samples[23]?.remainingFraction, 1 - 29 * 0.02);
    });

    it('round-trips samples and still loads a state file written before them', async () => {
      const manager = openState();
      manager.updatePoolQuota('claude', 0.8, cycleReset, NOW_MS);
      manager.updatePoolQuota('claude', 0.7, cycleReset, NOW_MS + 30 * MINUTE_MS);
      await manager.save();

      const reloaded = openState();
      await reloaded.load();
      assert.equal(reloaded.getPoolState('claude')?.samples?.length, 2);

      const legacyFile = join(testDir, 'legacy.json');
      writeFileSync(
        legacyFile,
        JSON.stringify({
          version: 1,
          lastProbeAt: new Date(NOW_MS).toISOString(),
          lastProbeSource: 'connect_rpc',
          pools: { claude: { resetTime: cycleReset, remainingFraction: 0.5, firedMilestones: [] } },
        }),
        'utf-8'
      );

      const legacy = openState(legacyFile);
      const loaded = await legacy.load();
      assert.deepEqual(loaded.pools, {
        claude: { resetTime: cycleReset, remainingFraction: 0.5, firedMilestones: [] },
      });
    });

    it('projects nothing from fewer than two samples in the current cycle', () => {
      assert.equal(
        computeBurnProjection({ samples: [], resetTime: cycleReset, nowMs: NOW_MS }),
        undefined
      );
      assert.equal(
        computeBurnProjection({
          samples: [sampleAt(30, 0.8)],
          resetTime: cycleReset,
          nowMs: NOW_MS,
        }),
        undefined
      );
      // Samples from the previous cycle describe a balance the current one no longer has.
      assert.equal(
        computeBurnProjection({
          samples: [sampleAt(120, 0.9, nextCycleReset), sampleAt(30, 0.6, nextCycleReset)],
          resetTime: cycleReset,
          nowMs: NOW_MS,
        }),
        undefined
      );
    });

    it('projects nothing when the samples span under five minutes', () => {
      assert.equal(
        computeBurnProjection({
          samples: [sampleAt(4, 0.8), sampleAt(0, 0.7)],
          resetTime: cycleReset,
          nowMs: NOW_MS,
        }),
        undefined
      );
      // Five minutes is the inclusive boundary of a usable window.
      assert.ok(
        computeBurnProjection({
          samples: [sampleAt(5, 0.8), sampleAt(0, 0.7)],
          resetTime: cycleReset,
          nowMs: NOW_MS,
        })
      );
    });

    it('projects nothing for a flat or refilling pool', () => {
      assert.equal(
        computeBurnProjection({
          samples: [sampleAt(60, 0.8), sampleAt(0, 0.8)],
          resetTime: cycleReset,
          nowMs: NOW_MS,
        }),
        undefined
      );
      assert.equal(
        computeBurnProjection({
          samples: [sampleAt(60, 0.5), sampleAt(0, 0.9)],
          resetTime: cycleReset,
          nowMs: NOW_MS,
        }),
        undefined
      );
    });

    it('derives a linear burn rate and the projected headroom at reset', () => {
      const projection = computeBurnProjection({
        samples: [sampleAt(60, 0.8), sampleAt(0, 0.72)],
        resetTime: cycleReset,
        nowMs: NOW_MS,
      });

      assert.ok(projection);
      assert.ok(Math.abs(projection.burnRatePerHour - 0.08) < 1e-9);
      // 0.72 - 0.08/h x 2h remaining
      assert.equal(projection.projectedRemainingAtResetPercent, 56);
      // (0.72 - 0.10 floor) / 0.08 per hour = 7.75h of headroom left
      assert.ok(projection.hoursUntilFloor !== null);
      assert.ok(Math.abs(projection.hoursUntilFloor - 7.75) < 1e-6);
    });

    it('clamps a projection that would run past zero before the reset', () => {
      const farReset = new Date(NOW_MS + 48 * 3600 * 1000).toISOString();
      const projection = computeBurnProjection({
        samples: [sampleAt(60, 0.9, farReset), sampleAt(0, 0.8, farReset)],
        resetTime: farReset,
        nowMs: NOW_MS,
      });

      assert.ok(projection);
      assert.equal(projection.projectedRemainingAtResetPercent, 0);
      assert.ok(projection.hoursUntilFloor !== null);
    });

    it('reports no hours to floor once the pool sits at it', () => {
      const projection = computeBurnProjection({
        samples: [sampleAt(60, 0.2), sampleAt(0, 0.05)],
        resetTime: cycleReset,
        nowMs: NOW_MS,
      });

      assert.ok(projection);
      assert.equal(projection.hoursUntilFloor, null);
      assert.equal(projection.projectedRemainingAtResetPercent, 0);
    });

    it('attaches a burn projection only to pools carrying enough samples', () => {
      const snapshots = snapshotsFromSentryState(
        {
          pools: {
            claude: {
              resetTime: cycleReset,
              remainingFraction: 0.72,
              firedMilestones: [],
              samples: [sampleAt(60, 0.8), sampleAt(0, 0.72)],
            },
            'gemini-hydrogen': {
              resetTime: nextCycleReset,
              remainingFraction: 0.9,
              firedMilestones: [],
            },
            'gemini-argon': {
              resetTime: nextCycleReset,
              remainingFraction: 0.5,
              firedMilestones: [],
              samples: [sampleAt(30, 0.5, nextCycleReset)],
            },
          },
        },
        NOW_MS
      );

      const byFamily = new Map(snapshots.map((snapshot) => [snapshot.family, snapshot]));
      assert.equal(byFamily.get('claude')?.burnProjection?.projectedRemainingAtResetPercent, 56);
      assert.equal(byFamily.get('gemini-hydrogen')?.burnProjection, undefined);
      // A single sample is history, but not a rate.
      assert.equal(byFamily.get('gemini-argon')?.burnProjection, undefined);

      // The emitted snapshot must survive the API payload schema.
      const parsed = QuotaSnapshotSchema.parse(byFamily.get('claude'));
      assert.equal(parsed.burnProjection?.projectedRemainingAtResetPercent, 56);
    });
  });
});

describe('Process execution (defaultExecFileAsync)', () => {
  it('kills a command that overruns its timeout instead of leaving it running', async () => {
    const marker = join(
      tmpdir(),
      `agylity-kill-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const script =
      `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 900);` +
      `setTimeout(() => {}, 6000);`;

    await assert.rejects(
      defaultExecFileAsync(process.execPath, ['-e', script], { timeout: 250 }),
      (err: any) => err?.killed === true && err?.code === 'ETIMEDOUT'
    );

    // The child is gone, so the write it had scheduled for later never happens.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(existsSync(marker), false);
  });

  it('resolves stdout and rejects a non-zero exit with the captured streams', async () => {
    const ok = await defaultExecFileAsync(process.execPath, ['-e', "console.log('hello')"]);
    assert.equal(ok.stdout.trim(), 'hello');

    await assert.rejects(
      defaultExecFileAsync(process.execPath, ['-e', "console.error('boom'); process.exit(3)"]),
      (err: any) => {
        assert.equal(err.code, 3);
        assert.match(err.stderr, /boom/);
        return true;
      }
    );
  });
});
