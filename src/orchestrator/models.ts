import { z } from 'zod';
import {
  calculateHoursUntilReset,
  resolveModelFamily,
  type QuotaFamily,
  type QuotaSnapshot,
} from '../sentry/models.js';

export type TaskPriority = 'P0' | 'P1' | 'P2';
export const TaskPrioritySchema = z.enum(['P0', 'P1', 'P2']).default('P0');

export type WorkerMode = 'headless' | 'visible' | 'any';
export const WorkerModeSchema = z.enum(['headless', 'visible', 'any']).default('headless');

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
    id: 'gemini-4-argon-high',
    label: 'Gemini 4 Argon (High)',
    family: 'gemini-argon',
    defaultEffort: 'high',
  },
  {
    id: 'gemini-4-argon-medium',
    label: 'Gemini 4 Argon (Medium)',
    family: 'gemini-argon',
    defaultEffort: 'medium',
  },
  {
    id: 'gemini-4-argon-low',
    label: 'Gemini 4 Argon (Low)',
    family: 'gemini-argon',
    defaultEffort: 'low',
  },
  {
    id: 'gemini-3.8-flash-high',
    label: 'Gemini 3.8 Flash (High)',
    family: 'gemini-flash',
    defaultEffort: 'high',
  },
  {
    id: 'gemini-3.8-flash-medium',
    label: 'Gemini 3.8 Flash (Medium)',
    family: 'gemini-flash',
    defaultEffort: 'medium',
  },
  {
    id: 'gemini-3.8-flash-low',
    label: 'Gemini 3.8 Flash (Low)',
    family: 'gemini-flash',
    defaultEffort: 'low',
  },
  {
    id: 'claude-sonnet-5-5-high',
    label: 'Claude Sonnet 5.5 (High)',
    family: 'claude',
    defaultEffort: 'high',
  },
  {
    id: 'claude-sonnet-5-5-medium',
    label: 'Claude Sonnet 5.5 (Medium)',
    family: 'claude',
    defaultEffort: 'medium',
  },
  {
    id: 'claude-sonnet-5-5-low',
    label: 'Claude Sonnet 5.5 (Low)',
    family: 'claude',
    defaultEffort: 'low',
  },
  {
    id: 'claude-opus-5-5-high',
    label: 'Claude Opus 5.5 (High)',
    family: 'claude',
    defaultEffort: 'high',
  },
  {
    id: 'claude-opus-5-5-medium',
    label: 'Claude Opus 5.5 (Medium)',
    family: 'claude',
    defaultEffort: 'medium',
  },
  {
    id: 'claude-opus-5-5-low',
    label: 'Claude Opus 5.5 (Low)',
    family: 'claude',
    defaultEffort: 'low',
  },
  {
    id: 'gpt-oss-120b-medium',
    label: 'GPT-OSS 120B (Medium)',
    family: 'claude',
    defaultEffort: 'medium',
  },
] as const;

export const DEFAULT_MODEL_BY_FAMILY: Record<QuotaFamily, string> = {
  'gemini-argon': 'gemini-4-argon-high',
  'gemini-flash': 'gemini-3.8-flash-high',
  claude: 'claude-sonnet-5-5-high',
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
  defaultModel = 'gemini-4-argon-high'
): string => {
  const safeDefault =
    defaultModel && defaultModel.trim() !== '' && defaultModel.trim().toLowerCase() !== 'auto'
      ? defaultModel.trim()
      : 'gemini-4-argon-high';

  if (
    !requestedModel ||
    requestedModel.trim() === '' ||
    requestedModel.trim().toLowerCase() === 'auto'
  ) {
    return safeDefault;
  }

  const trimmed = requestedModel.trim().toLowerCase();
  if (trimmed === 'gemini-argon' || trimmed === 'argon') {
    return DEFAULT_MODEL_BY_FAMILY['gemini-argon'];
  }
  if (trimmed === 'gemini-flash' || trimmed === 'flash') {
    return DEFAULT_MODEL_BY_FAMILY['gemini-flash'];
  }
  if (trimmed === 'claude' || trimmed === 'sonnet') {
    return DEFAULT_MODEL_BY_FAMILY.claude;
  }
  if (trimmed === 'opus') {
    return 'claude-opus-5-5-high';
  }

  return requestedModel.trim();
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
  priority?: TaskPriority;
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
  family: QuotaFamily;
  effectiveHeadroomPercent: number;
  hoursUntilReset: number | null;
  code?: 'OVERAGE_PROTECTION_TRIGGERED' | 'QUOTA_BURN_CONDITIONS_NOT_MET';
  reason?: string;
}

