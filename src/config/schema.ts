import { z } from 'zod';

// Safe boolean preprocessor preventing Boolean('false') === true coercion trap
export const booleanEnv = z.preprocess((val) => {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    if (['true', '1', 'yes'].includes(s)) return true;
    if (['false', '0', 'no', ''].includes(s)) return false;
  }
  return val;
}, z.boolean());

// Safe number parser with integer bounds
export const integerEnv = (defaultVal: number, min = 1) =>
  z
    .preprocess((val) => {
      if (typeof val === 'number') return val;
      if (typeof val === 'string' && val.trim() !== '') return Number(val);
      return val;
    }, z.number().int().min(min))
    .default(defaultVal);

// Safe comma-separated milestone parser ("24,12,3" -> [24, 12, 3])
export const milestoneHoursEnv = z.preprocess(
  (val) => {
    if (Array.isArray(val)) {
      return val.map(Number).filter((n) => !Number.isNaN(n) && n > 0);
    }
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (trimmed === '') return [24, 12, 3];
      return trimmed
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => !Number.isNaN(n) && n > 0);
    }
    return val;
  },
  z.array(z.number().positive()).default([24, 12, 3])
);

// Repository schema
export const RepositorySchema = z.object({
  id: z.string().min(1, 'Repository ID is required'),
  name: z.string().min(1, 'Repository name is required'),
  path: z.string().min(1, 'Repository filesystem path is required'),
  description: z.string().optional(),
  defaultBranch: z.string().default('main'),
});

export type RepositoryEntry = z.infer<typeof RepositorySchema>;

// Repositories JSON parser
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

// MAC address validator
export const MacAddressSchema = z
  .string()
  .regex(
    /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/,
    'Invalid MAC address format (expected AA:BB:CC:DD:EE:FF)'
  );

// Notification channels
export const NotificationChannelEnum = z.enum(['discord', 'console', 'webhook']);
export type NotificationChannelType = z.infer<typeof NotificationChannelEnum>;

// Raw Environment Schema for process.env ingestion
export const RawEnvSchema = z.object({
  /* Notification Channel */
  NOTIFICATION_CHANNEL: NotificationChannelEnum.optional(),
  NOTIFICATION_WEBHOOK_URL: z.string().url().optional().or(z.literal('')),
  DISCORD_TOKEN: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_GUILD_ID: z.string().optional(),
  DISCORD_NOTIFICATION_CHANNEL_ID: z.string().optional(),

  /* Quota Sentry & RPC */
  ANTIGRAVITY_ENDPOINT_URL: z.string().url().optional().or(z.literal('')),
  ANTIGRAVITY_CSRF_TOKEN: z.string().optional(),
  ANTIGRAVITY_LS_PORT: z.coerce.number().int().positive().optional(),
  QUOTA_CHECK_INTERVAL_SECONDS: z.coerce.number().int().min(10).optional(),
  QUOTA_ALERT_THRESHOLD_PERCENT: z.coerce.number().min(0).max(100).optional(),
  QUOTA_MILESTONE_HOURS: z.string().optional(),
  QUOTA_STATE_FILE_PATH: z.string().optional(),
  MIN_DISPATCH_HEADROOM_PERCENT: z.coerce.number().min(0).max(100).optional(),

  /* Repositories */
  REPOSITORIES_JSON: z.string().optional(),

  /* Persistence */
  DATABASE_PATH: z.string().optional(),

  /* Optional Orchestrator */
  ORCHESTRATOR_ENABLED: z.string().optional(),

  /* Optional Web UI */
  WEB_UI_ENABLED: z.string().optional(),
  WEB_UI_PORT: z.coerce.number().int().positive().optional(),
  WEB_UI_HOST: z.string().optional(),
});

export type RawEnv = z.infer<typeof RawEnvSchema>;

// Full Typed Application Configuration Contract
export interface AppConfig {
  notificationChannel: NotificationChannelType;
  notificationWebhookUrl?: string;
  discordToken?: string;
  discordClientId?: string;
  discordGuildId?: string;
  discordNotificationChannelId?: string;

  antigravityEndpointUrl?: string;
  antigravityCsrfToken?: string;
  antigravityLsPort?: number;
  quotaCheckIntervalSeconds: number;
  quotaAlertThresholdPercent: number;
  quotaMilestoneHours: number[];
  quotaStateFilePath: string;
  minDispatchHeadroomPercent: number;

  repositories: RepositoryEntry[];
  databasePath: string;

  orchestratorEnabled: boolean;

  webUiEnabled: boolean;
  webUiPort: number;
  webUiHost: string;
}

