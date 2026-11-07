import type http from 'node:http';
import ky from 'ky';
import {
  sendJson,
  methodNotAllowed,
  readJsonBody,
  toStringOrUndefined,
  toStringArray,
  toFiniteNumberOrUndefined,
  safeDecodeSegment,
} from '../http.js';
import type { WebServerOptions } from '../types.js';
import { resolveCoordinator } from './dispatch.js';
import { defaultExecFileAsync } from '../../sentry/discovery.js';
import {
  BacklogStatusSchema,
  ReasoningEffortSchema,
  type ReasoningEffort,
  type TaskActor,
} from '../../coordinator/models.js';

export const handleBacklogTasks = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  url: URL,
  method: string
): Promise<void> => {
  const coordinator = resolveCoordinator(options);

  if (method === 'GET') {
    const statusParam = url.searchParams.get('status');
    const parsedStatus = statusParam ? BacklogStatusSchema.safeParse(statusParam) : undefined;
    const list = coordinator.queue.listBacklogTasks(
      parsedStatus?.success ? parsedStatus.data : undefined
    );
    return sendJson(res, 200, list, { 'Cache-Control': 'no-store' });
  }

  if (method === 'POST') {
    const parsed = await readJsonBody(req, res, { emptyBody: 'malformed' });
    if (!parsed.ok) return;
    const payload: any = parsed.body;

    if (!payload?.title || !payload?.prompt || !payload?.repositoryId) {
      return sendJson(res, 400, {
        error: 'title, prompt, and repositoryId are required for backlog task',
      });
    }

    const effortParse = ReasoningEffortSchema.safeParse(payload.effort ?? 'high');
    const effort: ReasoningEffort = effortParse.success ? effortParse.data : 'high';
    const models = toStringArray(payload.models) ?? ['gemini-3.8-flash'];
    const actor: TaskActor =
      payload.actor === 'bot' || payload.actor === 'user' ? payload.actor : 'bot';

    const created = coordinator.queue.createBacklogTask({
      title: String(payload.title).trim(),
      prompt: String(payload.prompt).trim(),
      repositoryId: String(payload.repositoryId).trim(),
      models: models.length > 0 ? models : ['gemini-3.8-flash'],
      effort,
      verifyCommand: toStringOrUndefined(payload.verifyCommand),
      autoCreatePr: payload.autoCreatePr !== false,
      actor,
      priorityOrder: toFiniteNumberOrUndefined(payload.priorityOrder) ?? 0,
      maxAttempts: toFiniteNumberOrUndefined(payload.maxAttempts) ?? 2,
      githubIssueNumber: toFiniteNumberOrUndefined(payload.githubIssueNumber),
      githubIssueUrl: toStringOrUndefined(payload.githubIssueUrl),
    });

    return sendJson(res, 201, created);
  }

  return methodNotAllowed(res);
};

export const handleBacklogTaskById = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  pathname: string,
  method: string
): Promise<void> => {
  const match = /^\/api\/backlog\/([^/]+)(?:\/(dispatch))?$/.exec(pathname);
  const id = match?.[1] ? safeDecodeSegment(match[1]) : '';
  const action = match?.[2];
  if (!id) return sendJson(res, 400, { error: 'id is required' });

  const coordinator = resolveCoordinator(options);

  if (action === 'dispatch' && method === 'POST') {
    const task = coordinator.queue.getBacklogTask(id);
    if (!task) return sendJson(res, 404, { error: `Backlog task ${id} not found` });

    const concreteModel = task.models[0] || 'gemini-3.8-flash';
    const resolved = options.configStore.resolveConfig();

    const dispatchRes = await coordinator.dispatch({
      repositoryId: task.repositoryId,
      repositoryName: task.repositoryId,
      prompt: task.prompt,
      title: task.title,
      tier: 'backlog',
      originId: task.id,
      originNumber: task.taskNumber,
      originTitle: task.title,
      model: concreteModel,
      effort: task.effort,
      autoCreatePr: task.autoCreatePr,
      actor: task.actor,
      botPrPolicy: resolved.botPrPolicy,
      verifyCommand: task.verifyCommand,
      scheduleMode: 'immediate',
      requestedBy: `backlog:${task.id}`,
    });

    if (dispatchRes.success && dispatchRes.taskId) {
      coordinator.queue.updateBacklogTask(task.id, {
        status: 'dispatched',
        attemptCount: task.attemptCount + 1,
        swarmTaskId: dispatchRes.taskId,
      });
    }

    return sendJson(res, 200, dispatchRes);
  }

  if (method === 'GET') {
    const task = coordinator.queue.getBacklogTask(id);
    if (!task) return sendJson(res, 404, { error: `Backlog task ${id} not found` });
    return sendJson(res, 200, task, { 'Cache-Control': 'no-store' });
  }

  if (method === 'PATCH') {
    const parsed = await readJsonBody(req, res, { emptyBody: 'malformed' });
    if (!parsed.ok) return;
    const patch: any = parsed.body;

    const updated = coordinator.queue.updateBacklogTask(id, patch);
    if (!updated) return sendJson(res, 404, { error: `Backlog task ${id} not found` });
    return sendJson(res, 200, updated);
  }

  if (method === 'DELETE') {
    const deleted = coordinator.queue.deleteBacklogTask(id);
    if (!deleted) return sendJson(res, 404, { error: `Backlog task ${id} not found` });
    return sendJson(res, 200, { success: true, deleted: true });
  }

  return methodNotAllowed(res);
};

