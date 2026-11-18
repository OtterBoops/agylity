import { z } from 'zod';
import { upgradePoolFamilyId, type QuotaFamily } from '../shared/models.js';

export const QuotaInfoSchema = z.object({
  remainingFraction: z.number().min(0).max(1),
  resetTime: z.string(),
});

export const LanguageServerModelConfigSchema = z.object({
  label: z.string(),
  modelId: z.string(),
  modelOrAlias: z
    .object({
      model: z.string(),
    })
    .optional(),
  supportsImages: z.boolean().optional(),
  isRecommended: z.boolean().optional(),
  allowedTiers: z.array(z.string()).optional(),
  quotaInfo: QuotaInfoSchema.optional().nullable(),
  tagTitle: z.string().optional(),
  supportedMimeTypes: z.record(z.string(), z.boolean()).optional(),
});

export type LanguageServerModelConfig = z.infer<typeof LanguageServerModelConfigSchema>;

export const ClientModelSortSchema = z.object({
  name: z.string(),
  groups: z.array(
    z.object({
      modelLabels: z.array(z.string()),
    })
  ),
});

export const LanguageServerResponseSchema = z.object({
  clientModelConfigs: z.array(LanguageServerModelConfigSchema),
  clientModelSorts: z.array(ClientModelSortSchema).optional(),
  defaultOverrideModelConfig: z.record(z.string(), z.unknown()).optional(),
});

export type { QuotaFamily };

export const QuotaBucketSchema = z.object({
  bucketId: z.string(),
  displayName: z.string(),
  window: z.string().optional(),
  remainingFraction: z.number().min(0).max(1),
  resetTime: z.string().optional(),
  hoursUntilReset: z.number().min(0).nullable().optional(),
  description: z.string().optional(),
  disabled: z.boolean().optional(),
});

export type QuotaBucket = z.infer<typeof QuotaBucketSchema>;

export const QuotaSnapshotSchema = z.object({
  poolId: z.string(),
  family: z.enum(['claude', 'gemini-argon', 'gemini-hydrogen']),
  displayName: z.string(),
  remainingFraction: z.number().min(0).max(1),
  resetTime: z.string(),
  hoursUntilReset: z.number().min(0),
  models: z.array(z.string()),
  overageEnabled: z.boolean().optional(),
  remainingCredits: z.number().nullable().optional(),
  weekly: QuotaBucketSchema.optional(),
  shortTerm: QuotaBucketSchema.optional(),
  buckets: z.array(QuotaBucketSchema).optional(),
  burnProjection: z
    .object({
      burnRatePerHour: z.number(),
      projectedRemainingAtResetPercent: z.number(),
      hoursUntilFloor: z.number().nullable(),
    })
    .optional(),
});

export type QuotaSnapshot = z.infer<typeof QuotaSnapshotSchema>;

export const RawQuotaBucketSchema = z.object({
  bucketId: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  window: z.string().optional(),
  remainingFraction: z.number().min(0).max(1),
  resetTime: z.string().optional(),
  disabled: z.boolean().optional(),
});

export const RawQuotaGroupSchema = z.object({
  displayName: z.string(),
  description: z.string().optional(),
  buckets: z.array(RawQuotaBucketSchema),
});

// The server does not currently emit overageInfo; retained only as a secondary signal.
export const OverageInfoSchema = z.object({
  enabled: z.boolean().optional(),
});

export const RetrieveUserQuotaSummaryResponseSchema = z.object({
  response: z.object({
    groups: z.array(RawQuotaGroupSchema),
    description: z.string().optional(),
    overageInfo: OverageInfoSchema.optional(),
    overage_info: OverageInfoSchema.optional(),
  }),
});

export type RetrieveUserQuotaSummaryResponse = z.infer<
  typeof RetrieveUserQuotaSummaryResponseSchema
>;

export const UserPlanInfoSchema = z.object({
  teamsTier: z.string().optional(),
  planName: z.string().optional(),
  monthlyPromptCredits: z.number().optional(),
  monthlyFlowCredits: z.number().optional(),
  monthlyFlexCreditPurchaseAmount: z.number().optional(),
  canBuyMoreCredits: z.boolean().optional(),
});

export const GetUserStatusResponseSchema = z.object({
  userStatus: z
    .object({
      planStatus: z
        .object({
          planInfo: UserPlanInfoSchema.optional(),
        })
        .optional(),
    })
    .optional(),
});

export type GetUserStatusResponse = z.infer<typeof GetUserStatusResponseSchema>;

