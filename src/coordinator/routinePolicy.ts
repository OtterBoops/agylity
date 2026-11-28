import type {
  RoutineTaskRecord,
  RoutineEligibilityStatus,
  SwarmTask,
} from '../shared/contracts.js';
import type { PoolGroup, QuotaSnapshot } from '../sentry/models.js';
import type { ResolvedConfig } from '../config/types.js';
import { DEFAULT_QUOTA_BURN_MAX_HOURS } from '../shared/defaults.js';
import {
  ROUTINE_CYCLE_REARM_STATUSES,
  calculateEffectiveHeadroomPercent,
  findPoolForGroup,
  poolDispatchEnabled,
  poolGroupOfPoolId,
  poolHoursUntilReset,
  resolvePoolGroupForModelOrNull,
} from './models.js';

export interface RoutinePolicyDeps {
  config: { resolveConfig(): ResolvedConfig };
  queue: {
    hasActiveTaskForOrigin(originId: string): boolean;
    getLatestTaskForOrigin(originId: string, poolGroup?: string): SwarmTask | undefined;
    getTask(id: string): SwarmTask | undefined;
  };
  getActivePools(): QuotaSnapshot[];
  resolveDispatchModel(model: string | undefined, configuredDefault: string): string;
}

/** The routine's own window wins; the global burn window is only a fallback. */
export const routineLimits = (
  rt: RoutineTaskRecord,
  resolved: ResolvedConfig
): { triggerHours: number; minHeadroom: number } => {
  return {
    triggerHours:
      rt.triggerBeforeResetHours && rt.triggerBeforeResetHours > 0
        ? rt.triggerBeforeResetHours
        : (resolved.quotaBurnMaxHours ?? DEFAULT_QUOTA_BURN_MAX_HOURS),
    minHeadroom: Math.max(rt.minHeadroomPercent ?? 10, resolved.minDispatchHeadroomPercent ?? 0),
  };
};

/** The run a cycle stamp refers to: the latest task for that pool, else the recorded last task. */
export const cycleRun = (
  rt: RoutineTaskRecord,
  poolKey: string,
  deps: RoutinePolicyDeps
): SwarmTask | undefined => {
  return (
    deps.queue.getLatestTaskForOrigin(rt.id, poolKey) ??
    (rt.lastTaskId ? deps.queue.getTask(rt.lastTaskId) : undefined)
  );
};

export const routineMayTriggerAgain = (
  rt: RoutineTaskRecord,
  poolKey: string,
  resetTime: string,
  deps: RoutinePolicyDeps
): boolean => {
  const cycles = rt.lastTriggeredCycles ?? {};
  const stamped = Object.keys(cycles).length > 0 ? cycles[poolKey] : rt.lastTriggeredResetTime;
  if (!stamped || stamped !== resetTime) {
    return true;
  }

  const previous = cycleRun(rt, poolGroupOfPoolId(poolKey), deps);

  // A stamped cycle whose run can no longer be found stays burned: looping blind burns quota.
  if (!previous) return false;

  return (ROUTINE_CYCLE_REARM_STATUSES as readonly string[]).includes(previous.status);
};

export const orderRoutineCandidates = (
  routines: RoutineTaskRecord[],
  deps: RoutinePolicyDeps
): RoutineTaskRecord[] => {
  const lastRunMs = (rt: RoutineTaskRecord): number => {
    if (!rt.lastTaskId) return 0;
    const previous = deps.queue.getTask(rt.lastTaskId);
    const parsed = previous ? Date.parse(previous.createdAt) : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  };

  return [...routines].sort(
    (a, b) =>
      lastRunMs(a) - lastRunMs(b) || a.sortOrder - b.sortOrder || a.taskNumber - b.taskNumber
  );
};

