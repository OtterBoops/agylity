import type http from 'node:http';
import {
  sendJson,
  methodNotAllowed,
  readJsonBody,
  toStringOrUndefined,
  toTrimmedStringOrUndefined,
  toStringArray,
  toFiniteNumberOrUndefined,
  safeDecodeSegment,
  isSafetyBlockCode,
} from '../http.js';
import type { WebServerOptions } from '../types.js';
import { logger } from '../../logs/logger.js';
import { BUILTIN_DEFAULTS } from '../../config/schema.js';
import { Coordinator } from '../../coordinator/coordinator.js';
import { RegistrationTokenError } from '../../coordinator/queue.js';
import {
  annotateModelsWithQuota,
  CANONICAL_AGY_MODELS,
  isTerminalTaskStatus,
  ReasoningEffortSchema,
  ScheduleModeSchema,
  TaskStatusSchema,
  type ReasoningEffort,
  type ScheduleMode,
  type TaskStatus,
} from '../../coordinator/models.js';

const coordinatorCache = new WeakMap<WebServerOptions, Coordinator>();

export const resolveCoordinator = (options: WebServerOptions): Coordinator => {
  if (options.coordinator) {
    return options.coordinator;
  }
  let cached = coordinatorCache.get(options);
  if (!cached) {
    cached = new Coordinator({
      configStore: options.configStore,
      sentryState: options.sentryState,
      notifier: options.notifier,
      logger: options.logger ? options.logger.child('coordinator') : logger.child('coordinator'),
    });
    coordinatorCache.set(options, cached);
  }
  return cached;
};

const extractRunnerToken = (req: http.IncomingMessage): string | undefined => {
  const headerToken = req.headers['x-agylity-runner-token'];
  if (typeof headerToken === 'string' && headerToken.trim() !== '') {
    return headerToken.trim();
  }
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token !== '') return token;
  }
  return undefined;
};

export const handleGetDispatches = (
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  url: URL,
  method: string
): void => {
  if (method !== 'GET') return methodNotAllowed(res);
  const coordinator = resolveCoordinator(options);
  const limit = Number(url.searchParams.get('limit') ?? 50);
  const tasks = coordinator.queue.listTasks({
    limit: Number.isFinite(limit) ? limit : 50,
  });
  const mapped = tasks.map((t) => ({
    ...t,
    repository: t.repositoryName,
    success: t.status === 'completed' || t.status === 'no_changes',
  }));
  return sendJson(res, 200, mapped, { 'Cache-Control': 'no-store' });
};

export const handleGetModels = async (
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  method: string
): Promise<void> => {
  if (method !== 'GET') return methodNotAllowed(res);
  const resolved = options.configStore.resolveConfig();
  const coordinator = resolveCoordinator(options);

  let pools = coordinator.getActivePools();
  if (pools.length === 0 && options.quotaClient) {
    try {
      pools = await options.quotaClient.fetchQuota(false);
    } catch {
      pools = [];
    }
  }

  // Non-blocking: the provider serves its cache and revalidates in the background, so an
  // offline or unauthenticated CLI never stalls this route.
  const catalog = options.modelCatalog?.getModels() ?? CANONICAL_AGY_MODELS;
  const models = annotateModelsWithQuota(
    pools,
    resolved.minDispatchHeadroomPercent ?? 10,
    Date.now(),
    catalog
  );
  return sendJson(
    res,
    200,
    {
      defaultModel: resolved.defaultDispatchModel || BUILTIN_DEFAULTS.defaultDispatchModel,
      defaultEffort: resolved.defaultDispatchEffort || BUILTIN_DEFAULTS.defaultDispatchEffort,
      models,
      unattributedModels: options.modelCatalog?.getUnattributedModels() ?? [],
    },
    { 'Cache-Control': 'no-store' }
  );
};

