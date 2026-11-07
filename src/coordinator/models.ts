import { z } from 'zod';
import {
  calculateHoursUntilReset,
  FAMILY_ALIASES,
  resolveModelFamily,
  type QuotaFamily,
  type QuotaSnapshot,
} from '../sentry/models.js';

export type ScheduleMode = 'immediate' | 'pre_reset';
export const ScheduleModeSchema = z.enum(['immediate', 'pre_reset']).default('immediate');

export type TaskTier = 'immediate' | 'backlog' | 'routine';
export const TaskTierSchema = z.enum(['immediate', 'backlog', 'routine']).default('immediate');

export type BacklogStatus = 'pending' | 'dispatched' | 'completed' | 'failed' | 'canceled';
export const BacklogStatusSchema = z
  .enum(['pending', 'dispatched', 'completed', 'failed', 'canceled'])
  .default('pending');

export type TaskActor = 'user' | 'bot';
export const TaskActorSchema = z.enum(['user', 'bot']).default('user');

export type ReasoningEffort = 'low' | 'medium' | 'high';
export const ReasoningEffortSchema = z.enum(['low', 'medium', 'high']).default('high');

export const TERMINAL_TASK_STATUSES = ['completed', 'no_changes', 'failed', 'aborted'] as const;

/** Terminal task statuses, so no status list can drift from the set. */
export const isTerminalTaskStatus = (status: string): boolean =>
  (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);

export type TaskStatus =
  'queued' | 'claimed' | 'executing' | 'completed' | 'no_changes' | 'failed' | 'aborted';
export const TaskStatusSchema = z.enum([
  'queued',
  'claimed',
  'executing',
  'completed',
  'no_changes',
  'failed',
  'aborted',
]);

export interface AgyModelCatalogEntry {
  id: string;
  label: string;
  family: QuotaFamily;
  defaultEffort: ReasoningEffort;
  supportedEfforts?: readonly ReasoningEffort[];
  /** Exactly one catalog entry per family is that pool's default dispatch target. */
  defaultForFamily?: boolean;
}

export interface AnnotatedModelCatalogEntry extends AgyModelCatalogEntry {
  effectiveHeadroomPercent: number | null;
  weeklyRemainingPercent: number | null;
  shortTermRemainingPercent: number | null;
  resetTime: string | null;
  hoursUntilReset: number | null;
  belowSafetyFloor: boolean;
}

// Authoritative catalog of official Antigravity CLI (`agy --output-format json models`) models.
export const CANONICAL_AGY_MODELS: readonly AgyModelCatalogEntry[] = [
  {
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    family: 'gemini-flash',
    defaultEffort: 'medium',
    supportedEfforts: ['low', 'medium', 'high'],
    defaultForFamily: true,
  },
  {
    id: 'gemini-4-argon',
    label: 'Gemini 4 Argon',
    family: 'gemini-argon',
    defaultEffort: 'high',
    supportedEfforts: ['low', 'medium', 'high'],
    defaultForFamily: true,
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    family: 'claude',
    defaultEffort: 'high',
    supportedEfforts: ['low', 'medium', 'high'],
    defaultForFamily: true,
  },
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    family: 'claude',
    defaultEffort: 'high',
    supportedEfforts: ['low', 'medium', 'high'],
  },
  {
    id: 'gpt-oss-120b',
    label: 'GPT-OSS 120B',
    family: 'claude',
    defaultEffort: 'medium',
    supportedEfforts: ['medium'],
  },
] as const;

const ALL_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];

const CATALOG_BY_ID = new Map(CANONICAL_AGY_MODELS.map((m) => [m.id, m]));

/** Derived from the catalog, so a model's efforts are declared exactly once. */
export const MODEL_SUPPORTED_EFFORTS: Record<string, readonly ReasoningEffort[]> =
  Object.fromEntries(CANONICAL_AGY_MODELS.map((m) => [m.id, m.supportedEfforts ?? ALL_EFFORTS]));

