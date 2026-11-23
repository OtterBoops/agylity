import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  CANONICAL_AGY_MODELS,
  POOL_GROUPS,
  type AgyModelCatalogEntry,
  type PoolGroup,
} from '../../src/shared/models.js';
import {
  evaluateModelDispatchEligibility,
  evaluateModelPreferenceChain,
  highestAvailableModelForPoolGroup,
  resolveAvailableModelId,
  resolveDefaultDispatchModel,
} from '../../src/coordinator/models.js';
import { snapshotsFromSentryState, type QuotaSnapshot } from '../../src/sentry/models.js';
import { SentryStateManager } from '../../src/sentry/state.js';
import { QuotaEvaluator } from '../../src/sentry/evaluator.js';
import { AppDatabase } from '../../src/storage/db.js';
import { QUOTA_GRID_COLUMNS, quotaGridPlaceholders } from '../../src/shared/layout.js';
import { makeTempDir } from '../e2e/harness/index.js';

const canonicalEntry = (id: string): AgyModelCatalogEntry => {
  const entry = CANONICAL_AGY_MODELS.find((model) => model.id === id);
  assert.ok(entry, `expected ${id} in the bundled catalog`);
  return entry;
};

const catalogOf = (...ids: string[]): AgyModelCatalogEntry[] => ids.map(canonicalEntry);

/**
 * AI Plus serves one Gemini model and one Claude model. Every Gemini codename now bills the single
 * merged gemini pool, so Hydrogen is withheld here rather than moved to a pool of its own.
 */
const AI_PLUS_CATALOG = catalogOf('gemini-3.8-flash', 'claude-sonnet-5-5');

const resetTime = new Date(Date.now() + 20 * 3600 * 1000).toISOString();

const poolSnapshot = (poolGroup: PoolGroup, remainingFraction = 0.8): QuotaSnapshot => ({
  poolId: poolGroup,
  poolGroup,
  displayName: poolGroup,
  remainingFraction,
  resetTime,
  hoursUntilReset: 20,
  models: [],
  weekly: {
    bucketId: `${poolGroup}-weekly`,
    displayName: 'Weekly Limit',
    window: 'weekly',
    remainingFraction,
    resetTime,
    hoursUntilReset: 20,
  },
});

