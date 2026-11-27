import type http from 'node:http';
import type { z } from 'zod';
import type { WebServerOptions } from './types.js';
import {
  handleGetQuota,
  handleGetSummary,
  handleGetAlerts,
  handleDismissAlerts,
} from './controllers/quota.js';
import { handleGetAlertEvents } from './controllers/alerts.js';
import { handleDispatchEligibility } from './controllers/eligibility.js';
import { handleGetLogs } from './controllers/logs.js';
import { handleConfigEndpoint, handleDeleteConfigOverride } from './controllers/config.js';
import { handleTestNotify } from './controllers/notify.js';
import {
  handlePostDispatch,
  handleGetModels,
  handleGetTasks,
  handleGetTaskById,
  handlePollTasks,
  handleRunnerHeartbeat,
  handleTaskStatus,
  handleTaskCancel,
  handleTaskRetry,
  handleGetRunners,
  handleCreateRegistrationToken,
  handleRegisterRunner,
  handleManageRunnerById,
} from './controllers/dispatch.js';
import {
  handleBacklogTasks,
  handleBacklogTaskById,
  handleBulkBacklogTasks,
  handleSyncGithubBacklog,
} from './controllers/backlog.js';
import { handleRoutineTasks, handleRoutineTaskById } from './controllers/routines.js';
import { methodNotAllowed, sendJson } from './http.js';
import { buildOpenApiDocument } from './openapi.js';
import { normalizeBuildCommit, resolveBuildChannel } from '../shared/build.js';
import { AGYLITY_VERSION } from '../version.js';
import { ErrorResponseSchema } from './schemas/common.js';
import {
  AlertDismissResponseSchema,
  AlertEventPageSchema,
  AlertEventsQuerySchema,
  QuotaResponseSchema,
  SentryAlertStateSchema,
  SummaryResponseSchema,
} from './schemas/quota.js';
import {
  ConfigDeleteResponseSchema,
  ConfigUpdateRequestSchema,
  ConfigUpdateResponseSchema,
  ConfigViewSchema,
} from './schemas/config.js';
import {
  DispatchEligibilityQuerySchema,
  DispatchEligibilitySchema,
  HealthResponseSchema,
  LogsQuerySchema,
  LogsResponseSchema,
  NotifyTestErrorResponseSchema,
  NotifyTestRequestSchema,
  NotifyTestResponseSchema,
  OpenApiDocumentSchema,
} from './schemas/misc.js';
import {
  DispatchRequestSchema,
  DispatchResponseSchema,
  ModelCatalogSchema,
  PollRequestSchema,
  PollResponseSchema,
  RegistrationTokenRequestSchema,
  RegistrationTokenResponseSchema,
  RunnerHeartbeatRequestSchema,
  RunnerHeartbeatResponseSchema,
  RunnerPatchRequestSchema,
  RunnerPatchResponseSchema,
  RunnerRegisterRequestSchema,
  RunnerRegisterResponseSchema,
  RunnerRevokeResponseSchema,
  RunnersResponseSchema,
  TaskConflictResponseSchema,
  TaskDetailResponseSchema,
  TaskListQuerySchema,
  TaskListResponseSchema,
  TaskMutationResponseSchema,
  TaskStatusRequestSchema,
} from './schemas/dispatch.js';
import {
  BacklogBulkRequestSchema,
  BacklogBulkResponseSchema,
  BacklogCreateRequestSchema,
  BacklogDeleteResponseSchema,
  BacklogListQuerySchema,
  BacklogListResponseSchema,
  BacklogPatchRequestSchema,
  BacklogSyncResponseSchema,
  BacklogTaskSchema,
  DispatchResultSchema,
} from './schemas/backlog.js';
import {
  RoutineCreateRequestSchema,
  RoutineDeleteResponseSchema,
  RoutineListResponseSchema,
  RoutinePatchRequestSchema,
  RoutineTaskSchema,
  RoutineTriggerResponseSchema,
} from './schemas/routines.js';

export type RouteAuth = 'public' | 'bearer' | 'runner';

export interface RouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  options: WebServerOptions;
  url: URL;
  pathname: string;
  method: string;
  params: Record<string, string>;
  authRequired?: boolean;
  shutdownSignal?: AbortSignal;
}

