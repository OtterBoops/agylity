import type http from 'node:http';
import { createHash } from 'node:crypto';
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
  resolveDefaultDispatchModel,
  CANONICAL_AGY_MODELS,
  isTerminalTaskStatus,
  normalizeCascade,
  resolveConcreteModelId,
  ScheduleModeSchema,
  TaskStatusSchema,
  type CascadeHop,
  type ReasoningEffort,
  type ScheduleMode,
  type TaskStatus,
} from '../../coordinator/models.js';

const coordinatorCache = new WeakMap<WebServerOptions, Coordinator>();

const knownModelIds = (options: WebServerOptions): readonly string[] => [
  ...CANONICAL_AGY_MODELS.map((m) => m.id),
  ...(options.modelCatalog?.getModels() ?? []).map((m) => m.id),
];

export interface CascadeRequestOptions {
  fallbackModel?: string;
  fallbackEffort?: ReasoningEffort;
  knownModels?: readonly string[];
}

export const parseCascadeRequest = (
  raw: unknown,
  options: CascadeRequestOptions = {}
): { ok: true; cascade: CascadeHop[] } | { ok: false; error: string } => {
  const fallbackModel = options.fallbackModel?.trim() || 'gemini-4-hydrogen';

  if (raw === undefined || raw === null) {
    const seeded = options.fallbackEffort
      ? [{ model: fallbackModel, effort: options.fallbackEffort }]
      : [{ model: fallbackModel }];
    return { ok: true, cascade: normalizeCascade(seeded, fallbackModel) };
  }

  if (!Array.isArray(raw)) {
    return { ok: false, error: 'cascade must be an array of { model, effort } hops' };
  }
  if (raw.length === 0) {
    return { ok: false, error: 'cascade must contain at least one hop' };
  }

  const known = new Set<string>([
    ...CANONICAL_AGY_MODELS.map((m) => m.id),
    ...(options.knownModels ?? []),
  ]);

  for (let index = 0; index < raw.length; index += 1) {
    const hop: unknown = raw[index];
    if (hop === null || typeof hop !== 'object' || Array.isArray(hop)) {
      return {
        ok: false,
        error: `cascade[${index}] must be an object with a model and an effort`,
      };
    }
    const model = (hop as { model?: unknown }).model;
    if (typeof model !== 'string' || model.trim() === '') {
      return { ok: false, error: `cascade[${index}].model must be a non-empty string` };
    }
    const concrete = resolveConcreteModelId(model, fallbackModel);
    if (!known.has(concrete)) {
      return { ok: false, error: `cascade[${index}].model '${model}' is not a known model` };
    }
    const effort = (hop as { effort?: unknown }).effort;
    if (effort !== undefined && effort !== null && typeof effort !== 'string') {
      return { ok: false, error: `cascade[${index}].effort must be a string` };
    }
  }

  return { ok: true, cascade: normalizeCascade(raw, fallbackModel) };
};