export const computeRoutineEligibility = (
  rt: RoutineTaskRecord,
  snapshots: QuotaSnapshot[] | undefined,
  deps: RoutinePolicyDeps
): RoutineEligibilityStatus => {
  const resolved = deps.config.resolveConfig();

  if (!rt.enabled) {
    return {
      state: 'disabled',
      label: 'Disabled',
      detail: 'This routine is disabled and will not dispatch.',
    };
  }

  if (deps.queue.hasActiveTaskForOrigin(rt.id)) {
    const active = deps.queue.getLatestTaskForOrigin(rt.id);
    return {
      state: 'running',
      label: 'Looping',
      detail: `Task ${active?.id ?? 'run'} is ${active?.status ?? 'in flight'} on this routine.`,
    };
  }

  const pools = snapshots && snapshots.length > 0 ? snapshots : deps.getActivePools();
  if (pools.length === 0) {
    return {
      state: 'no_telemetry',
      label: 'No Telemetry',
      detail: 'No live quota telemetry is available, so dispatch cannot be validated.',
    };
  }

  const { triggerHours, minHeadroom } = routineLimits(rt, resolved);

  const targets: Array<{ model: string; poolGroup: PoolGroup }> = [];
  for (const hop of rt.cascade) {
    const model = deps.resolveDispatchModel(hop.model, resolved.defaultDispatchModel);
    const poolGroup = resolvePoolGroupForModelOrNull(model);
    // An unmapped model must never authorise a dispatch through the fail-open 'gemini' default.
    if (!poolGroup) continue;
    targets.push({ model, poolGroup });
  }
  const poolGroups = Array.from(new Set(targets.map((t) => t.poolGroup)));

  const enabledPoolGroups = new Set(
    poolGroups.filter((poolGroup) => poolDispatchEnabled(resolved, poolGroup))
  );
  if (enabledPoolGroups.size === 0) {
    return {
      state: 'pool_disabled',
      label: 'Pool Disabled',
      detail: `Dispatching is disabled for every pool this routine targets (${poolGroups.join(', ')}).`,
    };
  }

  let sawPool = false;
  let cycleComplete: string | undefined;
  let cycleFailed: string | undefined;
  let waitingWindow: string | undefined;
  let lowHeadroom: string | undefined;

  for (const { model, poolGroup } of targets) {
    if (!enabledPoolGroups.has(poolGroup)) continue;

    const pool = findPoolForGroup(pools, poolGroup);
    if (!pool) continue;
    sawPool = true;

    const poolLabel = pool.displayName || pool.poolId;
    const hoursUntilReset = poolHoursUntilReset(pool, Date.now());

    if (!pool.resetTime || hoursUntilReset === null || hoursUntilReset <= 0) {
      waitingWindow ??= `${poolLabel} has no pending reset deadline; waiting for the next probe cycle.`;
      continue;
    }

    if (
      !routineMayTriggerAgain(rt, pool.poolId || pool.poolGroup || poolGroup, pool.resetTime, deps)
    ) {
      const previous = cycleRun(rt, poolGroup, deps);

      const detail =
        `Cycle for ${poolLabel} is already burned for the reset at ${pool.resetTime}` +
        (previous ? ` (last run ${previous.status}).` : '.');
      // A cycle whose run failed or aborted ended in a terminal error, which reads differently.
      if (previous && (previous.status === 'failed' || previous.status === 'aborted')) {
        cycleFailed ??= detail;
      } else {
        cycleComplete ??= detail;
      }
      continue;
    }

    if (hoursUntilReset > triggerHours) {
      waitingWindow ??= `Reset in ${hoursUntilReset.toFixed(1)}h on ${poolLabel}; this routine opens at <=${triggerHours}h.`;
      continue;
    }

    const headroom = calculateEffectiveHeadroomPercent(pool);
    if (headroom === null) {
      lowHeadroom ??= `No usable headroom telemetry for ${poolLabel}.`;
      continue;
    }
    if (headroom < minHeadroom) {
      lowHeadroom ??= `${poolLabel} at ${headroom}% headroom, below the ${minHeadroom}% floor.`;
      continue;
    }

    return {
      state: 'ready',
      label: 'Ready',
      detail: `Dispatches on ${model} at the next probe (reset in ${hoursUntilReset.toFixed(1)}h, ${headroom}% headroom).`,
    };
  }

  if (cycleFailed) return { state: 'cycle_failed', label: 'Cycle Failed', detail: cycleFailed };
  if (cycleComplete) {
    return { state: 'cycle_complete', label: 'Cycle Complete', detail: cycleComplete };
  }
  if (waitingWindow) {
    return { state: 'waiting_window', label: 'Waiting Window', detail: waitingWindow };
  }
  if (lowHeadroom) return { state: 'low_headroom', label: 'Low Headroom', detail: lowHeadroom };

  return {
    state: 'no_telemetry',
    label: 'No Telemetry',
    detail: sawPool
      ? 'No pending dispatch condition is satisfied yet.'
      : `No quota pool matches ${poolGroups.join(', ')}.`,
  };
};
