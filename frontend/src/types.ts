import type * as preact from 'preact';

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

/**
 * Forecast from the observed burn rate; `hoursUntilFloor` is null when the projection never
 * reaches the safety floor before the window resets.
 */
export interface QuotaBurnProjection {
  burnRatePerHour: number;
  projectedRemainingAtResetPercent: number;
  hoursUntilFloor: number | null;
}

export interface QuotaSnapshot {
  poolId: string;
  family: string;
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

export interface ToastState {
  type: 'success' | 'error';
  message: string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  ts: string;
  level: LogLevel;
  message: string;
}

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface ModelCatalogEntry {
  id: string;
  label: string;
  family: 'claude' | 'gemini-argon' | 'gemini-flash';
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

/** `running` is the heartbeat state a runner reports while output is still streaming. */
export type TaskStatus =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'executing'
  | 'completed'
  | 'no_changes'
  | 'failed'
  | 'aborted';

export type PrPolicy = 'docs_only' | 'all' | 'none';
export type TaskTier = 'immediate' | 'backlog' | 'routine';
export type BacklogStatus = 'pending' | 'dispatched' | 'completed' | 'failed' | 'canceled';

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
  models: string[];
  effort: ReasoningEffort;
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

/**
 * Server-computed reason a routine will or will not dispatch this cycle. The label and detail
 * are authoritative copy — the UI never re-derives them from quota state.
 */
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
  models: string[];
  effort: ReasoningEffort;
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
  /** Absent only while a cached, pre-upgrade payload is still being served. */
  eligibility?: RoutineEligibility;
}

export interface RepositoryConfig {
  id: string;
  name: string;
  path: string;
  cloneUrl?: string;
  defaultBranch?: string;
}
