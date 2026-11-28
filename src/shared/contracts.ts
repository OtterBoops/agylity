// Wire contracts: one declaration per payload the HTTP API emits, shared by the daemon and the
// dashboard. Both sides import from here, so a field added on one side cannot drift from the other.
//
// Only types, type-only imports and dependency-free literal tuples belong here: Vite bundles this
// file directly into the client, so a zod or `node:` import would leak a server concern across the
// boundary. Validation schemas stay beside their producer and derive nothing from this file.

import type { PoolGroup, ReasoningEffort } from './models.js';

export const PR_POLICY_VALUES = ['all', 'docs_only', 'issues_only', 'none'] as const;

export type PrPolicy = (typeof PR_POLICY_VALUES)[number];

export const BACKLOG_CONCURRENCY_VALUES = ['single', 'per_repo', 'per_runner'] as const;

export type BacklogConcurrency = (typeof BACKLOG_CONCURRENCY_VALUES)[number];

export type TaskTier = 'immediate' | 'backlog' | 'routine';

/** The server never emits `running`; a live task is `claimed` or `executing`. */
export type TaskStatus =
  'queued' | 'claimed' | 'executing' | 'completed' | 'no_changes' | 'failed' | 'aborted';

export type BacklogStatus =
  'pending' | 'dispatched' | 'paused' | 'completed' | 'failed' | 'canceled';

/** Settled backlog rows: nothing will schedule them again, so the UI may hide or clear them. */
export const FINISHED_BACKLOG_STATUS_VALUES = ['completed', 'canceled'] as const;

export type ScheduleMode = 'immediate' | 'pre_reset';

export const PROBE_SOURCES = [
  'connect_rpc',
  'cli',
  'cli_fallback',
  'unreachable',
  'auth_required',
] as const;

export type ProbeSource = (typeof PROBE_SOURCES)[number];

export interface CascadeHop {
  model: string;
  effort: ReasoningEffort;
}

export interface QuotaBucket {
  bucketId: string;
  displayName: string;
  window?: string;
  remainingFraction: number;
  resetTime?: string;
  /** Absent when the pool reported no reset for this bucket, so it is not a 0-hour countdown. */
  hoursUntilReset?: number | null;
  description?: string;
  disabled?: boolean;
}

export interface QuotaBurnProjection {
  burnRatePerHour: number;
  projectedRemainingAtResetPercent: number;
  hoursUntilFloor: number | null;
}

export interface QuotaSnapshot {
  poolId: string;
  poolGroup: PoolGroup;
  displayName: string;
  /** Primary eval target (weekly). */
  remainingFraction: number;
  resetTime: string;
  hoursUntilReset: number;
  models: string[];
  overageEnabled?: boolean;
  remainingCredits?: number | null;
  burnProjection?: QuotaBurnProjection;
  weekly?: QuotaBucket;
  shortTerm?: QuotaBucket;
  buckets?: QuotaBucket[];
}

export interface BurnSample {
  at: string;
  remainingFraction: number;
  resetTime: string;
}

export interface SentryPoolState {
  resetTime: string;
  remainingFraction: number;
  firedMilestones: string[];
  lastAlertSentAt?: string | null;
  samples?: BurnSample[];
}

export interface EarlyResetPool {
  poolId: string;
  displayName?: string;
  previousRemainingFraction: number;
  remainingFraction: number;
  previousResetTime: string;
  resetTime: string;
}

export interface EarlyResetNotice {
  detectedAt: string;
  pools: EarlyResetPool[];
}

export interface SentryAlertState {
  version: number;
  lastProbeAt: string;
  lastProbeSource: ProbeSource;
  authRequired?: boolean;
  authErrorMessage?: string;
  pools: Record<string, SentryPoolState>;
  earlyResetNotice?: EarlyResetNotice | null;
}

export interface RunnerSystemInfo {
  hostname?: string;
  platform?: string;
  arch?: string;
  agyVersion?: string | null;
}

export interface SwarmRunnerRecord {
  runnerId: string;
  name: string;
  labels: string[];
  repositories: string[];
  systemInfo: RunnerSystemInfo;
  enabled: boolean;
  hasToken: boolean;
  activeTaskId?: string;
  status: 'idle' | 'busy' | 'offline';
  registeredAt: string;
  lastSeenAt: string;
}

export interface RunnersResponse {
  runners: SwarmRunnerRecord[];
  /** False when the coordinator holds no GitHub token: runners cannot push, open PRs or file issues. */
  credentialsAvailable: boolean;
}