export type ResolvedConfig = AppConfig;

// Built-in Defaults (Level 3 Fallback)
export const BUILTIN_DEFAULTS: AppConfig = {
  notificationChannel: 'discord',
  notificationWebhookUrl: undefined,
  discordToken: undefined,
  discordClientId: undefined,
  discordGuildId: undefined,
  discordNotificationChannelId: undefined,

  antigravityEndpointUrl: undefined,
  antigravityCsrfToken: undefined,
  antigravityLsPort: 60643,
  quotaCheckIntervalSeconds: 900, // 15 minutes
  quotaAlertThresholdPercent: 25, // 25% remaining quota triggers alert
  quotaMilestoneHours: [24, 12, 3],
  quotaStateFilePath: 'data/state.json',
  minDispatchHeadroomPercent: 10, // 10% safety floor preventing billable overages

  repositories: [],
  databasePath: 'data/agylity.db',

  orchestratorEnabled: false,

  webUiEnabled: false,
  webUiPort: 3000,
  webUiHost: '0.0.0.0',
};

export const parseRawEnv = (env: Record<string, string | undefined>): Partial<AppConfig> => {
  const parsed = RawEnvSchema.parse(env);
  const result: Partial<AppConfig> = {};

  if (parsed.NOTIFICATION_CHANNEL) result.notificationChannel = parsed.NOTIFICATION_CHANNEL;
  if (parsed.NOTIFICATION_WEBHOOK_URL)
    result.notificationWebhookUrl = parsed.NOTIFICATION_WEBHOOK_URL;
  if (parsed.DISCORD_TOKEN) result.discordToken = parsed.DISCORD_TOKEN;
  if (parsed.DISCORD_CLIENT_ID) result.discordClientId = parsed.DISCORD_CLIENT_ID;
  if (parsed.DISCORD_GUILD_ID) result.discordGuildId = parsed.DISCORD_GUILD_ID;
  if (parsed.DISCORD_NOTIFICATION_CHANNEL_ID)
    result.discordNotificationChannelId = parsed.DISCORD_NOTIFICATION_CHANNEL_ID;

  if (parsed.ANTIGRAVITY_ENDPOINT_URL)
    result.antigravityEndpointUrl = parsed.ANTIGRAVITY_ENDPOINT_URL;
  if (parsed.ANTIGRAVITY_CSRF_TOKEN) result.antigravityCsrfToken = parsed.ANTIGRAVITY_CSRF_TOKEN;
  if (parsed.ANTIGRAVITY_LS_PORT !== undefined)
    result.antigravityLsPort = parsed.ANTIGRAVITY_LS_PORT;
  if (parsed.QUOTA_CHECK_INTERVAL_SECONDS !== undefined)
    result.quotaCheckIntervalSeconds = parsed.QUOTA_CHECK_INTERVAL_SECONDS;
  if (parsed.QUOTA_ALERT_THRESHOLD_PERCENT !== undefined)
    result.quotaAlertThresholdPercent = parsed.QUOTA_ALERT_THRESHOLD_PERCENT;
  if (parsed.QUOTA_MILESTONE_HOURS) {
    result.quotaMilestoneHours = milestoneHoursEnv.parse(parsed.QUOTA_MILESTONE_HOURS);
  }
  if (parsed.QUOTA_STATE_FILE_PATH) result.quotaStateFilePath = parsed.QUOTA_STATE_FILE_PATH;
  if (parsed.MIN_DISPATCH_HEADROOM_PERCENT !== undefined) {
    result.minDispatchHeadroomPercent = parsed.MIN_DISPATCH_HEADROOM_PERCENT;
  }

  if (parsed.REPOSITORIES_JSON) {
    result.repositories = RepositoriesJsonSchema.parse(parsed.REPOSITORIES_JSON);
  }
  if (parsed.DATABASE_PATH) result.databasePath = parsed.DATABASE_PATH;

  if (parsed.ORCHESTRATOR_ENABLED !== undefined && parsed.ORCHESTRATOR_ENABLED.trim() !== '') {
    result.orchestratorEnabled = booleanEnv.parse(parsed.ORCHESTRATOR_ENABLED);
  }

  if (parsed.WEB_UI_ENABLED !== undefined && parsed.WEB_UI_ENABLED.trim() !== '') {
    result.webUiEnabled = booleanEnv.parse(parsed.WEB_UI_ENABLED);
  }
  if (parsed.WEB_UI_PORT !== undefined) result.webUiPort = parsed.WEB_UI_PORT;
  if (parsed.WEB_UI_HOST) result.webUiHost = parsed.WEB_UI_HOST;

  return result;
};
