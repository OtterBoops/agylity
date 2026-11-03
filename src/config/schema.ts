import { z } from 'zod';
import { logger } from '../logs/logger.js';

// A malformed env value must degrade to the built-in default, never crash the daemon at boot.
const warnEnvFallback = (variable: string, reason: string): void =>
  logger.child('config').warn('%s: %s; falling back to default', variable, reason);

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

/** Default milestone hours, referenced by the parser, the schema and the evaluator. */
export const DEFAULT_MILESTONE_HOURS = [24, 12, 3];

// Safe comma-separated milestone parser ("24,12,3" -> [24, 12, 3])
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

// Repository schema
export const RepositorySchema = z.preprocess(
  (val) => {
    if (typeof val === 'object' && val !== null) {
      const raw = val as Record<string, unknown>;
      const cloneUrl = typeof raw.cloneUrl === 'string' ? raw.cloneUrl.trim() : undefined;
      let derivedId = typeof raw.id === 'string' ? raw.id.trim() : '';
      let derivedName = typeof raw.name === 'string' ? raw.name.trim() : '';
      let derivedPath = typeof raw.path === 'string' ? raw.path.trim() : '';

      if (!derivedId && cloneUrl) {
        const match = cloneUrl.match(/([^/:]+)\/([^/]+?)(?:\.git)?$/);
        if (match && match[2]) {
          derivedId = match[2];
          if (!derivedName) derivedName = `${match[1]}/${match[2]}`;
        } else {
          derivedId = cloneUrl.replace(/[^a-zA-Z0-9_-]/g, '_');
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

export const PoolPoliciesSchema = z.object({
  claude: PoolPolicySchema,
  'gemini-argon': PoolPolicySchema,
  'gemini-flash': PoolPolicySchema,
});

export type PoolPolicies = z.infer<typeof PoolPoliciesSchema>;

export const DEFAULT_POOL_POLICIES: PoolPolicies = {
  'gemini-argon': { alertsEnabled: true, dispatchEnabled: true },
  'gemini-flash': { alertsEnabled: true, dispatchEnabled: true },
  claude: { alertsEnabled: false, dispatchEnabled: false },
};

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

// Notification channels
export const NotificationChannelEnum = z.enum(['discord', 'console', 'webhook', 'none']);
export type NotificationChannelType = z.infer<typeof NotificationChannelEnum>;

export const NotificationChannelsSchema = z.preprocess((val) => {
  if (Array.isArray(val)) {
    return val
      .map((v) => String(v).trim().toLowerCase())
      .filter((v) => ['discord', 'webhook', 'console', 'none'].includes(v));
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed || trimmed.toLowerCase() === 'none') return [];
    return trimmed
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => ['discord', 'webhook', 'console'].includes(s));
  }
  return [];
}, z.array(NotificationChannelEnum).default([]));

// Raw Environment Schema for process.env ingestion
export const RawEnvSchema = z.object({
  /* Notification Channels */
  NOTIFICATION_CHANNELS: z.string().optional(),
  NOTIFICATION_CHANNEL: NotificationChannelEnum.optional(),
  NOTIFICATION_WEBHOOK_URL: z.string().url().optional().or(z.literal('')),
  WEBHOOK_URL: z.string().url().optional().or(z.literal('')),
  WEBHOOK_SECRET: z.string().optional(),
  WEBHOOK_CUSTOM_HEADERS: z.string().optional(),
  DISCORD_TOKEN: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_GUILD_ID: z.string().optional(),
  DISCORD_NOTIFICATION_CHANNEL_ID: z.string().optional(),
  DISCORD_OWNER_USER_ID: z.string().optional(),
  DISCORD_PING_OWNER: z.string().optional(),

  /* Quota Sentry & RPC */
  ANTIGRAVITY_ENDPOINT_URL: z.string().url().optional().or(z.literal('')),
  ANTIGRAVITY_CSRF_TOKEN: z.string().optional(),
  QUOTA_CHECK_INTERVAL_SECONDS: z.coerce.number().int().min(30).optional(),
  QUOTA_ALERT_THRESHOLD_PERCENT: z.coerce.number().min(0).max(100).optional(),
  QUOTA_MILESTONE_HOURS: z.string().optional(),
  MIN_DISPATCH_HEADROOM_PERCENT: z.coerce.number().min(0).max(100).optional(),

  /* Repositories */
  REPOSITORIES_JSON: z.string().optional(),

  /* Optional Orchestrator */
  ORCHESTRATOR_ENABLED: z.string().optional(),
  DEFAULT_DISPATCH_MODEL: z.string().optional(),
  DEFAULT_DISPATCH_EFFORT: z.enum(['low', 'medium', 'high']).optional(),
  WORKER_SHARED_SECRET: z.string().optional(),
  QUOTA_BURN_MAX_HOURS: z.coerce.number().positive().optional(),
  QUOTA_BURN_MIN_HEADROOM_PERCENT: z.coerce.number().min(0).max(100).optional(),

  /* Optional Web UI */
  WEB_UI_ENABLED: z.string().optional(),
  ALLOW_OVERAGE: z.string().optional(),
  WEB_UI_PORT: z.coerce.number().int().positive().optional(),
  WEB_UI_HOST: z.string().optional(),
  WEB_UI_AUTH_TOKEN: z.string().optional(),

  /* In-App Network & IP Security */
  ALLOWED_IP_RANGES: z.string().optional(),
  TRUSTED_PROXIES: z.string().optional(),

  /* Logging */
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional(),
});

export type RawEnv = z.infer<typeof RawEnvSchema>;

// Full Typed Application Configuration Contract
export interface AppConfig {
  notificationChannel: NotificationChannelType;
  notificationChannels: NotificationChannelType[];
  notificationWebhookUrl?: string;
  webhookSecret?: string;
  webhookCustomHeaders?: Record<string, string>;
  discordToken?: string;
  discordClientId?: string;
  discordGuildId?: string;
  discordNotificationChannelId?: string;
  discordOwnerUserId?: string;
  discordPingOwner: boolean;

  antigravityEndpointUrl?: string;
  antigravityCsrfToken?: string;
  quotaCheckIntervalSeconds: number;
  quotaAlertThresholdPercent: number;
  quotaMilestoneHours: number[];
  minDispatchHeadroomPercent: number;
  poolPolicies: PoolPolicies;

  repositories: RepositoryEntry[];

  orchestratorEnabled: boolean;
  defaultDispatchModel: string;
  defaultDispatchEffort: 'low' | 'medium' | 'high';
  workerSharedSecret?: string;
  quotaBurnMaxHours: number;
  quotaBurnMinHeadroomPercent: number;

  webUiEnabled: boolean;
  /** Whether usage past 0% quota may draw billable credits; the language server does not report this. */
  allowOverage: boolean;
  webUiPort: number;
  webUiHost: string;
  webUiAuthToken?: string;

  allowedIpRanges: string[];
  trustedProxies: boolean;

  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export type ResolvedConfig = AppConfig;

// Authoritative env-var spelling per config key; the reverse lookup and secret env names derive from it.
export const CONFIG_KEY_ENV_NAMES: Partial<Record<keyof AppConfig, string>> = {
  notificationChannels: 'NOTIFICATION_CHANNELS',
  notificationChannel: 'NOTIFICATION_CHANNEL',
  notificationWebhookUrl: 'NOTIFICATION_WEBHOOK_URL',
  webhookSecret: 'WEBHOOK_SECRET',
  webhookCustomHeaders: 'WEBHOOK_CUSTOM_HEADERS',
  discordToken: 'DISCORD_TOKEN',
  discordClientId: 'DISCORD_CLIENT_ID',
  discordGuildId: 'DISCORD_GUILD_ID',
  discordNotificationChannelId: 'DISCORD_NOTIFICATION_CHANNEL_ID',
  discordOwnerUserId: 'DISCORD_OWNER_USER_ID',
  discordPingOwner: 'DISCORD_PING_OWNER',
  antigravityEndpointUrl: 'ANTIGRAVITY_ENDPOINT_URL',
  antigravityCsrfToken: 'ANTIGRAVITY_CSRF_TOKEN',
  quotaCheckIntervalSeconds: 'QUOTA_CHECK_INTERVAL_SECONDS',
  quotaAlertThresholdPercent: 'QUOTA_ALERT_THRESHOLD_PERCENT',
  quotaMilestoneHours: 'QUOTA_MILESTONE_HOURS',
  minDispatchHeadroomPercent: 'MIN_DISPATCH_HEADROOM_PERCENT',
  repositories: 'REPOSITORIES_JSON',
  orchestratorEnabled: 'ORCHESTRATOR_ENABLED',
  defaultDispatchModel: 'DEFAULT_DISPATCH_MODEL',
  defaultDispatchEffort: 'DEFAULT_DISPATCH_EFFORT',
  workerSharedSecret: 'WORKER_SHARED_SECRET',
  quotaBurnMaxHours: 'QUOTA_BURN_MAX_HOURS',
  quotaBurnMinHeadroomPercent: 'QUOTA_BURN_MIN_HEADROOM_PERCENT',
  webUiEnabled: 'WEB_UI_ENABLED',
  allowOverage: 'ALLOW_OVERAGE',
  webUiPort: 'WEB_UI_PORT',
  webUiHost: 'WEB_UI_HOST',
  webUiAuthToken: 'WEB_UI_AUTH_TOKEN',
  allowedIpRanges: 'ALLOWED_IP_RANGES',
  trustedProxies: 'TRUSTED_PROXIES',
  logLevel: 'LOG_LEVEL',
};

/** Env spellings accepted as aliases; not the primary name for their key. */
export const CONFIG_ENV_ALIASES: Record<string, keyof AppConfig> = {
  WEBHOOK_URL: 'notificationWebhookUrl',
};

/** env name -> config key, so the UI API accepts either spelling. */
export const ENV_TO_CONFIG_KEY: Record<string, keyof AppConfig> = {
  ...Object.fromEntries(
    Object.entries(CONFIG_KEY_ENV_NAMES).map(([key, env]) => [
      env as string,
      key as keyof AppConfig,
    ])
  ),
  ...CONFIG_ENV_ALIASES,
};

/** Which config keys are secret is declared once; their env names come from the map above. */
export const CANONICAL_SECRET_CONFIG_KEYS = [
  'discordToken',
  'antigravityCsrfToken',
  'notificationWebhookUrl',
  'webhookSecret',
  'webhookCustomHeaders',
  'workerSharedSecret',
  'webUiAuthToken',
] as const satisfies readonly (keyof AppConfig)[];

/** The control-plane bearer token, resolved identically wherever it is needed. */
export const resolveWebUiAuthToken = (
  config: { webUiAuthToken?: string } | undefined,
  env: Record<string, string | undefined> = process.env
): string | undefined => config?.webUiAuthToken || env.WEB_UI_AUTH_TOKEN;

export const SECRET_CONFIG_KEY_ENV_NAMES: Record<string, string> = Object.fromEntries(
  CANONICAL_SECRET_CONFIG_KEYS.map((k) => [k, CONFIG_KEY_ENV_NAMES[k]!])
);

// Built-in Defaults (Level 3 Fallback)
export const BUILTIN_DEFAULTS: AppConfig = {
  notificationChannel: 'none',
  notificationChannels: [],
  notificationWebhookUrl: undefined,
  webhookSecret: undefined,
  webhookCustomHeaders: undefined,
  discordToken: undefined,
  discordClientId: undefined,
  discordGuildId: undefined,
  discordNotificationChannelId: undefined,
  discordOwnerUserId: undefined,
  discordPingOwner: true,

  antigravityEndpointUrl: undefined,
  antigravityCsrfToken: undefined,
  quotaCheckIntervalSeconds: 60, // 60 seconds (1 minute default, minimum 30s)
  quotaAlertThresholdPercent: 25, // 25% remaining quota triggers alert
  quotaMilestoneHours: DEFAULT_MILESTONE_HOURS,
  minDispatchHeadroomPercent: 10, // 10% safety floor preventing billable overages
  poolPolicies: DEFAULT_POOL_POLICIES,

  repositories: [],

  orchestratorEnabled: false,
  defaultDispatchModel: 'gemini-3.8-flash',
  defaultDispatchEffort: 'medium',
  workerSharedSecret: undefined,
  quotaBurnMaxHours: 2,
  quotaBurnMinHeadroomPercent: 30,

  webUiEnabled: false,
  allowOverage: false,
  webUiPort: 8484,
  webUiHost: '0.0.0.0',
  webUiAuthToken: undefined,

  allowedIpRanges: [],
  trustedProxies: false,

  logLevel: 'info',
};

export const isTemplatePlaceholder = (val: string | undefined): boolean =>
  typeof val === 'string' && /^your_[a-z0-9_]+_here$/i.test(val.trim());

export const parseRawEnv = (env: Record<string, string | undefined>): Partial<AppConfig> => {
  const sanitizedEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      const trimmed = value.trim();
      sanitizedEnv[key] = trimmed === '' ? undefined : value;
    }
  }

  const parsed: Partial<RawEnv> = {};
  const rawEnvFields = RawEnvSchema.shape as Record<string, z.ZodTypeAny>;
  for (const [key, value] of Object.entries(sanitizedEnv)) {
    const fieldSchema = rawEnvFields[key];
    if (!fieldSchema) continue;
    const outcome = fieldSchema.safeParse(value);
    if (outcome.success) {
      (parsed as Record<string, unknown>)[key] = outcome.data;
    } else {
      warnEnvFallback(key, 'invalid value');
    }
  }

  const result: Partial<AppConfig> = {};

  if (parsed.NOTIFICATION_CHANNELS) {
    result.notificationChannels = NotificationChannelsSchema.parse(parsed.NOTIFICATION_CHANNELS);
    result.notificationChannel = result.notificationChannels[0] ?? 'none';
  } else if (parsed.NOTIFICATION_CHANNEL) {
    result.notificationChannel = parsed.NOTIFICATION_CHANNEL;
    result.notificationChannels =
      parsed.NOTIFICATION_CHANNEL !== 'none' ? [parsed.NOTIFICATION_CHANNEL] : [];
  }

  const rawWebhookUrl = parsed.NOTIFICATION_WEBHOOK_URL || parsed.WEBHOOK_URL;
  if (rawWebhookUrl && !isTemplatePlaceholder(rawWebhookUrl)) {
    result.notificationWebhookUrl = rawWebhookUrl;
  }
  if (parsed.WEBHOOK_SECRET && !isTemplatePlaceholder(parsed.WEBHOOK_SECRET)) {
    result.webhookSecret = parsed.WEBHOOK_SECRET;
  }
  if (parsed.WEBHOOK_CUSTOM_HEADERS) {
    try {
      result.webhookCustomHeaders = JSON.parse(parsed.WEBHOOK_CUSTOM_HEADERS);
    } catch {
      // Ignore invalid JSON in custom headers
    }
  }

  if (parsed.DISCORD_TOKEN && !isTemplatePlaceholder(parsed.DISCORD_TOKEN)) {
    result.discordToken = parsed.DISCORD_TOKEN;
  }
  if (parsed.DISCORD_CLIENT_ID && !isTemplatePlaceholder(parsed.DISCORD_CLIENT_ID)) {
    result.discordClientId = parsed.DISCORD_CLIENT_ID;
  }
  if (parsed.DISCORD_GUILD_ID && !isTemplatePlaceholder(parsed.DISCORD_GUILD_ID)) {
    result.discordGuildId = parsed.DISCORD_GUILD_ID;
  }
  if (
    parsed.DISCORD_NOTIFICATION_CHANNEL_ID &&
    !isTemplatePlaceholder(parsed.DISCORD_NOTIFICATION_CHANNEL_ID)
  ) {
    result.discordNotificationChannelId = parsed.DISCORD_NOTIFICATION_CHANNEL_ID;
  }
  if (
    parsed.DISCORD_OWNER_USER_ID &&
    parsed.DISCORD_OWNER_USER_ID.trim() !== '' &&
    !isTemplatePlaceholder(parsed.DISCORD_OWNER_USER_ID)
  ) {
    result.discordOwnerUserId = parsed.DISCORD_OWNER_USER_ID.trim();
  }
  if (parsed.DISCORD_PING_OWNER !== undefined && parsed.DISCORD_PING_OWNER.trim() !== '') {
    try {
      result.discordPingOwner = booleanEnv.parse(parsed.DISCORD_PING_OWNER);
    } catch {
      warnEnvFallback('DISCORD_PING_OWNER', 'invalid boolean value');
    }
  }

  if (parsed.ANTIGRAVITY_ENDPOINT_URL && !isTemplatePlaceholder(parsed.ANTIGRAVITY_ENDPOINT_URL)) {
    result.antigravityEndpointUrl = parsed.ANTIGRAVITY_ENDPOINT_URL;
  }
  if (parsed.ANTIGRAVITY_CSRF_TOKEN && !isTemplatePlaceholder(parsed.ANTIGRAVITY_CSRF_TOKEN)) {
    result.antigravityCsrfToken = parsed.ANTIGRAVITY_CSRF_TOKEN;
  }
  if (parsed.QUOTA_CHECK_INTERVAL_SECONDS !== undefined)
    result.quotaCheckIntervalSeconds = parsed.QUOTA_CHECK_INTERVAL_SECONDS;
  if (parsed.QUOTA_ALERT_THRESHOLD_PERCENT !== undefined)
    result.quotaAlertThresholdPercent = parsed.QUOTA_ALERT_THRESHOLD_PERCENT;
  if (parsed.QUOTA_MILESTONE_HOURS) {
    try {
      result.quotaMilestoneHours = milestoneHoursEnv.parse(parsed.QUOTA_MILESTONE_HOURS);
    } catch {
      warnEnvFallback('QUOTA_MILESTONE_HOURS', 'no valid positive hour entries');
      result.quotaMilestoneHours = [...BUILTIN_DEFAULTS.quotaMilestoneHours];
    }
  }
  if (parsed.MIN_DISPATCH_HEADROOM_PERCENT !== undefined) {
    result.minDispatchHeadroomPercent = parsed.MIN_DISPATCH_HEADROOM_PERCENT;
  }

  if (parsed.REPOSITORIES_JSON) {
    try {
      result.repositories = RepositoriesJsonSchema.parse(parsed.REPOSITORIES_JSON);
    } catch {
      warnEnvFallback('REPOSITORIES_JSON', 'invalid JSON or repository entry');
    }
  }

  if (parsed.ALLOW_OVERAGE !== undefined && parsed.ALLOW_OVERAGE.trim() !== '') {
    result.allowOverage = booleanEnv.parse(parsed.ALLOW_OVERAGE);
  }

  if (parsed.ORCHESTRATOR_ENABLED !== undefined && parsed.ORCHESTRATOR_ENABLED.trim() !== '') {
    try {
      result.orchestratorEnabled = booleanEnv.parse(parsed.ORCHESTRATOR_ENABLED);
    } catch {
      warnEnvFallback('ORCHESTRATOR_ENABLED', 'invalid boolean value');
    }
  }
  if (parsed.DEFAULT_DISPATCH_MODEL && parsed.DEFAULT_DISPATCH_MODEL.trim() !== '') {
    result.defaultDispatchModel = parsed.DEFAULT_DISPATCH_MODEL.trim();
  }
  if (parsed.DEFAULT_DISPATCH_EFFORT) {
    result.defaultDispatchEffort = parsed.DEFAULT_DISPATCH_EFFORT;
  }
  if (parsed.WORKER_SHARED_SECRET && !isTemplatePlaceholder(parsed.WORKER_SHARED_SECRET)) {
    result.workerSharedSecret = parsed.WORKER_SHARED_SECRET;
  }
  if (parsed.QUOTA_BURN_MAX_HOURS !== undefined) {
    result.quotaBurnMaxHours = parsed.QUOTA_BURN_MAX_HOURS;
  }
  if (parsed.QUOTA_BURN_MIN_HEADROOM_PERCENT !== undefined) {
    result.quotaBurnMinHeadroomPercent = parsed.QUOTA_BURN_MIN_HEADROOM_PERCENT;
  }

  if (parsed.WEB_UI_ENABLED !== undefined && parsed.WEB_UI_ENABLED.trim() !== '') {
    try {
      result.webUiEnabled = booleanEnv.parse(parsed.WEB_UI_ENABLED);
    } catch {
      warnEnvFallback('WEB_UI_ENABLED', 'invalid boolean value');
    }
  }
  if (parsed.WEB_UI_PORT !== undefined) result.webUiPort = parsed.WEB_UI_PORT;
  if (parsed.WEB_UI_HOST) result.webUiHost = parsed.WEB_UI_HOST;
  if (parsed.WEB_UI_AUTH_TOKEN && !isTemplatePlaceholder(parsed.WEB_UI_AUTH_TOKEN)) {
    result.webUiAuthToken = parsed.WEB_UI_AUTH_TOKEN;
  }

  if (parsed.ALLOWED_IP_RANGES !== undefined) {
    result.allowedIpRanges = parsed.ALLOWED_IP_RANGES.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (parsed.TRUSTED_PROXIES !== undefined && parsed.TRUSTED_PROXIES.trim() !== '') {
    try {
      result.trustedProxies = booleanEnv.parse(parsed.TRUSTED_PROXIES);
    } catch {
      warnEnvFallback('TRUSTED_PROXIES', 'invalid boolean value');
    }
  }

  if (parsed.LOG_LEVEL) result.logLevel = parsed.LOG_LEVEL;
  return result;
};

const CONFIG_FIELD_SCHEMAS: Record<keyof AppConfig, z.ZodTypeAny> = {
  notificationChannel: NotificationChannelEnum,
  notificationChannels: z.array(NotificationChannelEnum),
  notificationWebhookUrl: z.string().url().or(z.literal('')).optional(),
  webhookSecret: z.string().optional(),
  webhookCustomHeaders: z.record(z.string(), z.string()).optional(),
  discordToken: z.string().optional(),
  discordClientId: z.string().optional(),
  discordGuildId: z.string().optional(),
  discordNotificationChannelId: z.string().optional(),
  discordOwnerUserId: z.string().optional(),
  discordPingOwner: z.boolean(),
  antigravityEndpointUrl: z.string().url().or(z.literal('')).optional(),
  antigravityCsrfToken: z.string().optional(),
  quotaCheckIntervalSeconds: z.number().int().min(30),
  quotaAlertThresholdPercent: z.number().min(0).max(100),
  quotaMilestoneHours: z.array(z.number().positive()),
  minDispatchHeadroomPercent: z.number().min(0).max(100),
  poolPolicies: PoolPoliciesSchema,
  repositories: z.array(RepositorySchema),
  orchestratorEnabled: z.boolean(),
  defaultDispatchModel: z.string(),
  defaultDispatchEffort: z.enum(['low', 'medium', 'high']),
  workerSharedSecret: z.string().optional(),
  quotaBurnMaxHours: z.number().positive(),
  quotaBurnMinHeadroomPercent: z.number().min(0).max(100),
  webUiEnabled: z.boolean(),
  allowOverage: z.boolean(),
  webUiPort: z.number().int().positive(),
  webUiHost: z.string(),
  webUiAuthToken: z.string().optional(),
  allowedIpRanges: z.array(z.string()),
  trustedProxies: z.boolean(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']),
};

/** Prototype-pollution guard, shared with the store's key normaliser. */
export const FORBIDDEN_CONFIG_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const validateConfigOverridePatch = (
  patch: Record<string, unknown>
): Record<string, unknown> => {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw new Error('Config patch must be an object');
  }

  const validated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (FORBIDDEN_CONFIG_KEYS.has(key)) {
      throw new Error(`Forbidden configuration key: ${key}`);
    }
    if (!(key in CONFIG_FIELD_SCHEMAS)) {
      throw new Error(`Unknown configuration key: ${key}`);
    }
    const schema = CONFIG_FIELD_SCHEMAS[key as keyof AppConfig];
    validated[key] = schema.parse(value);
  }
  return validated;
};
