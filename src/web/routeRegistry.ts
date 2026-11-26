import type http from 'node:http';
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

export interface RouteSpec {
  path: string;
  methods: readonly string[];
  auth: RouteAuth;
  summary: string;
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
    invoke: ({ req, res, options, method }) => handleGetQuota(req, res, options, method),
  },
  {
    path: '/api/summary',
    methods: ['GET'],
    auth: 'bearer',
    summary: 'Headroom percentage per pool group plus the cached agy version.',
    invoke: ({ req, res, options, method }) => handleGetSummary(req, res, options, method),
  },
  {
    path: '/api/alerts',
    methods: ['GET'],
    auth: 'bearer',
    summary: 'Active sentry alerts.',
    invoke: ({ req, res, options, method }) => handleGetAlerts(req, res, options, method),
  },
  {
    path: '/api/alerts/dismiss',
    methods: ['POST'],
    auth: 'bearer',
    summary: 'Dismiss the named alerts.',
    invoke: ({ req, res, options, method }) => handleDismissAlerts(req, res, options, method),
  },
  {
    path: '/api/alerts/events',
    methods: ['GET'],
    auth: 'bearer',
    summary: 'Keyset-paginated alert history.',
    invoke: ({ req, res, options, url, method }) =>
      handleGetAlertEvents(req, res, options, url, method),
  },
  {
    path: '/api/logs',
    methods: ['GET'],
    auth: 'bearer',
    summary: 'Recent log lines, filtered by level and cursor.',
    invoke: ({ req, res, options, url, method }) => handleGetLogs(req, res, options, url, method),
  },
  {
    path: '/api/config',
    methods: ['GET', 'POST'],
    auth: 'bearer',
    summary: 'Resolved configuration, or a validated override write.',
    invoke: ({ req, res, options, method }) => handleConfigEndpoint(req, res, options, method),
  },
  {
    path: '/api/config/{key}',
    methods: ['DELETE'],
    auth: 'bearer',
    summary: 'Clear one stored override.',
    invoke: ({ req, res, options, pathname, method }) =>
      handleDeleteConfigOverride(req, res, options, pathname, method),
  },
  {
    path: '/api/notify/test',
    methods: ['POST'],
    auth: 'bearer',
    summary: 'Send a test notification to one destination.',
    invoke: ({ req, res, options, method }) => handleTestNotify(req, res, options, method),
  },
  {
    path: '/api/dispatch',
    methods: ['POST'],
    auth: 'bearer',
    summary: 'Queue a task.',
    invoke: ({ req, res, options, method }) => handlePostDispatch(req, res, options, method),
  },
  {
    path: '/api/models',
    methods: ['GET'],
    auth: 'bearer',
    summary: 'The model catalog with effort variants.',
    invoke: ({ req, res, options, method }) => handleGetModels(req, res, options, method),
  },
  {
    path: '/api/dispatch/eligibility',
    methods: ['GET'],
    auth: 'bearer',
    summary: 'Whether a dispatch would clear the safety floor.',
    invoke: ({ req, res, options, url, method }) =>
      handleDispatchEligibility(req, res, options, url, method),
  },
  {
    path: '/api/tasks',
    methods: ['GET'],
    auth: 'bearer',
    summary: 'Task list, filtered and paginated.',
    invoke: ({ req, res, options, url, method }) => handleGetTasks(req, res, options, url, method),
  },
  {
    path: '/api/tasks/poll',
    methods: ['POST'],
    auth: 'runner',
    summary: 'Runner long-poll that leases the next task.',
    invoke: ({ req, res, options, method, shutdownSignal }) =>
      handlePollTasks(req, res, options, method, shutdownSignal),
  },
  {
    path: '/api/runner/heartbeat',
    methods: ['POST'],
    auth: 'runner',
    summary: 'Runner heartbeat carrying the live output tail.',
    invoke: ({ req, res, options, method }) => handleRunnerHeartbeat(req, res, options, method),
  },
  {
    path: '/api/tasks/{id}/status',
    methods: ['POST'],
    auth: 'runner',
    summary: 'Runner status report for the task it leased.',
    invoke: ({ req, res, options, pathname, method }) =>
      handleTaskStatus(req, res, options, pathname, method),
  },
  {
    path: '/api/tasks/{id}/cancel',
    methods: ['POST'],
    auth: 'bearer',
    summary: 'Abort a task.',
    invoke: ({ req, res, options, pathname, method }) =>
      handleTaskCancel(req, res, options, pathname, method),
  },
  {
    path: '/api/tasks/{id}/retry',
    methods: ['POST'],
    auth: 'bearer',
    summary: 'Queue another run of a finished task.',
    invoke: ({ req, res, options, pathname, method }) =>
      handleTaskRetry(req, res, options, pathname, method),
  },
  {
    path: '/api/tasks/{id}',
    methods: ['GET'],
    auth: 'bearer',
    summary: 'One task, including its output and a change fingerprint.',
    invoke: ({ req, res, options, pathname, method }) =>
      handleGetTaskById(req, res, options, pathname, method),
  },
  {
    path: '/api/backlog/sync-github',
    methods: ['POST'],
    auth: 'bearer',
    summary: 'Import labelled GitHub issues as backlog items.',
    invoke: ({ req, res, options, method }) => handleSyncGithubBacklog(req, res, options, method),
  },
  {
    path: '/api/backlog/bulk',
    methods: ['POST', 'PATCH'],
    auth: 'bearer',
    summary: 'Bulk pause, resume or delete backlog items.',
    invoke: ({ req, res, options, method }) => handleBulkBacklogTasks(req, res, options, method),
  },
  {
    path: '/api/backlog',
    methods: ['GET', 'POST'],
    auth: 'bearer',
    summary: 'Backlog list, or a new backlog item.',
    invoke: ({ req, res, options, url, method }) =>
      handleBacklogTasks(req, res, options, url, method),
  },
  {
    path: '/api/backlog/{id}/dispatch',
    methods: ['POST'],
    auth: 'bearer',
    summary: 'Queue a run for a backlog item.',
    invoke: ({ req, res, options, pathname, method }) =>
      handleBacklogTaskById(req, res, options, pathname, method),
  },
  {
    path: '/api/backlog/{id}',
    methods: ['GET', 'PATCH', 'DELETE'],
    auth: 'bearer',
    summary: 'One backlog item: read, edit or delete.',
    invoke: ({ req, res, options, pathname, method }) =>
      handleBacklogTaskById(req, res, options, pathname, method),
  },
  {
    path: '/api/routines',
    methods: ['GET', 'POST'],
    auth: 'bearer',
    summary: 'Routine templates, or a new routine.',
    invoke: ({ req, res, options, url, method }) =>
      handleRoutineTasks(req, res, options, url, method),
  },
  {
    path: '/api/routines/{id}/trigger',
    methods: ['POST'],
    auth: 'bearer',
    summary: 'Queue a routine run now.',
    invoke: ({ req, res, options, pathname, method }) =>
      handleRoutineTaskById(req, res, options, pathname, method),
  },
  {
    path: '/api/routines/{id}',
    methods: ['GET', 'PATCH', 'DELETE'],
    auth: 'bearer',
    summary: 'One routine template: read, edit or delete.',
    invoke: ({ req, res, options, pathname, method }) =>
      handleRoutineTaskById(req, res, options, pathname, method),
  },
  {
    path: '/api/runners/registration-token',
    methods: ['POST'],
    auth: 'bearer',
    summary: 'Mint a one-time runner registration token.',
    invoke: ({ req, res, options, method }) =>
      handleCreateRegistrationToken(req, res, options, method),
  },
  {
    path: '/api/runners/register',
    methods: ['POST'],
    auth: 'runner',
    summary: 'Exchange a registration token for a runner credential.',
    invoke: ({ req, res, options, method }) => handleRegisterRunner(req, res, options, method),
  },
  {
    path: '/api/runners',
    methods: ['GET'],
    auth: 'bearer',
    summary: 'Registered runners and their leases.',
    invoke: ({ req, res, options, method }) => handleGetRunners(req, res, options, method),
  },
  {
    path: '/api/runners/{id}',
    methods: ['PATCH', 'DELETE'],
    auth: 'bearer',
    summary: 'One runner: enable, disable or revoke.',
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