const defaultModelFor = (family: QuotaFamily): string => {
  const entry = CANONICAL_AGY_MODELS.find((m) => m.family === family && m.defaultForFamily);
  if (!entry) throw new Error(`No default model declared for pool family '${family}'`);
  return entry.id;
};

/** Derived from the catalog's defaultForFamily marker, not a second hand-kept table. */
export const DEFAULT_MODEL_BY_FAMILY: Record<QuotaFamily, string> = {
  'gemini-argon': defaultModelFor('gemini-argon'),
  'gemini-flash': defaultModelFor('gemini-flash'),
  claude: defaultModelFor('claude'),
};

export const resolveReasoningEffortForModel = (
  model: string | undefined,
  requestedEffort: string | undefined
): ReasoningEffort => {
  const concreteModel = resolveConcreteModelId(model);
  const supported = MODEL_SUPPORTED_EFFORTS[concreteModel] ?? ALL_EFFORTS;
  const defaultEffort = CATALOG_BY_ID.get(concreteModel)?.defaultEffort ?? 'medium';

  if (!requestedEffort) return defaultEffort;

  const normalized = requestedEffort.trim().toLowerCase() as ReasoningEffort;
  return supported.includes(normalized) ? normalized : defaultEffort;
};

// `null` for an unrecognised id: eligibility must fail closed rather than charge another
// pool's headroom for a model nobody can attribute.
export const resolvePoolFamilyForModelOrNull = (modelOrFamily?: string): QuotaFamily | null => {
  if (!modelOrFamily) return null;
  const normalized = modelOrFamily.trim().toLowerCase();
  const alias = FAMILY_ALIASES[normalized];
  if (alias) return alias;

  const resolved = resolveModelFamily({ modelId: normalized, label: normalized });
  return resolved?.family ?? null;
};

// Display/bookkeeping default only — never use this to authorise a dispatch.
export const resolvePoolFamilyForModel = (modelOrFamily?: string): QuotaFamily =>
  resolvePoolFamilyForModelOrNull(modelOrFamily) ?? 'gemini-argon';

// Resolves to an explicit `agy --model` identifier; never returns 'auto'.
export const resolveConcreteModelId = (
  requestedModel: string | undefined,
  defaultModel = 'gemini-4-argon'
): string => {
  const safeDefault =
    defaultModel && defaultModel.trim() !== '' && defaultModel.trim().toLowerCase() !== 'auto'
      ? defaultModel.trim()
      : 'gemini-4-argon';

  if (
    !requestedModel ||
    requestedModel.trim() === '' ||
    requestedModel.trim().toLowerCase() === 'auto'
  ) {
    return safeDefault;
  }

  const trimmed = requestedModel.trim().toLowerCase();
  if (
    trimmed === 'gemini-argon' ||
    trimmed === 'argon' ||
    trimmed === 'gemini-4-argon' ||
    trimmed === 'gemini-4-argon-high'
  ) {
    return DEFAULT_MODEL_BY_FAMILY['gemini-argon'];
  }
  if (
    trimmed === 'gemini-flash' ||
    trimmed === 'flash' ||
    trimmed === 'gemini-3.8-flash' ||
    trimmed === 'gemini-3.8-flash-high'
  ) {
    return DEFAULT_MODEL_BY_FAMILY['gemini-flash'];
  }
  if (
    trimmed === 'claude' ||
    trimmed === 'sonnet' ||
    trimmed === 'claude-sonnet-5-5' ||
    trimmed === 'claude-sonnet-5-5-high'
  ) {
    return DEFAULT_MODEL_BY_FAMILY.claude;
  }
  if (trimmed === 'opus' || trimmed === 'claude-opus-5-5' || trimmed === 'claude-opus-5-5-high') {
    return 'claude-opus-5-5';
  }
  if (trimmed === 'gpt-oss' || trimmed === 'gpt-oss-120b' || trimmed === 'gpt-oss-120b-medium') {
    return 'gpt-oss-120b';
  }

  // Strip trailing legacy -high, -medium, -low suffixes if present
  return requestedModel.trim().replace(/-(high|medium|low)$/i, '');
};

