import { z } from 'zod';
import {
  CascadeHopSchema,
  PrPolicySchema,
  RoutineEligibilityStateSchema,
  SuccessSchema,
} from './common.js';
import { CascadeHopRequestSchema, DispatchResultSchema } from './backlog.js';

export const RoutineEligibilityStatusSchema = z.object({
  state: RoutineEligibilityStateSchema,
  label: z.string(),
  detail: z.string(),
});

export const RoutineTaskSchema = z.object({
  id: z.string(),
  taskNumber: z.number(),
  title: z.string(),
  prompt: z.string(),
  repositoryId: z.string(),
  cascade: z.array(CascadeHopSchema),
  verifyCommand: z.string().optional(),
  autoCreatePr: z.boolean(),
  prPolicy: PrPolicySchema.optional(),
  enabled: z.boolean(),
  sortOrder: z.number(),
  triggerBeforeResetHours: z.number(),
  minHeadroomPercent: z.number(),
  lastTriggeredResetTime: z.string().optional(),
  lastTriggeredCycles: z.record(z.string(), z.string()),
  lastTaskId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  eligibility: RoutineEligibilityStatusSchema.optional(),
});

export const RoutineListResponseSchema = z.array(RoutineTaskSchema);

export const RoutineCreateRequestSchema = z.object({
  title: z.string(),
  prompt: z.string(),
  repositoryId: z.string(),
  cascade: z.array(CascadeHopRequestSchema).optional(),
  verifyCommand: z.string().optional(),
  autoCreatePr: z.boolean().optional(),
  /** `null` clears the routine's policy and leaves the run to the configured default. */
  prPolicy: PrPolicySchema.nullable().optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().optional(),
  triggerBeforeResetHours: z.number().optional(),
  minHeadroomPercent: z.number().optional(),
});

export const RoutinePatchRequestSchema = z.object({
  title: z.string().optional(),
  prompt: z.string().optional(),
  repositoryId: z.string().optional(),
  cascade: z.array(CascadeHopRequestSchema).optional(),
  verifyCommand: z.string().nullable().optional(),
  autoCreatePr: z.boolean().optional(),
  prPolicy: PrPolicySchema.nullable().optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().optional(),
  triggerBeforeResetHours: z.number().optional(),
  minHeadroomPercent: z.number().optional(),
});

export const RoutineDeleteResponseSchema = z.object({
  ...SuccessSchema.shape,
  deleted: z.boolean(),
});

export { DispatchResultSchema as RoutineTriggerResponseSchema };
