import type http from 'node:http';
import {
  sendJson,
  methodNotAllowed,
  readJsonBody,
  toStringOrUndefined,
  toTrimmedStringOrUndefined,
  toStringArray,
  toFiniteNumberOrUndefined,
} from '../http.js';
import type { WebServerOptions } from '../types.js';
import { logger } from '../../logs/logger.js';
import { BUILTIN_DEFAULTS } from '../../config/schema.js';
import { OrchestratorCoordinator } from '../../orchestrator/coordinator.js';
import {
  annotateModelsWithQuota,
  ReasoningEffortSchema,
  ScheduleModeSchema,
  TaskStatusSchema,
  type ReasoningEffort,
  type ScheduleMode,
  type TaskStatus,
} from '../../orchestrator/models.js';

const coordinatorCache = new WeakMap<WebServerOptions, OrchestratorCoordinator>();

export const resolveOrchestrator = (options: WebServerOptions): OrchestratorCoordinator => {
  if (options.orchestrator) {
    return options.orchestrator;
  }
  let cached = coordinatorCache.get(options);
  if (!cached) {
    cached = new OrchestratorCoordinator({
      configStore: options.configStore,
      sentryState: options.sentryState,
      notifier: options.notifier,
      logger: options.logger ? options.logger.child('orchestrator') : logger.child('orchestrator'),
    });
    coordinatorCache.set(options, cached);
  }
  return cached;
};

