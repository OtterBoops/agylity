import type http from 'node:http';
import { sendJson, methodNotAllowed, readBody } from '../http.js';
import type { WebServerOptions } from '../types.js';
import { logger } from '../../logs/logger.js';
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
  req: http.IncomingMessage,
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
    success: t.status === 'completed',
  }));
  return sendJson(res, 200, mapped, { 'Cache-Control': 'no-store' });
};

export const handleGetModels = async (
  req: http.IncomingMessage,
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
      defaultModel: resolved.defaultDispatchModel || 'gemini-4-argon',
      defaultEffort: resolved.defaultDispatchEffort || 'high',
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

  const body = await readBody(req, res);
  if (!body.trim()) return sendJson(res, 400, { error: 'Request body cannot be empty' });

  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { error: 'Malformed JSON payload' });
  }

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

  const scheduleModeParse = ScheduleModeSchema.safeParse(
    payload.scheduleMode ?? (payload.priority === 'P2' ? 'pre_reset' : 'immediate')
  );
  const scheduleMode: ScheduleMode = scheduleModeParse.success
    ? scheduleModeParse.data
    : 'immediate';

  const effortParse = ReasoningEffortSchema.safeParse(payload.effort ?? 'high');
  const effort: ReasoningEffort | undefined = payload.effort
    ? effortParse.success
      ? effortParse.data
      : undefined
    : undefined;

  const requiredLabels = Array.isArray(payload.requiredLabels)
    ? payload.requiredLabels.map((l: unknown) => String(l).trim()).filter(Boolean)
    : undefined;

  const orchestrator = resolveOrchestrator(options);
  const result = await orchestrator.dispatch({
    repositoryId: typeof payload.repositoryId === 'string' ? payload.repositoryId : undefined,
    repositoryName,
    repositoryPath: typeof payload.repositoryPath === 'string' ? payload.repositoryPath : undefined,
    cloneUrl: typeof payload.cloneUrl === 'string' ? payload.cloneUrl.trim() : undefined,
    prompt,
    requestedBy: typeof payload.requestedBy === 'string' ? payload.requestedBy : 'web-ui',
    scheduleMode,
    requiredLabels,
    model: typeof payload.model === 'string' ? payload.model : undefined,
    effort,
    allowOverage: Boolean(payload.allowOverage),
    pushBranch: typeof payload.pushBranch === 'boolean' ? payload.pushBranch : true,
    autoCreatePr: typeof payload.autoCreatePr === 'boolean' ? payload.autoCreatePr : true,
    expiresAt: typeof payload.expiresAt === 'string' ? payload.expiresAt : undefined,
    standingTaskId: typeof payload.standingTaskId === 'string' ? payload.standingTaskId : undefined,
    verifyCommand: typeof payload.verifyCommand === 'string' ? payload.verifyCommand : undefined,
  });

  if (!result.success && result.code === 'OVERAGE_PROTECTION_TRIGGERED') {
    return sendJson(res, 400, result);
  }

  return sendJson(res, 200, result);
};

export const handleGetTasks = (
  req: http.IncomingMessage,
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

  const body = await readBody(req, res);
  let payload: any = {};
  if (body.trim()) {
    try {
      payload = JSON.parse(body);
    } catch {
      return sendJson(res, 400, { error: 'Malformed JSON payload' });
    }
  }

  // If authenticated via a per-runner token, bind identity strictly to the registered worker record
  const workerId =
    auth.worker?.workerId ??
    (typeof payload?.workerId === 'string' && payload.workerId.trim() !== ''
      ? payload.workerId.trim()
      : 'worker-default');
  const workerName =
    auth.worker?.name ??
    (typeof payload?.workerName === 'string' && payload.workerName.trim() !== ''
      ? payload.workerName.trim()
      : workerId);
  const labels = Array.isArray(payload?.labels)
    ? payload.labels.map((l: unknown) => String(l).trim()).filter(Boolean)
    : auth.worker?.labels;
  const repositories = Array.isArray(payload?.repositories)
    ? payload.repositories.map((r: unknown) => String(r).trim()).filter(Boolean)
    : auth.worker?.repositories;
  const systemInfo =
    payload?.systemInfo && typeof payload.systemInfo === 'object' ? payload.systemInfo : undefined;
  const timeoutMs =
    typeof payload?.timeoutMs === 'number' && Number.isFinite(payload.timeoutMs)
      ? payload.timeoutMs
      : 0;

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

  const body = await readBody(req, res);
  if (!body.trim()) return sendJson(res, 400, { error: 'Request body cannot be empty' });

  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { error: 'Malformed JSON payload' });
  }

  const statusParse = TaskStatusSchema.safeParse(payload?.status);
  if (!statusParse.success) {
    return sendJson(res, 400, { error: 'Valid status is required' });
  }

  const updated = await orchestrator.reportTaskStatus(taskId, {
    status: statusParse.data as TaskStatus,
    workerId:
      auth.worker?.workerId ??
      (typeof payload.workerId === 'string' ? payload.workerId : undefined),
    branchName: typeof payload.branchName === 'string' ? payload.branchName : undefined,
    output: typeof payload.output === 'string' ? payload.output : undefined,
    error: typeof payload.error === 'string' ? payload.error : undefined,
    durationMs: typeof payload.durationMs === 'number' ? payload.durationMs : undefined,
    message: typeof payload.message === 'string' ? payload.message : undefined,
  });

  if (!updated) {
    return sendJson(res, 404, { error: `Task ${taskId} not found` });
  }

  // Relay runner status update into coordinator logs
  if (payload.message && typeof payload.message === 'string') {
    logger.child('runner').info('[%s] %s', taskId, payload.message);
  }

  return sendJson(res, 200, { success: true, task: updated });
};

