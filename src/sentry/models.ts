import { z } from 'zod';
import { POOL_GROUP_LABELS, upgradePoolGroupId, type PoolGroup } from '../shared/models.js';
import type {
  BurnSample,
  QuotaBucket,
  QuotaBurnProjection,
  QuotaSnapshot,
} from '../shared/contracts.js';

// Quota payloads are declared once in the shared wire contracts; the schemas below validate the
// language-server and state-file shapes that feed them.
export type { BurnSample, QuotaBucket, QuotaBurnProjection, QuotaSnapshot };

export const QuotaInfoSchema = z.object({
  remainingFraction: z.number().min(0).max(1),
  resetTime: z.string(),
});

// The server lists models it will not serve with `quotaInfo: {}`, so a telemetry-free placeholder
// must resolve to absent rather than fail the whole response parse.
const quotaInfoOrAbsent = (value: unknown): unknown => {
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  return record.remainingFraction === undefined || record.resetTime === undefined
    ? undefined
    : value;
};

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
  quotaInfo: z.preprocess(quotaInfoOrAbsent, QuotaInfoSchema.optional().nullable()),
  tagTitle: z.string().optional(),
  tagDescription: z.string().optional(),
  disabled: z.boolean().optional(),
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

export type { PoolGroup };

export const QuotaBucketSchema = z.object({
  bucketId: z.string(),
  displayName: z.string(),
  window: z.string().optional(),
  remainingFraction: z.number().min(0).max(1),
  resetTime: z.string().optional(),
  hoursUntilReset: z.number().min(0).nullable().optional(),
  description: z.string().optional(),
  disabled: z.boolean().optional(),
}) satisfies z.ZodType<QuotaBucket>;

export const QuotaSnapshotSchema = z.object({
  poolId: z.string(),
  poolGroup: z.enum(['claude', 'gemini-argon', 'gemini-hydrogen']),
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
}) satisfies z.ZodType<QuotaSnapshot>;

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

export const POOL_GROUP_ORDER: Record<PoolGroup, number> = {
  'gemini-hydrogen': 0,
  'gemini-argon': 1,
  claude: 2,
};

// Prototype-free table: an arbitrary state-file key such as `constructor` must not resolve to an inherited member.
export const POOL_GROUP_ALIASES: Record<string, PoolGroup> = Object.assign(Object.create(null), {
  'gemini-argon': 'gemini-argon',
  argon: 'gemini-argon',
  'gemini-hydrogen': 'gemini-hydrogen',
  hydrogen: 'gemini-hydrogen',
  // Legacy key from state files and pool ids written before the pool group was renamed.
  'gemini-flash': 'gemini-hydrogen',
  flash: 'gemini-hydrogen',
  claude: 'claude',
  sonnet: 'claude',
  '3p': 'claude',
} as Record<string, PoolGroup>);

export const POOL_GROUP_DISPLAY_NAMES: Record<PoolGroup, string> = POOL_GROUP_LABELS;

