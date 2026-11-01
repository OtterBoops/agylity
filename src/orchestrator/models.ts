import { z } from 'zod';
import {
  calculateHoursUntilReset,
  resolveModelFamily,
  type QuotaFamily,
  type QuotaSnapshot,
} from '../sentry/models.js';

export type ScheduleMode = 'immediate' | 'pre_reset';
export const ScheduleModeSchema = z.enum(['immediate', 'pre_reset']).default('immediate');

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const ReasoningEffortSchema = z
  .enum(['low', 'medium', 'high', 'xhigh', 'max'])
  .default('high');

export type TaskStatus = 'queued' | 'claimed' | 'executing' | 'completed' | 'failed' | 'aborted';
export const TaskStatusSchema = z.enum([
  'queued',
  'claimed',
  'executing',
  'completed',
  'failed',
  'aborted',
]);

export interface AgyModelCatalogEntry {
  id: string;
  label: string;
  family: QuotaFamily;
  defaultEffort: ReasoningEffort;
}

export interface AnnotatedModelCatalogEntry extends AgyModelCatalogEntry {
  effectiveHeadroomPercent: number | null;
  weeklyRemainingPercent: number | null;
  shortTermRemainingPercent: number | null;
  resetTime: string | null;
  hoursUntilReset: number | null;
  belowSafetyFloor: boolean;
}

/**
 * Authoritative catalog of official Antigravity CLI (`agy --output-format json models`) models.
 */
export const CANONICAL_AGY_MODELS: readonly AgyModelCatalogEntry[] = [
  {
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    family: 'gemini-flash',
    defaultEffort: 'medium',
  },
  {
    id: 'gemini-4-argon',
    label: 'Gemini 4 Argon',
    family: 'gemini-argon',
    defaultEffort: 'high',
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    family: 'claude',
    defaultEffort: 'high',
  },
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    family: 'claude',
    defaultEffort: 'high',
  },
  {
    id: 'gpt-oss-120b',
    label: 'GPT-OSS 120B',
    family: 'claude',
    defaultEffort: 'medium',
  },
] as const;

export const DEFAULT_MODEL_BY_FAMILY: Record<QuotaFamily, string> = {
  'gemini-argon': 'gemini-4-argon',
  'gemini-flash': 'gemini-3.8-flash',
  claude: 'claude-sonnet-5-5',
};

/**
 * Resolves a model ID or pool family string to its canonical QuotaFamily.
 */
export const resolvePoolFamilyForModel = (modelOrFamily?: string): QuotaFamily => {
  if (!modelOrFamily) return 'gemini-argon';
  const normalized = modelOrFamily.trim().toLowerCase();
  if (normalized === 'gemini-argon' || normalized === 'argon') return 'gemini-argon';
  if (normalized === 'gemini-flash' || normalized === 'flash') return 'gemini-flash';
  if (normalized === 'claude' || normalized === '3p') return 'claude';

  const resolved = resolveModelFamily({ modelId: normalized, label: normalized });
  return resolved?.family ?? 'gemini-argon';
};

/**
 * Resolves a requested model string (or pool family shorthand) to an explicit `agy --model` identifier.
 * Never returns 'auto' so the CLI is always invoked with an explicit, predictable model flag.
 */
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

/**
 * Computes the effective remaining headroom percentage (0-100) for a quota pool,
 * taking the minimum of the weekly limit and the 5-hour rolling window limit:
 * effectiveHeadroom = min(weeklyRemaining, fiveHourRemaining)
 */
export const calculateEffectiveHeadroomPercent = (
  pool: Pick<QuotaSnapshot, 'remainingFraction' | 'weekly' | 'shortTerm' | 'buckets'>
): number => {
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
  if (fractions.length === 0) return 100;
  const minFraction = Math.max(0, Math.min(1, Math.min(...fractions)));
  return Math.round(minFraction * 100);
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
  nowMs?: number;
}

export interface ModelEligibilityResult {
  allowed: boolean;
  resolvedModel: string;
  family: QuotaFamily;
  effectiveHeadroomPercent: number;
  hoursUntilReset: number | null;
  code?: 'OVERAGE_PROTECTION_TRIGGERED' | 'QUOTA_BURN_CONDITIONS_NOT_MET';
  reason?: string;
}

/**
 * Evaluates whether a task with the given model and scheduleMode can safely dispatch/execute
 * under the current quota pool telemetry and safety floor rules.
 */
