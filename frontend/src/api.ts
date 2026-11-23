import ky, { isHTTPError } from 'ky';
import { DEFAULT_DISPATCH_EFFORT, DEFAULT_DISPATCH_MODEL } from '../../src/shared/models.ts';
import type {
  QuotaSnapshot,
  SentryAlertState,
  ConfigData,
  LogEntry,
  ModelCatalogEntry,
  SwarmRunnerRecord,
  RunnersResponse,
  RunnerRegistrationTokenResult,
  SwarmTask,
  BacklogTaskRecord,
  BacklogStatus,
  RoutineTaskRecord,
  PrPolicy,
  AlertEventPage,
  DispatchEligibility,
  CascadeHop,
} from './types';

export const getAuthToken = (): string | null => {
  try {
    if (typeof window !== 'undefined') {
      const tokenParam = new URLSearchParams(window.location.search).get('token');
      if (tokenParam) {
        localStorage.setItem('agylity_auth_token', tokenParam);
        return tokenParam;
      }
    }
    return localStorage.getItem('agylity_auth_token');
  } catch {
    return null;
  }
};

export const setAuthToken = (token: string | null): void => {
  try {
    if (token) {
      localStorage.setItem('agylity_auth_token', token);
    } else {
      localStorage.removeItem('agylity_auth_token');
    }
  } catch {}
};

export interface HealthStatus {
  status: string;
  uptime?: number;
  timestamp?: string;
  authRequired?: boolean;
  agyVersion?: string | null;
}

export const checkHealth = async (): Promise<HealthStatus> => {
  try {
    return await ky.get('/api/health', { retry: 0, timeout: 5000 }).json<HealthStatus>();
  } catch {
    return { status: 'error' };
  }
};

export const verifyAuthToken = async (
  testToken: string
): Promise<{ success: boolean; error?: string }> => {
  const clean = testToken.trim();
  if (!clean) {
    return { success: false, error: 'Bearer token cannot be empty' };
  }
  try {
    const res = await ky.get('/api/config', {
      headers: {
        Authorization: `Bearer ${clean}`,
      },
      retry: 0,
      timeout: 5000,
    });
    if (res.ok) {
      setAuthToken(clean);
      return { success: true };
    }
    return { success: false, error: 'Authentication failed' };
  } catch (err: any) {
    if (isHTTPError(err) && err.response) {
      if (err.response.status === 401) {
        return { success: false, error: 'Invalid or missing Bearer token' };
      }
      if (err.response.status === 429) {
        return {
          success: false,
          error: 'Rate limit engaged: Too many failed attempts. Please wait 60s.',
        };
      }
      if (err.response.status === 403) {
        return { success: false, error: 'Forbidden: IP address not in allowlist' };
      }
    }
    return { success: false, error: err?.message || 'Failed to connect to control plane' };
  }
};

export const api = ky.create({
  prefix: '/api',
  retry: {
    limit: 1,
  },
  hooks: {
    beforeRequest: [
      ({ request }) => {
        const token = getAuthToken();
        if (token) {
          request.headers.set('Authorization', `Bearer ${token}`);
        }
      },
    ],
    beforeError: [
      async ({ error }) => {
        if (isHTTPError(error) && error.response) {
          let isCliAuth = false;
          try {
            const body: any = await error.response.clone().json();
            if (body && typeof body.error === 'string') {
              error.message = body.error;
            }
            // AUTH_REQUIRED means the upstream agy credential is missing, so this 401 is not a bad UI token.
            if (body?.code === 'AUTH_REQUIRED') {
              isCliAuth = true;
            }
          } catch {}
          if (typeof window !== 'undefined' && error.response.status === 401 && !isCliAuth) {
            window.dispatchEvent(new CustomEvent('agylity:unauthorized'));
          }
        }
        return error;
      },
    ],
  },
});

export const getQuota = (force = false): Promise<QuotaSnapshot[]> =>
  api.get(force ? 'quota?refresh=1' : 'quota').json<QuotaSnapshot[]>();

export const getAlerts = (): Promise<SentryAlertState | null> =>
  api
    .get('alerts')
    .json<SentryAlertState | null>()
    .catch(() => null);

export const dismissEarlyReset = (): Promise<{ success: boolean; dismissed: boolean }> =>
  api.post('alerts/dismiss').json<{ success: boolean; dismissed: boolean }>();

export const getConfig = (): Promise<ConfigData> =>
  api
    .get('config')
    .json<ConfigData>()
    .catch(() => ({ resolved: {}, overrides: {} }));

export const updateConfig = (
  overrides: Record<string, unknown>
): Promise<ConfigData & { success: boolean }> =>
  api.post('config', { json: overrides }).json<ConfigData & { success: boolean }>();

export interface ConfigWriteEnvelope {
  set?: Record<string, unknown>;
  clear?: string[];
}