export const handlePostDispatch = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  method: string
): Promise<void> => {
  if (method !== 'POST') return methodNotAllowed(res);

  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return;
  const payload: any = parsed.body;

  if (!payload || typeof payload !== 'object' || !payload.repositoryId) {
    return sendJson(res, 400, { error: 'repositoryId is required' });
  }

  const repositoryId = String(payload.repositoryId).trim();
  if (!repositoryId) {
    return sendJson(res, 400, { error: 'repositoryId is required' });
  }

  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
  if (!prompt) {
    return sendJson(res, 400, { error: 'prompt is required' });
  }

  const scheduleModeParse = ScheduleModeSchema.safeParse(payload.scheduleMode ?? 'immediate');
  const scheduleMode: ScheduleMode = scheduleModeParse.success
    ? scheduleModeParse.data
    : 'immediate';

  const effortParse = ReasoningEffortSchema.safeParse(payload.effort ?? 'high');
  const effort: ReasoningEffort | undefined = payload.effort
    ? effortParse.success
      ? effortParse.data
      : undefined
    : undefined;

  const requiredLabels = toStringArray(payload.requiredLabels);

  const coordinator = resolveCoordinator(options);
  const result = await coordinator.dispatch({
    repositoryId,
    repositoryName: toStringOrUndefined(payload.repositoryName),
    repositoryPath: toStringOrUndefined(payload.repositoryPath),
    cloneUrl: typeof payload.cloneUrl === 'string' ? payload.cloneUrl.trim() : undefined,
    prompt,
    title: toStringOrUndefined(payload.title),
    tier: payload.tier === 'backlog' || payload.tier === 'routine' ? payload.tier : 'immediate',
    originId: toStringOrUndefined(payload.originId),
    originNumber: toFiniteNumberOrUndefined(payload.originNumber),
    originTitle: toStringOrUndefined(payload.originTitle),
    requestedBy: toStringOrUndefined(payload.requestedBy) ?? 'web-ui',
    actor: payload.actor === 'bot' || payload.actor === 'user' ? payload.actor : undefined,
    prPolicy:
      payload.prPolicy === 'docs_only' || payload.prPolicy === 'all' || payload.prPolicy === 'none'
        ? payload.prPolicy
        : undefined,
    scheduleMode,
    requiredLabels,
    model: toStringOrUndefined(payload.model),
    models: toStringArray(payload.models),
    effort,
    allowOverage: Boolean(payload.allowOverage),
    pushBranch: typeof payload.pushBranch === 'boolean' ? payload.pushBranch : true,
    autoCreatePr: typeof payload.autoCreatePr === 'boolean' ? payload.autoCreatePr : true,
    expiresAt: toStringOrUndefined(payload.expiresAt),
    standingTaskId: toStringOrUndefined(payload.standingTaskId),
    verifyCommand: toStringOrUndefined(payload.verifyCommand),
  });

  if (!result.success && isSafetyBlockCode(result.code)) {
    return sendJson(res, 400, result);
  }

  return sendJson(res, 200, result);
};

export const handleGetTasks = (
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  url: URL,
  method: string
): void => {
  if (method !== 'GET') return methodNotAllowed(res);
  const coordinator = resolveCoordinator(options);
  const limit = Number(url.searchParams.get('limit') ?? 50);
  const statusParam = url.searchParams.get('status') ?? undefined;
  const parsedStatus = statusParam ? TaskStatusSchema.safeParse(statusParam) : undefined;

  const tasks = coordinator.queue.listTasks({
    status: parsedStatus?.success ? parsedStatus.data : undefined,
    limit: Number.isFinite(limit) ? limit : 50,
  });

  return sendJson(res, 200, tasks, { 'Cache-Control': 'no-store' });
};

export const handlePollTasks = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  method: string
): Promise<void> => {
  if (method !== 'POST') return methodNotAllowed(res);

  const resolved = options.configStore.resolveConfig();
  const coordinator = resolveCoordinator(options);
  const auth = coordinator.authenticateRunner(extractRunnerToken(req));
  if (!auth.authenticated) {
    return sendJson(res, 401, { error: 'Unauthorized runner token' });
  }

  if (!resolved.coordinatorEnabled) {
    return sendJson(res, 200, { task: null, coordinatorEnabled: false });
  }

  const parsed = await readJsonBody(req, res, { emptyBody: 'allow' });
  if (!parsed.ok) return;
  const payload: any = parsed.body;

  // If authenticated via a per-runner token, bind identity strictly to the registered runner record
  const runnerId =
    auth.runner?.runnerId ?? toTrimmedStringOrUndefined(payload?.runnerId) ?? 'runner-default';
  const runnerName =
    auth.runner?.name ?? toTrimmedStringOrUndefined(payload?.runnerName) ?? runnerId;
  // A registered runner's scope comes from its registration, never from the poll payload.
  const labels = auth.runner ? auth.runner.labels : (toStringArray(payload?.labels) ?? []);
  const repositories = auth.runner
    ? auth.runner.repositories
    : (toStringArray(payload?.repositories) ?? []);
  const systemInfo =
    payload?.systemInfo && typeof payload.systemInfo === 'object' ? payload.systemInfo : undefined;
  const timeoutMs = toFiniteNumberOrUndefined(payload?.timeoutMs) ?? 0;

  const abortController = new AbortController();
  const onClose = () => abortController.abort();
  req.once('close', onClose);

  try {
    const task = await coordinator.pollForTask(
      {
        runnerId,
        runnerName,
        labels,
        repositories,
        systemInfo,
        timeoutMs,
      },
      abortController.signal
    );

    if (!res.writableEnded) {
      return sendJson(res, 200, { task }, { 'Cache-Control': 'no-store' });
    }
  } finally {
    req.off('close', onClose);
  }
};

