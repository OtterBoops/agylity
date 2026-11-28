import type { QuotaAlert, QuotaSnapshot } from './models.js';
import { calculateHoursUntilReset } from './models.js';
import { DEFAULT_MILESTONE_HOURS } from '../config/env.js';
import type { EarlyResetPool, SentryStateManager } from './state.js';
import { normalizeMilestoneKey } from './store.js';

interface QuotaEvaluatorOptions {
  milestoneHours?: number[];
  alertThresholdPercent?: number;
}

interface EvaluationPlan {
  alerts: QuotaAlert[];
  pendingMilestones: Map<string, number[]>;
  supersededMilestones: Map<string, number[]>;
  earlyResets: EarlyResetPool[];
  retiredPools: string[];
}

/** Milestones are deduplicated, positive and most-urgent-first wherever they arrive from config. */
const normalizeMilestones = (raw: number[]): number[] =>
  Array.from(new Set(raw.filter((m) => typeof m === 'number' && !Number.isNaN(m) && m > 0))).sort(
    (a, b) => b - a
  );

export class QuotaEvaluator {
  public milestoneHours: number[];
  public alertThresholdPercent: number;

  constructor(options: QuotaEvaluatorOptions = {}) {
    const milestones = normalizeMilestones(options.milestoneHours ?? DEFAULT_MILESTONE_HOURS);
    // An empty window list would silence every milestone alert, so it can never be the resolved value.
    this.milestoneHours = milestones.length > 0 ? milestones : [...DEFAULT_MILESTONE_HOURS];

    this.alertThresholdPercent =
      typeof options.alertThresholdPercent === 'number' &&
      !Number.isNaN(options.alertThresholdPercent)
        ? options.alertThresholdPercent
        : 25;
  }

  public updateConfig(options: QuotaEvaluatorOptions): void {
    if (options.milestoneHours !== undefined) {
      const next = normalizeMilestones(options.milestoneHours);
      if (next.length > 0) {
        this.milestoneHours = next;
      }
    }
    if (
      typeof options.alertThresholdPercent === 'number' &&
      !Number.isNaN(options.alertThresholdPercent)
    ) {
      this.alertThresholdPercent = options.alertThresholdPercent;
    }
  }

  evaluatePool(
    snapshot: QuotaSnapshot,
    firedMilestones: (number | string)[] = [],
    nowMs: number = Date.now()
  ): { alert: QuotaAlert | null; supersededMilestones: number[] } {
    const remainingPercentage = Math.round(snapshot.remainingFraction * 1000) / 10;

    // Checked against the raw fraction: 24.95% rounds to 25.0 and must not clear a 25% floor.
    if (snapshot.remainingFraction * 100 < this.alertThresholdPercent) {
      return { alert: null, supersededMilestones: [] };
    }

    const deltaHours = calculateHoursUntilReset(snapshot.resetTime, nowMs);

    if (deltaHours <= 0) {
      return { alert: null, supersededMilestones: [] };
    }

    const firedKeys = new Set(firedMilestones.map(normalizeMilestoneKey));

    const applicableMilestones = this.milestoneHours.filter((m) => deltaHours <= m);

    const unfiredApplicable = applicableMilestones.filter((m) => {
      const key = `${m}h`;
      return !firedKeys.has(key) && !firedKeys.has(String(m));
    });

    if (unfiredApplicable.length === 0) {
      return { alert: null, supersededMilestones: [] };
    }

    const mostUrgentMilestone = Math.min(...unfiredApplicable);

    const supersededMilestones = unfiredApplicable.filter((m) => m > mostUrgentMilestone);

    const alert: QuotaAlert = {
      pool: {
        ...snapshot,
        hoursUntilReset: deltaHours,
      },
      milestoneHours: mostUrgentMilestone,
      remainingPercentage,
      triggeredAt: new Date(nowMs).toISOString(),
    };

    return { alert, supersededMilestones };
  }

  evaluateWithPlan(
    snapshots: QuotaSnapshot[],
    stateManager?: SentryStateManager,
    nowMs: number = Date.now()
  ): EvaluationPlan {
    const alerts: QuotaAlert[] = [];
    const pendingMilestones = new Map<string, number[]>();
    const supersededMilestones = new Map<string, number[]>();
    const earlyResets: EarlyResetPool[] = [];

    for (const snapshot of snapshots) {
      let firedMilestones: string[] = [];

      if (stateManager) {
        const update = stateManager.updatePoolQuota(
          snapshot.poolId,
          snapshot.remainingFraction,
          snapshot.resetTime,
          nowMs
        );
        if (update?.earlyReset) {
          earlyResets.push({ ...update.earlyReset, displayName: snapshot.displayName });
        }
        const poolState = stateManager.getPoolState(snapshot.poolId);
        if (poolState) {
          firedMilestones = poolState.firedMilestones;
        }
      }

      const { alert, supersededMilestones: superseded } = this.evaluatePool(
        snapshot,
        firedMilestones,
        nowMs
      );

      if (alert) {
        alerts.push(alert);

        const pending = pendingMilestones.get(snapshot.poolId) ?? [];
        pending.push(alert.milestoneHours);
        pendingMilestones.set(snapshot.poolId, pending);

        if (superseded.length > 0) {
          const poolSuperseded = supersededMilestones.get(snapshot.poolId) ?? [];
          poolSuperseded.push(...superseded);
          supersededMilestones.set(snapshot.poolId, poolSuperseded);
        }
      }
    }

    // A plan is a probe: pools it did not report are retired here, so nothing offline keeps
    // offering a pool this account no longer holds.
    const retiredPools =
      stateManager && snapshots.length > 0
        ? stateManager.reconcilePools(snapshots.map((snapshot) => snapshot.poolId))
        : [];

    return { alerts, pendingMilestones, supersededMilestones, earlyResets, retiredPools };
  }

  evaluate(
    snapshots: QuotaSnapshot[],
    stateManager?: SentryStateManager,
    nowMs: number = Date.now()
  ): QuotaAlert[] {
    const plan = this.evaluateWithPlan(snapshots, stateManager, nowMs);

    if (stateManager) {
      for (const alert of plan.alerts) {
        stateManager.recordMilestoneFired(
          alert.pool.poolId,
          alert.milestoneHours,
          alert.triggeredAt
        );
      }
      for (const [poolId, milestones] of plan.supersededMilestones) {
        stateManager.recordSupersededMilestones(poolId, milestones);
      }
    }

    return plan.alerts;
  }
}
