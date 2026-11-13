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
  isSafetyBlockCode,
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
      models: task.models,
      effort: task.effort,
      autoCreatePr: task.autoCreatePr,
      actor: task.actor,
      prPolicy: resolved.prPolicy,
      verifyCommand: task.verifyCommand,
      scheduleMode: 'immediate',
      requestedBy: `backlog:${task.id}`,
    });

    if (dispatchRes.success && dispatchRes.taskId) {
      coordinator.queue.updateBacklogTask(task.id, {
        status: 'dispatched',
        attemptCount: task.attemptCount + 1,
        swarmTaskId: dispatchRes.taskId,
        lastError: null,
      });
      return sendJson(res, 200, dispatchRes);
    }

    // A refusal must not read as a queued task; keep the reason on the row for the dashboard.
    coordinator.queue.updateBacklogTask(task.id, {
      lastError: dispatchRes.error || 'Dispatch refused',
    });
    return sendJson(res, isSafetyBlockCode(dispatchRes.code) ? 400 : 200, dispatchRes);
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
  let canceledCount = 0;
  const failedRepos: string[] = [];
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

    const issues = await listOpenIssues(repoSlug, targetLabel, ghToken, options.logger);
    if (!issues) {
      failedRepos.push(repo.id);
      continue;
    }

    try {
      for (const issue of issues) {
        const key = `${repo.id}#${issue.number}`;
        if (existingKeys.has(key)) continue;

        coordinator.queue.createBacklogTask({
          title: `[GH #${issue.number}] ${issue.title.trim()}`,
          prompt: (issue.body || issue.title).trim(),
          repositoryId: repo.id,
          models: [config.defaultDispatchModel || 'gemini-3.8-flash'],
          effort: config.defaultDispatchEffort || 'high',
          autoCreatePr: true,
          actor: 'bot',
          githubIssueNumber: issue.number,
          githubIssueUrl: issue.html_url || issue.url,
          maxAttempts: 2,
        });

        existingKeys.add(key);
        importedCount++;
      }

      // A fetched repo proves which of its issues are still open, so a row whose issue is gone
      // must not stay queued. Dispatched rows are left alone: their task is in flight.
      const openNumbers = new Set(issues.map((issue) => issue.number));
      for (const row of existingBacklog) {
        if (row.repositoryId !== repo.id || row.githubIssueNumber === undefined) continue;
        if (openNumbers.has(row.githubIssueNumber)) continue;
        if (row.status === 'dispatched' || row.status === 'canceled') continue;
        coordinator.queue.updateBacklogTask(row.id, {
          status: 'canceled',
          lastError: 'Issue closed upstream',
        });
        canceledCount++;
      }
    } catch (err: any) {
      options.logger?.error?.(
        'Failed to import GitHub backlog for repo %s: %s',
        repo.id,
        err?.message ?? err
      );
      failedRepos.push(repo.id);
    }
  }

  return sendJson(res, 200, {
    success: failedRepos.length === 0,
    importedCount,
    canceledCount,
    label: targetLabel,
    failedRepos,
  });
};

interface GithubIssue {
  number: number;
  title: string;
  body?: string;
  html_url?: string;
  url?: string;
}

const GITHUB_ISSUE_PAGES = 5;
const GITHUB_ISSUE_PAGE_SIZE = 100;

const listOpenIssues = async (
  repoSlug: string,
  label: string,
  ghToken: string | undefined,
  logger?: WebServerOptions['logger']
): Promise<GithubIssue[] | undefined> => {
  if (ghToken) {
    try {
      const issues: GithubIssue[] = [];
      for (let page = 1; page <= GITHUB_ISSUE_PAGES; page++) {
        const batch = await ky
          .get(`https://api.github.com/repos/${repoSlug}/issues`, {
            headers: {
              Authorization: `Bearer ${ghToken}`,
              Accept: 'application/vnd.github+json',
              'User-Agent': 'Agylity-Backlog-Sync',
            },
            searchParams: {
              labels: label,
              state: 'open',
              per_page: GITHUB_ISSUE_PAGE_SIZE,
              page,
            },
            timeout: 15000,
          })
          .json<GithubIssue[]>();

        // The issues endpoint also returns pull requests.
        issues.push(...batch.filter((item: any) => !item.pull_request));
        if (batch.length < GITHUB_ISSUE_PAGE_SIZE) break;
      }
      return issues;
    } catch (apiErr) {
      logger?.warn?.(
        'GitHub REST sync failed for %s, falling back to gh CLI: %s',
        repoSlug,
        apiErr
      );
    }
  }

  try {
    const { stdout } = await defaultExecFileAsync(
      'gh',
      [
        'issue',
        'list',
        '--repo',
        repoSlug,
        '--label',
        label,
        '--state',
        'open',
        '--limit',
        '500',
        '--json',
        'number,title,body,url',
      ],
      { timeout: 20000 }
    );
    return stdout && stdout.trim() ? (JSON.parse(stdout) as GithubIssue[]) : [];
  } catch (ghCliErr) {
    logger?.debug?.('gh CLI sync failed for %s: %s', repoSlug, ghCliErr);
    return undefined;
  }
};
