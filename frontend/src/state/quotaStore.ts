import { createStore } from './store';
import { getQuota, getAlerts } from '../api';
import type { QuotaSnapshot, SentryAlertState } from '../types';

export interface QuotaState {
  quota: QuotaSnapshot[];
  alerts: SentryAlertState | null;
  loading: boolean;
  lastUpdated: number | null;
  error: string | null;
}

const initialState: QuotaState = {
  quota: [],
  alerts: null,
  loading: false,
  lastUpdated: null,
  error: null,
};

export const quotaStore = createStore<QuotaState>(initialState);

export async function refreshQuota(): Promise<void> {
  quotaStore.setState((prev) => ({ ...prev, loading: true, error: null }));
  try {
    const [quotaRes, alertsRes] = await Promise.all([getQuota(), getAlerts()]);
    quotaStore.setState({
      quota: quotaRes,
      alerts: alertsRes,
      loading: false,
      lastUpdated: Date.now(),
      error: null,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    quotaStore.setState((prev) => ({
      ...prev,
      loading: false,
      error: message,
    }));
  }
}

let pollingIntervalId: ReturnType<typeof setInterval> | null = null;

export function startQuotaPolling(intervalMs = 60000): () => void {
  if (pollingIntervalId) {
    clearInterval(pollingIntervalId);
  }
  refreshQuota();
  pollingIntervalId = setInterval(refreshQuota, intervalMs);

  return () => {
    if (pollingIntervalId) {
      clearInterval(pollingIntervalId);
      pollingIntervalId = null;
    }
  };
}
