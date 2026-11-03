import type { QuotaAlert, QuotaSnapshot } from './models.js';
import { calculateHoursUntilReset } from './models.js';
import { DEFAULT_MILESTONE_HOURS } from '../config/schema.js';
import type { SentryStateManager } from './state.js';

export interface QuotaEvaluatorOptions {
  milestoneHours?: number[];
  alertThresholdPercent?: number;
}

export interface EvaluationPlan {
  alerts: QuotaAlert[];
  pendingMilestones: Map<string, number[]>;
  supersededMilestones: Map<string, number[]>;
}

export class QuotaEvaluator {
  public milestoneHours: number[];
  public alertThresholdPercent: number;

  constructor(options: QuotaEvaluatorOptions = {}) {
    const rawMilestones = options.milestoneHours ?? DEFAULT_MILESTONE_HOURS;
    // Filter positive numbers, remove duplicates, sort descending: e.g. [24, 12, 3]
    this.milestoneHours = Array.from(
      new Set(rawMilestones.filter((m) => typeof m === 'number' && !Number.isNaN(m) && m > 0))
    ).sort((a, b) => b - a);

    this.alertThresholdPercent =
      typeof options.alertThresholdPercent === 'number' &&
      !Number.isNaN(options.alertThresholdPercent)
        ? options.alertThresholdPercent
        : 25;
  }

  public updateConfig(options: QuotaEvaluatorOptions): void {
    if (options.milestoneHours !== undefined) {
      this.milestoneHours = Array.from(
        new Set(
          options.milestoneHours.filter((m) => typeof m === 'number' && !Number.isNaN(m) && m > 0)
        )
      ).sort((a, b) => b - a);
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

    // Check headroom threshold: alert only if remaining quota headroom is >= threshold
    if (remainingPercentage < this.alertThresholdPercent) {
      return { alert: null, supersededMilestones: [] };
    }

    const deltaHours = calculateHoursUntilReset(snapshot.resetTime, nowMs);

    // If reset deadline has already passed or is 0, skip alert
    if (deltaHours <= 0) {
      return { alert: null, supersededMilestones: [] };
    }

    // Normalize fired milestones to string keys (e.g. "24h" or "24")
    const firedKeys = new Set(
      firedMilestones.map((m) => {
        const s = String(m).trim().toLowerCase();
        return s.endsWith('h') ? s : `${s}h`;
      })
    );

    // Find all applicable milestone windows where deltaHours <= milestone
    const applicableMilestones = this.milestoneHours.filter((m) => deltaHours <= m);

    // Filter to those that have not yet fired
    const unfiredApplicable = applicableMilestones.filter((m) => {
      const key = `${m}h`;
      return !firedKeys.has(key) && !firedKeys.has(String(m));
    });

    if (unfiredApplicable.length === 0) {
      return { alert: null, supersededMilestones: [] };
    }

    // Several thresholds crossed at once: only the most urgent fires.
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

  // Evaluates snapshots into a delivery plan and records NO milestone state.
  evaluateWithPlan(
    snapshots: QuotaSnapshot[],
    stateManager?: SentryStateManager,
    nowMs: number = Date.now()
  ): EvaluationPlan {
    const alerts: QuotaAlert[] = [];
    const pendingMilestones = new Map<string, number[]>();
    const supersededMilestones = new Map<string, number[]>();

    for (const snapshot of snapshots) {
      let firedMilestones: string[] = [];

      if (stateManager) {
        // Detect cycle rollover and update pool quota; milestone recording is deferred to the caller.
        stateManager.updatePoolQuota(
          snapshot.poolId,
          snapshot.remainingFraction,
          snapshot.resetTime
        );
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

    return { alerts, pendingMilestones, supersededMilestones };
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
