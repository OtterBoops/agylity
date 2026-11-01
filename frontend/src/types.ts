export interface QuotaBucket {
  bucketId: string;
  displayName: string;
  window?: string;
  remainingFraction: number;
  resetTime: string;
  hoursUntilReset: number;
  description?: string;
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

export interface SentryAlertState {
  version: number;
  lastProbeAt: string;
  lastProbeSource: 'connect_rpc' | 'cli_fallback' | 'unreachable';
  pools: Record<string, SentryPoolState>;
}

export interface ConfigData {
  resolved: Record<string, any>;
  overrides: Record<string, any>;
  secretsMeta?: Record<string, { isSet: boolean }>;
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
  id: number;
  createdAt: string;
  repository: string;
  prompt: string;
  requestedBy: string;
  success: boolean;
  branch?: string;
  error?: string;
  durationMs: number;
}

export interface ModelCatalogEntry {
  id: string;
  label: string;
  family: 'claude' | 'gemini-argon' | 'gemini-flash';
  defaultEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  effectiveHeadroomPercent: number | null;
  weeklyRemainingPercent: number | null;
  shortTermRemainingPercent: number | null;
  resetTime: string | null;
  hoursUntilReset: number | null;
  belowSafetyFloor: boolean;
}

export interface SwarmWorkerRecord {
  workerId: string;
  name: string;
  workerMode: 'headless' | 'visible' | 'any';
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
  workerMode: 'headless' | 'visible' | 'any';
  labels: string[];
  repositories: string[];
  expiresAt: string;
  createdAt: string;
}

export interface SwarmTask {
  id: string;
  createdAt: string;
  updatedAt: string;
  repositoryId?: string;
  repositoryName: string;
  repositoryPath?: string;
  cloneUrl?: string;
  defaultBranch?: string;
  prompt: string;
  requestedBy: string;
  priority: 'P0' | 'P1' | 'P2';
  workerMode: 'headless' | 'visible' | 'any';
  requiredLabels: string[];
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  status: 'queued' | 'claimed' | 'executing' | 'completed' | 'failed';
  claimedByWorkerId?: string;
  branchName?: string;
  error?: string;
  durationMs?: number;
  dispatchId?: number;
}