export const deriveOverageEnabled = (
  status: GetUserStatusResponse | null | undefined
): boolean | undefined => {
  const planInfo = status?.userStatus?.planStatus?.planInfo;
  if (!planInfo) return undefined;
  const flex = planInfo.monthlyFlexCreditPurchaseAmount;
  const canBuy = planInfo.canBuyMoreCredits;
  if (typeof flex !== 'number' && typeof canBuy !== 'boolean') return undefined;
  return (typeof flex === 'number' && flex > 0) || canBuy === true;
};

export const QuotaAlertSchema = z.object({
  pool: QuotaSnapshotSchema,
  milestoneHours: z.number(),
  remainingPercentage: z.number(),
  triggeredAt: z.string(),
});

export type QuotaAlert = z.infer<typeof QuotaAlertSchema>;

export interface QuotaClient {
  fetchQuota(force?: boolean): Promise<QuotaSnapshot[]>;
  updateConfig?(config: Partial<Record<string, unknown>>): void;
}

export const calculateHoursUntilReset = (resetTime: string, nowMs: number = Date.now()): number => {
  const resetEpoch = new Date(resetTime).getTime();
  if (Number.isNaN(resetEpoch)) return 0;
  const diffMs = resetEpoch - nowMs;
  if (diffMs <= 0) return 0;
  const hours = diffMs / (1000 * 60 * 60);
  return Math.max(0.0001, Math.round(hours * 1000) / 1000);
};

export interface BurnSample {
  at: string;
  remainingFraction: number;
  resetTime: string;
}

export interface QuotaBurnProjection {
  burnRatePerHour: number;
  projectedRemainingAtResetPercent: number;
  hoursUntilFloor: number | null;
}

export const BURN_FLOOR_PERCENT = 10;

/** Two observations closer than this cannot separate signal from probe jitter. */
const BURN_MIN_SPAN_MS = 5 * 60_000;
/** Below this drain the pool is flat or refilling, which has no meaningful projection. */
const BURN_MIN_RATE_PER_HOUR = 0.001;

export const computeBurnProjection = (input: {
  samples?: BurnSample[];
  resetTime: string;
  nowMs?: number;
  floorPercent?: number;
}): QuotaBurnProjection | undefined => {
  const nowMs = input.nowMs ?? Date.now();
  // Samples from an earlier cycle describe a different pool balance and are excluded.
  const cycle = (input.samples ?? []).filter((s) => s.resetTime === input.resetTime);
  if (cycle.length < 2) return undefined;

  const first = cycle[0]!;
  const last = cycle[cycle.length - 1]!;
  const firstMs = Date.parse(first.at);
  const lastMs = Date.parse(last.at);
  if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs)) return undefined;

  const elapsedMs = lastMs - firstMs;
  if (elapsedMs < BURN_MIN_SPAN_MS) return undefined;

  const elapsedHours = elapsedMs / (1000 * 60 * 60);
  const burnRatePerHour = (first.remainingFraction - last.remainingFraction) / elapsedHours;
  if (!(burnRatePerHour > BURN_MIN_RATE_PER_HOUR)) return undefined;

  const hoursUntilReset = calculateHoursUntilReset(input.resetTime, nowMs);
  const projectedFraction = last.remainingFraction - burnRatePerHour * hoursUntilReset;

  const floorFraction = (input.floorPercent ?? BURN_FLOOR_PERCENT) / 100;
  const hoursUntilFloorRaw = (last.remainingFraction - floorFraction) / burnRatePerHour;

  return {
    burnRatePerHour,
    projectedRemainingAtResetPercent: Math.round(Math.min(1, Math.max(0, projectedFraction)) * 100),
    hoursUntilFloor:
      last.remainingFraction <= floorFraction || !Number.isFinite(hoursUntilFloorRaw)
        ? null
        : hoursUntilFloorRaw,
  };
};

export const FAMILY_ORDER: Record<QuotaFamily, number> = {
  'gemini-hydrogen': 0,
  'gemini-argon': 1,
  claude: 2,
};

// Prototype-free table: an arbitrary state-file key such as `constructor` must not resolve to an inherited member.
export const FAMILY_ALIASES: Record<string, QuotaFamily> = Object.assign(Object.create(null), {
  'gemini-argon': 'gemini-argon',
  argon: 'gemini-argon',
  'gemini-hydrogen': 'gemini-hydrogen',
  hydrogen: 'gemini-hydrogen',
  // Legacy key from state files and pool ids written before the family was renamed.
  'gemini-flash': 'gemini-hydrogen',
  flash: 'gemini-hydrogen',
  claude: 'claude',
  sonnet: 'claude',
  '3p': 'claude',
} as Record<string, QuotaFamily>);

