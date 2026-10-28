import { createStore } from './store';
import { getConfig, updateConfig, deleteConfigOverride } from '../api';
import type { ConfigData } from '../types';

export interface ConfigState {
  config: ConfigData;
  loading: boolean;
  saving: boolean;
  error: string | null;
}

const initialState: ConfigState = {
  config: { resolved: {}, overrides: {} },
  loading: false,
  saving: false,
  error: null,
};

export const configStore = createStore<ConfigState>(initialState);

export async function refreshConfig(): Promise<ConfigData> {
  configStore.setState((prev) => ({ ...prev, loading: true, error: null }));
  try {
    const data = await getConfig();
    configStore.setState({
      config: data,
      loading: false,
      saving: false,
      error: null,
    });
    return data;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    configStore.setState((prev) => ({
      ...prev,
      loading: false,
      error: message,
    }));
    return configStore.getState().config;
  }
}

export async function saveConfigOverrides(
  overrides: Record<string, unknown>
): Promise<{ success: boolean; config?: ConfigData }> {
  configStore.setState((prev) => ({ ...prev, saving: true, error: null }));
  try {
    const res = await updateConfig(overrides);
    if (res.config) {
      configStore.setState({
        config: res.config,
        loading: false,
        saving: false,
        error: null,
      });
    } else {
      await refreshConfig();
    }
    return res;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    configStore.setState((prev) => ({
      ...prev,
      saving: false,
      error: message,
    }));
    throw err;
  }
}

export async function removeConfigOverride(key: string): Promise<{ success: boolean }> {
  configStore.setState((prev) => ({ ...prev, saving: true, error: null }));
  try {
    const res = await deleteConfigOverride(key);
    await refreshConfig();
    return res;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    configStore.setState((prev) => ({
      ...prev,
      saving: false,
      error: message,
    }));
    throw err;
  }
}