/**
 * Evaluates whether a task with the given model and priority can safely dispatch/execute
 * under the current quota pool telemetry and safety floor rules.
 */
export const evaluateModelDispatchEligibility = (
  options: ModelEligibilityOptions
): ModelEligibilityResult => {
  const resolvedModel = resolveConcreteModelId(options.requestedModel, options.defaultModel);
  const family = resolvePoolFamilyForModel(resolvedModel);
  const priority: TaskPriority = options.priority ?? 'P0';
  const minHeadroom = options.minDispatchHeadroomPercent ?? 10;
  const allowOverage = Boolean(options.allowOverage);
  const quotaBurnMaxHours = options.quotaBurnMaxHours ?? 2;
  const quotaBurnMinHeadroom = options.quotaBurnMinHeadroomPercent ?? 30;
  const pools = options.pools ?? [];
  const nowMs = options.nowMs ?? Date.now();

  if (pools.length === 0) {
    if (priority === 'P2' && !allowOverage) {
      return {
        allowed: false,
        resolvedModel,
        family,
        effectiveHeadroomPercent: 100,
        hoursUntilReset: null,
        code: 'QUOTA_BURN_CONDITIONS_NOT_MET',
        reason: `P2 Quota-Burn task queued: waiting for telemetry confirming <${quotaBurnMaxHours}h to reset and >=${quotaBurnMinHeadroom}% headroom.`,
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

  // 1. Safety Floor Check (Applies to all priorities unless allowOverage is true)
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

  // 2. P2 Opportunistic Quota-Burn Check (< quotaBurnMaxHours to reset AND >= quotaBurnMinHeadroomPercent)
  if (priority === 'P2' && !allowOverage) {
    const isWindowImminent =
      hoursUntilReset !== null && hoursUntilReset > 0 && hoursUntilReset <= quotaBurnMaxHours;
    const hasAmpleQuota = effectiveHeadroomPercent >= quotaBurnMinHeadroom;

    if (!isWindowImminent || !hasAmpleQuota) {
      return {
        allowed: false,
        resolvedModel,
        family,
        effectiveHeadroomPercent,
        hoursUntilReset,
        code: 'QUOTA_BURN_CONDITIONS_NOT_MET',
        reason: `P2 Quota-Burn conditions not yet met for ${family} (headroom: ${effectiveHeadroomPercent}%, reset in: ${hoursUntilReset !== null ? `${hoursUntilReset}h` : 'unknown'}; requires >=${quotaBurnMinHeadroom}% and <=${quotaBurnMaxHours}h). Task remains queued.`,
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
 * Parses the optional Discord modal model/priority input string (e.g. "gemini-4-argon-high P0", "P2", "claude-opus-5-5-high").
 */
export const parseDiscordModelPriorityInput = (
  rawInput: string | undefined,
  defaultModel = 'gemini-4-argon-high',
  fallbackPoolFamily?: string
): {
  model: string;
  priority: TaskPriority;
  effort: ReasoningEffort;
} => {
  const baseDefault = fallbackPoolFamily
    ? resolveConcreteModelId(fallbackPoolFamily, defaultModel)
    : resolveConcreteModelId(undefined, defaultModel);

  if (!rawInput || !rawInput.trim()) {
    const catalogMatch = CANONICAL_AGY_MODELS.find((m) => m.id === baseDefault);
    return {
      model: baseDefault,
      priority: 'P0',
      effort: catalogMatch?.defaultEffort ?? 'high',
    };
  }

  const tokens = rawInput
    .trim()
    .split(/[\s,|/]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  let priority: TaskPriority = 'P0';
  let effort: ReasoningEffort | undefined;
  let modelToken: string | undefined;

  for (const token of tokens) {
    const upper = token.toUpperCase();
    const lower = token.toLowerCase();
    if (upper === 'P0' || upper === 'P1' || upper === 'P2') {
      priority = upper as TaskPriority;
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
    priority,
    effort: effort ?? catalogMatch?.defaultEffort ?? 'high',
  };
};