export const FAMILY_DISPLAY_NAMES: Record<QuotaFamily, string> = {
  'gemini-hydrogen': 'Gemini Hydrogen',
  'gemini-argon': 'Gemini Argon',
  claude: 'Claude and GPT models',
};

export const FAMILY_DEFAULT_MODELS: Record<QuotaFamily, string[]> = {
  'gemini-hydrogen': ['Gemini 4 Hydrogen', 'Gemini 3.8 Flash'],
  'gemini-argon': ['Gemini 4 Argon'],
  claude: ['Claude Opus', 'Claude Sonnet', 'GPT-OSS'],
};

const resolveCredits = (
  extraCredits: { remainingCredits?: number | null; overageEnabled?: boolean } | undefined,
  overageFallback: boolean | undefined
): { remainingCredits: number | null; overageEnabled: boolean | undefined } => ({
  remainingCredits: extraCredits?.remainingCredits ?? null,
  overageEnabled: extraCredits?.overageEnabled ?? overageFallback,
});

export const toSnapshot = (input: {
  family: QuotaFamily;
  remainingFraction: number;
  resetTime: string;
  hoursUntilReset: number;
  models: string[];
  buckets?: QuotaBucket[];
  weekly?: QuotaBucket;
  shortTerm?: QuotaBucket;
  overageEnabled?: boolean;
  remainingCredits?: number | null;
  poolId?: string;
  displayName?: string;
}): QuotaSnapshot => ({
  poolId: input.poolId ?? input.family,
  family: input.family,
  displayName: input.displayName ?? FAMILY_DISPLAY_NAMES[input.family],
  remainingFraction: input.remainingFraction,
  resetTime: input.resetTime,
  hoursUntilReset: input.hoursUntilReset,
  models: input.models,
  overageEnabled: input.overageEnabled,
  remainingCredits: input.remainingCredits,
  weekly: input.weekly,
  shortTerm: input.shortTerm,
  buckets: input.buckets,
});

export const resolveModelFamily = (config: {
  modelId?: string;
  label?: string;
}): {
  family: QuotaFamily;
  displayName: string;
} | null => {
  const mid = (config.modelId || '').toLowerCase();
  const lbl = (config.label || '').toLowerCase();

  if (mid.includes('argon') || lbl.includes('argon')) {
    return { family: 'gemini-argon', displayName: FAMILY_DISPLAY_NAMES['gemini-argon'] };
  }

  // The orchestrator codenames carry 'pro' rather than 'argon' but bill the Argon pool.
  if (mid.includes('orchestrator') || lbl.includes('orchestrator')) {
    return { family: 'gemini-argon', displayName: FAMILY_DISPLAY_NAMES['gemini-argon'] };
  }

  // Hydrogen shares the Flash pool and matches before the flash branch, so `gemini-4-hydrogen-*` needs no pool of its own.
  if (mid.includes('hydrogen') || lbl.includes('hydrogen')) {
    return { family: 'gemini-hydrogen', displayName: FAMILY_DISPLAY_NAMES['gemini-hydrogen'] };
  }

  // No bare 'pro' branch: `gemini-pro-orchestrator-g1-pro` is not a Flash model, so a substring match would charge the wrong pool.
  if (mid.includes('flash') || lbl.includes('flash')) {
    return { family: 'gemini-hydrogen', displayName: FAMILY_DISPLAY_NAMES['gemini-hydrogen'] };
  }

  if (
    mid.includes('claude') ||
    mid.includes('opus') ||
    mid.includes('sonnet') ||
    mid.includes('gpt-oss') ||
    lbl.includes('claude') ||
    lbl.includes('opus') ||
    lbl.includes('sonnet') ||
    lbl.includes('gpt-oss')
  ) {
    return { family: 'claude', displayName: FAMILY_DISPLAY_NAMES.claude };
  }

  return null;
};

const poolIdSlug = (name: string): string => {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'pool';
};

export const resolveGroupFamily = (
  groupName: string
): {
  family: QuotaFamily;
  displayName: string;
  defaultModels: string[];
} | null => {
  const name = groupName.toLowerCase();
  if (name.includes('argon')) {
    return {
      family: 'gemini-argon',
      displayName: FAMILY_DISPLAY_NAMES['gemini-argon'],
      defaultModels: FAMILY_DEFAULT_MODELS['gemini-argon'],
    };
  }
  if (name.includes('claude') || name.includes('gpt')) {
    return {
      family: 'claude',
      displayName: FAMILY_DISPLAY_NAMES.claude,
      defaultModels: FAMILY_DEFAULT_MODELS.claude,
    };
  }
  if (name.includes('gemini')) {
    return {
      family: 'gemini-hydrogen',
      displayName: FAMILY_DISPLAY_NAMES['gemini-hydrogen'],
      defaultModels: FAMILY_DEFAULT_MODELS['gemini-hydrogen'],
    };
  }
  return null;
};

