import { z } from 'zod';
import { LogLevelSchema, PoolGroupSchema, ProbeSourceSchema } from './common.js';
import { NotificationDestinationSchema } from '../../config/env.js';

export const NotifyTestRequestSchema = z.object({
  destinationId: z.string().optional(),
  /** Test an unsaved draft instance; never persisted. */
  destination: NotificationDestinationSchema.optional(),
  channel: z.string().optional(),
  notificationWebhookUrl: z.string().optional(),
  webhookUrl: z.string().optional(),
  webhookSecret: z.string().optional(),
  discordToken: z.string().optional(),
  discordNotificationChannelId: z.string().optional(),
  discordChannelId: z.string().optional(),
  discordOwnerUserId: z.string().optional(),
  discordPingOwner: z.boolean().optional(),
});

/** Also the 400 body: a delivery that reports failure keeps this shape with `success: false`. */
export const NotifyTestResponseSchema = z.object({
  success: z.boolean(),
  channel: z.string(),
  message: z.string(),
});

export const NotifyTestErrorResponseSchema = z.object({
  success: z.boolean(),
  error: z.string(),
});

export const HealthResponseSchema = z.object({
  status: z.enum(['ok']),
  uptime: z.number(),
  timestamp: z.string(),
  authRequired: z.boolean(),
  agyVersion: z.string().nullable(),
  buildChannel: z.enum(['release', 'main', 'dev']),
  buildCommit: z.string().nullable(),
});

export const LogsQuerySchema = z.object({
  since: z.number().optional(),
  level: LogLevelSchema.optional(),
});

export const LogEntrySchema = z.object({
  id: z.number(),
  ts: z.string(),
  level: LogLevelSchema,
  message: z.string(),
});

export const LogsResponseSchema = z.object({
  enabled: z.boolean(),
  latestId: z.number(),
  entries: z.array(LogEntrySchema),
});

export const DispatchEligibilityQuerySchema = z.object({
  model: z.string().optional(),
  allowOverage: z.enum(['1', 'true', '0', 'false']).optional(),
});

export const DispatchEligibilitySchema = z.object({
  evaluatedAt: z.string(),
  accepts: z.boolean(),
  willRunNow: z.boolean(),
  code: z.string().nullable(),
  reason: z.string().nullable(),
  model: z.string(),
  poolGroup: PoolGroupSchema.nullable(),
  pool: z
    .object({
      poolId: z.string(),
      displayName: z.string(),
      weeklyPercent: z.number().nullable(),
      shortTermPercent: z.number().nullable(),
      effectivePercent: z.number().nullable(),
      limitingWindow: z.enum(['weekly', 'short_term']),
      hoursUntilReset: z.number().nullable(),
      resetTime: z.string(),
    })
    .nullable(),
  floorPercent: z.number(),
  allowOverage: z.boolean(),
  autonomy: z.object({ quenched: z.boolean(), remainingMs: z.number() }),
  runners: z.object({ online: z.number() }),
  telemetry: z.object({
    probeSource: ProbeSourceSchema,
    lastProbeAt: z.string().nullable(),
    authRequired: z.boolean(),
    authErrorMessage: z.string().nullable(),
  }),
  warnings: z.array(z.string()),
});

export const OpenApiDocumentSchema = z.object({
  openapi: z.string(),
  info: z.object({
    title: z.string(),
    version: z.string(),
    description: z.string(),
  }),
  components: z.record(z.string(), z.unknown()),
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
});
