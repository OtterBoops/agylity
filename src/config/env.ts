import { z } from 'zod';
import { logger } from '../logs/logger.js';
import { DEFAULT_MILESTONE_HOURS } from '../shared/defaults.js';
export {
  DEFAULT_BACKLOG_CONCURRENCY,
  DEFAULT_BACKLOG_MIN_HEADROOM_PERCENT,
  DEFAULT_MILESTONE_HOURS,
  DEFAULT_QUOTA_BURN_MAX_HOURS,
} from '../shared/defaults.js';
import { isValidIpRange } from '../net/ip.js';
import {
  NOTIFICATION_DESTINATION_TYPES,
  PR_POLICY_VALUES,
  type PrPolicy,
} from '../shared/contracts.js';
import { LEGACY_POOL_GROUPS } from '../shared/models.js';
import {
  DEFAULT_NOTIFICATION_TYPES,
  NOTIFICATION_KIND_VALUES,
  type NotificationKind,
} from '../shared/notificationKinds.js';

export const warnEnvFallback = (variable: string, reason: string): void =>
  logger.child('config').warn('%s: %s; falling back to default', variable, reason);

// A custom header map is flat and string-valued, so a nested or numeric entry is a rejection, not a coercion.
export const isPlainStringRecord = (val: unknown): val is Record<string, string> =>
  typeof val === 'object' &&
  val !== null &&
  !Array.isArray(val) &&
  Object.values(val as Record<string, unknown>).every((v) => typeof v === 'string');

export const booleanEnv = z.preprocess((val) => {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    if (['true', '1', 'yes'].includes(s)) return true;
    if (['false', '0', 'no', ''].includes(s)) return false;
  }
  return val;
}, z.boolean());

export const milestoneHoursEnv = z.preprocess((val) => {
  if (Array.isArray(val)) {
    return val.map(Number).filter((n) => !Number.isNaN(n) && n > 0);
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed === '') return DEFAULT_MILESTONE_HOURS;
    return trimmed
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => !Number.isNaN(n) && n > 0);
  }
  return val;
}, z.array(z.number().positive()).min(1).default(DEFAULT_MILESTONE_HOURS));

