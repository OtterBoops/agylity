import { z } from 'zod';
import type {
  RunnerRegistrationTokenResult,
  RunnersResponse,
  RunnerSystemInfo,
  SwarmRunnerRecord,
  SwarmTask,
} from '../../shared/contracts.js';
import {
  CascadeHopSchema,
  ErrorResponseSchema,
  PoolGroupSchema,
  PrPolicySchema,
  ReasoningEffortSchema,
  ScheduleModeSchema,
  SuccessSchema,
  TaskStatusSchema,
  TaskTierSchema,
} from './common.js';

export const RunnerSystemInfoSchema = z.object({
  hostname: z.string().optional(),
  platform: z.string().optional(),
  arch: z.string().optional(),
  agyVersion: z.string().nullable().optional(),
}) satisfies z.ZodType<RunnerSystemInfo>;

export const SwarmTaskSchema = z.object({
  id: z.string(),
  taskNumber: z.number(),
  title: z.string(),
  tier: TaskTierSchema,
  originId: z.string().optional(),
  originNumber: z.number().optional(),
  originIssueNumber: z.number().optional(),
  originTitle: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  repositoryId: z.string(),
  repositoryName: z.string(),
  repositoryPath: z.string(),
  cloneUrl: z.string().optional(),
  defaultBranch: z.string(),
  prompt: z.string(),
  requestedBy: z.string(),
  prPolicy: PrPolicySchema.optional(),
  scheduleMode: ScheduleModeSchema,
  requiredLabels: z.array(z.string()),
  model: z.string(),
  cascade: z.array(CascadeHopSchema),
  poolGroup: PoolGroupSchema,
  effort: ReasoningEffortSchema,
  allowOverage: z.boolean(),
  pushBranch: z.boolean(),
  autoCreatePr: z.boolean(),
  prUrl: z.string().optional(),
  issueUrls: z.array(z.string()).optional(),
  expiresAt: z.string().optional(),
  verifyCommand: z.string().optional(),
  status: TaskStatusSchema,
  runnerId: z.string().optional(),
  claimedAt: z.string().optional(),
  heartbeatAt: z.string().optional(),
  completedAt: z.string().optional(),
  branchName: z.string().optional(),
  output: z.string().optional(),
  error: z.string().optional(),
  durationMs: z.number(),
  numTurns: z.number().optional(),
  totalTokens: z.number().optional(),
  thinkingTokens: z.number().optional(),
}) satisfies z.ZodType<SwarmTask>;

/** The list query never selects `output`, so a page of tasks carries no run logs. */
export const TaskSummarySchema = SwarmTaskSchema.omit({ output: true });

/** Digest over status, updatedAt, output and error, so a poller can skip an unchanged task. */
export const TaskDetailResponseSchema = SwarmTaskSchema.extend({ fingerprint: z.string() });

export const TaskListQuerySchema = z.object({
  status: TaskStatusSchema.optional(),
  taskNumber: z.number().optional(),
  q: z.string().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
});

export const TaskListResponseSchema = z.object({
  tasks: z.array(TaskSummarySchema),
  total: z.number(),
  offset: z.number(),
  limit: z.number(),
});

/** A request hop may omit `effort`; the coordinator fills it from the model's default. */
export const DispatchCascadeHopSchema = z.object({
  model: z.string(),
  effort: ReasoningEffortSchema.optional(),
});

export const DispatchRequestSchema = z.object({
  repositoryId: z.string(),
  repositoryName: z.string().optional(),
  repositoryPath: z.string().optional(),
  cloneUrl: z.string().optional(),
  prompt: z.string(),
  title: z.string().optional(),
  tier: TaskTierSchema.optional(),
  originId: z.string().optional(),
  originNumber: z.number().optional(),
  originTitle: z.string().optional(),
  requestedBy: z.string().optional(),
  prPolicy: PrPolicySchema.optional(),
  scheduleMode: ScheduleModeSchema.optional(),
  requiredLabels: z.array(z.string()).optional(),
  cascade: z.array(DispatchCascadeHopSchema).optional(),
  allowOverage: z.boolean().optional(),
  pushBranch: z.boolean().optional(),
  autoCreatePr: z.boolean().optional(),
  expiresAt: z.string().optional(),
  standingTaskId: z.string().optional(),
  verifyCommand: z.string().optional(),
});

