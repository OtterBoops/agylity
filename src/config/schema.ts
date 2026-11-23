import { z } from 'zod';
import { logger } from '../logs/logger.js';

const warnEnvFallback = (variable: string, reason: string): void =>
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

export const DEFAULT_MILESTONE_HOURS = [48, 24, 12];

export const DEFAULT_QUOTA_BURN_MAX_HOURS = 4;

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

// A policy set saved before the pool rename carries `gemini-flash` and no `gemini-hydrogen`.
const normalizePoolPolicyKeys = (val: unknown): unknown => {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return val;
  const raw = val as Record<string, unknown>;
  if (raw['gemini-hydrogen'] !== undefined) return val;
  const legacy = raw['gemini-flash'];
  return legacy === undefined ? val : { ...raw, 'gemini-hydrogen': legacy };
};

export const PoolGroupPoliciesSchema = z.preprocess(
  normalizePoolPolicyKeys,
  z.object({
    claude: PoolPolicySchema,
    'gemini-argon': PoolPolicySchema,
    'gemini-hydrogen': PoolPolicySchema,
  })
);

export type PoolGroupPolicies = z.infer<typeof PoolGroupPoliciesSchema>;

export const DEFAULT_POOL_GROUP_POLICIES: PoolGroupPolicies = {
  'gemini-argon': { alertsEnabled: true, dispatchEnabled: true },
  'gemini-hydrogen': { alertsEnabled: true, dispatchEnabled: true },
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

export const PrPolicyEnum = z.enum(['docs_only', 'issues_only', 'all', 'none']);
export type PrPolicy = z.infer<typeof PrPolicyEnum>;

export const NotificationChannelEnum = z.enum(['discord', 'webhook', 'none']);
export type NotificationChannelType = z.infer<typeof NotificationChannelEnum>;

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

export const RawEnvSchema = z.object({
  NOTIFICATION_CHANNELS: z.string().optional(),
  NOTIFICATION_WEBHOOK_URL: z.string().url().optional().or(z.literal('')),
  WEBHOOK_SECRET: z.string().optional(),
  WEBHOOK_CUSTOM_HEADERS: z.string().optional(),
  DISCORD_TOKEN: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_GUILD_ID: z.string().optional(),
  DISCORD_NOTIFICATION_CHANNEL_ID: z.string().optional(),
  DISCORD_OWNER_USER_ID: z.string().optional(),
  DISCORD_PING_OWNER: z.string().optional(),
  ANTIGRAVITY_ENDPOINT_URL: z.string().url().optional().or(z.literal('')),
  ANTIGRAVITY_CSRF_TOKEN: z.string().optional(),
  QUOTA_CHECK_INTERVAL_SECONDS: z.coerce.number().int().min(30).optional(),
  AGY_UPDATE_INTERVAL_HOURS: z.coerce.number().min(0).optional(),
  QUOTA_ALERT_THRESHOLD_PERCENT: z.coerce.number().min(0).max(100).optional(),
  QUOTA_MILESTONE_HOURS: z.string().optional(),
  MIN_DISPATCH_HEADROOM_PERCENT: z.coerce.number().min(0).max(100).optional(),

  REPOSITORIES_JSON: z.string().optional(),
  COORDINATOR_ENABLED: z.string().optional(),
  ROUTINES_ENABLED: z.string().optional(),
  GITHUB_BACKLOG_LABEL: z.string().optional(),
  DEFAULT_DISPATCH_MODEL: z.string().optional(),
  DEFAULT_DISPATCH_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  RUNNER_SHARED_SECRET: z.string().optional(),
  PR_POLICY: PrPolicyEnum.optional(),
  QUOTA_BURN_MAX_HOURS: z.coerce.number().positive().optional(),
  QUOTA_BURN_MIN_HEADROOM_PERCENT: z.coerce.number().min(0).max(100).optional(),

  WEB_UI_ENABLED: z.string().optional(),
  ALLOW_OVERAGE: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  ALLOW_TOKENLESS_RUNNER: z.string().optional(),
  WEB_UI_PORT: z.coerce.number().int().positive().optional(),
  WEB_UI_HOST: z.string().optional(),
  WEB_UI_AUTH_TOKEN: z.string().optional(),
  WEB_UI_AUTH_EXEMPT_LOCALHOST: z.string().optional(),
  BASE_URL: z.string().url().optional().or(z.literal('')),

  ALLOWED_IP_RANGES: z.string().optional(),
  TRUSTED_PROXIES: z.string().optional(),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional(),
});

export type RawEnv = z.infer<typeof RawEnvSchema>;

export interface AppConfig {
  notificationChannel: NotificationChannelType;
  notificationChannels: NotificationChannelType[];
  notificationWebhookUrl?: string;
  webhookSecret?: string;
  webhookCustomHeaders?: Record<string, string>;
  discordToken?: string;
  /** GitHub PAT: the coordinator leases it to runners per task and uses it for backlog sync. */
  githubToken?: string;
  discordClientId?: string;
  discordGuildId?: string;
  discordNotificationChannelId?: string;
  discordOwnerUserId?: string;
  discordPingOwner: boolean;
  /** Discord-webhook URLs only: mentions the owner on quota alerts and test pings. */
  webhookPingOwner: boolean;

  antigravityEndpointUrl?: string;
  antigravityCsrfToken?: string;
  agyUpdateIntervalHours: number;
  quotaCheckIntervalSeconds: number;
  quotaAlertThresholdPercent: number;
  quotaMilestoneHours: number[];
  minDispatchHeadroomPercent: number;
  poolGroupPolicies: PoolGroupPolicies;

  repositories: RepositoryEntry[];

  coordinatorEnabled: boolean;
  routinesEnabled: boolean;
  githubBacklogLabel: string;
  defaultDispatchModel: string;
  defaultDispatchEffort: 'low' | 'medium' | 'high' | 'xhigh';
  runnerSharedSecret?: string;
  prPolicy: PrPolicy;
  quotaBurnMaxHours: number;
  quotaBurnMinHeadroomPercent: number;

  webUiEnabled: boolean;
  baseUrl?: string;
  allowOverage: boolean;
  /** Leases GitHub-remote tasks without a token; only for a non-GitHub remote. */
  allowTokenlessRunner: boolean;
  webUiPort: number;
  webUiHost: string;
  webUiAuthToken?: string;
  webUiAuthExemptLocalhost: boolean;

  allowedIpRanges: string[];
  trustedProxies: boolean;

  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export type ResolvedConfig = AppConfig;

export const CONFIG_KEY_ENV_NAMES: Partial<Record<keyof AppConfig, string>> = {
  notificationChannels: 'NOTIFICATION_CHANNELS',
  notificationWebhookUrl: 'NOTIFICATION_WEBHOOK_URL',
  webhookSecret: 'WEBHOOK_SECRET',
  webhookCustomHeaders: 'WEBHOOK_CUSTOM_HEADERS',
  discordToken: 'DISCORD_TOKEN',
  githubToken: 'GITHUB_TOKEN',
  discordClientId: 'DISCORD_CLIENT_ID',
  discordGuildId: 'DISCORD_GUILD_ID',
  discordNotificationChannelId: 'DISCORD_NOTIFICATION_CHANNEL_ID',
  discordOwnerUserId: 'DISCORD_OWNER_USER_ID',
  discordPingOwner: 'DISCORD_PING_OWNER',
  antigravityEndpointUrl: 'ANTIGRAVITY_ENDPOINT_URL',
  antigravityCsrfToken: 'ANTIGRAVITY_CSRF_TOKEN',
  agyUpdateIntervalHours: 'AGY_UPDATE_INTERVAL_HOURS',
  quotaCheckIntervalSeconds: 'QUOTA_CHECK_INTERVAL_SECONDS',
  quotaAlertThresholdPercent: 'QUOTA_ALERT_THRESHOLD_PERCENT',
  quotaMilestoneHours: 'QUOTA_MILESTONE_HOURS',
  minDispatchHeadroomPercent: 'MIN_DISPATCH_HEADROOM_PERCENT',
  repositories: 'REPOSITORIES_JSON',
  coordinatorEnabled: 'COORDINATOR_ENABLED',
  routinesEnabled: 'ROUTINES_ENABLED',
  githubBacklogLabel: 'GITHUB_BACKLOG_LABEL',
  defaultDispatchModel: 'DEFAULT_DISPATCH_MODEL',
  defaultDispatchEffort: 'DEFAULT_DISPATCH_EFFORT',
  runnerSharedSecret: 'RUNNER_SHARED_SECRET',
  prPolicy: 'PR_POLICY',
  quotaBurnMaxHours: 'QUOTA_BURN_MAX_HOURS',
  quotaBurnMinHeadroomPercent: 'QUOTA_BURN_MIN_HEADROOM_PERCENT',
  webUiEnabled: 'WEB_UI_ENABLED',
  allowOverage: 'ALLOW_OVERAGE',
  allowTokenlessRunner: 'ALLOW_TOKENLESS_RUNNER',
  webUiPort: 'WEB_UI_PORT',
  webUiHost: 'WEB_UI_HOST',
  webUiAuthToken: 'WEB_UI_AUTH_TOKEN',
  webUiAuthExemptLocalhost: 'WEB_UI_AUTH_EXEMPT_LOCALHOST',
  baseUrl: 'BASE_URL',
  allowedIpRanges: 'ALLOWED_IP_RANGES',
  trustedProxies: 'TRUSTED_PROXIES',
  logLevel: 'LOG_LEVEL',
};

export const ENV_TO_CONFIG_KEY: Record<string, keyof AppConfig> = {
  ...Object.fromEntries(
    Object.entries(CONFIG_KEY_ENV_NAMES).map(([key, env]) => [
      env as string,
      key as keyof AppConfig,
    ])
  ),
};

export const CANONICAL_SECRET_CONFIG_KEYS = [
  'discordToken',
  'githubToken',
  'antigravityCsrfToken',
  'notificationWebhookUrl',
  'webhookSecret',
  'webhookCustomHeaders',
  'runnerSharedSecret',
  'webUiAuthToken',
] as const satisfies readonly (keyof AppConfig)[];

export const resolveWebUiAuthToken = (
  config: { webUiAuthToken?: string } | undefined,
  env: Record<string, string | undefined> = process.env
): string | undefined => config?.webUiAuthToken || env.WEB_UI_AUTH_TOKEN;

export const SECRET_CONFIG_KEY_ENV_NAMES: Record<string, string> = Object.fromEntries(
  CANONICAL_SECRET_CONFIG_KEYS.map((k) => [k, CONFIG_KEY_ENV_NAMES[k]!])
);

export const BUILTIN_DEFAULTS: AppConfig = {
  notificationChannel: 'none',
  notificationChannels: [],
  notificationWebhookUrl: undefined,
  webhookSecret: undefined,
  webhookCustomHeaders: undefined,
  discordToken: undefined,
  githubToken: undefined,
  discordClientId: undefined,
  discordGuildId: undefined,
  discordNotificationChannelId: undefined,
  discordOwnerUserId: undefined,
  discordPingOwner: true,
  webhookPingOwner: true,

  antigravityEndpointUrl: undefined,
  antigravityCsrfToken: undefined,
  agyUpdateIntervalHours: 24,
  quotaCheckIntervalSeconds: 60,
  quotaAlertThresholdPercent: 25, // 25% remaining quota triggers alert
  quotaMilestoneHours: DEFAULT_MILESTONE_HOURS,
  minDispatchHeadroomPercent: 10, // 10% safety floor preventing billable overages
  poolGroupPolicies: DEFAULT_POOL_GROUP_POLICIES,

  repositories: [],

  coordinatorEnabled: false,
  routinesEnabled: true,
  githubBacklogLabel: 'backlog',
  defaultDispatchModel: 'gemini-4-hydrogen',
  defaultDispatchEffort: 'medium',
  runnerSharedSecret: undefined,
  prPolicy: 'all',
  quotaBurnMaxHours: DEFAULT_QUOTA_BURN_MAX_HOURS,
  quotaBurnMinHeadroomPercent: 30,

  webUiEnabled: false,
  allowOverage: false,
  allowTokenlessRunner: false,
  webUiPort: 8484,
  webUiHost: '0.0.0.0',
  webUiAuthToken: undefined,
  webUiAuthExemptLocalhost: true,
  baseUrl: undefined,

  allowedIpRanges: [],
  trustedProxies: false,

  logLevel: 'info',
};

// A copied example env (`your_bot_token_here`) must not read as a configured secret.
export const isTemplatePlaceholder = (val: string | undefined): boolean =>
  typeof val === 'string' && /^your_[a-z0-9_]+_here$/i.test(val.trim());

export const parseRawEnv = (env: Record<string, string | undefined>): Partial<AppConfig> => {
  const sanitizedEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      const trimmed = value.trim();
      sanitizedEnv[key] = trimmed === '' ? undefined : trimmed;
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
  }

  const rawWebhookUrl = parsed.NOTIFICATION_WEBHOOK_URL;
  if (rawWebhookUrl && !isTemplatePlaceholder(rawWebhookUrl)) {
    result.notificationWebhookUrl = rawWebhookUrl;
  }
  if (parsed.WEBHOOK_SECRET && !isTemplatePlaceholder(parsed.WEBHOOK_SECRET)) {
    result.webhookSecret = parsed.WEBHOOK_SECRET;
  }
  if (parsed.WEBHOOK_CUSTOM_HEADERS) {
    try {
      const decoded: unknown = JSON.parse(parsed.WEBHOOK_CUSTOM_HEADERS);
      if (isPlainStringRecord(decoded)) result.webhookCustomHeaders = decoded;
      else
        warnEnvFallback('WEBHOOK_CUSTOM_HEADERS', 'expected a flat object of string header values');
    } catch {
      warnEnvFallback('WEBHOOK_CUSTOM_HEADERS', 'invalid JSON syntax');
    }
  }

  if (parsed.DISCORD_TOKEN && !isTemplatePlaceholder(parsed.DISCORD_TOKEN)) {
    result.discordToken = parsed.DISCORD_TOKEN;
  }
  if (parsed.GITHUB_TOKEN && !isTemplatePlaceholder(parsed.GITHUB_TOKEN)) {
    result.githubToken = parsed.GITHUB_TOKEN.trim();
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
  if (parsed.AGY_UPDATE_INTERVAL_HOURS !== undefined)
    result.agyUpdateIntervalHours = parsed.AGY_UPDATE_INTERVAL_HOURS;
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

  if (parsed.ALLOW_TOKENLESS_RUNNER !== undefined && parsed.ALLOW_TOKENLESS_RUNNER.trim() !== '') {
    try {
      result.allowTokenlessRunner = booleanEnv.parse(parsed.ALLOW_TOKENLESS_RUNNER);
    } catch {
      warnEnvFallback('ALLOW_TOKENLESS_RUNNER', 'expected a boolean');
    }
  }

  if (parsed.ALLOW_OVERAGE !== undefined && parsed.ALLOW_OVERAGE.trim() !== '') {
    try {
      result.allowOverage = booleanEnv.parse(parsed.ALLOW_OVERAGE);
    } catch {
      warnEnvFallback('ALLOW_OVERAGE', 'invalid boolean value');
    }
  }

  if (parsed.COORDINATOR_ENABLED !== undefined && parsed.COORDINATOR_ENABLED.trim() !== '') {
    try {
      result.coordinatorEnabled = booleanEnv.parse(parsed.COORDINATOR_ENABLED);
    } catch {
      warnEnvFallback('COORDINATOR_ENABLED', 'invalid boolean value');
    }
  }
  if (parsed.ROUTINES_ENABLED !== undefined && parsed.ROUTINES_ENABLED.trim() !== '') {
    try {
      result.routinesEnabled = booleanEnv.parse(parsed.ROUTINES_ENABLED);
    } catch {
      warnEnvFallback('ROUTINES_ENABLED', 'invalid boolean value');
    }
  }
  if (parsed.GITHUB_BACKLOG_LABEL && parsed.GITHUB_BACKLOG_LABEL.trim() !== '') {
    result.githubBacklogLabel = parsed.GITHUB_BACKLOG_LABEL.trim();
  }
  if (parsed.DEFAULT_DISPATCH_MODEL && parsed.DEFAULT_DISPATCH_MODEL.trim() !== '') {
    result.defaultDispatchModel = parsed.DEFAULT_DISPATCH_MODEL.trim();
  }
  if (parsed.DEFAULT_DISPATCH_EFFORT) {
    result.defaultDispatchEffort = parsed.DEFAULT_DISPATCH_EFFORT;
  }
  if (parsed.RUNNER_SHARED_SECRET && !isTemplatePlaceholder(parsed.RUNNER_SHARED_SECRET)) {
    result.runnerSharedSecret = parsed.RUNNER_SHARED_SECRET;
  }
  if (parsed.PR_POLICY) {
    result.prPolicy = parsed.PR_POLICY;
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
  if (
    parsed.WEB_UI_AUTH_EXEMPT_LOCALHOST !== undefined &&
    parsed.WEB_UI_AUTH_EXEMPT_LOCALHOST.trim() !== ''
  ) {
    try {
      result.webUiAuthExemptLocalhost = booleanEnv.parse(parsed.WEB_UI_AUTH_EXEMPT_LOCALHOST);
    } catch {
      warnEnvFallback('WEB_UI_AUTH_EXEMPT_LOCALHOST', 'invalid boolean value');
    }
  }
  if (parsed.BASE_URL && !isTemplatePlaceholder(parsed.BASE_URL)) {
    result.baseUrl = parsed.BASE_URL.trim();
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
  githubToken: z.string().optional(),
  discordClientId: z.string().optional(),
  discordGuildId: z.string().optional(),
  discordNotificationChannelId: z.string().optional(),
  discordOwnerUserId: z.string().optional(),
  discordPingOwner: z.boolean(),
  webhookPingOwner: z.boolean(),
  antigravityEndpointUrl: z.string().url().or(z.literal('')).optional(),
  antigravityCsrfToken: z.string().optional(),
  agyUpdateIntervalHours: z.number().min(0),
  quotaCheckIntervalSeconds: z.number().int().min(30),
  quotaAlertThresholdPercent: z.number().min(0).max(100),
  quotaMilestoneHours: z.array(z.number().positive()),
  minDispatchHeadroomPercent: z.number().min(0).max(100),
  poolGroupPolicies: PoolGroupPoliciesSchema,
  repositories: z.array(RepositorySchema),
  coordinatorEnabled: z.boolean(),
  routinesEnabled: z.boolean(),
  githubBacklogLabel: z.string().min(1),
  defaultDispatchModel: z.string(),
  defaultDispatchEffort: z.enum(['low', 'medium', 'high', 'xhigh']),
  runnerSharedSecret: z.string().optional(),
  prPolicy: PrPolicyEnum,
  quotaBurnMaxHours: z.number().positive(),
  quotaBurnMinHeadroomPercent: z.number().min(0).max(100),
  webUiEnabled: z.boolean(),
  allowOverage: z.boolean(),
  allowTokenlessRunner: z.boolean(),
  webUiPort: z.number().int().positive(),
  webUiHost: z.string(),
  webUiAuthToken: z.string().optional(),
  webUiAuthExemptLocalhost: z.boolean(),
  baseUrl: z.string().url().or(z.literal('')).optional(),
  allowedIpRanges: z.array(z.string()),
  trustedProxies: z.boolean(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']),
};

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
    if (!Object.hasOwn(CONFIG_FIELD_SCHEMAS, key)) {
      throw new Error(`Unknown configuration key: ${key}`);
    }
    const schema = CONFIG_FIELD_SCHEMAS[key as keyof AppConfig];
    validated[key] = schema.parse(value);
  }
  return validated;
};