export const writeConfigEnvelope = async (
  payload: ConfigWriteEnvelope
): Promise<ConfigData & { success: boolean; cleared?: string[] }> => {
  try {
    return await api
      .post('config', { json: payload })
      .json<ConfigData & { success: boolean; cleared?: string[] }>();
  } catch (err) {
    if (isHTTPError(err)) {
      let body: { error?: unknown } | null = null;
      try {
        body = (await err.response.clone().json()) as { error?: unknown } | null;
      } catch {
        body = null;
      }
      if (body && typeof body.error === 'string' && body.error) {
        throw new Error(body.error);
      }
    }
    throw err;
  }
};

export const deleteConfigOverride = (key: string): Promise<{ success: boolean }> =>
  api.delete(`config/${encodeURIComponent(key)}`).json<{ success: boolean }>();

export const cancelTask = (id: string): Promise<{ success: boolean }> =>
  api.post(`tasks/${encodeURIComponent(id)}/cancel`).json<{ success: boolean }>();

export const retryTask = (id: string): Promise<{ success: boolean }> =>
  api.post(`tasks/${encodeURIComponent(id)}/retry`).json<{ success: boolean }>();

export interface TaskQuery {
  q?: string;
  taskNumber?: number;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface TaskPage {
  tasks: SwarmTask[];
  total: number;
  offset: number;
  limit: number;
}

export const getTasks = (
  query: TaskQuery | number = {},
  signal?: AbortSignal
): Promise<TaskPage> => {
  const params: TaskQuery = typeof query === 'number' ? { limit: query } : query;
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.taskNumber !== undefined) search.set('taskNumber', String(params.taskNumber));
  if (params.status) search.set('status', params.status);
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  if (params.offset !== undefined) search.set('offset', String(params.offset));
  const suffix = search.toString();
  return api.get(`tasks${suffix ? `?${suffix}` : ''}`, signal ? { signal } : {}).json<TaskPage>();
};

export const getTask = async (id: string): Promise<{ task: SwarmTask; fingerprint?: string }> => {
  const body = await api
    .get(`tasks/${encodeURIComponent(id)}`)
    .json<SwarmTask & { fingerprint?: string }>();
  const { fingerprint, ...task } = body;
  return { task: task as SwarmTask, fingerprint };
};

export const triggerDispatch = (payload: {
  repositoryId: string;
  repositoryName?: string;
  repositoryPath?: string;
  cloneUrl?: string;
  prompt: string;
  title?: string;
  cascade: CascadeHop[];
  requestedBy?: string;
  scheduleMode?: 'immediate' | 'pre_reset';
  prPolicy?: PrPolicy;
  verifyCommand?: string;
  autoCreatePr?: boolean;
  allowOverage?: boolean;
}): Promise<{
  success: boolean;
  status?: string;
  taskId?: string;
  branchName?: string;
  model?: string;
  error?: string;
  code?: string;
}> => api.post('dispatch', { json: payload }).json();

export interface ModelsResponse {
  defaultModel: string;
  defaultEffort: string;
  models: ModelCatalogEntry[];
  unattributedModels?: string[];
}

export const getModels = (): Promise<ModelsResponse> =>
  api
    .get('models')
    .json<ModelsResponse>()
    .catch(() => ({
      defaultModel: DEFAULT_DISPATCH_MODEL,
      defaultEffort: DEFAULT_DISPATCH_EFFORT,
      models: [],
    }));

export const getRunners = (): Promise<RunnersResponse> =>
  api
    .get('runners')
    .json<RunnersResponse>()
    // A failed poll says nothing about configuration, so do not accuse it of a missing token.
    .catch(() => ({ runners: [], credentialsAvailable: true }));

export const createRegistrationToken = (payload: {
  nameHint?: string;
  labels?: string[];
  repositories?: string[];
}): Promise<RunnerRegistrationTokenResult> =>
  api.post('runners/registration-token', { json: payload }).json<RunnerRegistrationTokenResult>();

export const setRunnerEnabled = (
  runnerId: string,
  enabled: boolean
): Promise<{ success: boolean; runner: SwarmRunnerRecord }> =>
  api
    .patch(`runners/${encodeURIComponent(runnerId)}`, { json: { enabled } })
    .json<{ success: boolean; runner: SwarmRunnerRecord }>();

export const revokeRunner = (runnerId: string): Promise<{ success: boolean; revoked: boolean }> =>
  api
    .delete(`runners/${encodeURIComponent(runnerId)}`)
    .json<{ success: boolean; revoked: boolean }>();

export const testNotification = async (
  channel?: string,
  overrides?: Record<string, unknown>
): Promise<{ success: boolean; message: string; channel?: string }> => {
  try {
    return await api
      .post('notify/test', { json: { ...(channel ? { channel } : {}), ...(overrides ?? {}) } })
      .json<{ success: boolean; message: string; channel?: string }>();
  } catch (err) {
    if (isHTTPError(err)) {
      const body = (await err.response
        .clone()
        .json()
        .catch(() => null)) as { message?: unknown } | null;
      if (body && typeof body.message === 'string' && body.message) {
        throw new Error(body.message);
      }
    }
    throw err;
  }
};