export const aggregateUserQuotaSummary = (
  summary: RetrieveUserQuotaSummaryResponse,
  nowMs: number = Date.now(),
  extraCredits?: { remainingCredits?: number | null; overageEnabled?: boolean }
): QuotaSnapshot[] => {
  const result: QuotaSnapshot[] = [];
  // A family arriving as several quota groups needs one pool id per group, or the stored reset deadline flip-flops between them.
  const usedPoolIds = new Set<string>();
  // Overage stays undefined when no signal is available, so "unknown" is not reported as "disabled".
  const { remainingCredits, overageEnabled } = resolveCredits(
    extraCredits,
    summary.response.overageInfo?.enabled ?? summary.response.overage_info?.enabled
  );

  for (const group of summary.response.groups) {
    const resolved = resolveGroupFamily(group.displayName);
    if (!resolved) continue;

    const rawWeekly =
      (group.buckets || []).find(
        (b) =>
          b.window === 'weekly' ||
          b.bucketId.includes('weekly') ||
          b.displayName.toLowerCase().includes('weekly')
      ) || group.buckets?.[0];

    const weeklyResetTime = rawWeekly?.resetTime || '';
    const weeklyHours = weeklyResetTime ? calculateHoursUntilReset(weeklyResetTime, nowMs) : 0;

    const bucketsWithHours: QuotaBucket[] = (group.buckets || []).map((b) => {
      const bReset = b.resetTime || weeklyResetTime;
      const bHours = b.resetTime ? calculateHoursUntilReset(b.resetTime, nowMs) : weeklyHours;
      return {
        bucketId: b.bucketId,
        displayName: b.displayName,
        window: b.window || (b.bucketId.includes('5h') ? '5h' : 'weekly'),
        remainingFraction: b.remainingFraction,
        resetTime: bReset,
        hoursUntilReset: bHours,
        description: b.description,
        disabled: b.disabled,
      };
    });

    const weeklyBucket =
      bucketsWithHours.find(
        (b) =>
          b.window === 'weekly' ||
          b.bucketId.includes('weekly') ||
          b.displayName.toLowerCase().includes('weekly')
      ) || bucketsWithHours[0];

    const shortTermBucket = bucketsWithHours.find(
      (b) =>
        b.window === '5h' ||
        b.bucketId.includes('5h') ||
        b.displayName.toLowerCase().includes('5-hour') ||
        b.displayName.toLowerCase().includes('five hour')
    );

    const groupModels = resolved.defaultModels;

    if (weeklyBucket) {
      const basePoolId: string = resolved.family;
      let poolId: string = basePoolId;
      if (usedPoolIds.has(poolId)) {
        const slug = poolIdSlug(group.displayName);
        poolId = `${basePoolId}:${slug}`;
        let suffix = 2;
        while (usedPoolIds.has(poolId)) {
          poolId = `${basePoolId}:${slug}-${suffix++}`;
        }
      }
      usedPoolIds.add(poolId);

      result.push(
        toSnapshot({
          family: resolved.family,
          poolId,
          displayName: poolId === basePoolId ? undefined : group.displayName,
          remainingFraction: weeklyBucket.remainingFraction,
          resetTime: weeklyBucket.resetTime || '',
          hoursUntilReset: weeklyBucket.hoursUntilReset ?? 0,
          models: groupModels,
          overageEnabled,
          remainingCredits,
          weekly: weeklyBucket,
          shortTerm: shortTermBucket,
          buckets: bucketsWithHours,
        })
      );
    }
  }

  return result.sort((a, b) => FAMILY_ORDER[a.family] - FAMILY_ORDER[b.family]);
};

const inferFamilyFromQuotaInfo = (
  quotaInfo: { remainingFraction: number; resetTime: string },
  pools: Iterable<{ family: QuotaFamily; remainingFraction: number; resetTime: string }>
): QuotaFamily | null => {
  const matches: QuotaFamily[] = [];
  for (const pool of pools) {
    if (
      pool.remainingFraction === quotaInfo.remainingFraction &&
      pool.resetTime === quotaInfo.resetTime
    ) {
      matches.push(pool.family);
    }
  }
  return matches.length === 1 ? matches[0]! : null;
};