export const handleTaskCancel = (
  req: http.IncomingMessage,
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
  return sendJson(res, 200, { success: true, task: updated });
};

export const handleTaskRetry = async (
  req: http.IncomingMessage,
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
  url: URL,
  method: string
): Promise<void> => {
  const orchestrator = resolveOrchestrator(options);

  if (method === 'GET') {
    const list = orchestrator.queue.listStandingTasks();
    return sendJson(res, 200, list, { 'Cache-Control': 'no-store' });
  }

  if (method === 'POST') {
    const body = await readBody(req, res);
    let payload: any;
    try {
      payload = JSON.parse(body);
    } catch {
      return sendJson(res, 400, { error: 'Malformed JSON payload' });
    }
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
    const body = await readBody(req, res);
    let patch: any;
    try {
      patch = JSON.parse(body);
    } catch {
      return sendJson(res, 400, { error: 'Malformed JSON payload' });
    }
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
  req: http.IncomingMessage,
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

  const body = await readBody(req, res);
  let payload: any = {};
  if (body.trim()) {
    try {
      payload = JSON.parse(body);
    } catch {
      return sendJson(res, 400, { error: 'Malformed JSON payload' });
    }
  }

  const labels = Array.isArray(payload?.labels)
    ? payload.labels.map((l: unknown) => String(l).trim()).filter(Boolean)
    : [];
  const repositories = Array.isArray(payload?.repositories)
    ? payload.repositories.map((r: unknown) => String(r).trim()).filter(Boolean)
    : [];
  const nameHint =
    typeof payload?.nameHint === 'string' && payload.nameHint.trim() !== ''
      ? payload.nameHint.trim()
      : undefined;
  const ttlMs =
    typeof payload?.ttlMs === 'number' && Number.isFinite(payload.ttlMs)
      ? payload.ttlMs
      : undefined;

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

  const body = await readBody(req, res);
  if (!body.trim()) return sendJson(res, 400, { error: 'Request body cannot be empty' });

  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { error: 'Malformed JSON payload' });
  }

  const registrationToken =
    typeof payload?.registrationToken === 'string' ? payload.registrationToken.trim() : '';
  if (!registrationToken) {
    return sendJson(res, 400, { error: 'registrationToken is required' });
  }

  const labels = Array.isArray(payload?.labels)
    ? payload.labels.map((l: unknown) => String(l).trim()).filter(Boolean)
    : undefined;
  const repositories = Array.isArray(payload?.repositories)
    ? payload.repositories.map((r: unknown) => String(r).trim()).filter(Boolean)
    : undefined;
  const systemInfo =
    payload?.systemInfo && typeof payload.systemInfo === 'object' ? payload.systemInfo : undefined;

  const orchestrator = resolveOrchestrator(options);
  try {
    const registered = orchestrator.registerRunner({
      registrationToken,
      workerId: typeof payload?.workerId === 'string' ? payload.workerId : undefined,
      workerName: typeof payload?.workerName === 'string' ? payload.workerName : undefined,
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
    const body = await readBody(req, res);
    if (!body.trim()) return sendJson(res, 400, { error: 'Request body cannot be empty' });

    let payload: any;
    try {
      payload = JSON.parse(body);
    } catch {
      return sendJson(res, 400, { error: 'Malformed JSON payload' });
    }

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
