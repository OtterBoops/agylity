import { z } from 'zod';
import type {
  BacklogConcurrency,
  BacklogStatus,
  LogLevel,
  ProbeSource,
  PrPolicy,
  RoutineEligibilityState,
  ScheduleMode,
  TaskStatus,
  TaskTier,
} from '../../shared/contracts.js';
import type { PoolGroup, ReasoningEffort } from '../../shared/models.js';

// Each tuple is checked against the wire contract's union, so the two cannot drift silently.
export const TASK_STATUS_VALUES = [
  'queued',
  'claimed',
  'executing',
  'completed',
  'no_changes',
  'failed',
  'aborted',
] as const satisfies readonly TaskStatus[];

export const BACKLOG_STATUS_VALUES = [
  'pending',
  'dispatched',
  'paused',
  'completed',
  'failed',
  'canceled',
] as const satisfies readonly BacklogStatus[];

export const TASK_TIER_VALUES = [
  'immediate',
  'backlog',
  'routine',
] as const satisfies readonly TaskTier[];

export const SCHEDULE_MODE_VALUES = [
  'immediate',
  'pre_reset',
] as const satisfies readonly ScheduleMode[];

export const POOL_GROUP_VALUES = ['gemini', 'claude'] as const satisfies readonly PoolGroup[];

export const REASONING_EFFORT_VALUES = [
  'low',
  'medium',
  'high',
  'xhigh',
] as const satisfies readonly ReasoningEffort[];

export const PR_POLICY_VALUES = [
  'all',
  'docs_only',
  'issues_only',
  'none',
] as const satisfies readonly PrPolicy[];

export const BACKLOG_CONCURRENCY_VALUES = [
  'single',
  'per_repo',
  'per_runner',
] as const satisfies readonly BacklogConcurrency[];

export const PROBE_SOURCE_VALUES = [
  'connect_rpc',
  'cli',
  'cli_fallback',
  'unreachable',
  'auth_required',
] as const satisfies readonly ProbeSource[];

export const LOG_LEVEL_VALUES = [
  'debug',
  'info',
  'warn',
  'error',
] as const satisfies readonly LogLevel[];

export const ROUTINE_ELIGIBILITY_STATE_VALUES = [
  'disabled',
  'running',
  'ready',
  'waiting_window',
  'cycle_complete',
  'cycle_failed',
  'pool_disabled',
  'low_headroom',
  'no_telemetry',
] as const satisfies readonly RoutineEligibilityState[];

export const TaskStatusSchema = z.enum(TASK_STATUS_VALUES);
export const BacklogStatusSchema = z.enum(BACKLOG_STATUS_VALUES);
export const TaskTierSchema = z.enum(TASK_TIER_VALUES);
export const ScheduleModeSchema = z.enum(SCHEDULE_MODE_VALUES);
export const PoolGroupSchema = z.enum(POOL_GROUP_VALUES);
export const ReasoningEffortSchema = z.enum(REASONING_EFFORT_VALUES);
export const PrPolicySchema = z.enum(PR_POLICY_VALUES);
export const BacklogConcurrencySchema = z.enum(BACKLOG_CONCURRENCY_VALUES);
export const ProbeSourceSchema = z.enum(PROBE_SOURCE_VALUES);
export const LogLevelSchema = z.enum(LOG_LEVEL_VALUES);
export const RoutineEligibilityStateSchema = z.enum(ROUTINE_ELIGIBILITY_STATE_VALUES);

/** Every non-2xx body the control plane emits: `code` and `message` appear only where present. */
export const ErrorResponseSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  message: z.string().optional(),
});

export const SuccessSchema = z.object({ success: z.boolean() });

export const CascadeHopSchema = z.object({
  model: z.string(),
  effort: ReasoningEffortSchema,
});

/** Emitted by the request middleware, so every route can answer with one of these. */
export const UnauthorizedSchema = z.object({ error: z.string() });

export const ForbiddenSchema = z.object({
  error: z.string(),
  clientIp: z.string().optional(),
});

export const RateLimitedSchema = z.object({
  error: z.string(),
  retryAfterSeconds: z.number(),
});

export const PayloadTooLargeSchema = z.object({
  error: z.string(),
  message: z.string(),
});
