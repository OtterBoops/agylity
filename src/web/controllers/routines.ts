import type http from 'node:http';
import {
  sendJson,
  methodNotAllowed,
  readJsonBody,
  toStringOrUndefined,
  toStringArray,
  toFiniteNumberOrUndefined,
  safeDecodeSegment,
  isSafetyBlockCode,
} from '../http.js';
import type { WebServerOptions } from '../types.js';
import { resolveCoordinator } from './dispatch.js';
import {
  ReasoningEffortSchema,
  type ReasoningEffort,
  type TaskActor,
} from '../../coordinator/models.js';
import { PrPolicyEnum, type PrPolicy } from '../../config/schema.js';

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
    return sendJson(res, 200, list, { 'Cache-Control': 'no-store' });
  }

  if (method === 'POST') {
    const parsed = await readJsonBody(req, res, { emptyBody: 'malformed' });
    if (!parsed.ok) return;
    const payload: any = parsed.body;

    if (!payload?.title || !payload?.prompt || !payload?.repositoryId) {
      return sendJson(res, 400, {
        error: 'title, prompt, and repositoryId are required for routine task',
      });
    }

    const effortParse = ReasoningEffortSchema.safeParse(payload.effort ?? 'high');
    const effort: ReasoningEffort = effortParse.success ? effortParse.data : 'high';
    const models =
      toStringArray(payload.models) ??
      (payload.model ? [String(payload.model)] : ['gemini-3.8-flash']);
    const actor: TaskActor =
      payload.actor === 'bot' || payload.actor === 'user' ? payload.actor : 'bot';
    const policyParsed = parseOptionalPrPolicy(payload.prPolicy);
    if (!policyParsed.ok) {
      return sendJson(res, 400, { error: policyParsed.error });
    }

    const created = coordinator.queue.createRoutineTask({
      title: String(payload.title).trim(),
      prompt: String(payload.prompt).trim(),
      repositoryId: String(payload.repositoryId).trim(),
      models: models.length > 0 ? models : ['gemini-3.8-flash'],
      effort,
      verifyCommand: toStringOrUndefined(payload.verifyCommand),
      autoCreatePr: payload.autoCreatePr !== false,
      actor,
      prPolicy: policyParsed.value,
      enabled: payload.enabled !== false,
      sortOrder: toFiniteNumberOrUndefined(payload.sortOrder) ?? 0,
      triggerBeforeResetHours: toFiniteNumberOrUndefined(payload.triggerBeforeResetHours) ?? 2,
      minHeadroomPercent: toFiniteNumberOrUndefined(payload.minHeadroomPercent) ?? 10,
    });

    return sendJson(res, 201, created);
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

  if (action === 'trigger' && method === 'POST') {
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
      models: rt.models,
      effort: rt.effort,
      autoCreatePr: rt.autoCreatePr,
      actor: rt.actor || 'bot',
      prPolicy: rt.prPolicy ?? resolved.prPolicy,
      verifyCommand: rt.verifyCommand,
      scheduleMode: 'immediate',
      requestedBy: `routine:${rt.id}`,
    });

    if (dispatchRes.success && dispatchRes.taskId) {
      coordinator.queue.updateRoutineTask(rt.id, {
        lastTaskId: dispatchRes.taskId,
      });
    }

    return sendJson(res, isSafetyBlockCode(dispatchRes.code) ? 400 : 200, dispatchRes);
  }

  if (method === 'GET') {
    const rt = coordinator.queue.getRoutineTask(id);
    if (!rt) return sendJson(res, 404, { error: `Routine task ${id} not found` });
    return sendJson(res, 200, rt, { 'Cache-Control': 'no-store' });
  }

  if (method === 'PATCH') {
    const parsed = await readJsonBody(req, res, { emptyBody: 'malformed' });
    if (!parsed.ok) return;
    const patch: any = parsed.body;
    const policyParsed = parseOptionalPrPolicy(patch?.prPolicy);
    if (!policyParsed.ok) {
      return sendJson(res, 400, { error: policyParsed.error });
    }
    if (patch && 'prPolicy' in patch) {
      patch.prPolicy = policyParsed.value;
    }

    const updated = coordinator.queue.updateRoutineTask(id, patch);
    if (!updated) return sendJson(res, 404, { error: `Routine task ${id} not found` });
    return sendJson(res, 200, updated);
  }

  if (method === 'DELETE') {
    const deleted = coordinator.queue.deleteRoutineTask(id);
    if (!deleted) return sendJson(res, 404, { error: `Routine task ${id} not found` });
    return sendJson(res, 200, { success: true, deleted: true });
  }

  return methodNotAllowed(res);
};
