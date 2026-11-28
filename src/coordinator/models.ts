import { z } from 'zod';
import { isGithubRemoteUrl } from '../shared/github.js';
import {
  calculateHoursUntilReset,
  POOL_GROUP_ALIASES,
  poolGroupForModelConfig,
  type QuotaBucket,
  type PoolGroup,
  type QuotaSnapshot,
} from '../sentry/models.js';
import { DEFAULT_QUOTA_BURN_MAX_HOURS } from '../config/env.js';
import { upgradePoolGroupId } from '../shared/models.js';
import type { ResolvedConfig } from '../config/types.js';
import {
  CANONICAL_AGY_MODELS,
  DEFAULT_MODEL_BY_POOL_GROUP,
  isOrchestratorModelId,
  resolveConcreteModelId,
  resolveReasoningEffortForModel,
  type AgyModelCatalogEntry,
  type ReasoningEffort,
} from '../shared/models.js';
import { toPercentFloor } from '../shared/percent.js';

export {
  ALL_EFFORTS,
  CANONICAL_AGY_MODELS,
  CATALOG_BY_ID,
  DEFAULT_DISPATCH_MODEL,
  DEFAULT_MODEL_BY_POOL_GROUP,
  isOrchestratorModelId,
  modelSupportsEffort,
  resolveConcreteModelId,
  resolveReasoningEffortForModel,
} from '../shared/models.js';
export type { AgyModelCatalogEntry, ReasoningEffort };

// Wire enums and payloads are declared once in ../../shared/contracts.ts; the zod schemas below
// only validate what crosses the boundary, so no type is stated twice.
import type {
  BacklogStatus,
  CascadeHop,
  RoutineEligibilityState,
  RoutineEligibilityStatus,
  ScheduleMode,
  TaskStatus,
  TaskTier,
} from '../shared/contracts.js';

export type {
  BacklogStatus,
  CascadeHop,
  RoutineEligibilityState,
  RoutineEligibilityStatus,
  ScheduleMode,
  TaskStatus,
  TaskTier,
};

// Each schema is bound to its contract: a literal the contract does not allow is a compile error.
export const ScheduleModeSchema = z
  .enum(['immediate', 'pre_reset'])
  .default('immediate') satisfies z.ZodType<ScheduleMode, ScheduleMode | undefined>;

export type RunnerLeaseBlockReason = 'missing_github_token';

/**
 * A GitHub remote needs the coordinator's PAT: without it the clone is anonymous and the push fails
 * after the run has already spent quota. A task with no clone URL is a local checkout and exempt.
 */
export const isGithubRemoteTask = (task: {
  cloneUrl?: string;
  repositoryName?: string;
}): boolean => {
  if (task.cloneUrl?.trim()) return isGithubRemoteUrl(task.cloneUrl);
  // A bare owner/repo name is how a cloned GitHub repository is configured.
  return /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(task.repositoryName?.trim() ?? '');
};

export const BacklogStatusSchema = z
  .enum(['pending', 'dispatched', 'paused', 'completed', 'failed', 'canceled'])
  .default('pending') satisfies z.ZodType<BacklogStatus, BacklogStatus | undefined>;

export const TERMINAL_TASK_STATUSES = ['completed', 'no_changes', 'failed', 'aborted'] as const;

/** `TERMINAL_TASK_STATUSES` is the single source so no status list can drift. */
export const isTerminalTaskStatus = (status: string): boolean =>
  (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);

/** A cycle only re-arms after its previous run succeeded; anything else ends the cycle. */
export const ROUTINE_CYCLE_REARM_STATUSES = ['completed'] as const;

export const TaskStatusSchema = z.enum([
  'queued',
  'claimed',
  'executing',
  'completed',
  'no_changes',
  'failed',
  'aborted',
]) satisfies z.ZodType<TaskStatus>;

interface AnnotatedModelCatalogEntry extends AgyModelCatalogEntry {
  effectiveHeadroomPercent: number | null;
  weeklyRemainingPercent: number | null;
  shortTermRemainingPercent: number | null;
  resetTime: string | null;
  hoursUntilReset: number | null;
  belowSafetyFloor: boolean;
}

export const resolvePoolGroupForModelOrNull = (modelOrPoolGroup?: string): PoolGroup | null => {
  if (!modelOrPoolGroup) return null;
  const normalized = modelOrPoolGroup.trim().toLowerCase();
  const alias = POOL_GROUP_ALIASES[normalized];
  if (alias) return alias;

  const resolved = poolGroupForModelConfig({ modelId: normalized, label: normalized });
  return resolved?.poolGroup ?? null;
};

