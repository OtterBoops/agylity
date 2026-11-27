import { z } from 'zod';
import {
  BacklogStatusSchema,
  CascadeHopSchema,
  ScheduleModeSchema,
  SuccessSchema,
  TaskStatusSchema,
} from './common.js';

/** A request hop may omit `effort`; the handler fills in the configured default. */
export const CascadeHopRequestSchema = CascadeHopSchema.extend({
  effort: CascadeHopSchema.shape.effort.optional(),
});

export const BacklogTaskSchema = z.object({
  id: z.string(),
  taskNumber: z.number(),
  title: z.string(),
  prompt: z.string(),
  repositoryId: z.string(),
  cascade: z.array(CascadeHopSchema),
  verifyCommand: z.string().optional(),
  autoCreatePr: z.boolean(),
  priorityOrder: z.number(),
  status: BacklogStatusSchema,
  attemptCount: z.number(),
  maxAttempts: z.number(),
  lastError: z.string().optional(),
  swarmTaskId: z.string().optional(),
  githubIssueNumber: z.number().optional(),
  githubIssueUrl: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const BacklogListResponseSchema = z.array(BacklogTaskSchema);

/** GET reads `status` only: the handler ignores any other query parameter. */
export const BacklogListQuerySchema = z.object({
  status: BacklogStatusSchema.optional(),
});

export const BacklogCreateRequestSchema = z.object({
  title: z.string(),
  prompt: z.string(),
  repositoryId: z.string(),
  cascade: z.array(CascadeHopRequestSchema).optional(),
  verifyCommand: z.string().optional(),
  autoCreatePr: z.boolean().optional(),
  priorityOrder: z.number().optional(),
  maxAttempts: z.number().optional(),
});

/** Status and attempt columns belong to the coordinator, so PATCH rejects them as unknown keys. */
export const BacklogPatchRequestSchema = z.object({
  title: z.string().optional(),
  prompt: z.string().optional(),
  repositoryId: z.string().optional(),
  cascade: z.array(CascadeHopRequestSchema).optional(),
  verifyCommand: z.string().nullable().optional(),
  autoCreatePr: z.boolean().optional(),
  priorityOrder: z.number().optional(),
  maxAttempts: z.number().optional(),
});

export const BacklogDeleteResponseSchema = z.object({
  ...SuccessSchema.shape,
  deleted: z.boolean(),
});

/** These codes also select the status line: safety blocks answer 400, origin conflicts 409. */
export const DispatchResultSchema = z.object({
  success: z.boolean(),
  status: TaskStatusSchema.optional(),
  taskId: z.string().optional(),
  dispatchId: z.string().optional(),
  repo: z.string(),
  branchName: z.string().optional(),
  model: z.string().optional(),
  poolGroup: z.string().optional(),
  scheduleMode: ScheduleModeSchema.optional(),
  requiredLabels: z.array(z.string()).optional(),
  output: z.string().optional(),
  error: z.string().optional(),
  code: z
    .enum([
      'COORDINATOR_DISABLED',
      'OVERAGE_PROTECTION_TRIGGERED',
      'QUOTA_BURN_QUEUED',
      'TELEMETRY_UNAVAILABLE',
      'ORIGIN_NOT_DISPATCHABLE',
      'EXECUTION_FAILED',
    ])
    .optional(),
  minDispatchHeadroomPercent: z.number().optional(),
  currentHeadroomPercent: z.number().optional(),
  durationMs: z.number().optional(),
});

export const BacklogBulkActionSchema = z.enum(['pause', 'resume', 'delete']);

export const BacklogBulkRequestSchema = z.object({
  action: BacklogBulkActionSchema,
  ids: z.array(z.string()),
});

export const BacklogBulkDeleteResponseSchema = z.object({
  deleted: z.number(),
  ids: z.array(z.string()),
  skipped: z.array(z.string()),
});

export const BacklogBulkUpdateResponseSchema = z.object({
  updated: z.number(),
  items: z.array(BacklogTaskSchema),
  skipped: z.array(z.string()),
});

export const BacklogSyncFailureSchema = z.object({
  repositoryId: z.string(),
  reason: z.string(),
});

export const BacklogSyncResponseSchema = z.object({
  success: z.boolean(),
  importedCount: z.number(),
  canceledCount: z.number(),
  label: z.string(),
  failedRepos: z.array(z.string()),
  failures: z.array(BacklogSyncFailureSchema),
});

/** The bulk handler answers with one of the two bodies above, selected by `action`. */
export const BacklogBulkResponseSchema = z.union([
  BacklogBulkUpdateResponseSchema,
  BacklogBulkDeleteResponseSchema,
]);
