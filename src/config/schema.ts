import { z } from 'zod';
import { logger } from '../logs/logger.js';
import {
  BACKLOG_CONCURRENCY_VALUES,
  PR_POLICY_VALUES,
  type BacklogConcurrency,
  type PrPolicy,
} from '../shared/contracts.js';
import { LEGACY_POOL_GROUPS } from '../shared/models.js';

const warnEnvFallback = (variable: string, reason: string): void =>
  logger.child('config').warn('%s: %s; falling back to default', variable, reason);

// A custom header map is flat and string-valued, so a nested or numeric entry is a rejection, not a coercion.
const isPlainStringRecord = (val: unknown): val is Record<string, string> =>
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

export const DEFAULT_BACKLOG_MIN_HEADROOM_PERCENT = 40;

export const DEFAULT_BACKLOG_CONCURRENCY: BacklogConcurrency = 'per_repo';

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

const RepositorySchema = z.preprocess(
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

const PoolPolicySchema = z.object({
  alertsEnabled: z.boolean(),
  dispatchEnabled: z.boolean(),
});

// A policy set saved before the Gemini pools were merged carries the old group keys; the merged key
// wins when both are present.
const normalizePoolPolicyKeys = (val: unknown): unknown => {
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

const PoolGroupPoliciesSchema = z.preprocess(
  normalizePoolPolicyKeys,
  z.object({
    gemini: PoolPolicySchema,
    claude: PoolPolicySchema,
  })
);

export type PoolGroupPolicies = z.infer<typeof PoolGroupPoliciesSchema>;

const DEFAULT_POOL_GROUP_POLICIES: PoolGroupPolicies = {
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

const NotificationChannelEnum = z.enum(['discord', 'webhook', 'none']);
type NotificationChannelType = z.infer<typeof NotificationChannelEnum>;

const NotificationChannelsSchema = z.preprocess((val) => {
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
const WebhookHeadersSchema = z.string().transform((raw, ctx) => {
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

const AllowedIpRangesSchema = z.string().transform((raw) =>
  raw
    .split(',')
    .map((range) => range.trim())
    .filter(Boolean)
);

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
  backlogMinHeadroomPercent: number;
  backlogConcurrency: BacklogConcurrency;

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

export type ConfigDocGroup =
  | 'notifications'
  | 'sentry'
  | 'coordinator'
  | 'security'
  | 'web'
  | 'logging'
  | 'storage'
  | 'runner';

/** Section order and headings of the generated env reference. */
export const CONFIG_DOC_GROUPS: readonly { id: ConfigDocGroup; label: string }[] = [
  { id: 'notifications', label: 'Multi-Channel Notifications' },
  { id: 'sentry', label: 'Quota Sentry' },
  { id: 'coordinator', label: 'Optional Task Coordinator' },
  { id: 'security', label: 'Security & Encryption' },
  { id: 'web', label: 'Decoupled Web Dashboard' },
  { id: 'logging', label: 'Logging & Sinks' },
  { id: 'storage', label: 'Storage & Runtime Paths' },
  { id: 'runner', label: 'Swarm Runner' },
];

interface ConfigEntryBase {
  group: ConfigDocGroup;
  /** The env string's type: what the operator writes, not the resolved value. */
  type: 'string' | 'number' | 'boolean';
  /** Rendered default; an em dash means the variable has no value until one is set. */
  defaultLabel: string;
  description: string;
  /** Uncommented in `.env.example` only where a deployment is expected to set it. */
  example: 'set' | 'comment';
  /** Value written after `ENV=` when the built-in default is not a useful sample. */
  exampleValue?: string;
  secret?: boolean;
  /** A dashboard-only key: part of `AppConfig` but absent from the env reference. */
  hidden?: boolean;
}

/** A variable the process reads directly, with no `AppConfig` key behind it. */
interface EnvOnlyEntry extends ConfigEntryBase {
  env: string;
  key?: undefined;
  value?: undefined;
  envSchema?: undefined;
  overrideSchema?: undefined;
}

interface ConfigKeyEntry extends ConfigEntryBase {
  key: keyof AppConfig;
  env?: string;
  /** Built-in default. `undefined` is a real default: the key starts unset. */
  value: unknown;
  /** Validates a dashboard override. Every key has one, so no write can bypass validation. */
  overrideSchema: z.ZodTypeAny;
  /** Validates and converts the raw env string; absent for a key with no env spelling. */
  envSchema?: z.ZodTypeAny;
  /** Warning reason for a rejected env value, when the schema's own message is too opaque. */
  invalidReason?: string;
  /** On a rejected env value publish the built-in default instead of leaving the key unset. */
  fallbackToDefault?: boolean;
}

export type ConfigRegistryEntry = EnvOnlyEntry | ConfigKeyEntry;

// The single declaration of every knob: env spelling, schema, default, secret flag and the copy
// the reference table renders. Adding a config key is one entry here; the docs generator and the
// drift tests read this table rather than a second list.
export const CONFIG_REGISTRY = [
  {
    group: 'notifications',
    type: 'string',
    defaultLabel: 'none',
    example: 'set',
    key: 'notificationChannels',
    value: [],
    overrideSchema: z.array(NotificationChannelEnum),
    env: 'NOTIFICATION_CHANNELS',
    envSchema: NotificationChannelsSchema,
    description:
      'Active remote channels (`discord`, `webhook`, `none`). Multiple channels can run concurrently (e.g. `discord,webhook`). Every event is written to stdout and the Logs buffer by the logger regardless of this setting; a stored `console` value is dropped with a warning.',
  },
  {
    group: 'notifications',
    type: 'string',
    defaultLabel: '\u2014',
    example: 'comment',
    secret: true,
    key: 'discordToken',
    value: undefined,
    overrideSchema: z.string().optional(),
    env: 'DISCORD_TOKEN',
    envSchema: z.string(),
    description: 'Discord Bot application secret token (encrypted at rest).',
  },
  {
    group: 'notifications',
    type: 'string',
    defaultLabel: '\u2014',
    example: 'comment',
    key: 'discordClientId',
    value: undefined,
    overrideSchema: z.string().optional(),
    env: 'DISCORD_CLIENT_ID',
    envSchema: z.string(),
    description:
      'Discord Application ID. Required for slash-command registration: without it `/quota` and `/dispatch` are never registered.',
  },
  {
    group: 'notifications',
    type: 'string',
    defaultLabel: '\u2014',
    example: 'comment',
    key: 'discordGuildId',
    value: undefined,
    overrideSchema: z.string().optional(),
    env: 'DISCORD_GUILD_ID',
    envSchema: z.string(),
    description:
      'Target Discord Guild (Server) ID. Omitted, commands register globally instead of per-guild.',
  },
  {
    group: 'notifications',
    type: 'string',
    defaultLabel: '\u2014',
    example: 'comment',
    key: 'discordNotificationChannelId',
    value: undefined,
    overrideSchema: z.string().optional(),
    env: 'DISCORD_NOTIFICATION_CHANNEL_ID',
    envSchema: z.string(),
    description: 'Target Discord text channel ID for embeds.',
  },
  {
    group: 'notifications',
    type: 'string',
    defaultLabel: '\u2014',
    example: 'comment',
    key: 'discordOwnerUserId',
    value: undefined,
    overrideSchema: z.string().optional(),
    env: 'DISCORD_OWNER_USER_ID',
    envSchema: z.string(),
    description:
      'Authorized Discord User ID for strict single-user binding (pins first interacting user via TOFU if unset).',
  },
  {
    group: 'notifications',
    type: 'boolean',
    defaultLabel: 'true',
    example: 'set',
    key: 'discordPingOwner',
    value: true,
    overrideSchema: z.boolean(),
    env: 'DISCORD_PING_OWNER',
    envSchema: booleanEnv,
    invalidReason: 'invalid boolean value',
    description:
      'Whether to mention/ping the owner (`<@ID>`) on the Discord Bot destination. Applies to the bot only; the webhook destination has its own `webhookPingOwner`.',
  },
  {
    group: 'notifications',
    type: 'boolean',
    defaultLabel: 'true',
    example: 'comment',
    key: 'webhookPingOwner',
    value: true,
    overrideSchema: z.boolean(),
    description:
      'Whether the webhook destination mentions the owner. Only Discord webhook URLs can render `<@ID>`; every other endpoint receives the payload untouched. UI-only \u2014 no environment variable.',
  },
  {
    group: 'notifications',
    type: 'string',
    defaultLabel: '\u2014',
    example: 'comment',
    secret: true,
    key: 'notificationWebhookUrl',
    value: undefined,
    overrideSchema: z.string().url().or(z.literal('')).optional(),
    env: 'NOTIFICATION_WEBHOOK_URL',
    envSchema: z.string().url().or(z.literal('')),
    description: 'Webhook target URL for HTTP POST JSON notifications (encrypted at rest).',
  },
  {
    group: 'notifications',
    type: 'string',
    defaultLabel: '\u2014',
    example: 'comment',
    secret: true,
    key: 'webhookSecret',
    value: undefined,
    overrideSchema: z.string().optional(),
    env: 'WEBHOOK_SECRET',
    envSchema: z.string(),
    description:
      'Optional HMAC-SHA256 signature secret for `x-agylity-signature` (encrypted at rest).',
  },
  {
    group: 'notifications',
    type: 'string',
    defaultLabel: '\u2014',
    example: 'comment',
    secret: true,
    key: 'webhookCustomHeaders',
    value: undefined,
    overrideSchema: z.record(z.string(), z.string()).optional(),
    env: 'WEBHOOK_CUSTOM_HEADERS',
    envSchema: WebhookHeadersSchema,
    description:
      'Optional JSON object string containing custom HTTP headers sent with webhook requests (e.g. `{"Authorization":"Bearer ..."}`).',
  },
  {
    group: 'sentry',
    type: 'string',
    defaultLabel: '\u2014',
    example: 'set',
    key: 'antigravityEndpointUrl',
    value: undefined,
    overrideSchema: z.string().url().or(z.literal('')).optional(),
    env: 'ANTIGRAVITY_ENDPOINT_URL',
    envSchema: z.string().url().or(z.literal('')),
    description:
      'Custom Language Server Connect-RPC URL (port and CSRF credentials are auto-discovered from local process by default).',
  },
  {
    group: 'sentry',
    type: 'string',
    defaultLabel: '\u2014',
    example: 'comment',
    secret: true,
    key: 'antigravityCsrfToken',
    value: undefined,
    overrideSchema: z.string().optional(),
    env: 'ANTIGRAVITY_CSRF_TOKEN',
    envSchema: z.string(),
    description:
      'Explicit CSRF token for Language Server Connect-RPC requests (auto-discovered if unset).',
  },
  {
    group: 'sentry',
    type: 'number',
    defaultLabel: '60643',
    example: 'comment',
    env: 'ANTIGRAVITY_LS_PORT',
    description:
      'TCP port of the local Antigravity Language Server, used when the port cannot be discovered from a running process.',
  },
  {
    group: 'sentry',
    type: 'number',
    defaultLabel: '60',
    example: 'set',
    key: 'quotaCheckIntervalSeconds',
    value: 60,
    overrideSchema: z.number().int().min(15),
    env: 'QUOTA_CHECK_INTERVAL_SECONDS',
    envSchema: z.coerce.number().int().min(15),
    description: 'Sentry polling interval (60s = 1m). Min: 15.',
  },
  {
    group: 'sentry',
    type: 'number',
    defaultLabel: '24',
    example: 'set',
    key: 'agyUpdateIntervalHours',
    value: 24,
    overrideSchema: z.number().min(0),
    env: 'AGY_UPDATE_INTERVAL_HOURS',
    envSchema: z.coerce.number().min(0),
    description:
      'Interval, in hours, for a periodic background `agy update` run by the coordinator daemon and by swarm runners between poll cycles (never while a task is executing). `0` disables it; a refresh is skipped while a quota probe or another update is in flight, and quota probes are skipped while an update runs. Failures are logged as warnings without stopping the process; the version transition is logged at info. Independent of the one-shot container start refresh (`AGY_UPDATE_ON_BOOT`, see [deployment](./deployment.md)).',
  },
  {
    group: 'sentry',
    type: 'number',
    defaultLabel: '25',
    example: 'set',
    key: 'quotaAlertThresholdPercent',
    value: 25,
    overrideSchema: z.number().min(0).max(100),
    env: 'QUOTA_ALERT_THRESHOLD_PERCENT',
    envSchema: z.coerce.number().min(0).max(100),
    description: 'Minimum quota headroom percentage triggering alert.',
  },
  {
    group: 'sentry',
    type: 'string',
    defaultLabel: '48,24,12',
    example: 'set',
    key: 'quotaMilestoneHours',
    value: [...DEFAULT_MILESTONE_HOURS],
    overrideSchema: z.array(z.number().positive()),
    env: 'QUOTA_MILESTONE_HOURS',
    envSchema: milestoneHoursEnv,
    invalidReason: 'no valid positive hour entries',
    fallbackToDefault: true,
    description: 'Comma-separated deadline milestone evaluation windows.',
  },
  {
    group: 'sentry',
    type: 'number',
    defaultLabel: '10',
    example: 'set',
    key: 'minDispatchHeadroomPercent',
    value: 10,
    overrideSchema: z.number().min(0).max(100),
    env: 'MIN_DISPATCH_HEADROOM_PERCENT',
    envSchema: z.coerce.number().min(0).max(100),
    description:
      'Safety floor headroom % preventing paid overages. Setting it to `0` disables the floor entirely, so pair that with `ALLOW_OVERAGE` below.',
  },
  {
    group: 'sentry',
    type: 'boolean',
    defaultLabel: 'false',
    example: 'set',
    key: 'allowOverage',
    value: false,
    overrideSchema: z.boolean(),
    env: 'ALLOW_OVERAGE',
    envSchema: booleanEnv,
    invalidReason: 'invalid boolean value',
    description:
      'Whether usage past 0% quota may draw purchased credits. The language server does not report this, so set it to match your account; it is the honest record of your overage posture.',
  },
  {
    group: 'coordinator',
    type: 'boolean',
    defaultLabel: 'false',
    example: 'set',
    key: 'coordinatorEnabled',
    value: false,
    overrideSchema: z.boolean(),
    env: 'COORDINATOR_ENABLED',
    envSchema: booleanEnv,
    invalidReason: 'invalid boolean value',
    description:
      'Enable/disable optional task continuation & runner coordinator. Sentry alerts operate when false.',
  },
  {
    group: 'coordinator',
    type: 'boolean',
    defaultLabel: 'true',
    example: 'set',
    key: 'routinesEnabled',
    value: true,
    overrideSchema: z.boolean(),
    env: 'ROUTINES_ENABLED',
    envSchema: booleanEnv,
    invalidReason: 'invalid boolean value',
    description:
      'Master switch for Tier 3 routine tasks. When `false`, no routine is auto-triggered regardless of its own `enabled` flag; the dashboard toggle writes this key.',
  },
  {
    group: 'coordinator',
    type: 'string',
    defaultLabel: 'backlog',
    example: 'set',
    key: 'githubBacklogLabel',
    value: 'backlog',
    overrideSchema: z.string().min(1),
    env: 'GITHUB_BACKLOG_LABEL',
    envSchema: z.string(),
    description:
      'Issue label that `POST /api/backlog/sync-github` imports as Tier 2 backlog items. Issues carrying it become pending work, and an active item is canceled when its issue closes upstream; a finished item keeps its status.',
  },
  {
    group: 'coordinator',
    type: 'string',
    defaultLabel: '\u2014',
    example: 'comment',
    secret: true,
    key: 'githubToken',
    value: undefined,
    overrideSchema: z.string().optional(),
    env: 'GITHUB_TOKEN',
    envSchema: z.string(),
    description:
      "GitHub PAT, a coordinator secret: encrypted at rest (`enc:v1`), masked in `GET /api/config`, and settable or clearable from **Settings** without a restart. Resolved from the SQLite override, then the coordinator's own `GITHUB_TOKEN` environment variable. Authenticates clone and push, pull requests, issue filing and `POST /api/backlog/sync-github` (without it that route falls back to the `gh` CLI and never calls REST unauthenticated). Each `POST /api/tasks/poll` attaches it to the lease in memory only, so a runner needs no token of its own and the value is never written to `swarm_tasks`, `runner.json` or a log.",
  },
  {
    group: 'coordinator',
    type: 'boolean',
    defaultLabel: 'false',
    example: 'comment',
    key: 'allowTokenlessRunner',
    value: false,
    overrideSchema: z.boolean(),
    env: 'ALLOW_TOKENLESS_RUNNER',
    envSchema: booleanEnv,
    invalidReason: 'expected a boolean',
    description:
      "Coordinator guard and runner-side override. On the coordinator, a runner whose poll reports `credentialsAvailable: false` is not leased a GitHub-remote task unless this is `true`; leaving it off is the correct setting for a GitHub remote, where a tokenless run would clone anonymously, spend the run's quota and fail the push. A runner also reads the variable from its own environment, for a non-GitHub remote where anonymous clone and push are expected.",
  },
  {
    group: 'coordinator',
    type: 'string',
    defaultLabel: '<hostname>',
    example: 'comment',
    exampleValue: '',
    env: 'RUNNER_ID',
    description:
      'Stable runner identity. Falls back to `RUNNER_NAME`, which itself falls back to the bare host name \u2014 a container identity that changes on every recreation and leaves a dead runner in the list.',
  },
  {
    group: 'coordinator',
    type: 'string',
    defaultLabel: '<hostname>',
    example: 'comment',
    exampleValue: '',
    env: 'RUNNER_NAME',
    description:
      'Stable runner identity used when `RUNNER_ID` is unset. Offline runners past a 10-minute grace are pruned automatically.',
  },
  {
    group: 'coordinator',
    type: 'string',
    defaultLabel: 'gemini-4-hydrogen',
    example: 'comment',
    key: 'defaultDispatchModel',
    value: 'gemini-4-hydrogen',
    overrideSchema: z.string(),
    env: 'DEFAULT_DISPATCH_MODEL',
    envSchema: z.string(),
    description:
      'Default model used for task dispatches when not explicitly selected. A model the active account tier withholds is resolved to the newest model the same pool group still serves (an AI Plus account holding only `gemini-3.8-flash` dispatches on it rather than on `gemini-4-hydrogen`); a group with no pool at all stays refused.',
  },
  {
    group: 'coordinator',
    type: 'string',
    defaultLabel: 'medium',
    example: 'comment',
    key: 'defaultDispatchEffort',
    value: 'medium',
    overrideSchema: z.enum(['low', 'medium', 'high', 'xhigh']),
    env: 'DEFAULT_DISPATCH_EFFORT',
    envSchema: z.enum(['low', 'medium', 'high', 'xhigh']),
    description:
      'Default reasoning effort passed to `agy --effort`. One of `low`, `medium`, `high`, `xhigh` \u2014 an unknown value is rejected.',
  },
  {
    group: 'coordinator',
    type: 'string',
    defaultLabel: 'all',
    example: 'comment',
    key: 'prPolicy',
    value: 'all',
    overrideSchema: PrPolicyEnum,
    env: 'PR_POLICY',
    envSchema: PrPolicyEnum,
    description:
      'Governance policy for every tier (`immediate`, `backlog`, `routine`), emitted as a `[Policy: ...]` directive. `all` lets every change through. `docs_only` suppresses the push and PR when any changed file is not documentation (doc extensions `.md` `.markdown` `.mdown` `.mkdn` `.txt` `.rst` `.adoc`; `README*`; `license`, `licence`, `notice`, `copying`, `authors`, `contributors`, `changelog`, `changes`, `code_of_conduct`, `contributing`, `security`; and `.svg`/`.png`/`.jpg`/`.jpeg`/`.gif`/`.webp` under `docs/` or `doc/`). `issues_only` and `none` suppress both the push and the PR regardless of content. The branch is discarded and the run reports a success with `no_changes`, unless it filed GitHub issues, which then settle it `completed` with `issueUrls`. Overridable per task via the `pr_policy` column (default `inherit`, meaning fall back to this value).',
  },
  {
    group: 'coordinator',
    type: 'string',
    defaultLabel: '\u2014',
    example: 'comment',
    secret: true,
    key: 'runnerSharedSecret',
    value: undefined,
    overrideSchema: z.string().optional(),
    env: 'RUNNER_SHARED_SECRET',
    envSchema: z.string(),
    description: 'Optional shared fallback secret token for swarm runners.',
  },
  {
    group: 'coordinator',
    type: 'number',
    defaultLabel: '4',
    example: 'comment',
    key: 'quotaBurnMaxHours',
    value: DEFAULT_QUOTA_BURN_MAX_HOURS,
    overrideSchema: z.number().positive(),
    env: 'QUOTA_BURN_MAX_HOURS',
    envSchema: z.coerce.number().positive(),
    description:
      'Routine fallback window: hours remaining before reset that release a Tier 3 routine which sets no `trigger_before_reset_hours` of its own. A manual `pre_reset` dispatch also waits for the reset to be this close before it leaves `QUOTA_BURN_QUEUED`.',
  },
  {
    group: 'coordinator',
    type: 'number',
    defaultLabel: '30',
    example: 'comment',
    key: 'quotaBurnMinHeadroomPercent',
    value: 30,
    overrideSchema: z.number().min(0).max(100),
    env: 'QUOTA_BURN_MIN_HEADROOM_PERCENT',
    envSchema: z.coerce.number().min(0).max(100),
    description:
      'Pre-reset burn floor: minimum remaining pool headroom percentage for a manual `pre_reset` dispatch to be released once its window opens. Falls back to `MIN_DISPATCH_HEADROOM_PERCENT` when unset or `0`; routines gate on their own `min_headroom_percent` instead.',
  },
  {
    group: 'coordinator',
    type: 'number',
    defaultLabel: '40',
    example: 'comment',
    key: 'backlogMinHeadroomPercent',
    value: DEFAULT_BACKLOG_MIN_HEADROOM_PERCENT,
    overrideSchema: z.number().min(0).max(100),
    env: 'BACKLOG_MIN_HEADROOM_PERCENT',
    envSchema: z.coerce.number().min(0).max(100),
    description:
      'Minimum effective headroom percentage a Tier 2 backlog spawn requires, range 0\u2013100. It is a floor rather than an override: the spawn also has to clear `MIN_DISPATCH_HEADROOM_PERCENT`, and the higher of the two wins. Editable as **Backlog minimum headroom (%)** in **Settings \u2192 Coordinator**.',
  },
  {
    group: 'coordinator',
    type: 'string',
    defaultLabel: 'per_repo',
    example: 'comment',
    key: 'backlogConcurrency',
    value: DEFAULT_BACKLOG_CONCURRENCY,
    overrideSchema: z.enum(BACKLOG_CONCURRENCY_VALUES),
    env: 'BACKLOG_CONCURRENCY',
    envSchema: z.enum(BACKLOG_CONCURRENCY_VALUES),
    description:
      'How many Tier 2 backlog tasks the autonomous scheduler may keep active at once: `single` (1 globally), `per_repo` (1 per repository, capped by online runners), or `per_runner` (1 per online runner, even on the same repository). Editable as **Backlog concurrency** in **Settings \u2192 Coordinator**.',
  },
  {
    group: 'coordinator',
    type: 'string',
    defaultLabel: '[]',
    example: 'comment',
    key: 'repositories',
    value: [],
    overrideSchema: z.array(RepositorySchema),
    env: 'REPOSITORIES_JSON',
    envSchema: RepositoriesJsonSchema,
    exampleValue:
      '[{"id":"repo-1","name":"Repo 1","path":"/repos/repo-1","cloneUrl":"https://github.com/org/repo-1.git","defaultBranch":"main"}]',
    invalidReason: 'invalid JSON or repository entry',
    description:
      'Optional pre-configured repositories JSON array string (alternative to Web UI configuration).',
  },
  {
    group: 'security',
    type: 'string',
    defaultLabel: '\u2014',
    example: 'set',
    secret: true,
    env: 'AGYLITY_SECRET_KEY',
    description:
      'Master 256-bit key for AES-256-GCM. Accepts 64-char hex or passphrase. If unset, auto-generates key at `data/.agylity.key`.',
  },
  {
    group: 'security',
    type: 'string',
    defaultLabel: '\u2014',
    example: 'comment',
    secret: true,
    key: 'webUiAuthToken',
    value: undefined,
    overrideSchema: z.string().optional(),
    env: 'WEB_UI_AUTH_TOKEN',
    envSchema: z.string(),
    description:
      'Bearer token locking down the control plane. Required when `WEB_UI_HOST` is not a loopback address (the server refuses to start without it); enforces constant-time verification, brute-force rate limits, and full lock screen.',
  },
  {
    group: 'security',
    type: 'boolean',
    defaultLabel: 'true',
    example: 'set',
    key: 'webUiAuthExemptLocalhost',
    value: true,
    overrideSchema: z.boolean(),
    env: 'WEB_UI_AUTH_EXEMPT_LOCALHOST',
    envSchema: booleanEnv,
    invalidReason: 'invalid boolean value',
    description:
      'When true, a request bypasses Bearer token authentication only when **both** the resolved client IP and the direct peer socket are loopback (`127.0.0.0/8`, `::1`). A proxied or forwarded request whose socket is not loopback still requires the token.',
  },
  {
    group: 'security',
    type: 'string',
    defaultLabel: '\u2014',
    example: 'comment',
    key: 'allowedIpRanges',
    value: [],
    overrideSchema: z.array(z.string()),
    env: 'ALLOWED_IP_RANGES',
    envSchema: AllowedIpRangesSchema,
    description:
      'Comma-separated list of allowed IPv4/IPv6 addresses and CIDR subnets. Blocks unauthorized clients with HTTP 403 when set.',
  },
  {
    group: 'security',
    type: 'boolean',
    defaultLabel: 'false',
    example: 'comment',
    key: 'trustedProxies',
    value: false,
    overrideSchema: z.boolean(),
    env: 'TRUSTED_PROXIES',
    envSchema: booleanEnv,
    invalidReason: 'invalid boolean value',
    description:
      'When true, extracts client IP from proxy headers only when the direct peer socket is **loopback** (`127.0.0.0/8`, `::1/128`). Private ranges are deliberately NOT trusted \u2014 otherwise any host on the LAN or a Docker bridge could forge the client IP.',
  },
  {
    group: 'web',
    type: 'boolean',
    defaultLabel: 'false',
    example: 'set',
    key: 'webUiEnabled',
    value: false,
    overrideSchema: z.boolean(),
    env: 'WEB_UI_ENABLED',
    envSchema: booleanEnv,
    invalidReason: 'invalid boolean value',
    description: 'Enable/disable decoupled native HTTP web dashboard.',
  },
  {
    group: 'web',
    type: 'number',
    defaultLabel: '8484',
    example: 'set',
    key: 'webUiPort',
    value: 8484,
    overrideSchema: z.number().int().positive(),
    env: 'WEB_UI_PORT',
    envSchema: z.coerce.number().int().positive(),
    description: 'Web dashboard listening port.',
  },
  {
    group: 'web',
    type: 'string',
    defaultLabel: '0.0.0.0',
    example: 'set',
    key: 'webUiHost',
    value: '0.0.0.0',
    overrideSchema: z.string(),
    env: 'WEB_UI_HOST',
    envSchema: z.string(),
    description: 'Web dashboard interface bind address.',
  },
  {
    group: 'web',
    type: 'string',
    defaultLabel: '\u2014',
    example: 'comment',
    key: 'baseUrl',
    value: undefined,
    overrideSchema: z.string().url().or(z.literal('')).optional(),
    env: 'BASE_URL',
    envSchema: z.string().url(),
    description:
      'Public origin of the dashboard, e.g. `https://agylity.example.com`. When set, Discord and webhook embed titles link to the task inspector (dispatch status) or the quota overview (alerts). Unset keeps embeds unlinked; currently optional (may become required for future features such as OAuth/WebAuthn callbacks or inbound webhooks).',
  },
  {
    group: 'logging',
    type: 'string',
    defaultLabel: 'info',
    example: 'set',
    key: 'logLevel',
    value: 'info',
    overrideSchema: z.enum(['debug', 'info', 'warn', 'error']),
    env: 'LOG_LEVEL',
    envSchema: z.enum(['debug', 'info', 'warn', 'error']),
    description:
      'Minimum log level (`debug`, `info`, `warn`, `error`) for terminal stdout/stderr and web UI log buffer.',
  },
  {
    group: 'storage',
    type: 'string',
    defaultLabel: 'data/agylity.db',
    example: 'comment',
    env: 'DATABASE_PATH',
    description:
      'SQLite database holding config overrides, task history and runner records. Parent directories are created on boot.',
  },
  {
    group: 'storage',
    type: 'string',
    defaultLabel: 'data/state.json',
    example: 'comment',
    env: 'QUOTA_STATE_FILE_PATH',
    description:
      'Legacy quota milestone state file. Imported once into SQLite when the sentry ledger is empty, then never written again, so an upgrade does not re-fire alerts already sent.',
  },
  {
    group: 'storage',
    type: 'string',
    defaultLabel: 'agy',
    example: 'comment',
    env: 'AGY_BIN_PATH',
    description:
      'Path to the `agy` binary the daemon and runners invoke. Useful when the CLI is not on `PATH`.',
  },
  {
    group: 'storage',
    type: 'string',
    defaultLabel: '\u2014',
    example: 'comment',
    env: 'REMOTE_AGY_BIN_PATH',
    description:
      "Overrides `AGY_BIN_PATH` everywhere it is resolved: the daemon's quota CLI, the coordinator's model catalog, and remote/swarm execution.",
  },
  {
    group: 'runner',
    type: 'string',
    defaultLabel: 'http://127.0.0.1:8484',
    example: 'comment',
    env: 'COORDINATOR_URL',
    description:
      'URL of the central Agylity Coordinator server. A value with no scheme is read as `http://`.',
  },
  {
    group: 'runner',
    type: 'string',
    defaultLabel: '\u2014',
    example: 'comment',
    env: 'REGISTRATION_TOKEN',
    description:
      'One-time runner registration token (`agyr_reg_...`, default TTL 1 hour) minted by `POST /api/runners/registration-token` and exchanged at `POST /api/runners/register` for a persistent runner token. An `agyr_run_...` value is read as `RUNNER_TOKEN`.',
  },
  {
    group: 'runner',
    type: 'string',
    defaultLabel: '\u2014',
    example: 'comment',
    env: 'RUNNER_TOKEN',
    description:
      'Persistent runner token (`agyr_run_...`) issued when a registration token is exchanged. An `agyr_run_...` value supplied through `REGISTRATION_TOKEN` is treated the same way.',
  },
  {
    group: 'runner',
    type: 'string',
    defaultLabel: '\u2014',
    example: 'comment',
    env: 'RUNNER_LABELS',
    description:
      'Comma-separated labels advertised at registration, lowercased. A task that requires labels is only offered to a runner carrying all of them.',
  },
  {
    group: 'runner',
    type: 'string',
    defaultLabel: '\u2014',
    example: 'comment',
    env: 'RUNNER_REPOSITORIES',
    description:
      'Comma-separated repository IDs this runner is scoped to. Empty means unscoped: it may claim any repository the coordinator offers.',
  },
  {
    group: 'runner',
    type: 'string',
    defaultLabel: 'data/runner.json (/data/runner.json in the image)',
    example: 'comment',
    exampleValue: '',
    env: 'RUNNER_STATE_PATH',
    description:
      'Where the runner persists its identity and token, so a restart resumes instead of re-registering. Must be on writable, persistent storage.',
  },
  {
    group: 'runner',
    type: 'number',
    defaultLabel: '25000',
    example: 'comment',
    env: 'RUNNER_POLL_TIMEOUT_MS',
    description: "Long-poll timeout, in milliseconds, for the runner's task-queue request.",
  },
  {
    group: 'runner',
    type: 'number',
    defaultLabel: '2000',
    example: 'comment',
    env: 'RUNNER_IDLE_INTERVAL_MS',
    description:
      'Delay between polls after an empty long-poll, in milliseconds. A blank or non-numeric value falls back to the default instead of collapsing to `0`.',
  },
  {
    group: 'runner',
    type: 'string',
    defaultLabel: 'task `requestedBy`, else `User`',
    example: 'comment',
    exampleValue: '',
    env: 'GIT_AUTHOR_NAME',
    description:
      'Git commit author name for automated task completion commits. `GIT_COMMITTER_NAME` overrides the committer identity, which otherwise reuses this value.',
  },
  {
    group: 'runner',
    type: 'string',
    defaultLabel: 'user@users.noreply.github.com',
    example: 'comment',
    env: 'GIT_AUTHOR_EMAIL',
    description:
      'Git commit author email. `GIT_COMMITTER_EMAIL` overrides the committer identity, which otherwise reuses this value.',
  },
  {
    group: 'notifications',
    type: 'string',
    defaultLabel: 'none',
    example: 'comment',
    hidden: true,
    key: 'notificationChannel',
    value: 'none',
    overrideSchema: NotificationChannelEnum,
    description:
      'Singular view of `NOTIFICATION_CHANNELS`, derived on read so the daemon and the UI never disagree.',
  },
  {
    group: 'sentry',
    type: 'boolean',
    defaultLabel: 'plan default',
    example: 'comment',
    hidden: true,
    key: 'poolGroupPolicies',
    value: DEFAULT_POOL_GROUP_POLICIES,
    overrideSchema: PoolGroupPoliciesSchema,
    description: 'Per-pool alert and dispatch switches, written only from the dashboard.',
  },
] satisfies readonly ConfigRegistryEntry[];

// `satisfies` keeps each entry's literal key, so this check is real: a new `AppConfig` key with no
// registry entry fails to compile instead of silently never resolving.
type AssertNever<T extends never> = T;

/** Resolves to `never`; anything else is a compile error naming the uncovered key. */
export type UnregisteredConfigKeys = AssertNever<
  Exclude<keyof AppConfig, NonNullable<(typeof CONFIG_REGISTRY)[number]['key']>>
>;

const configDefaults: Partial<Record<keyof AppConfig, unknown>> = {};
const configFieldSchemas: Partial<Record<keyof AppConfig, z.ZodTypeAny>> = {};
for (const entry of CONFIG_REGISTRY) {
  if (entry.key === undefined) continue;
  configDefaults[entry.key] = entry.value;
  configFieldSchemas[entry.key] = entry.overrideSchema;
}

export const BUILTIN_DEFAULTS: AppConfig = configDefaults as AppConfig;

const CONFIG_FIELD_SCHEMAS = configFieldSchemas as Record<keyof AppConfig, z.ZodTypeAny>;

export const CONFIG_KEY_ENV_NAMES: Partial<Record<keyof AppConfig, string>> = Object.fromEntries(
  CONFIG_REGISTRY.flatMap((entry) =>
    entry.key !== undefined && entry.env !== undefined ? [[entry.key, entry.env]] : []
  )
) as Partial<Record<keyof AppConfig, string>>;

export const ENV_TO_CONFIG_KEY: Record<string, keyof AppConfig> = Object.fromEntries(
  CONFIG_REGISTRY.flatMap((entry) =>
    entry.key !== undefined && entry.env !== undefined ? [[entry.env, entry.key]] : []
  )
);

export const CANONICAL_SECRET_CONFIG_KEYS: readonly (keyof AppConfig)[] = CONFIG_REGISTRY.flatMap(
  (entry) => (entry.key !== undefined && entry.secret ? [entry.key] : [])
);

export const SECRET_CONFIG_KEY_ENV_NAMES: Record<string, string> = Object.fromEntries(
  CONFIG_REGISTRY.flatMap((entry) =>
    entry.key !== undefined && entry.env !== undefined && entry.secret
      ? [[entry.key, entry.env]]
      : []
  )
);

export const resolveWebUiAuthToken = (
  config: { webUiAuthToken?: string } | undefined,
  env: Record<string, string | undefined> = process.env
): string | undefined => config?.webUiAuthToken || env.WEB_UI_AUTH_TOKEN;

// A copied example env (`your_bot_token_here`) must never read as a configured value.
const isTemplatePlaceholder = (val: string | undefined): boolean =>
  typeof val === 'string' && /^your_[a-z0-9_]+_here$/i.test(val.trim());

export const parseRawEnv = (env: Record<string, string | undefined>): Partial<AppConfig> => {
  const sanitizedEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const trimmed = value.trim();
    sanitizedEnv[key] = trimmed === '' ? undefined : trimmed;
  }

  const result: Partial<AppConfig> = {};
  for (const entry of CONFIG_REGISTRY) {
    if (entry.key === undefined || entry.env === undefined || entry.envSchema === undefined)
      continue;
    const raw = sanitizedEnv[entry.env];
    if (raw === undefined || isTemplatePlaceholder(raw)) continue;

    // A preprocessor that throws on unparsable JSON is a rejected value, not a crash.
    let outcome: ReturnType<typeof entry.envSchema.safeParse> | null = null;
    try {
      outcome = entry.envSchema.safeParse(raw);
    } catch {
      outcome = null;
    }
    if (outcome === null || !outcome.success) {
      const reason =
        entry.invalidReason ??
        (outcome !== null && !outcome.success
          ? (outcome.error.issues[0]?.message ?? 'invalid value')
          : 'invalid value');
      warnEnvFallback(entry.env, reason);
      if (entry.fallbackToDefault) {
        const fallback = entry.value;
        (result as Record<string, unknown>)[entry.key] = Array.isArray(fallback)
          ? [...fallback]
          : fallback;
      }
      continue;
    }
    (result as Record<string, unknown>)[entry.key] = outcome.data;
  }

  // The plural is the source; the singular is derived so the daemon and the UI cannot disagree.
  if (result.notificationChannels !== undefined) {
    result.notificationChannel = result.notificationChannels[0] ?? 'none';
  }

  return result;
};

export const RawEnvSchema = z.object(
  Object.fromEntries(
    CONFIG_REGISTRY.flatMap((entry) =>
      entry.env !== undefined && entry.envSchema !== undefined
        ? [[entry.env, entry.envSchema.optional()]]
        : []
    )
  )
);

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
