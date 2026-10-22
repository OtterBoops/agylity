import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { QuotaEvaluator, type EvaluationResult } from '../../src/sentry/evaluator.js';
import {
  SentryStateManager,
  normalizeMilestoneKey,
  createInitialState,
  type SentryState,
} from '../../src/sentry/state.js';
import {
  calculateHoursUntilReset,
  formatHoursHuman,
  type QuotaSnapshot,
} from '../../src/sentry/models.js';
import { makeTempDir } from '../e2e/harness/index.js';

describe('Empirical Challenger 2: Milestone 2 Boundary & Stress Harness', () => {
  /* ==================================================================== */
  /* 1. QuotaEvaluator Math & Boundary Thresholds                          */
  /* ==================================================================== */
  describe('1. QuotaEvaluator Math & Boundary Thresholds', () => {
    it('accurately triggers alert when remainingFraction is exactly equal to threshold (0.25)', () => {
      const evaluator = new QuotaEvaluator({
        milestoneHours: [24, 12, 3],
        alertThresholdPercent: 25,
      });

      const now = Date.now();
      const snapshot: QuotaSnapshot = {
        poolId: 'claude',
        family: 'claude',
        displayName: 'Claude 5.5 / Opus',
        remainingFraction: 0.25, // Exactly 25.0%
        resetTime: new Date(now + 10 * 3600 * 1000).toISOString(), // 10h remaining
        hoursUntilReset: 10,
        models: ['Claude Sonnet 5.5'],
      };

      const result = evaluator.evaluatePool(snapshot, [], now);
      assert.ok(result.alert, 'Alert must trigger at remainingFraction === 0.25');
      assert.equal(result.alert.remainingPercentage, 25.0);
      assert.equal(result.alert.milestoneHours, 12);
    });

    it('triggers alert at 0.2499 due to 1-decimal rounding (rounds to 25.0%)', () => {
      const evaluator = new QuotaEvaluator({
        milestoneHours: [24, 12, 3],
        alertThresholdPercent: 25,
      });

      const now = Date.now();
      const snapshot: QuotaSnapshot = {
        poolId: 'claude',
        family: 'claude',
        displayName: 'Claude 5.5 / Opus',
        remainingFraction: 0.2499, // 24.99% -> Math.round(249.9)/10 = 25.0%
        resetTime: new Date(now + 10 * 3600 * 1000).toISOString(),
        hoursUntilReset: 10,
        models: ['Claude Sonnet 5.5'],
      };

      const result = evaluator.evaluatePool(snapshot, [], now);
      assert.ok(
        result.alert,
        'Alert triggers at 0.2499 because 1-decimal rounding evaluates to 25.0%'
      );
      assert.equal(result.alert.remainingPercentage, 25.0);
    });

    it('suppresses alert when remainingFraction is strictly below threshold (0.2494 and 0.24)', () => {
      const evaluator = new QuotaEvaluator({
        milestoneHours: [24, 12, 3],
        alertThresholdPercent: 25,
      });

      const now = Date.now();
      const belowFractions = [0.2494, 0.249, 0.24, 0.2, 0.1, 0.01];

      for (const fraction of belowFractions) {
        const snapshot: QuotaSnapshot = {
          poolId: 'claude',
          family: 'claude',
          displayName: 'Claude 5.5 / Opus',
          remainingFraction: fraction,
          resetTime: new Date(now + 10 * 3600 * 1000).toISOString(),
          hoursUntilReset: 10,
          models: ['Claude Sonnet 5.5'],
        };

        const result = evaluator.evaluatePool(snapshot, [], now);
        assert.equal(
          result.alert,
          null,
          `Alert must be suppressed for remainingFraction ${fraction}`
        );
        assert.deepEqual(result.supersededMilestones, []);
      }
    });

    it('handles extreme fraction boundaries: 1.0 (100%) triggers, 0.0 (0%) suppresses', () => {
      const evaluator = new QuotaEvaluator({
        milestoneHours: [24, 12, 3],
        alertThresholdPercent: 25,
      });

      const now = Date.now();
      const resetTime = new Date(now + 5 * 3600 * 1000).toISOString();

      // 1.0 -> 100%
      const snapshot100: QuotaSnapshot = {
        poolId: 'claude',
        family: 'claude',
        displayName: 'Claude 5.5 / Opus',
        remainingFraction: 1.0,
        resetTime,
        hoursUntilReset: 5,
        models: ['Claude Sonnet 5.5'],
      };
      const res100 = evaluator.evaluatePool(snapshot100, [], now);
      assert.ok(res100.alert);
      assert.equal(res100.alert.remainingPercentage, 100.0);
      assert.equal(res100.alert.milestoneHours, 12);

      // 0.0 -> 0%
      const snapshot0: QuotaSnapshot = {
        poolId: 'claude',
        family: 'claude',
        displayName: 'Claude 5.5 / Opus',
        remainingFraction: 0.0,
        resetTime,
        hoursUntilReset: 5,
        models: ['Claude Sonnet 5.5'],
      };
      const res0 = evaluator.evaluatePool(snapshot0, [], now);
      assert.equal(res0.alert, null, '0.0 fraction must suppress alert');
    });

    it('suppresses alerts when resetTime is in the past, exactly now, or zero hours remaining', () => {
      const evaluator = new QuotaEvaluator({
        milestoneHours: [24, 12, 3],
        alertThresholdPercent: 25,
      });

      const now = 1776600000000; // Fixed timestamp

      const pastTimes = [
        new Date(now - 3600 * 1000).toISOString(), // 1 hour ago
        new Date(now - 1000).toISOString(), // 1 second ago
        new Date(now).toISOString(), // Exactly now
        '1970-01-01T00:00:00.000Z', // Epoch start
        '1969-12-31T23:59:59.000Z', // Negative epoch
        'invalid-iso-date-string', // Corrupted date
        '', // Empty date
      ];

      for (const resetTime of pastTimes) {
        const snapshot: QuotaSnapshot = {
          poolId: 'claude',
          family: 'claude',
          displayName: 'Claude 5.5 / Opus',
          remainingFraction: 0.8,
          resetTime,
          hoursUntilReset: 1, // Snapshot may have stale hours, evaluator must recalculate
          models: ['Claude Sonnet 5.5'],
        };

        const result = evaluator.evaluatePool(snapshot, [], now);
        assert.equal(result.alert, null, `Must suppress alert for resetTime '${resetTime}'`);
        assert.deepEqual(result.supersededMilestones, []);
      }
    });

    it('evaluates custom alertThresholdPercent correctly (0%, 50%, 100%)', () => {
      const now = Date.now();
      const resetTime = new Date(now + 2 * 3600 * 1000).toISOString();

      // Custom threshold 50%
      const eval50 = new QuotaEvaluator({ alertThresholdPercent: 50 });
      const snap49: QuotaSnapshot = {
        poolId: 'claude',
        family: 'claude',
        displayName: 'Claude',
        remainingFraction: 0.49,
        resetTime,
        hoursUntilReset: 2,
        models: ['Claude'],
      };
      const snap50: QuotaSnapshot = {
        ...snap49,
        remainingFraction: 0.5,
      };
      assert.equal(eval50.evaluatePool(snap49, [], now).alert, null);
      assert.ok(eval50.evaluatePool(snap50, [], now).alert);

      // Custom threshold 0%
      const eval0 = new QuotaEvaluator({ alertThresholdPercent: 0 });
      const snap0: QuotaSnapshot = { ...snap49, remainingFraction: 0.0 };
      assert.ok(eval0.evaluatePool(snap0, [], now).alert, 'At 0% threshold, 0.0 fraction triggers');

      // Custom threshold 100%
      const eval100 = new QuotaEvaluator({ alertThresholdPercent: 100 });
      assert.equal(eval100.evaluatePool(snap50, [], now).alert, null);
      assert.ok(eval100.evaluatePool({ ...snap49, remainingFraction: 1.0 }, [], now).alert);
    });
  });

  /* ==================================================================== */
  /* 2. Multi-Window Simultaneous Crossing & Late-Wake Anti-Spam          */
  /* ==================================================================== */
  describe('2. Multi-Window Simultaneous Crossing & Anti-Spam', () => {
    it('daemon late-wake at 1h remaining: triggers ONLY 3h milestone and supersedes 24h and 12h', () => {
      const evaluator = new QuotaEvaluator({
        milestoneHours: [24, 12, 3],
        alertThresholdPercent: 25,
      });

      const resetTime = new Date('2026-10-25T12:00:00.000Z').getTime();
      // Daemon wakes at 1 hour remaining:
      const now = resetTime - 1 * 3600 * 1000;

      const snapshot: QuotaSnapshot = {
        poolId: 'claude',
        family: 'claude',
        displayName: 'Claude 5.5 / Opus',
        remainingFraction: 0.75,
        resetTime: new Date(resetTime).toISOString(),
        hoursUntilReset: 1,
        models: ['Claude Sonnet 5.5'],
      };

      const result = evaluator.evaluatePool(snapshot, [], now);

      assert.ok(result.alert, 'Must generate alert');
      assert.equal(result.alert.milestoneHours, 3, 'Must trigger smallest applicable window (3h)');
      assert.deepEqual(
        result.supersededMilestones.sort((a, b) => a - b),
        [12, 24],
        'Must supersede all larger applicable windows [12, 24]'
      );
    });

    it('anti-spam: subsequent ticks after late-wake trigger zero repeat or superseded alerts', () => {
      const stateManager = new SentryStateManager();
      const evaluator = new QuotaEvaluator({
        milestoneHours: [24, 12, 3],
        alertThresholdPercent: 25,
      });

      const resetTime = new Date('2026-10-25T12:00:00.000Z').getTime();

      // Tick 1: Wake at 1 hour remaining -> triggers 3h, supersedes [12, 24]
      const t1 = resetTime - 1 * 3600 * 1000;
      const snap1: QuotaSnapshot = {
        poolId: 'claude',
        family: 'claude',
        displayName: 'Claude 5.5 / Opus',
        remainingFraction: 0.7,
        resetTime: new Date(resetTime).toISOString(),
        hoursUntilReset: 1,
        models: ['Claude Sonnet 5.5'],
      };

      const alerts1 = evaluator.evaluate([snap1], stateManager, t1);
      assert.equal(alerts1.length, 1);
      assert.equal(alerts1[0].milestoneHours, 3);

      // Verify state manager recorded both fired and superseded milestones
      assert.equal(stateManager.isMilestoneFired('claude', 3), true);
      assert.equal(stateManager.isMilestoneFired('claude', 12), true);
      assert.equal(stateManager.isMilestoneFired('claude', 24), true);

      // Tick 2: 45 minutes remaining -> zero alerts
      const t2 = resetTime - 45 * 60 * 1000;
      const alerts2 = evaluator.evaluate([snap1], stateManager, t2);
      assert.equal(alerts2.length, 0, 'No alerts should fire on tick 2');

      // Tick 3: 15 minutes remaining -> zero alerts
      const t3 = resetTime - 15 * 60 * 1000;
      const alerts3 = evaluator.evaluate([snap1], stateManager, t3);
      assert.equal(alerts3.length, 0, 'No alerts should fire on tick 3');

      // Tick 4: 1 minute remaining -> zero alerts
      const t4 = resetTime - 60 * 1000;
      const alerts4 = evaluator.evaluate([snap1], stateManager, t4);
      assert.equal(alerts4.length, 0, 'No alerts should fire on tick 4');
    });

    it('dense milestone configuration [72, 48, 24, 12, 6, 3, 1] cascades correctly across progressive checks', () => {
      const stateManager = new SentryStateManager();
      const evaluator = new QuotaEvaluator({
        milestoneHours: [72, 48, 24, 12, 6, 3, 1],
        alertThresholdPercent: 25,
      });

      const resetTime = new Date('2026-10-30T12:00:00.000Z').getTime();
      const makeSnap = (hoursLeft: number): QuotaSnapshot => ({
        poolId: 'claude',
        family: 'claude',
        displayName: 'Claude 5.5 / Opus',
        remainingFraction: 0.65,
        resetTime: new Date(resetTime).toISOString(),
        hoursUntilReset: hoursLeft,
        models: ['Claude Sonnet 5.5'],
      });

      // Stage A: System starts at 5 hours remaining
      // Applicable: [72, 48, 24, 12, 6]
      // Most urgent: 6h; superseded: [72, 48, 24, 12]
      const tA = resetTime - 5 * 3600 * 1000;
      const alertsA = evaluator.evaluate([makeSnap(5)], stateManager, tA);
      assert.equal(alertsA.length, 1);
      assert.equal(alertsA[0].milestoneHours, 6);
      assert.equal(stateManager.isMilestoneFired('claude', 6), true);
      assert.equal(stateManager.isMilestoneFired('claude', 12), true);
      assert.equal(stateManager.isMilestoneFired('claude', 24), true);
      assert.equal(stateManager.isMilestoneFired('claude', 48), true);
      assert.equal(stateManager.isMilestoneFired('claude', 72), true);
      assert.equal(stateManager.isMilestoneFired('claude', 3), false);
      assert.equal(stateManager.isMilestoneFired('claude', 1), false);

      // Stage B: Advance to 2 hours remaining
      // 3h is now applicable and unfired
      const tB = resetTime - 2 * 3600 * 1000;
      const alertsB = evaluator.evaluate([makeSnap(2)], stateManager, tB);
      assert.equal(alertsB.length, 1);
      assert.equal(alertsB[0].milestoneHours, 3);
      assert.equal(stateManager.isMilestoneFired('claude', 3), true);
      assert.equal(stateManager.isMilestoneFired('claude', 1), false);

      // Stage C: Advance to 0.5 hours (30m) remaining
      // 1h is now applicable and unfired
      const tC = resetTime - 30 * 60 * 1000;
      const alertsC = evaluator.evaluate([makeSnap(0.5)], stateManager, tC);
      assert.equal(alertsC.length, 1);
      assert.equal(alertsC[0].milestoneHours, 1);
      assert.equal(stateManager.isMilestoneFired('claude', 1), true);

      // Stage D: Advance to 0.1 hours (6m) remaining
      // All milestones fired
      const tD = resetTime - 6 * 60 * 1000;
      const alertsD = evaluator.evaluate([makeSnap(0.1)], stateManager, tD);
      assert.equal(alertsD.length, 0);
    });
  });

  /* ==================================================================== */
  /* 3. Milestone Configuration Robustness                                 */
  /* ==================================================================== */
  describe('3. Milestone Configuration Robustness (Unsorted, Duplicates, Empty)', () => {
    it('correctly handles unsorted milestone arrays ([3, 24, 12]) by sorting descending', () => {
      const evaluator = new QuotaEvaluator({
        milestoneHours: [3, 24, 12],
      });

      assert.deepEqual(evaluator.milestoneHours, [24, 12, 3]);

      const now = Date.now();
      const snapshot: QuotaSnapshot = {
        poolId: 'claude',
        family: 'claude',
        displayName: 'Claude',
        remainingFraction: 0.5,
        resetTime: new Date(now + 2 * 3600 * 1000).toISOString(),
        hoursUntilReset: 2,
        models: ['Claude'],
      };

      const result = evaluator.evaluatePool(snapshot, [], now);
      assert.equal(result.alert?.milestoneHours, 3);
      assert.deepEqual(
        result.supersededMilestones.sort((a, b) => a - b),
        [12, 24]
      );
    });

    it('correctly deduplicates duplicate milestones ([24, 24, 12, 12, 3, 3])', () => {
      const evaluator = new QuotaEvaluator({
        milestoneHours: [24, 24, 12, 12, 3, 3],
      });

      assert.deepEqual(evaluator.milestoneHours, [24, 12, 3]);
    });

    it('safely handles empty milestone array ([]) without throwing', () => {
      const evaluator = new QuotaEvaluator({
        milestoneHours: [],
      });

      assert.deepEqual(evaluator.milestoneHours, []);

      const now = Date.now();
      const snapshot: QuotaSnapshot = {
        poolId: 'claude',
        family: 'claude',
        displayName: 'Claude',
        remainingFraction: 0.9,
        resetTime: new Date(now + 10 * 3600 * 1000).toISOString(),
        hoursUntilReset: 10,
        models: ['Claude'],
      };

      const result = evaluator.evaluatePool(snapshot, [], now);
      assert.equal(result.alert, null);
      assert.deepEqual(result.supersededMilestones, []);
    });

    it('filters out non-positive, NaN, and non-numeric values from milestoneHours', () => {
      const evaluator = new QuotaEvaluator({
        milestoneHours: [-5, 0, NaN, null as any, undefined as any, '24' as any, 18, 6],
      });

      assert.deepEqual(evaluator.milestoneHours, [18, 6]);
    });

    it('supports fractional milestone hours (e.g. 0.5h, 1.5h)', () => {
      const evaluator = new QuotaEvaluator({
        milestoneHours: [1.5, 0.5],
      });

      assert.deepEqual(evaluator.milestoneHours, [1.5, 0.5]);

      const now = Date.now();
      const snap: QuotaSnapshot = {
        poolId: 'claude',
        family: 'claude',
        displayName: 'Claude',
        remainingFraction: 0.8,
        resetTime: new Date(now + 20 * 60 * 1000).toISOString(), // 20m = 0.33h
        hoursUntilReset: 0.33,
        models: ['Claude'],
      };

      const result = evaluator.evaluatePool(snap, [], now);
      assert.ok(result.alert);
      assert.equal(result.alert.milestoneHours, 0.5);
      assert.deepEqual(result.supersededMilestones, [1.5]);
    });
  });

  /* ==================================================================== */
  /* 4. SentryStateManager Crash Safety & Corruption Quarantine            */
  /* ==================================================================== */
  describe('4. SentryStateManager Crash Safety & Corruption Quarantine', () => {
    it('quarantines truncated/partial JSON and initializes clean state', async () => {
      const { dir, cleanup } = makeTempDir('sentry_state_crash_');
      try {
        const stateFile = path.join(dir, 'state.json');
        fs.writeFileSync(stateFile, '{"version": 1, "pools": { "claude": { "reset', 'utf-8');

        const manager = new SentryStateManager(stateFile);
        const state = await manager.load();

        assert.equal(state.version, 1);
        assert.deepEqual(state.pools, {});

        // Verify quarantine file was created
        const entries = fs.readdirSync(dir);
        const corruptFile = entries.find((f) => f.startsWith('state.json.corrupt.'));
        assert.ok(
          corruptFile,
          `Expected quarantine file starting with state.json.corrupt., found: ${entries}`
        );

        const corruptContent = fs.readFileSync(path.join(dir, corruptFile), 'utf-8');
        assert.equal(corruptContent, '{"version": 1, "pools": { "claude": { "reset');

        // Verify manager can save clean state afterwards
        manager.recordMilestoneFired('claude', 24);
        await manager.save();

        const reloaded = await new SentryStateManager(stateFile).load();
        assert.equal(reloaded.pools['claude']?.firedMilestones.includes('24h'), true);
      } finally {
        cleanup();
      }
    });

    it('quarantines raw non-JSON binary bytes and initializes clean state', async () => {
      const { dir, cleanup } = makeTempDir('sentry_state_binary_');
      try {
        const stateFile = path.join(dir, 'state.json');
        fs.writeFileSync(stateFile, Buffer.from([0x00, 0xff, 0xde, 0xad, 0xbe, 0xef]));

        const manager = new SentryStateManager(stateFile);
        const state = await manager.load();

        assert.equal(state.version, 1);
        assert.deepEqual(state.pools, {});

        const entries = fs.readdirSync(dir);
        const corruptFile = entries.find((f) => f.startsWith('state.json.corrupt.'));
        assert.ok(corruptFile);
      } finally {
        cleanup();
      }
    });

    it('quarantines schema-invalid JSON (unsupported version) and initializes clean state', async () => {
      const { dir, cleanup } = makeTempDir('sentry_state_schema_');
      try {
        const stateFile = path.join(dir, 'state.json');
        const invalidSchemaJson = {
          version: 999, // Schema requires literal 1
          lastProbeAt: new Date().toISOString(),
          lastProbeSource: 'connect_rpc',
          pools: {},
        };
        fs.writeFileSync(stateFile, JSON.stringify(invalidSchemaJson), 'utf-8');

        const manager = new SentryStateManager(stateFile);
        const state = await manager.load();

        assert.equal(state.version, 1);
        assert.deepEqual(state.pools, {});

        const entries = fs.readdirSync(dir);
        const corruptFile = entries.find((f) => f.startsWith('state.json.corrupt.'));
        assert.ok(corruptFile);
      } finally {
        cleanup();
      }
    });

    it('quarantines zero-byte empty file and initializes clean state', async () => {
      const { dir, cleanup } = makeTempDir('sentry_state_empty_');
      try {
        const stateFile = path.join(dir, 'state.json');
        fs.writeFileSync(stateFile, '', 'utf-8');

        const manager = new SentryStateManager(stateFile);
        const state = await manager.load();

        assert.equal(state.version, 1);
        assert.deepEqual(state.pools, {});

        const entries = fs.readdirSync(dir);
        const corruptFile = entries.find((f) => f.startsWith('state.json.corrupt.'));
        assert.ok(corruptFile);
      } finally {
        cleanup();
      }
    });

    it('load on non-existent file (ENOENT) initializes fresh state without creating a quarantine file', async () => {
      const { dir, cleanup } = makeTempDir('sentry_state_enoent_');
      try {
        const stateFile = path.join(dir, 'non_existent_state.json');
        const manager = new SentryStateManager(stateFile);
        const state = await manager.load();

        assert.equal(state.version, 1);
        assert.deepEqual(state.pools, {});

        const entries = fs.readdirSync(dir);
        assert.equal(entries.length, 0, 'No files should be created on ENOENT load');
      } finally {
        cleanup();
      }
    });
  });

  /* ==================================================================== */
  /* 5. Cycle Rollover & Cross-Restart Deduplication                       */
  /* ==================================================================== */
  describe('5. Cycle Rollover & Cross-Restart Deduplication', () => {
    it('advancing resetTime cleanly clears firedMilestones and resets lastAlertSentAt', async () => {
      const manager = new SentryStateManager();

      // Cycle 1: 2026-10-20
      const cycle1Reset = '2026-10-20T12:00:00.000Z';
      manager.updatePoolQuota('claude', 0.5, cycle1Reset);
      manager.recordMilestoneFired('claude', 24);
      manager.recordMilestoneFired('claude', 12);
      manager.recordMilestoneFired('claude', 3);

      assert.equal(manager.isMilestoneFired('claude', 24), true);
      assert.equal(manager.isMilestoneFired('claude', 12), true);
      assert.equal(manager.isMilestoneFired('claude', 3), true);
      assert.ok(manager.getPoolState('claude')?.lastAlertSentAt);

      // Cycle 2: resetTime advances to 2026-10-21
      const cycle2Reset = '2026-10-21T12:00:00.000Z';
      const rollover = manager.updatePoolQuota('claude', 0.9, cycle2Reset);

      assert.equal(rollover, true, 'updatePoolQuota must return true on cycle rollover');
      assert.equal(manager.isMilestoneFired('claude', 24), false);
      assert.equal(manager.isMilestoneFired('claude', 12), false);
      assert.equal(manager.isMilestoneFired('claude', 3), false);

      const poolState = manager.getPoolState('claude');
      assert.deepEqual(poolState?.firedMilestones, []);
      assert.equal(poolState?.lastAlertSentAt, null);
      assert.equal(poolState?.resetTime, cycle2Reset);
      assert.equal(poolState?.remainingFraction, 0.9);
    });

    it('independent pool lifecycles: rolling over claude does not affect gemini-argon or gemini-flash', async () => {
      const manager = new SentryStateManager();

      const time1 = '2026-10-20T12:00:00.000Z';
      manager.updatePoolQuota('claude', 0.5, time1);
      manager.updatePoolQuota('gemini-argon', 0.4, time1);

      manager.recordMilestoneFired('claude', 12);
      manager.recordMilestoneFired('gemini-argon', 24);

      // Advance claude only
      const time2 = '2026-10-21T12:00:00.000Z';
      manager.updatePoolQuota('claude', 0.85, time2);

      // Claude reset
      assert.equal(manager.isMilestoneFired('claude', 12), false);
      assert.deepEqual(manager.getPoolState('claude')?.firedMilestones, []);

      // Argon intact
      assert.equal(manager.isMilestoneFired('gemini-argon', 24), true);
      assert.deepEqual(manager.getPoolState('gemini-argon')?.firedMilestones, ['24h']);
    });

    it('deduplicates across process restarts via state.json persistence', async () => {
      const { dir, cleanup } = makeTempDir('sentry_restart_');
      try {
        const stateFile = path.join(dir, 'state.json');

        // Process 1: run evaluator and persist
        const mgr1 = new SentryStateManager(stateFile);
        await mgr1.load();

        const evaluator = new QuotaEvaluator({ milestoneHours: [24, 12, 3] });
        const resetTime = new Date(Date.now() + 10 * 3600 * 1000).toISOString();
        const snap: QuotaSnapshot = {
          poolId: 'claude',
          family: 'claude',
          displayName: 'Claude',
          remainingFraction: 0.6,
          resetTime,
          hoursUntilReset: 10,
          models: ['Claude'],
        };

        const alerts1 = evaluator.evaluate([snap], mgr1);
        assert.equal(alerts1.length, 1);
        assert.equal(alerts1[0].milestoneHours, 12);
        await mgr1.save();

        // Process 2: restart with fresh manager instance loading disk state
        const mgr2 = new SentryStateManager(stateFile);
        await mgr2.load();

        assert.equal(mgr2.isMilestoneFired('claude', 12), true);
        assert.equal(mgr2.isMilestoneFired('claude', 24), true); // superseded
        assert.equal(mgr2.isMilestoneFired('claude', 3), false);

        // Evaluate again in Process 2: must trigger 0 alerts
        const alerts2 = evaluator.evaluate([snap], mgr2);
        assert.equal(alerts2.length, 0, 'No duplicate alert allowed across restart');
      } finally {
        cleanup();
      }
    });

    it('resilient against rapid sequential saves (stress testing Windows atomic rename)', async () => {
      const { dir, cleanup } = makeTempDir('sentry_rapid_save_');
      try {
        const stateFile = path.join(dir, 'state.json');
        const manager = new SentryStateManager(stateFile);
        await manager.load();

        for (let i = 0; i < 25; i++) {
          manager.updateProbe('connect_rpc', new Date().toISOString());
          manager.recordMilestoneFired('claude', i + 1);
          await manager.save();
        }

        const verifyManager = new SentryStateManager(stateFile);
        const state = await verifyManager.load();
        assert.equal(state.pools['claude']?.firedMilestones.length, 25);
      } finally {
        cleanup();
      }
    });

    it('concurrent saves in the exact same millisecond experience tempFile naming collision under Promise.all', async () => {
      const { dir, cleanup } = makeTempDir('sentry_concurrent_collision_');
      try {
        const stateFile = path.join(dir, 'state.json');
        const manager = new SentryStateManager(stateFile);
        await manager.load();

        const saves = Array.from({ length: 5 }, (_, i) => {
          manager.recordMilestoneFired('claude', i + 1);
          return manager.save();
        });

        const results = await Promise.allSettled(saves);
        const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

        // Due to ${pid}.${Date.now()} without a unique nonce, concurrent saves collision can trigger ENOENT
        if (rejected.length > 0) {
          const err = rejected[0].reason as NodeJS.ErrnoException;
          assert.equal(err.code, 'ENOENT');
        }
      } finally {
        cleanup();
      }
    });
  });

  /* ==================================================================== */
  /* 6. End-to-End Simulation: Multi-Day Quota Lifecycle                   */
  /* ==================================================================== */
  describe('6. End-to-End Multi-Day Quota Lifecycle', () => {
    it('simulates complete 48h autonomous timeline across multiple cycles and varying headroom', () => {
      const stateManager = new SentryStateManager();
      const evaluator = new QuotaEvaluator({
        milestoneHours: [24, 12, 3],
        alertThresholdPercent: 25,
      });

      const day1Start = new Date('2026-10-20T12:00:00.000Z').getTime();
      const day1Reset = new Date('2026-10-21T12:00:00.000Z').getTime();
      const day2Reset = new Date('2026-10-22T12:00:00.000Z').getTime();

      const timeline: Array<{
        name: string;
        time: number;
        fraction: number;
        resetTime: number;
        expectedAlerts: number[];
      }> = [
        // Day 1: Cycle 1 starts (24h before reset)
        {
          name: 'Day 1: 24h milestone reached',
          time: day1Start,
          fraction: 0.85,
          resetTime: day1Reset,
          expectedAlerts: [24],
        },
        // Day 1: 18h remaining (between 24h and 12h) -> no alert
        {
          name: 'Day 1: 18h remaining',
          time: day1Start + 6 * 3600 * 1000,
          fraction: 0.75,
          resetTime: day1Reset,
          expectedAlerts: [],
        },
        // Day 1: 11h remaining -> 12h milestone triggers
        {
          name: 'Day 1: 11h remaining (12h milestone)',
          time: day1Start + 13 * 3600 * 1000,
          fraction: 0.5,
          resetTime: day1Reset,
          expectedAlerts: [12],
        },
        // Day 1: 8h remaining -> heavy usage, quota drops to 15% (< 25% threshold)
        {
          name: 'Day 1: Headroom below threshold',
          time: day1Start + 16 * 3600 * 1000,
          fraction: 0.15,
          resetTime: day1Reset,
          expectedAlerts: [],
        },
        // Day 1: 2h remaining -> quota headroom still low (20% < 25%) -> suppressed
        {
          name: 'Day 1: 2h remaining, suppressed by threshold',
          time: day1Start + 22 * 3600 * 1000,
          fraction: 0.2,
          resetTime: day1Reset,
          expectedAlerts: [],
        },
        // Day 1: 1h remaining -> quota headroom at 30% (above threshold) -> 3h milestone triggers!
        {
          name: 'Day 1: 1h remaining, headroom recovered to 30% -> 3h milestone triggers',
          time: day1Start + 23 * 3600 * 1000,
          fraction: 0.3,
          resetTime: day1Reset,
          expectedAlerts: [3],
        },
        // Day 2: Cycle Rollover! Upstream resetTime advances to Day 2
        {
          name: 'Day 2: Cycle Rollover at 23.5h remaining -> 24h milestone triggers',
          time: day1Reset + 30 * 60 * 1000, // 30m into cycle 2 (23.5h remaining)
          fraction: 0.95,
          resetTime: day2Reset,
          expectedAlerts: [24],
        },
        // Day 2: Repeat probe 10m later -> no repeat alert
        {
          name: 'Day 2: Repeat probe 10m later',
          time: day1Reset + 40 * 60 * 1000,
          fraction: 0.95,
          resetTime: day2Reset,
          expectedAlerts: [],
        },
      ];

      for (const step of timeline) {
        const snap: QuotaSnapshot = {
          poolId: 'claude',
          family: 'claude',
          displayName: 'Claude 5.5 / Opus',
          remainingFraction: step.fraction,
          resetTime: new Date(step.resetTime).toISOString(),
          hoursUntilReset: (step.resetTime - step.time) / 3600000,
          models: ['Claude Sonnet 5.5'],
        };

        const alerts = evaluator.evaluate([snap], stateManager, step.time);
        const alertMilestones = alerts.map((a) => a.milestoneHours);
        assert.deepEqual(
          alertMilestones,
          step.expectedAlerts,
          `Failed on step: ${step.name}. Expected ${JSON.stringify(step.expectedAlerts)}, got ${JSON.stringify(alertMilestones)}`
        );
      }
    });
  });
});
