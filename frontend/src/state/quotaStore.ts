import { createStore } from './store';
import { getQuota, getAlerts } from '../api';
import type { QuotaSnapshot, SentryAlertState } from '../types';

const QUOTA_CACHE_KEY = 'agylity.quotaCache.v1';
const VERDICT_CACHE_KEY = 'agylity.verdictCache.v1';
const RUNNERS_CACHE_KEY = 'agylity.runnersCache.v1';

export const readUiCache = <T>(key: string): T | null => {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};

export const writeUiCache = <T>(key: string, value: T): void => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota or private-mode failures.
  }
};

export const clearOverviewUiCache = (): void => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(QUOTA_CACHE_KEY);
    localStorage.removeItem(VERDICT_CACHE_KEY);
    localStorage.removeItem(RUNNERS_CACHE_KEY);
  } catch {
    // Ignore storage errors.
  }
};

export { VERDICT_CACHE_KEY, RUNNERS_CACHE_KEY };

interface CachedQuotaPayload {
  quota: QuotaSnapshot[];
  alerts: SentryAlertState | null;
  lastUpdated: number | null;
}

const loadInitialQuotaState = (): QuotaState => {
  const cached = readUiCache<CachedQuotaPayload>(QUOTA_CACHE_KEY);
  if (cached && Array.isArray(cached.quota) && cached.quota.length > 0) {
    return {
      quota: cached.quota,
      alerts: cached.alerts ?? null,
      loading: false,
      lastUpdated: typeof cached.lastUpdated === 'number' ? cached.lastUpdated : null,
      error: null,
    };
  }
  return {
    quota: [],
    alerts: null,
    loading: false,
    lastUpdated: null,
    error: null,
  };
};

export interface QuotaState {
  quota: QuotaSnapshot[];
  alerts: SentryAlertState | null;
  loading: boolean;
  lastUpdated: number | null;
  error: string | null;
}

const initialState: QuotaState = loadInitialQuotaState();

export const quotaStore = createStore<QuotaState>(initialState);

export const refreshQuota = async (options?: { force?: boolean }): Promise<void> => {
  quotaStore.setState((prev) => ({ ...prev, loading: true, error: null }));
  try {
    const [quotaRes, alertsRes] = await Promise.all([
      getQuota(options?.force ?? false),
      getAlerts(),
    ]);
    const lastUpdated = Date.now();
    quotaStore.setState({
      quota: quotaRes,
      alerts: alertsRes,
      loading: false,
      lastUpdated,
      error: null,
    });
    writeUiCache<CachedQuotaPayload>(QUOTA_CACHE_KEY, {
      quota: quotaRes,
      alerts: alertsRes,
      lastUpdated,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    quotaStore.setState((prev) => ({
      ...prev,
      loading: false,
      error: message,
    }));
  }
};

export const refreshAlerts = async (): Promise<void> => {
  const alerts = await getAlerts();
  quotaStore.setState((prev) => {
    const next = { ...prev, alerts };
    if (next.quota.length > 0) {
      writeUiCache<CachedQuotaPayload>(QUOTA_CACHE_KEY, {
        quota: next.quota,
        alerts: next.alerts,
        lastUpdated: next.lastUpdated,
      });
    }
    return next;
  });
};

let activePollingId: ReturnType<typeof setInterval> | null = null;

export const startQuotaPolling = (intervalMs = 60000, refreshOnStart = true): (() => void) => {
  if (activePollingId) {
    clearInterval(activePollingId);
    activePollingId = null;
  }
  if (refreshOnStart) refreshQuota();
  const id = setInterval(refreshQuota, intervalMs);
  activePollingId = id;

  return () => {
    clearInterval(id);
    if (activePollingId === id) {
      activePollingId = null;
    }
  };
};