// Display/bookkeeping default only — never use this to authorise a dispatch.
export const resolvePoolGroupForModel = (modelOrPoolGroup?: string): PoolGroup =>
  resolvePoolGroupForModelOrNull(modelOrPoolGroup) ?? 'gemini';

const headroomPercentOf = (fraction: number | undefined): number | null =>
  typeof fraction === 'number' && Number.isFinite(fraction)
    ? toPercentFloor(Math.max(0, Math.min(1, fraction)))
    : null;

/** Highest available = last entry for the pool group in catalog order: agy lists models oldest first. */
export const highestAvailableModelForPoolGroup = (
  poolGroup: PoolGroup,
  catalog: readonly AgyModelCatalogEntry[] = CANONICAL_AGY_MODELS
): string | undefined => {
  const candidates = catalog.filter((entry) => entry.poolGroup === poolGroup);
  const concrete = candidates.filter((entry) => !isOrchestratorModelId(entry.id));
  const ordered = concrete.length > 0 ? concrete : candidates;
  return ordered[ordered.length - 1]?.id;
};

// An account tier withholds models the build still knows about, so a withheld id lands on the
// newest model its own pool group offers rather than a model that cannot run.
export const resolveAvailableModelId = (
  model: string,
  catalog: readonly AgyModelCatalogEntry[] = CANONICAL_AGY_MODELS
): string => {
  if (catalog.length === 0) return model;
  if (catalog.some((entry) => entry.id === model)) return model;
  if (isOrchestratorModelId(model)) return model;
  const poolGroup = resolvePoolGroupForModelOrNull(model);
  if (poolGroup === null) return model;
  return highestAvailableModelForPoolGroup(poolGroup, catalog) ?? model;
};

export const resolveDefaultDispatchModel = (
  configured: string | undefined,
  catalog: readonly AgyModelCatalogEntry[] = CANONICAL_AGY_MODELS
): string => resolveAvailableModelId(resolveConcreteModelId(configured), catalog);

export const normalizeCascade = (input: unknown, fallbackModel?: string): CascadeHop[] => {
  const hops: CascadeHop[] = [];
  const seen = new Set<string>();

  const push = (rawModel: unknown, rawEffort: unknown): void => {
    const requested = typeof rawModel === 'string' ? rawModel.trim() : '';
    if (requested === '') return;
    const model = resolveConcreteModelId(requested);
    if (seen.has(model)) return;
    seen.add(model);
    hops.push({
      model,
      effort: resolveReasoningEffortForModel(
        model,
        typeof rawEffort === 'string' ? rawEffort : undefined
      ),
    });
  };

  if (Array.isArray(input)) {
    for (const entry of input) {
      if (typeof entry === 'string') {
        push(entry, undefined);
      } else if (entry && typeof entry === 'object') {
        const hop = entry as { model?: unknown; effort?: unknown };
        push(hop.model, hop.effort);
      }
    }
  } else if (typeof input === 'string') {
    push(input, undefined);
  }

  if (hops.length > 0) return hops;

  const fallback = (fallbackModel ?? '').trim() || DEFAULT_MODEL_BY_POOL_GROUP.gemini;
  const resolvedFallback = resolveConcreteModelId(fallback);
  return [
    {
      model: resolvedFallback,
      effort: resolveReasoningEffortForModel(resolvedFallback, undefined),
    },
  ];
};

export const calculateEffectiveHeadroomPercent = (
  pool: Pick<QuotaSnapshot, 'remainingFraction' | 'weekly' | 'shortTerm' | 'buckets'>
): number | null => {
  const fractions: number[] = [];
  const addBucket = (bucket: QuotaBucket | undefined): void => {
    if (!bucket || bucket.disabled === true) return;
    if (typeof bucket.remainingFraction === 'number' && Number.isFinite(bucket.remainingFraction)) {
      fractions.push(bucket.remainingFraction);
    }
  };
  if (typeof pool.remainingFraction === 'number' && Number.isFinite(pool.remainingFraction)) {
    fractions.push(pool.remainingFraction);
  }
  addBucket(pool.weekly);
  addBucket(pool.shortTerm);
  if (Array.isArray(pool.buckets)) {
    for (const b of pool.buckets) addBucket(b);
  }
  if (fractions.length === 0) return null;
  const minFraction = Math.max(0, Math.min(1, Math.min(...fractions)));
  return toPercentFloor(minFraction);
};

export const findPoolForGroup = <
  T extends { poolGroup?: PoolGroup; poolId?: string; displayName?: string },
