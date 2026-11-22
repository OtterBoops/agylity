import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  CANONICAL_AGY_MODELS,
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

/** AI Plus serves one Gemini model and one Claude model; no Argon pool and no Gemini 4 Hydrogen. */
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
    it('keeps one column list for every account shape', () => {
      assert.equal(QUOTA_GRID_COLUMNS, 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3');
    });

    it('fills a short last row with placeholders per breakpoint', () => {
      const visible = (count: number): { md: number; xl: number } => {
        const slots = quotaGridPlaceholders(count);
        return {
          md: slots.filter((slot) => slot.className.includes('md:flex')).length,
          xl: slots.filter((slot) => slot.className.endsWith('xl:flex')).length,
        };
      };

      // Three cells (two pools plus the absent group) fill the row at three columns.
      assert.deepEqual(visible(3), { md: 1, xl: 0 });
      assert.deepEqual(visible(4), { md: 0, xl: 2 });
      assert.deepEqual(visible(5), { md: 1, xl: 1 });
      assert.deepEqual(visible(7), { md: 1, xl: 2 });
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

    it('never moves a withheld model onto another pool group', () => {
      // Argon has no candidate at all here, so the id survives and eligibility locks instead.
      assert.equal(resolveAvailableModelId('gemini-4-argon', AI_PLUS_CATALOG), 'gemini-4-argon');
    });

    it('picks the newest model in the group and ignores orchestrator routes', () => {
      const catalog = [
        ...catalogOf('gemini-3.8-flash', 'gemini-4-neon'),
        {
          id: 'gemini-pro-orchestrator',
          label: 'Gemini Pro Orchestrator',
          poolGroup: 'gemini-hydrogen' as const,
          defaultEffort: 'medium' as const,
        },
      ];
      assert.equal(highestAvailableModelForPoolGroup('gemini-hydrogen', catalog), 'gemini-4-neon');
      assert.equal(
        highestAvailableModelForPoolGroup('gemini-hydrogen', AI_PLUS_CATALOG),
        'gemini-3.8-flash'
      );
    });
  });

  describe('pool group eligibility', () => {
    it('authorises the substituted model against the hydrogen pool', () => {
      const result = evaluateModelDispatchEligibility({
        requestedModel: 'gemini-4-hydrogen',
        pools: [poolSnapshot('gemini-hydrogen')],
        catalog: AI_PLUS_CATALOG,
      });
      assert.equal(result.allowed, true);
      assert.equal(result.resolvedModel, 'gemini-3.8-flash');
      assert.equal(result.poolGroup, 'gemini-hydrogen');
    });

    it('resolves a preference chain onto the model the tier actually serves', () => {
      const result = evaluateModelPreferenceChain({
        cascade: [{ model: 'gemini-4-hydrogen', effort: 'medium' }],
        pools: [poolSnapshot('gemini-hydrogen')],
        minHeadroomPercent: 10,
        catalog: AI_PLUS_CATALOG,
      });
      assert.equal(result.allowed, true);
      assert.equal(result.selectedModel, 'gemini-3.8-flash');
    });

    it('still refuses a pool group the account holds no pool for', () => {
      const result = evaluateModelPreferenceChain({
        cascade: [{ model: 'gemini-4-argon', effort: 'high' }],
        pools: [poolSnapshot('gemini-hydrogen'), poolSnapshot('claude')],
        minHeadroomPercent: 10,
        catalog: AI_PLUS_CATALOG,
      });
      assert.equal(result.allowed, false);
      assert.match(result.reason ?? '', /no telemetry pool/);
    });
  });

  describe('pool state reconciliation', () => {
    it('retires a pool the probe stopped reporting and keeps the rest', () => {
      const { dir, cleanup } = makeTempDir('ai_plus_pools_');
      const db = new AppDatabase(join(dir, 'pools.db'));
      const manager = new SentryStateManager({ db });
      try {
        manager.updatePoolQuota('gemini-hydrogen', 0.9, resetTime);
        manager.updatePoolQuota('gemini-argon', 0.5, resetTime);
        manager.recordMilestoneFired('gemini-argon', 24);
        assert.equal(snapshotsFromSentryState(manager.getState()).length, 2);

        const retired = manager.reconcilePools(['gemini-hydrogen', 'gemini-hydrogen']);

        assert.deepEqual(retired, ['gemini-argon']);
        assert.deepEqual(Object.keys(manager.getState().pools), ['gemini-hydrogen']);
        assert.deepEqual(
          snapshotsFromSentryState(manager.getState()).map((snapshot) => snapshot.poolId),
          ['gemini-hydrogen']
        );

        const raw = db.getRawDb();
        for (const table of ['pool_state', 'pool_milestones', 'pool_samples']) {
          const row = raw
            .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE pool_id = 'gemini-argon'`)
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
        manager.updatePoolQuota('gemini-hydrogen', 0.9, resetTime);
        manager.updatePoolQuota('gemini-argon', 0.5, resetTime);

        assert.deepEqual(manager.reconcilePools([]), []);
        assert.deepEqual(Object.keys(manager.getState().pools).sort(), [
          'gemini-argon',
          'gemini-hydrogen',
        ]);
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
        manager.updatePoolQuota('gemini-argon', 0.5, resetTime);

        const failedProbe = evaluator.evaluateWithPlan([], manager);
        assert.deepEqual(failedProbe.retiredPools, []);
        assert.ok(manager.getState().pools['gemini-argon']);

        const probe = evaluator.evaluateWithPlan([poolSnapshot('gemini-hydrogen')], manager);
        assert.deepEqual(probe.retiredPools, ['gemini-argon']);
        assert.deepEqual(Object.keys(manager.getState().pools), ['gemini-hydrogen']);
      } finally {
        db.close();
        cleanup();
      }
    });

    it('drops a retired pool from a stored early-reset notice', () => {
      const { dir, cleanup } = makeTempDir('ai_plus_pools_notice_');
      const db = new AppDatabase(join(dir, 'pools.db'));
      const manager = new SentryStateManager({ db });
      try {
        manager.updatePoolQuota('gemini-argon', 0.5, resetTime);
        manager.recordEarlyResetNotice([
          {
            poolId: 'gemini-argon',
            previousRemainingFraction: 0.2,
            remainingFraction: 0.9,
            previousResetTime: resetTime,
            resetTime,
          },
        ]);

        manager.reconcilePools(['gemini-hydrogen']);

        assert.deepEqual(manager.getEarlyResetNotice()?.pools, []);
      } finally {
        db.close();
        cleanup();
      }
    });
  });
});