export const handleSyncGithubBacklog = async (
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  method: string
): Promise<void> => {
  if (method !== 'POST') return methodNotAllowed(res);

  const config = options.configStore.resolveConfig();
  const coordinator = resolveCoordinator(options);
  const targetLabel = config.githubBacklogLabel || 'backlog';
  const ghToken = process.env.GITHUB_TOKEN?.trim();

  let importedCount = 0;
  const existingBacklog = coordinator.queue.listBacklogTasks();
  const existingKeys = new Set(
    existingBacklog
      .filter((t) => t.githubIssueNumber !== undefined)
      .map((t) => `${t.repositoryId}#${t.githubIssueNumber}`)
  );

  for (const repo of config.repositories) {
    let repoSlug: string | undefined;
    if (repo.cloneUrl) {
      const match = /github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?/.exec(repo.cloneUrl);
      if (match) repoSlug = match[1];
    }
    if (!repoSlug && repo.id.includes('/')) {
      repoSlug = repo.id;
    }
    if (!repoSlug) continue;

    try {
      let issues: Array<{
        number: number;
        title: string;
        body?: string;
        html_url?: string;
        url?: string;
      }> = [];

      if (ghToken) {
        try {
          const resp = await ky
            .get(`https://api.github.com/repos/${repoSlug}/issues`, {
              headers: {
                Authorization: `Bearer ${ghToken}`,
                Accept: 'application/vnd.github+json',
                'User-Agent': 'Agylity-Backlog-Sync',
              },
              searchParams: {
                labels: targetLabel,
                state: 'open',
                per_page: 50,
              },
              timeout: 15000,
            })
            .json<any[]>();

          issues = resp.filter((item) => !item.pull_request);
        } catch (apiErr) {
          options.logger?.warn?.(
            'GitHub REST sync failed for %s, falling back to gh CLI: %s',
            repoSlug,
            apiErr
          );
        }
      }

      if (issues.length === 0) {
        try {
          const { stdout } = await defaultExecFileAsync(
            'gh',
            [
              'issue',
              'list',
              '--repo',
              repoSlug,
              '--label',
              targetLabel,
              '--state',
              'open',
              '--json',
              'number,title,body,url',
            ],
            { timeout: 15000 }
          );
          if (stdout && stdout.trim()) {
            issues = JSON.parse(stdout);
          }
        } catch (ghCliErr) {
          options.logger?.debug?.('gh CLI sync failed for %s: %s', repoSlug, ghCliErr);
        }
      }

      for (const issue of issues) {
        const key = `${repo.id}#${issue.number}`;
        if (existingKeys.has(key)) continue;

        const title = issue.title.trim();
        const prompt = (issue.body || issue.title).trim();
        const issueUrl = issue.html_url || issue.url;

        coordinator.queue.createBacklogTask({
          title: `[GH #${issue.number}] ${title}`,
          prompt,
          repositoryId: repo.id,
          models: [config.defaultDispatchModel || 'gemini-3.8-flash'],
          effort: config.defaultDispatchEffort || 'high',
          autoCreatePr: true,
          actor: 'bot',
          githubIssueNumber: issue.number,
          githubIssueUrl: issueUrl,
          maxAttempts: 2,
        });

        existingKeys.add(key);
        importedCount++;
      }
    } catch (err: any) {
      options.logger?.error?.(
        'Failed to sync GitHub backlog for repo %s: %s',
        repo.id,
        err?.message ?? err
      );
    }
  }

  return sendJson(res, 200, {
    success: true,
    importedCount,
    label: targetLabel,
  });
};
