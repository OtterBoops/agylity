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
} from './types';

export const api = ky.create({
  prefix: '/api',
  retry: {
    limit: 1,
  },
  hooks: {
    beforeError: [
      async ({ error }) => {
        if (isHTTPError(error) && error.response) {
          try {
            const body: any = await error.response.json();
            if (body && typeof body.error === 'string') {
              error.message = body.error;
            }
          } catch {
            // keep default error.message
          }
        }
        return error;
      },
    ],
  },
});

export const getQuota = (): Promise<QuotaSnapshot[]> =>
  api
    .get('quota')
    .json<QuotaSnapshot[]>()
    .catch(() => []);

export const getAlerts = (): Promise<SentryAlertState | null> =>
  api
    .get('alerts')
    .json<SentryAlertState | null>()
    .catch(() => null);

export const getConfig = (): Promise<ConfigData> =>
  api
    .get('config')
    .json<ConfigData>()
    .catch(() => ({ resolved: {}, overrides: {} }));

export const updateConfig = (
  overrides: Record<string, unknown>
): Promise<{ success: boolean; config?: ConfigData }> =>
  api.post('config', { json: overrides }).json<{ success: boolean; config?: ConfigData }>();

export const deleteConfigOverride = (key: string): Promise<{ success: boolean }> =>
  api.delete(`config/${encodeURIComponent(key)}`).json<{ success: boolean }>();

export const triggerDispatch = (payload: {
  repositoryName: string;
  repositoryId?: string;
  repositoryPath?: string;
  cloneUrl?: string;
  prompt: string;
  requestedBy?: string;
  model?: string;
  priority?: 'P0' | 'P1' | 'P2';
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  workerMode?: 'headless' | 'visible' | 'any';
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
    .catch(() => ({ defaultModel: 'gemini-4-argon-high', defaultEffort: 'high', models: [] }));

export const getWorkers = (): Promise<SwarmWorkerRecord[]> =>
  api
    .get('workers')
    .json<SwarmWorkerRecord[]>()
    .catch(() => []);

export const createRegistrationToken = (payload: {
  nameHint?: string;
  workerMode?: 'headless' | 'visible' | 'any';
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
): Promise<{ enabled: boolean; entries: LogEntry[] }> =>
  api.get(`logs?since=${since}&level=${level}`).json<{ enabled: boolean; entries: LogEntry[] }>();