describe('AI Plus edge cases', () => {
  describe('quota grid columns', () => {
    it('renders one cell per merged pool group in a two-column grid', () => {
      assert.deepEqual(POOL_GROUPS, ['gemini', 'claude']);
      assert.equal(QUOTA_GRID_COLUMNS, 'grid-cols-1 md:grid-cols-2');
    });

    it('fills an odd row with a single placeholder that only shows at the two-column breakpoint', () => {
      for (const count of [2, 4, 6]) {
        assert.deepEqual(quotaGridPlaceholders(count), [], `${count} cells fill every row`);
      }

      for (const count of [1, 3, 5]) {
        const slots = quotaGridPlaceholders(count);
        assert.equal(slots.length, 1, `${count} cells leave one gap in the last row`);
        assert.deepEqual(
          slots.map((slot) => slot.className),
          ['hidden md:flex']
        );
      }
    });
  });

  describe('default dispatch model', () => {
    it('falls back to the newest model the same pool group still serves', () => {
      assert.equal(
        resolveAvailableModelId('gemini-4-hydrogen', AI_PLUS_CATALOG),
        'gemini-3.8-flash'
      );
      assert.equal(
        resolveDefaultDispatchModel('gemini-4-hydrogen', AI_PLUS_CATALOG),
        'gemini-3.8-flash'
      );
    });

    it('resolves an Argon codename inside the merged gemini pool rather than off it', () => {
      // Argon and Hydrogen now bill one pool, so the tier's one Gemini model serves both.
      assert.equal(resolveDefaultDispatchModel('argon', AI_PLUS_CATALOG), 'gemini-3.8-flash');
      assert.equal(resolveAvailableModelId('gemini-4-argon', AI_PLUS_CATALOG), 'gemini-3.8-flash');
    });

    it('leaves a served model and the full catalog untouched', () => {
      assert.equal(
        resolveDefaultDispatchModel('gemini-4-hydrogen', CANONICAL_AGY_MODELS),
        'gemini-4-hydrogen'
      );
      assert.equal(
        resolveAvailableModelId('claude-sonnet-5-5', AI_PLUS_CATALOG),
        'claude-sonnet-5-5'
      );
    });

    it('leaves a model alone when its own pool group has no live pool', () => {
      const geminiOnly = catalogOf('gemini-3.8-flash');
      // The claude group has no candidate at all here, so the id survives and eligibility locks.
      assert.equal(resolveAvailableModelId('claude-opus-5-5', geminiOnly), 'claude-opus-5-5');
      // A route is never swapped for a model, or dispatch would silently leave the route.
      assert.equal(
        resolveAvailableModelId('gemini-pro-orchestrator-argon', AI_PLUS_CATALOG),
        'gemini-pro-orchestrator-argon'
      );
    });

    it('picks the newest model in the group and ignores orchestrator routes', () => {
      const catalog = [
        ...catalogOf('gemini-3.8-flash', 'gemini-4-neon'),
        {
          id: 'gemini-pro-orchestrator',
          label: 'Gemini Pro Orchestrator',
          poolGroup: 'gemini' as const,
          defaultEffort: 'medium' as const,
        },
      ];
      assert.equal(highestAvailableModelForPoolGroup('gemini', catalog), 'gemini-4-neon');
      assert.equal(
        highestAvailableModelForPoolGroup('gemini', AI_PLUS_CATALOG),
        'gemini-3.8-flash'
      );
    });
  });

  describe('pool group eligibility', () => {
    it('authorises the substituted model against the one gemini pool', () => {
      const result = evaluateModelDispatchEligibility({
        requestedModel: 'gemini-4-hydrogen',
        pools: [poolSnapshot('gemini')],
        catalog: AI_PLUS_CATALOG,
      });
      assert.equal(result.allowed, true);
      assert.equal(result.resolvedModel, 'gemini-3.8-flash');
      assert.equal(result.poolGroup, 'gemini');
    });

    it('resolves a preference chain onto the model the tier actually serves', () => {
      const result = evaluateModelPreferenceChain({
        cascade: [{ model: 'gemini-4-hydrogen', effort: 'medium' }],
        pools: [poolSnapshot('gemini')],
        minHeadroomPercent: 10,
        catalog: AI_PLUS_CATALOG,
      });
      assert.equal(result.allowed, true);
      assert.equal(result.selectedModel, 'gemini-3.8-flash');
      assert.equal(result.poolGroup, 'gemini');
    });

    it('still refuses a pool group the account holds no pool for', () => {
      const result = evaluateModelPreferenceChain({
        cascade: [{ model: 'claude-opus-5-5', effort: 'high' }],
        pools: [poolSnapshot('gemini')],
        minHeadroomPercent: 10,
        catalog: AI_PLUS_CATALOG,
      });
      assert.equal(result.allowed, false);
      assert.match(result.reason ?? '', /no telemetry pool/);
      assert.match(result.reason ?? '', /claude-sonnet-5-5 \(claude\)/);
    });
  });

  describe('pool state reconciliation', () => {
    it('retires a pool the probe stopped reporting and keeps the rest', () => {
      const { dir, cleanup } = makeTempDir('ai_plus_pools_');
      const db = new AppDatabase(join(dir, 'pools.db'));
      const manager = new SentryStateManager({ db });
      try {
        manager.updatePoolQuota('gemini', 0.9, resetTime);
        manager.updatePoolQuota('claude', 0.5, resetTime);
        manager.recordMilestoneFired('claude', 24);
        assert.equal(snapshotsFromSentryState(manager.getState()).length, 2);

        const retired = manager.reconcilePools(['gemini']);

        assert.deepEqual(retired, ['claude']);
        assert.deepEqual(Object.keys(manager.getState().pools), ['gemini']);
        assert.deepEqual(
          snapshotsFromSentryState(manager.getState()).map((snapshot) => snapshot.poolId),
          ['gemini']
        );

        const raw = db.getRawDb();
        for (const table of ['pool_state', 'pool_milestones', 'pool_samples']) {
          const row = raw
            .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE pool_id = 'claude'`)
            .get() as { c: number };
          assert.equal(row.c, 0, `${table} must not keep the retired pool`);
        }
      } finally {
        db.close();
        cleanup();
      }
    });

    it('treats an empty probe as no information and keeps every pool', () => {
      const { dir, cleanup } = makeTempDir('ai_plus_pools_empty_');
      const db = new AppDatabase(join(dir, 'pools.db'));
      const manager = new SentryStateManager({ db });
      try {
        manager.updatePoolQuota('gemini', 0.9, resetTime);
        manager.updatePoolQuota('claude', 0.5, resetTime);

        assert.deepEqual(manager.reconcilePools([]), []);
        assert.deepEqual(Object.keys(manager.getState().pools).sort(), ['claude', 'gemini']);
      } finally {
        db.close();
        cleanup();
      }
    });

    it('reconciles as part of a probe, never on a failed one', () => {
      const { dir, cleanup } = makeTempDir('ai_plus_pools_eval_');
      const db = new AppDatabase(join(dir, 'pools.db'));
      const manager = new SentryStateManager({ db });
      const evaluator = new QuotaEvaluator({
        milestoneHours: [24, 12, 3],
        alertThresholdPercent: 25,
      });
      try {
        manager.updatePoolQuota('claude', 0.5, resetTime);

        const failedProbe = evaluator.evaluateWithPlan([], manager);
        assert.deepEqual(failedProbe.retiredPools, []);
        assert.ok(manager.getState().pools['claude']);

        const probe = evaluator.evaluateWithPlan([poolSnapshot('gemini')], manager);
        assert.deepEqual(probe.retiredPools, ['claude']);
        assert.deepEqual(Object.keys(manager.getState().pools), ['gemini']);
      } finally {
        db.close();
        cleanup();
      }
    });

    it('clears a stored early-reset notice once every pool it names is retired', () => {
      const { dir, cleanup } = makeTempDir('ai_plus_pools_notice_');
      const db = new AppDatabase(join(dir, 'pools.db'));
      const manager = new SentryStateManager({ db });
      try {
        manager.updatePoolQuota('claude', 0.5, resetTime);
        manager.recordEarlyResetNotice([
          {
            poolId: 'claude',
            previousRemainingFraction: 0.2,
            remainingFraction: 0.9,
            previousResetTime: resetTime,
            resetTime,
          },
        ]);

        manager.reconcilePools(['gemini']);

        assert.equal(manager.getEarlyResetNotice(), null);
      } finally {
        db.close();
        cleanup();
      }
    });
  });
});
