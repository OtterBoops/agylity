import type { QuotaAlert, QuotaSnapshot } from '../sentry/models.js';
import type { ResolvedConfig } from '../config/schema.js';
import type { DeliveryChannelResult } from '../shared/contracts.js';

export type { QuotaAlert, QuotaSnapshot };
// Delivered-channel results are part of the alert-history payload the dashboard reads.
export type { DeliveryChannelResult };

export type DispatchStep =
  'waking' | 'polling' | 'executing' | 'completed' | 'no_changes' | 'aborted' | 'failed';

export interface DispatchStatusUpdate {
  status?: DispatchStep;
  step?: DispatchStep | string;
  message?: string;
  repositoryName?: string;
  repositoryPath?: string;
  prompt?: string;
  branchName?: string;
  issueUrls?: string[];
  output?: string;
  error?: string;
  durationMs?: number;
  requestedBy?: string;
  timestamp?: string;
  details?: Record<string, unknown>;
  taskId?: string;
  model?: string;
  effort?: string;
  runnerName?: string;
  createdAt?: string;
}

export interface DispatchRequest {
  repositoryId: string;
  repositoryName?: string;
  repositoryPath?: string;
  cloneUrl?: string;
  prompt: string;
  requestedBy: string;
  requestedByUserId?: string;
  cascade?: { model: string; effort: 'low' | 'medium' | 'high' | 'xhigh' }[];
  runnerMode?: 'headless' | 'visible' | 'any';
  poolGroup?: string;
  requiredLabels?: string[];
  allowOverage?: boolean;
  pushBranch?: boolean;
  verifyCommand?: string;
}

export interface DispatchResult {
  success: boolean;
  branchName?: string;
  output?: string;
  error?: string;
  durationMs: number;
  taskId?: string;
  status?: string;
  code?: string;
}

export interface InfoNotice {
  title: string;
  message: string;
  path?: string;
  poolGroup?: string;
  poolName?: string;
  models?: string[];
  resetTime?: string;
  hoursUntilReset?: number;
  timestamp?: string;
}

export interface DeliveryOutcome {
  delivered: boolean;
  results: Record<string, DeliveryChannelResult>;
}

export interface Notifier {
  readonly channelName: string;
  initialize(): Promise<void>;
  notifyQuotaAlert(alert: QuotaAlert): Promise<DeliveryOutcome>;
  notifyDispatchStatus(status: DispatchStatusUpdate): Promise<void>;
  notifyInfo(notice: InfoNotice): Promise<DeliveryOutcome | void>;
  updateConfig?(newConfig: Partial<ResolvedConfig>): Promise<void>;
  shutdown(): Promise<void>;
  testNotification?(targetChannel?: string): Promise<{
    success: boolean;
    message: string;
    channel?: string;
    results?: Record<string, { success: boolean; message: string }>;
  }>;
}

export interface NotifierOptions {
  onDispatchRequested?: (req: DispatchRequest) => Promise<DispatchResult>;
  onContinueRequested?: (
    req: DispatchRequest & { taskId?: string; branchName?: string }
  ) => Promise<DispatchResult>;
  onQuotaRequested?: () => Promise<QuotaSnapshot[]>;
  onOwnerDiscovered?: (ownerUserId: string) => void | Promise<void>;
}
