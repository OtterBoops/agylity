import ky, { isHTTPError } from 'ky';
import type {
  QuotaSnapshot,
  SentryAlertState,
  ConfigData,
  LogEntry,
  DispatchRecord,
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
  prompt: string;
  requestedBy?: string;
  allowOverage?: boolean;
}): Promise<{ success: boolean; branchName?: string }> =>
  api.post('dispatch', { json: payload }).json<{ success: boolean; branchName?: string }>();

export const testNotification = (): Promise<{ ok: boolean; message: string }> =>
  api.post('notify/test').json<{ ok: boolean; message: string }>();

export const getDispatches = (limit = 50): Promise<DispatchRecord[]> =>
  api.get(`dispatches?limit=${limit}`).json<DispatchRecord[]>();

export const getLogs = (
  since = 0,
  level = 'debug'
): Promise<{ enabled: boolean; entries: LogEntry[] }> =>
  api.get(`logs?since=${since}&level=${level}`).json<{ enabled: boolean; entries: LogEntry[] }>();