export const calculateEffectiveHeadroomPercent = (
  pool: Pick<QuotaSnapshot, 'remainingFraction' | 'weekly' | 'shortTerm' | 'buckets'>
): number | null => {
  const fractions: number[] = [];
  if (typeof pool.remainingFraction === 'number' && Number.isFinite(pool.remainingFraction)) {
    fractions.push(pool.remainingFraction);
  }
  if (
    pool.weekly &&
    typeof pool.weekly.remainingFraction === 'number' &&
    Number.isFinite(pool.weekly.remainingFraction)
  ) {
    fractions.push(pool.weekly.remainingFraction);
  }
  if (
    pool.shortTerm &&
    typeof pool.shortTerm.remainingFraction === 'number' &&
    Number.isFinite(pool.shortTerm.remainingFraction)
  ) {
    fractions.push(pool.shortTerm.remainingFraction);
  }
  if (Array.isArray(pool.buckets)) {
    for (const b of pool.buckets) {
      if (typeof b.remainingFraction === 'number' && Number.isFinite(b.remainingFraction)) {
        fractions.push(b.remainingFraction);
      }
    }
  }
  if (fractions.length === 0) return null;
  const minFraction = Math.max(0, Math.min(1, Math.min(...fractions)));
  // Floor, not round: 9.5% must not clear a 10% safety floor.
  return Math.floor(minFraction * 100);
};

export interface ModelEligibilityOptions {
  requestedModel?: string;
  defaultModel?: string;
  scheduleMode?: ScheduleMode;
  pools?: Array<
    Pick<
      QuotaSnapshot,
      | 'poolId'
      | 'family'
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
}

export interface ModelEligibilityResult {
  allowed: boolean;
  resolvedModel: string;
  /** null when the requested model id maps to no known pool. */
  family: QuotaFamily | null;
  effectiveHeadroomPercent: number;
  hoursUntilReset: number | null;
  code?: 'OVERAGE_PROTECTION_TRIGGERED' | 'QUOTA_BURN_CONDITIONS_NOT_MET' | 'TELEMETRY_UNAVAILABLE';
  reason?: string;
}

