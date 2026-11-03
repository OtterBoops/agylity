import { z } from 'zod';

// Connect-RPC Language Server Schemas

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

export type LanguageServerResponse = z.infer<typeof LanguageServerResponseSchema>;

// Quota & Sentry Types

export type QuotaFamily = 'claude' | 'gemini-argon' | 'gemini-flash';

export const QuotaBucketSchema = z.object({
  bucketId: z.string(),
  displayName: z.string(),
  window: z.string().optional(),
  remainingFraction: z.number().min(0).max(1),
  resetTime: z.string(),
  hoursUntilReset: z.number().min(0),
  description: z.string().optional(),
});

export type QuotaBucket = z.infer<typeof QuotaBucketSchema>;

export const QuotaSnapshotSchema = z.object({
  poolId: z.string(),
  family: z.enum(['claude', 'gemini-argon', 'gemini-flash']),
  displayName: z.string(),
  // Primary evaluation target (weekly quota)
  remainingFraction: z.number().min(0).max(1),
  resetTime: z.string(),
  hoursUntilReset: z.number().min(0),
  models: z.array(z.string()),
  // AI overcharge / flex credit protection
  overageEnabled: z.boolean().optional(),
  remainingCredits: z.number().nullable().optional(),
  // Dual quota buckets
  weekly: QuotaBucketSchema.optional(),
  shortTerm: QuotaBucketSchema.optional(),
  buckets: z.array(QuotaBucketSchema).optional(),
});

export type QuotaSnapshot = z.infer<typeof QuotaSnapshotSchema>;

// RetrieveUserQuotaSummary RPC Schemas

export const RawQuotaBucketSchema = z.object({
  bucketId: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  window: z.string().optional(),
  remainingFraction: z.number().min(0).max(1),
  resetTime: z.string(),
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

// GetUserStatus RPC Schemas (authoritative source of plan / overage signals)

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

// Derives whether paid overage is enabled from GetUserStatus planInfo.
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

// Helpers & Aggregation

export const calculateHoursUntilReset = (resetTime: string, nowMs: number = Date.now()): number => {
  const resetEpoch = new Date(resetTime).getTime();
  if (Number.isNaN(resetEpoch)) return 0;
  const diffMs = resetEpoch - nowMs;
  if (diffMs <= 0) return 0;
  const hours = diffMs / (1000 * 60 * 60);
  return Math.max(0.0001, Math.round(hours * 1000) / 1000);
};

// Formats time remaining in hours to human readable string (e.g. "23h 45m").
export const formatHoursHuman = (hours: number): string => {
  if (hours <= 0) return '0m';
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
};

// Formats time remaining in hours to human-friendly calendar durations matching Antigravity native UI
export const formatResetTimeHuman = (hours: number): string => {
  if (hours <= 0) return '0m';
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const rem = Math.floor(hours % 24);
    return rem > 0 ? `${days}d ${rem}h` : `${days}d`;
  }
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
};

/** Canonical pool ordering, shared by every aggregator. */
export const FAMILY_ORDER: Record<QuotaFamily, number> = {
  'gemini-flash': 0,
  'gemini-argon': 1,
  claude: 2,
};

/** Accepted pool shorthands, in one place so every resolver agrees on them. */
export const FAMILY_ALIASES: Record<string, QuotaFamily> = {
  'gemini-argon': 'gemini-argon',
  argon: 'gemini-argon',
  'gemini-flash': 'gemini-flash',
  flash: 'gemini-flash',
  claude: 'claude',
  sonnet: 'claude',
  '3p': 'claude',
};

/** User-facing pool names, so no resolver carries its own copy. */
export const FAMILY_DISPLAY_NAMES: Record<QuotaFamily, string> = {
  'gemini-flash': 'Gemini Flash',
  'gemini-argon': 'Gemini Argon',
  claude: 'Claude and GPT models',
};

/** Fallback member models per pool, used when the API supplies none. */
export const FAMILY_DEFAULT_MODELS: Record<QuotaFamily, string[]> = {
  'gemini-flash': ['Gemini Flash', 'Gemini Pro'],
  'gemini-argon': ['Gemini 4 Argon'],
  claude: ['Claude Opus', 'Claude Sonnet', 'GPT-OSS'],
};

/** Credits and overage travel together; each aggregator supplies its own overage fallback. */
const resolveCredits = (
  extraCredits: { remainingCredits?: number | null; overageEnabled?: boolean } | undefined,
  overageFallback: boolean | undefined
): { remainingCredits: number | null; overageEnabled: boolean | undefined } => ({
  remainingCredits: extraCredits?.remainingCredits ?? null,
  overageEnabled: extraCredits?.overageEnabled ?? overageFallback,
});

/** Single place that knows the QuotaSnapshot shape; every aggregator funnels through it. */
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
}): QuotaSnapshot => ({
  poolId: input.poolId ?? input.family,
  family: input.family,
  displayName: FAMILY_DISPLAY_NAMES[input.family],
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

  if (mid.includes('flash') || lbl.includes('flash')) {
    return { family: 'gemini-flash', displayName: FAMILY_DISPLAY_NAMES['gemini-flash'] };
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

// Determines canonical family and defaults from a RetrieveUserQuotaSummary group name.
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
      family: 'gemini-flash',
      displayName: FAMILY_DISPLAY_NAMES['gemini-flash'],
      defaultModels: FAMILY_DEFAULT_MODELS['gemini-flash'],
    };
  }
  return null;
};