export const RepositorySchema = z.preprocess(
  (val) => {
    if (typeof val === 'object' && val !== null) {
      const raw = val as Record<string, unknown>;
      const cloneUrl = typeof raw.cloneUrl === 'string' ? raw.cloneUrl.trim() : undefined;
      const description = typeof raw.description === 'string' ? raw.description.trim() : '';
      let derivedId = typeof raw.id === 'string' ? raw.id.trim() : '';
      let derivedName = typeof raw.name === 'string' ? raw.name.trim() : '';
      let derivedPath = typeof raw.path === 'string' ? raw.path.trim() : '';

      if (!derivedId && cloneUrl) {
        const match = cloneUrl.match(/([^/:]+)\/([^/]+?)(?:\.git)?\/*$/);
        if (match && match[2]) {
          derivedId = match[2];
          if (!derivedName) derivedName = `${match[1]}/${match[2]}`;
        } else {
          derivedId = cloneUrl.replace(/[^a-zA-Z0-9_-]/g, '_');
          if (!derivedName) derivedName = derivedId;
        }
      }

      if (!derivedId && derivedName) {
        derivedId = derivedName.split('/').pop() || derivedName;
      }

      if (!derivedPath && cloneUrl && derivedId) {
        derivedPath = `/repos/${derivedId}`;
      }

      return {
        id: derivedId,
        name: derivedName,
        path: derivedPath,
        cloneUrl,
        ...(description !== '' ? { description } : {}),
        defaultBranch:
          typeof raw.defaultBranch === 'string' && raw.defaultBranch.trim() !== ''
            ? raw.defaultBranch.trim()
            : 'main',
      };
    }
    return val;
  },
  z.object({
    id: z.string().min(1, 'Repository ID is required'),
    name: z.string().min(1, 'Repository name is required'),
    path: z.string().min(1, 'Repository filesystem path is required'),
    cloneUrl: z.string().optional(),
    description: z.string().optional(),
    defaultBranch: z.string().default('main'),
  })
);

export type RepositoryEntry = z.infer<typeof RepositorySchema>;

export const PoolPolicySchema = z.object({
  alertsEnabled: z.boolean(),
  dispatchEnabled: z.boolean(),
});

// A policy set saved before the Gemini pools were merged carries the old group keys; the merged key
// wins when both are present.
export const normalizePoolPolicyKeys = (val: unknown): unknown => {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return val;
  const raw = { ...(val as Record<string, unknown>) };
  let changed = false;
  for (const [legacy, group] of Object.entries(LEGACY_POOL_GROUPS)) {
    if (raw[legacy] === undefined) continue;
    if (raw[group] === undefined) raw[group] = raw[legacy];
    delete raw[legacy];
    changed = true;
  }
  return changed ? raw : val;
};

export const PoolGroupPoliciesSchema = z.preprocess(
  normalizePoolPolicyKeys,
  z.object({
    gemini: PoolPolicySchema,
    claude: PoolPolicySchema,
  })
);

export type PoolGroupPolicies = z.infer<typeof PoolGroupPoliciesSchema>;

export const NotificationTypesSchema = z
  .partialRecord(
    z.enum(NOTIFICATION_KIND_VALUES as [NotificationKind, ...NotificationKind[]]),
    z.boolean()
  )
  .transform((value) => ({ ...DEFAULT_NOTIFICATION_TYPES, ...value }))
  .default(DEFAULT_NOTIFICATION_TYPES);

export type NotificationTypes = z.infer<typeof NotificationTypesSchema>;

export const DEFAULT_POOL_GROUP_POLICIES: PoolGroupPolicies = {
  gemini: { alertsEnabled: true, dispatchEnabled: true },
  claude: { alertsEnabled: false, dispatchEnabled: false },
};

export const RepositoriesJsonSchema = z.preprocess((val) => {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed === '') return [];
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new Error('REPOSITORIES_JSON contains invalid JSON syntax');
    }
  }
  return val;
}, z.array(RepositorySchema).default([]));

// The values and the union live in the shared wire contracts; this schema only validates env input.
export const PrPolicyEnum = z.enum(PR_POLICY_VALUES);
export type { PrPolicy };

export const NotificationChannelEnum = z.enum(['discord', 'webhook', 'none']);
export type NotificationChannelType = z.infer<typeof NotificationChannelEnum>;

export const NotificationDestinationSchema = z.object({
  id: z.string().min(1),
  type: z.enum(NOTIFICATION_DESTINATION_TYPES),
  label: z.string().default(''),
  enabled: z.boolean().default(true),
  pingOwner: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const DestinationsSchema = z.array(NotificationDestinationSchema).default([]);

export const DestinationsJsonSchema = z.preprocess((val) => {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed === '') return [];
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new Error('NOTIFICATION_DESTINATIONS_JSON contains invalid JSON syntax');
    }
  }
  return val;
}, DestinationsSchema);

export const NotificationChannelsSchema = z.preprocess((val) => {
  if (Array.isArray(val)) {
    return val
      .map((v) => String(v).trim().toLowerCase())
      .filter((v) => ['discord', 'webhook', 'none'].includes(v));
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed || trimmed.toLowerCase() === 'none') return [];
    return trimmed
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => ['discord', 'webhook'].includes(s));
  }
  return [];
}, z.array(NotificationChannelEnum).default([]));

// A custom header map is flat and string-valued, so a nested or numeric entry is a rejection, not a coercion.
export const WebhookHeadersSchema = z.string().transform((raw, ctx) => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'invalid JSON syntax' });
    return z.NEVER;
  }
  if (!isPlainStringRecord(decoded)) {
    ctx.addIssue({ code: 'custom', message: 'expected a flat object of string header values' });
    return z.NEVER;
  }
  return decoded;
});

export const AllowedIpRangesSchema = z.string().transform((raw) =>
  raw
    .split(',')
    .map((range) => range.trim())
    .filter(Boolean)
);

export const IpRangeEntrySchema = z
  .string()
  .trim()
  .refine((entry) => isValidIpRange(entry), {
    message: 'invalid IP address or CIDR range',
  });

export const TrustedProxyRangesOverrideSchema = z.array(IpRangeEntrySchema);

export const TrustedProxyRangesEnvSchema = AllowedIpRangesSchema.pipe(
  TrustedProxyRangesOverrideSchema
);
