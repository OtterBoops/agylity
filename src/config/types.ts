import type { BacklogConcurrency, NotificationDestination, PrPolicy } from '../shared/contracts.js';
import type { NotificationKind } from '../shared/notificationKinds.js';
import type { NotificationChannelType, PoolGroupPolicies, RepositoryEntry } from './env.js';

export interface AppConfig {
  notificationChannel: NotificationChannelType;
  notificationChannels: NotificationChannelType[];
  /** Push destination instances. Absent falls back to bootstrapping from the legacy fields below. */
  destinations?: NotificationDestination[];
  notificationTypes: Record<NotificationKind, boolean>;
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
  /** Commit identity for runner work; unset falls through to the runner's env, then the token. */
  gitAuthorName?: string;
  gitAuthorEmail?: string;
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
  trustedProxyRanges: string[];

  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export type ResolvedConfig = AppConfig & { destinations: NotificationDestination[] };

export type ConfigDocGroup =
  | 'notifications'
  | 'sentry'
  | 'coordinator'
  | 'security'
  | 'web'
  | 'logging'
  | 'storage'
  | 'runner';
