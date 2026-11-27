import { z } from 'zod';
import { PoolGroupSchema, ProbeSourceSchema } from './common.js';

export const QuotaBucketSchema = z.object({
  bucketId: z.string(),
  displayName: z.string(),
  window: z.string().optional(),
  remainingFraction: z.number(),
  resetTime: z.string().optional(),
  hoursUntilReset: z.number().nullable().optional(),
  description: z.string().optional(),
  disabled: z.boolean().optional(),
});

export const QuotaBurnProjectionSchema = z.object({
  burnRatePerHour: z.number(),
  projectedRemainingAtResetPercent: z.number(),
  hoursUntilFloor: z.number().nullable(),
});

export const QuotaSnapshotSchema = z.object({
  poolId: z.string(),
  poolGroup: PoolGroupSchema,
  displayName: z.string(),
  remainingFraction: z.number(),
  resetTime: z.string(),
  hoursUntilReset: z.number(),
  models: z.array(z.string()),
  overageEnabled: z.boolean().optional(),
  remainingCredits: z.number().nullable().optional(),
  burnProjection: QuotaBurnProjectionSchema.optional(),
  weekly: QuotaBucketSchema.optional(),
  shortTerm: QuotaBucketSchema.optional(),
  buckets: z.array(QuotaBucketSchema).optional(),
});

/** GET /api/quota answers with the bare array, not an envelope object. */
export const QuotaResponseSchema = z.array(QuotaSnapshotSchema);

export const SummaryResponseSchema = z.object({
  geminiPercent: z.number().nullable(),
  claudePercent: z.number().nullable(),
  agyVersion: z.string().nullable(),
});

export const BurnSampleSchema = z.object({
  at: z.string(),
  remainingFraction: z.number(),
  resetTime: z.string(),
});

export const SentryPoolStateSchema = z.object({
  resetTime: z.string(),
  remainingFraction: z.number(),
  firedMilestones: z.array(z.string()),
  lastAlertSentAt: z.string().nullable().optional(),
  samples: z.array(BurnSampleSchema).optional(),
});

export const EarlyResetPoolSchema = z.object({
  poolId: z.string(),
  displayName: z.string().optional(),
  previousRemainingFraction: z.number(),
  remainingFraction: z.number(),
  previousResetTime: z.string(),
  resetTime: z.string(),
});

export const EarlyResetNoticeSchema = z.object({
  detectedAt: z.string(),
  pools: z.array(EarlyResetPoolSchema),
});

export const SentryAlertStateSchema = z.object({
  version: z.number(),
  lastProbeAt: z.string(),
  lastProbeSource: ProbeSourceSchema,
  authRequired: z.boolean().optional(),
  authErrorMessage: z.string().optional(),
  pools: z.record(z.string(), SentryPoolStateSchema),
  earlyResetNotice: EarlyResetNoticeSchema.nullable().optional(),
});

/** `earlyResetNotice` is always the literal `null` on this acknowledgement. */
export const AlertDismissResponseSchema = z.object({
  success: z.boolean(),
  dismissed: z.boolean(),
  earlyResetNotice: z.null(),
});

export const AlertEventsQuerySchema = z.object({
  limit: z.number().optional(),
  before: z.string().optional(),
  pool: z.string().optional(),
});

export const DeliveryChannelResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

export const AlertEventSchema = z.object({
  id: z.number(),
  firedAt: z.string(),
  poolId: z.string(),
  kind: z.string(),
  milestoneHours: z.number().nullable(),
  headroomPercent: z.number().nullable(),
  resetTime: z.string(),
  channels: z.record(z.string(), DeliveryChannelResultSchema),
});

export const AlertEventPageSchema = z.object({
  events: z.array(AlertEventSchema),
  nextBefore: z.string().nullable(),
});