export interface RunnerRegistrationTokenResult {
  id: string;
  registrationToken: string;
  nameHint?: string;
  labels: string[];
  repositories: string[];
  expiresAt: string;
  createdAt: string;
}

export interface SwarmTask {
  id: string;
  taskNumber: number;
  title: string;
  tier: TaskTier;
  originId?: string;
  originNumber?: number;
  originIssueNumber?: number;
  originTitle?: string;
  createdAt: string;
  updatedAt: string;
  repositoryId: string;
  repositoryName: string;
  repositoryPath: string;
  cloneUrl?: string;
  defaultBranch: string;
  prompt: string;
  requestedBy: string;
  prPolicy?: PrPolicy;
  scheduleMode: ScheduleMode;
  requiredLabels: string[];
  model: string;
  cascade: CascadeHop[];
  poolGroup: PoolGroup;
  effort: ReasoningEffort;
  allowOverage: boolean;
  pushBranch: boolean;
  autoCreatePr: boolean;
  prUrl?: string;
  issueUrls?: string[];
  expiresAt?: string;
  verifyCommand?: string;
  status: TaskStatus;
  runnerId?: string;
  claimedAt?: string;
  heartbeatAt?: string;
  completedAt?: string;
  branchName?: string;
  output?: string;
  error?: string;
  durationMs: number;
  numTurns?: number;
  totalTokens?: number;
  thinkingTokens?: number;
}

export interface BacklogTaskRecord {
  id: string;
  taskNumber: number;
  title: string;
  prompt: string;
  repositoryId: string;
  cascade: CascadeHop[];
  verifyCommand?: string;
  autoCreatePr: boolean;
  priorityOrder: number;
  status: BacklogStatus;
  attemptCount: number;
  maxAttempts: number;
  lastError?: string;
  swarmTaskId?: string;
  githubIssueNumber?: number;
  githubIssueUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export type RoutineEligibilityState =
  | 'disabled'
  | 'running'
  | 'ready'
  | 'waiting_window'
  | 'cycle_complete'
  | 'cycle_failed'
  | 'pool_disabled'
  | 'low_headroom'
  | 'no_telemetry';

export interface RoutineEligibilityStatus {
  state: RoutineEligibilityState;
  label: string;
  detail: string;
}

export interface RoutineTaskRecord {
  id: string;
  taskNumber: number;
  title: string;
  prompt: string;
  repositoryId: string;
  cascade: CascadeHop[];
  verifyCommand?: string;
  autoCreatePr: boolean;
  prPolicy?: PrPolicy;
  enabled: boolean;
  sortOrder: number;
  triggerBeforeResetHours: number;
  minHeadroomPercent: number;
  lastTriggeredResetTime?: string;
  lastTriggeredCycles: Record<string, string>;
  lastTaskId?: string;
  createdAt: string;
  updatedAt: string;
  /** Computed per read from live telemetry, so it is absent on the stored row itself. */
  eligibility?: RoutineEligibilityStatus;
}

export interface DeliveryChannelResult {
  success: boolean;
  error?: string;
  /** The notification type was switched off: the event is logged and recorded, never delivered. */
  suppressed?: boolean;
}

export const NOTIFICATION_DESTINATION_TYPES = ['discord', 'webhook'] as const;

export type NotificationDestinationType = (typeof NOTIFICATION_DESTINATION_TYPES)[number];

/** One configured push destination. `config` holds the type's own secrets and identifiers. */
export interface NotificationDestination {
  id: string;
  type: NotificationDestinationType;
  label: string;
  enabled: boolean;
  pingOwner: boolean;
  config: Record<string, unknown>;
}

export interface AlertEvent {
  id: number;
  firedAt: string;
  poolId: string;
  /** `milestone` or `early_reset` today; the column is open so a new kind reads without a migration. */
  kind: string;
  milestoneHours: number | null;
  headroomPercent: number | null;
  resetTime: string;
  channels: Record<string, DeliveryChannelResult>;
}

export interface AlertEventPage {
  events: AlertEvent[];
  nextBefore: string | null;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  ts: string;
  level: LogLevel;
  message: string;
}

/** Agent output tail a heartbeat carries, in UTF-16 units (what `tailWindow` caps). */
export const HEARTBEAT_TAIL_BYTES = 16 * 1024;

/** Body ceiling the control plane enforces; the runner clips its status report to fit inside it. */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