// Aggregates RetrieveUserQuotaSummary Connect-RPC response into canonical QuotaSnapshot pools.
export const aggregateUserQuotaSummary = (
  summary: RetrieveUserQuotaSummaryResponse,
  nowMs: number = Date.now(),
  extraCredits?: { remainingCredits?: number | null; overageEnabled?: boolean }
): QuotaSnapshot[] => {
  const result: QuotaSnapshot[] = [];
  // Overage stays undefined when no signal is available so "unknown" is not reported as disabled.
  const { remainingCredits, overageEnabled } = resolveCredits(
    extraCredits,
    summary.response.overageInfo?.enabled ?? summary.response.overage_info?.enabled
  );

  for (const group of summary.response.groups) {
    const resolved = resolveGroupFamily(group.displayName);
    if (!resolved) continue;

    const bucketsWithHours: QuotaBucket[] = (group.buckets || []).map((b) => ({
      bucketId: b.bucketId,
      displayName: b.displayName,
      window: b.window || (b.bucketId.includes('5h') ? '5h' : 'weekly'),
      remainingFraction: b.remainingFraction,
      resetTime: b.resetTime,
      hoursUntilReset: calculateHoursUntilReset(b.resetTime, nowMs),
      description: b.description,
    }));

    // Weekly bucket is the primary evaluation target
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

    let groupModels = resolved.defaultModels;
    if (
      group.description &&
      group.description.toLowerCase().includes('models within this group:')
    ) {
      const match = /models within this group:\s*([^\.]+)/i.exec(group.description);
      if (match && match[1]) {
        groupModels = match[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }

    if (weeklyBucket) {
      result.push(
        toSnapshot({
          family: resolved.family,
          // The weekly limit is the primary eval target
          remainingFraction: weeklyBucket.remainingFraction,
          resetTime: weeklyBucket.resetTime,
          hoursUntilReset: weeklyBucket.hoursUntilReset,
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

// Aggregates raw language server model configs into canonical QuotaSnapshot pools.
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

  for (const config of configs) {
    if (!config.quotaInfo) continue;
    const resolved = resolveModelFamily(config);
    if (!resolved) continue;

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
      // If resetTime is earlier or remainingFraction is strictly known, maintain consistent info
      if (
        config.quotaInfo.resetTime &&
        (!existing.resetTime || config.quotaInfo.resetTime < existing.resetTime)
      ) {
        existing.resetTime = config.quotaInfo.resetTime;
      }
      if (typeof config.quotaInfo.remainingFraction === 'number') {
        // In the language server all models in the same pool report equal remainingFraction.
        // We use Math.min to be conservative if any drift occurs.
        existing.remainingFraction = Math.min(
          existing.remainingFraction,
          config.quotaInfo.remainingFraction
        );
      }
    }
  }

  const { remainingCredits, overageEnabled } = resolveCredits(extraCredits, false);

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
    const family = FAMILY_ALIASES[rawId];
    // An unknown pool id must not be reported as another pool's headroom.
    if (!family) continue;

    const defaultModels =
      family === 'claude'
        ? ['claude-sonnet-5-5', 'claude-opus-5-5']
        : family === 'gemini-argon'
          ? ['gemini-4-argon']
          : ['gemini-3.8-flash'];

    const hoursUntilReset = calculateHoursUntilReset(pool.resetTime, nowMs);
    const weeklyBucket: QuotaBucket = {
      bucketId: `${family}-weekly`,
      displayName: 'Weekly Limit',
      window: 'weekly',
      remainingFraction: pool.remainingFraction,
      resetTime: pool.resetTime,
      hoursUntilReset,
    };

    snapshots.push(
      toSnapshot({
        poolId,
        family,
        remainingFraction: pool.remainingFraction,
        resetTime: pool.resetTime,
        hoursUntilReset,
        models: defaultModels,
        weekly: weeklyBucket,
        buckets: [weeklyBucket],
      })
    );
  }

  return snapshots.sort((a, b) => FAMILY_ORDER[a.family] - FAMILY_ORDER[b.family]);
};