export const evaluateModelDispatchEligibility = (
  options: ModelEligibilityOptions
): ModelEligibilityResult => {
  const resolvedModel = resolveConcreteModelId(options.requestedModel, options.defaultModel);
  const family = resolvePoolFamilyForModelOrNull(resolvedModel);
  const scheduleMode: ScheduleMode = options.scheduleMode ?? 'immediate';
  const minHeadroom = options.minDispatchHeadroomPercent ?? 10;
  const allowOverage = Boolean(options.allowOverage);
  const quotaBurnMaxHours = options.quotaBurnMaxHours ?? 2;
  const pools = options.pools ?? [];
  const nowMs = options.nowMs ?? Date.now();

  if (family === null) {
    return {
      allowed: false,
      resolvedModel,
      family,
      effectiveHeadroomPercent: 0,
      hoursUntilReset: null,
      code: 'TELEMETRY_UNAVAILABLE',
      reason: `Unknown model '${resolvedModel}': it maps to no quota pool, so headroom cannot be verified. Dispatch locked.`,
    };
  }

  if (pools.length === 0) {
    if (scheduleMode === 'pre_reset' && !allowOverage) {
      return {
        allowed: false,
        resolvedModel,
        family,
        effectiveHeadroomPercent: 100,
        hoursUntilReset: null,
        code: 'QUOTA_BURN_CONDITIONS_NOT_MET',
        reason: `Pre-Reset Quota-Burn task queued: waiting for telemetry confirming <${quotaBurnMaxHours}h to reset and >=${minHeadroom}% headroom.`,
      };
    }
    if (allowOverage) {
      return {
        allowed: true,
        resolvedModel,
        family,
        effectiveHeadroomPercent: 100,
        hoursUntilReset: null,
      };
    }
    // No telemetry means the safety floor cannot be verified, so fail closed.
    return {
      allowed: false,
      resolvedModel,
      family,
      effectiveHeadroomPercent: 0,
      hoursUntilReset: null,
      code: 'TELEMETRY_UNAVAILABLE',
      reason: `Overage Protection: quota telemetry for ${family} could not be read, so remaining headroom is unknown. Dispatch locked to prevent paid AI overages; pass allowOverage: true to override.`,
    };
  }

  const targetPool = pools.find(
    (p) =>
      p.family === family ||
      p.poolId === family ||
      resolvePoolFamilyForModel(p.poolId || p.displayName) === family
  );

  // No pool for this family, or a pool whose fractions are unusable, means unknown.
  const effectiveHeadroomPercent = targetPool
    ? calculateEffectiveHeadroomPercent(targetPool)
    : null;
  if (effectiveHeadroomPercent === null) {
    return {
      allowed: false,
      resolvedModel,
      family,
      effectiveHeadroomPercent: 0,
      hoursUntilReset: null,
      code: 'TELEMETRY_UNAVAILABLE',
      reason: `Overage Protection: no usable quota telemetry for ${family}, so remaining headroom is unknown. Dispatch locked to prevent paid AI overages; pass allowOverage: true to override.`,
    };
  }
  const hoursUntilReset = targetPool
    ? typeof targetPool.hoursUntilReset === 'number' && targetPool.hoursUntilReset > 0
      ? targetPool.hoursUntilReset
      : calculateHoursUntilReset(targetPool.resetTime, nowMs)
    : null;

  // 1. Safety Floor Check (Applies to all schedule modes unless allowOverage is true)
  if (effectiveHeadroomPercent < minHeadroom && !allowOverage) {
    return {
      allowed: false,
      resolvedModel,
      family,
      effectiveHeadroomPercent,
      hoursUntilReset,
      code: 'OVERAGE_PROTECTION_TRIGGERED',
      reason: `Overage Protection: Remaining quota for ${family} (${effectiveHeadroomPercent}%) is below the safety floor (${minHeadroom}%). Dispatch locked to prevent paid AI overages or credit consumption. Pass allowOverage: true to override.`,
    };
  }

  // 2. Pre-Reset Opportunistic Quota-Burn Check (<= quotaBurnMaxHours to reset AND >= minHeadroom)
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
        family,
        effectiveHeadroomPercent,
        hoursUntilReset,
        code: 'QUOTA_BURN_CONDITIONS_NOT_MET',
        reason: `Pre-Reset Quota-Burn conditions not yet met for ${family} (headroom: ${effectiveHeadroomPercent}%, reset in: ${hoursUntilReset !== null ? `${hoursUntilReset}h` : 'unknown'}; requires >=${burnMinHeadroom}% and <=${quotaBurnMaxHours}h). Task remains queued.`,
      };
    }
  }

  return {
    allowed: true,
    resolvedModel,
    family,
    effectiveHeadroomPercent,
    hoursUntilReset,
  };
};

// Annotates the canonical model catalog with live quota headroom and reset windows from active pools.
export const annotateModelsWithQuota = (
  pools: QuotaSnapshot[] = [],
  minDispatchHeadroomPercent = 10,
  nowMs: number = Date.now()
): AnnotatedModelCatalogEntry[] => {
  return CANONICAL_AGY_MODELS.map((entry) => {
    const pool = pools.find((p) => p.family === entry.family || p.poolId === entry.family);
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
    const hoursUntilReset =
      pool.hoursUntilReset > 0
        ? pool.hoursUntilReset
        : calculateHoursUntilReset(pool.resetTime, nowMs);

    return {
      ...entry,
      effectiveHeadroomPercent,
      weeklyRemainingPercent,
      shortTermRemainingPercent,
      resetTime: pool.resetTime,
      hoursUntilReset,
      // Unknown headroom counts as below the floor, matching the dispatch gate.
      belowSafetyFloor:
        effectiveHeadroomPercent === null || effectiveHeadroomPercent < minDispatchHeadroomPercent,
    };
  });
};

