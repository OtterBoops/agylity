import type http from 'node:http';
import ky from 'ky';
import {
  sendJson,
  methodNotAllowed,
  readJsonBody,
  toStringOrUndefined,
  toFiniteNumberOrUndefined,
  safeDecodeSegment,
  dispatchHttpStatus,
} from '../http.js';
import type { WebServerOptions } from '../types.js';
import {
  configuredCascade,
  parseCascadeRequest,
  resolveCoordinator,
  knownModelIds,
} from './dispatch.js';
import { defaultExecFileAsync } from '../../sentry/discovery.js';
import {
  BacklogStatusSchema,
  isTerminalTaskStatus,
  type BacklogStatus,
} from '../../coordinator/models.js';
import type { BacklogTaskRecord } from '../../coordinator/queue.js';
import type { RepositoryEntry } from '../../config/schema.js';

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

    const title = typeof payload?.title === 'string' ? payload.title.trim() : '';
    const prompt = typeof payload?.prompt === 'string' ? payload.prompt.trim() : '';
    const repositoryId =
      typeof payload?.repositoryId === 'string' ? payload.repositoryId.trim() : '';
    if (!title || !prompt || !repositoryId) {
      return sendJson(res, 400, {
        error: 'title, prompt, and repositoryId are required for backlog task',
      });
    }

    const resolved = options.configStore.resolveConfig();
    const cascadeParse = parseCascadeRequest(payload.cascade, {
      fallbackModel: resolved.defaultDispatchModel,
      fallbackEffort: resolved.defaultDispatchEffort,
      knownModels: knownModelIds(options),
    });
    if (!cascadeParse.ok) {
      return sendJson(res, 400, { error: cascadeParse.error });
    }

    const created = coordinator.queue.createBacklogTask({
      title,
      prompt,
      repositoryId,
      cascade: cascadeParse.cascade,
      verifyCommand: toStringOrUndefined(payload.verifyCommand),
      autoCreatePr: payload.autoCreatePr !== false,
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

  if (action === 'dispatch') {
    if (method !== 'POST') return sendJson(res, 405, { error: 'Method Not Allowed' });
    const task = coordinator.queue.getBacklogTask(id);
    if (!task) return sendJson(res, 404, { error: `Backlog task ${id} not found` });

    if (task.status === 'dispatched' || coordinator.queue.hasActiveTaskForOrigin(task.id)) {
      return sendJson(res, 409, {
        success: false,
        error: `Backlog task ${task.id} already has an active run in flight`,
        code: 'ORIGIN_ALREADY_ACTIVE',
        status: task.status,
      });
    }

    const resolved = options.configStore.resolveConfig();
    const matchedRepo = resolved.repositories.find(
      (r) =>
        r.id.toLowerCase() === task.repositoryId.toLowerCase() ||
        r.name.toLowerCase() === task.repositoryId.toLowerCase()
    );

    const dispatchRes = await coordinator.dispatch({
      repositoryId: task.repositoryId,
      repositoryName: matchedRepo?.name ?? task.repositoryId,
      repositoryPath: matchedRepo?.path,
      cloneUrl: matchedRepo?.cloneUrl,
      prompt: task.prompt,
      title: task.title,
      tier: 'backlog',
      originId: task.id,
      originNumber: task.taskNumber,
      originTitle: task.title,
      cascade: task.cascade,
      autoCreatePr: task.autoCreatePr,
      prPolicy: resolved.prPolicy,
      verifyCommand: task.verifyCommand,
      scheduleMode: 'immediate',
      requestedBy: `backlog:${task.id}`,
    });

    if (dispatchRes.success && dispatchRes.taskId) {
      return sendJson(res, 200, dispatchRes);
    }

    if (dispatchRes.code !== 'ORIGIN_ALREADY_ACTIVE') {
      coordinator.queue.updateBacklogTask(task.id, {
        lastError: dispatchRes.error || 'Dispatch refused',
      });
    }
    return sendJson(res, dispatchHttpStatus(dispatchRes.code), dispatchRes);
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
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return sendJson(res, 400, { error: 'Request body must be a JSON object' });
    }

    const textError = validateTextFieldPatch(patch);
    if (textError) return sendJson(res, 400, { error: textError });

    if ('cascade' in patch) {
      const resolved = options.configStore.resolveConfig();
      const cascadeParse = parseCascadeRequest(patch.cascade, {
        fallbackModel: resolved.defaultDispatchModel,
        fallbackEffort: resolved.defaultDispatchEffort,
        knownModels: knownModelIds(options),
      });
      if (!cascadeParse.ok) return sendJson(res, 400, { error: cascadeParse.error });
      patch.cascade = cascadeParse.cascade;
    }

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

const BULK_BACKLOG_MAX_IDS = 200;

const BULK_PAUSE_FROM: readonly BacklogStatus[] = ['pending', 'dispatched'];

export const handleBulkBacklogTasks = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  method: string
): Promise<void> => {
  if (method !== 'PATCH') return methodNotAllowed(res);

  const parsed = await readJsonBody(req, res, { emptyBody: 'malformed' });
  if (!parsed.ok) return;
  const payload: any = parsed.body;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return sendJson(res, 400, { error: 'Request body must be a JSON object' });
  }

  const action = payload.action;
  if (action !== 'pause' && action !== 'resume') {
    return sendJson(res, 400, { error: "action must be 'pause' or 'resume'" });
  }

  const rawIds = payload.ids;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    return sendJson(res, 400, { error: 'ids must be a non-empty array of backlog task ids' });
  }
  if (rawIds.length > BULK_BACKLOG_MAX_IDS) {
    return sendJson(res, 400, {
      error: `ids accepts at most ${BULK_BACKLOG_MAX_IDS} entries per request`,
    });
  }
  if (rawIds.some((id: unknown) => typeof id !== 'string' || id.trim() === '')) {
    return sendJson(res, 400, { error: 'ids must contain only non-empty strings' });
  }

  const coordinator = resolveCoordinator(options);
  const targetStatus: BacklogStatus = action === 'pause' ? 'paused' : 'pending';
  const eligibleFrom: readonly BacklogStatus[] = action === 'pause' ? BULK_PAUSE_FROM : ['paused'];

  const items: BacklogTaskRecord[] = [];
  const skipped: string[] = [];

  for (const id of new Set<string>(rawIds.map((raw: string) => raw.trim()))) {
    const row = coordinator.queue.getBacklogTask(id);
    if (!row || !eligibleFrom.includes(row.status)) {
      skipped.push(id);
      continue;
    }
    const updated = coordinator.queue.updateBacklogTask(id, { status: targetStatus });
    if (!updated) {
      skipped.push(id);
      continue;
    }
    items.push(updated);
  }

  return sendJson(res, 200, { updated: items.length, items, skipped });
};