export const aggregateQuotaPools = (
  configs: LanguageServerModelConfig[],
  nowMs: number = Date.now(),
  extraCredits?: { remainingCredits?: number | null; overageEnabled?: boolean }
): QuotaSnapshot[] => {
  const poolMap = new Map<
    QuotaFamily,
    {
      family: QuotaFamily;
      displayName: string;
      remainingFraction: number;
      resetTime: string;
      models: Set<string>;
    }
  >();

  const orphans: LanguageServerModelConfig[] = [];

  for (const config of configs) {
    if (!config.quotaInfo) continue;
    const resolved = resolveModelFamily(config);
    if (!resolved) {
      orphans.push(config);
      continue;
    }

    const { family, displayName } = resolved;
    const modelLabel = config.label || config.modelId;

    if (!poolMap.has(family)) {
      poolMap.set(family, {
        family,
        displayName,
        remainingFraction: config.quotaInfo.remainingFraction,
        resetTime: config.quotaInfo.resetTime,
        models: new Set([modelLabel]),
      });
    } else {
      const existing = poolMap.get(family)!;
      existing.models.add(modelLabel);
      if (
        config.quotaInfo.resetTime &&
        (!existing.resetTime || config.quotaInfo.resetTime < existing.resetTime)
      ) {
        existing.resetTime = config.quotaInfo.resetTime;
      }
      if (typeof config.quotaInfo.remainingFraction === 'number') {
        existing.remainingFraction = Math.min(
          existing.remainingFraction,
          config.quotaInfo.remainingFraction
        );
      }
    }
  }

  const { remainingCredits, overageEnabled } = resolveCredits(extraCredits, false);

  for (const orphan of orphans) {
    const inferred = inferFamilyFromQuotaInfo(orphan.quotaInfo!, poolMap.values());
    if (!inferred) continue;
    poolMap.get(inferred)!.models.add(orphan.label || orphan.modelId);
  }

  const result: QuotaSnapshot[] = [];
  for (const entry of poolMap.values()) {
    const hoursUntilReset = calculateHoursUntilReset(entry.resetTime, nowMs);
    const weeklyBucket: QuotaBucket = {
      bucketId: `${entry.family}-weekly`,
      displayName: 'Weekly Limit',
      window: 'weekly',
      remainingFraction: entry.remainingFraction,
      resetTime: entry.resetTime,
      hoursUntilReset,
    };
    result.push(
      toSnapshot({
        family: entry.family,
        remainingFraction: entry.remainingFraction,
        resetTime: entry.resetTime,
        hoursUntilReset,
        models: Array.from(entry.models).sort(),
        overageEnabled,
        remainingCredits,
        weekly: weeklyBucket,
        buckets: [weeklyBucket],
      })
    );
  }

  return result.sort((a, b) => FAMILY_ORDER[a.family] - FAMILY_ORDER[b.family]);
};

export interface QuotaStatePoolLike {
  resetTime: string;
  remainingFraction: number;
  firedMilestones?: string[];
  lastAlertSentAt?: string | null;
  samples?: BurnSample[];
}

export interface QuotaStateLike {
  pools: Record<string, QuotaStatePoolLike>;
}

export const snapshotsFromSentryState = (
  state: QuotaStateLike,
  nowMs: number = Date.now()
): QuotaSnapshot[] => {
  const snapshots: QuotaSnapshot[] = [];
  for (const [poolId, pool] of Object.entries(state.pools ?? {})) {
    const rawId = poolId.toLowerCase().trim();
    const family = FAMILY_ALIASES[rawId] ?? FAMILY_ALIASES[rawId.split(':')[0] ?? ''];
    if (!family) continue;

    const hoursUntilReset = calculateHoursUntilReset(pool.resetTime, nowMs);
    const weeklyBucket: QuotaBucket = {
      bucketId: `${family}-weekly`,
      displayName: 'Weekly Limit',
      window: 'weekly',
      remainingFraction: pool.remainingFraction,
      resetTime: pool.resetTime,
      hoursUntilReset,
    };

    const snapshot = toSnapshot({
      poolId: upgradePoolFamilyId(poolId),
      family,
      remainingFraction: pool.remainingFraction,
      resetTime: pool.resetTime,
      hoursUntilReset,
      models: [...FAMILY_DEFAULT_MODELS[family]],
      weekly: weeklyBucket,
      buckets: [weeklyBucket],
    });

    const burnProjection = computeBurnProjection({
      samples: pool.samples,
      resetTime: pool.resetTime,
      nowMs,
    });
    if (burnProjection) snapshot.burnProjection = burnProjection;

    snapshots.push(snapshot);
  }

  return snapshots.sort((a, b) => FAMILY_ORDER[a.family] - FAMILY_ORDER[b.family]);
};