export const handleTaskStatus = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  pathname: string,
  method: string
): Promise<void> => {
  if (method !== 'POST') return methodNotAllowed(res);

  const coordinator = resolveCoordinator(options);
  const auth = coordinator.authenticateRunner(extractRunnerToken(req));
  if (!auth.authenticated) {
    return sendJson(res, 401, { error: 'Unauthorized runner token' });
  }

  const match = /^\/api\/tasks\/([^/]+)\/status$/.exec(pathname);
  const taskId = match?.[1] ? safeDecodeSegment(match[1]) : '';
  if (!taskId) {
    return sendJson(res, 400, { error: 'taskId is required' });
  }

  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return;
  const payload: any = parsed.body;

  const statusParse = TaskStatusSchema.safeParse(payload?.status);
  if (!statusParse.success) {
    return sendJson(res, 400, { error: 'Valid status is required' });
  }

  const result = await coordinator.reportTaskStatus(taskId, {
    status: statusParse.data as TaskStatus,
    runnerId: auth.runner?.runnerId ?? toStringOrUndefined(payload.runnerId),
    branchName: toStringOrUndefined(payload.branchName),
    prUrl: toStringOrUndefined(payload.prUrl),
    output: toStringOrUndefined(payload.output),
    error: toStringOrUndefined(payload.error),
    durationMs: toFiniteNumberOrUndefined(payload.durationMs),
    numTurns: toFiniteNumberOrUndefined(payload.numTurns),
    totalTokens: toFiniteNumberOrUndefined(payload.totalTokens),
    thinkingTokens: toFiniteNumberOrUndefined(payload.thinkingTokens),
    message: toStringOrUndefined(payload.message),
  });

  if (!result) {
    return sendJson(res, 404, { error: `Task ${taskId} not found` });
  }

  if (!result.applied) {
    return sendJson(res, 409, {
      error: `Task ${taskId} status update refused; current status is ${result.task.status}`,
      status: result.task.status,
      task: result.task,
    });
  }

  // Relay runner status update into coordinator logs
  if (payload.message && typeof payload.message === 'string') {
    logger.child('runner').info('[%s] %s', taskId, payload.message);
  }

  return sendJson(res, 200, { success: true, task: result.task });
};

export const handleTaskCancel = async (
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  pathname: string,
  method: string
): Promise<void> => {
  if (method !== 'POST') return methodNotAllowed(res);
  const match = /^\/api\/tasks\/([^/]+)\/cancel$/.exec(pathname);
  const taskId = match?.[1] ? safeDecodeSegment(match[1]) : '';
  if (!taskId) return sendJson(res, 400, { error: 'taskId is required' });

  const coordinator = resolveCoordinator(options);
  const result = await coordinator.cancelTask(taskId);
  if (!result) return sendJson(res, 404, { error: `Task ${taskId} not found` });
  if (!result.applied) {
    return sendJson(res, 409, {
      error: `Task ${taskId} cannot be cancelled; current status is ${result.task.status}`,
      status: result.task.status,
      task: result.task,
    });
  }
  return sendJson(res, 200, { success: true, task: result.task });
};

export const handleTaskRetry = async (
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  pathname: string,
  method: string
): Promise<void> => {
  if (method !== 'POST') return methodNotAllowed(res);
  const match = /^\/api\/tasks\/([^/]+)\/retry$/.exec(pathname);
  const taskId = match?.[1] ? safeDecodeSegment(match[1]) : '';
  if (!taskId) return sendJson(res, 400, { error: 'taskId is required' });

  const coordinator = resolveCoordinator(options);
  const task = coordinator.queue.getTask(taskId);
  if (!task) return sendJson(res, 404, { error: `Task ${taskId} not found` });
  if (!isTerminalTaskStatus(task.status)) {
    return sendJson(res, 409, {
      error: `Task ${taskId} is still ${task.status}; only a finished task can be retried`,
      status: task.status,
    });
  }

  const retryRes = await coordinator.dispatch({
    repositoryId: task.repositoryId,
    repositoryName: task.repositoryName,
    repositoryPath: task.repositoryPath,
    cloneUrl: task.cloneUrl,
    prompt: task.prompt,
    title: task.title,
    tier: task.tier,
    originId: task.originId,
    originNumber: task.originNumber,
    originTitle: task.originTitle,
    requestedBy: 'web-ui (retry)',
    actor: task.actor,
    prPolicy: task.prPolicy,
    scheduleMode: task.scheduleMode,
    model: task.model,
    effort: task.effort,
    requiredLabels: task.requiredLabels,
    expiresAt: task.expiresAt,
    standingTaskId: task.standingTaskId,
    allowOverage: task.allowOverage,
    pushBranch: task.pushBranch,
    autoCreatePr: task.autoCreatePr,
    verifyCommand: task.verifyCommand,
  });

  return sendJson(res, 200, retryRes);
};