/** A refusal is this same body with `success: false` and a 4xx status instead of 200. */
export const DispatchResponseSchema = z.object({
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

export const ModelCatalogEntrySchema = z.object({
  id: z.string(),
  label: z.string(),
  poolGroup: PoolGroupSchema,
  defaultEffort: ReasoningEffortSchema,
  supportedEfforts: z.array(ReasoningEffortSchema).optional(),
  defaultForGroup: z.boolean().optional(),
  effectiveHeadroomPercent: z.number().nullable(),
  weeklyRemainingPercent: z.number().nullable(),
  shortTermRemainingPercent: z.number().nullable(),
  resetTime: z.string().nullable(),
  hoursUntilReset: z.number().nullable(),
  belowSafetyFloor: z.boolean(),
});

export const ModelCatalogSchema = z.object({
  defaultModel: z.string(),
  defaultEffort: ReasoningEffortSchema,
  models: z.array(ModelCatalogEntrySchema),
  unattributedModels: z.array(z.string()),
});

export const PollRequestSchema = z.object({
  runnerId: z.string().optional(),
  runnerName: z.string().optional(),
  labels: z.array(z.string()).optional(),
  repositories: z.array(z.string()).optional(),
  systemInfo: RunnerSystemInfoSchema.optional(),
  timeoutMs: z.number().optional(),
});

export const PollResponseSchema = z.object({
  task: SwarmTaskSchema.nullable(),
  coordinatorEnabled: z.boolean().optional(),
  credentialsAvailable: z.boolean(),
  gitIdentity: z.object({ name: z.string().optional(), email: z.string().optional() }).optional(),
  /** Lease-only: the coordinator's GitHub token reaches the runner on this response, never a row. */
  githubToken: z.string().optional(),
  leaseBlocked: z.enum(['missing_github_token']).optional(),
});

export const RunnerHeartbeatRequestSchema = z.object({
  taskId: z.string(),
  runnerId: z.string().optional(),
  leaseDurationMs: z.number().optional(),
  outputTail: z.string().optional(),
});

/** A withheld lease answers 409 with this same body and `leaseOk: false`. */
export const RunnerHeartbeatResponseSchema = z.object({
  leaseOk: z.boolean(),
  status: TaskStatusSchema,
  task: SwarmTaskSchema,
});

export const TaskStatusRequestSchema = z.object({
  status: TaskStatusSchema,
  runnerId: z.string().optional(),
  /** `null` clears the stored branch: a discarded branch has no name to report. */
  branchName: z.string().nullable().optional(),
  prUrl: z.string().optional(),
  issueUrls: z.array(z.string()).optional(),
  title: z.string().optional(),
  output: z.string().optional(),
  error: z.string().optional(),
  durationMs: z.number().optional(),
  numTurns: z.number().optional(),
  totalTokens: z.number().optional(),
  thinkingTokens: z.number().optional(),
  message: z.string().optional(),
});

export const TaskMutationResponseSchema = SuccessSchema.extend({ task: SwarmTaskSchema });

export const TaskConflictResponseSchema = ErrorResponseSchema.extend({
  status: TaskStatusSchema,
  task: SwarmTaskSchema.optional(),
});

export const SwarmRunnerRecordSchema = z.object({
  runnerId: z.string(),
  name: z.string(),
  labels: z.array(z.string()),
  repositories: z.array(z.string()),
  systemInfo: RunnerSystemInfoSchema,
  enabled: z.boolean(),
  hasToken: z.boolean(),
  activeTaskId: z.string().optional(),
  status: z.enum(['idle', 'busy', 'offline']),
  registeredAt: z.string(),
  lastSeenAt: z.string(),
}) satisfies z.ZodType<SwarmRunnerRecord>;

export const RunnersResponseSchema = z.object({
  runners: z.array(SwarmRunnerRecordSchema),
  credentialsAvailable: z.boolean(),
}) satisfies z.ZodType<RunnersResponse>;

export const RunnerPatchRequestSchema = z.object({ enabled: z.boolean() });

export const RunnerPatchResponseSchema = SuccessSchema.extend({ runner: SwarmRunnerRecordSchema });

export const RunnerRevokeResponseSchema = z.object({
  success: z.boolean(),
  revoked: z.boolean(),
  runnerId: z.string(),
});

export const RegistrationTokenRequestSchema = z.object({
  nameHint: z.string().optional(),
  labels: z.array(z.string()).optional(),
  repositories: z.array(z.string()).optional(),
  ttlMs: z.number().optional(),
});

export const RegistrationTokenResponseSchema = z.object({
  id: z.string(),
  registrationToken: z.string(),
  nameHint: z.string().optional(),
  labels: z.array(z.string()),
  repositories: z.array(z.string()),
  expiresAt: z.string(),
  createdAt: z.string(),
}) satisfies z.ZodType<RunnerRegistrationTokenResult>;

export const RunnerRegisterRequestSchema = z.object({
  registrationToken: z.string(),
  runnerId: z.string().optional(),
  runnerName: z.string().optional(),
  labels: z.array(z.string()).optional(),
  repositories: z.array(z.string()).optional(),
  systemInfo: RunnerSystemInfoSchema.optional(),
});

export const RunnerRegisterResponseSchema = z.object({
  success: z.boolean(),
  runner: SwarmRunnerRecordSchema,
  runnerToken: z.string(),
});