export const POOL_GROUP_DEFAULT_MODELS: Record<PoolGroup, string[]> = {
  'gemini-hydrogen': ['Gemini 4 Hydrogen', 'Gemini 4 Neon', 'Gemini 3.8 Flash'],
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
  poolGroup: PoolGroup;
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
  poolId: input.poolId ?? input.poolGroup,
  poolGroup: input.poolGroup,
  displayName: input.displayName ?? POOL_GROUP_DISPLAY_NAMES[input.poolGroup],
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

export const poolGroupForModelConfig = (config: {
  modelId?: string;
  label?: string;
}): {
  poolGroup: PoolGroup;
  displayName: string;
} | null => {
  const mid = (config.modelId || '').toLowerCase();
  const lbl = (config.label || '').toLowerCase();

  // A `-disabled` id is a listing placeholder with no quota; it belongs to no pool.
  if (mid.endsWith('-disabled')) return null;

  if (mid.includes('argon') || lbl.includes('argon')) {
    return { poolGroup: 'gemini-argon', displayName: POOL_GROUP_DISPLAY_NAMES['gemini-argon'] };
  }

  // Carbon and Neon run on Hydrogen and match before the orchestrator prefix, which spans both pools.
  if (
    mid.includes('carbon') ||
    lbl.includes('carbon') ||
    mid.includes('neon') ||
    lbl.includes('neon')
  ) {
    return {
      poolGroup: 'gemini-hydrogen',
      displayName: POOL_GROUP_DISPLAY_NAMES['gemini-hydrogen'],
    };
  }

  // Only the G1 Pro route bills Argon; a bare `gemini-pro-orchestrator` is the Carbon route.
  if (mid.includes('orchestrator') || lbl.includes('orchestrator')) {
    const poolGroup: PoolGroup = mid.includes('g1-pro') ? 'gemini-argon' : 'gemini-hydrogen';
    return { poolGroup, displayName: POOL_GROUP_DISPLAY_NAMES[poolGroup] };
  }

  // Hydrogen shares the Flash pool and matches before the flash branch, so `gemini-4-hydrogen-*` needs no pool of its own.
  if (mid.includes('hydrogen') || lbl.includes('hydrogen')) {
    return {
      poolGroup: 'gemini-hydrogen',
      displayName: POOL_GROUP_DISPLAY_NAMES['gemini-hydrogen'],
    };
  }

  // No bare 'pro' branch: `gemini-pro-orchestrator-g1-pro` is not a Flash model, so a substring match would charge the wrong pool.
  if (mid.includes('flash') || lbl.includes('flash')) {
    return {
      poolGroup: 'gemini-hydrogen',
      displayName: POOL_GROUP_DISPLAY_NAMES['gemini-hydrogen'],
    };
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
    return { poolGroup: 'claude', displayName: POOL_GROUP_DISPLAY_NAMES.claude };
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

export const resolvePoolGroupForQuotaGroup = (
  groupName: string
): {
  poolGroup: PoolGroup;
  displayName: string;
  defaultModels: string[];
} | null => {
  const name = groupName.toLowerCase();
  if (name.includes('argon')) {
    return {
      poolGroup: 'gemini-argon',
      displayName: POOL_GROUP_DISPLAY_NAMES['gemini-argon'],
      defaultModels: POOL_GROUP_DEFAULT_MODELS['gemini-argon'],
    };
  }
  if (name.includes('claude') || name.includes('gpt')) {
    return {
      poolGroup: 'claude',
      displayName: POOL_GROUP_DISPLAY_NAMES.claude,
      defaultModels: POOL_GROUP_DEFAULT_MODELS.claude,
    };
  }
  if (name.includes('gemini')) {
    return {
      poolGroup: 'gemini-hydrogen',
      displayName: POOL_GROUP_DISPLAY_NAMES['gemini-hydrogen'],
      defaultModels: POOL_GROUP_DEFAULT_MODELS['gemini-hydrogen'],
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
  // A pool group arriving as several quota groups needs one pool id per group, or the stored reset
  // deadline flip-flops between them.
  const usedPoolIds = new Set<string>();
  // Overage stays undefined when no signal is available, so "unknown" is not reported as "disabled".
  const { remainingCredits, overageEnabled } = resolveCredits(
    extraCredits,
    summary.response.overageInfo?.enabled ?? summary.response.overage_info?.enabled
  );

  for (const group of summary.response.groups) {
    const resolved = resolvePoolGroupForQuotaGroup(group.displayName);
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
      const basePoolId: string = resolved.poolGroup;
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
          poolGroup: resolved.poolGroup,
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

  return result.sort((a, b) => POOL_GROUP_ORDER[a.poolGroup] - POOL_GROUP_ORDER[b.poolGroup]);
};

const inferPoolGroupFromQuotaInfo = (
  quotaInfo: { remainingFraction: number; resetTime: string },
  pools: Iterable<{ poolGroup: PoolGroup; remainingFraction: number; resetTime: string }>
): PoolGroup | null => {
  const matches: PoolGroup[] = [];
  for (const pool of pools) {
    if (
      pool.remainingFraction === quotaInfo.remainingFraction &&
      pool.resetTime === quotaInfo.resetTime
    ) {
      matches.push(pool.poolGroup);
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
    PoolGroup,
    {
      poolGroup: PoolGroup;
      displayName: string;
      remainingFraction: number;
      resetTime: string;
      models: Set<string>;
    }
  >();

  const orphans: LanguageServerModelConfig[] = [];

  for (const config of configs) {
    // A disabled entry keeps the pool's numbers but is not a usable model for that pool.
    if (config.disabled) continue;
    if (!config.quotaInfo) continue;
    const resolved = poolGroupForModelConfig(config);
    if (!resolved) {
      orphans.push(config);
      continue;
    }

    const { poolGroup, displayName } = resolved;
    const modelLabel = config.label || config.modelId;

    if (!poolMap.has(poolGroup)) {
      poolMap.set(poolGroup, {
        poolGroup,
        displayName,
        remainingFraction: config.quotaInfo.remainingFraction,
        resetTime: config.quotaInfo.resetTime,
        models: new Set([modelLabel]),
      });
    } else {
      const existing = poolMap.get(poolGroup)!;
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
    const inferred = inferPoolGroupFromQuotaInfo(orphan.quotaInfo!, poolMap.values());
    if (!inferred) continue;
    poolMap.get(inferred)!.models.add(orphan.label || orphan.modelId);
  }

  const result: QuotaSnapshot[] = [];
  for (const entry of poolMap.values()) {
    const hoursUntilReset = calculateHoursUntilReset(entry.resetTime, nowMs);
    const weeklyBucket: QuotaBucket = {
      bucketId: `${entry.poolGroup}-weekly`,
      displayName: 'Weekly Limit',
      window: 'weekly',
      remainingFraction: entry.remainingFraction,
      resetTime: entry.resetTime,
      hoursUntilReset,
    };
    result.push(
      toSnapshot({
        poolGroup: entry.poolGroup,
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

  return result.sort((a, b) => POOL_GROUP_ORDER[a.poolGroup] - POOL_GROUP_ORDER[b.poolGroup]);
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
    const poolGroup = POOL_GROUP_ALIASES[rawId] ?? POOL_GROUP_ALIASES[rawId.split(':')[0] ?? ''];
    if (!poolGroup) continue;

    const hoursUntilReset = calculateHoursUntilReset(pool.resetTime, nowMs);
    const weeklyBucket: QuotaBucket = {
      bucketId: `${poolGroup}-weekly`,
      displayName: 'Weekly Limit',
      window: 'weekly',
      remainingFraction: pool.remainingFraction,
      resetTime: pool.resetTime,
      hoursUntilReset,
    };

    const snapshot = toSnapshot({
      poolId: upgradePoolGroupId(poolId),
      poolGroup,
      remainingFraction: pool.remainingFraction,
      resetTime: pool.resetTime,
      hoursUntilReset,
      models: [...POOL_GROUP_DEFAULT_MODELS[poolGroup]],
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

  return snapshots.sort((a, b) => POOL_GROUP_ORDER[a.poolGroup] - POOL_GROUP_ORDER[b.poolGroup]);
};
