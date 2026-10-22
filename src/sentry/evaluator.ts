import type { QuotaAlert, QuotaSnapshot } from './models.js';
import { calculateHoursUntilReset } from './models.js';
import type { SentryStateManager } from './state.js';

export interface QuotaEvaluatorOptions {
  milestoneHours?: number[];
  alertThresholdPercent?: number;
}

export interface EvaluationResult {
  alerts: QuotaAlert[];
  supersededMilestones: Map<string, number[]>;
}

export class QuotaEvaluator {
  public readonly milestoneHours: number[];
  public readonly alertThresholdPercent: number;

  constructor(options: QuotaEvaluatorOptions = {}) {
    const rawMilestones = options.milestoneHours ?? [24, 12, 3];
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

  /**
   * Pure evaluation for a single pool snapshot against a list of already fired milestones.
   */
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

    // Late-wake reconciliation:
    // When multiple milestone thresholds are crossed, trigger ONLY the most urgent (smallest window)
    const mostUrgentMilestone = Math.min(...unfiredApplicable);

    // All larger applicable un-fired milestones are superseded
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

  /**
   * Evaluates a collection of snapshots, optionally updating SentryStateManager.
   * Returns triggered QuotaAlerts.
   */
  evaluate(
    snapshots: QuotaSnapshot[],
    stateManager?: SentryStateManager,
    nowMs: number = Date.now()
  ): QuotaAlert[] {
    const alerts: QuotaAlert[] = [];

    for (const snapshot of snapshots) {
      let firedMilestones: string[] = [];

      if (stateManager) {
        // Detect cycle rollover and update pool state
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

      const { alert, supersededMilestones } = this.evaluatePool(snapshot, firedMilestones, nowMs);

      if (alert) {
        alerts.push(alert);

        if (stateManager) {
          // Record the fired milestone
          stateManager.recordMilestoneFired(
            snapshot.poolId,
            alert.milestoneHours,
            alert.triggeredAt
          );

          // Record superseded milestones to prevent later notification spam
          if (supersededMilestones.length > 0) {
            stateManager.recordSupersededMilestones(snapshot.poolId, supersededMilestones);
          }
        }
      }
    }

    return alerts;
  }
}