>(
  pools: readonly T[],
  poolGroup: PoolGroup
): T | undefined =>
  pools.find(
    (p) =>
      p.poolGroup === poolGroup ||
      p.poolId === poolGroup ||
      resolvePoolGroupForModelOrNull(p.poolId || p.displayName) === poolGroup
  );

export const poolHoursUntilReset = (
  pool: Pick<QuotaSnapshot, 'hoursUntilReset' | 'resetTime'>,
  nowMs: number
): number | null =>
  typeof pool.hoursUntilReset === 'number' && pool.hoursUntilReset > 0
    ? pool.hoursUntilReset
    : calculateHoursUntilReset(pool.resetTime, nowMs);

interface ModelEligibilityOptions {
  requestedModel?: string;
  defaultModel?: string;
  scheduleMode?: ScheduleMode;
  pools?: Array<
    Pick<
      QuotaSnapshot,
      | 'poolId'
      | 'poolGroup'
      | 'displayName'
      | 'remainingFraction'
      | 'resetTime'
      | 'hoursUntilReset'
      | 'weekly'
      | 'shortTerm'
      | 'buckets'
    >
  >;
  minDispatchHeadroomPercent?: number;
  allowOverage?: boolean;
  quotaBurnMaxHours?: number;
  quotaBurnMinHeadroomPercent?: number;
  nowMs?: number;
  catalog?: readonly AgyModelCatalogEntry[];
}

export interface ModelEligibilityResult {
  allowed: boolean;
  resolvedModel: string;
  poolGroup: PoolGroup | null;
  effectiveHeadroomPercent: number;
  hoursUntilReset: number | null;
  code?: 'OVERAGE_PROTECTION_TRIGGERED' | 'QUOTA_BURN_CONDITIONS_NOT_MET' | 'TELEMETRY_UNAVAILABLE';
  reason?: string;
}

export const evaluateModelDispatchEligibility = (
  options: ModelEligibilityOptions
): ModelEligibilityResult => {
  const resolvedModel = resolveAvailableModelId(
    resolveConcreteModelId(options.requestedModel, options.defaultModel),
    options.catalog
  );
  const poolGroup = resolvePoolGroupForModelOrNull(resolvedModel);
  const scheduleMode: ScheduleMode = options.scheduleMode ?? 'immediate';
  const minHeadroom = options.minDispatchHeadroomPercent ?? 10;
  const allowOverage = Boolean(options.allowOverage);
  const quotaBurnMaxHours = options.quotaBurnMaxHours ?? DEFAULT_QUOTA_BURN_MAX_HOURS;
  const pools = options.pools ?? [];
  const nowMs = options.nowMs ?? Date.now();

  // Missing or unusable telemetry answers with one locked payload, so only the reason varies.
  const lockedForUnknownTelemetry = (reason: string): ModelEligibilityResult => ({
    allowed: false,
    resolvedModel,
    poolGroup,
    effectiveHeadroomPercent: 0,
    hoursUntilReset: null,
    code: 'TELEMETRY_UNAVAILABLE',
    reason,
  });
  // Overage is the explicit override for unknown telemetry, in both the empty-pool and unusable-pool case.
  const overageBypass = (): ModelEligibilityResult => ({
    allowed: true,
    resolvedModel,
    poolGroup,
    effectiveHeadroomPercent: 100,
    hoursUntilReset: null,
  });

  if (poolGroup === null) {
    return lockedForUnknownTelemetry(
      `Unknown model '${resolvedModel}': it maps to no quota pool, so headroom cannot be verified. Dispatch locked.`
    );
  }

  if (pools.length === 0) {
    if (scheduleMode === 'pre_reset' && !allowOverage) {
      return {
        allowed: false,
        resolvedModel,
        poolGroup,
        effectiveHeadroomPercent: 100,
        hoursUntilReset: null,
        code: 'QUOTA_BURN_CONDITIONS_NOT_MET',
        reason: `Pre-Reset Quota-Burn task queued: waiting for telemetry confirming <${quotaBurnMaxHours}h to reset and >=${minHeadroom}% headroom.`,
      };
    }
    if (allowOverage) return overageBypass();
    return lockedForUnknownTelemetry(
      `Overage Protection: quota telemetry for ${poolGroup} could not be read, so remaining headroom is unknown. Dispatch locked to prevent paid AI overages; pass allowOverage: true to override.`
    );
  }

  const targetPool = findPoolForGroup(pools, poolGroup);

  const effectiveHeadroomPercent = targetPool
    ? calculateEffectiveHeadroomPercent(targetPool)
    : null;
  if (effectiveHeadroomPercent === null) {
    if (allowOverage) return overageBypass();
    return lockedForUnknownTelemetry(
      `Overage Protection: no usable quota telemetry for ${poolGroup}, so remaining headroom is unknown. Dispatch locked to prevent paid AI overages; pass allowOverage: true to override.`
    );
  }
  const hoursUntilReset = targetPool ? poolHoursUntilReset(targetPool, nowMs) : null;

  if (effectiveHeadroomPercent < minHeadroom && !allowOverage) {
    return {
      allowed: false,
      resolvedModel,
      poolGroup,
      effectiveHeadroomPercent,
      hoursUntilReset,
      code: 'OVERAGE_PROTECTION_TRIGGERED',
      reason: `Overage Protection: Remaining quota for ${poolGroup} (${effectiveHeadroomPercent}%) is below the safety floor (${minHeadroom}%). Dispatch locked to prevent paid AI overages or credit consumption. Pass allowOverage: true to override.`,
    };
  }

  if (scheduleMode === 'pre_reset' && !allowOverage) {
    const isWindowImminent =
      hoursUntilReset !== null && hoursUntilReset > 0 && hoursUntilReset <= quotaBurnMaxHours;
    const burnMinHeadroom =
      options.quotaBurnMinHeadroomPercent !== undefined && options.quotaBurnMinHeadroomPercent > 0
        ? options.quotaBurnMinHeadroomPercent
        : minHeadroom;
    const hasAmpleQuota =
      effectiveHeadroomPercent >= burnMinHeadroom && effectiveHeadroomPercent > 0;

    if (!isWindowImminent || !hasAmpleQuota) {
      return {
        allowed: false,
        resolvedModel,
        poolGroup,
        effectiveHeadroomPercent,
        hoursUntilReset,
        code: 'QUOTA_BURN_CONDITIONS_NOT_MET',
        reason: `Pre-Reset Quota-Burn conditions not yet met for ${poolGroup} (headroom: ${effectiveHeadroomPercent}%, reset in: ${hoursUntilReset !== null ? `${hoursUntilReset}h` : 'unknown'}; requires >=${burnMinHeadroom}% and <=${quotaBurnMaxHours}h). Task remains queued.`,
      };
    }
  }

  return {
    allowed: true,
    resolvedModel,
    poolGroup,
    effectiveHeadroomPercent,
    hoursUntilReset,
  };
};

