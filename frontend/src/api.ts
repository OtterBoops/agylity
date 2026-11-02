import ky, { isHTTPError } from 'ky';
import type {
  QuotaSnapshot,
  SentryAlertState,
  ConfigData,
  LogEntry,
  DispatchRecord,
  ModelCatalogEntry,
  SwarmWorkerRecord,
  RunnerRegistrationTokenResult,
  SwarmTask,
} from './types';

export const getAuthToken = (): string | null => {
  try {
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
            if (body?.code === 'AUTH_REQUIRED') {
              isCliAuth = true;
            }
          } catch {
            // keep default error.message
          }
          if (typeof window !== 'undefined' && error.response.status === 401 && !isCliAuth) {
            window.dispatchEvent(new CustomEvent('agylity:unauthorized'));
          }
        }
        return error;
      },
    ],
  },
});

export const getQuota = (): Promise<QuotaSnapshot[]> => api.get('quota').json<QuotaSnapshot[]>();

export const getAlerts = (): Promise<SentryAlertState | null> =>
  api.get('alerts').json<SentryAlertState | null>();

export const getConfig = (): Promise<ConfigData> =>
  api
    .get('config')
    .json<ConfigData>()
    .catch(() => ({ resolved: {}, overrides: {} }));

export const updateConfig = (
  overrides: Record<string, unknown>
): Promise<ConfigData & { success: boolean }> =>
  api.post('config', { json: overrides }).json<ConfigData & { success: boolean }>();

export const deleteConfigOverride = (key: string): Promise<{ success: boolean }> =>
  api.delete(`config/${encodeURIComponent(key)}`).json<{ success: boolean }>();

export const getTasks = (limit = 50): Promise<SwarmTask[]> =>
  api
    .get(`tasks?limit=${limit}`)
    .json<SwarmTask[]>()
    .catch(() => []);

export const triggerDispatch = (payload: {
  repositoryName: string;
  repositoryId?: string;
  repositoryPath?: string;
  cloneUrl?: string;
  prompt: string;
  requestedBy?: string;
  model?: string;
  scheduleMode?: 'immediate' | 'pre_reset';
  effort?: 'low' | 'medium' | 'high';
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

export const getModels = (): Promise<{
  defaultModel: string;
  defaultEffort: string;
  models: ModelCatalogEntry[];
}> =>
  api
    .get('models')
    .json<{ defaultModel: string; defaultEffort: string; models: ModelCatalogEntry[] }>()
    .catch(() => ({ defaultModel: 'gemini-4-argon', defaultEffort: 'high', models: [] }));

export const getWorkers = (): Promise<SwarmWorkerRecord[]> =>
  api
    .get('workers')
    .json<SwarmWorkerRecord[]>()
    .catch(() => []);

export const createRegistrationToken = (payload: {
  nameHint?: string;
  labels?: string[];
  repositories?: string[];
}): Promise<RunnerRegistrationTokenResult> =>
  api.post('workers/registration-token', { json: payload }).json<RunnerRegistrationTokenResult>();

export const setWorkerEnabled = (
  workerId: string,
  enabled: boolean
): Promise<{ success: boolean; worker: SwarmWorkerRecord }> =>
  api
    .patch(`workers/${encodeURIComponent(workerId)}`, { json: { enabled } })
    .json<{ success: boolean; worker: SwarmWorkerRecord }>();

export const revokeWorker = (workerId: string): Promise<{ success: boolean; revoked: boolean }> =>
  api
    .delete(`workers/${encodeURIComponent(workerId)}`)
    .json<{ success: boolean; revoked: boolean }>();

export const testNotification = (
  channel?: string,
  overrides?: Record<string, unknown>
): Promise<{ success: boolean; message: string; channel?: string }> =>
  api
    .post('notify/test', { json: { ...(channel ? { channel } : {}), ...(overrides ?? {}) } })
    .json<{ success: boolean; message: string; channel?: string }>();

export const getDispatches = (limit = 50): Promise<DispatchRecord[]> =>
  api.get(`dispatches?limit=${limit}`).json<DispatchRecord[]>();

export const getLogs = (
  since = 0,
  level = 'debug'
): Promise<{ enabled: boolean; latestId?: number; entries: LogEntry[] }> =>
  api
    .get(`logs?since=${since}&level=${level}`)
    .json<{ enabled: boolean; latestId?: number; entries: LogEntry[] }>();
