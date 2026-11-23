import type * as preact from 'preact';

import type { PoolGroup, ReasoningEffort } from '../../src/shared/models.ts';

export type { PoolGroup, ReasoningEffort };

declare module 'preact' {
  namespace JSX {
    interface IntrinsicAttributes {
      path?: string;
      default?: boolean;
    }
  }
}

declare module 'preact-router/match' {
  export interface LinkProps extends preact.JSX.HTMLAttributes<HTMLAnchorElement> {
    href?: string;
    activeClassName?: string;
    children?: preact.ComponentChildren;
  }
  export function Link(props: LinkProps & { href?: string }): preact.VNode;
}

export interface QuotaBucket {
  bucketId: string;
  displayName: string;
  window?: string;
  remainingFraction: number;
  resetTime?: string;
  hoursUntilReset: number;
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
  poolGroup: string;
  displayName: string;
  remainingFraction: number; // Primary eval target (weekly)
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

export interface SentryPoolState {
  resetTime: string;
  remainingFraction: number;
  firedMilestones: string[];
  lastAlertSentAt: string | null;
}

export type ProbeSource = 'connect_rpc' | 'cli' | 'cli_fallback' | 'unreachable' | 'auth_required';

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

export interface ConfigData {
  resolved: Record<string, any>;
  overrides: Record<string, any>;
  secretsMeta?: Record<string, { isSet: boolean }>;
  sources?: Record<string, 'override' | 'env' | 'default'>;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  ts: string;
  level: LogLevel;
  message: string;
}

export interface CascadeHop {
  model: string;
  effort: ReasoningEffort;
}

export interface ModelCatalogEntry {
  id: string;
  label: string;
  poolGroup: PoolGroup;
  defaultEffort: ReasoningEffort;
  supportedEfforts: ReasoningEffort[];
  effectiveHeadroomPercent: number | null;
  weeklyRemainingPercent: number | null;
  shortTermRemainingPercent: number | null;
  resetTime: string | null;
  hoursUntilReset: number | null;
  belowSafetyFloor: boolean;
}

export interface SwarmRunnerRecord {
  runnerId: string;
  name: string;
  labels: string[];
  repositories: string[];
  systemInfo?: {
    agyVersion?: string | null;
    hostname?: string;
    platform?: string;
    arch?: string;
  };
  enabled: boolean;
  hasToken: boolean;
  activeTaskId?: string;
  status: 'idle' | 'busy' | 'offline';
  registeredAt?: string;
  lastSeenAt: string;
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

export type TaskStatus =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'executing'
  | 'completed'
  | 'no_changes'
  | 'failed'
  | 'aborted';

export type PrPolicy = 'docs_only' | 'issues_only' | 'all' | 'none';
export type TaskTier = 'immediate' | 'backlog' | 'routine';
export type BacklogStatus =
  'pending' | 'dispatched' | 'completed' | 'failed' | 'canceled' | 'paused';

export interface SwarmTask {
  id: string;
  taskNumber?: number;
  title?: string;
  tier?: TaskTier;
  originId?: string;
  originNumber?: number;
  originTitle?: string;
  createdAt: string;
  updatedAt: string;
  repositoryId?: string;
  repositoryName: string;
  repositoryPath?: string;
  cloneUrl?: string;
  defaultBranch?: string;
  prompt: string;
  requestedBy: string;
  prPolicy?: PrPolicy;
  scheduleMode: 'immediate' | 'pre_reset';
  requiredLabels: string[];
  model: string;
  effort: ReasoningEffort;
  cascade?: CascadeHop[];
  verifyCommand?: string;
  status: TaskStatus;
  runnerId?: string;
  claimedByRunnerId?: string;
  claimedAt?: string;
  heartbeatAt?: string;
  completedAt?: string;
  branchName?: string;
  autoCreatePr?: boolean;
  prUrl?: string;
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

export interface RoutineEligibility {
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
  lastTaskId?: string;
  createdAt: string;
  updatedAt: string;
  eligibility?: RoutineEligibility;
}

export interface RepositoryConfig {
  id: string;
  name: string;
  path: string;
  cloneUrl?: string;
  defaultBranch?: string;
}

export interface DispatchPoolView {
  poolId: string;
  displayName: string;
  weeklyPercent: number | null;
  shortTermPercent: number | null;
  effectivePercent: number;
  limitingWindow: 'weekly' | 'short_term';
  hoursUntilReset: number | null;
  resetTime: string | null;
}

export interface DispatchEligibility {
  evaluatedAt: string;
  accepts: boolean;
  willRunNow: boolean;
  code: string | null;
  reason: string | null;
  model: string;
  poolGroup: string | null;
  pool: DispatchPoolView | null;
  floorPercent: number;
  allowOverage: boolean;
  autonomy: { quenched: boolean; remainingMs: number };
  runners: { online: number };
  telemetry: {
    probeSource: string;
    lastProbeAt: string | null;
    authRequired: boolean;
    authErrorMessage: string | null;
  };
  warnings: string[];
}

export interface AlertEvent {
  id: number;
  firedAt: string;
  poolId: string;
  kind: 'milestone' | 'early_reset' | string;
  milestoneHours: number | null;
  headroomPercent: number | null;
  resetTime: string | null;
  channels: Record<string, { success: boolean; error?: string }>;
}

export interface AlertEventPage {
  events: AlertEvent[];
  nextBefore: string | null;
}