const OWNER_REPO_SLUG_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;
const GITHUB_URL_SLUG_RE = /github\.com[/:]([^/\s]+)\/([^/#?\s]+?)(?:\.git)?\/?$/i;

const parseGithubSlugFromUrl = (value: string): string | undefined => {
  const match = GITHUB_URL_SLUG_RE.exec(value.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
};

const isTerminalBacklogStatus = (status: BacklogStatus): boolean =>
  status === 'canceled' || isTerminalTaskStatus(status);

export const resolveGithubRepoSlug = async (
  repo: Pick<RepositoryEntry, 'id' | 'name' | 'path' | 'cloneUrl'>,
  execFileAsync: typeof defaultExecFileAsync = defaultExecFileAsync
): Promise<string | undefined> => {
  if (repo.cloneUrl) {
    const fromCloneUrl = parseGithubSlugFromUrl(repo.cloneUrl);
    if (fromCloneUrl) return fromCloneUrl;
  }
  if (OWNER_REPO_SLUG_RE.test(repo.id)) {
    return repo.id;
  }
  if (OWNER_REPO_SLUG_RE.test(repo.name)) {
    return repo.name;
  }
  if (repo.path) {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', repo.path, 'remote', 'get-url', 'origin'],
        { timeout: 5000 }
      );
      if (stdout) {
        const fromOrigin = parseGithubSlugFromUrl(stdout);
        if (fromOrigin) return fromOrigin;
      }
    } catch {
      // Missing checkout, non-git directory, or no origin remote.
    }
  }
  return undefined;
};

export interface GithubIssueSyncFailure {
  repositoryId: string;
  reason: string;
}

const describeError = (err: unknown): string => {
  if (err instanceof Error && err.message) return err.message;
  const text = String(err);
  return text === '[object Object]' ? 'unknown error' : text;
};

export interface SyncGithubBacklogDeps {
  listOpenIssues?: typeof listOpenIssues;
  execFileAsync?: typeof defaultExecFileAsync;
}

export const handleSyncGithubBacklog = async (
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WebServerOptions,
  method: string,
  deps?: SyncGithubBacklogDeps
): Promise<void> => {
  if (method !== 'POST') return methodNotAllowed(res);

  const config = options.configStore.resolveConfig();
  const coordinator = resolveCoordinator(options);
  const targetLabel = config.githubBacklogLabel || 'backlog';
  const ghToken = config.githubToken?.trim();
  const fetchIssues = deps?.listOpenIssues ?? listOpenIssues;
  const execFileAsync = deps?.execFileAsync ?? defaultExecFileAsync;

  let importedCount = 0;
  let canceledCount = 0;
  const failedRepos: string[] = [];
  const failures: GithubIssueSyncFailure[] = [];
  const markFailed = (repositoryId: string, reason: string) => {
    failedRepos.push(repositoryId);
    failures.push({ repositoryId, reason });
  };
  const existingBacklog = coordinator.queue.listBacklogTasks();
  // Finished or canceled rows are history: only active rows block re-importing an issue.
  const existingKeys = new Set(
    existingBacklog
      .filter((t) => t.githubIssueNumber !== undefined && !isTerminalBacklogStatus(t.status))
      .map((t) => `${t.repositoryId}#${t.githubIssueNumber}`)
  );

  for (const repo of config.repositories) {
    const repoSlug = await resolveGithubRepoSlug(repo, execFileAsync);
    if (!repoSlug) {
      options.logger?.warn?.(
        'Cannot resolve GitHub owner/repo slug for configured repository %s; skipping backlog sync',
        repo.id
      );
      markFailed(
        repo.id,
        'cannot resolve GitHub owner/repo from repository name, clone URL, or git origin remote'
      );
      continue;
    }

    const listing = await fetchIssues(
      repoSlug,
      targetLabel,
      ghToken,
      options.logger,
      execFileAsync
    );
    if (!listing.ok) {
      markFailed(repo.id, listing.reason);
      continue;
    }
    const issues = listing.issues;

    try {
      for (const issue of issues) {
        const key = `${repo.id}#${issue.number}`;
        if (existingKeys.has(key)) continue;

        const cascade = configuredCascade({
          fallbackModel: config.defaultDispatchModel || 'gemini-4-hydrogen',
          fallbackEffort: config.defaultDispatchEffort || 'high',
        });

        coordinator.queue.createBacklogTask({
          title: `[GH #${issue.number}] ${issue.title.trim()}`,
          prompt: (issue.body || issue.title).trim(),
          repositoryId: repo.id,
          cascade,
          autoCreatePr: true,
          githubIssueNumber: issue.number,
          githubIssueUrl: issue.html_url || issue.url,
          maxAttempts: 2,
        });

        existingKeys.add(key);
        importedCount++;
      }

      if (!listing.truncated) {
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
      }
    } catch (err) {
      const reason = describeError(err);
      options.logger?.error?.('Failed to import GitHub backlog for repo %s: %s', repo.id, reason);
      markFailed(repo.id, `import failed: ${reason}`);
    }
  }

  return sendJson(res, 200, {
    success: failedRepos.length === 0,
    importedCount,
    canceledCount,
    label: targetLabel,
    failedRepos,
    failures,
  });
};

interface GithubIssue {
  number: number;
  title: string;
  body?: string;
  html_url?: string;
  url?: string;
}

interface GithubIssueListing {
  issues: GithubIssue[];
  truncated: boolean;
}

const GITHUB_ISSUE_PAGES = 5;
const GITHUB_ISSUE_PAGE_SIZE = 100;
const GH_CLI_ISSUE_LIMIT = 500;

export type GithubIssueFetchResult =
  ({ ok: true } & GithubIssueListing) | { ok: false; reason: string };

const fetchGithubRestIssues = async (
  repoSlug: string,
  label: string,
  ghToken: string
): Promise<GithubIssueListing> => {
  const issues: GithubIssue[] = [];
  let truncated = false;

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
    if (page === GITHUB_ISSUE_PAGES) truncated = true;
  }
  return { issues, truncated };
};

