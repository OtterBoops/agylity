import { createStore } from './store';
import { getConfig, writeConfigEnvelope, deleteConfigOverride } from '../api';
import { ALL_SETTINGS_FIELDS, normalizeModelId, toDisplay } from '../config/fields';
import type { ConfigData } from '../types';

export interface ConfigState {
  config: ConfigData;
  loading: boolean;
  saving: boolean;
  error: string | null;
  drafts: Record<string, string>;
}

const initialState: ConfigState = {
  config: { resolved: {}, overrides: {} },
  loading: false,
  saving: false,
  error: null,
  drafts: {},
};

export const configStore = createStore<ConfigState>(initialState);

export interface ConfigWriteResult extends ConfigData {
  success: boolean;
  cleared?: string[];
}

const FIELD_INDEX = new Map(ALL_SETTINGS_FIELDS.map((field) => [field.key, field]));

const isSecretField = (config: ConfigData, key: string): boolean => {
  if (config.secretsMeta && Object.hasOwn(config.secretsMeta, key)) return true;
  const lower = key.toLowerCase();
  return (
    lower.endsWith('token') ||
    lower.endsWith('secret') ||
    lower.endsWith('password') ||
    lower.endsWith('key') ||
    lower.includes('csrf') ||
    lower.includes('webhookurl')
  );
};

const canonical = (key: string, raw: string): string =>
  key === 'defaultDispatchModel' ? normalizeModelId(raw) : raw;

const parseDraftValue = (key: string, raw: string): unknown => {
  const field = FIELD_INDEX.get(key);
  if (!field) return raw;
  if (field.type === 'number') {
    if (raw.trim() === '') return undefined;
    const num = Number(raw);
    return Number.isFinite(num) ? num : undefined;
  }
  if (field.type === 'list') {
    const entries = raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (field.itemType !== 'number') return entries;
    return entries.map((entry) => {
      const num = Number(entry);
      if (!Number.isFinite(num) || num <= 0) {
        throw new Error(
          `${field.label} must be a list of positive numbers; "${entry}" is not one.`
        );
      }
      return num;
    });
  }
  if (field.type === 'select' && (raw === 'true' || raw === 'false')) return raw === 'true';
  if (field.type === 'boolean') return raw === 'true';
  return raw;
};

export const setDraft = (key: string, value: string): void => {
  configStore.setState((prev) => ({ ...prev, drafts: { ...prev.drafts, [key]: value } }));
};

export const clearDraft = (key: string): void => {
  configStore.setState((prev) => {
    if (!Object.hasOwn(prev.drafts, key)) return prev;
    const drafts = { ...prev.drafts };
    delete drafts[key];
    return { ...prev, drafts };
  });
};

export const clearAllDrafts = (): void => {
  configStore.setState((prev) =>
    Object.keys(prev.drafts).length === 0 ? prev : { ...prev, drafts: {} }
  );
};

export const dirtyKeys = (config: ConfigData): string[] => {
  const drafts = configStore.getState().drafts;
  const overrides = config.overrides ?? {};
  const resolved = config.resolved ?? {};
  const dirty: string[] = [];

  for (const [key, draft] of Object.entries(drafts)) {
    if (isSecretField(config, key)) {
      if (draft.trim() !== '') dirty.push(key);
      continue;
    }
    const current = toDisplay(overrides[key] ?? resolved[key]);
    if (canonical(key, draft) === canonical(key, current)) continue;
    // Blank only counts as dirty when an override exists behind it: saving it is a clear, not a no-op.
    if (draft === '' && !Object.hasOwn(overrides, key)) continue;
    dirty.push(key);
  }

  return dirty;
};

export const refreshConfig = async (): Promise<ConfigData> => {
  configStore.setState((prev) => ({ ...prev, loading: true, error: null }));
  try {
    const data = await getConfig();
    configStore.setState((prev) => ({ ...prev, config: data, loading: false, error: null }));
    return data;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    configStore.setState((prev) => ({ ...prev, loading: false, error: message }));
    return configStore.getState().config;
  }
};

const submitWrite = async (
  set: Record<string, unknown>,
  clear: string[],
  savedKeys: string[]
): Promise<ConfigWriteResult> => {
  configStore.setState((prev) => ({ ...prev, saving: true, error: null }));
  try {
    const res = await writeConfigEnvelope({ set, clear });
    const hasConfig = Boolean(res.resolved && res.overrides);
    configStore.setState((prev) => {
      const drafts = { ...prev.drafts };
      for (const key of savedKeys) delete drafts[key];
      return {
        config: hasConfig
          ? {
              resolved: res.resolved,
              overrides: res.overrides,
              sources: res.sources ?? prev.config.sources,
              secretsMeta: res.secretsMeta,
            }
          : prev.config,
        drafts,
        loading: false,
        saving: false,
        error: null,
      };
    });
    if (!hasConfig) await refreshConfig();
    return res;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    configStore.setState((prev) => ({ ...prev, saving: false, error: message }));
    throw err;
  }
};

export const saveConfigOverrides = async (
  overrides: Record<string, unknown>
): Promise<ConfigWriteResult> => {
  const currentOverrides = configStore.getState().config.overrides ?? {};
  const set: Record<string, unknown> = {};
  const clear: string[] = [];
  const savedKeys: string[] = [];

  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) continue;
    savedKeys.push(key);
    if (value === null || value === '') {
      if (Object.hasOwn(currentOverrides, key)) clear.push(key);
      continue;
    }
    set[key] = value;
  }

  if (Object.keys(set).length === 0 && clear.length === 0) {
    return { success: true, cleared: [], ...configStore.getState().config };
  }
  return submitWrite(set, clear, savedKeys);
};

export const saveDrafts = async (keys?: string[]): Promise<ConfigWriteResult> => {
  const state = configStore.getState();
  const scope = dirtyKeys(state.config).filter((key) => !keys || keys.includes(key));

  if (scope.length === 0) {
    return { success: true, cleared: [], ...state.config };
  }

  const set: Record<string, unknown> = {};
  const clear: string[] = [];
  const savedKeys: string[] = [];

  for (const key of scope) {
    const raw = state.drafts[key];
    if (isSecretField(state.config, key)) {
      set[key] = raw.trim();
      savedKeys.push(key);
      continue;
    }
    if (raw === '') {
      // Clear, never set '': an empty override would pin the field instead of falling back to its default.
      clear.push(key);
      savedKeys.push(key);
      continue;
    }
    let value: unknown;
    try {
      value = parseDraftValue(key, raw);
    } catch (err: unknown) {
      configStore.setState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : String(err),
      }));
      throw err;
    }
    if (value === undefined) continue; // an unparsable row stays dirty rather than vanishing
    set[key] = value;
    savedKeys.push(key);
  }

  if (Object.keys(set).length === 0 && clear.length === 0) {
    return { success: true, cleared: [], ...state.config };
  }
  return submitWrite(set, clear, savedKeys);
};

export const removeConfigOverride = async (key: string): Promise<{ success: boolean }> => {
  configStore.setState((prev) => ({ ...prev, saving: true, error: null }));
  try {
    const res = await deleteConfigOverride(key);
    clearDraft(key);
    await refreshConfig();
    configStore.setState((prev) => ({ ...prev, saving: false, error: null }));
    return res;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    configStore.setState((prev) => ({ ...prev, saving: false, error: message }));
    throw err;
  }
};