export const annotateModelsWithQuota = (
  pools: QuotaSnapshot[] = [],
  minDispatchHeadroomPercent = 10,
  nowMs: number = Date.now(),
  catalog: readonly AgyModelCatalogEntry[] = CANONICAL_AGY_MODELS
): AnnotatedModelCatalogEntry[] => {
  return catalog.map((entry) => {
    const pool = pools.find((p) => p.poolGroup === entry.poolGroup || p.poolId === entry.poolGroup);
    if (!pool) {
      return {
        ...entry,
        effectiveHeadroomPercent: null,
        weeklyRemainingPercent: null,
        shortTermRemainingPercent: null,
        resetTime: null,
        hoursUntilReset: null,
        belowSafetyFloor: false,
      };
    }

    const effectiveHeadroomPercent = calculateEffectiveHeadroomPercent(pool);
    const weeklyRemainingPercent = Math.round(
      (pool.weekly?.remainingFraction ?? pool.remainingFraction) * 100
    );
    const shortTermRemainingPercent =
      pool.shortTerm !== undefined ? Math.round(pool.shortTerm.remainingFraction * 100) : null;
    const hoursUntilReset = poolHoursUntilReset(pool, nowMs);

    return {
      ...entry,
      effectiveHeadroomPercent,
      weeklyRemainingPercent,
      shortTermRemainingPercent,
      resetTime: pool.resetTime,
      hoursUntilReset,
      belowSafetyFloor:
        effectiveHeadroomPercent === null || effectiveHeadroomPercent < minDispatchHeadroomPercent,
    };
  });
};

interface ModelPreferenceEvaluationResult {
  allowed: boolean;
  selectedModel?: string;
  selectedEffort?: ReasoningEffort;
  selectedHopIndex?: number;
  poolGroup?: PoolGroup;
  effectiveHeadroomPercent?: number;
  weeklyHeadroomPercent?: number;
  shortTermHeadroomPercent?: number | null;
  resetTime?: string;
  hoursUntilReset?: number | null;
  shortTermResetTime?: string;
  reason?: string;
}