const extractRunnerToken = (req: http.IncomingMessage): string | undefined => {
  const headerToken = req.headers['x-agylity-worker-token'];
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
  const orchestrator = resolveOrchestrator(options);
  const limit = Number(url.searchParams.get('limit') ?? 50);
  const tasks = orchestrator.queue.listTasks({
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
  const orchestrator = resolveOrchestrator(options);

  let pools = orchestrator.getActivePools();
  if (pools.length === 0 && options.quotaClient) {
    try {
      pools = await options.quotaClient.fetchQuota(false);
    } catch {
      pools = [];
    }
  }

  const models = annotateModelsWithQuota(pools, resolved.minDispatchHeadroomPercent ?? 10);
  return sendJson(
    res,
    200,
    {
      defaultModel: resolved.defaultDispatchModel || BUILTIN_DEFAULTS.defaultDispatchModel,
      defaultEffort: resolved.defaultDispatchEffort || BUILTIN_DEFAULTS.defaultDispatchEffort,
      models,
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

  if (!payload || typeof payload !== 'object' || !payload.repositoryName) {
    return sendJson(res, 400, { error: 'repositoryName is required' });
  }

  const repositoryName = String(payload.repositoryName).trim();
  if (!repositoryName) {
    return sendJson(res, 400, { error: 'repositoryName is required' });
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

  const orchestrator = resolveOrchestrator(options);
  const result = await orchestrator.dispatch({
    repositoryId: toStringOrUndefined(payload.repositoryId),
    repositoryName,
    repositoryPath: toStringOrUndefined(payload.repositoryPath),
    cloneUrl: typeof payload.cloneUrl === 'string' ? payload.cloneUrl.trim() : undefined,
    prompt,
    requestedBy: toStringOrUndefined(payload.requestedBy) ?? 'web-ui',
    scheduleMode,
    requiredLabels,
    model: toStringOrUndefined(payload.model),
    effort,
    allowOverage: Boolean(payload.allowOverage),
    pushBranch: typeof payload.pushBranch === 'boolean' ? payload.pushBranch : true,
    autoCreatePr: typeof payload.autoCreatePr === 'boolean' ? payload.autoCreatePr : true,
    expiresAt: toStringOrUndefined(payload.expiresAt),
    standingTaskId: toStringOrUndefined(payload.standingTaskId),
    verifyCommand: toStringOrUndefined(payload.verifyCommand),
  });

  if (!result.success && result.code === 'OVERAGE_PROTECTION_TRIGGERED') {
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
  const orchestrator = resolveOrchestrator(options);
  const limit = Number(url.searchParams.get('limit') ?? 50);
  const statusParam = url.searchParams.get('status') ?? undefined;
  const parsedStatus = statusParam ? TaskStatusSchema.safeParse(statusParam) : undefined;

  const tasks = orchestrator.queue.listTasks({
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
  const orchestrator = resolveOrchestrator(options);
  const auth = orchestrator.authenticateRunner(extractRunnerToken(req));
  if (!auth.authenticated) {
    return sendJson(res, 401, { error: 'Unauthorized runner token' });
  }

  if (!resolved.orchestratorEnabled) {
    return sendJson(res, 200, { task: null, orchestratorEnabled: false });
  }

  const parsed = await readJsonBody(req, res, { emptyBody: 'allow' });
  if (!parsed.ok) return;
  const payload: any = parsed.body;

  // If authenticated via a per-runner token, bind identity strictly to the registered worker record
  const workerId =
    auth.worker?.workerId ?? toTrimmedStringOrUndefined(payload?.workerId) ?? 'worker-default';
  const workerName =
    auth.worker?.name ?? toTrimmedStringOrUndefined(payload?.workerName) ?? workerId;
  const labels = toStringArray(payload?.labels) ?? auth.worker?.labels;
  const repositories = toStringArray(payload?.repositories) ?? auth.worker?.repositories;
  const systemInfo =
    payload?.systemInfo && typeof payload.systemInfo === 'object' ? payload.systemInfo : undefined;
  const timeoutMs = toFiniteNumberOrUndefined(payload?.timeoutMs) ?? 0;

  const abortController = new AbortController();
  const onClose = () => abortController.abort();
  req.once('close', onClose);

  try {
    const task = await orchestrator.pollForTask(
      {
        workerId,
        workerName,
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

  const orchestrator = resolveOrchestrator(options);
  const auth = orchestrator.authenticateRunner(extractRunnerToken(req));
  if (!auth.authenticated) {
    return sendJson(res, 401, { error: 'Unauthorized runner token' });
  }

  const match = /^\/api\/tasks\/([^/]+)\/status$/.exec(pathname);
  const taskId = match?.[1] ? decodeURIComponent(match[1]) : '';
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

  const result = await orchestrator.reportTaskStatus(taskId, {
    status: statusParse.data as TaskStatus,
    workerId: auth.worker?.workerId ?? toStringOrUndefined(payload.workerId),
    branchName: toStringOrUndefined(payload.branchName),
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

export const handleTaskCancel = (
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  pathname: string,
  method: string
): void => {
  if (method !== 'POST') return methodNotAllowed(res);
  const match = /^\/api\/tasks\/([^/]+)\/cancel$/.exec(pathname);
  const taskId = match?.[1] ? decodeURIComponent(match[1]) : '';
  if (!taskId) return sendJson(res, 400, { error: 'taskId is required' });

  const orchestrator = resolveOrchestrator(options);
  const task = orchestrator.queue.getTask(taskId);
  if (!task) return sendJson(res, 404, { error: `Task ${taskId} not found` });

  const updated = orchestrator.queue.updateTaskStatus(taskId, {
    status: 'aborted',
    error: 'Task aborted by user',
  });
  return sendJson(res, 200, { success: true, task: updated?.task });
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
  const taskId = match?.[1] ? decodeURIComponent(match[1]) : '';
  if (!taskId) return sendJson(res, 400, { error: 'taskId is required' });

  const orchestrator = resolveOrchestrator(options);
  const task = orchestrator.queue.getTask(taskId);
  if (!task) return sendJson(res, 404, { error: `Task ${taskId} not found` });

  const retryRes = await orchestrator.dispatch({
    repositoryId: task.repositoryId,
    repositoryName: task.repositoryName,
    repositoryPath: task.repositoryPath,
    cloneUrl: task.cloneUrl,
    prompt: task.prompt,
    requestedBy: 'web-ui (retry)',
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

export const handleStandingTasks = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  _url: URL,
  method: string
): Promise<void> => {
  const orchestrator = resolveOrchestrator(options);

  if (method === 'GET') {
    const list = orchestrator.queue.listStandingTasks();
    return sendJson(res, 200, list, { 'Cache-Control': 'no-store' });
  }

  if (method === 'POST') {
    const parsed = await readJsonBody(req, res, { emptyBody: 'malformed' });
    if (!parsed.ok) return;
    const payload: any = parsed.body;
    if (!payload?.title || !payload?.prompt || !payload?.repositoryId || !payload?.model) {
      return sendJson(res, 400, {
        error: 'title, prompt, repositoryId, and model are required for standing task',
      });
    }
    const created = orchestrator.queue.createStandingTask(payload);
    return sendJson(res, 201, created);
  }

  return methodNotAllowed(res);
};

export const handleStandingTaskById = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  pathname: string,
  method: string
): Promise<void> => {
  const match = /^\/api\/standing-tasks\/([^/]+)(?:\/(trigger))?$/.exec(pathname);
  const id = match?.[1] ? decodeURIComponent(match[1]) : '';
  const action = match?.[2];
  if (!id) return sendJson(res, 400, { error: 'id is required' });

  const orchestrator = resolveOrchestrator(options);

  if (action === 'trigger' && method === 'POST') {
    const st = orchestrator.queue.getStandingTask(id);
    if (!st) return sendJson(res, 404, { error: `Standing task ${id} not found` });
    const dispatchRes = await orchestrator.dispatch({
      repositoryId: st.repositoryId,
      repositoryName: st.repositoryId,
      prompt: st.prompt,
      model: st.model,
      effort: st.effort,
      autoCreatePr: st.autoCreatePr,
      verifyCommand: st.verifyCommand,
      standingTaskId: st.id,
      scheduleMode: 'immediate',
    });
    return sendJson(res, 200, dispatchRes);
  }

  if (method === 'PATCH') {
    const parsed = await readJsonBody(req, res, { emptyBody: 'malformed' });
    if (!parsed.ok) return;
    const patch: any = parsed.body;
    const updated = orchestrator.queue.updateStandingTask(id, patch);
    if (!updated) return sendJson(res, 404, { error: `Standing task ${id} not found` });
    return sendJson(res, 200, updated);
  }

  if (method === 'DELETE') {
    const deleted = orchestrator.queue.deleteStandingTask(id);
    if (!deleted) return sendJson(res, 404, { error: `Standing task ${id} not found` });
    return sendJson(res, 200, { success: true, deleted: true });
  }

  return methodNotAllowed(res);
};

export const handleGetWorkers = (
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  method: string
): void => {
  if (method !== 'GET') return methodNotAllowed(res);
  const orchestrator = resolveOrchestrator(options);
  const workers = orchestrator.listWorkers();
  return sendJson(res, 200, workers, { 'Cache-Control': 'no-store' });
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

  const orchestrator = resolveOrchestrator(options);
  const result = orchestrator.createRegistrationToken({
    nameHint,
    labels,
    repositories,
    ttlMs,
  });

  return sendJson(res, 200, result, { 'Cache-Control': 'no-store' });
};

export const handleRegisterWorker = async (
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

  const orchestrator = resolveOrchestrator(options);
  try {
    const registered = orchestrator.registerRunner({
      registrationToken,
      workerId: toStringOrUndefined(payload?.workerId),
      workerName: toStringOrUndefined(payload?.workerName),
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
        worker: registered.worker,
        runnerToken: registered.runnerToken,
      },
      { 'Cache-Control': 'no-store' }
    );
  } catch (err: any) {
    return sendJson(res, 401, {
      error: err?.message || 'Invalid, expired, or already-consumed registration token',
    });
  }
};

export const handleManageWorkerById = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  pathname: string,
  method: string
): Promise<void> => {
  const match = /^\/api\/workers\/([^/]+)$/.exec(pathname);
  const workerId = match?.[1] ? decodeURIComponent(match[1]).trim() : '';
  if (!workerId) {
    return sendJson(res, 400, { error: 'workerId is required' });
  }

  const orchestrator = resolveOrchestrator(options);

  if (method === 'DELETE') {
    const revoked = orchestrator.revokeWorker(workerId);
    if (!revoked) {
      return sendJson(res, 404, { error: `Runner ${workerId} not found` });
    }
    return sendJson(res, 200, { success: true, revoked: true, workerId });
  }

  if (method === 'PATCH') {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return;
    const payload: any = parsed.body;

    if (typeof payload?.enabled !== 'boolean') {
      return sendJson(res, 400, { error: 'enabled (boolean) is required' });
    }

    const updated = orchestrator.setWorkerEnabled(workerId, payload.enabled);
    if (!updated) {
      return sendJson(res, 404, { error: `Runner ${workerId} not found` });
    }
    return sendJson(res, 200, { success: true, worker: updated });
  }

  return methodNotAllowed(res);
};