export const handleGetRunners = (
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  method: string
): void => {
  if (method !== 'GET') return methodNotAllowed(res);
  const coordinator = resolveCoordinator(options);
  const runners = coordinator.listRunners();
  return sendJson(res, 200, runners, { 'Cache-Control': 'no-store' });
};

export const handleCreateRegistrationToken = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  method: string
): Promise<void> => {
  if (method !== 'POST') return methodNotAllowed(res);

  const parsed = await readJsonBody(req, res, { emptyBody: 'allow' });
  if (!parsed.ok) return;
  const payload: any = parsed.body;

  const labels = toStringArray(payload?.labels) ?? [];
  const repositories = toStringArray(payload?.repositories) ?? [];
  const nameHint = toTrimmedStringOrUndefined(payload?.nameHint);
  const ttlMs = toFiniteNumberOrUndefined(payload?.ttlMs);

  const coordinator = resolveCoordinator(options);
  const result = coordinator.createRegistrationToken({
    nameHint,
    labels,
    repositories,
    ttlMs,
  });

  return sendJson(res, 200, result, { 'Cache-Control': 'no-store' });
};

export const handleRegisterRunner = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  method: string
): Promise<void> => {
  if (method !== 'POST') return methodNotAllowed(res);

  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return;
  const payload: any = parsed.body;

  const registrationToken =
    typeof payload?.registrationToken === 'string' ? payload.registrationToken.trim() : '';
  if (!registrationToken) {
    return sendJson(res, 400, { error: 'registrationToken is required' });
  }

  const labels = toStringArray(payload?.labels);
  const repositories = toStringArray(payload?.repositories);
  const systemInfo =
    payload?.systemInfo && typeof payload.systemInfo === 'object' ? payload.systemInfo : undefined;

  const coordinator = resolveCoordinator(options);
  try {
    const registered = coordinator.registerRunner({
      registrationToken,
      runnerId: toStringOrUndefined(payload?.runnerId),
      runnerName: toStringOrUndefined(payload?.runnerName),
      labels,
      repositories,
      systemInfo,
    });

    if (!registered) {
      return sendJson(res, 401, {
        error: 'Invalid, expired, or already-consumed registration token',
      });
    }

    return sendJson(
      res,
      200,
      {
        success: true,
        runner: registered.runner,
        runnerToken: registered.runnerToken,
      },
      { 'Cache-Control': 'no-store' }
    );
  } catch (err: any) {
    if (err instanceof RegistrationTokenError) {
      return sendJson(res, 401, { error: err.message });
    }
    // Anything else is an internal fault, not an auth failure, and its detail stays in the log.
    logger.child('web').error('Runner registration failed: %s', err?.stack ?? err);
    return sendJson(res, 500, { error: 'Runner registration failed' });
  }
};

export const handleManageRunnerById = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  pathname: string,
  method: string
): Promise<void> => {
  const match = /^\/api\/runners\/([^/]+)$/.exec(pathname);
  const runnerId = match?.[1] ? (safeDecodeSegment(match[1]) ?? '').trim() : '';
  if (!runnerId) {
    return sendJson(res, 400, { error: 'runnerId is required' });
  }

  const coordinator = resolveCoordinator(options);

  if (method === 'DELETE') {
    const revoked = coordinator.revokeRunner(runnerId);
    if (!revoked) {
      return sendJson(res, 404, { error: `Runner ${runnerId} not found` });
    }
    return sendJson(res, 200, { success: true, revoked: true, runnerId });
  }

  if (method === 'PATCH') {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return;
    const payload: any = parsed.body;

    if (typeof payload?.enabled !== 'boolean') {
      return sendJson(res, 400, { error: 'enabled (boolean) is required' });
    }

    const updated = coordinator.setRunnerEnabled(runnerId, payload.enabled);
    if (!updated) {
      return sendJson(res, 404, { error: `Runner ${runnerId} not found` });
    }
    return sendJson(res, 200, { success: true, runner: updated });
  }

  return methodNotAllowed(res);
};
