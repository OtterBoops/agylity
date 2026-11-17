import type http from 'node:http';
import {
  sendJson,
  methodNotAllowed,
  readJsonBody,
  toStringOrUndefined,
  toFiniteNumberOrUndefined,
  safeDecodeSegment,
  isSafetyBlockCode,
} from '../http.js';
import type { WebServerOptions } from '../types.js';
import { parseCascadeRequest, resolveCoordinator } from './dispatch.js';
import { DEFAULT_QUOTA_BURN_MAX_HOURS, PrPolicyEnum, type PrPolicy } from '../../config/schema.js';

const parseOptionalPrPolicy = (
  raw: unknown
): { ok: true; value: PrPolicy | null | undefined } | { ok: false; error: string } => {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null || raw === '') return { ok: true, value: null };
  const parsed = PrPolicyEnum.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "prPolicy must be 'docs_only', 'all', 'none', or null" };
  }
  return { ok: true, value: parsed.data };
};

const TEXT_FIELDS = ['title', 'prompt', 'repositoryId'] as const;

const validateTextFieldPatch = (body: any): string | undefined => {
  if (!body || typeof body !== 'object') return undefined;
  for (const field of TEXT_FIELDS) {
    if (!(field in body)) continue;
    const value = body[field];
    if (typeof value !== 'string' || value.trim() === '') {
      return `${field} must be a non-empty string`;
    }
  }
  return undefined;
};

const validateRoutineLimits = (body: any): string | undefined => {
  if (!body || typeof body !== 'object') return undefined;
  if (body.triggerBeforeResetHours !== undefined) {
    const hours = body.triggerBeforeResetHours;
    if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) {
      return 'triggerBeforeResetHours must be a finite number greater than 0';
    }
  }
  if (body.minHeadroomPercent !== undefined) {
    const headroom = body.minHeadroomPercent;
    if (
      typeof headroom !== 'number' ||
      !Number.isFinite(headroom) ||
      headroom < 0 ||
      headroom > 100
    ) {
      return 'minHeadroomPercent must be a finite number between 0 and 100';
    }
  }
  return undefined;
};

export const handleRoutineTasks = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  _url: URL,
  method: string
): Promise<void> => {
  const coordinator = resolveCoordinator(options);

  if (method === 'GET') {
    const list = coordinator.queue.listRoutineTasks();
    return sendJson(
      res,
      200,
      list.map((rt) => ({ ...rt, eligibility: coordinator.computeRoutineEligibility(rt) })),
      { 'Cache-Control': 'no-store' }
    );
  }

  if (method === 'POST') {
    const parsed = await readJsonBody(req, res, { emptyBody: 'malformed' });
    if (!parsed.ok) return;
    const payload: any = parsed.body;

    const title = typeof payload?.title === 'string' ? payload.title.trim() : '';
    const prompt = typeof payload?.prompt === 'string' ? payload.prompt.trim() : '';
    const repositoryId =
      typeof payload?.repositoryId === 'string' ? payload.repositoryId.trim() : '';
    if (!title || !prompt || !repositoryId) {
      return sendJson(res, 400, {
        error: 'title, prompt, and repositoryId are required for routine task',
      });
    }

    const limitError = validateRoutineLimits(payload);
    if (limitError) {
      return sendJson(res, 400, { error: limitError });
    }

    const resolved = options.configStore.resolveConfig();
    const cascadeParse = parseCascadeRequest(payload.cascade, {
      fallbackModel: resolved.defaultDispatchModel,
      fallbackEffort: resolved.defaultDispatchEffort,
    });
    if (!cascadeParse.ok) {
      return sendJson(res, 400, { error: cascadeParse.error });
    }
    const policyParsed = parseOptionalPrPolicy(payload.prPolicy);
    if (!policyParsed.ok) {
      return sendJson(res, 400, { error: policyParsed.error });
    }

    const created = coordinator.queue.createRoutineTask({
      title,
      prompt,
      repositoryId,
      cascade: cascadeParse.cascade,
      verifyCommand: toStringOrUndefined(payload.verifyCommand),
      autoCreatePr: payload.autoCreatePr !== false,
      prPolicy: policyParsed.value,
      enabled: payload.enabled !== false,
      sortOrder: toFiniteNumberOrUndefined(payload.sortOrder) ?? 0,
      triggerBeforeResetHours:
        toFiniteNumberOrUndefined(payload.triggerBeforeResetHours) ?? DEFAULT_QUOTA_BURN_MAX_HOURS,
      minHeadroomPercent: toFiniteNumberOrUndefined(payload.minHeadroomPercent) ?? 10,
    });

    return sendJson(res, 201, {
      ...created,
      eligibility: coordinator.computeRoutineEligibility(created),
    });
  }

  return methodNotAllowed(res);
};

