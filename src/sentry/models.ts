import { z } from 'zod';

// Connect-RPC Language Server Schemas

export const QuotaInfoSchema = z.object({
  remainingFraction: z.number().min(0).max(1),
  resetTime: z.string(),
});

export type QuotaInfo = z.infer<typeof QuotaInfoSchema>;

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
  supportedMimeTypes: z.record(z.boolean()).optional(),
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

export type ClientModelSort = z.infer<typeof ClientModelSortSchema>;

export const LanguageServerResponseSchema = z.object({
  clientModelConfigs: z.array(LanguageServerModelConfigSchema),
  clientModelSorts: z.array(ClientModelSortSchema).optional(),
  defaultOverrideModelConfig: z.record(z.unknown()).optional(),
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

export type RawQuotaBucket = z.infer<typeof RawQuotaBucketSchema>;

export const RawQuotaGroupSchema = z.object({
  displayName: z.string(),
  description: z.string().optional(),
  buckets: z.array(RawQuotaBucketSchema),
});

export type RawQuotaGroup = z.infer<typeof RawQuotaGroupSchema>;

export const OverageInfoSchema = z.object({
  enabled: z.boolean().optional(),
});

export type OverageInfo = z.infer<typeof OverageInfoSchema>;

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

/**
 * Calculates hours until reset from an ISO 8601 string.
 * Returns 0 if already reset or invalid date.
 */
export const calculateHoursUntilReset = (resetTime: string, nowMs: number = Date.now()): number => {
  const resetEpoch = new Date(resetTime).getTime();
  if (Number.isNaN(resetEpoch)) return 0;
  const diffMs = resetEpoch - nowMs;
  if (diffMs <= 0) return 0;
  return Math.round((diffMs / (1000 * 60 * 60)) * 100) / 100;
};

/**
 * Formats time remaining in hours to human readable string (e.g. "23h 45m").
 */
export const formatHoursHuman = (hours: number): string => {
  if (hours <= 0) return '0m';
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
};

/**
 * Formats time remaining in hours to human-friendly calendar durations matching Antigravity native UI
 * (e.g. "4d 16h", "1d 3h", "6d 14h", "3h 18m").
 */
export const formatResetTimeHuman = (hours: number): string => {
  if (hours <= 0) return '0m';
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const rem = Math.floor(hours % 24);
    return rem > 0 ? `${days}d ${rem}h` : `${days}d`;
  }
  const h = Math.floor(hours);
  const m = Math.round((hours % 1) * 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
};

/**
 * Determines the canonical family for a model configuration.
 */
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
    return {
      family: 'gemini-argon',
      displayName: 'Gemini 4 Argon',
    };
  }

  if (mid.includes('flash') || lbl.includes('flash')) {
    return {
      family: 'gemini-flash',
      displayName: 'Gemini 3.8 Flash',
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
    return {
      family: 'claude',
      displayName: 'Claude 5.5 / Opus',
    };
  }

  return null;
};

/**
 * Determines canonical family and defaults from a RetrieveUserQuotaSummary group name.
 */
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
      displayName: 'Gemini 4 Argon',
      defaultModels: ['Gemini 4 Argon'],
    };
  }
  if (name.includes('claude') || name.includes('gpt')) {
    return {
      family: 'claude',
      displayName: 'Claude 5.5 / Opus',
      defaultModels: ['Claude Opus', 'Claude Sonnet', 'GPT-OSS'],
    };
  }
  if (name.includes('gemini')) {
    return {
      family: 'gemini-flash',
      displayName: 'Gemini 3.8 Flash / Pro',
      defaultModels: ['Gemini Flash', 'Gemini Pro'],
    };
  }
  return null;
};

/**
 * Aggregates RetrieveUserQuotaSummary Connect-RPC response into canonical QuotaSnapshot pools.
 * Accurately tracks both the Weekly Limit (primary eval target) and 5-Hour rolling limits.
 */
export const aggregateUserQuotaSummary = (
  summary: RetrieveUserQuotaSummaryResponse,
  nowMs: number = Date.now()
): QuotaSnapshot[] => {
  const result: QuotaSnapshot[] = [];
  const overageEnabled =
    summary.response.overageInfo?.enabled ?? summary.response.overage_info?.enabled ?? false;

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
      result.push({
        poolId: resolved.family,
        family: resolved.family,
        displayName: group.displayName || resolved.displayName,
        // The weekly limit is the primary eval target
        remainingFraction: weeklyBucket.remainingFraction,
        resetTime: weeklyBucket.resetTime,
        hoursUntilReset: weeklyBucket.hoursUntilReset,
        models: groupModels,
        overageEnabled,
        weekly: weeklyBucket,
        shortTerm: shortTermBucket,
        buckets: bucketsWithHours,
      });
    }
  }

  const order: Record<QuotaFamily, number> = {
    claude: 0,
    'gemini-argon': 1,
    'gemini-flash': 2,
  };

  return result.sort((a, b) => order[a.family] - order[b.family]);
};

/**
 * Aggregates raw language server model configs into canonical QuotaSnapshot pools.
 * Pools 13 raw models into 3 canonical family pools:
 * - claude: Claude 5.5 / 3.7 / 3.5 Sonnet, Opus, GPT-OSS
 * - gemini-argon: Gemini 4 Argon
 * - gemini-flash: Gemini 3.8 Flash
 */
export const aggregateQuotaPools = (
  configs: LanguageServerModelConfig[],
  nowMs: number = Date.now()
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
    result.push({
      poolId: entry.family,
      family: entry.family,
      displayName: entry.displayName,
      remainingFraction: entry.remainingFraction,
      resetTime: entry.resetTime,
      hoursUntilReset,
      models: Array.from(entry.models).sort(),
      weekly: weeklyBucket,
      buckets: [weeklyBucket],
    });
  }

  // Consistent ordering of pools: claude, gemini-argon, gemini-flash
  const order: Record<QuotaFamily, number> = {
    claude: 0,
    'gemini-argon': 1,
    'gemini-flash': 2,
  };

  return result.sort((a, b) => order[a.family] - order[b.family]);
};