export interface ModelPreferenceEvaluationResult {
  allowed: boolean;
  selectedModel?: string;
  family?: QuotaFamily;
  effectiveHeadroomPercent?: number;
  weeklyHeadroomPercent?: number;
  shortTermHeadroomPercent?: number | null;
  resetTime?: string;
  hoursUntilReset?: number | null;
  shortTermResetTime?: string;
  reason?: string;
}

/**
 * Evaluates an ordered preference list of candidate models against live quota pools.
 * Independently enforces the headroom floor across BOTH the 5-hour rolling bucket (shortTerm)
 * and the weekly pool (weekly) to prevent rate-limit deadlocks when a manual task depletes 5h quota.
 */
export const evaluateModelPreferenceChain = (options: {
  models: string[];
  defaultModel?: string;
  pools: QuotaSnapshot[];
  minHeadroomPercent: number;
  maxHoursUntilReset?: number;
  isPoolDispatchEnabled?: (family: QuotaFamily) => boolean;
  nowMs?: number;
}): ModelPreferenceEvaluationResult => {
  const candidates =
    options.models.length > 0
      ? options.models
      : [options.defaultModel || DEFAULT_MODEL_BY_FAMILY['gemini-flash']];
  const nowMs = options.nowMs ?? Date.now();
  const rejectionReasons: string[] = [];

  for (const rawCandidate of candidates) {
    const resolvedModel = resolveConcreteModelId(rawCandidate, options.defaultModel);
    const family = resolvePoolFamilyForModelOrNull(resolvedModel);
    if (family === null) {
      rejectionReasons.push(`${resolvedModel}: unknown model id, no quota pool`);
      continue;
    }

    if (options.isPoolDispatchEnabled && !options.isPoolDispatchEnabled(family)) {
      rejectionReasons.push(`${resolvedModel} (${family}): pool dispatch disabled`);
      continue;
    }

    const targetPool = options.pools.find(
      (p) =>
        p.family === family ||
        p.poolId === family ||
        resolvePoolFamilyForModel(p.poolId || p.displayName) === family
    );
    if (!targetPool) {
      rejectionReasons.push(`${resolvedModel} (${family}): no telemetry pool`);
      continue;
    }

    const weeklyFraction = targetPool.weekly?.remainingFraction ?? targetPool.remainingFraction;
    const weeklyHeadroomPercent =
      typeof weeklyFraction === 'number' && Number.isFinite(weeklyFraction)
        ? Math.floor(Math.max(0, Math.min(1, weeklyFraction)) * 100)
        : null;

    const isShortTermActive = targetPool.shortTerm && !targetPool.shortTerm.disabled;
    const shortTermFraction = isShortTermActive
      ? targetPool.shortTerm?.remainingFraction
      : undefined;
    const shortTermHeadroomPercent =
      typeof shortTermFraction === 'number' && Number.isFinite(shortTermFraction)
        ? Math.floor(Math.max(0, Math.min(1, shortTermFraction)) * 100)
        : null;

    const effectiveHeadroomPercent = calculateEffectiveHeadroomPercent(targetPool);

    if (effectiveHeadroomPercent === null || weeklyHeadroomPercent === null) {
      rejectionReasons.push(`${resolvedModel}: unusable quota telemetry`);
      continue;
    }

    // Check active 5-hour rolling bucket explicitly so we log 5h deadlock blocks clearly
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

    const hoursUntilReset =
      typeof targetPool.hoursUntilReset === 'number' && targetPool.hoursUntilReset > 0
        ? targetPool.hoursUntilReset
        : calculateHoursUntilReset(targetPool.resetTime, nowMs);

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
      family,
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