/** Documents the wire shape; handlers keep their own parsing, so nothing here enforces. */
export interface RouteOperation {
  request?: { body?: z.ZodType; query?: z.ZodType; bodyOptional?: boolean };
  responses: Readonly<Record<number, z.ZodType>>;
}

export interface RouteSpec {
  path: string;
  methods: readonly string[];
  auth: RouteAuth;
  summary: string;
  operations: Readonly<Record<string, RouteOperation>>;
  invoke: (ctx: RouteContext) => void | Promise<void>;
}

const pathMatches = (pattern: string, pathname: string): Record<string, string> | undefined => {
  const patternParts = pattern.split('/');
  const nameParts = pathname.split('/');
  if (patternParts.length !== nameParts.length) return undefined;

  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index]!;
    const actual = nameParts[index]!;
    if (expected.startsWith('{') && expected.endsWith('}')) {
      if (!actual) return undefined;
      // A malformed escape stays raw so the handler answers 400 rather than the router throwing.
      try {
        params[expected.slice(1, -1)] = decodeURIComponent(actual);
      } catch {
        params[expected.slice(1, -1)] = actual;
      }
      continue;
    }
    if (expected !== actual) return undefined;
  }
  return params;
};

export const ROUTES: readonly RouteSpec[] = [
  {
    path: '/api/health',
    methods: ['GET'],
    auth: 'public',
    summary: 'Liveness, auth requirement and build provenance.',
    operations: {
      GET: { responses: { 200: HealthResponseSchema } },
    },
    invoke: ({ res, options, method, authRequired }) => {
      if (method !== 'GET') {
        return methodNotAllowed(res);
      }
      // Cache-only: a healthcheck must answer while `agy update` is rewriting the binary.
      void options.agyUpdater?.getVersion();
      return sendJson(res, 200, {
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        authRequired: Boolean(authRequired),
        agyVersion: options.agyUpdater?.getCachedVersion() ?? null,
        buildChannel: resolveBuildChannel(process.env.BUILD_CHANNEL),
        buildCommit: normalizeBuildCommit(process.env.BUILD_COMMIT),
      });
    },
  },
  {
    path: '/api/openapi.json',
    methods: ['GET'],
    auth: 'bearer',
    summary: 'This document, generated from the route registry.',
    operations: {
      GET: { responses: { 200: OpenApiDocumentSchema } },
    },
    invoke: ({ res, method }) => {
      if (method !== 'GET') {
        return methodNotAllowed(res);
      }
      return sendJson(res, 200, buildOpenApiDocument(AGYLITY_VERSION));
    },
  },
  {
    path: '/api/quota',
    methods: ['GET'],
    auth: 'bearer',
    summary: 'Current quota pools and credit balances.',
    operations: {
      GET: { responses: { 200: QuotaResponseSchema, 500: ErrorResponseSchema } },
    },
    invoke: ({ req, res, options, method }) => handleGetQuota(req, res, options, method),
  },
  {
    path: '/api/summary',
    methods: ['GET'],
    auth: 'bearer',
    summary: 'Headroom percentage per pool group plus the cached agy version.',
    operations: {
      GET: { responses: { 200: SummaryResponseSchema } },
    },
    invoke: ({ req, res, options, method }) => handleGetSummary(req, res, options, method),
  },
  {
    path: '/api/alerts',
    methods: ['GET'],
    auth: 'bearer',
    summary: 'Active sentry alerts.',
    operations: {
      GET: { responses: { 200: SentryAlertStateSchema } },
    },
    invoke: ({ req, res, options, method }) => handleGetAlerts(req, res, options, method),
  },
  {
    path: '/api/alerts/dismiss',
    methods: ['POST'],
    auth: 'bearer',
    summary: 'Dismiss the named alerts.',
    operations: {
      POST: {
        responses: {
          200: AlertDismissResponseSchema,
          500: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    invoke: ({ req, res, options, method }) => handleDismissAlerts(req, res, options, method),
  },
  {
    path: '/api/alerts/events',
    methods: ['GET'],
    auth: 'bearer',
    summary: 'Keyset-paginated alert history.',
    operations: {
      GET: {
        request: { query: AlertEventsQuerySchema },
        responses: {
          200: AlertEventPageSchema,
          500: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    invoke: ({ req, res, options, url, method }) =>
      handleGetAlertEvents(req, res, options, url, method),
  },
  {
    path: '/api/logs',
    methods: ['GET'],
    auth: 'bearer',
    summary: 'Recent log lines, filtered by level and cursor.',
    operations: {
      GET: {
        request: { query: LogsQuerySchema },
        responses: { 200: LogsResponseSchema },
      },
    },
    invoke: ({ req, res, options, url, method }) => handleGetLogs(req, res, options, url, method),
  },
  {
    path: '/api/config',
    methods: ['GET', 'POST'],
    auth: 'bearer',
    summary: 'Resolved configuration, or a validated override write.',
    operations: {
      GET: { responses: { 200: ConfigViewSchema } },
      POST: {
        request: { body: ConfigUpdateRequestSchema },
        responses: { 200: ConfigUpdateResponseSchema, 400: ErrorResponseSchema },
      },
    },
    invoke: ({ req, res, options, method }) => handleConfigEndpoint(req, res, options, method),
  },
  {
    path: '/api/config/{key}',
    methods: ['DELETE'],
    auth: 'bearer',
    summary: 'Clear one stored override.',
    operations: {
      DELETE: {
        responses: { 200: ConfigDeleteResponseSchema, 400: ErrorResponseSchema },
      },
    },
    invoke: ({ req, res, options, pathname, method }) =>
      handleDeleteConfigOverride(req, res, options, pathname, method),
  },
  {
    path: '/api/notify/test',
    methods: ['POST'],
    auth: 'bearer',
    summary: 'Send a test notification to one destination.',
    operations: {
      POST: {
        request: { body: NotifyTestRequestSchema },
        responses: {
          200: NotifyTestResponseSchema,
          400: NotifyTestResponseSchema,
          500: NotifyTestErrorResponseSchema,
        },
      },
    },
    invoke: ({ req, res, options, method }) => handleTestNotify(req, res, options, method),
  },
  {
    path: '/api/dispatch',
    methods: ['POST'],
    auth: 'bearer',
    summary: 'Queue a task.',
    operations: {
      POST: {
        request: { body: DispatchRequestSchema },
        responses: {
          200: DispatchResponseSchema,
          400: DispatchResponseSchema,
          409: DispatchResponseSchema,
        },
      },
    },
    invoke: ({ req, res, options, method }) => handlePostDispatch(req, res, options, method),
  },
  {
    path: '/api/models',
    methods: ['GET'],
    auth: 'bearer',
    summary: 'The model catalog with effort variants.',
    operations: {
      GET: { responses: { 200: ModelCatalogSchema } },
    },
    invoke: ({ req, res, options, method }) => handleGetModels(req, res, options, method),
  },
  {
    path: '/api/dispatch/eligibility',
    methods: ['GET'],
    auth: 'bearer',
    summary: 'Whether a dispatch would clear the safety floor.',
    operations: {
      GET: {
        request: { query: DispatchEligibilityQuerySchema },
        responses: {
          200: DispatchEligibilitySchema,
          500: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    invoke: ({ req, res, options, url, method }) =>
      handleDispatchEligibility(req, res, options, url, method),
  },
  {
    path: '/api/tasks',
    methods: ['GET'],
    auth: 'bearer',
    summary: 'Task list, filtered and paginated.',
    operations: {
      GET: {
        request: { query: TaskListQuerySchema },
        responses: { 200: TaskListResponseSchema, 400: ErrorResponseSchema },
      },
    },
    invoke: ({ req, res, options, url, method }) => handleGetTasks(req, res, options, url, method),
  },
  {
    path: '/api/tasks/poll',
    methods: ['POST'],
    auth: 'runner',
    summary: 'Runner long-poll that leases the next task.',
    operations: {
      POST: {
        request: { body: PollRequestSchema, bodyOptional: true },
        responses: { 200: PollResponseSchema, 400: ErrorResponseSchema, 401: ErrorResponseSchema },
      },
    },
    invoke: ({ req, res, options, method, shutdownSignal }) =>
      handlePollTasks(req, res, options, method, shutdownSignal),
  },
  {
    path: '/api/runner/heartbeat',
    methods: ['POST'],
    auth: 'runner',
    summary: 'Runner heartbeat carrying the live output tail.',
    operations: {
      POST: {
        request: { body: RunnerHeartbeatRequestSchema, bodyOptional: true },
        responses: {
          200: RunnerHeartbeatResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: RunnerHeartbeatResponseSchema,
        },
      },
    },
    invoke: ({ req, res, options, method }) => handleRunnerHeartbeat(req, res, options, method),
  },
  {
    path: '/api/tasks/{id}/status',
    methods: ['POST'],
    auth: 'runner',
    summary: 'Runner status report for the task it leased.',
    operations: {
      POST: {
        request: { body: TaskStatusRequestSchema },
        responses: {
          200: TaskMutationResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: TaskConflictResponseSchema,
        },
      },
    },
    invoke: ({ req, res, options, pathname, method }) =>
      handleTaskStatus(req, res, options, pathname, method),
  },
  {
    path: '/api/tasks/{id}/cancel',
    methods: ['POST'],
    auth: 'bearer',
    summary: 'Abort a task.',
    operations: {
      POST: {
        responses: {
          200: TaskMutationResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: TaskConflictResponseSchema,
        },
      },
    },
    invoke: ({ req, res, options, pathname, method }) =>
      handleTaskCancel(req, res, options, pathname, method),
  },
  {
    path: '/api/tasks/{id}/retry',
    methods: ['POST'],
    auth: 'bearer',
    summary: 'Queue another run of a finished task.',
    operations: {
      POST: {
        responses: {
          200: DispatchResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: TaskConflictResponseSchema,
        },
      },
    },
    invoke: ({ req, res, options, pathname, method }) =>
      handleTaskRetry(req, res, options, pathname, method),
  },
  {
    path: '/api/tasks/{id}',
    methods: ['GET'],
    auth: 'bearer',
    summary: 'One task, including its output and a change fingerprint.',
    operations: {
      GET: {
        responses: { 200: TaskDetailResponseSchema, 404: ErrorResponseSchema },
      },
    },
    invoke: ({ req, res, options, pathname, method }) =>
      handleGetTaskById(req, res, options, pathname, method),
  },
  {
    path: '/api/backlog/sync-github',
    methods: ['POST'],
    auth: 'bearer',
    summary: 'Import labelled GitHub issues as backlog items.',
    operations: {
      POST: { responses: { 200: BacklogSyncResponseSchema } },
    },
    invoke: ({ req, res, options, method }) => handleSyncGithubBacklog(req, res, options, method),
  },
  {
    path: '/api/backlog/bulk',
    methods: ['POST', 'PATCH'],
    auth: 'bearer',
    summary: 'Bulk pause, resume or delete backlog items.',
    operations: {
      POST: {
        request: { body: BacklogBulkRequestSchema },
        responses: { 200: BacklogBulkResponseSchema, 400: ErrorResponseSchema },
      },
      PATCH: {
        request: { body: BacklogBulkRequestSchema },
        responses: { 200: BacklogBulkResponseSchema, 400: ErrorResponseSchema },
      },
    },
    invoke: ({ req, res, options, method }) => handleBulkBacklogTasks(req, res, options, method),
  },
  {
    path: '/api/backlog',
    methods: ['GET', 'POST'],
    auth: 'bearer',
    summary: 'Backlog list, or a new backlog item.',
    operations: {
      GET: {
        request: { query: BacklogListQuerySchema },
        responses: { 200: BacklogListResponseSchema, 400: ErrorResponseSchema },
      },
      POST: {
        request: { body: BacklogCreateRequestSchema },
        responses: { 201: BacklogTaskSchema, 400: ErrorResponseSchema },
      },
    },
    invoke: ({ req, res, options, url, method }) =>
      handleBacklogTasks(req, res, options, url, method),
  },
  {
    path: '/api/backlog/{id}/dispatch',
    methods: ['POST'],
    auth: 'bearer',
    summary: 'Queue a run for a backlog item.',
    operations: {
      POST: {
        responses: {
          200: DispatchResultSchema,
          400: DispatchResultSchema,
          404: ErrorResponseSchema,
          409: DispatchResultSchema,
        },
      },
    },
    invoke: ({ req, res, options, pathname, method }) =>
      handleBacklogTaskById(req, res, options, pathname, method),
  },
  {
    path: '/api/backlog/{id}',
    methods: ['GET', 'PATCH', 'DELETE'],
    auth: 'bearer',
    summary: 'One backlog item: read, edit or delete.',
    operations: {
      GET: {
        responses: { 200: BacklogTaskSchema, 404: ErrorResponseSchema },
      },
      PATCH: {
        request: { body: BacklogPatchRequestSchema },
        responses: {
          200: BacklogTaskSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
      DELETE: {
        responses: {
          200: BacklogDeleteResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    invoke: ({ req, res, options, pathname, method }) =>
      handleBacklogTaskById(req, res, options, pathname, method),
  },
  {
    path: '/api/routines',
    methods: ['GET', 'POST'],
    auth: 'bearer',
    summary: 'Routine templates, or a new routine.',
    operations: {
      GET: { responses: { 200: RoutineListResponseSchema } },
      POST: {
        request: { body: RoutineCreateRequestSchema },
        responses: { 201: RoutineTaskSchema, 400: ErrorResponseSchema },
      },
    },
    invoke: ({ req, res, options, url, method }) =>
      handleRoutineTasks(req, res, options, url, method),
  },
  {
    path: '/api/routines/{id}/trigger',
    methods: ['POST'],
    auth: 'bearer',
    summary: 'Queue a routine run now.',
    operations: {
      POST: {
        responses: {
          200: RoutineTriggerResponseSchema,
          400: RoutineTriggerResponseSchema,
          404: ErrorResponseSchema,
          409: RoutineTriggerResponseSchema,
        },
      },
    },
    invoke: ({ req, res, options, pathname, method }) =>
      handleRoutineTaskById(req, res, options, pathname, method),
  },
  {
    path: '/api/routines/{id}',
    methods: ['GET', 'PATCH', 'DELETE'],
    auth: 'bearer',
    summary: 'One routine template: read, edit or delete.',
    operations: {
      GET: { responses: { 200: RoutineTaskSchema, 404: ErrorResponseSchema } },
      PATCH: {
        request: { body: RoutinePatchRequestSchema },
        responses: {
          200: RoutineTaskSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
      DELETE: {
        responses: { 200: RoutineDeleteResponseSchema, 404: ErrorResponseSchema },
      },
    },
    invoke: ({ req, res, options, pathname, method }) =>
      handleRoutineTaskById(req, res, options, pathname, method),
  },
  {
    path: '/api/runners/registration-token',
    methods: ['POST'],
    auth: 'bearer',
    summary: 'Mint a one-time runner registration token.',
    operations: {
      POST: {
        request: { body: RegistrationTokenRequestSchema, bodyOptional: true },
        responses: { 200: RegistrationTokenResponseSchema, 400: ErrorResponseSchema },
      },
    },
    invoke: ({ req, res, options, method }) =>
      handleCreateRegistrationToken(req, res, options, method),
  },
  {
    path: '/api/runners/register',
    methods: ['POST'],
    auth: 'runner',
    summary: 'Exchange a registration token for a runner credential.',
    operations: {
      POST: {
        request: { body: RunnerRegisterRequestSchema },
        responses: {
          200: RunnerRegisterResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    invoke: ({ req, res, options, method }) => handleRegisterRunner(req, res, options, method),
  },
  {
    path: '/api/runners',
    methods: ['GET'],
    auth: 'bearer',
    summary: 'Registered runners and their leases.',
    operations: {
      GET: { responses: { 200: RunnersResponseSchema } },
    },
    invoke: ({ req, res, options, method }) => handleGetRunners(req, res, options, method),
  },
  {
    path: '/api/runners/{id}',
    methods: ['PATCH', 'DELETE'],
    auth: 'bearer',
    summary: 'One runner: enable, disable or revoke.',
    operations: {
      PATCH: {
        request: { body: RunnerPatchRequestSchema },
        responses: {
          200: RunnerPatchResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
      DELETE: {
        responses: { 200: RunnerRevokeResponseSchema, 404: ErrorResponseSchema },
      },
    },
    invoke: ({ req, res, options, pathname, method }) =>
      handleManageRunnerById(req, res, options, pathname, method),
  },
];

export const matchRoute = (
  pathname: string
): { route: RouteSpec; params: Record<string, string> } | undefined => {
  for (const route of ROUTES) {
    const params = pathMatches(route.path, pathname);
    if (params) return { route, params };
  }
  return undefined;
};

/** Runner-token routes keep their own brute-force bucket, so the split has one declaration. */
export const routeAuthFor = (pathname: string): RouteAuth => {
  const matched = matchRoute(pathname);
  if (matched) return matched.route.auth;
  // An unregistered path keeps the control-plane gate it had before the registry existed.
  return pathname.startsWith('/api/') ? 'bearer' : 'public';
};