export const handleRoutineTaskById = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  pathname: string,
  method: string
): Promise<void> => {
  const match = /^\/api\/routines\/([^/]+)(?:\/(trigger))?$/.exec(pathname);
  const id = match?.[1] ? safeDecodeSegment(match[1]) : '';
  const action = match?.[2];
  if (!id) return sendJson(res, 400, { error: 'id is required' });

  const coordinator = resolveCoordinator(options);

  if (action === 'trigger') {
    if (method !== 'POST') return sendJson(res, 405, { error: 'Method Not Allowed' });
    const rt = coordinator.queue.getRoutineTask(id);
    if (!rt) return sendJson(res, 404, { error: `Routine task ${id} not found` });

    const resolved = options.configStore.resolveConfig();

    const dispatchRes = await coordinator.dispatch({
      repositoryId: rt.repositoryId,
      repositoryName: rt.repositoryId,
      prompt: rt.prompt,
      title: rt.title,
      tier: 'routine',
      originId: rt.id,
      originNumber: rt.taskNumber,
      originTitle: rt.title,
      cascade: rt.cascade,
      autoCreatePr: rt.autoCreatePr,
      prPolicy: rt.prPolicy ?? resolved.prPolicy,
      verifyCommand: rt.verifyCommand,
      scheduleMode: 'immediate',
      requestedBy: `routine:${rt.id}`,
    });

    if (dispatchRes.success && dispatchRes.taskId) {
      const pool = coordinator
        .getActivePools()
        .find((p) => p.family === dispatchRes.poolFamily || p.poolId === dispatchRes.poolFamily);
      coordinator.queue.updateRoutineTask(rt.id, {
        lastTaskId: dispatchRes.taskId,
        ...(pool?.resetTime ? { lastTriggeredResetTime: pool.resetTime } : {}),
      });
    }

    return sendJson(res, isSafetyBlockCode(dispatchRes.code) ? 400 : 200, dispatchRes);
  }

  if (method === 'GET') {
    const rt = coordinator.queue.getRoutineTask(id);
    if (!rt) return sendJson(res, 404, { error: `Routine task ${id} not found` });
    return sendJson(
      res,
      200,
      { ...rt, eligibility: coordinator.computeRoutineEligibility(rt) },
      { 'Cache-Control': 'no-store' }
    );
  }

  if (method === 'PATCH') {
    const parsed = await readJsonBody(req, res, { emptyBody: 'malformed' });
    if (!parsed.ok) return;
    const patch: any = parsed.body;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return sendJson(res, 400, { error: 'Request body must be a JSON object' });
    }

    const textError = validateTextFieldPatch(patch);
    if (textError) return sendJson(res, 400, { error: textError });
    const limitError = validateRoutineLimits(patch);
    if (limitError) return sendJson(res, 400, { error: limitError });

    const policyParsed = parseOptionalPrPolicy(patch?.prPolicy);
    if (!policyParsed.ok) {
      return sendJson(res, 400, { error: policyParsed.error });
    }
    if (patch && 'prPolicy' in patch) {
      patch.prPolicy = policyParsed.value;
    }

    if ('cascade' in patch) {
      const resolved = options.configStore.resolveConfig();
      const cascadeParse = parseCascadeRequest(patch.cascade, {
        fallbackModel: resolved.defaultDispatchModel,
        fallbackEffort: resolved.defaultDispatchEffort,
      });
      if (!cascadeParse.ok) return sendJson(res, 400, { error: cascadeParse.error });
      patch.cascade = cascadeParse.cascade;
    }

    const updated = coordinator.queue.updateRoutineTask(id, patch);
    if (!updated) return sendJson(res, 404, { error: `Routine task ${id} not found` });
    return sendJson(res, 200, {
      ...updated,
      eligibility: coordinator.computeRoutineEligibility(updated),
    });
  }

  if (method === 'DELETE') {
    const deleted = coordinator.queue.deleteRoutineTask(id);
    if (!deleted) return sendJson(res, 404, { error: `Routine task ${id} not found` });
    return sendJson(res, 200, { success: true, deleted: true });
  }

  return methodNotAllowed(res);
};
