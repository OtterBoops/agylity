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

export interface SentryAlertState {
  version: number;
  lastProbeAt: string;
  lastProbeSource: ProbeSource;
  authRequired?: boolean;
  authErrorMessage?: string;
  pools: Record<string, SentryPoolState>;
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

export interface DispatchRecord {
  id: string | number;
  taskNumber?: number;
  title?: string;
  tier?: 'immediate' | 'backlog' | 'routine';
  originId?: string;
  originNumber?: number;
  originTitle?: string;
  createdAt: string;
  repository: string;
  repositoryName?: string;
  prompt: string;
  requestedBy: string;
  success: boolean;
  status?: TaskStatus;
  model?: string;
  effort?: string;
  branch?: string;
  branchName?: string;
  prUrl?: string;
  output?: string;
  error?: string;
  durationMs: number;
}

export interface ModelCatalogEntry {
  id: string;
  label: string;
  family: 'claude' | 'gemini-argon' | 'gemini-flash';
  defaultEffort: 'low' | 'medium' | 'high';
  supportedEfforts: ('low' | 'medium' | 'high')[];
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

export type TaskStatus =
  'queued' | 'claimed' | 'executing' | 'completed' | 'no_changes' | 'failed' | 'aborted';

export type BotPrPolicy = 'docs_only' | 'all' | 'none';
export type TaskActor = 'user' | 'bot';
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
  actor?: TaskActor;
  botPrPolicy?: BotPrPolicy;
  scheduleMode: 'immediate' | 'pre_reset';
  requiredLabels: string[];
  model: string;
  effort: 'low' | 'medium' | 'high';
  status: TaskStatus;
  runnerId?: string;
  claimedByRunnerId?: string;
  branchName?: string;
  autoCreatePr?: boolean;
  prUrl?: string;
  output?: string;
  error?: string;
  durationMs: number;
}

export interface BacklogTaskRecord {
  id: string;
  taskNumber: number;
  title: string;
  prompt: string;
  repositoryId: string;
  models: string[];
  effort: 'low' | 'medium' | 'high';
  verifyCommand?: string;
  autoCreatePr: boolean;
  actor: TaskActor;
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

export interface RoutineTaskRecord {
  id: string;
  taskNumber: number;
  title: string;
  prompt: string;
  repositoryId: string;
  models: string[];
  effort: 'low' | 'medium' | 'high';
  verifyCommand?: string;
  autoCreatePr: boolean;
  actor: TaskActor;
  enabled: boolean;
  sortOrder: number;
  triggerBeforeResetHours: number;
  minHeadroomPercent: number;
  lastTriggeredResetTime?: string;
  lastTaskId?: string;
  createdAt: string;
  updatedAt: string;
}

// Deprecated alias for legacy views transitioning to routines
export type StandingTaskRecord = RoutineTaskRecord;

export interface RepositoryConfig {
  id: string;
  name: string;
  path: string;
  cloneUrl?: string;
  defaultBranch?: string;
}
