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
  details: z.record(z.unknown()).optional(),
  taskId: z.string().optional(),
});

export interface DispatchRequest {
  repositoryName: string;
  repositoryPath: string;
  prompt: string;
  requestedBy: string;
  repositoryId?: string;
}

export const DispatchRequestSchema = z.object({
  repositoryName: z.string().min(1),
  repositoryPath: z.string().min(1),
  prompt: z.string().min(1).max(4000),
  requestedBy: z.string().min(1),
  repositoryId: z.string().optional(),
});

export interface DispatchResult {
  success: boolean;
  branchName?: string;
  output?: string;
  error?: string;
  durationMs: number;
}

export const DispatchResultSchema = z.object({
  success: z.boolean(),
  branchName: z.string().optional(),
  output: z.string().optional(),
  error: z.string().optional(),
  durationMs: z.number().nonnegative(),
});

export interface Notifier {
  readonly channelName: string;
  initialize(): Promise<void>;
  notifyQuotaAlert(alert: QuotaAlert): Promise<void>;
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
  onQuotaRequested?: () => Promise<QuotaSnapshot[]>;
}