export const evaluateModelDispatchEligibility = (
  options: ModelEligibilityOptions
): ModelEligibilityResult => {
  const resolvedModel = resolveConcreteModelId(options.requestedModel, options.defaultModel);
  const family = resolvePoolFamilyForModel(resolvedModel);
  const scheduleMode: ScheduleMode = options.scheduleMode ?? 'immediate';
  const minHeadroom = options.minDispatchHeadroomPercent ?? 10;
  const allowOverage = Boolean(options.allowOverage);
  const quotaBurnMaxHours = options.quotaBurnMaxHours ?? 2;
  const pools = options.pools ?? [];
  const nowMs = options.nowMs ?? Date.now();

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
    return {
      allowed: true,
      resolvedModel,
      family,
      effectiveHeadroomPercent: 100,
      hoursUntilReset: null,
    };
  }

  // Locate the specific pool matching the resolved model family
  let targetPool = pools.find(
    (p) =>
      p.family === family ||
      p.poolId === family ||
      resolvePoolFamilyForModel(p.poolId || p.displayName) === family
  );

  // Fallback if only a partial/mock pool set was provided in state
  if (!targetPool && pools.length > 0) {
    targetPool = pools.reduce((mostConstrained, current) =>
      calculateEffectiveHeadroomPercent(current) <
      calculateEffectiveHeadroomPercent(mostConstrained)
        ? current
        : mostConstrained
    );
  }

  const effectiveHeadroomPercent = targetPool ? calculateEffectiveHeadroomPercent(targetPool) : 100;
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
    const hasAmpleQuota = effectiveHeadroomPercent >= minHeadroom;

    if (!isWindowImminent || !hasAmpleQuota) {
      return {
        allowed: false,
        resolvedModel,
        family,
        effectiveHeadroomPercent,
        hoursUntilReset,
        code: 'QUOTA_BURN_CONDITIONS_NOT_MET',
        reason: `Pre-Reset Quota-Burn conditions not yet met for ${family} (headroom: ${effectiveHeadroomPercent}%, reset in: ${hoursUntilReset !== null ? `${hoursUntilReset}h` : 'unknown'}; requires >=${minHeadroom}% and <=${quotaBurnMaxHours}h). Task remains queued.`,
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

/**
 * Annotates the canonical model catalog with live quota headroom and reset windows from active pools.
 */
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
      belowSafetyFloor: effectiveHeadroomPercent < minDispatchHeadroomPercent,
    };
  });
};

/**
 * Parses the optional Discord modal model/scheduleMode input string (e.g. "gemini-4-argon-high pre_reset", "claude-opus-5-5-high").
 */
export const parseDiscordModelPriorityInput = (
  rawInput: string | undefined,
  defaultModel = 'gemini-3.8-flash',
  fallbackPoolFamily?: string
): {
  model: string;
  scheduleMode: ScheduleMode;
  effort: ReasoningEffort;
} => {
  const baseDefault = fallbackPoolFamily
    ? resolveConcreteModelId(fallbackPoolFamily, defaultModel)
    : resolveConcreteModelId(undefined, defaultModel);

  if (!rawInput || !rawInput.trim()) {
    const catalogMatch = CANONICAL_AGY_MODELS.find((m) => m.id === baseDefault);
    return {
      model: baseDefault,
      scheduleMode: 'immediate',
      effort: catalogMatch?.defaultEffort ?? 'high',
    };
  }

  const tokens = rawInput
    .trim()
    .split(/[\s,|/]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  let scheduleMode: ScheduleMode = 'immediate';
  let effort: ReasoningEffort | undefined;
  let modelToken: string | undefined;

  for (const token of tokens) {
    const upper = token.toUpperCase();
    const lower = token.toLowerCase();
    if (lower === 'pre_reset' || lower === 'prereset' || upper === 'P2') {
      scheduleMode = 'pre_reset';
      continue;
    }
    if (lower === 'immediate' || upper === 'P0' || upper === 'P1') {
      scheduleMode = 'immediate';
      continue;
    }
    if (['low', 'medium', 'high', 'xhigh', 'max'].includes(lower)) {
      effort = lower as ReasoningEffort;
      continue;
    }
    if (!modelToken) {
      modelToken = token;
    }
  }

  const resolvedModel = resolveConcreteModelId(modelToken, baseDefault);
  const catalogMatch = CANONICAL_AGY_MODELS.find((m) => m.id === resolvedModel);

  return {
    model: resolvedModel,
    scheduleMode,
    effort: effort ?? catalogMatch?.defaultEffort ?? 'high',
  };
};