export const configuredCascade = (options: CascadeRequestOptions = {}): CascadeHop[] => {
  const parsed = parseCascadeRequest(undefined, options);
  return parsed.ok ? parsed.cascade : [];
};

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

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
      defaultModel: resolveDefaultDispatchModel(
        resolved.defaultDispatchModel || BUILTIN_DEFAULTS.defaultDispatchModel,
        catalog
      ),
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

  const resolved = options.configStore.resolveConfig();
  const cascadeParse = parseCascadeRequest(payload.cascade, {
    fallbackModel: resolved.defaultDispatchModel || BUILTIN_DEFAULTS.defaultDispatchModel,
    fallbackEffort: resolved.defaultDispatchEffort || BUILTIN_DEFAULTS.defaultDispatchEffort,
    knownModels: knownModelIds(options),
  });
  if (!cascadeParse.ok) {
    return sendJson(res, 400, { error: cascadeParse.error });
  }

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
    prPolicy:
      payload.prPolicy === 'docs_only' ||
      payload.prPolicy === 'issues_only' ||
      payload.prPolicy === 'all' ||
      payload.prPolicy === 'none'
        ? payload.prPolicy
        : undefined,
    scheduleMode,
    requiredLabels,
    cascade: cascadeParse.cascade,
    allowOverage: payload.allowOverage === true,
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

  const requestedLimit = Number(url.searchParams.get('limit') ?? 50);
  const limit = Math.min(
    Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 50),
    500
  );
  const requestedOffset = Number(url.searchParams.get('offset') ?? 0);
  const offset = Math.max(0, Number.isFinite(requestedOffset) ? Math.floor(requestedOffset) : 0);

  const statusParam = url.searchParams.get('status')?.trim();
  let status: TaskStatus | undefined;
  if (statusParam) {
    const parsedStatus = TaskStatusSchema.safeParse(statusParam);
    if (!parsedStatus.success) {
      return sendJson(res, 400, { error: `Unknown task status: ${statusParam}` }, NO_STORE);
    }
    status = parsedStatus.data;
  }

  const taskNumberParam = url.searchParams.get('taskNumber')?.trim();
  let taskNumber: number | undefined;
  if (taskNumberParam) {
    const parsed = Number(taskNumberParam);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return sendJson(
        res,
        400,
        { error: `taskNumber must be a positive integer: ${taskNumberParam}` },
        NO_STORE
      );
    }
    taskNumber = parsed;
  }

  const q = url.searchParams.get('q')?.trim() || undefined;
  const filters = { status, q, taskNumber };

  const tasks = coordinator.queue.listTasks({ ...filters, limit, offset });
  const total = coordinator.queue.countTasks(filters);

  return sendJson(res, 200, { tasks, total, offset, limit }, NO_STORE);
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

  // A per-runner token binds identity to the registered record, never to the poll payload.
  const runnerId =
    auth.runner?.runnerId ?? toTrimmedStringOrUndefined(payload?.runnerId) ?? 'runner-default';
  const runnerName =
    auth.runner?.name ?? toTrimmedStringOrUndefined(payload?.runnerName) ?? runnerId;
  const labels = auth.runner ? auth.runner.labels : (toStringArray(payload?.labels) ?? []);
  const repositories = auth.runner
    ? auth.runner.repositories
    : (toStringArray(payload?.repositories) ?? []);
  const systemInfo =
    payload?.systemInfo && typeof payload.systemInfo === 'object' ? payload.systemInfo : undefined;
  const timeoutMs = toFiniteNumberOrUndefined(payload?.timeoutMs) ?? 0;

  const abortController = new AbortController();
  const onClose = () => abortController.abort();
  // The request's 'close' has already fired after the body read; only the response reports a mid-poll hangup.
  res.once('close', onClose);

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
    res.off('close', onClose);
  }
};

export const handleGetTaskById = (
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  pathname: string,
  method: string
): void => {
  if (method !== 'GET') return methodNotAllowed(res);
  const match = /^\/api\/tasks\/([^/]+)$/.exec(pathname);
  const taskId = match?.[1] ? safeDecodeSegment(match[1]) : '';
  if (!taskId) return sendJson(res, 400, { error: 'taskId is required' });

  const coordinator = resolveCoordinator(options);
  const task = coordinator.queue.getTask(taskId);
  if (!task) return sendJson(res, 404, { error: `Task ${taskId} not found` });
  const fingerprint = createHash('sha1')
    .update(
      `${task.status}\u0000${task.updatedAt}\u0000${task.output ?? ''}\u0000${task.error ?? ''}`
    )
    .digest('hex')
    .slice(0, 16);
  return sendJson(res, 200, { ...task, fingerprint }, { 'Cache-Control': 'no-store' });
};

export const handleRunnerHeartbeat = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  method: string
): Promise<void> => {
  if (method !== 'POST') return methodNotAllowed(res);

  const coordinator = resolveCoordinator(options);
  const auth = coordinator.authenticateRunner(extractRunnerToken(req));
  if (!auth.authenticated) {
    return sendJson(res, 401, { error: 'Unauthorized runner token' });
  }

  const parsed = await readJsonBody(req, res, { emptyBody: 'allow' });
  if (!parsed.ok) return;
  const payload: any = parsed.body;

  const taskId = toTrimmedStringOrUndefined(payload?.taskId);
  if (!taskId) return sendJson(res, 400, { error: 'taskId is required' });

  const result = coordinator.heartbeatTask(
    taskId,
    auth.runner?.runnerId ?? toTrimmedStringOrUndefined(payload?.runnerId) ?? 'runner-default',
    toFiniteNumberOrUndefined(payload?.leaseDurationMs),
    toStringOrUndefined(payload?.outputTail)
  );

  if (!result) return sendJson(res, 404, { error: `Task ${taskId} not found` });
  return sendJson(res, result.applied ? 200 : 409, {
    leaseOk: result.applied,
    status: result.task.status,
    task: result.task,
  });
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

  const retryRes = await coordinator.retryTask(task);

  if (!retryRes.success && isSafetyBlockCode(retryRes.code)) {
    return sendJson(res, 400, retryRes);
  }

  // A retry is a dispatch, so a safety-floor refusal is a 4xx here too, not a 200 body.
  if (!retryRes.success && isSafetyBlockCode(retryRes.code)) {
    return sendJson(res, 400, retryRes);
  }

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