export const getLogs = (
  since = 0,
  level = 'debug'
): Promise<{ enabled: boolean; latestId?: number; entries: LogEntry[] }> =>
  api
    .get(`logs?since=${since}&level=${level}`)
    .json<{ enabled: boolean; latestId?: number; entries: LogEntry[] }>();

export const getRoutines = (): Promise<RoutineTaskRecord[]> =>
  api.get('routines').json<RoutineTaskRecord[]>();

export const createRoutine = (
  input: Partial<RoutineTaskRecord> & {
    title: string;
    prompt: string;
    repositoryId: string;
    cascade?: CascadeHop[];
  }
): Promise<RoutineTaskRecord> => api.post('routines', { json: input }).json<RoutineTaskRecord>();

export const updateRoutine = (
  id: string,
  patch: Partial<Omit<RoutineTaskRecord, 'verifyCommand' | 'prPolicy'>> & {
    verifyCommand?: string | null;
    prPolicy?: RoutineTaskRecord['prPolicy'] | null;
  }
): Promise<RoutineTaskRecord> =>
  api.patch(`routines/${encodeURIComponent(id)}`, { json: patch }).json<RoutineTaskRecord>();

export const deleteRoutine = (id: string): Promise<boolean> =>
  api
    .delete(`routines/${encodeURIComponent(id)}`)
    .json<{ success: boolean; deleted: boolean }>()
    .then((r) => r.success);

export const triggerRoutine = (
  id: string
): Promise<{ success: boolean; taskId?: string; error?: string; code?: string }> =>
  api
    .post(`routines/${encodeURIComponent(id)}/trigger`)
    .json<{ success: boolean; taskId?: string; error?: string; code?: string }>();

export const getBacklogTasks = (status?: string): Promise<BacklogTaskRecord[]> =>
  api
    .get(`backlog${status ? `?status=${encodeURIComponent(status)}` : ''}`)
    .json<BacklogTaskRecord[]>();

export const createBacklogTask = (
  input: Partial<BacklogTaskRecord> & {
    title: string;
    prompt: string;
    repositoryId: string;
    cascade: CascadeHop[];
  }
): Promise<BacklogTaskRecord> => api.post('backlog', { json: input }).json<BacklogTaskRecord>();

export interface BacklogTaskPatch {
  title?: string;
  prompt?: string;
  repositoryId?: string;
  cascade?: CascadeHop[];
  verifyCommand?: string | null;
  autoCreatePr?: boolean;
  priorityOrder?: number;
  status?: BacklogStatus;
}

export const updateBacklogTask = (
  id: string,
  patch: BacklogTaskPatch
): Promise<BacklogTaskRecord> =>
  api.patch(`backlog/${encodeURIComponent(id)}`, { json: patch }).json<BacklogTaskRecord>();

export const deleteBacklogTask = (id: string): Promise<boolean> =>
  api
    .delete(`backlog/${encodeURIComponent(id)}`)
    .json<{ success: boolean; deleted: boolean }>()
    .then((r) => r.success);

export const dispatchBacklogTask = (
  id: string
): Promise<{ success: boolean; taskId?: string; error?: string; code?: string }> =>
  api
    .post(`backlog/${encodeURIComponent(id)}/dispatch`)
    .json<{ success: boolean; taskId?: string; error?: string; code?: string }>();

export interface GithubSyncFailure {
  repositoryId: string;
  reason: string;
}

export interface GithubSyncResult {
  success: boolean;
  importedCount: number;
  canceledCount?: number;
  label: string;
  failedRepos?: string[];
  failures?: GithubSyncFailure[];
}

export const syncGithubBacklog = (): Promise<GithubSyncResult> =>
  api.post('backlog/sync-github').json<GithubSyncResult>();

export const getDispatchEligibility = (params: { model?: string; allowOverage?: boolean } = {}) => {
  const query = new URLSearchParams();
  if (params.model) query.set('model', params.model);
  if (params.allowOverage) query.set('allowOverage', '1');
  const suffix = query.toString();
  return api.get(`dispatch/eligibility${suffix ? `?${suffix}` : ''}`).json<DispatchEligibility>();
};

export const getAlertEvents = (params: { limit?: number; before?: string; pool?: string } = {}) => {
  const query = new URLSearchParams();
  query.set('limit', String(params.limit ?? 50));
  if (params.before) query.set('before', params.before);
  if (params.pool) query.set('pool', params.pool);
  return api.get(`alerts/events?${query.toString()}`).json<AlertEventPage>();
};

export const bulkUpdateBacklog = (
  ids: string[],
  action: 'pause' | 'resume'
): Promise<{ updated: number; items: BacklogTaskRecord[]; skipped: string[] }> =>
  api.patch('backlog/bulk', { json: { ids, action } }).json();