export const evaluateModelPreferenceChain = (options: {
  cascade: CascadeHop[];
  defaultModel?: string;
  pools: QuotaSnapshot[];
  minHeadroomPercent: number;
  maxHoursUntilReset?: number;
  isPoolDispatchEnabled?: (poolGroup: PoolGroup) => boolean;
  nowMs?: number;
  catalog?: readonly AgyModelCatalogEntry[];
}): ModelPreferenceEvaluationResult => {
  const hops =
    options.cascade.length > 0
      ? options.cascade
      : normalizeCascade([], options.defaultModel || DEFAULT_MODEL_BY_POOL_GROUP.gemini);
  const nowMs = options.nowMs ?? Date.now();
  const rejectionReasons: string[] = [];

  for (const [hopIndex, hop] of hops.entries()) {
    const resolvedModel = resolveAvailableModelId(
      resolveConcreteModelId(hop.model, options.defaultModel),
      options.catalog
    );
    const effort = resolveReasoningEffortForModel(resolvedModel, hop.effort);
    const poolGroup = resolvePoolGroupForModelOrNull(resolvedModel);
    if (poolGroup === null) {
      rejectionReasons.push(`${resolvedModel}: unknown model id, no quota pool`);
      continue;
    }

    if (options.isPoolDispatchEnabled && !options.isPoolDispatchEnabled(poolGroup)) {
      rejectionReasons.push(`${resolvedModel} (${poolGroup}): pool dispatch disabled`);
      continue;
    }

    const targetPool = findPoolForGroup(options.pools, poolGroup);
    if (!targetPool) {
      rejectionReasons.push(`${resolvedModel} (${poolGroup}): no telemetry pool`);
      continue;
    }

    const weeklyHeadroomPercent = headroomPercentOf(
      targetPool.weekly?.remainingFraction ?? targetPool.remainingFraction
    );

    const isShortTermActive = targetPool.shortTerm && !targetPool.shortTerm.disabled;
    const shortTermHeadroomPercent = isShortTermActive
      ? headroomPercentOf(targetPool.shortTerm?.remainingFraction)
      : null;

    const effectiveHeadroomPercent = calculateEffectiveHeadroomPercent(targetPool);

    if (effectiveHeadroomPercent === null || weeklyHeadroomPercent === null) {
      rejectionReasons.push(`${resolvedModel}: unusable quota telemetry`);
      continue;
    }

    if (
      shortTermHeadroomPercent !== null &&
      shortTermHeadroomPercent < options.minHeadroomPercent
    ) {
      const recoveryNote = targetPool.shortTerm?.resetTime
        ? ` (recovers at ${targetPool.shortTerm.resetTime})`
        : '';
      rejectionReasons.push(
        `${resolvedModel}: 5h bucket at ${shortTermHeadroomPercent}% < ${options.minHeadroomPercent}% floor${recoveryNote}`
      );
      continue;
    }

    if (
      weeklyHeadroomPercent < options.minHeadroomPercent ||
      effectiveHeadroomPercent < options.minHeadroomPercent
    ) {
      rejectionReasons.push(
        `${resolvedModel}: weekly/effective headroom at ${effectiveHeadroomPercent}% < ${options.minHeadroomPercent}% floor`
      );
      continue;
    }

    const hoursUntilReset = poolHoursUntilReset(targetPool, nowMs);

    if (options.maxHoursUntilReset !== undefined) {
      if (
        !targetPool.resetTime ||
        hoursUntilReset === null ||
        hoursUntilReset <= 0 ||
        hoursUntilReset > options.maxHoursUntilReset
      ) {
        rejectionReasons.push(
          `${resolvedModel}: reset in ${hoursUntilReset ?? 'unknown'}h > ${options.maxHoursUntilReset}h window`
        );
        continue;
      }
    }

    return {
      allowed: true,
      selectedModel: resolvedModel,
      selectedEffort: effort,
      selectedHopIndex: hopIndex,
      poolGroup,
      effectiveHeadroomPercent,
      weeklyHeadroomPercent,
      shortTermHeadroomPercent,
      resetTime: targetPool.resetTime,
      hoursUntilReset,
      shortTermResetTime: targetPool.shortTerm?.resetTime,
    };
  }

  return {
    allowed: false,
    reason: rejectionReasons.join('; ') || 'No eligible models in preference chain',
  };
};

// A pool id is either the group id or `<group>:<slug>`; only the prefix names the group.
export const poolGroupOfPoolId = (poolId: string): string => {
  const upgraded = upgradePoolGroupId(poolId);
  const separator = upgraded.indexOf(':');
  return separator >= 0 ? upgraded.slice(0, separator) : upgraded;
};

/** A pool dispatches unless its policy explicitly disables it. */
export const poolDispatchEnabled = (resolved: ResolvedConfig, poolGroup: PoolGroup): boolean =>
  resolved.poolGroupPolicies?.[poolGroup]?.dispatchEnabled !== false;