const fetchGhCliIssues = async (
  repoSlug: string,
  label: string,
  execFileAsync: typeof defaultExecFileAsync = defaultExecFileAsync,
  ghToken?: string
): Promise<GithubIssueListing> => {
  const { stdout } = await execFileAsync(
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
      String(GH_CLI_ISSUE_LIMIT),
      '--json',
      'number,title,body,url',
    ],
    { timeout: 20000, env: { ...process.env, GITHUB_TOKEN: ghToken ?? '' } }
  );
  const issues: GithubIssue[] = stdout && stdout.trim() ? JSON.parse(stdout) : [];
  return { issues, truncated: issues.length >= GH_CLI_ISSUE_LIMIT };
};

export const listOpenIssues = async (
  repoSlug: string,
  label: string,
  ghToken: string | undefined,
  logger?: WebServerOptions['logger'],
  execFileAsync: typeof defaultExecFileAsync = defaultExecFileAsync
): Promise<GithubIssueFetchResult> => {
  let restError: string | undefined;

  if (ghToken) {
    try {
      return { ok: true, ...(await fetchGithubRestIssues(repoSlug, label, ghToken)) };
    } catch (err) {
      restError = describeError(err);
      logger?.warn?.(
        'GitHub REST backlog sync failed for %s, falling back to gh CLI: %s',
        repoSlug,
        restError
      );
    }

    try {
      return { ok: true, ...(await fetchGhCliIssues(repoSlug, label, execFileAsync, ghToken)) };
    } catch (err) {
      const reason = `GitHub REST API failed (${restError}) and the gh CLI failed (${describeError(err)})`;
      logger?.warn?.('GitHub backlog sync failed for %s: %s', repoSlug, reason);
      return { ok: false, reason };
    }
  }

  try {
    return { ok: true, ...(await fetchGhCliIssues(repoSlug, label, execFileAsync, ghToken)) };
  } catch (err) {
    const reason = `no GitHub token is configured on the coordinator and the gh CLI is unavailable (${describeError(err)})`;
    logger?.warn?.('GitHub backlog sync failed for %s: %s', repoSlug, reason);
    return { ok: false, reason };
  }
};
