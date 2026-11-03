import { z } from 'zod';
import type { QuotaAlert, QuotaSnapshot } from '../sentry/models.js';
import type { ResolvedConfig } from '../config/schema.js';

export type { QuotaAlert, QuotaSnapshot };

export type DispatchStep = 'waking' | 'polling' | 'executing' | 'completed' | 'aborted' | 'failed';

export const DispatchStepSchema = z.enum([
  'waking',
  'polling',
  'executing',
  'completed',
  'aborted',
  'failed',
]);

export interface DispatchStatusUpdate {
  status?: DispatchStep;
  step?: DispatchStep | string;
  message?: string;
  repositoryName?: string;
  repositoryPath?: string;
  prompt?: string;
  branchName?: string;
  output?: string;
  error?: string;
  durationMs?: number;
  requestedBy?: string;
  timestamp?: string;
  details?: Record<string, unknown>;
  taskId?: string;
  model?: string;
  runnerName?: string;
  createdAt?: string;
}

export const DispatchStatusUpdateSchema = z.object({
  status: DispatchStepSchema.optional(),
  step: z.string().optional(),
  message: z.string().optional(),
  repositoryName: z.string().optional(),
  repositoryPath: z.string().optional(),
  prompt: z.string().optional(),
  branchName: z.string().optional(),
  output: z.string().optional(),
  error: z.string().optional(),
  durationMs: z.number().optional(),
  requestedBy: z.string().optional(),
  timestamp: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  taskId: z.string().optional(),
  model: z.string().optional(),
  runnerName: z.string().optional(),
  createdAt: z.string().optional(),
});

export interface DispatchRequest {
  repositoryName: string;
  repositoryPath?: string;
  cloneUrl?: string;
  prompt: string;
  requestedBy: string;
  requestedByUserId?: string;
  repositoryId?: string;
  model?: string;
  priority?: 'P0' | 'P1' | 'P2';
  effort?: 'low' | 'medium' | 'high';
  workerMode?: 'headless' | 'visible' | 'any';
  poolFamily?: string;
  requiredLabels?: string[];
  allowOverage?: boolean;
  pushBranch?: boolean;
  verifyCommand?: string;
}

export const DispatchRequestSchema = z.object({
  repositoryName: z.string().min(1),
  repositoryPath: z.string().optional(),
  cloneUrl: z.string().url().optional(),
  prompt: z.string().min(1).max(4000),
  requestedBy: z.string().min(1),
  requestedByUserId: z.string().optional(),
  repositoryId: z.string().optional(),
  model: z.string().optional(),
  priority: z.enum(['P0', 'P1', 'P2']).optional(),
  effort: z.enum(['low', 'medium', 'high']).optional(),
  workerMode: z.enum(['headless', 'visible', 'any']).optional(),
  poolFamily: z.string().optional(),
  requiredLabels: z.array(z.string()).optional(),
  allowOverage: z.boolean().optional(),
  pushBranch: z.boolean().optional(),
  verifyCommand: z.string().optional(),
});

export interface DispatchResult {
  success: boolean;
  branchName?: string;
  output?: string;
  error?: string;
  durationMs: number;
  taskId?: string;
  priority?: 'P0' | 'P1' | 'P2';
  status?: string;
  code?: string;
}

export const DispatchResultSchema = z.object({
  success: z.boolean(),
  branchName: z.string().optional(),
  output: z.string().optional(),
  error: z.string().optional(),
  durationMs: z.number().nonnegative(),
  taskId: z.string().optional(),
  priority: z.enum(['P0', 'P1', 'P2']).optional(),
  status: z.string().optional(),
  code: z.string().optional(),
});

/** Per-channel outcome of a single notification delivery attempt. */
export interface DeliveryChannelResult {
  success: boolean;
  error?: string;
}

// Outcome of notifyQuotaAlert; `delivered` is true if any channel succeeded, or if none are configured.
export interface DeliveryOutcome {
  delivered: boolean;
  results: Record<string, DeliveryChannelResult>;
}

export interface Notifier {
  readonly channelName: string;
  initialize(): Promise<void>;
  notifyQuotaAlert(alert: QuotaAlert): Promise<DeliveryOutcome>;
  notifyDispatchStatus(status: DispatchStatusUpdate): Promise<void>;
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
  onContinueRequested?: (req: any) => Promise<DispatchResult>;
  onQuotaRequested?: () => Promise<QuotaSnapshot[]>;
  onOwnerDiscovered?: (ownerUserId: string) => void | Promise<void>;
}
